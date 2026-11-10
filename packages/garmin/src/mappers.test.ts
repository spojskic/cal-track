import { describe, expect, it } from 'vitest';
import {
  FIELD_CANDIDATES,
  hrvFromSleep,
  humanizeTypeKey,
  mapActivities,
  mapHrvDay,
  mapProfile,
  mapSleepDay,
  mapUserSummary,
  mapWeightRange,
} from './mappers';
import type { GarminBiometric, GarminDiagnostic, GarminFieldCoverage } from './normalized';

// The fixtures below are built from the field names the reference project reads (garmin-companion:
// crates/garmin-core/src/{client,sync,sleep}.rs). Values are made up.

const byType = (list: readonly GarminBiometric[], type: string): GarminBiometric[] => list.filter((b) => b.type === type);
const one = (list: readonly GarminBiometric[], type: string): GarminBiometric => {
  const r = byType(list, type);
  expect(r, type).toHaveLength(1);
  return r[0] as GarminBiometric;
};
const diag = (list: readonly GarminDiagnostic[], field: string, reason?: string) =>
  list.find((d) => d.field === field && (reason === undefined || d.reason === reason));
const cov = (list: readonly GarminFieldCoverage[], field: string): GarminFieldCoverage => {
  const c = list.find((x) => x.field === field);
  expect(c, field).toBeDefined();
  return c as GarminFieldCoverage;
};

const DATE = '2026-11-09';

describe('mapProfile', () => {
  it('reads displayName (client.rs Profile)', () => {
    const r = mapProfile({ displayName: 'a1b2c3d4-0000-4000-8000-123456789abc', fullName: 'X', profileId: 5 });
    expect(r.displayName).toBe('a1b2c3d4-0000-4000-8000-123456789abc');
    expect(cov(r.coverage, 'displayName')).toMatchObject({ found: 1, total: 1, matchedBy: { displayName: 1 } });
  });
  it('has no displayName for other shapes and reports it', () => {
    const r = mapProfile({ fullName: 'X' });
    expect(r.displayName).toBeUndefined();
    expect(diag(r.diagnostics, 'displayName', 'missing')).toBeDefined();
  });
});

describe('mapUserSummary (usersummary/daily)', () => {
  const summary = {
    restingHeartRate: 52,
    totalSteps: 9876,
    averageStressLevel: 31,
    bodyBatteryHighestValue: 88,
    bodyBatteryLowestValue: 14,
    consumedKilocalories: null,
    totalKilocalories: 2650,
    activeKilocalories: 612,
    bmrKilocalories: 2038,
    netCalorieGoal: 1900,
  };

  it('reads energy, steps, resting heart rate, stress and body battery by the reference field names', () => {
    const r = mapUserSummary(summary, DATE);
    expect(r.energy).toEqual({ date: DATE, activeKcal: 612, restingKcal: 2038, totalKcal: 2650, steps: 9876 });
    expect(one(r.biometrics, 'resting_heart_rate')).toMatchObject({ date: DATE, value: 52, unit: 'bpm', externalId: `garmin:resting_heart_rate:${DATE}` });
    expect(one(r.biometrics, 'stress')).toMatchObject({ value: 31, unit: 'score', externalId: `garmin:stress:${DATE}` });
    expect(one(r.biometrics, 'body_battery')).toMatchObject({ value: 88, unit: 'percent', meta: { high: 88, low: 14 } });
  });

  it('reports which JSON key satisfied each field', () => {
    const r = mapUserSummary(summary, DATE);
    expect(cov(r.coverage, 'activeKcal')).toMatchObject({ found: 1, matchedBy: { activeKilocalories: 1 } });
    expect(cov(r.coverage, 'restingKcal').matchedBy).toEqual({ bmrKilocalories: 1 });
    expect(cov(r.coverage, 'steps').matchedBy).toEqual({ totalSteps: 1 });
    expect(cov(r.coverage, 'stress').matchedBy).toEqual({ averageStressLevel: 1 });
  });

  it('the day\'s totals are the latest values: a later pull replaces, it is never added', () => {
    const earlier = mapUserSummary({ ...summary, activeKilocalories: 300, bmrKilocalories: 801, totalKilocalories: 1101 }, DATE);
    const later = mapUserSummary(summary, DATE);
    expect(earlier.energy?.restingKcal).toBe(801);
    expect(later.energy?.restingKcal).toBe(2038); // not 801 + 2038
    expect(later.energy?.date).toBe(earlier.energy?.date);
  });

  it('derives the missing part of active + resting = total, and says so', () => {
    const noResting = mapUserSummary({ totalKilocalories: 2650, activeKilocalories: 612 }, DATE);
    expect(noResting.energy).toMatchObject({ activeKcal: 612, restingKcal: 2038, totalKcal: 2650 });
    expect(diag(noResting.diagnostics, 'restingKcal', 'fallback_used')).toBeDefined();
    const noTotal = mapUserSummary({ activeKilocalories: 100, bmrKilocalories: 1900 }, DATE);
    expect(noTotal.energy?.totalKcal).toBe(2000);
    const noActive = mapUserSummary({ totalKilocalories: 2000, bmrKilocalories: 1900 }, DATE);
    expect(noActive.energy?.activeKcal).toBe(100);
  });

  it('keeps unknown unknown: zero, negative and null values are absent, never a fake 0', () => {
    const r = mapUserSummary(
      { totalSteps: 0, activeKilocalories: 0, bmrKilocalories: null, restingHeartRate: null, averageStressLevel: -1, bodyBatteryHighestValue: 0 },
      DATE,
    );
    expect(r.energy).toBeUndefined();
    expect(r.biometrics).toEqual([]);
  });

  it('a day before the watch was worn (200 with every field null) maps to nothing', () => {
    const r = mapUserSummary({ totalKilocalories: null, activeKilocalories: null, bmrKilocalories: null, totalSteps: null, restingHeartRate: null }, DATE);
    expect(r.energy).toBeUndefined();
    expect(r.biometrics).toEqual([]);
    expect(cov(r.coverage, 'activeKcal')).toMatchObject({ found: 0, total: 1 });
  });

  it('drops implausible values', () => {
    const r = mapUserSummary({ activeKilocalories: 90_000, bmrKilocalories: 1800, restingHeartRate: 400, totalSteps: 999_999 }, DATE);
    expect(r.energy).toMatchObject({ restingKcal: 1800 });
    expect(r.energy?.activeKcal).toBeUndefined();
    expect(r.energy?.steps).toBeUndefined();
    expect(byType(r.biometrics, 'resting_heart_rate')).toEqual([]);
    expect(diag(r.diagnostics, 'restingHeartRate', 'implausible')).toBeDefined();
  });

  it('accepts numeric strings and the nested Personal API names as fallbacks (GUESSES)', () => {
    const r = mapUserSummary(
      { calories: { burnedActive: '412', burnedResting: 1850 }, movement: { steps: { value: 1949 } }, heartRate: { restingValue: 53 }, stress: { avgLevel: 25 } },
      DATE,
    );
    expect(r.energy).toMatchObject({ activeKcal: 412, restingKcal: 1850, steps: 1949 });
    expect(one(r.biometrics, 'resting_heart_rate').value).toBe(53);
    expect(one(r.biometrics, 'stress').value).toBe(25);
    expect(cov(r.coverage, 'activeKcal').matchedBy).toEqual({ 'calories.burnedActive': 1 });
  });

  it('survives hostile input', () => {
    for (const input of [null, undefined, 5, 'x', [], [1], {}, { activeKilocalories: {} }, { totalSteps: [1] }, true]) {
      expect(() => mapUserSummary(input, DATE)).not.toThrow();
    }
    expect(diag(mapUserSummary('hello', DATE).diagnostics, '$', 'unexpected_shape')).toBeDefined();
  });
});

describe('mapSleepDay (dailySleepData)', () => {
  const night = {
    avgOvernightHrv: 89.0,
    restingHeartRate: 48,
    restlessMomentsCount: 62,
    bodyBatteryChange: 83,
    dailySleepDTO: {
      sleepTimeSeconds: 31200,
      deepSleepSeconds: 3960,
      lightSleepSeconds: 19800,
      remSleepSeconds: 7440,
      awakeSleepSeconds: 180,
      napTimeSeconds: 0,
      averageRespirationValue: 13.0,
      lowestRespirationValue: 11.0,
      averageSpO2Value: 97.0,
      lowestSpO2Value: 90,
      sleepStartTimestampGMT: 1786316322000,
      sleepStartTimestampLocal: 1786323522000,
      sleepEndTimestampGMT: 1786347702000,
      sleepEndTimestampLocal: 1786354902000,
      sleepScores: { overall: { value: 93, qualifierKey: 'EXCELLENT' } },
    },
  };

  it('maps the night: hours asleep, stages in minutes, score, SpO2 and respiration', () => {
    const r = mapSleepDay(night, DATE);
    const sleep = one(r.biometrics, 'sleep');
    expect(sleep).toMatchObject({ date: DATE, value: 8.67, unit: 'hr', externalId: `garmin:sleep:${DATE}`, recordedAtMs: 1786347702000 });
    expect(sleep.meta).toMatchObject({ source: 'garmin', deep: 66, core: 330, rem: 124, awake: 3, staged: true, score: 93, quality: 'EXCELLENT', startMs: 1786316322000, endMs: 1786347702000 });
    expect(one(r.biometrics, 'sleep_score')).toMatchObject({ value: 93, unit: 'score', externalId: `garmin:sleep_score:${DATE}` });
    expect(one(r.biometrics, 'spo2')).toMatchObject({ value: 97, unit: 'percent', meta: { source: 'sleep', low: 90 } });
    expect(one(r.biometrics, 'respiration_rate')).toMatchObject({ value: 13, unit: 'brpm', meta: { source: 'sleep' } });
    expect(r.avgOvernightHrv).toBe(89);
  });

  it('reports the keys that matched', () => {
    const r = mapSleepDay(night, DATE);
    expect(cov(r.coverage, 'sleepTimeSeconds').matchedBy).toEqual({ 'dailySleepDTO.sleepTimeSeconds': 1 });
    expect(cov(r.coverage, 'sleepScore').matchedBy).toEqual({ 'dailySleepDTO.sleepScores.overall.value': 1 });
    expect(cov(r.coverage, 'avgOvernightHrv').matchedBy).toEqual({ avgOvernightHrv: 1 });
  });

  it('files the night under the requested (waking) day', () => {
    expect(mapSleepDay(night, '2026-08-10').biometrics.every((b) => b.date === '2026-08-10')).toBe(true);
  });

  it('adds the stages up when the total is missing', () => {
    const r = mapSleepDay({ dailySleepDTO: { deepSleepSeconds: 3600, lightSleepSeconds: 14400, remSleepSeconds: 3600 } }, DATE);
    expect(one(r.biometrics, 'sleep').value).toBe(6.0);
    expect(diag(r.diagnostics, 'sleepTimeSeconds', 'fallback_used')).toBeDefined();
  });

  it('a night with nothing in it (watch on the bedside table) maps to nothing', () => {
    expect(mapSleepDay({ dailySleepDTO: { sleepTimeSeconds: null, sleepScores: null } }, DATE).biometrics).toEqual([]);
    expect(mapSleepDay({}, DATE).biometrics).toEqual([]);
    expect(mapSleepDay({ dailySleepDTO: { sleepTimeSeconds: 0 } }, DATE).biometrics).toEqual([]);
  });

  it('drops an absurd night and out-of-range scores', () => {
    const r = mapSleepDay({ dailySleepDTO: { sleepTimeSeconds: 90_000, sleepScores: { overall: { value: 250 } } } }, DATE);
    expect(byType(r.biometrics, 'sleep')).toEqual([]);
    expect(byType(r.biometrics, 'sleep_score')).toEqual([]);
  });

  it('tolerates the un-nested names (GUESS) and survives hostile input', () => {
    const r = mapSleepDay({ sleepTimeSeconds: 25_200, sleepScores: { overall: { value: 80 } } }, DATE);
    expect(one(r.biometrics, 'sleep').value).toBe(7);
    expect(one(r.biometrics, 'sleep_score').value).toBe(80);
    for (const input of [null, undefined, 5, 'x', [], [1], { dailySleepDTO: 'x' }, { dailySleepDTO: [] }]) {
      expect(() => mapSleepDay(input, DATE)).not.toThrow();
    }
  });
});

describe('mapHrvDay (hrv-service/hrv/{date})', () => {
  const hrv = {
    hrvSummary: {
      lastNightAvg: 62,
      weeklyAvg: 58,
      status: 'BALANCED',
      baseline: { lowUpper: 45, balancedLow: 50, balancedUpper: 70 },
    },
    hrvReadings: [{ hrvValue: 60, readingTimeLocal: '2026-11-09T01:05:00.0' }],
  };

  it('maps the overnight average with its context', () => {
    const r = mapHrvDay(hrv, DATE);
    expect(one(r.biometrics, 'hrv')).toMatchObject({
      date: DATE,
      value: 62,
      unit: 'ms',
      externalId: `garmin:hrv:${DATE}`,
      meta: { method: 'rmssd', status: 'BALANCED', weeklyAvg: 58, baselineLow: 50, baselineHigh: 70 },
    });
    expect(cov(r.coverage, 'lastNightAvg').matchedBy).toEqual({ 'hrvSummary.lastNightAvg': 1 });
  });

  it('a reply without an overnight average maps to nothing', () => {
    expect(mapHrvDay({ hrvSummary: { lastNightAvg: null, status: 'NONE' } }, DATE).biometrics).toEqual([]);
    expect(mapHrvDay({ hrvReadings: [] }, DATE).biometrics).toEqual([]);
  });

  it('hrvFromSleep builds the fallback row from the sleep reply', () => {
    expect(hrvFromSleep(DATE, 89)).toMatchObject({ type: 'hrv', value: 89, externalId: `garmin:hrv:${DATE}`, meta: { method: 'rmssd', from: 'sleep' } });
  });

  it('survives hostile input', () => {
    for (const input of [null, undefined, 5, 'x', [], [1], { hrvSummary: 'x' }]) expect(() => mapHrvDay(input, DATE)).not.toThrow();
  });
});

describe('mapWeightRange (weight/dateRange)', () => {
  const weights = {
    dateWeightList: [
      { samplePk: 1700000001, calendarDate: '2026-11-09', weight: 81500.0, bmi: 24.6, bodyFat: 19.5, bodyWater: 55.1, boneMass: 3100, muscleMass: 36400, sourceType: 'INDEX_SCALE', timestampGMT: 1_762_669_800_000 },
      { samplePk: 1700000002, calendarDate: '2026-11-07', weight: 82000.0, bodyFat: null, sourceType: 'MANUAL' },
    ],
  };

  it('reads grams as kg, with the weigh-in id from samplePk', () => {
    const r = mapWeightRange(weights);
    const w = byType(r.items, 'weight');
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({
      date: '2026-11-09',
      value: 81.5,
      unit: 'kg',
      externalId: 'garmin:weight:1700000001',
      recordedAtMs: 1_762_669_800_000,
      meta: { bmi: 24.6, muscleMassKg: 36.4, boneMassKg: 3.1, bodyWaterPct: 55.1, source: 'INDEX_SCALE' },
    });
    expect(w[1]).toMatchObject({ date: '2026-11-07', value: 82, externalId: 'garmin:weight:1700000002' });
    expect(cov(r.coverage, 'weight').matchedBy).toEqual({ weight: 2 });
    expect(diag(r.diagnostics, 'weight', 'converted')).toBeDefined();
  });

  it('maps body fat only where a scale wrote it (percent)', () => {
    const r = mapWeightRange(weights);
    const fat = byType(r.items, 'body_fat');
    expect(fat).toHaveLength(1);
    expect(fat[0]).toMatchObject({ date: '2026-11-09', value: 19.5, unit: 'percent', externalId: 'garmin:body_fat:1700000001' });
  });

  it('a corrected weigh-in keeps its id, so the stored row is updated instead of duplicated', () => {
    const a = mapWeightRange({ dateWeightList: [{ samplePk: 7, calendarDate: '2026-11-09', weight: 80000 }] });
    const b = mapWeightRange({ dateWeightList: [{ samplePk: 7, calendarDate: '2026-11-09', weight: 79500 }] });
    expect(a.items[0]?.externalId).toBe(b.items[0]?.externalId);
  });

  it('keeps several weigh-ins of the same day apart, even without a samplePk', () => {
    const r = mapWeightRange({ dateWeightList: [{ calendarDate: '2026-11-09', weight: 80000 }, { calendarDate: '2026-11-09', weight: 80400 }] });
    const ids = r.items.map((b) => b.externalId);
    expect(new Set(ids).size).toBe(2);
  });

  it('accepts kg, a bare array and the date as epoch ms', () => {
    expect(mapWeightRange([{ calendarDate: '2026-11-09', weight: 81.5 }]).items[0]?.value).toBe(81.5);
    const r = mapWeightRange({ dateWeightList: [{ date: Date.UTC(2026, 10, 9, 8), weight: 81500 }] });
    expect(r.items[0]?.date).toBe('2026-11-09');
    expect(diag(r.diagnostics, 'date', 'fallback_used')).toBeDefined();
  });

  it('skips entries without a date or with an absurd weight, and treats empty lists as nothing', () => {
    const r = mapWeightRange({ dateWeightList: [{ weight: 80000 }, { calendarDate: '2026-11-09', weight: 5 }, { calendarDate: '2026-11-09', weight: null }] });
    expect(r.items).toEqual([]);
    expect(mapWeightRange({ dateWeightList: [] }).items).toEqual([]);
    expect(mapWeightRange({ dateWeightList: null }).items).toEqual([]);
    expect(mapWeightRange(null).items).toEqual([]);
  });

  it('converts a body fat fraction to percent', () => {
    const r = mapWeightRange({ dateWeightList: [{ samplePk: 1, calendarDate: '2026-11-09', weight: 80000, bodyFat: 0.2 }] });
    expect(one(r.items, 'body_fat').value).toBe(20);
  });

  it('survives hostile input', () => {
    for (const input of [undefined, 5, 'x', [1], { dateWeightList: [1, null, 'x'] }, { dateWeightList: { a: 1 } }, { data: 'x' }]) {
      expect(() => mapWeightRange(input)).not.toThrow();
    }
  });
});

describe('mapActivities (activitylist-service)', () => {
  const list = [
    {
      activityId: 12345678901,
      activityName: 'Morning run',
      startTimeLocal: '2026-11-09 06:30:00',
      distance: 5000.4,
      duration: 1800.6,
      movingDuration: 1700,
      calories: 412.4,
      averageHR: 150,
      maxHR: 175,
      activityType: { typeKey: 'running' },
    },
    {
      activityId: 12345678902,
      activityName: null,
      startTimeLocal: '2026-11-08 18:00:00',
      startTimeGMT: '2026-11-08 17:00:00',
      duration: 3000,
      calories: 163,
      activityType: { typeKey: 'strength_training' },
    },
  ];

  it('maps workouts with their calories and duration', () => {
    const r = mapActivities(list);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toEqual({
      externalId: 'garmin:activity:12345678901',
      name: 'Morning run',
      typeKey: 'running',
      date: '2026-11-09',
      startLocal: '2026-11-09 06:30:00',
      durationSec: 1801,
      kcal: 412,
      distanceM: 5000.4,
    });
    expect(r.items[1]).toMatchObject({ name: 'Strength training', typeKey: 'strength_training', date: '2026-11-08', startMs: Date.UTC(2026, 10, 8, 17), kcal: 163 });
  });

  it('files the workout under the local start day, whatever the UTC day', () => {
    const r = mapActivities([{ activityId: 1, startTimeLocal: '2026-11-09 00:30:00', startTimeGMT: '2026-11-08 23:30:00', duration: 600, activityType: { typeKey: 'walking' } }]);
    expect(r.items[0]?.date).toBe('2026-11-09');
  });

  it('falls back to elapsed / moving duration, and to the GMT clock without a local start', () => {
    const r = mapActivities([
      { activityId: 1, startTimeLocal: '2026-11-09 06:00:00', movingDuration: 900 },
      { activityId: 2, startTimeGMT: '2026-11-09 06:00:00', elapsedDuration: 1200 },
    ]);
    expect(r.items.map((w) => w.durationSec)).toEqual([900, 1200]);
    expect(r.items[1]?.startLocal).toBe('2026-11-09 06:00:00');
    expect(diag(r.diagnostics, 'startTimeLocal', 'fallback_used')).toBeDefined();
  });

  it('skips activities without an id, a start or a duration', () => {
    const r = mapActivities([{ startTimeLocal: '2026-11-09 06:00:00', duration: 60 }, { activityId: 2, duration: 60 }, { activityId: 3, startTimeLocal: '2026-11-09 06:00:00' }]);
    expect(r.items).toEqual([]);
  });

  it('leaves calories absent when Garmin has none, and accepts wrapped lists', () => {
    const r = mapActivities({ activityList: [{ activityId: 1, startTimeLocal: '2026-11-09 06:00:00', duration: 600 }] });
    expect(r.items[0]?.kcal).toBeUndefined();
    expect(mapActivities([]).items).toEqual([]);
    expect(mapActivities(null).items).toEqual([]);
  });

  it('is deduped by activity id', () => {
    const a = { activityId: 1, startTimeLocal: '2026-11-09 06:00:00', duration: 600, calories: 100 };
    expect(mapActivities([a, { ...a, calories: 120 }]).items).toHaveLength(1);
  });

  it('survives hostile input', () => {
    for (const input of [undefined, 5, 'x', [1, null], [{ activityId: {}, startTimeGMT: [] }], { activityList: { a: 1 } }, { weird: 1 }]) {
      expect(() => mapActivities(input)).not.toThrow();
    }
    expect(humanizeTypeKey('')).toBe('Workout');
    expect(humanizeTypeKey('lap_swimming')).toBe('Lap swimming');
  });
});

describe('field candidates', () => {
  it('list the reference (VERIFIED) name first for every field', () => {
    expect(FIELD_CANDIDATES.userSummary.activeKcal[0]).toBe('activeKilocalories');
    expect(FIELD_CANDIDATES.userSummary.restingKcal[0]).toBe('bmrKilocalories');
    expect(FIELD_CANDIDATES.userSummary.totalKcal[0]).toBe('totalKilocalories');
    expect(FIELD_CANDIDATES.userSummary.steps[0]).toBe('totalSteps');
    expect(FIELD_CANDIDATES.userSummary.restingHr[0]).toBe('restingHeartRate');
    expect(FIELD_CANDIDATES.userSummary.stress[0]).toBe('averageStressLevel');
    expect(FIELD_CANDIDATES.sleep.totalSec[0]).toBe('dailySleepDTO.sleepTimeSeconds');
    expect(FIELD_CANDIDATES.hrv.lastNight[0]).toBe('hrvSummary.lastNightAvg');
    expect(FIELD_CANDIDATES.weight.id[0]).toBe('samplePk');
    expect(FIELD_CANDIDATES.activities.startLocal[0]).toBe('startTimeLocal');
  });
});
