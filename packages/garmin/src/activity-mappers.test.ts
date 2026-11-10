import { describe, expect, it } from 'vitest';
import {
  DETAIL_FIELD_CANDIDATES,
  bestExerciseGuess,
  detailsFromListItem,
  mapActivitySummary,
  mapExerciseSets,
  mapHrZones,
  mapSplits,
} from './activity-mappers';
import { mapActivities } from './mappers';
import type { GarminDiagnostic, GarminFieldCoverage } from './normalized';

// The fixtures use the field names the reference project reads (garmin-companion: client.rs ActivitySummary / HrZoneBucket,
// strength.rs parse_sets, analysis.rs extract_laps). Values are made up. The names INSIDE summaryDTO are guesses (see
// DETAIL_FIELD_CANDIDATES) except where they equal a list field.

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const cov = (list: readonly GarminFieldCoverage[], field: string) => list.find((c) => c.field === field);
const diag = (list: readonly GarminDiagnostic[], field: string, reason?: string) => list.find((d) => d.field === field && (reason === undefined || d.reason === reason));

const LIST_RUN = {
  activityId: 12345678901,
  activityName: 'Morning run',
  startTimeLocal: '2026-11-09 06:30:00',
  distance: 5000.4,
  duration: 1800.6,
  movingDuration: 1700,
  calories: 412.4,
  averageHR: 150,
  maxHR: 175,
  averageSpeed: 2.7778,
  elevationGain: 38.4,
  aerobicTrainingEffect: 3.14,
  anaerobicTrainingEffect: 1.2,
  hrTimeInZone_1: 120.4,
  hrTimeInZone_2: 600,
  hrTimeInZone_3: 800,
  hrTimeInZone_4: 250,
  hrTimeInZone_5: 30,
  activityType: { typeKey: 'running' },
};

describe('detailsFromListItem (the activity list, no extra request)', () => {
  it('reads heart rate, zones, training effect, speed, climb and calories from the list fields', () => {
    expect(detailsFromListItem(LIST_RUN, NOW)).toEqual({
      v: 1,
      source: 'garmin',
      level: 'summary',
      fetchedAt: new Date(NOW).toISOString(),
      typeKey: 'running',
      avgHr: 150,
      maxHr: 175,
      hrZones: [
        { zone: 1, seconds: 120 },
        { zone: 2, seconds: 600 },
        { zone: 3, seconds: 800 },
        { zone: 4, seconds: 250 },
        { zone: 5, seconds: 30 },
      ],
      distanceM: 5000.4,
      elevationGainM: 38,
      avgSpeedMps: 2.778,
      avgPaceSecPerKm: 360,
      trainingEffect: { aerobic: 3.1, anaerobic: 1.2 },
      calories: 412,
    });
  });

  it('gives no pace for a bike ride, and nothing when the item has no such fields', () => {
    const ride = detailsFromListItem({ activityType: { typeKey: 'cycling' }, averageSpeed: 7.5, averageHR: 130 }, NOW);
    expect(ride?.avgSpeedMps).toBe(7.5);
    expect(ride?.avgPaceSecPerKm).toBeUndefined();
    expect(detailsFromListItem({ activityType: { typeKey: 'running' }, duration: 600 }, NOW)).toBeUndefined();
    expect(detailsFromListItem({}, NOW)).toBeUndefined();
  });

  it('ignores a worn day filed with averageHR 0 and zones without time', () => {
    const d = detailsFromListItem({ activityType: { typeKey: 'other' }, averageHR: 0, maxHR: 0, hrTimeInZone_1: 0, hrTimeInZone_2: 0, calories: 80 }, NOW);
    expect(d).toMatchObject({ calories: 80 });
    expect(d?.avgHr).toBeUndefined();
    expect(d?.hrZones).toBeUndefined();
  });

  it('is attached to mapActivities only when the caller passes the clock', () => {
    expect(mapActivities([LIST_RUN]).items[0]?.details).toBeUndefined();
    const withClock = mapActivities([LIST_RUN, { activityId: 2, startTimeLocal: '2026-11-09 06:00:00', duration: 600 }], { nowMs: NOW });
    expect(withClock.items[0]?.details).toMatchObject({ level: 'summary', avgHr: 150 });
    expect(withClock.items[1]?.details).toBeUndefined();
    // the report of the list is unchanged by the extra fields
    expect(withClock.coverage.map((c) => c.field)).not.toContain('avgHr');
  });
});

describe('mapActivitySummary (GET /activity-service/activity/{id})', () => {
  const reply = {
    activityId: 12345678901,
    activityName: 'Morning run',
    activityTypeDTO: { typeId: 1, typeKey: 'running' },
    summaryDTO: {
      startTimeLocal: '2026-11-09T06:30:00.0',
      distance: 5012.4,
      duration: 1800.6,
      movingDuration: 1700,
      elevationGain: 38.2,
      averageSpeed: 2.7778,
      calories: 412,
      bmrCalories: 94,
      averageHR: 150,
      maxHR: 175,
      minHR: 98,
      trainingEffect: 3.14,
      anaerobicTrainingEffect: 1.24,
    },
  };

  it('reads the summaryDTO', () => {
    const r = mapActivitySummary(reply);
    expect(r.part).toEqual({
      typeKey: 'running',
      avgHr: 150,
      maxHr: 175,
      minHr: 98,
      distanceM: 5012.4,
      elevationGainM: 38,
      avgSpeedMps: 2.778,
      avgPaceSecPerKm: 360,
      trainingEffect: { aerobic: 3.1, anaerobic: 1.2 },
      calories: 412,
      activeCalories: 318,
    });
    expect(cov(r.coverage, 'avgHr')).toMatchObject({ found: 1, total: 1, matchedBy: { 'summaryDTO.averageHR': 1 } });
    expect(cov(r.coverage, 'aerobicTrainingEffect')?.matchedBy).toEqual({ 'summaryDTO.trainingEffect': 1 });
    expect(diag(r.diagnostics, 'activeCalories', 'fallback_used')).toBeDefined();
  });

  it('falls back to a flat (list-like) shape, and to the pace from distance and time when there is no speed', () => {
    const r = mapActivitySummary({ activityType: { typeKey: 'walking' }, averageHR: 110, distance: 3000, duration: 1800, calories: 150 });
    expect(r.part).toMatchObject({ typeKey: 'walking', avgHr: 110, distanceM: 3000, calories: 150, avgPaceSecPerKm: 600 });
    expect(r.part.avgSpeedMps).toBeUndefined();
  });

  it('computes a pace from distance and duration when only those exist', () => {
    const r = mapActivitySummary({ activityTypeDTO: { typeKey: 'running' }, summaryDTO: { distance: 5000, duration: 1800 } });
    expect(r.part.avgPaceSecPerKm).toBe(360);
  });

  it('leaves absent what is absent, and reports what it could not find', () => {
    const r = mapActivitySummary({ activityTypeDTO: { typeKey: 'strength_training' }, summaryDTO: { duration: 3000, averageHR: 0, maxHR: 400 } });
    expect(r.part).toEqual({ typeKey: 'strength_training' });
    expect(cov(r.coverage, 'avgHr')?.found).toBe(0);
    expect(diag(r.diagnostics, 'avgHr', 'implausible')).toBeDefined();
  });

  it('a maximum below the average is dropped; a minimum above it too', () => {
    const r = mapActivitySummary({ summaryDTO: { averageHR: 150, maxHR: 120, minHR: 170 } });
    expect(r.part).toEqual({ avgHr: 150 });
  });

  it('survives hostile input', () => {
    for (const input of [undefined, null, 5, 'x', [], [1], { summaryDTO: 'x' }, { summaryDTO: [] }, { weird: 1 }]) {
      expect(() => mapActivitySummary(input)).not.toThrow();
    }
    expect(mapActivitySummary([{ summaryDTO: { averageHR: 100 } }]).part.avgHr).toBe(100);
    expect(diag(mapActivitySummary('x').diagnostics, '$', 'unexpected_shape')).toBeDefined();
  });

  it('lists its candidates, the verified list names first', () => {
    expect(DETAIL_FIELD_CANDIDATES.summary.avgHr[0]).toBe('summaryDTO.averageHR');
    expect(DETAIL_FIELD_CANDIDATES.summary.avgHr).toContain('averageHR');
  });
});

describe('mapHrZones (GET .../hrTimeInZones)', () => {
  const reply = [
    { zoneNumber: 1, secsInZone: 120.4, zoneLowBoundary: 95 },
    { zoneNumber: 2, secsInZone: 600, zoneLowBoundary: 114 },
    { zoneNumber: 3, secsInZone: 800, zoneLowBoundary: 133 },
    { zoneNumber: 4, secsInZone: 250.5, zoneLowBoundary: 152 },
    { zoneNumber: 5, secsInZone: 0, zoneLowBoundary: 171 },
  ];
  it('reads zoneNumber, secsInZone and zoneLowBoundary', () => {
    const r = mapHrZones(reply);
    expect(r.zones).toEqual([
      { zone: 1, seconds: 120, lowBpm: 95 },
      { zone: 2, seconds: 600, lowBpm: 114 },
      { zone: 3, seconds: 800, lowBpm: 133 },
      { zone: 4, seconds: 251, lowBpm: 152 },
      { zone: 5, seconds: 0, lowBpm: 171 },
    ]);
    expect(cov(r.coverage, 'secsInZone')).toMatchObject({ found: 5, total: 5 });
  });
  it('accepts a wrapped list, drops zones without a number or time, orders them', () => {
    const r = mapHrZones({ hrTimeInZones: [{ zoneNumber: 3, secsInZone: 5 }, { secsInZone: 9 }, { zoneNumber: 1, secsInZone: 7 }, { zoneNumber: 2 }] });
    expect(r.zones).toEqual([{ zone: 1, seconds: 7 }, { zone: 3, seconds: 5 }]);
  });
  it('gives no zones when no time was spent in any, or for hostile input', () => {
    expect(mapHrZones([{ zoneNumber: 1, secsInZone: 0 }]).zones).toEqual([]);
    for (const input of [undefined, null, 5, 'x', {}, { weird: 1 }, [1, 'a']]) expect(() => mapHrZones(input)).not.toThrow();
    expect(mapHrZones({ weird: 1 }).zones).toEqual([]);
  });
});

describe('mapExerciseSets (GET .../exerciseSets)', () => {
  const set = (i: number, type: 'ACTIVE' | 'REST', extra: Record<string, unknown> = {}) => ({ messageIndex: i, setType: type, ...extra });
  const bench = [{ category: 'BENCH_PRESS', probability: 91.2 }, { category: 'SHOULDER_PRESS', probability: 5 }];

  it('pairs each work set with the rest after it, converts grams to kg and names the exercise', () => {
    const r = mapExerciseSets({
      exerciseSets: [
        set(0, 'ACTIVE', { duration: 31.2, repetitionCount: 8, weight: 60000, exercises: bench }),
        set(1, 'REST', { duration: 90 }),
        set(2, 'ACTIVE', { duration: 28, repetitionCount: 6, weight: 70000, exercises: bench }),
        set(3, 'REST', { duration: 120 }),
        set(4, 'ACTIVE', { duration: 40, repetitionCount: 12, weight: null, exercises: [{ category: 'UNKNOWN', probability: 99 }] }),
      ],
    });
    expect(r.sets).toEqual([
      { exercise: 'Bench press', guess: true, reps: 8, weightKg: 60, durationSec: 31, restSec: 90 },
      { exercise: 'Bench press', guess: true, reps: 6, weightKg: 70, durationSec: 28, restSec: 120 },
      { reps: 12, durationSec: 40 },
    ]);
    expect(cov(r.coverage, 'repetitionCount')).toMatchObject({ found: 3 });
  });

  it('puts sets in messageIndex order when the numbering is unique, in array order otherwise', () => {
    const shuffled = mapExerciseSets({ exerciseSets: [set(2, 'ACTIVE', { repetitionCount: 3 }), set(0, 'ACTIVE', { repetitionCount: 1 }), set(1, 'ACTIVE', { repetitionCount: 2 })] });
    expect(shuffled.sets.map((s) => s.reps)).toEqual([1, 2, 3]);
    const repeated = mapExerciseSets({ exerciseSets: [set(1, 'ACTIVE', { repetitionCount: 3 }), set(1, 'ACTIVE', { repetitionCount: 1 })] });
    expect(repeated.sets.map((s) => s.reps)).toEqual([3, 1]);
  });

  it('drops noise sets and rests without a work set before them', () => {
    const r = mapExerciseSets({ exerciseSets: [set(0, 'REST', { duration: 30 }), set(1, 'ACTIVE', {}), set(2, 'ACTIVE', { repetitionCount: 10 })] });
    expect(r.sets).toEqual([{ reps: 10 }]);
  });

  it('a set without a type counts as a work set; a weight of 0 is not a weight', () => {
    const r = mapExerciseSets({ exerciseSets: [{ repetitionCount: 5, weight: 0 }] });
    expect(r.sets).toEqual([{ reps: 5 }]);
  });

  it('caps the number of sets', () => {
    const many = { exerciseSets: Array.from({ length: 300 }, (_, i) => set(i, 'ACTIVE', { repetitionCount: 5 })) };
    expect(mapExerciseSets(many).sets).toHaveLength(120);
  });

  it('survives hostile input', () => {
    for (const input of [undefined, null, 5, 'x', {}, { exerciseSets: null }, { exerciseSets: [1, null, 'a'] }, [], { exerciseSets: [{ exercises: 'x', duration: 'y' }] }]) {
      expect(() => mapExerciseSets(input)).not.toThrow();
    }
    expect(mapExerciseSets({ exerciseSets: null }).sets).toEqual([]);
  });
});

describe('bestExerciseGuess (reference strength.rs: floor 50, a tie is no guess, UNKNOWN never wins)', () => {
  it('picks the clear winner', () => {
    expect(bestExerciseGuess([{ category: 'CURL', probability: 80 }, { category: 'ROW', probability: 10 }])).toBe('Curl');
    expect(bestExerciseGuess([{ category: 'CURL', probability: 55 }])).toBe('Curl');
  });
  it('is undefined below the floor, for UNKNOWN and for an exact tie', () => {
    expect(bestExerciseGuess([{ category: 'CURL', probability: 49 }])).toBeUndefined();
    expect(bestExerciseGuess([{ category: 'UNKNOWN', probability: 99 }, { category: 'CURL', probability: 40 }])).toBeUndefined();
    expect(bestExerciseGuess([{ category: 'BENCH_PRESS', probability: 74.609375 }, { category: 'SHOULDER_PRESS', probability: 74.609375 }])).toBeUndefined();
  });
  it('an UNKNOWN does not hide a real guess below it', () => {
    expect(bestExerciseGuess([{ category: 'UNKNOWN', probability: 99 }, { category: 'SQUAT', probability: 60 }])).toBe('Squat');
  });
  it('tolerates junk', () => {
    expect(bestExerciseGuess(undefined)).toBeUndefined();
    expect(bestExerciseGuess([null, 1, { category: 5 }, { probability: 90 }])).toBeUndefined();
  });
});

describe('mapSplits (GET .../splits)', () => {
  const reply = {
    lapDTOs: [
      { lapIndex: 1, distance: 1000, duration: 360.4, averageHR: 148, maxHR: 160, elevationGain: 4.2 },
      { lapIndex: 2, distance: 1000, duration: 355, averageHR: 152, maxHR: 165 },
      { lapIndex: 3, distance: 5, duration: 10 },
      { lapIndex: 4, distance: 1000 },
    ],
  };
  it('reads the laps (lapDTOs) with pace, heart rate and climb; a lap without a duration is dropped', () => {
    const r = mapSplits(reply);
    expect(r.laps).toEqual([
      { index: 1, distanceM: 1000, durationSec: 360, avgHr: 148, maxHr: 160, paceSecPerKm: 360, elevationGainM: 4 },
      { index: 2, distanceM: 1000, durationSec: 355, avgHr: 152, maxHr: 165, paceSecPerKm: 355 },
      { index: 3, distanceM: 5, durationSec: 10 },
    ]);
  });
  it('keeps at most 20 laps', () => {
    const many = { lapDTOs: Array.from({ length: 50 }, (_, i) => ({ lapIndex: i + 1, distance: 100, duration: 30 })) };
    expect(mapSplits(many).laps).toHaveLength(20);
  });
  it('numbers laps by position without lapIndex and survives hostile input', () => {
    expect(mapSplits({ lapDTOs: [{ duration: 30 }, { duration: 40 }] }).laps.map((l) => l.index)).toEqual([1, 2]);
    for (const input of [undefined, null, 5, 'x', {}, { lapDTOs: 'x' }, { lapDTOs: [null, 1] }]) expect(() => mapSplits(input)).not.toThrow();
  });
});
