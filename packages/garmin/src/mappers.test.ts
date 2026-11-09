import { describe, expect, it } from 'vitest';
import {
  FieldTracker,
  mapActivities,
  mapBodyBattery,
  mapDailySummaries,
  mapHeartRateDay,
  mapHrv,
  mapSleep,
  mapSpo2Day,
  mapStepsDaily,
  mapStressDaily,
  mapUserSettings,
  mapWeight,
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
} from './mappers';
import type { GarminBiometric, GarminDiagnostic } from './normalized';

const H = 3_600_000;
/** 2026-11-09 06:00 UTC */
const T0 = Date.UTC(2026, 10, 9, 6, 0, 0);
const SLEEP_START = Date.UTC(2026, 10, 8, 23, 0, 0);
const SLEEP_END = Date.UTC(2026, 10, 9, 6, 30, 0);

const byType = (list: GarminBiometric[], type: string): GarminBiometric[] => list.filter((b) => b.type === type);
const one = (list: GarminBiometric[], type: string): GarminBiometric => {
  const r = byType(list, type);
  expect(r).toHaveLength(1);
  return r[0]!;
};
const diag = (list: GarminDiagnostic[], field: string, reason?: string): GarminDiagnostic | undefined =>
  list.find((d) => d.field === field && (reason === undefined || d.reason === reason));

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

// -------------------------------------------------------------------------------------------------------------------

const summary = (over: Record<string, unknown> = {}) => ({
  userProfileId: 12345,
  calendarDate: '2026-11-09',
  totalKilocalories: 2650,
  activeKilocalories: 612,
  bmrKilocalories: 2038,
  consumedKilocalories: null,
  remainingKilocalories: 2650,
  totalSteps: 9876,
  totalDistanceMeters: 7421,
  wellnessStartTimeGmt: '2026-11-08T23:00:00.0',
  wellnessStartTimeLocal: '2026-11-09T00:00:00.0',
  durationInMilliseconds: 86400000,
  highlyActiveSeconds: 1200,
  restingHeartRate: 52,
  minHeartRate: 46,
  maxHeartRate: 161,
  averageStressLevel: 31,
  bodyBatteryHighestValue: 88,
  bodyBatteryLowestValue: 14,
  bodyBatteryMostRecentValue: 40,
  bodyBatteryChargedValue: 62,
  bodyBatteryDrainedValue: 74,
  avgWakingRespirationValue: 14.2,
  averageSpo2: 95.4,
  lowestSpo2: 90,
  ...over,
});

/**
 * Shape of /usersummary-service/v2/dailysummaries as returned for a real account (Nov 2026), reduced to the
 * fields we read. Values are made up; the NESTING is what matters (this regressed once: flat names matched nothing).
 */
const REAL_V2_DAILY_SUMMARY = {
  uuid: 'x',
  calendarDate: '2026-11-09',
  source: 'GARMIN',
  includesWellnessData: true,
  includesActivityData: true,
  movement: { steps: { goal: 7000, value: 1949, distanceInMeters: 1500 } },
  calories: { burnedResting: 1850, burnedActive: 412, burnedTotal: 2262 },
  heartRate: { minValue: 50, maxValue: 101, restingValue: 53 },
  stress: { avgLevel: 25, maxLevel: 90, qualifier: 'balanced' },
  bodyBattery: { minValue: 24, maxValue: 82, chargedValue: 58, drainedValue: 54, latestValue: 30 },
  respiration: { avgValue: 14, maxValue: 20, minValue: 9, latestValue: 15 },
};

describe('mapDailySummaries (real v2 nested shape)', () => {
  it('reads calories, steps, resting HR, stress, body battery and respiration from nested objects', () => {
    const r = mapDailySummaries({ data: [REAL_V2_DAILY_SUMMARY] });
    expect(r.energy).toEqual([
      { date: '2026-11-09', activeKcal: 412, restingKcal: 1850, totalKcal: 2262, steps: 1949 },
    ]);
    const byType = Object.fromEntries(r.biometrics.map((b) => [b.type, b.value]));
    expect(byType.resting_heart_rate).toBe(53);
    expect(byType.stress).toBe(25);
    expect(byType.body_battery).toBe(82);
    expect(byType.respiration_rate).toBe(14);
  });

  it('reports no missing core fields for the real shape', () => {
    const r = mapDailySummaries({ data: [REAL_V2_DAILY_SUMMARY] });
    const missing = r.diagnostics.filter((d) => /activeKcal|restingKcal|totalKcal|steps|restingHeartRate|stress|bodyBattery/.test(d.field));
    expect(missing).toEqual([]);
  });
});

describe('mapDailySummaries', () => {
  it('maps a realistic {data: [...]} response', () => {
    const r = mapDailySummaries({ data: [summary(), summary({ calendarDate: '2026-11-10', totalSteps: 1200 })] });
    expect(r.energy).toEqual([
      { date: '2026-11-09', activeKcal: 612, restingKcal: 2038, totalKcal: 2650, steps: 9876 },
      { date: '2026-11-10', activeKcal: 612, restingKcal: 2038, totalKcal: 2650, steps: 1200 },
    ]);
    expect(r.dates).toEqual(['2026-11-09', '2026-11-10']);
    const day = r.biometrics.filter((b) => b.date === '2026-11-09');
    expect(one(day, 'resting_heart_rate')).toMatchObject({ value: 52, unit: 'bpm', externalId: 'garmin:resting_heart_rate:2026-11-09', meta: { min: 46, max: 161 } });
    expect(one(day, 'stress')).toMatchObject({ value: 31, unit: 'score' });
    expect(one(day, 'respiration_rate')).toMatchObject({ value: 14.2, unit: 'brpm' });
    expect(one(day, 'spo2')).toMatchObject({ value: 95.4, unit: 'percent', meta: { low: 90 } });
    expect(one(day, 'body_battery')).toMatchObject({
      value: 88,
      unit: 'percent',
      meta: { high: 88, low: 14, charged: 62, drained: 74, latest: 40 },
    });
    expect(r.diagnostics.filter((d) => d.reason === 'missing')).toEqual([]);
  });
  it('accepts a bare array and a single object', () => {
    expect(mapDailySummaries([summary()]).energy).toHaveLength(1);
    expect(mapDailySummaries(summary()).energy).toHaveLength(1);
    expect(mapDailySummaries({ data: { data: [summary()] } }).energy).toHaveLength(1);
  });
  it('treats null, 204 and empty containers as no data without diagnostics', () => {
    for (const raw of [null, undefined, [], {}, { data: [] }, { data: null }]) {
      const r = mapDailySummaries(raw);
      expect(r.energy).toEqual([]);
      expect(r.biometrics).toEqual([]);
      expect(r.diagnostics).toEqual([]);
    }
  });
  it('accepts alternative field names', () => {
    const r = mapDailySummaries([
      {
        date: '2026-11-09',
        activeKcal: 500,
        restingKcal: 1800,
        totalKcal: 2300,
        steps: 4000,
        restingHeartRateInBeatsPerMinute: 55,
        avgStressLevel: 40,
        highestBodyBattery: 70,
        averageRespirationValue: 13,
        avgSpo2: 96,
      },
    ]);
    expect(r.energy[0]).toEqual({ date: '2026-11-09', activeKcal: 500, restingKcal: 1800, totalKcal: 2300, steps: 4000 });
    expect(r.biometrics.map((b) => b.type).sort()).toEqual(['body_battery', 'respiration_rate', 'resting_heart_rate', 'spo2', 'stress']);
  });
  it('accepts numeric strings and derives nothing from them incorrectly', () => {
    const r = mapDailySummaries([summary({ activeKilocalories: '612.4', bmrKilocalories: '2038', totalKilocalories: '2650', totalSteps: '9876', restingHeartRate: '52' })]);
    expect(r.energy[0]).toEqual({ date: '2026-11-09', activeKcal: 612.4, restingKcal: 2038, totalKcal: 2650, steps: 9876 });
    expect(one(r.biometrics, 'resting_heart_rate').value).toBe(52);
  });
  it('missing fields are ABSENT, never 0, and are reported', () => {
    const r = mapDailySummaries([{ calendarDate: '2026-11-09', totalSteps: 3000 }]);
    expect(r.energy).toEqual([{ date: '2026-11-09', steps: 3000 }]);
    expect(r.biometrics).toEqual([]);
    const d = diag(r.diagnostics, 'activeKcal', 'missing')!;
    expect(d.count).toBe(1);
    expect(d.of).toBe(1);
    expect(d.detail).toContain('activeKilocalories');
    expect(d.sampleDate).toBe('2026-11-09');
    for (const f of ['restingHeartRate', 'stress', 'respiration', 'spo2', 'bodyBatteryHigh']) expect(diag(r.diagnostics, f, 'missing')).toBeDefined();
  });
  it('zero or negative values are not data', () => {
    const r = mapDailySummaries([summary({ activeKilocalories: 0, bmrKilocalories: 0, totalKilocalories: 0, totalSteps: 0, averageStressLevel: -1, restingHeartRate: 0 })]);
    expect(r.energy).toEqual([{ date: '2026-11-09', steps: 0 }]);
    expect(byType(r.biometrics, 'stress')).toEqual([]);
    expect(byType(r.biometrics, 'resting_heart_rate')).toEqual([]);
    expect(diag(r.diagnostics, 'stress', 'implausible')).toBeDefined();
  });
  it('derives total / resting / active from the other two and says so', () => {
    const a = mapDailySummaries([{ calendarDate: '2026-11-09', activeKilocalories: 400, bmrKilocalories: 1800 }]);
    expect(a.energy[0]).toEqual({ date: '2026-11-09', activeKcal: 400, restingKcal: 1800, totalKcal: 2200 });
    expect(diag(a.diagnostics, 'totalKcal', 'fallback_used')).toBeDefined();
    const b = mapDailySummaries([{ calendarDate: '2026-11-09', activeKilocalories: 400, totalKilocalories: 2200 }]);
    expect(b.energy[0]).toEqual({ date: '2026-11-09', activeKcal: 400, restingKcal: 1800, totalKcal: 2200 });
    const c = mapDailySummaries([{ calendarDate: '2026-11-09', bmrKilocalories: 1800, totalKilocalories: 2200 }]);
    expect(c.energy[0]).toEqual({ date: '2026-11-09', activeKcal: 400, restingKcal: 1800, totalKcal: 2200 });
  });
  it('does not derive a negative resting value', () => {
    const r = mapDailySummaries([{ calendarDate: '2026-11-09', activeKilocalories: 3000, totalKilocalories: 2200 }]);
    expect(r.energy[0]).toEqual({ date: '2026-11-09', activeKcal: 3000, totalKcal: 2200 });
  });
  it('falls back to the most recent body battery value when the highest is missing', () => {
    const r = mapDailySummaries([{ calendarDate: '2026-11-09', bodyBatteryMostRecentValue: 35 }]);
    expect(one(r.biometrics, 'body_battery').value).toBe(35);
    expect(diag(r.diagnostics, 'bodyBatteryHigh', 'fallback_used')).toBeDefined();
  });
  it('drops implausible values with a diagnostic', () => {
    const r = mapDailySummaries([summary({ restingHeartRate: 400, averageSpo2: 12, avgWakingRespirationValue: 900, bodyBatteryHighestValue: 250, activeKilocalories: 99999 })]);
    expect(byType(r.biometrics, 'resting_heart_rate')).toEqual([]);
    expect(byType(r.biometrics, 'spo2')).toEqual([]);
    expect(byType(r.biometrics, 'respiration_rate')).toEqual([]);
    expect(byType(r.biometrics, 'body_battery').every((b) => b.value <= 100)).toBe(true);
    expect(diag(r.diagnostics, 'restingHeartRate', 'implausible')).toBeDefined();
    expect(diag(r.diagnostics, 'activeKcal', 'implausible')).toBeDefined();
  });
  it('reports wrong types without throwing', () => {
    const r = mapDailySummaries([summary({ restingHeartRate: 'fifty', averageStressLevel: {}, totalSteps: [1] })]);
    expect(byType(r.biometrics, 'resting_heart_rate')).toEqual([]);
    expect(diag(r.diagnostics, 'restingHeartRate', 'wrong_type')!.detail).toContain('restingHeartRate=string');
    expect(diag(r.diagnostics, 'stress', 'wrong_type')).toBeDefined();
    expect(r.energy[0]!.steps).toBeUndefined();
  });
  it('skips items without a date and derives the date from wellnessStartTimeLocal', () => {
    const r = mapDailySummaries([{ totalSteps: 1 }, { wellnessStartTimeLocal: '2026-11-08T00:00:00.0', totalSteps: 5000 }]);
    expect(r.energy).toEqual([{ date: '2026-11-08', steps: 5000 }]);
    expect(diag(r.diagnostics, 'date', 'skipped')!.count).toBe(1);
  });
  it('honours the include flags (no work, no diagnostics for disabled groups)', () => {
    const r = mapDailySummaries([{ calendarDate: '2026-11-09' }], { include: { energy: false, restingHr: false, spo2: false, respiration: false, bodyBattery: false, stress: true } });
    expect(r.diagnostics.map((d) => d.field).filter((f) => f !== 'date')).toEqual(['stress']);
    const e = mapDailySummaries([summary()], { include: { energy: true, restingHr: false, spo2: false, respiration: false, bodyBattery: false, stress: false } });
    expect(e.biometrics).toEqual([]);
    expect(e.energy).toHaveLength(1);
  });
  it('last item wins for duplicate dates', () => {
    const r = mapDailySummaries([summary({ totalSteps: 100 }), summary({ totalSteps: 200 })]);
    expect(r.energy).toHaveLength(1);
    expect(r.energy[0]!.steps).toBe(200);
    expect(r.biometrics.filter((b) => b.type === 'stress')).toHaveLength(1);
  });
  it('unwraps items nested under summary', () => {
    const r = mapDailySummaries([{ summary: summary(), calendarDate: '2026-11-09' }]);
    expect(r.energy[0]!.activeKcal).toBe(612);
  });
  it('coverage records which JSON key satisfied each field', () => {
    const r = mapDailySummaries([summary(), summary({ calendarDate: '2026-11-10' }), { calendarDate: '2026-11-11', activeKcal: 5 }]);
    const cov = r.coverage.find((c) => c.field === 'activeKcal')!;
    expect(cov).toMatchObject({ endpoint: 'dailySummaries', total: 3, found: 3 });
    expect(cov.matchedBy).toEqual({ activeKilocalories: 2, activeKcal: 1 });
    expect(r.coverage.find((c) => c.field === 'stress')).toMatchObject({ total: 3, found: 2 });
  });
});

// -------------------------------------------------------------------------------------------------------------------

const sleepDto = (over: Record<string, unknown> = {}) => ({
  id: 1731100000000,
  userProfilePK: 12345,
  calendarDate: '2026-11-09',
  sleepTimeSeconds: 27000,
  napTimeSeconds: 0,
  sleepWindowConfirmed: true,
  sleepStartTimestampGMT: SLEEP_START,
  sleepEndTimestampGMT: SLEEP_END,
  sleepStartTimestampLocal: SLEEP_START + H,
  sleepEndTimestampLocal: SLEEP_END + H,
  deepSleepSeconds: 5400,
  lightSleepSeconds: 14400,
  remSleepSeconds: 5400,
  awakeSleepSeconds: 1800,
  averageSpO2Value: 94.5,
  lowestSpO2Value: 89,
  highestSpO2Value: 99,
  averageRespirationValue: 13.4,
  sleepScores: { overall: { value: 82, qualifierKey: 'GOOD' } },
  ...over,
});

describe('mapSleep', () => {
  it('maps a night: hours, stage minutes, score, timestamps', () => {
    const r = mapSleep([sleepDto()]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toEqual({
      date: '2026-11-09',
      type: 'sleep',
      value: 7.5,
      unit: 'hr',
      externalId: 'garmin:sleep:2026-11-09',
      recordedAtMs: SLEEP_END,
      meta: { deepMin: 90, lightMin: 240, remMin: 90, awakeMin: 30, score: 82, startMs: SLEEP_START, endMs: SLEEP_END },
    });
    expect(r.extras).toEqual([{ date: '2026-11-09', spo2: 94.5, spo2Low: 89, respiration: 13.4 }]);
  });
  it('accepts the single-day shape with a dailySleepDTO wrapper', () => {
    const r = mapSleep({ dailySleepDTO: sleepDto(), sleepMovement: [], remSleepData: true });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.value).toBe(7.5);
  });
  it('accepts a wrapped list and numeric strings', () => {
    const r = mapSleep({ data: [sleepDto({ sleepTimeSeconds: '25200', deepSleepSeconds: '3600', sleepScores: { overall: { value: '71' } } })] });
    expect(r.items[0]!.value).toBe(7);
    expect(r.items[0]!.meta).toMatchObject({ deepMin: 60, score: 71 });
  });
  it('score can live in alternative places; absence is fine', () => {
    expect(mapSleep([sleepDto({ sleepScores: undefined, sleepScore: 66 })]).items[0]!.meta).toMatchObject({ score: 66 });
    const none = mapSleep([sleepDto({ sleepScores: undefined })]);
    expect(none.items[0]!.meta).not.toHaveProperty('score');
    expect(diag(none.diagnostics, 'sleepScore')).toBeUndefined(); // optional: not reported as missing
  });
  it('sums the stages when the total is missing', () => {
    const r = mapSleep([sleepDto({ sleepTimeSeconds: undefined })]);
    expect(r.items[0]!.value).toBe(7); // deep+light+rem = 25200 s
    expect(diag(r.diagnostics, 'sleepTimeSeconds', 'fallback_used')).toBeDefined();
  });
  it('skips a night without any duration (no zero rows)', () => {
    const r = mapSleep([{ calendarDate: '2026-11-09' }, sleepDto({ calendarDate: '2026-11-08', sleepTimeSeconds: 0, deepSleepSeconds: undefined, lightSleepSeconds: undefined, remSleepSeconds: undefined })]);
    expect(r.items).toEqual([]);
    expect(diag(r.diagnostics, 'sleepTimeSeconds', 'skipped')!.count).toBe(2);
  });
  it('omits stage meta that is absent', () => {
    const r = mapSleep([{ calendarDate: '2026-11-09', sleepTimeSeconds: 21600 }]);
    expect(r.items[0]!.meta).toBeUndefined();
    expect(r.items[0]!.value).toBe(6);
  });
  it('rejects implausible durations', () => {
    expect(mapSleep([{ calendarDate: '2026-11-09', sleepTimeSeconds: 100000 }]).items).toEqual([]);
    expect(mapSleep([{ calendarDate: '2026-11-09', sleepTimeSeconds: 120 }]).items).toEqual([]);
    // an implausible total is not "missing": the stage sum must not silently replace it
    expect(mapSleep([sleepDto({ sleepTimeSeconds: 100000 })]).items).toEqual([]);
  });
  it('multiple nights', () => {
    const r = mapSleep([sleepDto(), sleepDto({ calendarDate: '2026-11-08', sleepTimeSeconds: 21600 })]);
    expect(r.items.map((i) => i.date)).toEqual(['2026-11-09', '2026-11-08']);
  });
  it('is empty for 204/null', () => {
    expect(mapSleep(null).items).toEqual([]);
    expect(mapSleep([]).diagnostics).toEqual([]);
  });
});

describe('mapHrv', () => {
  const hrvDay = (over: Record<string, unknown> = {}) => ({
    calendarDate: '2026-11-09',
    weeklyAvg: 58,
    lastNightAvg: 62,
    lastNight5MinHigh: 101,
    baseline: { lowUpper: 49, balancedLow: 52, balancedUpper: 68, markerValue: 0.4 },
    status: 'BALANCED',
    feedbackPhrase: 'HRV_BALANCED_2',
    createTimeStamp: '2026-11-09T05:00:00.0',
    ...over,
  });
  it('maps the daily summaries', () => {
    const r = mapHrv({ hrvSummaries: [hrvDay(), hrvDay({ calendarDate: '2026-11-08', lastNightAvg: 55 })], userProfilePk: 1 });
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toEqual({
      date: '2026-11-09',
      type: 'hrv',
      value: 62,
      unit: 'ms',
      externalId: 'garmin:hrv:2026-11-09',
      meta: { status: 'BALANCED', weeklyAvg: 58, peak: 101, baselineLow: 52, baselineHigh: 68 },
    });
  });
  it('maps the single-day shape', () => {
    const r = mapHrv({ hrvSummary: hrvDay(), hrvReadings: [{ hrvValue: 60 }], startTimestampGMT: 'x' });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.value).toBe(62);
  });
  it('does not substitute the weekly average when last night is missing', () => {
    const r = mapHrv({ hrvSummaries: [hrvDay({ lastNightAvg: undefined })] });
    expect(r.items).toEqual([]);
    expect(diag(r.diagnostics, 'lastNightAvg', 'missing')).toBeDefined();
  });
  it('accepts strings and rounds', () => {
    const r = mapHrv([hrvDay({ lastNightAvg: '61.6', weeklyAvg: '58.2' })]);
    expect(r.items[0]!.value).toBe(62);
    expect(r.items[0]!.meta).toMatchObject({ weeklyAvg: 58 });
  });
  it('works without baseline/status', () => {
    const r = mapHrv([{ calendarDate: '2026-11-09', lastNightAvg: 40 }]);
    expect(r.items[0]!.meta).toBeUndefined();
  });
  it('drops implausible values', () => {
    expect(mapHrv([hrvDay({ lastNightAvg: 5000 })]).items).toEqual([]);
    expect(mapHrv([hrvDay({ lastNightAvg: 0 })]).items).toEqual([]);
  });
});

describe('mapWeight', () => {
  const w = (over: Record<string, unknown> = {}) => ({
    samplePk: 1731100000123,
    date: T0,
    calendarDate: '2026-11-09',
    weight: 72500,
    bmi: 23.456,
    bodyFat: 18.2,
    bodyWater: 55.1,
    boneMass: 3100,
    muscleMass: 31500,
    physiqueRating: null,
    visceralFat: null,
    metabolicAge: null,
    sourceType: 'INDEX_SCALE',
    timestampGMT: T0,
    weightDelta: 300,
    ...over,
  });
  it('maps weight/all: grams -> kg, body fat, meta', () => {
    const r = mapWeight([w()]);
    expect(r.items).toHaveLength(2);
    expect(one(r.items, 'weight')).toEqual({
      date: '2026-11-09',
      type: 'weight',
      value: 72.5,
      unit: 'kg',
      externalId: `garmin:weight:2026-11-09:${T0}`,
      recordedAtMs: T0,
      meta: { bmi: 23.5, muscleMassKg: 31.5, boneMassKg: 3.1, bodyWaterPct: 55.1, source: 'INDEX_SCALE' },
    });
    expect(one(r.items, 'body_fat')).toMatchObject({ value: 18.2, unit: 'percent', externalId: `garmin:body_fat:2026-11-09:${T0}` });
    expect(diag(r.diagnostics, 'weight', 'converted')).toBeDefined();
  });
  it('treats small values as kilograms', () => {
    const r = mapWeight([w({ weight: 72.5 })]);
    expect(one(r.items, 'weight').value).toBe(72.5);
    expect(diag(r.diagnostics, 'weight', 'converted')).toBeUndefined();
  });
  it('accepts numeric strings', () => {
    expect(one(mapWeight([w({ weight: '81200', bodyFat: '21.5' })]).items, 'weight').value).toBe(81.2);
  });
  it('honours include flags', () => {
    expect(byType(mapWeight([w()], { include: { weight: true, bodyFat: false } }).items, 'body_fat')).toEqual([]);
    expect(byType(mapWeight([w()], { include: { weight: false, bodyFat: true } }).items, 'weight')).toEqual([]);
  });
  it('weigh-ins without body fat produce only weight (and no noisy missing diagnostic)', () => {
    const r = mapWeight([w({ bodyFat: null })]);
    expect(byType(r.items, 'body_fat')).toEqual([]);
    expect(diag(r.diagnostics, 'bodyFat', 'missing')).toBeUndefined();
  });
  it('converts a body-fat fraction to percent', () => {
    const r = mapWeight([w({ bodyFat: 0.182 })]);
    expect(one(r.items, 'body_fat').value).toBe(18.2);
    expect(diag(r.diagnostics, 'bodyFat', 'converted')).toBeDefined();
  });
  it('keeps several weigh-ins per day with distinct ids', () => {
    const r = mapWeight([w(), w({ timestampGMT: T0 + 9 * H, weight: 72300 })]);
    expect(byType(r.items, 'weight').map((b) => b.value)).toEqual([72.5, 72.3]);
    expect(new Set(r.items.map((b) => b.externalId)).size).toBe(4);
  });
  it('numbers duplicates without a timestamp deterministically', () => {
    const r = mapWeight([w({ timestampGMT: undefined, bodyFat: null }), w({ timestampGMT: undefined, bodyFat: null, weight: 72000 })]);
    expect(byType(r.items, 'weight').map((b) => b.externalId)).toEqual(['garmin:weight:2026-11-09', 'garmin:weight:2026-11-09:1']);
  });
  it('maps the weight/range shape (dailyWeightSummaries / allWeightMetrics / latestWeight)', () => {
    const r = mapWeight({
      dailyWeightSummaries: [
        { summaryDate: '2026-11-09', numOfWeightEntries: 2, minWeight: 72000, maxWeight: 72500, latestWeight: w(), allWeightMetrics: [w(), w({ timestampGMT: T0 + 9 * H })] },
        { summaryDate: '2026-11-08', latestWeight: w({ calendarDate: undefined, timestampGMT: T0 - 24 * H, weight: 73000 }) },
      ],
      totalAverage: { weight: 72400 },
      previousDateWeight: null,
      nextDateWeight: null,
    });
    expect(byType(r.items, 'weight').map((b) => [b.date, b.value])).toEqual([
      ['2026-11-09', 72.5],
      ['2026-11-09', 72.5],
      ['2026-11-08', 73],
    ]);
  });
  it('maps a dateWeightList container', () => {
    expect(byType(mapWeight({ dateWeightList: [w()], dailyWeightSummaries: [] }).items, 'weight')).toHaveLength(1);
  });
  it('derives the date from epoch ms when calendarDate is missing', () => {
    const r = mapWeight([w({ calendarDate: undefined })]);
    expect(one(r.items, 'weight').date).toBe('2026-11-09');
    expect(diag(r.diagnostics, 'date', 'fallback_used')).toBeDefined();
  });
  it('drops implausible weights and entries without a date', () => {
    const r = mapWeight([w({ weight: 5 }), w({ weight: 900 }), w({ calendarDate: undefined, date: 'x', timestampGMT: undefined })]);
    expect(byType(r.items, 'weight')).toEqual([]);
    expect(diag(r.diagnostics, 'weight', 'implausible')!.count).toBe(2);
    expect(diag(r.diagnostics, 'date', 'skipped')).toBeDefined();
  });
  it('is empty and quiet for null / empty', () => {
    for (const raw of [null, [], {}, { dailyWeightSummaries: [] }]) expect(mapWeight(raw)).toMatchObject({ items: [], diagnostics: [] });
  });
  it('reports an unrecognisable container', () => {
    const r = mapWeight({ somethingElse: 1 });
    expect(diag(r.diagnostics, '$', 'unexpected_shape')).toBeDefined();
  });
});

describe('mapBodyBattery', () => {
  const descriptors = (idx: { ts: number; status: number; level: number; ver: number }) => [
    { bodyBatteryValueDescriptorIndex: idx.ts, bodyBatteryValueDescriptorKey: 'timestamp' },
    { bodyBatteryValueDescriptorIndex: idx.status, bodyBatteryValueDescriptorKey: 'bodyBatteryStatus' },
    { bodyBatteryValueDescriptorIndex: idx.level, bodyBatteryValueDescriptorKey: 'bodyBatteryLevel' },
    { bodyBatteryValueDescriptorIndex: idx.ver, bodyBatteryValueDescriptorKey: 'bodyBatteryVersion' },
  ];
  const report = (over: Record<string, unknown> = {}) => ({
    date: '2026-11-09',
    charged: 62,
    drained: 74,
    startTimestampGMT: '2026-11-08T23:00:00.0',
    endTimestampGMT: '2026-11-09T23:00:00.0',
    startTimestampLocal: '2026-11-09T00:00:00.0',
    endTimestampLocal: '2026-11-10T00:00:00.0',
    bodyBatteryValuesArray: [
      [SLEEP_START, 'MEASURED', 40, 2.0],
      [1_762_650_000_000, 'MEASURED', 88, 2.0],
      [1_762_660_000_000, 'MEASURED', 52, 2.0],
      [1_762_670_000_000, 'MEASURED', 14, 2.0],
    ],
    bodyBatteryValueDescriptorDTOList: descriptors({ ts: 0, status: 1, level: 2, ver: 3 }),
    ...over,
  });
  it('uses the descriptor index to find the level', () => {
    const r = mapBodyBattery([report()]);
    expect(r.items[0]).toEqual({
      date: '2026-11-09',
      type: 'body_battery',
      value: 88,
      unit: 'percent',
      externalId: 'garmin:body_battery:2026-11-09',
      meta: { high: 88, low: 14, charged: 62, drained: 74, latest: 14 },
    });
    expect(diag(r.diagnostics, 'bodyBatteryValueDescriptors')).toBeUndefined();
  });
  it('follows a different descriptor order', () => {
    const r = mapBodyBattery([
      report({
        bodyBatteryValuesArray: [[10, 1_762_650_000_000, 'MEASURED'], [77, 1_762_660_000_000, 'MEASURED']],
        bodyBatteryValueDescriptorDTOList: [
          { bodyBatteryValueDescriptorIndex: 0, bodyBatteryValueDescriptorKey: 'bodyBatteryLevel' },
          { bodyBatteryValueDescriptorIndex: 1, bodyBatteryValueDescriptorKey: 'timestamp' },
          { bodyBatteryValueDescriptorIndex: 2, bodyBatteryValueDescriptorKey: 'bodyBatteryStatus' },
        ],
      }),
    ]);
    expect(r.items[0]!.value).toBe(77);
    expect(r.items[0]!.meta).toMatchObject({ high: 77, low: 10 });
  });
  it('falls back to index 1 for [timestamp, level] pairs when there are no descriptors', () => {
    const r = mapBodyBattery([report({ bodyBatteryValuesArray: [[1, 30], [2, 90], [3, 60]], bodyBatteryValueDescriptorDTOList: undefined })]);
    expect(r.items[0]!.value).toBe(90);
    expect(diag(r.diagnostics, 'bodyBatteryValueDescriptors', 'fallback_used')).toBeDefined();
  });
  it('falls back to index 2 for longer entries and ignores unusable descriptors', () => {
    const r = mapBodyBattery([report({ bodyBatteryValueDescriptorDTOList: [{ nope: true }, 'x', null] })]);
    expect(r.items[0]!.value).toBe(88);
    expect(diag(r.diagnostics, 'bodyBatteryValueDescriptors', 'fallback_used')).toBeDefined();
  });
  it('skips null / out-of-range levels and non-array entries', () => {
    const r = mapBodyBattery([report({ bodyBatteryValuesArray: [[1, 'M', null, 2], [2, 'M', 250, 2], 'junk', [3, 'M', '45', 2], null, []] })]);
    expect(r.items[0]!.value).toBe(45);
  });
  it('reports a report with no levels', () => {
    const r = mapBodyBattery([report({ bodyBatteryValuesArray: [] })]);
    expect(r.items).toEqual([]);
    expect(diag(r.diagnostics, 'bodyBatteryLevel', 'missing')).toBeDefined();
  });
  it('reports a missing or wrong-typed values array', () => {
    expect(diag(mapBodyBattery([report({ bodyBatteryValuesArray: undefined })]).diagnostics, 'bodyBatteryValuesArray', 'missing')).toBeDefined();
    expect(diag(mapBodyBattery([report({ bodyBatteryValuesArray: 'x' })]).diagnostics, 'bodyBatteryValuesArray', 'wrong_type')).toBeDefined();
  });
  it('derives the date from startTimestampLocal when needed', () => {
    const r = mapBodyBattery([report({ date: undefined })]);
    expect(r.items[0]!.date).toBe('2026-11-09');
    expect(diag(r.diagnostics, 'date', 'fallback_used')).toBeDefined();
  });
  it('charged/drained are optional', () => {
    const r = mapBodyBattery([report({ charged: undefined, drained: undefined })]);
    expect(r.items[0]!.meta).toEqual({ high: 88, low: 14, latest: 14 });
  });
  it('maps several days and is quiet for empty input', () => {
    expect(mapBodyBattery([report(), report({ date: '2026-11-08' })]).items).toHaveLength(2);
    expect(mapBodyBattery(null).diagnostics).toEqual([]);
  });
});

describe('single-day and stats mappers', () => {
  it('mapHeartRateDay', () => {
    const r = mapHeartRateDay({ userProfilePK: 1, calendarDate: '2026-11-09', maxHeartRate: 161, minHeartRate: 46, restingHeartRate: 52, lastSevenDaysAvgRestingHeartRate: 53, heartRateValues: [[1, 60]] });
    expect(r.items[0]).toMatchObject({ date: '2026-11-09', type: 'resting_heart_rate', value: 52, unit: 'bpm', meta: { min: 46, max: 161, sevenDayAvg: 53 } });
  });
  it('mapHeartRateDay uses the requested date when the response has none, and ignores empty days', () => {
    expect(mapHeartRateDay({ restingHeartRate: 50 }, '2026-11-01').items[0]!.date).toBe('2026-11-01');
    expect(mapHeartRateDay({ restingHeartRate: 50 }).items).toEqual([]);
    expect(mapHeartRateDay(null, '2026-11-01').items).toEqual([]);
    expect(mapHeartRateDay({ calendarDate: '2026-11-01', heartRateValues: null }).items).toEqual([]);
  });
  it('mapSpo2Day', () => {
    const r = mapSpo2Day({ calendarDate: '2026-11-09', averageSpO2: 95.2, lowestSpO2: 89, latestSpO2: 96, avgSleepSpO2: 94 });
    expect(r.items[0]).toMatchObject({ type: 'spo2', value: 95.2, unit: 'percent', meta: { low: 89, latest: 96, sleepAvg: 94 } });
    expect(mapSpo2Day({ averageSpO2: 97 }, '2026-11-02').items[0]!.date).toBe('2026-11-02');
    expect(mapSpo2Day({ calendarDate: '2026-11-09' }).items).toEqual([]);
  });
  it('mapStepsDaily', () => {
    const r = mapStepsDaily([{ calendarDate: '2026-11-09', totalSteps: 9876, totalDistance: 7421, stepGoal: 10000 }, { calendarDate: '2026-11-08', totalSteps: '4000' }, { calendarDate: '2026-11-07' }]);
    expect(r.items).toEqual([{ date: '2026-11-09', steps: 9876 }, { date: '2026-11-08', steps: 4000 }]);
    expect(diag(r.diagnostics, 'steps', 'missing')!.count).toBe(1);
  });
  it('mapStressDaily reads nested and flat values', () => {
    const r = mapStressDaily([
      { calendarDate: '2026-11-09', values: { overallStressLevel: 31, restStressDuration: 100 } },
      { calendarDate: '2026-11-08', overallStressLevel: '28' },
      { calendarDate: '2026-11-07', values: { overallStressLevel: -1 } },
      { calendarDate: '2026-11-06', values: {} },
    ]);
    expect(r.items.map((i) => [i.date, i.value])).toEqual([['2026-11-09', 31], ['2026-11-08', 28]]);
    expect(r.items[0]!.unit).toBe('score');
  });
});

describe('mapActivities', () => {
  const act = (over: Record<string, unknown> = {}) => ({
    activityId: 12345678901,
    activityName: 'Morning Run',
    startTimeLocal: '2026-11-09 07:30:00',
    startTimeGMT: '2026-11-09 06:30:00',
    activityType: { typeId: 1, typeKey: 'running', parentTypeId: 17 },
    distance: 8123.4,
    duration: 2701.234,
    elapsedDuration: 2760.5,
    movingDuration: 2690,
    calories: 612,
    averageHR: 150,
    ...over,
  });
  it('maps a run', () => {
    const r = mapActivities([act()]);
    expect(r.items).toEqual([
      {
        externalId: 'garmin:activity:12345678901',
        name: 'Morning Run',
        typeKey: 'running',
        startMs: Date.UTC(2026, 10, 9, 6, 30, 0),
        endMs: Date.UTC(2026, 10, 9, 6, 30, 0) + 2_760_500,
        durationSec: 2701,
        kcal: 612,
        distanceM: 8123.4,
      },
    ]);
  });
  it('accepts wrapped lists, string numbers and string ids', () => {
    const r = mapActivities({ activityList: [act({ activityId: '999', duration: '1800', calories: '300.4', distance: '5000' })] });
    expect(r.items[0]).toMatchObject({ externalId: 'garmin:activity:999', durationSec: 1800, kcal: 300, distanceM: 5000 });
  });
  it('omits kcal/distance when zero or absent (strength training)', () => {
    const r = mapActivities([act({ activityType: { typeKey: 'strength_training' }, distance: 0, calories: undefined })]);
    expect(r.items[0]).not.toHaveProperty('kcal');
    expect(r.items[0]).not.toHaveProperty('distanceM');
    expect(r.items[0]!.typeKey).toBe('strength_training');
  });
  it('handles alternative type locations and humanizes a missing name', () => {
    const r = mapActivities([act({ activityName: undefined, activityType: undefined, activityTypeDTO: { typeKey: 'indoor_cardio' } }), act({ activityId: 2, activityType: 'cycling', activityName: '' })]);
    expect(r.items[0]).toMatchObject({ typeKey: 'indoor_cardio', name: 'Indoor cardio' });
    expect(r.items[1]).toMatchObject({ typeKey: 'cycling', name: 'Cycling' });
  });
  it('uses elapsed or moving duration when duration is missing', () => {
    expect(mapActivities([act({ duration: undefined })]).items[0]!.durationSec).toBe(2761);
    expect(mapActivities([act({ duration: undefined, elapsedDuration: undefined })]).items[0]!.durationSec).toBe(2690);
  });
  it('falls back to startTimeLocal with an offset, or as UTC, and says so', () => {
    const noGmt = act({ startTimeGMT: undefined });
    const a = mapActivities([noGmt], { localOffsetMs: 3_600_000 });
    expect(a.items[0]!.startMs).toBe(Date.UTC(2026, 10, 9, 6, 30, 0));
    const b = mapActivities([noGmt]);
    expect(b.items[0]!.startMs).toBe(Date.UTC(2026, 10, 9, 7, 30, 0));
    expect(diag(b.diagnostics, 'startMs', 'fallback_used')).toBeDefined();
  });
  it('skips activities without id, start or duration', () => {
    const r = mapActivities([act({ activityId: undefined }), act({ startTimeGMT: undefined, startTimeLocal: undefined }), act({ duration: 0, elapsedDuration: undefined, movingDuration: undefined })]);
    expect(r.items).toEqual([]);
    expect(diag(r.diagnostics, 'activityId', 'skipped')).toBeDefined();
    expect(diag(r.diagnostics, 'startMs', 'skipped')).toBeDefined();
    expect(diag(r.diagnostics, 'durationSec', 'skipped')).toBeDefined();
  });
  it('is quiet for no activities', () => {
    expect(mapActivities(null).items).toEqual([]);
    expect(mapActivities([]).diagnostics).toEqual([]);
  });
});

describe('mapUserSettings', () => {
  it('reads top-level and nested fields', () => {
    expect(mapUserSettings({ displayName: 'Sam', timeZone: 'Europe/Sarajevo', measurementSystem: 'metric' })).toEqual({ displayName: 'Sam', timeZone: 'Europe/Sarajevo', measurementSystem: 'metric' });
    expect(mapUserSettings({ userData: { timeZone: 'UTC', measurementSystem: 'statute_us' }, fullName: 'A B' })).toEqual({ displayName: 'A B', timeZone: 'UTC', measurementSystem: 'statute_us' });
    expect(mapUserSettings(null)).toEqual({});
    expect(mapUserSettings('x')).toEqual({});
  });
});

describe('hostile inputs never throw', () => {
  const circular: Record<string, unknown> = { calendarDate: '2026-11-09' };
  circular.self = circular;
  circular.data = [circular];
  const deep = { a: { b: { c: { d: { e: { data: [{ calendarDate: '2026-11-09' }] } } } } } };
  const inputs: unknown[] = [
    undefined, null, 0, 1, -1, NaN, Infinity, '', 'text', '{"json":"string"}', true, false, [], [null], [undefined], [[]], [[[]]], [1, 'a', true],
    {}, { data: 'x' }, { data: 5 }, { data: [null, 1, 'x'] }, { data: {} }, { data: { data: { data: [] } } },
    { calendarDate: 5, totalSteps: {} }, { calendarDate: ['2026-11-09'] }, { calendarDate: '2026-11-09', activeKilocalories: [1, 2] },
    circular, deep, [circular], Object.create(null), new Date(), () => 1, Symbol('x'), 10n,
    { hrvSummaries: 'x' }, { dailyWeightSummaries: [null, 1, { allWeightMetrics: 'x' }] }, { bodyBatteryValuesArray: { a: 1 } },
    [{ bodyBatteryValuesArray: [[]], date: '2026-11-09' }], [{ activityId: {}, startTimeGMT: [] }], { activityList: { a: 1 } },
  ];
  const mappers: Array<[string, (raw: unknown) => unknown]> = [
    ['mapDailySummaries', (r) => mapDailySummaries(r)],
    ['mapSleep', (r) => mapSleep(r)],
    ['mapHrv', (r) => mapHrv(r)],
    ['mapWeight', (r) => mapWeight(r)],
    ['mapBodyBattery', (r) => mapBodyBattery(r)],
    ['mapHeartRateDay', (r) => mapHeartRateDay(r, '2026-11-09')],
    ['mapSpo2Day', (r) => mapSpo2Day(r, '2026-11-09')],
    ['mapStepsDaily', (r) => mapStepsDaily(r)],
    ['mapStressDaily', (r) => mapStressDaily(r)],
    ['mapActivities', (r) => mapActivities(r)],
    ['mapUserSettings', (r) => mapUserSettings(r)],
    ['parseGarminTimestamp', (r) => parseGarminTimestamp(r)],
    ['pickNumber', (r) => pickNumber(r, ['a'])],
  ];
  for (const [name, fn] of mappers) {
    it(`${name} survives every hostile input`, () => {
      for (const input of inputs) expect(() => fn(input)).not.toThrow();
    });
  }
  it('results always have the documented shape', () => {
    for (const input of inputs) {
      const r = mapDailySummaries(input);
      expect(Array.isArray(r.energy)).toBe(true);
      expect(Array.isArray(r.biometrics)).toBe(true);
      expect(Array.isArray(r.diagnostics)).toBe(true);
      expect(Array.isArray(r.coverage)).toBe(true);
      for (const d of r.diagnostics) expect(d.count).toBeGreaterThan(0);
    }
  });
  it('flags a wholly unexpected container as unexpected_shape', () => {
    expect(diag(mapDailySummaries('hello').diagnostics, '$', 'unexpected_shape')).toBeDefined();
    expect(diag(mapSleep({ weird: 1 }).diagnostics, '$', 'unexpected_shape')!.detail).toContain('weird');
    expect(diag(mapSleep([1, 'x']).diagnostics, '$item', 'unexpected_shape')!.count).toBe(2);
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
    expect(t.coverage()[0]).toEqual({ endpoint: 'x', field: 'f', total: 5, found: 2, matchedBy: { a: 1, b: 1 } });
    const reasons = t.diagnostics().map((d) => d.reason).sort();
    expect(reasons).toEqual(['implausible', 'missing', 'wrong_type']);
  });
  it('mergeDiagnostics sums counts per endpoint/field/reason', () => {
    const a: GarminDiagnostic = { endpoint: 'e', field: 'f', reason: 'missing', count: 2, of: 3, detail: 'first' };
    const b: GarminDiagnostic = { endpoint: 'e', field: 'f', reason: 'missing', count: 1, of: 4, detail: 'second', sampleDate: '2026-01-01' };
    const c: GarminDiagnostic = { endpoint: 'e', field: 'g', reason: 'missing', count: 1 };
    const merged = mergeDiagnostics([a], [b, c]);
    expect(merged).toHaveLength(2);
    expect(merged.find((d) => d.field === 'f')).toMatchObject({ count: 3, of: 7, detail: 'first', sampleDate: '2026-01-01' });
  });
  it('mergeCoverage sums totals and matched keys', () => {
    const m = mergeCoverage(
      [{ endpoint: 'e', field: 'f', total: 2, found: 1, matchedBy: { a: 1 } }],
      [{ endpoint: 'e', field: 'f', total: 3, found: 3, matchedBy: { a: 1, b: 2 } }],
    );
    expect(m).toEqual([{ endpoint: 'e', field: 'f', total: 5, found: 4, matchedBy: { a: 2, b: 2 } }]);
  });
});
