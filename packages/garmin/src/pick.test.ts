import { describe, expect, it } from 'vitest';
import {
  FieldTracker,
  mergeCoverage,
  mergeDiagnostics,
  parseGarminTimestamp,
  pickNumber,
  pickString,
  secondsToHours,
  secondsToMinutes,
  toFiniteNumber,
  weightIsGrams,
  weightToKg,
} from './pick';
import type { GarminDiagnostic } from './normalized';

describe('pickNumber / pickString / toFiniteNumber', () => {
  it('returns the first usable candidate', () => {
    expect(pickNumber({ a: 1, b: 2 }, ['x', 'b', 'a'])).toBe(2);
    expect(pickNumber({ a: null, b: 2 }, ['a', 'b'])).toBe(2);
    expect(pickNumber({ a: '', b: 3 }, ['a', 'b'])).toBe(3);
  });
  it('accepts numeric strings and skips junk', () => {
    expect(pickNumber({ a: ' 72.5 ' }, ['a'])).toBe(72.5);
    expect(pickNumber({ a: '72,5' }, ['a'])).toBe(72.5);
    expect(pickNumber({ a: '1e3' }, ['a'])).toBe(1000);
    expect(pickNumber({ a: 'abc', b: 4 }, ['a', 'b'])).toBe(4);
    expect(pickNumber({ a: NaN, b: Infinity, c: true, d: [] , e: {}}, ['a', 'b', 'c', 'd', 'e'])).toBeUndefined();
    expect(pickNumber({ a: '12abc' }, ['a'])).toBeUndefined();
  });
  it('keeps zero (a real value) but not absence', () => {
    expect(pickNumber({ a: 0 }, ['a'])).toBe(0);
    expect(pickNumber({}, ['a'])).toBeUndefined();
  });
  it('supports dotted paths and case-insensitive names', () => {
    expect(pickNumber({ sleepScores: { overall: { value: 81 } } }, ['sleepScores.overall.value'])).toBe(81);
    expect(pickNumber({ SleepScores: { Overall: { Value: '77' } } }, ['sleepScores.overall.value'])).toBe(77);
    expect(pickNumber({ averageSpO2: 95 }, ['averageSpo2'])).toBe(95);
    expect(pickNumber({ 'a.b': 5 }, ['a.b'])).toBe(5);
  });
  it('never throws on non-objects', () => {
    for (const v of [null, undefined, 5, 'x', [], true]) {
      expect(pickNumber(v, ['a'])).toBeUndefined();
      expect(pickString(v, ['a'])).toBeUndefined();
    }
  });
  it('pickString trims, rejects blanks, stringifies numbers', () => {
    expect(pickString({ a: '  hi ' }, ['a'])).toBe('hi');
    expect(pickString({ a: '   ', b: 'x' }, ['a', 'b'])).toBe('x');
    expect(pickString({ a: 12 }, ['a'])).toBe('12');
    expect(pickString({ a: { x: 1 } }, ['a'])).toBeUndefined();
  });
  it('toFiniteNumber', () => {
    expect(toFiniteNumber('3')).toBe(3);
    expect(toFiniteNumber(null)).toBeUndefined();
    expect(toFiniteNumber('1.2.3')).toBeUndefined();
  });
});

describe('parseGarminTimestamp', () => {
  it('reads Garmin strings as UTC', () => {
    expect(parseGarminTimestamp('2026-11-09 06:30:00')).toBe(Date.UTC(2026, 10, 9, 6, 30, 0));
    expect(parseGarminTimestamp('2026-11-09 06:30:00', 'gmt')).toBe(Date.UTC(2026, 10, 9, 6, 30, 0));
    expect(parseGarminTimestamp('2026-11-09T06:30:00')).toBe(Date.UTC(2026, 10, 9, 6, 30, 0));
  });
  it('handles fractions, minutes-only, date-only and Z', () => {
    expect(parseGarminTimestamp('2026-11-09 06:30:00.0')).toBe(Date.UTC(2026, 10, 9, 6, 30, 0));
    expect(parseGarminTimestamp('2026-11-09 06:30:00.250')).toBe(Date.UTC(2026, 10, 9, 6, 30, 0, 250));
    expect(parseGarminTimestamp('2026-11-09 06:30')).toBe(Date.UTC(2026, 10, 9, 6, 30, 0));
    expect(parseGarminTimestamp('2026-11-09')).toBe(Date.UTC(2026, 10, 9));
    expect(parseGarminTimestamp('2026-11-09T06:30:00Z')).toBe(Date.UTC(2026, 10, 9, 6, 30, 0));
  });
  it('honours explicit offsets', () => {
    expect(parseGarminTimestamp('2026-11-09T06:30:00+01:00')).toBe(Date.UTC(2026, 10, 9, 5, 30, 0));
    expect(parseGarminTimestamp('2026-11-09T06:30:00-0500')).toBe(Date.UTC(2026, 10, 9, 11, 30, 0));
    expect(parseGarminTimestamp('2026-11-09T06:30:00+01')).toBe(Date.UTC(2026, 10, 9, 5, 30, 0));
  });
  it('local variants give the wall clock encoded as UTC', () => {
    const local = parseGarminTimestamp('2026-11-09 07:30:00', 'local')!;
    const gmt = parseGarminTimestamp('2026-11-09 06:30:00', 'gmt')!;
    expect(local - gmt).toBe(3_600_000); // +01:00 offset recoverable from a pair
  });
  it('accepts epoch ms and seconds, numbers or numeric strings', () => {
    expect(parseGarminTimestamp(1_762_669_800_000)).toBe(1_762_669_800_000);
    expect(parseGarminTimestamp(1_762_669_800)).toBe(1_762_669_800_000);
    expect(parseGarminTimestamp('1762669800000')).toBe(1_762_669_800_000);
  });
  it('returns undefined for garbage', () => {
    for (const v of ['', 'yesterday', '2026-13-01 00:00:00', '2026-02-31 00:00:00', '2026-11-09 25:00:00', 5, -1, 0, null, undefined, {}, [], NaN, true]) {
      expect(parseGarminTimestamp(v)).toBeUndefined();
    }
  });
});

describe('unit helpers', () => {
  it('weight grams vs kg heuristic', () => {
    expect(weightToKg(72500)).toBe(72.5);
    expect(weightToKg(72345)).toBe(72.345);
    expect(weightToKg(72.5)).toBe(72.5);
    expect(weightToKg(1000)).toBe(1000);
    expect(weightToKg(1001)).toBe(1.001);
    expect(weightIsGrams(80000)).toBe(true);
    expect(weightIsGrams(80)).toBe(false);
  });
  it('seconds conversions', () => {
    expect(secondsToMinutes(5400)).toBe(90);
    expect(secondsToMinutes(89)).toBe(1);
    expect(secondsToHours(27000)).toBe(7.5);
    expect(secondsToHours(26000)).toBe(7.22);
  });
});


describe('diagnostics helpers', () => {
  it('FieldTracker counts hits, misses and matched keys', () => {
    const t = new FieldTracker('x');
    t.item();
    expect(t.number({ a: 1 }, 'f', ['a', 'b'])).toBe(1);
    expect(t.number({ b: '2' }, 'f', ['a', 'b'])).toBe(2);
    expect(t.number({}, 'f', ['a', 'b'], { date: '2026-01-01' })).toBeUndefined();
    expect(t.number({ a: 'zzz' }, 'f', ['a', 'b'])).toBeUndefined();
    expect(t.number({ a: 500 }, 'f', ['a'], { max: 100 })).toBeUndefined();
    expect(t.coverage()[0]).toEqual({ endpoint: 'x', field: 'f', total: 5, found: 2, matchedBy: { a: 1, b: 1 }, tried: ['a', 'b'] });
    const reasons = t.diagnostics().map((d) => d.reason).sort();
    expect(reasons).toEqual(['implausible', 'missing', 'wrong_type']);
  });
  it('an optional field is counted in the coverage but never reported as missing', () => {
    const t = new FieldTracker('x');
    expect(t.number({}, 'f', ['a'], { optional: true })).toBeUndefined();
    expect(t.diagnostics()).toEqual([]);
    expect(t.coverage()[0]).toMatchObject({ total: 1, found: 0 });
  });
  it('mergeDiagnostics sums counts per endpoint/field/reason', () => {
    const a: GarminDiagnostic = { endpoint: 'e', field: 'f', reason: 'missing', count: 2, of: 3, detail: 'first' };
    const b: GarminDiagnostic = { endpoint: 'e', field: 'f', reason: 'missing', count: 1, of: 4, detail: 'second', sampleDate: '2026-01-01' };
    const c: GarminDiagnostic = { endpoint: 'e', field: 'g', reason: 'missing', count: 1 };
    const merged = mergeDiagnostics([a], [b, c]);
    expect(merged).toHaveLength(2);
    expect(merged.find((d) => d.field === 'f')).toMatchObject({ count: 3, of: 7, detail: 'first', sampleDate: '2026-01-01' });
  });
  it('mergeCoverage sums totals and matched keys and keeps the tried names', () => {
    const m = mergeCoverage(
      [{ endpoint: 'e', field: 'f', total: 2, found: 1, matchedBy: { a: 1 }, tried: ['a', 'b'] }],
      [{ endpoint: 'e', field: 'f', total: 3, found: 3, matchedBy: { a: 1, b: 2 }, tried: ['a', 'c'] }],
    );
    expect(m).toEqual([{ endpoint: 'e', field: 'f', total: 5, found: 4, matchedBy: { a: 2, b: 2 }, tried: ['a', 'b', 'c'] }]);
  });
});
