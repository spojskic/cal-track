import { describe, expect, it } from 'vitest';
import { eachDate } from './dates';
import { GarminError } from './errors';
import { fetchGarminData, type GarminSyncInclude, type GarminSyncProgress } from './sync';
import { createFakeClient } from './test-utils';

type Route = Parameters<typeof createFakeClient>[0][number];

const ALL: GarminSyncInclude = {
  energy: true, workouts: true, weight: true, bodyFat: true, restingHr: true, hrv: true, spo2: true, respiration: true, sleep: true, bodyBattery: true, stress: true,
};
const FROM = '2026-11-03';
const TO = '2026-11-09';

const P = {
  summaries: '/usersummary-service/v2/dailysummaries',
  sleep: '/sleep-service/sleep/dailySleepSummariesByDate',
  hrv: /^\/hrv-service\/hrv\/daily\//,
  weight: /^\/weight-service\/weight\/all\//,
  weightRange: /^\/weight-service\/weight\/range\//,
  activities: '/activitylist-service/activities/search/activities',
  bodyBattery: '/wellness-service/wellness/bodyBattery/reports/daily',
  stress: /^\/usersummary-service\/stats\/stress\/daily\//,
  steps: /^\/usersummary-service\/stats\/steps\/daily\//,
  hr: '/wellness-service/wellness/dailyHeartRate',
  spo2: /^\/wellness-service\/wellness\/daily\/spo2acclimation\//,
};

const summaryItem = (date: string, over: Record<string, unknown> = {}) => ({
  calendarDate: date, totalKilocalories: 2600, activeKilocalories: 560, bmrKilocalories: 2040, totalSteps: 8000,
  restingHeartRate: 52, averageStressLevel: 30, bodyBatteryHighestValue: 85, bodyBatteryLowestValue: 12,
  avgWakingRespirationValue: 14, averageSpo2: 95, ...over,
});
const sleepItem = (date: string) => ({ calendarDate: date, sleepTimeSeconds: 27000, deepSleepSeconds: 5400, lightSleepSeconds: 14400, remSleepSeconds: 5400, awakeSleepSeconds: 1800, averageSpO2Value: 93, averageRespirationValue: 13 });
const pathDates = (path: string): [string, string] => {
  const m = /(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(path)!;
  return [m[1]!, m[2]!];
};

function baseRoutes(): Route[] {
  return [
    [P.summaries, (c) => ({ data: eachDate(String(c.params!.startDate), String(c.params!.endDate)).map((d) => summaryItem(d)) })],
    [P.sleep, (c) => eachDate(String(c.params!.startDate), String(c.params!.endDate)).map(sleepItem)],
    [P.hrv, (c) => ({ hrvSummaries: eachDate(...pathDates(c.path)).map((d) => ({ calendarDate: d, lastNightAvg: 60, weeklyAvg: 58, status: 'BALANCED' })) })],
    [P.weight, (c) => eachDate(...pathDates(c.path)).filter((_, i) => i % 3 === 0).map((d) => ({ calendarDate: d, weight: 72500, bodyFat: 18.5, timestampGMT: Date.parse(`${d}T06:00:00Z`) }))],
    [P.activities, (c) => (c.params!.start === 0 ? [{ activityId: 1, activityName: 'Run', startTimeGMT: '2026-11-05 06:00:00', activityType: { typeKey: 'running' }, duration: 1800, calories: 300, distance: 5000 }] : [])],
  ];
}
const make = (...over: Route[]) => createFakeClient([...over, ...baseRoutes()]);
const count = (c: { paths(): string[] }, p: string | RegExp): number => c.paths().filter((x) => (typeof p === 'string' ? x === p : p.test(x))).length;

describe('request planning', () => {
  it('fetches everything with the minimum number of calls (one per endpoint for 7 days)', async () => {
    const c = make();
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: ALL });
    expect(c.paths()).toEqual([
      P.summaries,
      P.sleep,
      '/hrv-service/hrv/daily/2026-11-03/2026-11-09',
      '/weight-service/weight/all/2026-11-03/2026-11-09',
      P.activities,
    ]);
    expect(r.requestCount).toBe(5);
    expect(r.errors).toEqual([]);
    expect(r.energy).toHaveLength(7);
    expect(r.energy[0]).toEqual({ date: '2026-11-03', activeKcal: 560, restingKcal: 2040, totalKcal: 2600, steps: 8000 });
    const n = (t: string) => r.biometrics.filter((b) => b.type === t).length;
    expect(['resting_heart_rate', 'stress', 'body_battery', 'respiration_rate', 'spo2', 'sleep', 'hrv'].map(n)).toEqual([7, 7, 7, 7, 7, 7, 7]);
    expect(n('weight')).toBe(3);
    expect(n('body_fat')).toBe(3);
    expect(r.workouts).toHaveLength(1);
    expect(r.workouts[0]).toMatchObject({ externalId: 'garmin:activity:1', typeKey: 'running', kcal: 300 });
  });
  it('issues the right query parameters', async () => {
    const c = make();
    await fetchGarminData(c, { from: FROM, to: TO, include: ALL });
    expect(c.calls[0]!.params).toEqual({ startDate: FROM, endDate: TO });
    expect(c.calls[1]!.params).toEqual({ startDate: FROM, endDate: TO });
    expect(c.calls[4]!.params).toEqual({ start: 0, limit: 100, startDate: FROM, endDate: TO });
  });
  it('only energy: a single daily-summaries call', async () => {
    const c = make();
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: { energy: true } });
    expect(c.paths()).toEqual([P.summaries]);
    expect(r.energy).toHaveLength(7);
    expect(r.biometrics).toEqual([]);
  });
  it('summary-backed types share one call', async () => {
    const c = make();
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: { restingHr: true, spo2: true, respiration: true, stress: true, bodyBattery: true } });
    expect(c.paths()).toEqual([P.summaries]);
    expect(r.energy).toEqual([]);
    expect(new Set(r.biometrics.map((b) => b.type))).toEqual(new Set(['resting_heart_rate', 'spo2', 'respiration_rate', 'stress', 'body_battery']));
  });
  it('nothing included -> no requests', async () => {
    const c = make();
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: {} });
    expect(c.calls).toHaveLength(0);
    expect(r).toMatchObject({ energy: [], workouts: [], biometrics: [], diagnostics: [], errors: [], requestCount: 0 });
  });
  it('each include flag maps to exactly its endpoint', async () => {
    const cases: Array<[keyof GarminSyncInclude, string | RegExp]> = [['sleep', P.sleep], ['hrv', P.hrv], ['weight', P.weight], ['bodyFat', P.weight], ['workouts', P.activities]];
    for (const [flag, path] of cases) {
      const c = make();
      await fetchGarminData(c, { from: FROM, to: TO, include: { [flag]: true } });
      expect(c.calls).toHaveLength(1);
      expect(count(c, path)).toBe(1);
    }
  });
  it('chunks long ranges by each endpoint limit (90 days)', async () => {
    const c = make();
    const r = await fetchGarminData(c, { from: '2026-08-12', to: '2026-11-09', include: ALL });
    expect(count(c, P.summaries)).toBe(1);
    expect(count(c, P.sleep)).toBe(3);
    expect(count(c, P.hrv)).toBe(4);
    expect(count(c, P.weight)).toBe(3);
    expect(count(c, P.activities)).toBe(1);
    expect(r.requestCount).toBe(12);
    expect(r.energy).toHaveLength(90);
    expect(r.biometrics.filter((b) => b.type === 'sleep')).toHaveLength(90);
    expect(r.biometrics.filter((b) => b.type === 'hrv')).toHaveLength(90);
  });
  it('splits daily summaries above one year', async () => {
    const c = make();
    const r = await fetchGarminData(c, { from: '2025-10-01', to: '2026-11-04', include: { energy: true } });
    expect(count(c, P.summaries)).toBe(2);
    expect(r.energy).toHaveLength(400);
  });
  it('paginates workouts', async () => {
    const page = (start: number, n: number) => Array.from({ length: n }, (_, i) => ({ activityId: start + i, startTimeGMT: '2026-11-05 06:00:00', duration: 600 }));
    const c = make([P.activities, (call) => page(Number(call.params!.start), call.params!.start === 200 ? 50 : 100)]);
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: { workouts: true } });
    expect(count(c, P.activities)).toBe(3);
    expect(r.workouts).toHaveLength(250);
    expect(r.requestCount).toBe(3);
  });
  it('rejects from > to and invalid dates without any request', async () => {
    const c = make();
    await expect(fetchGarminData(c, { from: TO, to: FROM, include: ALL })).rejects.toMatchObject({ kind: 'bad_request' });
    await expect(fetchGarminData(c, { from: 'x', to: TO, include: ALL })).rejects.toBeInstanceOf(GarminError);
    expect(c.calls).toHaveLength(0);
  });
  it('a one-day range works', async () => {
    const c = make();
    const r = await fetchGarminData(c, { from: TO, to: TO, include: { energy: true, sleep: true } });
    expect(r.energy).toHaveLength(1);
    expect(c.calls).toHaveLength(2);
  });
});

describe('output', () => {
  it('is sorted and de-duplicated', async () => {
    const c = make(
      [P.summaries, () => ({ data: [summaryItem('2026-11-05'), summaryItem('2026-11-03'), summaryItem('2026-11-05', { totalSteps: 9999 })] })],
    );
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: { energy: true, restingHr: true } });
    expect(r.energy.map((e) => e.date)).toEqual(['2026-11-03', '2026-11-05']);
    expect(r.energy[1]!.steps).toBe(9999);
    expect(r.biometrics.map((b) => b.date)).toEqual(['2026-11-03', '2026-11-05']);
  });
  it('merges diagnostics across chunks (counts add up)', async () => {
    const c = make([P.summaries, (call) => ({ data: eachDate(String(call.params!.startDate), String(call.params!.endDate)).map((d) => ({ calendarDate: d, totalSteps: 1 })) })]);
    const r = await fetchGarminData(c, { from: '2025-10-01', to: '2026-11-04', include: { energy: true } });
    const d = r.diagnostics.find((x) => x.field === 'activeKcal' && x.reason === 'missing')!;
    expect(d.count).toBe(400);
    expect(d.of).toBe(400);
    expect(r.coverage.find((x) => x.field === 'steps')).toMatchObject({ total: 400, found: 400 });
  });
  it('never lets diagnostics from disabled groups leak in', async () => {
    const c = make([P.summaries, () => ({ data: [{ calendarDate: FROM }] })]);
    const r = await fetchGarminData(c, { from: FROM, to: FROM, include: { stress: true } });
    expect(r.diagnostics.map((d) => d.field).filter((f) => f !== 'date')).toEqual(['stress']);
  });
});

describe('errors', () => {
  it('collects a failing chunk and keeps the rest', async () => {
    const c = make([P.sleep, (call) => (call.params!.startDate === '2026-09-12' ? new GarminError({ kind: 'server', status: 503 }) : eachDate(String(call.params!.startDate), String(call.params!.endDate)).map(sleepItem))]);
    const r = await fetchGarminData(c, { from: '2026-08-12', to: '2026-11-09', include: { sleep: true, energy: true } });
    expect(r.errors).toEqual([{ endpoint: 'sleep', start: '2026-09-12', end: '2026-10-12', kind: 'server', status: 503, retryable: true, message: expect.any(String) }]);
    expect(r.biometrics.filter((b) => b.type === 'sleep')).toHaveLength(90 - 31);
    expect(r.energy).toHaveLength(90);
  });
  it('a 403 (missing scope) on one endpoint is collected, the sync goes on', async () => {
    const c = make([P.hrv, () => new GarminError({ kind: 'unauthorized', status: 403 })]);
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: { hrv: true, sleep: true, energy: true } });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ endpoint: 'hrv', kind: 'unauthorized', status: 403 });
    expect(r.energy).toHaveLength(7);
    expect(r.biometrics.some((b) => b.type === 'sleep')).toBe(true);
  });
  it('a bad key aborts immediately', async () => {
    const err = new GarminError({ kind: 'invalid_key', status: 401 });
    const c = make([P.summaries, () => err]);
    await expect(fetchGarminData(c, { from: FROM, to: TO, include: ALL })).rejects.toBe(err);
    expect(c.calls).toHaveLength(1);
  });
  it('a persistent 401 on a later endpoint aborts the rest', async () => {
    const err = new GarminError({ kind: 'unauthorized', status: 401 });
    const c = make([P.sleep, () => err]);
    await expect(fetchGarminData(c, { from: FROM, to: TO, include: ALL })).rejects.toBe(err);
    expect(c.paths()).toEqual([P.summaries, P.sleep]);
  });
  it('expired/revoked keys abort', async () => {
    const c = make([P.activities, () => new GarminError({ kind: 'key_expired_or_revoked' })]);
    await expect(fetchGarminData(c, { from: FROM, to: TO, include: ALL })).rejects.toMatchObject({ kind: 'key_expired_or_revoked' });
  });
  it('network and rate-limit failures are collected, not fatal', async () => {
    const c = make([P.summaries, () => new GarminError({ kind: 'network' })], [P.sleep, () => new GarminError({ kind: 'rate_limited', status: 429, retryAfterSeconds: 30 })]);
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: { energy: true, sleep: true, hrv: true }, fallbacks: { rangedEndpoints: false } });
    expect(r.errors.map((e) => e.kind).sort()).toEqual(['network', 'rate_limited']);
    expect(r.biometrics.filter((b) => b.type === 'hrv')).toHaveLength(7);
  });
  it('unexpected exceptions from the client are collected as unexpected errors', async () => {
    const c = make([P.hrv, () => new TypeError('bug in transport')]);
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: { hrv: true } });
    expect(r.errors[0]).toMatchObject({ endpoint: 'hrv', kind: 'unexpected' });
  });
});

describe('fallbacks', () => {
  const noBodyBattery = (date: string) => summaryItem(date, { bodyBatteryHighestValue: undefined, bodyBatteryLowestValue: undefined });
  const summariesWithout = (fields: string[]): Route => [
    P.summaries,
    (c) => ({
      data: eachDate(String(c.params!.startDate), String(c.params!.endDate)).map((d) => {
        const item: Record<string, unknown> = summaryItem(d);
        for (const f of fields) delete item[f];
        return item;
      }),
    }),
  ];
  const bbReport = (c: { params?: Record<string, unknown> }) =>
    eachDate(String(c.params!.startDate), String(c.params!.endDate)).map((d) => ({ date: d, charged: 50, drained: 60, bodyBatteryValuesArray: [[1, 'M', 20, 2], [2, 'M', 90, 2]], bodyBatteryValueDescriptorDTOList: [{ bodyBatteryValueDescriptorIndex: 2, bodyBatteryValueDescriptorKey: 'bodyBatteryLevel' }] }));

  it('does NOT call fallback endpoints when the summaries are complete', async () => {
    const c = make();
    await fetchGarminData(c, { from: FROM, to: TO, include: ALL, fallbacks: { perDayEndpoints: true } });
    for (const p of [P.bodyBattery, P.stress, P.steps, P.hr, P.spo2]) expect(count(c, p)).toBe(0);
  });
  it('body battery comes from the ranged report when the summaries lack it', async () => {
    const c = make(summariesWithout(['bodyBatteryHighestValue', 'bodyBatteryLowestValue']), [P.bodyBattery, bbReport]);
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: { bodyBattery: true } });
    expect(c.paths()).toEqual([P.summaries, P.bodyBattery]);
    expect(c.calls[1]!.params).toEqual({ startDate: FROM, endDate: TO });
    expect(r.biometrics.filter((b) => b.type === 'body_battery')).toHaveLength(7);
    expect(r.biometrics[0]!.value).toBe(90);
    expect(r.requestCount).toBe(2);
  });
  it('stress comes from the stats endpoint when missing', async () => {
    const c = make(summariesWithout(['averageStressLevel']), [P.stress, (call) => eachDate(...pathDates(call.path)).map((d) => ({ calendarDate: d, values: { overallStressLevel: 33 } }))]);
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: { stress: true } });
    expect(c.paths()).toEqual([P.summaries, '/usersummary-service/stats/stress/daily/2026-11-03/2026-11-09']);
    expect(r.biometrics.filter((b) => b.type === 'stress')).toHaveLength(7);
  });
  it('steps come from the stats endpoint when missing, merged into the same energy rows', async () => {
    const c = make(summariesWithout(['totalSteps']), [P.steps, (call) => eachDate(...pathDates(call.path)).map((d) => ({ calendarDate: d, totalSteps: 7000 }))]);
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: { energy: true } });
    expect(count(c, P.steps)).toBe(1);
    expect(r.energy).toHaveLength(7);
    expect(r.energy[0]).toEqual({ date: '2026-11-03', activeKcal: 560, restingKcal: 2040, totalKcal: 2600, steps: 7000 });
  });
  it('ranged fallbacks can be disabled', async () => {
    const c = make(summariesWithout(['bodyBatteryHighestValue']));
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: { bodyBattery: true }, fallbacks: { rangedEndpoints: false } });
    expect(c.paths()).toEqual([P.summaries]);
    expect(r.diagnostics.some((d) => d.field === 'bodyBatteryHigh' && d.reason === 'missing')).toBe(true);
  });
  it('fallback chunking follows the fallback endpoint limit and skips chunks with no missing dates', async () => {
    // 60 days, body battery missing only for the first and the last 3 days -> chunks of 31: [1..31] and [32..60]
    const dates = eachDate('2026-09-11', '2026-11-09');
    const c = make(
      [P.summaries, () => ({ data: dates.map((d, i) => (i < 3 || i >= 57 ? noBodyBattery(d) : summaryItem(d))) })],
      [P.bodyBattery, bbReport],
    );
    await fetchGarminData(c, { from: '2026-09-11', to: '2026-11-09', include: { bodyBattery: true } });
    expect(count(c, P.bodyBattery)).toBe(2);
    // missing only at the very start -> one fallback request
    const c2 = make([P.summaries, () => ({ data: dates.map((d, i) => (i < 3 ? noBodyBattery(d) : summaryItem(d))) })], [P.bodyBattery, bbReport]);
    await fetchGarminData(c2, { from: '2026-09-11', to: '2026-11-09', include: { bodyBattery: true } });
    expect(count(c2, P.bodyBattery)).toBe(1);
    expect(c2.calls[1]!.params).toEqual({ startDate: '2026-09-11', endDate: '2026-09-13' }); // only the span with missing days
  });
  it('per-day fallbacks are off by default', async () => {
    const c = make(summariesWithout(['restingHeartRate', 'averageSpo2']));
    await fetchGarminData(c, { from: FROM, to: TO, include: { restingHr: true, spo2: true } });
    expect(c.paths()).toEqual([P.summaries]);
  });
  it('per-day fallbacks fetch only the dates that lack the field, when enabled', async () => {
    const dates = eachDate(FROM, TO);
    const c = make(
      [P.summaries, () => ({ data: dates.map((d, i) => summaryItem(d, i % 2 === 0 ? { restingHeartRate: undefined } : {})) })],
      [P.hr, (call) => ({ calendarDate: call.params!.date, restingHeartRate: 49 })],
    );
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: { restingHr: true }, fallbacks: { perDayEndpoints: true } });
    expect(count(c, P.hr)).toBe(4);
    expect(c.calls.filter((x) => x.path === P.hr).map((x) => x.params!.date)).toEqual(['2026-11-03', '2026-11-05', '2026-11-07', '2026-11-09']);
    const rhr = r.biometrics.filter((b) => b.type === 'resting_heart_rate');
    expect(rhr).toHaveLength(7);
    expect(rhr.find((b) => b.date === '2026-11-03')!.value).toBe(49);
    expect(rhr.find((b) => b.date === '2026-11-04')!.value).toBe(52);
  });
  it('caps per-day fallbacks', async () => {
    const c = make(summariesWithout(['restingHeartRate']), [P.hr, (call) => ({ calendarDate: call.params!.date, restingHeartRate: 49 })]);
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: { restingHr: true }, fallbacks: { perDayEndpoints: true, maxPerDayRequests: 3 } });
    expect(count(c, P.hr)).toBe(3);
    expect(r.biometrics.filter((b) => b.type === 'resting_heart_rate')).toHaveLength(3);
    const none = make(summariesWithout(['restingHeartRate']));
    await fetchGarminData(none, { from: FROM, to: TO, include: { restingHr: true }, fallbacks: { perDayEndpoints: true, maxPerDayRequests: 0 } });
    expect(count(none, P.hr)).toBe(0);
  });
  it('SpO2 per-day fallback uses the spo2 endpoint', async () => {
    const c = make(summariesWithout(['averageSpo2']), [P.spo2, (call) => ({ calendarDate: call.path.split('/').pop(), averageSpO2: 94 })]);
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: { spo2: true }, fallbacks: { perDayEndpoints: true } });
    expect(count(c, P.spo2)).toBe(7);
    expect(r.biometrics.filter((b) => b.type === 'spo2').every((b) => b.value === 94)).toBe(true);
  });
  it('night-time SpO2 and respiration from the sleep response fill gaps for free (flagged)', async () => {
    const c = make(summariesWithout(['averageSpo2', 'avgWakingRespirationValue']));
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: { spo2: true, respiration: true, sleep: true }, fallbacks: { perDayEndpoints: true } });
    expect(c.paths()).toEqual([P.summaries, P.sleep]);
    const spo2 = r.biometrics.filter((b) => b.type === 'spo2');
    expect(spo2).toHaveLength(7);
    expect(spo2[0]).toMatchObject({ value: 93, meta: { source: 'sleep' }, externalId: 'garmin:spo2:2026-11-03' });
    expect(r.biometrics.filter((b) => b.type === 'respiration_rate')).toHaveLength(7);
    expect(r.diagnostics.some((d) => d.endpoint === 'sleep' && d.field === 'spo2' && d.reason === 'fallback_used' && d.count === 7)).toBe(true);
  });
  it('the sleep fallback does not override real daily values', async () => {
    const c = make();
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: { spo2: true, sleep: true } });
    expect(r.biometrics.filter((b) => b.type === 'spo2').every((b) => b.value === 95 && !b.meta)).toBe(true);
  });
  it('dates the summaries do not mention are not chased', async () => {
    const dates = eachDate(FROM, TO);
    const c = make([P.summaries, () => ({ data: dates.slice(0, 3).map((d) => summaryItem(d, { restingHeartRate: undefined })) })], [P.hr, (call) => ({ calendarDate: call.params!.date, restingHeartRate: 50 })]);
    await fetchGarminData(c, { from: FROM, to: TO, include: { restingHr: true }, fallbacks: { perDayEndpoints: true } });
    expect(count(c, P.hr)).toBe(3);
  });
  it('an empty (204) summary response triggers no fallbacks', async () => {
    const c = make([P.summaries, () => null]);
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: ALL, fallbacks: { perDayEndpoints: true } });
    for (const p of [P.bodyBattery, P.stress, P.steps, P.hr, P.spo2]) expect(count(c, p)).toBe(0);
    expect(r.energy).toEqual([]);
  });
  it('a failed summaries chunk is retried through the ranged fallbacks', async () => {
    const c = make([P.summaries, () => new GarminError({ kind: 'server', status: 500 })], [P.bodyBattery, bbReport], [P.stress, (call) => eachDate(...pathDates(call.path)).map((d) => ({ calendarDate: d, overallStressLevel: 40 }))]);
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: { bodyBattery: true, stress: true } });
    expect(r.errors).toHaveLength(1);
    expect(count(c, P.bodyBattery)).toBe(1);
    expect(count(c, P.stress)).toBe(1);
    expect(r.biometrics.filter((b) => b.type === 'body_battery')).toHaveLength(7);
    expect(r.biometrics.filter((b) => b.type === 'stress')).toHaveLength(7);
  });
  it('a failing fallback is collected too', async () => {
    const c = make(summariesWithout(['bodyBatteryHighestValue']), [P.bodyBattery, () => new GarminError({ kind: 'server', status: 502 })]);
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: { bodyBattery: true } });
    expect(r.errors).toEqual([expect.objectContaining({ endpoint: 'bodyBattery', kind: 'server' })]);
  });
});

describe('weight', () => {
  it('bodyFat only: no weight rows', async () => {
    const c = make();
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: { bodyFat: true } });
    expect(r.biometrics.every((b) => b.type === 'body_fat')).toBe(true);
    expect(r.biometrics).toHaveLength(3);
  });
  it('weight only: no body fat rows', async () => {
    const c = make();
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: { weight: true } });
    expect(r.biometrics.every((b) => b.type === 'weight' && b.unit === 'kg' && b.value === 72.5)).toBe(true);
  });
  it('falls back to weight/range when weight/all fails with a 4xx', async () => {
    const c = make(
      [P.weight, () => new GarminError({ kind: 'bad_request', status: 404 })],
      [P.weightRange, (call) => ({ dailyWeightSummaries: [{ summaryDate: pathDates(call.path)[0], allWeightMetrics: [{ calendarDate: pathDates(call.path)[0], weight: 80000, timestampGMT: 1_790_000_000_000 }] }] })],
    );
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: { weight: true } });
    expect(c.calls[1]!.params).toEqual({ includeAll: true });
    expect(r.biometrics).toHaveLength(1);
    expect(r.biometrics[0]!.value).toBe(80);
    expect(r.errors).toHaveLength(1); // the original failure stays visible
    expect(r.diagnostics.some((d) => d.endpoint === 'weight' && d.reason === 'fallback_used')).toBe(true);
  });
  it('falls back to weight/range when weight/all returns an unrecognisable shape', async () => {
    const c = make([P.weight, () => ({ foo: 'bar' })], [P.weightRange, () => ({ dateWeightList: [{ calendarDate: '2026-11-04', weight: 70100 }] })]);
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: { weight: true } });
    expect(count(c, P.weightRange)).toBe(1);
    expect(r.biometrics.map((b) => b.value)).toEqual([70.1]);
  });
  it('does not call weight/range when ranged fallbacks are off', async () => {
    const c = make([P.weight, () => new GarminError({ kind: 'bad_request', status: 404 })]);
    await fetchGarminData(c, { from: FROM, to: TO, include: { weight: true }, fallbacks: { rangedEndpoints: false } });
    expect(count(c, P.weightRange)).toBe(0);
  });
  it('an empty weight response is simply empty', async () => {
    const c = make([P.weight, () => []]);
    const r = await fetchGarminData(c, { from: FROM, to: TO, include: { weight: true } });
    expect(r.biometrics).toEqual([]);
    expect(count(c, P.weightRange)).toBe(0);
  });
});

describe('progress', () => {
  it('reports every request with a monotonically growing counter', async () => {
    const c = make();
    const events: GarminSyncProgress[] = [];
    const r = await fetchGarminData(c, { from: '2026-08-12', to: '2026-11-09', include: ALL, onProgress: (p) => events.push(p) });
    expect(events).toHaveLength(r.requestCount);
    expect(events.map((e) => e.completedRequests)).toEqual(events.map((_, i) => i + 1));
    expect(events.every((e) => e.plannedRequests >= e.completedRequests)).toBe(true);
    expect(events[events.length - 1]!.plannedRequests).toBe(12);
    expect(events[0]).toMatchObject({ endpoint: 'dailySummaries', completedRequests: 1 });
  });
  it('planned requests grow when fallbacks are scheduled', async () => {
    const c = make(
      [P.summaries, (call) => ({ data: eachDate(String(call.params!.startDate), String(call.params!.endDate)).map((d) => summaryItem(d, { bodyBatteryHighestValue: undefined })) })],
    );
    const events: GarminSyncProgress[] = [];
    await fetchGarminData(c, { from: FROM, to: TO, include: { bodyBattery: true }, onProgress: (p) => events.push(p) });
    expect(events[0]!.plannedRequests).toBe(1);
    expect(events[events.length - 1]!.plannedRequests).toBe(2);
  });
});
