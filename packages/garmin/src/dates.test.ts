import { describe, expect, it } from 'vitest';
import { addDays, chunkDateRange, diffDays, eachDate, formatYmd, fromDayNumber, isLeapYear, isValidYmd, leadingYmd, parseYmd, toDayNumber, utcDateOf } from './dates';
import { GarminError } from './errors';

describe('parse / validate', () => {
  it('accepts valid dates and rejects impossible ones', () => {
    expect(isValidYmd('2026-11-10')).toBe(true);
    expect(isValidYmd('2028-02-29')).toBe(true);
    expect(isValidYmd('2026-02-29')).toBe(false);
    expect(isValidYmd('2026-13-01')).toBe(false);
    expect(isValidYmd('2026-00-10')).toBe(false);
    expect(isValidYmd('2026-04-31')).toBe(false);
    expect(isValidYmd('26-11-10')).toBe(false);
    expect(isValidYmd('2026-11-10T00:00')).toBe(false);
    expect(isValidYmd(20261110)).toBe(false);
    expect(parseYmd(null)).toBeNull();
  });
  it('leap years', () => {
    expect([1900, 2000, 2024, 2026, 2100].map(isLeapYear)).toEqual([false, true, true, false, false]);
  });
  it('leadingYmd takes the date part of timestamps', () => {
    expect(leadingYmd('2026-11-09 06:30:00')).toBe('2026-11-09');
    expect(leadingYmd('2026-11-09T06:30:00.000Z')).toBe('2026-11-09');
    expect(leadingYmd('nope')).toBeNull();
    expect(leadingYmd(5)).toBeNull();
  });
});

describe('day numbers and addDays', () => {
  it('round-trips and matches Date.UTC', () => {
    for (const s of ['1970-01-01', '2000-02-29', '2026-03-29', '2026-10-25', '2026-11-10', '2099-12-31', '1999-12-31']) {
      const p = parseYmd(s)!;
      const n = toDayNumber(p);
      expect(fromDayNumber(n)).toEqual(p);
      const d = new Date(`${s}T00:00:00Z`);
      expect(n).toBe(Math.round(d.getTime() / 86_400_000));
    }
  });
  it('adds across month, year and leap boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-11-10', 0)).toBe('2026-11-10');
    expect(addDays('2026-11-10', 365)).toBe('2027-11-10');
  });
  it('is not affected by DST transitions', () => {
    // EU DST: 2026-03-29 (spring forward), 2026-10-25 (fall back); US: 2026-03-08, 2026-11-01
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(addDays('2026-10-24', 2)).toBe('2026-10-26');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
    expect(diffDays('2026-03-01', '2026-04-01')).toBe(31);
    expect(diffDays('2026-10-01', '2026-11-01')).toBe(31);
  });
  it('diffDays is signed', () => {
    expect(diffDays('2026-11-10', '2026-11-07')).toBe(-3);
    expect(diffDays('2026-11-07', '2026-11-10')).toBe(3);
  });
  it('throws a GarminError for invalid input', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow(GarminError);
    expect(() => diffDays('x', '2026-01-01')).toThrow(GarminError);
  });
  it('formatYmd pads and utcDateOf maps instants', () => {
    expect(formatYmd({ y: 2026, m: 3, d: 4 })).toBe('2026-03-04');
    expect(utcDateOf(Date.UTC(2026, 10, 9, 23, 59, 59))).toBe('2026-11-09');
    expect(utcDateOf(Date.UTC(2026, 10, 10, 0, 0, 0))).toBe('2026-11-10');
  });
  it('eachDate is inclusive', () => {
    expect(eachDate('2026-02-27', '2026-03-02')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
    expect(eachDate('2026-11-10', '2026-11-10')).toEqual(['2026-11-10']);
    expect(eachDate('2026-11-11', '2026-11-10')).toEqual([]);
  });
});

describe('chunkDateRange', () => {
  it('returns one chunk when the range fits', () => {
    expect(chunkDateRange('2026-11-01', '2026-11-28', 28)).toEqual([{ start: '2026-11-01', end: '2026-11-28' }]);
    expect(chunkDateRange('2026-11-10', '2026-11-10', 31)).toEqual([{ start: '2026-11-10', end: '2026-11-10' }]);
  });
  it('splits inclusively without gaps or overlaps', () => {
    expect(chunkDateRange('2026-11-01', '2026-11-29', 28)).toEqual([
      { start: '2026-11-01', end: '2026-11-28' },
      { start: '2026-11-29', end: '2026-11-29' },
    ]);
    const c = chunkDateRange('2026-01-01', '2026-03-31', 31);
    expect(c).toEqual([
      { start: '2026-01-01', end: '2026-01-31' },
      { start: '2026-02-01', end: '2026-03-03' },
      { start: '2026-03-04', end: '2026-03-31' },
    ]);
  });
  it('covers every day exactly once across a full year (non-leap and leap)', () => {
    for (const [a, b, n] of [['2026-01-01', '2026-12-31', 365], ['2028-01-01', '2028-12-31', 366]] as const) {
      const chunks = chunkDateRange(a, b, 31);
      expect(chunks.reduce((s, c) => s + diffDays(c.start, c.end) + 1, 0)).toBe(n);
      for (let i = 1; i < chunks.length; i++) expect(addDays(chunks[i - 1]!.end, 1)).toBe(chunks[i]!.start);
      expect(chunks[0]!.start).toBe(a);
      expect(chunks[chunks.length - 1]!.end).toBe(b);
      expect(chunks.every((c) => diffDays(c.start, c.end) + 1 <= 31)).toBe(true);
    }
  });
  it('handles the leap day', () => {
    expect(chunkDateRange('2028-02-28', '2028-03-01', 2)).toEqual([
      { start: '2028-02-28', end: '2028-02-29' },
      { start: '2028-03-01', end: '2028-03-01' },
    ]);
  });
  it('is DST-safe', () => {
    const c = chunkDateRange('2026-03-27', '2026-04-02', 3);
    expect(c.map((x) => `${x.start}..${x.end}`)).toEqual(['2026-03-27..2026-03-29', '2026-03-30..2026-04-01', '2026-04-02..2026-04-02']);
  });
  it('splits a 400-day range into 365 + 35', () => {
    const c = chunkDateRange('2025-10-01', '2026-11-04', 365);
    expect(c).toHaveLength(2);
    expect(diffDays(c[0]!.start, c[0]!.end) + 1).toBe(365);
  });
  it('is empty when start is after end', () => {
    expect(chunkDateRange('2026-11-11', '2026-11-10', 5)).toEqual([]);
  });
  it('rejects bad arguments', () => {
    expect(() => chunkDateRange('2026-11-01', '2026-11-10', 0)).toThrow(GarminError);
    expect(() => chunkDateRange('2026-11-01', '2026-11-10', 1.5)).toThrow(GarminError);
    expect(() => chunkDateRange('bad', '2026-11-10', 5)).toThrow(GarminError);
  });
});
