import { describe, expect, it } from 'vitest';
import {
  addDetailRun,
  emptyDetailStats,
  fetchActivityDetails,
  parseDetailStats,
  type DetailStats,
  type GarminActivitySource,
} from './activity-details';
import type { GarminReply } from './client';
import { GarminError } from './errors';
import { formatDetailReport } from './report';
import { parseWorkoutDetails, type WorkoutDetails } from './workout-details';

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const ok = (data: unknown): GarminReply => ({ status: 200, empty: false, data });
const EMPTY: GarminReply = { status: 200, empty: true, data: null };
const noData = () => new GarminError({ kind: 'http', status: 404 });

const SUMMARY = {
  activityTypeDTO: { typeKey: 'running' },
  summaryDTO: { distance: 5012.4, duration: 1800, averageSpeed: 2.7778, averageHR: 150, maxHR: 175, minHR: 98, calories: 412, bmrCalories: 94, trainingEffect: 3.1 },
};
const STRENGTH_SUMMARY = { activityTypeDTO: { typeKey: 'strength_training' }, summaryDTO: { duration: 3000, averageHR: 118, maxHR: 162, calories: 245 } };
const ZONES = [1, 2, 3, 4, 5].map((n) => ({ zoneNumber: n, secsInZone: n * 100, zoneLowBoundary: 90 + n * 20 }));
const SPLITS = { lapDTOs: [{ lapIndex: 1, distance: 1000, duration: 360, averageHR: 148 }] };
const SETS = {
  exerciseSets: [
    { messageIndex: 0, setType: 'ACTIVE', duration: 30, repetitionCount: 8, weight: 60000, exercises: [{ category: 'BENCH_PRESS', probability: 90 }] },
    { messageIndex: 1, setType: 'REST', duration: 90 },
  ],
};

type Script = Partial<Record<'activity' | 'zones' | 'sets' | 'splits', () => GarminReply | Error>>;

function fake(script: Script = {}) {
  const log: string[] = [];
  const run = async (label: string, fn: (() => GarminReply | Error) | undefined, dflt: GarminReply) => {
    log.push(label);
    const r = fn ? fn() : dflt;
    if (r instanceof Error) throw r;
    return r;
  };
  const client: GarminActivitySource = {
    activity: (id) => run(`activity ${id}`, script.activity, ok(SUMMARY)),
    activityHrZones: (id) => run(`zones ${id}`, script.zones, ok(ZONES)),
    activityExerciseSets: (id) => run(`sets ${id}`, script.sets, ok(SETS)),
    activitySplits: (id) => run(`splits ${id}`, script.splits, ok(SPLITS)),
  };
  return { client, log };
}

const BASE_SUMMARY: WorkoutDetails = { v: 1, source: 'garmin', level: 'summary', fetchedAt: new Date(NOW - 86_400_000).toISOString(), typeKey: 'running', avgHr: 140, calories: 400 };

describe('fetchActivityDetails: the calls', () => {
  it('a run: summary, zones, then splits - one at a time, nothing else', async () => {
    const { client, log } = fake();
    const r = await fetchActivityDetails({ client, activityId: '777', nowMs: NOW });
    expect(log).toEqual(['activity 777', 'zones 777', 'splits 777']);
    expect(r.status).toBe('complete');
    expect(r.details).toMatchObject({
      v: 1,
      source: 'garmin',
      level: 'full',
      fetchedAt: new Date(NOW).toISOString(),
      typeKey: 'running',
      avgHr: 150,
      maxHr: 175,
      minHr: 98,
      distanceM: 5012.4,
      avgPaceSecPerKm: 360,
      trainingEffect: { aerobic: 3.1 },
      calories: 412,
      activeCalories: 318,
      laps: [{ index: 1, distanceM: 1000, durationSec: 360, avgHr: 148, paceSecPerKm: 360 }],
    });
    expect(r.details?.hrZones).toHaveLength(5);
    expect(r.details?.sets).toBeUndefined();
    expect(r.report.endpoints).toEqual({
      activity: { requests: 1, results: { ok: 1 } },
      activityZones: { requests: 1, results: { ok: 1 } },
      activitySplits: { requests: 1, results: { ok: 1 } },
    });
  });

  it('a strength session reads the sets instead of the laps', async () => {
    const { client, log } = fake({ activity: () => ok(STRENGTH_SUMMARY) });
    const r = await fetchActivityDetails({ client, activityId: '8', nowMs: NOW });
    expect(log).toEqual(['activity 8', 'zones 8', 'sets 8']);
    expect(r.details?.sets).toEqual([{ exercise: 'Bench press', guess: true, reps: 8, weightKg: 60, durationSec: 30, restSec: 90 }]);
    expect(r.details?.laps).toBeUndefined();
  });

  it('knows a strength session from the stored type key or the name when the summary has none', async () => {
    const byBase = fake({ activity: () => noData() });
    await fetchActivityDetails({ client: byBase.client, activityId: '8', nowMs: NOW, base: { ...BASE_SUMMARY, typeKey: 'strength_training' } });
    expect(byBase.log).toContain('sets 8');
    const byName = fake({ activity: () => EMPTY });
    await fetchActivityDetails({ client: byName.client, activityId: '8', nowMs: NOW, name: 'Strength training' });
    expect(byName.log).toContain('sets 8');
    const neither = fake({ activity: () => EMPTY });
    await fetchActivityDetails({ client: neither.client, activityId: '8', nowMs: NOW, name: 'Evening walk' });
    expect(neither.log).toContain('splits 8');
  });

  it('keeps what is stored for every value the endpoints do not return', async () => {
    const { client } = fake({ activity: () => EMPTY, zones: () => noData(), splits: () => noData() });
    const r = await fetchActivityDetails({ client, activityId: '9', nowMs: NOW, base: BASE_SUMMARY });
    expect(r.status).toBe('complete');
    expect(r.details).toMatchObject({ level: 'full', typeKey: 'running', avgHr: 140, calories: 400, fetchedAt: new Date(NOW).toISOString() });
  });

  it('a new value replaces the stored one', async () => {
    const { client } = fake();
    const r = await fetchActivityDetails({ client, activityId: '9', nowMs: NOW, base: BASE_SUMMARY });
    expect(r.details).toMatchObject({ avgHr: 150, calories: 412 });
  });
});

describe('fetchActivityDetails: when Garmin has nothing or fails', () => {
  it('"no data" everywhere (a manual activity) is a complete read with an empty envelope, so it is not asked again', async () => {
    const { client } = fake({ activity: () => noData(), zones: () => EMPTY, splits: () => noData() });
    const r = await fetchActivityDetails({ client, activityId: '5', nowMs: NOW });
    expect(r.status).toBe('complete');
    expect(r.details).toEqual({ v: 1, source: 'garmin', level: 'full', fetchedAt: new Date(NOW).toISOString() });
    expect(r.report.endpoints.activity?.results).toEqual({ 'HTTP 404': 1 });
    expect(r.report.endpoints.activityZones?.results).toEqual({ empty: 1 });
  });

  it.each([
    ['rate_limited', new GarminError({ kind: 'rate_limited', status: 429, retryAfterSeconds: 120 })],
    ['session_dead', new GarminError({ kind: 'session_dead', status: 401 })],
    ['unauthorized', new GarminError({ kind: 'unauthorized', status: 401 })],
    ['network', new GarminError({ kind: 'network' })],
    ['timeout', new GarminError({ kind: 'timeout' })],
    ['storage', new GarminError({ kind: 'storage' })],
  ] as const)('%s ends the read at once: nothing to store, no further request', async (kind, error) => {
    const { client, log } = fake({ zones: () => error });
    const r = await fetchActivityDetails({ client, activityId: '5', nowMs: NOW });
    expect(r.status).toBe('stopped');
    expect(r.details).toBeNull();
    expect(r.stop).toMatchObject({ kind, endpoint: 'activityZones' });
    expect(log).toEqual(['activity 5', 'zones 5']); // no splits request after the stop
    expect(r.stop?.message.length).toBeGreaterThan(5);
    if (kind === 'rate_limited') expect(r.stop?.retryAfterSec).toBe(120);
  });

  it('a 5xx on one call makes the read partial: stored as a summary so it is read again', async () => {
    const { client } = fake({ splits: () => new GarminError({ kind: 'server', status: 503 }) });
    const r = await fetchActivityDetails({ client, activityId: '5', nowMs: NOW });
    expect(r.status).toBe('partial');
    expect(r.details).toMatchObject({ level: 'summary', avgHr: 150 });
    expect(r.details?.laps).toBeUndefined();
    expect(r.report.endpoints.activitySplits?.results).toEqual({ 'server error (HTTP 503)': 1 });
  });

  it('a partial read that gained nothing and had nothing to build on stores nothing', async () => {
    const { client } = fake({
      activity: () => new GarminError({ kind: 'server', status: 500 }),
      zones: () => new GarminError({ kind: 'parse' }),
      splits: () => new GarminError({ kind: 'server', status: 500 }),
    });
    const r = await fetchActivityDetails({ client, activityId: '5', nowMs: NOW });
    expect(r.status).toBe('partial');
    expect(r.details).toBeNull();
    const withBase = await fetchActivityDetails({ client, activityId: '5', nowMs: NOW, base: BASE_SUMMARY });
    expect(withBase.details).toMatchObject({ level: 'summary', avgHr: 140 });
  });

  it('never throws, even for an invalid id or a client that throws something odd', async () => {
    const odd: GarminActivitySource = {
      activity: async () => {
        throw 'weird';
      },
      activityHrZones: async () => ok('not an array'),
      activityExerciseSets: async () => ok(null),
      activitySplits: async () => ok(12),
    };
    const r = await fetchActivityDetails({ client: odd, activityId: '5', nowMs: NOW });
    expect(r.status).toBe('partial');
    const garbage = fake({ activity: () => ok('x'), zones: () => ok({ nope: 1 }), splits: () => ok([1, 2]) });
    await expect(fetchActivityDetails({ client: garbage.client, activityId: '5', nowMs: NOW })).resolves.toMatchObject({ status: 'complete' });
  });

  it('the stored result always passes the tolerant parser', async () => {
    const { client } = fake();
    const r = await fetchActivityDetails({ client, activityId: '5', nowMs: NOW });
    expect(parseWorkoutDetails(JSON.parse(JSON.stringify(r.details)))).toEqual(r.details);
  });
});

describe('detail stats and the report section', () => {
  it('accumulates reads per endpoint without any value', async () => {
    let stats: DetailStats = emptyDetailStats();
    const a = await fetchActivityDetails({ client: fake().client, activityId: '1', nowMs: NOW });
    stats = addDetailRun(stats, a.report, a.stop, NOW);
    const b = await fetchActivityDetails({ client: fake({ zones: () => new GarminError({ kind: 'rate_limited', status: 429 }) }).client, activityId: '2', nowMs: NOW + 5000 });
    stats = addDetailRun(stats, b.report, b.stop, NOW + 5000);

    expect(stats.reads).toBe(2);
    expect(stats.lastReadAtMs).toBe(NOW + 5000);
    expect(stats.endpoints.activity).toEqual({ requests: 2, results: { ok: 2 } });
    expect(stats.endpoints.activityZones).toEqual({ requests: 2, results: { ok: 1, 'rate limited (HTTP 429)': 1 } });
    expect(stats.stops).toEqual({ rate_limited: 1 });

    const text = formatDetailReport(stats);
    expect(text).toContain('Workout details');
    expect(text).toContain('Activities read: 2, last at 2026-11-10T12:00:05.000Z');
    expect(text).toContain('Reads stopped early: rate_limited x1');
    expect(text).toContain('activity: /activity-service/activity/{id}');
    expect(text).toContain('activityZones: /activity-service/activity/{id}/hrTimeInZones');
    expect(text).toContain('2 requests: ok 1, rate limited (HTTP 429) 1');
    expect(text).toMatch(/avgHr: found 2 of 2 via summaryDTO\.averageHR/);
    // no values, no ids
    for (const secret of ['150', '175', '5012', '777', '12345678901', 'Bearer']) expect(text, secret).not.toContain(secret);
  });

  it('is empty before the first read, and survives a round trip and garbage', async () => {
    expect(formatDetailReport(null)).toBe('');
    expect(formatDetailReport(emptyDetailStats())).toBe('');
    const a = await fetchActivityDetails({ client: fake().client, activityId: '1', nowMs: NOW });
    const stats = addDetailRun(emptyDetailStats(), a.report, a.stop, NOW);
    expect(parseDetailStats(JSON.parse(JSON.stringify(stats)))).toEqual(stats);
    expect(parseDetailStats(JSON.stringify(stats))).toEqual(stats);
    for (const bad of [null, undefined, 5, 'x', '{', [], {}, { v: 2 }, { v: 1, endpoints: 'x', coverage: 5 }]) {
      expect(() => parseDetailStats(bad)).not.toThrow();
    }
    expect(parseDetailStats({ v: 2, reads: 4 })).toEqual(emptyDetailStats());
  });

  it('lists the fields it never found', async () => {
    const { client } = fake({ activity: () => ok({ activityTypeDTO: { typeKey: 'running' }, summaryDTO: { averageHR: 140 } }) });
    const r = await fetchActivityDetails({ client, activityId: '1', nowMs: NOW });
    const text = formatDetailReport(addDetailRun(emptyDetailStats(), r.report, r.stop, NOW));
    expect(text).toMatch(/Detail fields NOT found: .*activity\.minHr/);
    expect(text).toContain('minHr: NOT FOUND in 1 reply');
  });
});
