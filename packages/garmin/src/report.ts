// Plain-text sync report: what the last sync asked Garmin for and what it found, so the user can paste it back when a
// field name was a guess. It contains NO health values, NO ids and NO tokens: only endpoint templates, HTTP outcomes,
// counts, and the NAMES of the JSON fields that were (or were not) found.

import { DETAIL_ENDPOINT_ORDER, type DetailStats } from './activity-details';
import { ENDPOINT_TEMPLATES } from './constants';
import type { GarminDiagnostic, GarminFieldCoverage } from './normalized';
import type { GarminSyncCounts, GarminSyncReport } from './sync';

export interface ReportInfo {
  generatedAtMs: number;
  /** e.g. 'Ration 0.1.0 (ios)'. Optional. */
  app?: string;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Diagnostics whose `detail` is safe to print (key names and static text). 'implausible' / 'skipped' can carry numbers. */
const DETAIL_SAFE: ReadonlySet<GarminDiagnostic['reason']> = new Set(['missing', 'wrong_type', 'unexpected_shape', 'fallback_used', 'converted']);

function fieldLine(c: GarminFieldCoverage): string {
  if (c.found === 0) {
    return `  ${c.field}: NOT FOUND in ${plural(c.total, 'reply', 'replies')} (tried: ${c.tried.join(', ')})`;
  }
  const via = Object.entries(c.matchedBy)
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => (Object.keys(c.matchedBy).length > 1 ? `${key} (${n})` : key))
    .join(', ');
  return `  ${c.field}: found ${c.found} of ${c.total} via ${via}`;
}

function resultsText(results: Record<string, number>): string {
  const parts = Object.entries(results).map(([label, n]) => `${label} ${n}`);
  return parts.length > 0 ? parts.join(', ') : 'none';
}

/** The report as text. Deterministic for a given input (no clock reads). */
export function formatSyncReport(report: GarminSyncReport, info: ReportInfo, counts?: GarminSyncCounts): string {
  const lines: string[] = [];
  lines.push('Ration - Garmin sync report');
  lines.push(`Generated: ${new Date(info.generatedAtMs).toISOString()}`);
  if (info.app) lines.push(`App: ${info.app}`);
  lines.push(`Range: ${report.range.from} to ${report.range.to} (${plural(report.days, 'day', 'days')})`);
  lines.push(`Duration: ${Math.max(0, Math.round((report.finishedAtMs - report.startedAtMs) / 100) / 10)} s`);
  if (report.stop) {
    const where = report.stop.endpoint === 'writer' ? 'while saving' : `at ${report.stop.endpoint}`;
    lines.push(`Result: STOPPED ${where}: ${report.stop.kind}${report.stop.retryAfterSec !== undefined ? ` (Retry-After ${report.stop.retryAfterSec} s)` : ''}`);
    lines.push(`  ${report.stop.message}`);
  } else {
    lines.push('Result: finished');
  }
  if (counts) {
    const bio = Object.entries(counts.biometrics)
      .map(([type, n]) => `${type} ${n}`)
      .join(', ');
    lines.push(
      `Rows: ${plural(counts.energyDays, 'energy day', 'energy days')}, ${plural(counts.workouts, 'workout', 'workouts')}` +
        (bio ? `, ${bio}` : ''),
    );
  }

  lines.push('');
  lines.push('Endpoints (all GET, nothing is written to Garmin)');
  if (report.endpoints.length === 0) lines.push('  (no request was sent)');
  for (const e of report.endpoints) {
    lines.push(`${e.endpoint}: ${e.path}`);
    lines.push(`  ${plural(e.requests, 'request', 'requests')}: ${resultsText(e.results)}; with data: ${e.records}`);
  }

  const notFound = report.coverage.filter((c) => c.found === 0 && c.total > 0);
  lines.push('');
  lines.push(
    notFound.length > 0
      ? `Fields NOT found: ${notFound.map((c) => `${c.endpoint}.${c.field}`).join(', ')}`
      : 'Fields NOT found: none',
  );

  const byEndpoint = new Map<string, GarminFieldCoverage[]>();
  for (const c of report.coverage) byEndpoint.set(c.endpoint, [...(byEndpoint.get(c.endpoint) ?? []), c]);
  if (byEndpoint.size > 0) {
    lines.push('');
    lines.push('Fields (JSON key that matched; no values are included)');
    for (const [endpoint, list] of byEndpoint) {
      lines.push(endpoint);
      for (const c of list) lines.push(fieldLine(c));
    }
  }

  const diagnostics = report.diagnostics.filter((d) => d.reason !== 'missing');
  if (diagnostics.length > 0) {
    lines.push('');
    lines.push('Mapper notes');
    for (const d of diagnostics) {
      const detail = d.detail && DETAIL_SAFE.has(d.reason) ? ` - ${d.detail}` : '';
      lines.push(`  ${d.endpoint}.${d.field}: ${d.reason} x${d.count}${d.of !== undefined ? ` of ${d.of}` : ''}${detail}`);
    }
  }

  if (report.notes.length > 0) {
    lines.push('');
    lines.push('Other notes');
    for (const n of report.notes) lines.push(`  ${n}`);
  }
  return lines.join('\n');
}

/**
 * The "Workout details" section of the report: which per-activity endpoints were asked (all GET), what they answered and which
 * JSON fields were found. Like the rest of the report it has NO values, NO activity ids and NO tokens. Empty string when no
 * workout detail has been read on this phone yet.
 */
export function formatDetailReport(stats: DetailStats | null | undefined): string {
  if (!stats || stats.reads === 0) return '';
  const lines: string[] = [];
  lines.push('Workout details (one activity at a time, all GET; read when a Garmin workout is opened and for the newest ones after a sync)');
  lines.push(`Activities read: ${stats.reads}${stats.lastReadAtMs !== null ? `, last at ${new Date(stats.lastReadAtMs).toISOString()}` : ''}`);
  const stops = Object.entries(stats.stops);
  if (stops.length > 0) lines.push(`Reads stopped early: ${stops.map(([kind, n]) => `${kind} x${n}`).join(', ')}`);
  for (const name of DETAIL_ENDPOINT_ORDER) {
    const e = stats.endpoints[name];
    if (!e) continue;
    lines.push(`${name}: ${ENDPOINT_TEMPLATES[name]}`);
    lines.push(`  ${plural(e.requests, 'request', 'requests')}: ${resultsText(e.results)}`);
  }

  const notFound = stats.coverage.filter((c) => c.found === 0 && c.total > 0);
  lines.push('');
  lines.push(
    notFound.length > 0
      ? `Detail fields NOT found: ${notFound.map((c) => `${c.endpoint}.${c.field}`).join(', ')}`
      : 'Detail fields NOT found: none',
  );
  const byEndpoint = new Map<string, GarminFieldCoverage[]>();
  for (const c of stats.coverage) byEndpoint.set(c.endpoint, [...(byEndpoint.get(c.endpoint) ?? []), c]);
  for (const [endpoint, list] of byEndpoint) {
    lines.push(endpoint);
    for (const c of list) lines.push(fieldLine(c));
  }
  const notes = stats.diagnostics.filter((d) => d.reason !== 'missing');
  if (notes.length > 0) {
    lines.push('');
    lines.push('Detail mapper notes');
    for (const d of notes) {
      const detail = d.detail && DETAIL_SAFE.has(d.reason) ? ` - ${d.detail}` : '';
      lines.push(`  ${d.endpoint}.${d.field}: ${d.reason} x${d.count}${d.of !== undefined ? ` of ${d.of}` : ''}${detail}`);
    }
  }
  return lines.join('\n');
}
