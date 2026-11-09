import { describe, expect, it } from 'vitest';
import { MAX_DAYS, PATHS } from './constants';
import { diffDays } from './dates';
import {
  ENDPOINT_IDS,
  fetchEndpointRange,
  GARMIN_ENDPOINTS,
  getActivities,
  getBodyBattery,
  getDailySummaries,
  getHeartRateDay,
  getHrvRange,
  getSleepSummaries,
  getSpo2Day,
  getStepsDaily,
  getUserSettings,
  getWeightAll,
  getWeightRange,
  isEndpointId,
  planChunks,
  toSyncError,
} from './endpoints';
import { GarminError } from './errors';
import { createFakeClient } from './test-utils';
import { fetchActivitiesRange, fetchRange, fetchSleepRange, fetchStepsRange } from './endpoints';

describe('registry', () => {
  it('has a spec for every id with consistent fields', () => {
    for (const id of ENDPOINT_IDS) {
      const spec = GARMIN_ENDPOINTS[id];
      expect(spec.id).toBe(id);
      expect(spec.title.length).toBeGreaterThan(3);
      const req = spec.request({ start: '2026-11-01', end: '2026-11-07' });
      expect(req.path.startsWith('/')).toBe(true);
      if (spec.kind === 'range') expect(spec.maxDays).toBeGreaterThan(0);
    }
    expect(isEndpointId('sleep')).toBe(true);
    expect(isEndpointId('nope')).toBe(false);
  });
  it('limits match the documented table', () => {
    expect(MAX_DAYS).toMatchObject({ dailySummaries: 365, sleep: 31, bodyBattery: 31, steps: 28, stress: 28, hydration: 31 });
    expect(GARMIN_ENDPOINTS.sleep.maxDays).toBe(31);
    expect(GARMIN_ENDPOINTS.steps.maxDays).toBe(28);
    expect(GARMIN_ENDPOINTS.stress.maxDays).toBe(28);
    expect(GARMIN_ENDPOINTS.hydration.maxDays).toBe(31);
    expect(GARMIN_ENDPOINTS.bodyBattery.maxDays).toBe(31);
    expect(GARMIN_ENDPOINTS.dailySummaries.maxDays).toBe(365);
  });
  it('builds the documented paths and params', () => {
    const c = { start: '2026-11-01', end: '2026-11-07' };
    expect(GARMIN_ENDPOINTS.dailySummaries.request(c)).toEqual({ path: '/usersummary-service/v2/dailysummaries', params: { startDate: '2026-11-01', endDate: '2026-11-07' } });
    expect(GARMIN_ENDPOINTS.sleep.request(c)).toEqual({ path: '/sleep-service/sleep/dailySleepSummariesByDate', params: { startDate: '2026-11-01', endDate: '2026-11-07' } });
    expect(GARMIN_ENDPOINTS.sleepDay.request({ start: '2026-11-01', end: '2026-11-01' })).toEqual({ path: '/sleep-service/sleep/dailySleep', params: { date: '2026-11-01' } });
    expect(GARMIN_ENDPOINTS.hrv.request(c).path).toBe('/hrv-service/hrv/daily/2026-11-01/2026-11-07');
    expect(GARMIN_ENDPOINTS.hrvDay.request({ start: '2026-11-03', end: '2026-11-03' }).path).toBe('/hrv-service/hrv/2026-11-03');
    expect(GARMIN_ENDPOINTS.weight.request(c).path).toBe('/weight-service/weight/all/2026-11-01/2026-11-07');
    expect(GARMIN_ENDPOINTS.weightRange.request(c)).toEqual({ path: '/weight-service/weight/range/2026-11-01/2026-11-07', params: { includeAll: true } });
    expect(GARMIN_ENDPOINTS.bodyBattery.request(c).path).toBe('/wellness-service/wellness/bodyBattery/reports/daily');
    expect(GARMIN_ENDPOINTS.heartRateDay.request({ start: '2026-11-03', end: '2026-11-03' })).toEqual({ path: '/wellness-service/wellness/dailyHeartRate', params: { date: '2026-11-03' } });
    expect(GARMIN_ENDPOINTS.spo2Day.request({ start: '2026-11-03', end: '2026-11-03' }).path).toBe('/wellness-service/wellness/daily/spo2acclimation/2026-11-03');
    expect(GARMIN_ENDPOINTS.steps.request(c).path).toBe('/usersummary-service/stats/steps/daily/2026-11-01/2026-11-07');
    expect(GARMIN_ENDPOINTS.stress.request(c).path).toBe('/usersummary-service/stats/stress/daily/2026-11-01/2026-11-07');
    expect(GARMIN_ENDPOINTS.hydration.request(c).path).toBe('/usersummary-service/stats/hydration/daily/2026-11-01/2026-11-07');
    expect(GARMIN_ENDPOINTS.wellnessActivities.request(c).path).toBe('/wellnessactivity-service/activity/summary/range/2026-11-01/2026-11-07');
    expect(GARMIN_ENDPOINTS.activities.request(c, { start: 200, limit: 100 })).toEqual({
      path: '/activitylist-service/activities/search/activities',
      params: { start: 200, limit: 100, startDate: '2026-11-01', endDate: '2026-11-07' },
    });
  });
  it('mappers are attached where a normalized shape exists', () => {
    for (const id of ['dailySummaries', 'sleep', 'sleepDay', 'hrv', 'hrvDay', 'weight', 'weightRange', 'bodyBattery', 'heartRateDay', 'spo2Day', 'steps', 'stress', 'activities'] as const) {
      const m = GARMIN_ENDPOINTS[id].map!(null, { date: '2026-11-01' });
      expect(m.diagnostics).toEqual([]);
    }
    expect(GARMIN_ENDPOINTS.hydration.map).toBeUndefined();
    expect(GARMIN_ENDPOINTS.userSettings.map).toBeUndefined();
  });
  it('map() passes the requested date to single-day mappers', () => {
    const m = GARMIN_ENDPOINTS.heartRateDay.map!({ restingHeartRate: 50 }, { date: '2026-11-04' });
    expect(m.biometrics?.[0]?.date).toBe('2026-11-04');
  });
});

describe('typed wrappers', () => {
  it('call the right path with the right params', async () => {
    const c = createFakeClient([]);
    await getUserSettings(c);
    await getDailySummaries(c, '2026-11-01', '2026-11-07');
    await getSleepSummaries(c, '2026-11-01', '2026-11-07');
    await getHrvRange(c, '2026-11-01', '2026-11-07');
    await getWeightAll(c, '2026-11-01', '2026-11-07');
    await getWeightRange(c, '2026-11-01', '2026-11-07');
    await getBodyBattery(c, '2026-11-01', '2026-11-07');
    await getHeartRateDay(c, '2026-11-01');
    await getSpo2Day(c, '2026-11-01');
    await getStepsDaily(c, '2026-11-01', '2026-11-07');
    await getActivities(c, { start: 0, limit: 100, startDate: '2026-11-01', endDate: '2026-11-07' });
    expect(c.calls.map((x) => x.path)).toEqual([
      PATHS.userSettings,
      PATHS.dailySummaries,
      PATHS.sleepRange,
      '/hrv-service/hrv/daily/2026-11-01/2026-11-07',
      '/weight-service/weight/all/2026-11-01/2026-11-07',
      '/weight-service/weight/range/2026-11-01/2026-11-07',
      PATHS.bodyBattery,
      PATHS.heartRateDay,
      '/wellness-service/wellness/daily/spo2acclimation/2026-11-01',
      '/usersummary-service/stats/steps/daily/2026-11-01/2026-11-07',
      PATHS.activities,
    ]);
    expect(c.calls[1]!.params).toEqual({ startDate: '2026-11-01', endDate: '2026-11-07' });
    expect(c.calls[5]!.params).toEqual({ includeAll: true });
  });
});

describe('planChunks / fetchEndpointRange', () => {
  it('chunks by the documented limits', () => {
    expect(planChunks('sleep', '2026-01-01', '2026-03-31')).toHaveLength(3);
    expect(planChunks('steps', '2026-11-01', '2026-11-28')).toHaveLength(1);
    expect(planChunks('steps', '2026-11-01', '2026-11-29')).toHaveLength(2);
    expect(planChunks('dailySummaries', '2025-10-01', '2026-11-04')).toHaveLength(2);
    expect(planChunks('dailySummaries', '2026-01-01', '2026-12-31')).toHaveLength(1);
    expect(planChunks('hydration', '2026-01-01', '2026-02-01')).toHaveLength(2);
    expect(planChunks('heartRateDay', '2026-11-01', '2026-11-05')).toHaveLength(5);
    expect(planChunks('activities', '2026-01-01', '2026-12-31')).toHaveLength(1);
    expect(planChunks('userSettings', '2026-01-01', '2026-12-31')).toHaveLength(1);
  });
  it('requests one call per chunk and returns the raw data', async () => {
    const c = createFakeClient([[/sleepSummaries|dailySleepSummariesByDate/, (call) => [{ calendarDate: String(call.params?.startDate) }]]]);
    const r = await fetchEndpointRange(c, 'sleep', '2026-01-01', '2026-03-31');
    expect(r.requests).toBe(3);
    expect(r.errors).toEqual([]);
    expect(r.chunks.map((x) => [x.start, x.end])).toEqual([['2026-01-01', '2026-01-31'], ['2026-02-01', '2026-03-03'], ['2026-03-04', '2026-03-31']]);
    expect(c.calls.map((x) => x.params)).toEqual([
      { startDate: '2026-01-01', endDate: '2026-01-31' },
      { startDate: '2026-02-01', endDate: '2026-03-03' },
      { startDate: '2026-03-04', endDate: '2026-03-31' },
    ]);
    for (const call of c.calls) expect(diffDays(String(call.params!.startDate), String(call.params!.endDate)) + 1).toBeLessThanOrEqual(31);
  });
  it('keeps null (204) results', async () => {
    const c = createFakeClient([]);
    const r = await fetchEndpointRange(c, 'hrv', '2026-11-01', '2026-11-07');
    expect(r.chunks).toEqual([{ start: '2026-11-01', end: '2026-11-07', raw: null }]);
  });
  it('per-day endpoints make one request per date', async () => {
    const c = createFakeClient([]);
    const r = await fetchEndpointRange(c, 'spo2Day', '2026-11-01', '2026-11-03');
    expect(r.requests).toBe(3);
    expect(c.paths()).toEqual([
      '/wellness-service/wellness/daily/spo2acclimation/2026-11-01',
      '/wellness-service/wellness/daily/spo2acclimation/2026-11-02',
      '/wellness-service/wellness/daily/spo2acclimation/2026-11-03',
    ]);
  });
  it('maxRequests caps per-day fetching', async () => {
    const c = createFakeClient([]);
    const r = await fetchEndpointRange(c, 'heartRateDay', '2026-11-01', '2026-11-30', { maxRequests: 4 });
    expect(r.requests).toBe(4);
  });
  it('paginates activities by 100 until a short page', async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ activityId: i }));
    const c = createFakeClient([[/activities\/search/, (call) => (call.params?.start === 0 ? page(100) : call.params?.start === 100 ? page(100) : page(37))]]);
    const r = await fetchEndpointRange(c, 'activities', '2026-01-01', '2026-11-10');
    expect(r.requests).toBe(3);
    expect(r.chunks.map((x) => x.page)).toEqual([0, 1, 2]);
    expect(c.calls.map((x) => x.params!.start)).toEqual([0, 100, 200]);
    expect(c.calls.every((x) => x.params!.limit === 100 && x.params!.startDate === '2026-01-01' && x.params!.endDate === '2026-11-10')).toBe(true);
  });
  it('stops paginating on an empty / null page and on an error', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ activityId: i }));
    const a = createFakeClient([[/activities/, (call) => (call.params?.start === 0 ? full : null)]]);
    expect((await fetchEndpointRange(a, 'activities', '2026-01-01', '2026-01-31')).requests).toBe(2);
    const b = createFakeClient([[/activities/, (call) => (call.params?.start === 0 ? full : new GarminError({ kind: 'server', status: 500 }))]]);
    const rb = await fetchEndpointRange(b, 'activities', '2026-01-01', '2026-01-31');
    expect(rb.requests).toBe(2);
    expect(rb.chunks).toHaveLength(1);
    expect(rb.errors).toHaveLength(1);
  });
  it('supports an object page ({activityList}) when counting', async () => {
    const c = createFakeClient([[/activities/, () => ({ activityList: Array.from({ length: 100 }, () => ({})) })]]);
    const r = await fetchEndpointRange(c, 'activities', '2026-01-01', '2026-01-31', { pageSize: 100 });
    expect(r.requests).toBeGreaterThan(1);
  });
  it('collects non-auth failures per chunk and continues', async () => {
    const c = createFakeClient([[/dailySleepSummariesByDate/, (call) => (call.params?.startDate === '2026-02-01' ? new GarminError({ kind: 'server', status: 503 }) : [{ calendarDate: 'x' }])]]);
    const r = await fetchEndpointRange(c, 'sleep', '2026-01-01', '2026-03-31');
    expect(r.requests).toBe(3);
    expect(r.chunks).toHaveLength(2);
    expect(r.errors).toEqual([{ endpoint: 'sleep', start: '2026-02-01', end: '2026-03-03', kind: 'server', status: 503, retryable: true, message: expect.stringContaining('Garmin') }]);
  });
  it('collects a 403 (missing scope) instead of aborting', async () => {
    const c = createFakeClient([[/./, () => new GarminError({ kind: 'unauthorized', status: 403 })]]);
    const r = await fetchEndpointRange(c, 'sleep', '2026-01-01', '2026-03-31');
    expect(r.errors).toHaveLength(3);
    expect(r.errors[0]!.message).toContain('permission');
  });
  it('rethrows fatal auth errors', async () => {
    for (const err of [new GarminError({ kind: 'invalid_key' }), new GarminError({ kind: 'key_expired_or_revoked' }), new GarminError({ kind: 'unauthorized', status: 401 })]) {
      const c = createFakeClient([[/./, () => err]]);
      await expect(fetchEndpointRange(c, 'sleep', '2026-01-01', '2026-03-31')).rejects.toBe(err);
      expect(c.calls).toHaveLength(1);
    }
  });
  it('wraps unknown throwables into the error list', async () => {
    const c = createFakeClient([[/./, () => new Error('weird')]]);
    const r = await fetchEndpointRange(c, 'hrv', '2026-11-01', '2026-11-07');
    expect(r.errors[0]).toMatchObject({ kind: 'unexpected', retryable: false });
  });
  it('reports progress after each request', async () => {
    const c = createFakeClient([]);
    const seen: string[] = [];
    await fetchEndpointRange(c, 'steps', '2026-11-01', '2026-12-15', { onRequest: (i) => seen.push(`${i.endpoint}:${i.start}`) });
    expect(seen).toEqual(['steps:2026-11-01', 'steps:2026-11-29']);
  });
  it('toSyncError is serialisable and friendly', () => {
    const e = toSyncError('sleep', new GarminError({ kind: 'rate_limited', status: 429 }), { start: 'a', end: 'b' });
    expect(JSON.parse(JSON.stringify(e))).toEqual({ endpoint: 'sleep', start: 'a', end: 'b', kind: 'rate_limited', status: 429, retryable: true, message: expect.any(String) });
  });
});

describe('fetchRange aliases', () => {
  it('fetchRange is fetchEndpointRange', () => {
    expect(fetchRange).toBe(fetchEndpointRange);
  });
  it('per-endpoint helpers fix the id', async () => {
    const c = createFakeClient([]);
    expect((await fetchSleepRange(c, '2026-01-01', '2026-03-31')).requests).toBe(3);
    expect((await fetchStepsRange(c, '2026-11-01', '2026-11-29')).requests).toBe(2);
    expect((await fetchActivitiesRange(c, '2026-01-01', '2026-01-31')).requests).toBe(1);
  });
});
