import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENDPOINT_IDS } from '@cal/garmin';
import { DEFAULT_DAYS, parseProbeArgs, USAGE } from './args';

const ctx = { defaultOutDir: '/repo/tools/garmin-probe/out', baseDir: '/repo' };
const parse = (...argv: string[]) => parseProbeArgs(argv, ctx);
const ok = (...argv: string[]) => {
  const r = parse(...argv);
  if (!r.ok) throw new Error(r.error);
  return r.args;
};

describe('parseProbeArgs', () => {
  it('has safe defaults: 3 days, structure only, all endpoints, default out dir', () => {
    expect(ok()).toEqual({ days: DEFAULT_DAYS, outDir: '/repo/tools/garmin-probe/out', raw: false, mapped: false, endpoints: [...ENDPOINT_IDS], cn: false, help: false });
    expect(DEFAULT_DAYS).toBe(3);
  });
  it('ignores the bare -- that pnpm forwards', () => {
    expect(ok('--', '--days', '5').days).toBe(5);
  });
  it('parses --days in both forms', () => {
    expect(ok('--days', '7').days).toBe(7);
    expect(ok('--days=14').days).toBe(14);
    expect(ok('--days', '365').days).toBe(365);
  });
  it('rejects bad --days', () => {
    for (const v of ['0', '-3', '366', 'abc', '1.5', '']) expect(parse('--days', v).ok).toBe(false);
    expect(parse('--days').ok).toBe(false);
    expect(parse('--days', '--raw').ok).toBe(false);
  });
  it('resolves --out relative to the invocation directory', () => {
    expect(ok('--out', 'my-out').outDir).toBe(resolve('/repo', 'my-out'));
    expect(ok('--out=tools/garmin-probe/out2').outDir).toBe(resolve('/repo', 'tools/garmin-probe/out2'));
    expect(ok('--out', '/abs/dir').outDir).toBe('/abs/dir');
    expect(parse('--out').ok).toBe(false);
  });
  it('parses flags', () => {
    expect(ok('--raw').raw).toBe(true);
    expect(ok('--mapped').mapped).toBe(true);
    expect(ok('--cn').cn).toBe(true);
    expect(ok('--help').help).toBe(true);
    expect(ok('-h').help).toBe(true);
    expect(ok('--structure-only').raw).toBe(false);
  });
  it('--raw and --structure-only contradict', () => {
    const r = parse('--raw', '--structure-only');
    expect(r.ok).toBe(false);
  });
  it('parses and validates --endpoints', () => {
    expect(ok('--endpoints', 'sleep,hrv').endpoints).toEqual(['sleep', 'hrv']);
    expect(ok('--endpoints=weight, steps ,weight').endpoints).toEqual(['weight', 'steps']);
    const bad = parse('--endpoints', 'sleep,bogus');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('bogus');
    expect(parse('--endpoints', ',').ok).toBe(false);
    expect(parse('--endpoints').ok).toBe(false);
  });
  it('rejects unknown options', () => {
    const r = parse('--frobnicate');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('--frobnicate');
  });
  it('NEVER accepts the key on the command line', () => {
    for (const argv of [['--key', 'GCDC_abc'], ['--api-key=GCDC_abc'], ['--token', 'x'], ['GCDC_abcdef'], ['--days', 'GCDC_abc'], ['--out', '/tmp/gcdc_x']]) {
      const r = parseProbeArgs(argv, ctx);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain('GARMIN_PERSONAL_API_KEY');
        expect(r.error).not.toContain('abc');
      }
    }
  });
  it('USAGE documents the env var and every option', () => {
    for (const s of ['GARMIN_PERSONAL_API_KEY', '--days', '--out', '--structure-only', '--raw', '--endpoints', '--mapped']) expect(USAGE).toContain(s);
  });
});
