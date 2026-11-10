import { describe, expect, it } from 'vitest';
import {
  DETAILS_MAX_AGE_MS,
  MAX_LAPS,
  MAX_SETS,
  boundedNumber,
  garminActivityIdOf,
  hasWorkoutData,
  humanizeExerciseName,
  isPacedKey,
  isStrengthLike,
  needsGarminDetails,
  paceFromDistance,
  paceFromSpeed,
  parseWorkoutDetails,
  toStoredDetails,
  type DetailsCandidate,
  type WorkoutDetails,
} from './workout-details';

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

const FULL: WorkoutDetails = {
  v: 1,
  source: 'garmin',
  level: 'full',
  fetchedAt: iso(NOW - 3_600_000),
  typeKey: 'strength_training',
  avgHr: 128,
  maxHr: 171,
  minHr: 72,
  hrZones: [
    { zone: 1, seconds: 300, lowBpm: 95 },
    { zone: 2, seconds: 900, lowBpm: 114 },
  ],
  trainingEffect: { aerobic: 3.1, anaerobic: 1.2 },
  calories: 412,
  sets: [{ exercise: 'Bench press', guess: true, reps: 8, weightKg: 60, durationSec: 31, restSec: 90 }],
  laps: [{ index: 1, distanceM: 1000, durationSec: 360, avgHr: 150, paceSecPerKm: 360 }],
};

describe('parseWorkoutDetails', () => {
  it('round-trips a valid v1 object unchanged', () => {
    expect(parseWorkoutDetails(FULL)).toEqual(FULL);
    expect(parseWorkoutDetails(JSON.stringify(FULL))).toEqual(FULL);
  });

  it('refuses anything that is not a v1 garmin object, without throwing', () => {
    for (const bad of [null, undefined, 5, 'x', '{', [], {}, { v: 2, source: 'garmin' }, { v: 1, source: 'apple' }, { v: 1 }]) {
      expect(parseWorkoutDetails(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('drops out-of-range and wrongly typed values instead of failing', () => {
    const d = parseWorkoutDetails({
      v: 1,
      source: 'garmin',
      fetchedAt: iso(NOW),
      avgHr: 0, // Garmin files a worn day with averageHR 0
      maxHr: 900,
      minHr: 'abc',
      distanceM: -5,
      avgSpeedMps: 'fast',
      trainingEffect: { aerobic: 9, anaerobic: '2.4' },
      calories: 0,
      sets: [{ exercise: '  ', reps: 'x' }, 'junk', { reps: 10, weightKg: -3 }],
      laps: 'nope',
      hrZones: [{ zone: 0, seconds: 5 }, { zone: 2, seconds: -1 }],
      extra: 'kept out',
    });
    expect(d).toEqual({
      v: 1,
      source: 'garmin',
      level: 'full',
      fetchedAt: iso(NOW),
      trainingEffect: { anaerobic: 2.4 },
      sets: [{ reps: 10 }],
    });
  });

  it('keeps numeric strings, normalises the type key and the time', () => {
    const d = parseWorkoutDetails({ v: '1', source: 'garmin', fetchedAt: '2026-11-10T13:00:00+01:00', typeKey: ' Running ', avgHr: '150.4' });
    expect(d).toMatchObject({ v: 1, fetchedAt: iso(NOW), typeKey: 'running', avgHr: 150 });
    expect(parseWorkoutDetails({ v: 1, source: 'garmin', fetchedAt: 'yesterday' })?.fetchedAt).toBe('1970-01-01T00:00:00.000Z');
    expect(parseWorkoutDetails({ v: 1, source: 'garmin', fetchedAt: iso(NOW), typeKey: 'bad key!' })?.typeKey).toBeUndefined();
  });

  it('a maximum below the average (or a minimum above it) is not believed', () => {
    const d = parseWorkoutDetails({ v: 1, source: 'garmin', fetchedAt: iso(NOW), avgHr: 150, maxHr: 140, minHr: 160 });
    expect(d).toMatchObject({ avgHr: 150 });
    expect(d?.maxHr).toBeUndefined();
    expect(d?.minHr).toBeUndefined();
  });

  it('caps laps at 20 and sets at 120, and removes duplicate zones', () => {
    const laps = Array.from({ length: 40 }, (_, i) => ({ index: i + 1, durationSec: 60 }));
    const sets = Array.from({ length: 300 }, () => ({ reps: 5 }));
    const zones = [{ zone: 2, seconds: 10 }, { zone: 2, seconds: 20 }, { zone: 1, seconds: 5 }];
    const d = parseWorkoutDetails({ v: 1, source: 'garmin', fetchedAt: iso(NOW), laps, sets, hrZones: zones });
    expect(d?.laps).toHaveLength(MAX_LAPS);
    expect(d?.sets).toHaveLength(MAX_SETS);
    expect(d?.hrZones).toEqual([{ zone: 1, seconds: 5 }, { zone: 2, seconds: 20 }]);
  });

  it('zones with no time at all are left out, and a set needs reps, a duration or a name', () => {
    const d = parseWorkoutDetails({
      v: 1,
      source: 'garmin',
      fetchedAt: iso(NOW),
      hrZones: [{ zone: 1, seconds: 0 }],
      sets: [{ weightKg: 20 }, { durationSec: 30 }],
    });
    expect(d?.hrZones).toBeUndefined();
    expect(d?.sets).toEqual([{ durationSec: 30 }]);
  });

  it('level is "summary" only when it says so', () => {
    expect(parseWorkoutDetails({ v: 1, source: 'garmin', fetchedAt: iso(NOW), level: 'summary' })?.level).toBe('summary');
    expect(parseWorkoutDetails({ v: 1, source: 'garmin', fetchedAt: iso(NOW) })?.level).toBe('full');
    expect(parseWorkoutDetails({ v: 1, source: 'garmin', fetchedAt: iso(NOW), level: 'whatever' })?.level).toBe('full');
  });
});

describe('toStoredDetails / hasWorkoutData', () => {
  it('stores the canonical form: undefined keys and unknown keys are gone', () => {
    const stored = toStoredDetails({ ...FULL, avgHr: undefined, laps: undefined, hrZones: undefined, sets: undefined, ...({ rogue: 1 } as object) } as WorkoutDetails);
    expect(stored).not.toBeNull();
    expect(Object.keys(stored as object).sort()).toEqual(['calories', 'fetchedAt', 'level', 'maxHr', 'minHr', 'source', 'trainingEffect', 'typeKey', 'v']);
  });
  it('knows an empty envelope from one with data', () => {
    expect(hasWorkoutData(null)).toBe(false);
    expect(hasWorkoutData({ v: 1, source: 'garmin', fetchedAt: iso(NOW), typeKey: 'running' })).toBe(false);
    expect(hasWorkoutData({ v: 1, source: 'garmin', fetchedAt: iso(NOW), avgHr: 120 })).toBe(true);
  });
});

describe('helpers', () => {
  it('boundedNumber', () => {
    expect(boundedNumber('12.345', 0, 100, { decimals: 1 })).toBe(12.3);
    expect(boundedNumber(0, 0, 10, { above: true })).toBeUndefined();
    expect(boundedNumber(11, 0, 10)).toBeUndefined();
    expect(boundedNumber(null, 0, 10)).toBeUndefined();
    expect(boundedNumber(Number.NaN, 0, 10)).toBeUndefined();
  });
  it('pace from distance and from speed', () => {
    expect(paceFromDistance(5000, 1800)).toBe(360);
    expect(paceFromDistance(5, 60)).toBeUndefined(); // part-lap
    expect(paceFromDistance(undefined, 60)).toBeUndefined();
    expect(paceFromDistance(1000, 0)).toBeUndefined();
    expect(paceFromSpeed(2.7778)).toBe(360);
    expect(paceFromSpeed(0)).toBeUndefined();
    expect(paceFromSpeed(30)).toBeUndefined(); // 33 s per km is not a pace
  });
  it('garminActivityIdOf accepts only the sync format', () => {
    expect(garminActivityIdOf('garmin:activity:12345678901')).toBe('12345678901');
    for (const bad of [null, undefined, '', 'garmin:sleep:2026-11-09', 'garmin:activity:', 'garmin:activity:12a', 'garmin:activity:../x', 'HK-1']) {
      expect(garminActivityIdOf(bad), String(bad)).toBeNull();
    }
  });
  it('names and kinds', () => {
    expect(humanizeExerciseName('BENCH_PRESS')).toBe('Bench press');
    expect(humanizeExerciseName('')).toBe('');
    expect(isStrengthLike('strength_training')).toBe(true);
    expect(isStrengthLike('hiit')).toBe(true);
    expect(isStrengthLike('running', 'Strength run')).toBe(false); // the type key decides when there is one
    expect(isStrengthLike(undefined, 'Strength training')).toBe(true);
    expect(isStrengthLike(undefined, 'Morning run')).toBe(false);
    expect(isPacedKey('treadmill_running')).toBe(true);
    expect(isPacedKey('cycling')).toBe(false);
    expect(isPacedKey(undefined)).toBe(false);
  });
});

describe('needsGarminDetails', () => {
  const row = (over: Partial<DetailsCandidate> = {}): DetailsCandidate => ({
    source: 'garmin',
    external_id: 'garmin:activity:123',
    details: null,
    started_at: iso(NOW - 3_600_000),
    entry_date: '2026-11-10',
    ...over,
  });

  it('never for manual, device-health or id-less rows', () => {
    expect(needsGarminDetails(row({ source: 'manual' }), NOW)).toBe(false);
    expect(needsGarminDetails(row({ source: 'apple_health' }), NOW)).toBe(false);
    expect(needsGarminDetails(row({ external_id: null }), NOW)).toBe(false);
    expect(needsGarminDetails(row({ external_id: 'garmin:sleep:2026-11-09' }), NOW)).toBe(false);
  });
  it('yes without details, with unreadable details and with only the list summary', () => {
    expect(needsGarminDetails(row(), NOW)).toBe(true);
    expect(needsGarminDetails(row({ details: { nonsense: true } }), NOW)).toBe(true);
    expect(needsGarminDetails(row({ details: { ...FULL, level: 'summary' } }), NOW)).toBe(true);
  });
  it('no for fresh full details', () => {
    expect(needsGarminDetails(row({ details: FULL }), NOW)).toBe(false);
  });
  it('older than a day: yes while the workout is recent, no once it is old', () => {
    const stale = { ...FULL, fetchedAt: iso(NOW - DETAILS_MAX_AGE_MS - 1000) };
    expect(needsGarminDetails(row({ details: stale }), NOW)).toBe(true);
    expect(needsGarminDetails(row({ details: stale, started_at: iso(NOW - 10 * 86_400_000), entry_date: '2026-10-31' }), NOW)).toBe(false);
    expect(needsGarminDetails(row({ details: { ...FULL, fetchedAt: 'garbage' } }), NOW)).toBe(true);
  });
  it('uses the entry date when the start time is unknown', () => {
    const stale = { ...FULL, fetchedAt: iso(NOW - 2 * DETAILS_MAX_AGE_MS) };
    expect(needsGarminDetails(row({ details: stale, started_at: null, entry_date: '2026-11-09' }), NOW)).toBe(true);
    expect(needsGarminDetails(row({ details: stale, started_at: null, entry_date: '2026-09-01' }), NOW)).toBe(false);
  });
});
