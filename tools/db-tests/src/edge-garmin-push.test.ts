import { describe, expect, it } from 'vitest';
import {
  BIOMETRIC_UNITS,
  canonicalKind,
  emptyMapped,
  extractPushItems,
  hasRows,
  humanizeActivityType,
  localDateOf,
  mapActivity,
  mapBodyComps,
  mapDailies,
  mapHrv,
  mapPushItem,
  mapSleeps,
  mapStressDetails,
  mergeMapped,
  toEpochSec,
  toYmd,
  trimPayload,
} from '../../../supabase/functions/_shared/garmin-push.ts';

// 2026-11-10 00:00:00 UTC
const DAY = Date.UTC(2026, 10, 10) / 1000;

describe('garmin-push: extractPushItems', () => {
  it('splits a body into items per kind and deregistrations', () => {
    const r = extractPushItems({
      dailies: [{ userId: 'u1', summaryId: 's1', calendarDate: '2026-11-10' }],
      sleeps: [{ userId: 'u2', userAccessToken: 'tok' }],
      deregistrations: [{ userId: 'u3' }, { userAccessToken: 'tok-only' }],
    });
    expect(r.items.map((i) => [i.kind, i.garminUserId, i.accessToken, i.summaryId])).toEqual([
      ['dailies', 'u1', null, 's1'],
      ['sleeps', 'u2', 'tok', null],
    ]);
    expect(r.deregistrations).toEqual([
      { garminUserId: 'u3', accessToken: null },
      { garminUserId: null, accessToken: 'tok-only' },
    ]);
    expect(r.skipped).toBe(0);
  });

  it('accepts alias kind names and numeric user ids, and keeps unknown kinds as they are', () => {
    const r = extractPushItems({
      dailySummaries: [{ userId: 12345 }],
      bodyCompositions: [{ garminUserId: 'x' }],
      userMetrics: [{ userId: 'u' }],
    });
    expect(r.items.map((i) => [i.kind, i.garminUserId])).toEqual([
      ['dailies', '12345'],
      ['bodyComps', 'x'],
      ['userMetrics', 'u'],
    ]);
    expect(canonicalKind('STRESSDETAILS')).toBe('stressDetails');
    expect(canonicalKind('somethingNew')).toBe('somethingNew');
  });

  it('skips non-object entries and non-array values without throwing', () => {
    const r = extractPushItems({
      dailies: [1, 'x', null, { userId: 'u' }],
      sleeps: { not: 'an array' },
    });
    expect(r.items).toHaveLength(1);
    expect(r.skipped).toBe(4);
    for (const bad of [null, undefined, 'text', 42, [1, 2]]) {
      expect(extractPushItems(bad)).toEqual({ items: [], deregistrations: [], skipped: 1 });
    }
  });
});

describe('garmin-push: dates', () => {
  it('toYmd accepts real calendar days only', () => {
    expect(toYmd('2026-11-10')).toBe('2026-11-10');
    expect(toYmd('2026-11-10T08:00:00Z')).toBe('2026-11-10');
    expect(toYmd('2026-02-31')).toBeUndefined();
    expect(toYmd('10.11.2026')).toBeUndefined();
    expect(toYmd(20261110)).toBeUndefined();
  });

  it('toEpochSec converts milliseconds and rejects junk', () => {
    expect(toEpochSec(DAY)).toBe(DAY);
    expect(toEpochSec(DAY * 1000)).toBe(DAY);
    expect(toEpochSec(`${DAY}`)).toBe(DAY);
    expect(toEpochSec(0)).toBeUndefined();
    expect(toEpochSec(-5)).toBeUndefined();
    expect(toEpochSec('x')).toBeUndefined();
  });

  it('localDateOf applies the UTC offset of the user', () => {
    const lateEvening = DAY + 23 * 3600 + 30 * 60; // 23:30 UTC
    expect(localDateOf(lateEvening, 0)).toBe('2026-11-10');
    expect(localDateOf(lateEvening, 2 * 3600)).toBe('2026-11-11'); // 01:30 local, next day
    expect(localDateOf(DAY + 30 * 60, -5 * 3600)).toBe('2026-11-09'); // 19:30 local, previous day
  });
});

describe('garmin-push: dailies -> daily_energy (+ resting HR, stress, body battery)', () => {
  const flat = {
    userId: 'u1',
    summaryId: 'x1',
    calendarDate: '2026-11-10',
    startTimeInSeconds: DAY,
    startTimeOffsetInSeconds: 3600,
    durationInSeconds: 43_200,
    steps: 4210,
    activeKilocalories: 321.4,
    bmrKilocalories: 801,
    restingHeartRateInBeatsPerMinute: 58,
    averageStressLevel: 34,
  };

  it('maps the flat Health-API names; kcal are the day-so-far values as pushed (never deltas)', () => {
    const m = mapDailies(flat);
    expect(m.energy).toEqual([
      { local_date: '2026-11-10', active_kcal: 321, resting_kcal: 801, steps: 4210 },
    ]);
    expect(m.biometrics.map((b) => [b.type, b.value, b.unit, b.external_id])).toEqual([
      ['resting_heart_rate', 58, 'bpm', 'garmin:resting_heart_rate:2026-11-10'],
      ['stress', 34, 'score', 'garmin:stress:2026-11-10'],
    ]);
    // recorded_at = end of the covered window: it orders cumulative pushes of the same day
    expect(m.biometrics[0]!.recorded_at).toBe(new Date((DAY + 43_200) * 1000).toISOString());
  });

  it('a later, larger cumulative push of the same day maps to larger values (the DB keeps the latest)', () => {
    const later = mapDailies({
      ...flat,
      durationInSeconds: 86_400,
      steps: 9000,
      activeKilocalories: 700,
      bmrKilocalories: 1650,
    });
    expect(later.energy[0]).toEqual({
      local_date: '2026-11-10',
      active_kcal: 700,
      resting_kcal: 1650,
      steps: 9000,
    });
    expect(later.biometrics[0]!.recorded_at! > mapDailies(flat).biometrics[0]!.recorded_at!).toBe(
      true,
    );
  });

  it('maps the nested v2 shape verified on a real Personal API account', () => {
    const m = mapDailies({
      calendarDate: '2026-11-09',
      calories: { burnedActive: 512.6, burnedResting: 1702, burnedTotal: 2214.6 },
      movement: { steps: { value: 10432 } },
      heartRate: { restingValue: 55, minValue: 48, maxValue: 160 },
      stress: { avgLevel: 29 },
      bodyBattery: {
        maxValue: 92,
        minValue: 14,
        latestValue: 40,
        chargedValue: 71,
        drainedValue: 78,
      },
    });
    expect(m.energy).toEqual([
      { local_date: '2026-11-09', active_kcal: 513, resting_kcal: 1702, steps: 10432 },
    ]);
    expect(m.biometrics.map((b) => [b.type, b.value])).toEqual([
      ['resting_heart_rate', 55],
      ['stress', 29],
      ['body_battery', 92],
    ]);
    expect(m.biometrics[2]!.meta).toEqual({
      high: 92,
      low: 14,
      latest: 40,
      charged: 71,
      drained: 78,
    });
  });

  it('derives resting from total - active (and vice versa) like the pull mapper', () => {
    expect(
      mapDailies({ calendarDate: '2026-11-10', activeKilocalories: 300, totalKilocalories: 1100 })
        .energy[0],
    ).toMatchObject({
      active_kcal: 300,
      resting_kcal: 800,
    });
    expect(
      mapDailies({ calendarDate: '2026-11-10', bmrKilocalories: 800, totalKilocalories: 1100 })
        .energy[0],
    ).toMatchObject({
      active_kcal: 300,
      resting_kcal: 800,
    });
  });

  it('zero or negative counters are "unknown", not zero; an all-empty push yields no energy row', () => {
    const early = mapDailies({
      calendarDate: '2026-11-10',
      steps: 0,
      activeKilocalories: 0,
      bmrKilocalories: 12,
    });
    expect(early.energy).toEqual([
      { local_date: '2026-11-10', active_kcal: null, resting_kcal: 12, steps: null },
    ]);
    expect(
      mapDailies({ calendarDate: '2026-11-10', steps: 0, activeKilocalories: 0 }).energy,
    ).toEqual([]);
  });

  it('rejects implausible values and Garmin "no data" markers', () => {
    const m = mapDailies({
      calendarDate: '2026-11-10',
      steps: 999_999,
      activeKilocalories: 99_999,
      restingHeartRateInBeatsPerMinute: 5,
      averageStressLevel: -1,
    });
    expect(m.energy).toEqual([]);
    expect(m.biometrics).toEqual([]);
  });

  it('accepts numeric strings and falls back to the start time for the date', () => {
    const m = mapDailies({
      startTimeInSeconds: String(DAY),
      startTimeOffsetInSeconds: 7200,
      steps: '1500',
    });
    expect(m.energy).toEqual([
      { local_date: '2026-11-10', active_kcal: null, resting_kcal: null, steps: 1500 },
    ]);
  });

  it('reports a note and no rows without any date', () => {
    const m = mapDailies({ steps: 100 });
    expect(hasRows(m)).toBe(false);
    expect(m.notes).toEqual(['dailies: no calendarDate / start time']);
  });
});

describe('garmin-push: sleeps -> biometrics', () => {
  it('maps the flat push shape: hours asleep = deep + light + REM, stage minutes, score, night SpO2 / respiration', () => {
    const m = mapSleeps({
      calendarDate: '2026-11-10',
      startTimeInSeconds: DAY - 8 * 3600,
      durationInSeconds: 8 * 3600,
      deepSleepDurationInSeconds: 5400,
      lightSleepDurationInSeconds: 14400,
      remSleepInSeconds: 7200,
      awakeDurationInSeconds: 1800,
      overallSleepScore: { value: 81, qualifierKey: 'GOOD' },
      timeOffsetSleepSpo2: { '0': 95, '60': 97, '120': 0, '180': 96 },
      timeOffsetSleepRespiration: { '0': 14, '60': 16 },
    });
    const byType = Object.fromEntries(m.biometrics.map((b) => [b.type, b]));
    expect(byType.sleep).toMatchObject({
      value: 7.5,
      unit: 'hr',
      external_id: 'garmin:sleep:2026-11-10',
      entry_date: '2026-11-10',
    });
    expect(byType.sleep!.meta).toMatchObject({
      deepMin: 90,
      lightMin: 240,
      remMin: 120,
      awakeMin: 30,
      score: 81,
    });
    expect(byType.sleep!.recorded_at).toBe(new Date(DAY * 1000).toISOString());
    expect(byType.spo2).toMatchObject({ value: 96, meta: { source: 'sleep', low: 95 } });
    expect(byType.respiration_rate!.value).toBe(15);
  });

  it('maps the nested shape (sleepTimeSeconds, sleepScores.overall.value, averages)', () => {
    const m = mapSleeps({
      calendarDate: '2026-11-09',
      sleepTimeSeconds: 27000,
      deepSleepSeconds: 3600,
      lightSleepSeconds: 18000,
      remSleepSeconds: 5400,
      awakeSleepSeconds: 900,
      sleepScores: { overall: { value: 77 } },
      averageSpO2Value: 94.4,
      averageRespirationValue: 13.2,
    });
    expect(m.biometrics.map((b) => [b.type, b.value])).toEqual([
      ['sleep', 7.5],
      ['spo2', 94.4],
      ['respiration_rate', 13.2],
    ]);
    expect(m.biometrics[0]!.meta.score).toBe(77);
  });

  it('with only the period length known, subtracts awake / unmeasurable time and flags it', () => {
    const m = mapSleeps({
      calendarDate: '2026-11-10',
      durationInSeconds: 30_600,
      awakeDurationInSeconds: 1800,
      unmeasurableSleepDurationInSeconds: 1800,
    });
    expect(m.biometrics[0]).toMatchObject({ type: 'sleep', value: 7.5 });
    expect(m.biometrics[0]!.meta.approx).toBe(true);
  });

  it('drops implausible nights and notes why', () => {
    expect(mapSleeps({ calendarDate: '2026-11-10', sleepTimeSeconds: 120 }).biometrics).toEqual([]);
    const none = mapSleeps({ calendarDate: '2026-11-10' });
    expect(none.biometrics).toEqual([]);
    expect(none.notes).toEqual(['sleeps: no sleep duration']);
  });
});

describe('garmin-push: activities -> exercise_entries', () => {
  const activity = {
    userId: 'u1',
    summaryId: 'sum-1',
    activityId: 987654,
    activityName: 'Morning Run',
    activityType: 'RUNNING',
    startTimeInSeconds: DAY + 6 * 3600,
    startTimeOffsetInSeconds: 3600,
    durationInSeconds: 1950,
    activeKilocalories: 410,
  };

  it('maps a push summary; the id scheme matches the pull mapper so a later backfill de-duplicates', () => {
    const m = mapActivity(activity);
    expect(m.exercises).toEqual([
      {
        entry_date: '2026-11-10',
        name: 'Morning Run',
        minutes: 32.5,
        kcal: 410,
        external_id: 'garmin:activity:987654',
        started_at: new Date((DAY + 6 * 3600) * 1000).toISOString(),
        ended_at: new Date((DAY + 6 * 3600 + 1950) * 1000).toISOString(),
      },
    ]);
  });

  it('uses the summaryId when there is no activityId, and humanizes the type when there is no name', () => {
    const m = mapActivity({
      ...activity,
      activityId: undefined,
      activityName: undefined,
      activityType: 'ROCK_CLIMBING',
    });
    expect(m.exercises[0]).toMatchObject({
      name: 'Rock climbing',
      external_id: 'garmin:activity:sum-1',
    });
    expect(humanizeActivityType('HIGH_INTENSITY_INTERVAL_TRAINING')).toBe('HIIT');
    expect(humanizeActivityType('strengthTraining')).toBe('Strength training');
    expect(humanizeActivityType(undefined)).toBe('Workout');
  });

  it('buckets the workout on the LOCAL day (UTC offset) and keeps unknown kcal as 0', () => {
    const late = mapActivity({
      ...activity,
      startTimeInSeconds: DAY + 23 * 3600,
      startTimeOffsetInSeconds: 2 * 3600,
      activeKilocalories: undefined,
    });
    expect(late.exercises[0]).toMatchObject({ entry_date: '2026-11-11', kcal: 0 });
  });

  it('skips activities without a start, an id or a usable duration', () => {
    expect(mapActivity({ ...activity, startTimeInSeconds: undefined }).exercises).toEqual([]);
    expect(
      mapActivity({ ...activity, activityId: undefined, summaryId: undefined }).exercises,
    ).toEqual([]);
    expect(mapActivity({ ...activity, durationInSeconds: 0 }).exercises).toEqual([]);
    expect(mapActivity({ ...activity, durationInSeconds: 99 * 86400 }).exercises).toEqual([]);
  });
});

describe('garmin-push: stressDetails -> body battery', () => {
  it('takes the day high / low / latest from the time-offset samples', () => {
    const m = mapStressDetails({
      calendarDate: '2026-11-10',
      startTimeInSeconds: DAY,
      durationInSeconds: 86_400,
      timeOffsetBodyBatteryValues: {
        '0': 40,
        '900': 55,
        '1800': 90,
        '2700': 62,
        '3600': -1,
        '4500': 140,
      },
    });
    expect(m.biometrics).toHaveLength(1);
    expect(m.biometrics[0]).toMatchObject({
      type: 'body_battery',
      value: 90,
      unit: 'percent',
      external_id: 'garmin:body_battery:2026-11-10',
    });
    expect(m.biometrics[0]!.meta).toEqual({ high: 90, low: 40, latest: 62, samples: 4 });
  });

  it('notes missing or unusable samples', () => {
    expect(mapStressDetails({ calendarDate: '2026-11-10' }).notes).toEqual([
      'stressDetails: no body battery samples',
    ]);
    expect(
      mapStressDetails({ calendarDate: '2026-11-10', timeOffsetBodyBatteryValues: { '0': -1 } })
        .biometrics,
    ).toEqual([]);
  });
});

describe('garmin-push: bodyComps -> weight and body fat', () => {
  const comp = {
    userId: 'u1',
    summaryId: 'bc1',
    measurementTimeInSeconds: DAY + 7 * 3600,
    measurementTimeOffsetInSeconds: 3600,
    weightInGrams: 72_450,
    bodyFatInPercent: 18.26,
    bodyMassIndex: 22.34,
    muscleMassInGrams: 33_000,
    bodyWaterInPercent: 55.5,
  };

  it('maps grams to kg and uses per-measurement external ids like the pull mapper', () => {
    const m = mapBodyComps(comp);
    const t = (DAY + 7 * 3600) * 1000;
    expect(m.biometrics.map((b) => [b.type, b.value, b.unit, b.external_id, b.entry_date])).toEqual(
      [
        ['weight', 72.45, 'kg', `garmin:weight:2026-11-10:${t}`, '2026-11-10'],
        ['body_fat', 18.3, 'percent', `garmin:body_fat:2026-11-10:${t}`, '2026-11-10'],
      ],
    );
    expect(m.biometrics[0]!.meta).toEqual({ bmi: 22.3, muscleMassKg: 33, bodyWaterPct: 55.5 });
  });

  it('converts a body fat fraction and rejects implausible weights', () => {
    expect(
      mapBodyComps({ ...comp, weightInGrams: undefined, bodyFatInPercent: 0.2 }).biometrics[0]!
        .value,
    ).toBe(20);
    const bad = mapBodyComps({ ...comp, weightInGrams: 1500, bodyFatInPercent: undefined });
    expect(bad.biometrics).toEqual([]);
    expect(bad.notes).toEqual(['bodyComps: implausible weight']);
  });
});

describe('garmin-push: hrv', () => {
  it('maps last night average with optional meta', () => {
    const m = mapHrv({
      calendarDate: '2026-11-10',
      lastNightAvg: 48.4,
      lastNight5MinHigh: 91,
      weeklyAvg: 50,
      status: 'BALANCED',
    });
    expect(m.biometrics[0]).toMatchObject({
      type: 'hrv',
      value: 48,
      unit: 'ms',
      external_id: 'garmin:hrv:2026-11-10',
    });
    expect(m.biometrics[0]!.meta).toEqual({ peak: 91, weeklyAvg: 50, status: 'BALANCED' });
    expect(mapHrv({ calendarDate: '2026-11-10' }).notes).toEqual(['hrv: no lastNightAvg']);
  });
});

describe('garmin-push: dispatcher and helpers', () => {
  it('routes by kind, returns nothing for unknown kinds and never throws', () => {
    expect(mapPushItem('dailies', { calendarDate: '2026-11-10', steps: 5 }).energy).toHaveLength(1);
    expect(hasRows(mapPushItem('userMetrics', { calendarDate: '2026-11-10', vo2Max: 50 }))).toBe(
      false,
    );
    const hostile = {
      calendarDate: '2026-11-10',
      get steps(): number {
        throw new Error('boom');
      },
    };
    expect(mapPushItem('dailies', hostile).notes).toEqual(['dailies: mapping failed']);
  });

  it('merges mappings and detects empty ones', () => {
    const a = mapDailies({ calendarDate: '2026-11-10', steps: 5 });
    const b = mapActivity({ summaryId: 's', startTimeInSeconds: DAY, durationInSeconds: 600 });
    const merged = mergeMapped([a, b, emptyMapped()]);
    expect(merged.energy).toHaveLength(1);
    expect(merged.exercises).toHaveLength(1);
    expect(hasRows(emptyMapped())).toBe(false);
  });

  it('uses exactly the units of the pull mapper', () => {
    expect(BIOMETRIC_UNITS).toEqual({
      weight: 'kg',
      body_fat: 'percent',
      resting_heart_rate: 'bpm',
      hrv: 'ms',
      spo2: 'percent',
      respiration_rate: 'brpm',
      sleep: 'hr',
      body_battery: 'percent',
      stress: 'score',
    });
  });
});

describe('garmin-push: trimPayload (keeps the raw buffer small)', () => {
  it('keeps small payloads intact', () => {
    const small = { userId: 'u', steps: 10, nested: { a: [1, 2, 3] } };
    expect(trimPayload(small)).toEqual(small);
  });

  it('shrinks big sample maps and arrays but keeps their size and a few samples', () => {
    const samples = Object.fromEntries(
      Array.from({ length: 5760 }, (_, i) => [String(i * 15), 60 + (i % 40)]),
    );
    const trimmed = trimPayload({
      steps: 10,
      timeOffsetHeartRateSamples: samples,
      laps: Array.from({ length: 100 }, (_, i) => i),
    }) as Record<string, unknown>;
    expect(trimmed.steps).toBe(10);
    expect(trimmed.timeOffsetHeartRateSamples).toEqual({
      _trimmed: 'object',
      entries: 5760,
      sample: { '0': 60, '15': 61, '30': 62 },
    });
    expect(trimmed.laps).toEqual({ _trimmed: 'array', length: 100, sample: [0, 1, 2] });
    expect(JSON.stringify(trimmed).length).toBeLessThan(500);
  });

  it('shortens long strings, limits depth, and never mutates its input', () => {
    const input = { text: 'x'.repeat(1000), deep: { a: { b: { c: { d: { e: { f: 1 } } } } } } };
    const copy = JSON.parse(JSON.stringify(input));
    const out = trimPayload(input) as { text: string; deep: unknown };
    expect(out.text.length).toBe(301);
    expect(JSON.stringify(out.deep)).toContain('_trimmed');
    expect(input).toEqual(copy);
  });

  it('falls back to the key list when a payload is still huge', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`k${i}`, 'y'.repeat(300)]),
    );
    const out = trimPayload(wide, { maxChars: 1000 }) as Record<string, unknown>;
    expect(out._trimmed).toBe('payload');
    expect(out.keys).toHaveLength(20);
  });
});
