import { describe, expect, it } from 'vitest';
import type { GarminDiagnostic, GarminFieldCoverage } from '@cal/garmin';
import { formatEndpointReport, sanitizeDetail } from './report';

const cov: GarminFieldCoverage[] = [
  { endpoint: 'dailySummaries', field: 'activeKcal', total: 3, found: 3, matchedBy: { activeKilocalories: 2, activeKcal: 1 } },
  { endpoint: 'dailySummaries', field: 'restingKcal', total: 3, found: 0, matchedBy: {} },
  { endpoint: 'dailySummaries', field: 'stress', total: 3, found: 2, matchedBy: { averageStressLevel: 2 } },
];
const diags: GarminDiagnostic[] = [
  { endpoint: 'dailySummaries', field: 'restingKcal', reason: 'missing', count: 3, of: 3, detail: 'none of: bmrKilocalories, restingKcal', sampleDate: '2026-11-09' },
  { endpoint: 'dailySummaries', field: 'stress', reason: 'implausible', count: 1, of: 3, detail: 'averageStressLevel: 250 above 100' },
  { endpoint: 'dailySummaries', field: 'totalKcal', reason: 'fallback_used', count: 3, detail: 'total = active + resting' },
];

describe('formatEndpointReport', () => {
  const text = formatEndpointReport({ endpoint: 'dailySummaries', title: 'Daily summaries', requests: 1, responses: 1, coverage: cov, diagnostics: diags, errors: [] });
  it('shows found counts and the matching JSON keys', () => {
    expect(text).toContain('== dailySummaries  (Daily summaries)');
    expect(text).toMatch(/activeKcal\s+3\/3\s+activeKilocalories \(2\), activeKcal \(1\)/);
    expect(text).toMatch(/stress\s+2\/3\s+averageStressLevel \(2\)/);
  });
  it('flags fields that were not found and lists the names that were tried', () => {
    expect(text).toMatch(/restingKcal\s+0\/3\s+NOT FOUND/);
    expect(text).toContain('missing: restingKcal x3 of 3 - none of: bmrKilocalories, restingKcal');
  });
  it('lists other diagnostics', () => {
    expect(text).toContain('fallback_used: totalKcal x3');
    expect(text).toContain('implausible: stress x1 of 3');
  });
  it('can strip numbers from implausible details so a shared report holds no values', () => {
    const redacted = formatEndpointReport({ endpoint: 'dailySummaries', requests: 1, responses: 1, coverage: cov, diagnostics: diags, errors: [], redactValues: true });
    expect(redacted).toContain('averageStressLevel: # above #');
    expect(redacted).not.toContain('250');
    expect(sanitizeDetail(diags[1]!, true)).toBe('averageStressLevel: # above #');
    expect(sanitizeDetail(diags[1]!, false)).toBe('averageStressLevel: 250 above 100');
    expect(sanitizeDetail(diags[0]!, true)).toBe('none of: bmrKilocalories, restingKcal');
  });
  it('prints request errors', () => {
    const t = formatEndpointReport({ endpoint: 'sleep', requests: 2, responses: 1, coverage: [], diagnostics: [], errors: [{ kind: 'server', status: 503, message: 'Garmin is having trouble', start: '2026-11-01', end: '2026-11-07' }] });
    expect(t).toContain('ERROR server HTTP 503 [2026-11-01..2026-11-07]: Garmin is having trouble');
  });
  it('explains empty and unmapped endpoints', () => {
    expect(formatEndpointReport({ endpoint: 'hrv', requests: 1, responses: 0, coverage: [], diagnostics: [], errors: [] })).toContain('empty response');
    expect(formatEndpointReport({ endpoint: 'hydration', requests: 1, responses: 1, coverage: [], diagnostics: [], errors: [], unmapped: true })).toContain('no mapper');
  });
});
