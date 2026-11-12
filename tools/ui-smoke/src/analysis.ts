/** Turns the mock backend's logs into report issues. Pure. */
import type { CallRecord, UnhandledRecord } from './mock-backend';
import type { Issue } from './report';

/**
 * Error codes that normal app flows can hit on purpose (and handle): reported as WARN. Everything else a
 * PostgREST call answers with (unknown column, invalid input, missing relationship, WHERE-less update, ...) is
 * an app/schema bug => FAIL.
 */
export const BENIGN_BACKEND_CODES: ReadonlySet<string> = new Set([
  'PGRST116', // .single() on 0 / many rows
  '23505', // unique violation (idempotent upserts / retries)
  '23503', // FK violation (the app has fallbacks, e.g. exercise activity codes)
  '23001', // foods immutability trigger (the app creates a new version via supersede_food)
]);

export interface BackendLogs {
  calls: readonly CallRecord[];
  unhandled: readonly UnhandledRecord[];
  warnings: readonly string[];
}

const allowed = (text: string, allow: readonly (string | RegExp)[]): boolean =>
  allow.some((a) => (typeof a === 'string' ? text.includes(a) : a.test(text)));

/** Counts identical issues once ("... (x3)"). */
export function dedupeIssues(issues: readonly Issue[]): Issue[] {
  const map = new Map<string, { issue: Issue; count: number }>();
  for (const issue of issues) {
    const key = `${issue.severity}|${issue.kind}|${issue.message}`;
    const cur = map.get(key);
    if (cur) cur.count += 1;
    else map.set(key, { issue, count: 1 });
  }
  return [...map.values()].map(({ issue, count }) => (count > 1 ? { ...issue, message: `${issue.message} (x${count})` } : issue));
}

export function backendIssues(logs: BackendLogs, allow: readonly (string | RegExp)[] = []): Issue[] {
  const issues: Issue[] = [];
  for (const call of logs.calls) {
    if (call.status < 400 || call.kind === 'function' || call.kind === 'other') continue;
    const text = `${call.method} ${call.path}${call.query} -> ${call.status} ${call.error ?? ''}`.trim();
    if (allowed(text, allow)) continue;
    const code = call.error?.split(':')[0] ?? '';
    const benign = call.kind === 'auth' || BENIGN_BACKEND_CODES.has(code);
    issues.push({ severity: benign ? 'warn' : 'fail', kind: 'backend', message: `backend error: ${text}` });
  }
  for (const u of logs.unhandled) {
    const text = `${u.method} ${u.path}`;
    if (allowed(text, allow)) continue;
    issues.push({ severity: 'fail', kind: 'backend', message: `unhandled backend call: ${text} (${u.reason})` });
  }
  for (const w of logs.warnings) issues.push({ severity: 'warn', kind: 'backend', message: `mock backend: ${w}` });
  return dedupeIssues(issues);
}

/** Which Edge Functions were invoked (they answer 404 not_deployed, except `sign-up`, `send-invite` and `friend-request`). */
export function functionCalls(calls: readonly CallRecord[]): string[] {
  return calls.filter((c) => c.kind === 'function').map((c) => c.target);
}
