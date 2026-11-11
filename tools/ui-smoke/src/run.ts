/**
 * Entry point: `pnpm --filter @ration/ui-smoke smoke [-- --skip-build --only=<text> --out=<dir> --chrome=<path>]`
 *
 * Builds the web export (unless --skip-build), starts Chrome through playwright-core and walks every scenario at
 * every viewport. Needs NO local server: the build is served from disk and the Supabase backend is an in-process
 * mock, both through `context.route()`. Cannot run inside the Optimus sandbox (Chrome needs sockets/IPC): use a
 * normal terminal.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright-core';

import { AppFiles } from './app-files';
import { buildWebExport, isValidExport } from './build';
import { USAGE, parseArgs } from './cli';
import { resolveChrome } from './chrome';
import { buildFixtures } from './fixtures';
import { renderMarkdown, renderSummary, summarizeUnhandled, exitCodeOf, type Report, type ScenarioResult } from './report';
import { compareRoutes, scanRoutes } from './routes-scan';
import { runScenario, type ScenarioRun } from './runner';
import { SCENARIOS } from './scenarios';
import { DEFAULT_VIEWPORTS, VIEWPORTS, resolvePath, type Scenario, type ViewportName } from './types';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const appDir = join(repoRoot, 'apps', 'app');
const appRoutesDir = join(appDir, 'src', 'app');

const pad = (n: number, width = 3) => String(n).padStart(width, '0');

function selectScenarios(only: string | undefined): { scenario: Scenario; index: number }[] {
  const all = SCENARIOS.map((scenario, i) => ({ scenario, index: i + 1 }));
  if (!only) return all;
  const needle = only.toLowerCase();
  const fixtures = buildFixtures('default');
  return all.filter(({ scenario }) => scenario.name.toLowerCase().includes(needle) || resolvePath(scenario, fixtures).toLowerCase().includes(needle));
}

function harnessWarnings(): string[] {
  const warnings: string[] = [];
  const names = new Map<string, number>();
  for (const s of SCENARIOS) names.set(s.name, (names.get(s.name) ?? 0) + 1);
  for (const [name, count] of names) if (count > 1) warnings.push(`duplicate scenario name "${name}" (${count}x): screenshots would overwrite each other`);
  if (!existsSync(appRoutesDir)) return [...warnings, `route directory not found: ${appRoutesDir}`];
  const coverage = compareRoutes(scanRoutes(appRoutesDir), SCENARIOS.map((s) => s.route));
  for (const r of coverage.uncovered) warnings.push(`UNCOVERED ROUTE ${r.pattern} (apps/app/src/app/${r.file}) has no scenario: add one to tools/ui-smoke/src/scenarios.ts`);
  for (const r of coverage.unknown) warnings.push(`STALE SCENARIO ROUTE ${r} does not exist in apps/app/src/app any more`);
  return warnings;
}

async function main(): Promise<number> {
  const { options, errors } = parseArgs(process.argv.slice(2));
  if (errors.length > 0) {
    console.error(`${errors.join('\n')}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const viewportNames = (options.viewports ?? [...DEFAULT_VIEWPORTS]) as ViewportName[];
  const unknownViewport = viewportNames.find((v) => !(v in VIEWPORTS));
  if (unknownViewport) {
    console.error(`unknown viewport "${unknownViewport}" (known: ${Object.keys(VIEWPORTS).join(', ')})`);
    return 2;
  }

  const selected = selectScenarios(options.only);
  const warnings = harnessWarnings();

  if (options.list) {
    const fixtures = buildFixtures('default');
    for (const { scenario, index } of selected) {
      console.log(`${pad(index)}  ${scenario.auth.padEnd(10)} ${scenario.route.padEnd(22)} ${resolvePath(scenario, fixtures).padEnd(48)} ${scenario.name}`);
    }
    console.log(`\n${selected.length} scenarios, ${selected.length * viewportNames.length} runs (${viewportNames.join(', ')})`);
    for (const w of warnings) console.log(`warning: ${w}`);
    return 0;
  }
  if (selected.length === 0) {
    console.error(`No scenario matches --only=${options.only ?? ''}`);
    return 2;
  }

  const outDir = resolve(options.out);
  const distDir = resolve(options.dist);
  mkdirSync(outDir, { recursive: true });

  const chrome = resolveChrome({ flag: options.chrome, playwrightPath: () => chromium.executablePath() });
  if (!chrome.ok) {
    console.error(`${chrome.error}\nTried:\n  ${chrome.tried.join('\n  ')}`);
    return 2;
  }

  if (options.skipBuild) {
    const valid = isValidExport(distDir);
    if (!valid.ok) {
      console.error(`--skip-build: no usable web export in ${distDir} (${valid.reason}). Run once without --skip-build.`);
      return 2;
    }
    console.log(`Reusing the web export in ${distDir}`);
  } else {
    console.log(`Building the web export into ${distDir} (expo export, EXPO_PUBLIC_SUPABASE_URL=https://mock.supabase.test)...`);
    const build = await buildWebExport({ appDir, distDir, logFile: join(outDir, 'build.log'), clearCache: !options.keepCache });
    if (!build.ok) {
      console.error(`Web export FAILED after ${Math.round(build.durationMs / 1000)} s (full log: ${build.logFile}):\n${build.tail}`);
      return 1;
    }
    console.log(`Web export built in ${Math.round(build.durationMs / 1000)} s`);
  }

  if (!options.only) for (const vp of viewportNames) rmSync(join(outDir, vp), { recursive: true, force: true });

  const files = new AppFiles(distDir);
  const startedAt = new Date();
  console.log(`Launching Chrome (${chrome.path}, ${chrome.source})`);
  const browser = await chromium.launch({ executablePath: chrome.path, headless: !options.headed, args: ['--hide-scrollbars'] });

  let aborted = false;
  process.once('SIGINT', () => {
    aborted = true;
    console.log('\nInterrupted: finishing the running scenarios and writing the report...');
  });

  const jobs = selected.flatMap(({ scenario, index }) =>
    viewportNames.filter((vp) => !scenario.viewports || scenario.viewports.includes(vp)).map((vp) => ({ scenario, index, vp })),
  );
  const runs: ScenarioRun[] = [];
  let cursor = 0;
  let finished = 0;

  const worker = async () => {
    while (!aborted) {
      const job = jobs[cursor++];
      if (!job) return;
      const run = await runScenario(
        { browser, files, outDir, consoleErrors: options.consoleErrors, timeoutMs: options.timeoutMs, ...(options.theme ? { theme: options.theme } : {}), ...(options.corners ? { corners: options.corners } : {}) },
        job.scenario,
        job.index,
        job.vp,
      );
      runs.push(run);
      finished += 1;
      const r = run.result;
      console.log(`[${pad(finished)}/${pad(jobs.length)}] ${r.status.padEnd(4)} ${job.vp.padEnd(7)} ${pad(r.index)} ${r.name} (${(r.durationMs / 1000).toFixed(1)} s)`);
      for (const issue of r.issues.filter((i) => i.severity === 'fail').slice(0, 3)) console.log(`        ${issue.kind}: ${issue.message.slice(0, 200)}`);
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(options.workers, jobs.length) }, worker));
  } finally {
    await browser.close().catch(() => undefined);
  }

  const order = (r: ScenarioResult) => r.index * 10 + viewportNames.indexOf(r.viewport as ViewportName);
  const results = runs.map((r) => r.result).sort((a, b) => order(a) - order(b));

  const count = <T,>(items: T[], key: (t: T) => string) => {
    const map = new Map<string, number>();
    for (const item of items) map.set(key(item), (map.get(key(item)) ?? 0) + 1);
    return [...map.entries()];
  };
  const report: Report = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    outDir,
    distDir,
    chrome: chrome.path,
    viewports: viewportNames,
    results,
    unhandled: summarizeUnhandled(runs.flatMap((r) => r.unhandled)),
    warnings: aborted ? [...warnings, 'the run was interrupted: results are incomplete'] : warnings,
    blockedExternal: count(runs.flatMap((r) => r.blocked), (b) => b.url).map(([url, n]) => ({ url, count: n })),
    edgeFunctions: count(runs.flatMap((r) => r.functionCalls), (n) => n).map(([name, n]) => ({ name, count: n })),
    ignoredConsole: runs.reduce((sum, r) => sum + r.ignoredConsole, 0),
  };
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, 'report.md'), renderMarkdown(report));
  console.log(`\n${renderSummary(report)}`);
  return aborted ? 1 : exitCodeOf(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : error);
      process.exit(2);
    },
  );
}
