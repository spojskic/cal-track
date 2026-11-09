/** Result model of a smoke run and its JSON / Markdown rendering. Pure. */

export type Status = 'OK' | 'WARN' | 'FAIL';

export type IssueKind =
  | 'console'
  | 'pageerror'
  | 'request'
  | 'backend'
  | 'blank'
  | 'overlay'
  | 'assertion'
  | 'step'
  | 'timeout'
  | 'external'
  | 'text'
  | 'harness';

export interface Issue {
  severity: 'warn' | 'fail';
  kind: IssueKind;
  message: string;
}

export interface ScenarioResult {
  index: number;
  name: string;
  route: string;
  path: string;
  viewport: string;
  status: Status;
  durationMs: number;
  issues: Issue[];
  screenshots: string[];
  backendCalls: number;
  mutations: number;
  textLength: number;
}

export interface UnhandledSummary {
  endpoint: string;
  reason: string;
  count: number;
  scenarios: string[];
}

export interface Report {
  startedAt: string;
  finishedAt: string;
  outDir: string;
  distDir: string;
  chrome: string;
  viewports: string[];
  results: ScenarioResult[];
  unhandled: UnhandledSummary[];
  /** Harness-level warnings: uncovered routes, mock features that are not emulated, ... */
  warnings: string[];
  blockedExternal: { url: string; count: number }[];
  edgeFunctions: { name: string; count: number }[];
  ignoredConsole: number;
}

export function statusOf(issues: readonly Issue[]): Status {
  if (issues.some((i) => i.severity === 'fail')) return 'FAIL';
  return issues.length > 0 ? 'WARN' : 'OK';
}

export interface Totals {
  total: number;
  ok: number;
  warn: number;
  fail: number;
}

export function totalsOf(results: readonly ScenarioResult[]): Totals {
  const t: Totals = { total: results.length, ok: 0, warn: 0, fail: 0 };
  for (const r of results) {
    if (r.status === 'OK') t.ok += 1;
    else if (r.status === 'WARN') t.warn += 1;
    else t.fail += 1;
  }
  return t;
}

/** 1 when any scenario failed. */
export function exitCodeOf(report: Pick<Report, 'results'>): 0 | 1 {
  return report.results.some((r) => r.status === 'FAIL') ? 1 : 0;
}

/** Merges unhandled backend calls of all scenarios into one table. */
export function summarizeUnhandled(items: readonly { scenario: string; method: string; path: string; reason: string }[]): UnhandledSummary[] {
  const map = new Map<string, UnhandledSummary>();
  for (const it of items) {
    const endpoint = `${it.method} ${it.path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')}`;
    const key = `${endpoint}|${it.reason}`;
    const cur = map.get(key) ?? { endpoint, reason: it.reason, count: 0, scenarios: [] };
    cur.count += 1;
    if (!cur.scenarios.includes(it.scenario)) cur.scenarios.push(it.scenario);
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const clip = (text: string, max = 400): string => (text.length > max ? `${text.slice(0, max)}...` : text);

export function renderMarkdown(report: Report): string {
  const lines: string[] = [];
  const totals = totalsOf(report.results);
  lines.push('# Cal Track UI smoke report', '');
  lines.push(`- Started: ${report.startedAt}`, `- Finished: ${report.finishedAt}`, `- Chrome: ${report.chrome}`, `- Build: ${report.distDir}`);
  lines.push(`- Viewports: ${report.viewports.join(', ')}`);
  lines.push(`- Result: **${totals.fail > 0 ? 'FAIL' : totals.warn > 0 ? 'WARN' : 'OK'}** (${totals.ok} OK, ${totals.warn} WARN, ${totals.fail} FAIL of ${totals.total} runs)`, '');

  const names = [...new Set(report.results.map((r) => `${String(r.index).padStart(3, '0')} ${r.name}`))];
  lines.push('## Scenarios', '');
  lines.push(`| Scenario | ${report.viewports.join(' | ')} |`, `| --- | ${report.viewports.map(() => '---').join(' | ')} |`);
  for (const label of names) {
    const row = report.results.filter((r) => `${String(r.index).padStart(3, '0')} ${r.name}` === label);
    const cells = report.viewports.map((vp) => {
      const r = row.find((x) => x.viewport === vp);
      if (!r) return '-';
      return r.status === 'OK' ? 'OK' : `${r.status} (${r.issues.length})`;
    });
    lines.push(`| ${cell(label)} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  const problems = report.results.filter((r) => r.status !== 'OK');
  if (problems.length > 0) {
    lines.push('## Problems', '');
    for (const r of problems) {
      lines.push(`### ${r.status} ${String(r.index).padStart(3, '0')} ${r.name} [${r.viewport}] ${r.path}`, '');
      for (const issue of r.issues) lines.push(`- **${issue.severity.toUpperCase()}** \`${issue.kind}\`: ${cell(clip(issue.message))}`);
      if (r.screenshots.length > 0) lines.push(`- screenshots: ${r.screenshots.join(', ')}`);
      lines.push('');
    }
  }

  lines.push('## Unhandled backend endpoints', '');
  if (report.unhandled.length === 0) lines.push('None: every request was answered by the mock.', '');
  else {
    lines.push('| Endpoint | Reason | Calls | Scenarios |', '| --- | --- | --- | --- |');
    for (const u of report.unhandled) lines.push(`| ${cell(u.endpoint)} | ${cell(u.reason)} | ${u.count} | ${cell(u.scenarios.join(', '))} |`);
    lines.push('');
  }

  if (report.edgeFunctions.length > 0) {
    lines.push('## Edge functions invoked (all answered 404 not_deployed)', '');
    for (const f of report.edgeFunctions) lines.push(`- \`${f.name}\` x ${f.count}`);
    lines.push('');
  }
  if (report.blockedExternal.length > 0) {
    lines.push('## External requests that were blocked', '');
    for (const b of report.blockedExternal) lines.push(`- ${b.url} x ${b.count}`);
    lines.push('');
  }
  if (report.warnings.length > 0) {
    lines.push('## Harness warnings', '');
    for (const w of report.warnings) lines.push(`- ${w}`);
    lines.push('');
  }
  if (report.ignoredConsole > 0) lines.push(`_${report.ignoredConsole} console messages matched the ignore list (src/known-noise.ts)._`, '');
  return `${lines.join('\n')}\n`;
}

/** Short console summary. */
export function renderSummary(report: Report): string {
  const t = totalsOf(report.results);
  const lines = [`UI smoke: ${t.ok} OK, ${t.warn} WARN, ${t.fail} FAIL (${t.total} runs)`];
  for (const r of report.results.filter((x) => x.status === 'FAIL')) {
    lines.push(`  FAIL ${String(r.index).padStart(3, '0')} ${r.name} [${r.viewport}]: ${r.issues.find((i) => i.severity === 'fail')?.message.slice(0, 160) ?? ''}`);
  }
  if (report.unhandled.length > 0) lines.push(`  ${report.unhandled.length} unhandled backend endpoint(s), see report.md`);
  for (const w of report.warnings.slice(0, 8)) lines.push(`  warning: ${w}`);
  lines.push(`  report: ${report.outDir}/report.md`);
  return lines.join('\n');
}
