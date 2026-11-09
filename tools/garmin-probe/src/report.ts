// Plain-text report of what the mappers could and could not find.

import type { GarminDiagnostic, GarminFieldCoverage } from '@cal/garmin';

export interface EndpointReportInput {
  endpoint: string;
  title?: string;
  requests: number;
  /** Number of response chunks / pages received. */
  responses: number;
  coverage: readonly GarminFieldCoverage[];
  diagnostics: readonly GarminDiagnostic[];
  errors: ReadonlyArray<{ kind: string; status?: number; message: string; start?: string; end?: string }>;
  /** True when the endpoint has no mapper. */
  unmapped?: boolean;
  /** Strip numbers from `implausible` details so a shared report does not contain values. */
  redactValues?: boolean;
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

export function sanitizeDetail(d: GarminDiagnostic, redactValues: boolean): string {
  const detail = d.detail ?? '';
  if (!redactValues || d.reason !== 'implausible') return detail;
  return detail.replace(/-?\d+(\.\d+)?/g, '#');
}

export function formatEndpointReport(r: EndpointReportInput): string {
  const lines: string[] = [];
  lines.push(`== ${r.endpoint}${r.title ? `  (${r.title})` : ''}`);
  lines.push(`   requests: ${r.requests}, responses with data: ${r.responses}`);
  for (const e of r.errors) {
    lines.push(`   ERROR ${e.kind}${e.status !== undefined ? ` HTTP ${e.status}` : ''}${e.start ? ` [${e.start}..${e.end ?? e.start}]` : ''}: ${e.message}`);
  }
  if (r.unmapped) {
    lines.push('   (no mapper: only the structure file is useful)');
    return lines.join('\n');
  }
  if (r.coverage.length) {
    lines.push(`   ${pad('field', 28)}${pad('found', 9)}matched by`);
    for (const c of r.coverage) {
      const status = c.total === 0 ? '-' : `${c.found}/${c.total}`;
      const by = Object.entries(c.matchedBy).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n})`).join(', ');
      const flag = c.total > 0 && c.found === 0 ? 'NOT FOUND' : by || '-';
      lines.push(`   ${pad(c.field, 28)}${pad(status, 9)}${flag}`);
    }
  } else if (!r.errors.length) {
    lines.push('   (nothing to map: empty response)');
  }
  const notes = r.diagnostics.filter((d) => d.reason !== 'missing' || !r.coverage.some((c) => c.field === d.field));
  for (const d of notes) {
    const detail = sanitizeDetail(d, r.redactValues === true);
    lines.push(`   - ${d.reason}: ${d.field} x${d.count}${d.of !== undefined ? ` of ${d.of}` : ''}${detail ? ` - ${detail}` : ''}${d.sampleDate ? ` (e.g. ${d.sampleDate})` : ''}`);
  }
  const missing = r.diagnostics.filter((d) => d.reason === 'missing' && r.coverage.some((c) => c.field === d.field));
  for (const d of missing) {
    lines.push(`   - missing: ${d.field} x${d.count}${d.of !== undefined ? ` of ${d.of}` : ''} - ${d.detail ?? ''}`);
  }
  return lines.join('\n');
}
