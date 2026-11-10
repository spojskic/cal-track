/**
 * Runs ONE scenario at ONE viewport in a fresh browser context with a fresh mock backend, and returns the
 * result with everything the report needs. Never throws: failures become issues.
 *
 * A fresh context per run (instead of one per viewport) isolates localStorage, the persisted react-query cache,
 * the session and the backend data, so mutations of one scenario can never leak into the next one.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Browser, BrowserContext, Page } from 'playwright-core';

import type { AppFiles } from './app-files';
import { waitForInputValue } from './actions';
import { backendIssues, dedupeIssues, functionCalls } from './analysis';
import { buttonLayoutScript, dateShiftScript, inspectPageScript, scrollMetricsScript, seedSessionScript, seedThemeScript } from './browser-scripts';
import { APP_ORIGIN, FIXED_NOW_MS, STORAGE_KEY, TIMEZONE } from './constants';
import { classifyConsole } from './known-noise';
import { buildFixtures } from './fixtures';
import { createMockBackend, type MutationRecord } from './mock-backend';
import type { Issue, IssueKind, ScenarioResult } from './report';
import { statusOf } from './report';
import { installRouting, type BlockedRequest, type RequestLog } from './routing';
import { SEED_SESSION_TTL_SECONDS, buildSession } from './session';
import { THEME_STORAGE_KEY, themeSeedFor, type Corners } from './theme-seed';
import { VIEWPORTS, resolvePath, type Scenario, type ScenarioContext, type TextOptions, type ViewportName } from './types';

export interface RunDeps {
  browser: Browser;
  files: AppFiles;
  outDir: string;
  consoleErrors: 'fail' | 'warn';
  timeoutMs: number;
  /** `--theme=<paletteId>`: the app starts with this palette (the saved theme choice is seeded before it loads). */
  theme?: string;
  /** `--corners=rounded|boxy`: the app starts with this corner style (seeded together with `theme`). */
  corners?: Corners;
}

export interface ScenarioRun {
  result: ScenarioResult;
  unhandled: { scenario: string; method: string; path: string; reason: string }[];
  blocked: BlockedRequest[];
  functionCalls: string[];
  ignoredConsole: number;
}

interface PageInfo {
  textLength: number;
  sample: string;
  fatalHits: string[];
  suspectHits: string[];
}

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'scenario';

const firstLine = (e: unknown): string => {
  const text = e instanceof Error ? e.message : String(e);
  return (text.split('\n').find((l) => l.trim() !== '') ?? text).trim().slice(0, 300);
};

const MAX_TALL_HEIGHT = 5000;
/** Fewer visible characters than this is a blank screen. */
const MIN_TEXT_LENGTH = 20;
/** How long a nearly empty screen may still be loading before it counts as blank. */
const BLANK_GRACE_MS = 6000;
const BLANK_POLL_MS = 250;

export async function runScenario(deps: RunDeps, scenario: Scenario, index: number, viewportName: ViewportName): Promise<ScenarioRun> {
  const started = Date.now();
  const vp = VIEWPORTS[viewportName];
  const fixtures = buildFixtures(scenario.fixtures ?? 'default');
  const backend = createMockBackend(fixtures.seed);
  const log: RequestLog = { blocked: [], app404: [] };
  const issues: Issue[] = [];
  const screenshots: string[] = [];
  let ignoredConsole = 0;
  let textLength = 0;
  let context: BrowserContext | undefined;
  let page: Page | undefined;

  const dir = join(deps.outDir, viewportName);
  mkdirSync(dir, { recursive: true });
  const base = `${String(index).padStart(3, '0')}-${slugify(scenario.name)}`;
  const push = (severity: Issue['severity'], kind: IssueKind, message: string) => issues.push({ severity, kind, message });

  const capture = async (suffix: string, tall: boolean): Promise<void> => {
    if (!page) return;
    const file = `${base}${suffix}.png`;
    try {
      await page.screenshot({ path: join(dir, file), animations: 'disabled', caret: 'hide' });
      screenshots.push(`${viewportName}/${file}`);
    } catch (e) {
      push('warn', 'harness', `screenshot ${file} failed: ${firstLine(e)}`);
      return;
    }
    if (!tall) return;
    try {
      const metrics = (await page.evaluate(scrollMetricsScript())) as { innerWidth: number; innerHeight: number; extra: number };
      if (metrics.extra > 40) {
        const tallFile = `${base}${suffix}-full.png`;
        await page.setViewportSize({ width: metrics.innerWidth, height: Math.min(metrics.innerHeight + metrics.extra + 8, MAX_TALL_HEIGHT) });
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(dir, tallFile), animations: 'disabled', caret: 'hide', scale: 'css' });
        screenshots.push(`${viewportName}/${tallFile}`);
        await page.setViewportSize({ width: metrics.innerWidth, height: metrics.innerHeight });
        await page.waitForTimeout(200);
      }
    } catch (e) {
      push('warn', 'harness', `tall screenshot failed: ${firstLine(e)}`);
    }
  };

  const settle = async (extraMs = 400): Promise<void> => {
    if (!page) return;
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => undefined);
    await page.waitForTimeout(extraMs);
  };

  const inspect = async (): Promise<void> => {
    if (!page) return;
    // A screen that is still loading (spinner, a retried request) is not blank: wait for the network to go idle and
    // give it a moment to render text before judging.
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);
    let info = (await page.evaluate(inspectPageScript())) as PageInfo;
    for (let waited = 0; info.textLength < MIN_TEXT_LENGTH && waited < BLANK_GRACE_MS; waited += BLANK_POLL_MS) {
      await page.waitForTimeout(BLANK_POLL_MS);
      info = (await page.evaluate(inspectPageScript())) as PageInfo;
    }
    textLength = info.textLength;
    if (info.textLength < MIN_TEXT_LENGTH) push('fail', 'blank', `Blank screen: ${info.textLength} characters of visible text`);
    const allowText = scenario.allowText ?? [];
    for (const hit of info.fatalHits) if (!allowText.some((re) => re.test(hit))) push('fail', 'overlay', `Error text on the screen: "${hit}"`);
    for (const hit of info.suspectHits) if (!allowText.some((re) => re.test(hit))) push('warn', 'text', `Suspicious text on the screen: "${hit}" (${info.sample.slice(0, 120)}...)`);
    // Buttons: labels that wrap in a pill, are cut off or stick out (checked on every screen and every viewport).
    const buttonIssues: unknown = await page.evaluate(buttonLayoutScript()).catch(() => []);
    if (Array.isArray(buttonIssues)) for (const issue of buttonIssues) push('warn', 'layout', `Button ${String(issue)}`);
  };

  const textTimeout = (o?: TextOptions) => o?.timeout ?? 8000;

  const ctx = (p: Page): ScenarioContext => ({
    page: p,
    backend,
    fixtures,
    viewport: viewportName,
    // phone and phone-dark (and any future phone-sized viewport): the layout depends on the width, not on the colour scheme
    isPhone: vp.width < 600,
    async step(label, fn) {
      try {
        await fn();
        return true;
      } catch (e) {
        push('warn', 'step', `${label}: ${firstLine(e)}`);
        return false;
      }
    },
    async check(label, fn) {
      try {
        await fn();
        return true;
      } catch (e) {
        push('fail', 'assertion', `${label}: ${firstLine(e)}`);
        return false;
      }
    },
    async expectText(text, o) {
      try {
        await p.getByText(text, { exact: o?.exact ?? false }).first().waitFor({ state: 'visible', timeout: textTimeout(o) });
        return true;
      } catch {
        push('fail', 'assertion', `Expected text not visible: ${String(text)}`);
        return false;
      }
    },
    async expectNoText(text, o) {
      try {
        await p.getByText(text, { exact: o?.exact ?? false }).first().waitFor({ state: 'hidden', timeout: textTimeout(o) });
        return true;
      } catch {
        push('fail', 'assertion', `Text should not be visible: ${String(text)}`);
        return false;
      }
    },
    async expectInputValue(field, value, o) {
      const result = await waitForInputValue(p, field, value, textTimeout(o));
      if (result.ok) return true;
      const actual = result.actual === null ? '' : ` but it is "${result.actual.slice(0, 80)}"`;
      const why = result.error && result.actual === null ? ` (${result.error.slice(0, 120)})` : '';
      push('fail', 'assertion', `Expected input ${String(field)} to have the value ${String(value)}${actual}${why}`);
      return false;
    },
    async expectUrl(pattern, timeout = 8000) {
      try {
        await p.waitForURL(pattern, { timeout });
        return true;
      } catch {
        push('fail', 'assertion', `Expected URL ${String(pattern)} but the page is at ${p.url()}`);
        return false;
      }
    },
    async expectMutation(table, op, predicate, timeout = 6000) {
      const find = (): MutationRecord | undefined => backend.mutationsOf(table, op).find((m) => !predicate || predicate(m));
      const deadline = Date.now() + timeout;
      for (;;) {
        if (find()) return true;
        if (Date.now() > deadline) break;
        await p.waitForTimeout(100);
      }
      const seen = backend.mutations.map((m) => `${m.ok ? '' : 'failed '}${m.op} ${m.table}`).join(', ') || 'no mutations';
      push('fail', 'assertion', `Expected ${op} on ${table}${predicate ? ' (matching the predicate)' : ''}; recorded: ${seen}`);
      return false;
    },
    settle,
    async snapshot(label, o) {
      await capture(`-${slugify(label)}`, o?.tall ?? true);
    },
    warn: (m) => push('warn', 'assertion', m),
    fail: (m) => push('fail', 'assertion', m),
  });

  const work = async (): Promise<void> => {
    context = await deps.browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.deviceScaleFactor,
      isMobile: vp.isMobile,
      hasTouch: vp.hasTouch,
      locale: 'en-US',
      timezoneId: TIMEZONE,
      colorScheme: vp.colorScheme ?? 'light',
      serviceWorkers: 'block',
      ignoreHTTPSErrors: true,
    });
    await context.addInitScript({ content: dateShiftScript(FIXED_NOW_MS) });
    if (scenario.auth === 'signed-in') {
      const session = buildSession(fixtures.user, { nowMs: FIXED_NOW_MS, ttlSeconds: SEED_SESSION_TTL_SECONDS });
      await context.addInitScript({ content: seedSessionScript({ origin: APP_ORIGIN, storageKey: STORAGE_KEY, session }) });
    }
    const themePrefs = themeSeedFor({ theme: deps.theme, corners: deps.corners });
    if (themePrefs) await context.addInitScript({ content: seedThemeScript({ origin: APP_ORIGIN, storageKey: THEME_STORAGE_KEY, prefs: themePrefs }) });
    await installRouting(context, { files: deps.files, getBackend: () => backend, log });

    page = await context.newPage();
    const pg = page;
    pg.on('console', (msg) => {
      const verdict = classifyConsole(
        { type: msg.type(), text: msg.text(), url: msg.location().url },
        { extra: scenario.allowConsole ?? [], errorSeverity: deps.consoleErrors },
      );
      if (verdict.kind === 'ignore') {
        if (msg.type() === 'error' || msg.type() === 'warning') ignoredConsole += 1;
      } else {
        push(verdict.kind, 'console', `console.${msg.type()}: ${msg.text().slice(0, 400)}`);
      }
    });
    pg.on('pageerror', (err) => push('fail', 'pageerror', `Uncaught exception: ${firstLine(err)}`));
    pg.on('crash', () => push('fail', 'harness', 'The page crashed'));
    pg.on('requestfailed', (req) => {
      const failure = req.failure()?.errorText ?? 'failed';
      if (log.blocked.some((b) => b.url === req.url())) return;
      if (/ERR_ABORTED/.test(failure)) return;
      push('warn', 'request', `request failed: ${req.method()} ${req.url().slice(0, 160)} (${failure})`);
    });
    pg.on('dialog', (dialog) => {
      void dialog.accept().catch(() => undefined);
    });

    const c = ctx(pg);
    await scenario.setup?.(pg, c);

    const path = resolvePath(scenario, fixtures);
    await pg.goto(`${APP_ORIGIN}${path}`, { waitUntil: 'load', timeout: 60_000 });
    await settle();
    await inspect();
    for (const expected of scenario.expect ?? []) await c.expectText(expected);
    for (const input of scenario.expectInputs ?? []) await c.expectInputValue(input.field, input.value);
    await capture('', true);

    if (scenario.after) {
      await scenario.after(pg, c);
      await settle();
      await inspect();
      await capture('-after', true);
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const workPromise = work();
  workPromise.catch(() => undefined); // may reject after a timeout, when the context is torn down
  const outcome: 'done' | 'timeout' | { error: unknown } = await Promise.race([
    workPromise.then(() => 'done' as const),
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), deps.timeoutMs);
    }),
  ]).catch((error: unknown) => ({ error }));
  if (timer) clearTimeout(timer);

  if (outcome === 'timeout') push('fail', 'timeout', `Scenario run exceeded ${Math.round(deps.timeoutMs / 1000)} s`);
  else if (outcome !== 'done') push('fail', 'harness', `Scenario crashed: ${firstLine(outcome.error)}`);
  if (outcome !== 'done' && page) await capture('-FAILED', false).catch(() => undefined);

  if (context) {
    await Promise.race([context.close().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 10_000))]);
  }

  issues.push(...backendIssues(backend, scenario.allowBackendErrors ?? []));
  const seenBlocked = new Set<string>();
  for (const b of log.blocked) {
    if (seenBlocked.has(b.url)) continue;
    seenBlocked.add(b.url);
    push('warn', 'external', `blocked external request: ${b.method} ${b.url.slice(0, 200)} (${b.resourceType})`);
  }
  for (const missing of new Set(log.app404)) push('warn', 'request', `404 from the build: ${missing}`);

  const finalIssues = dedupeIssues(issues);
  const unhandled = backend.unhandled.map((u) => ({ scenario: scenario.name, method: u.method, path: u.path, reason: u.reason }));
  return {
    result: {
      index,
      name: scenario.name,
      route: scenario.route,
      path: resolvePath(scenario, fixtures),
      viewport: viewportName,
      status: statusOf(finalIssues),
      durationMs: Date.now() - started,
      issues: finalIssues,
      screenshots,
      backendCalls: backend.calls.length,
      mutations: backend.mutations.filter((m) => m.ok).length,
      textLength,
    },
    unhandled,
    blocked: log.blocked,
    functionCalls: functionCalls(backend.calls),
    ignoredConsole,
  };
}
