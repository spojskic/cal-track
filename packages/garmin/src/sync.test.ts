import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GarminConnectClient, type GarminReply } from './client';
import { CONNECT_API_BASE, DEFAULT_CLIENT_ID, DI_TOKEN_URL } from './constants';
import { GarminError } from './errors';
import { runGarminSync, type GarminBatch, type GarminSyncSource } from './sync';
import { REFRESH_TOKEN, accessToken, createClock, createFakeFetch, json, reply } from './test-utils';

const ok = (data: unknown): GarminReply => ({ status: 200, empty: false, data });
const EMPTY: GarminReply = { status: 200, empty: true, data: null };
const noData = () => new GarminError({ kind: 'http', status: 404 });

const SUMMARY = (steps: number) => ({
  restingHeartRate: 52,
  totalSteps: steps,
  averageStressLevel: 31,
  bodyBatteryHighestValue: 88,
  bodyBatteryLowestValue: 14,
  totalKilocalories: 2650,
  activeKilocalories: 612,
  bmrKilocalories: 2038,
});
const SLEEP = { avgOvernightHrv: 70, dailySleepDTO: { sleepTimeSeconds: 27000, deepSleepSeconds: 3600, sleepScores: { overall: { value: 81 } } } };
const HRV = { hrvSummary: { lastNightAvg: 64, status: 'BALANCED' } };
const ACTIVITY = (id: number, date: string) => ({ activityId: id, activityName: 'Run', startTimeLocal: `${date} 07:00:00`, duration: 1800, calories: 300, activityType: { typeKey: 'running' } });

interface Script {
  profile?: () => GarminReply | Error;
  summary?: (date: string) => GarminReply | Error;
  sleep?: (date: string) => GarminReply | Error;
  hrv?: (date: string) => GarminReply | Error;
  weight?: () => GarminReply | Error;
  activities?: (start: number) => GarminReply | Error;
}

function fakeClient(script: Script = {}) {
  const log: string[] = [];
  const run = async (label: string, fn: (() => GarminReply | Error) | undefined, dflt: GarminReply): Promise<GarminReply> => {
    log.push(label);
    const r = fn ? fn() : dflt;
    if (r instanceof Error) throw r;
    return r;
  };
  const client: GarminSyncSource = {
    profile: () => run('profile', script.profile, ok({ displayName: 'user-1' })),
    userSummary: (name, date) => run(`summary ${name} ${date}`, script.summary && (() => script.summary!(date)), ok(SUMMARY(9000))),
    sleep: (name, date) => run(`sleep ${name} ${date}`, script.sleep && (() => script.sleep!(date)), ok(SLEEP)),
    hrv: (date) => run(`hrv ${date}`, script.hrv && (() => script.hrv!(date)), ok(HRV)),
    weightRange: (a, b) => run(`weight ${a} ${b}`, script.weight, ok({ dateWeightList: [{ samplePk: 1, calendarDate: b, weight: 81500 }] })),
    activities: (start, limit) => run(`activities ${start} ${limit}`, script.activities && (() => script.activities!(start)), ok([])),
  };
  return { client, log };
}

async function run(script: Script, extra: Partial<Parameters<typeof runGarminSync>[0]> = {}) {
  const { client, log } = fakeClient(script);
  const batches: GarminBatch[] = [];
  const outcome = await runGarminSync({
    client,
    range: { from: '2026-11-08', to: '2026-11-10' },
    onBatch: async (b) => void batches.push(b),
    now: () => 1_000,
    ...extra,
  });
  return { outcome, log, batches };
}

describe('the walk', () => {
  it('reads the profile first, then activities and weight, then each day newest first (3 requests a day)', async () => {
    const { outcome, log } = await run({});
    expect(log).toEqual([
      'profile',
      'activities 0 50',
      'weight 2026-11-08 2026-11-10',
      'summary user-1 2026-11-10',
      'sleep user-1 2026-11-10',
      'hrv 2026-11-10',
      'summary user-1 2026-11-09',
      'sleep user-1 2026-11-09',
      'hrv 2026-11-09',
      'summary user-1 2026-11-08',
      'sleep user-1 2026-11-08',
      'hrv 2026-11-08',
    ]);
    expect(outcome.status).toBe('complete');
    expect(outcome.counts.daysRead).toBe(3);
  });

  it('hands over the data as it goes: workouts, weigh-ins, then one batch per day with its energy', async () => {
    const { outcome, batches } = await run({ activities: () => ok([ACTIVITY(1, '2026-11-09'), ACTIVITY(2, '2026-10-01')]) });
    expect(batches.map((b) => b.label)).toEqual(['activities', 'weight', '2026-11-10', '2026-11-09', '2026-11-08']);
    expect(batches[0]?.workouts.map((w) => w.externalId)).toEqual(['garmin:activity:1']); // the October one is outside the range
    expect(batches[1]?.biometrics.map((b) => b.type)).toEqual(['weight']);
    const day = batches[2] as GarminBatch;
    expect(day.energy).toEqual([{ date: '2026-11-10', activeKcal: 612, restingKcal: 2038, totalKcal: 2650, steps: 9000 }]);
    expect(day.biometrics.map((b) => b.type).sort()).toEqual(['body_battery', 'hrv', 'resting_heart_rate', 'sleep', 'sleep_score', 'stress']);
    expect(outcome.counts).toMatchObject({ energyDays: 3, workouts: 1, daysRead: 3 });
    expect(outcome.counts.biometrics).toMatchObject({ weight: 1, sleep: 3, hrv: 3, stress: 3, resting_heart_rate: 3 });
  });

  it('pages through the activities while they still reach into the range', async () => {
    const page = (n: number, date: string, base: number) => ok(Array.from({ length: n }, (_, i) => ACTIVITY(base + i, date)));
    const { log, batches } = await run({
      activities: (start) => (start === 0 ? page(50, '2026-11-09', 100) : start === 50 ? page(50, '2026-11-08', 200) : page(10, '2026-10-01', 300)),
    });
    expect(log.filter((l) => l.startsWith('activities'))).toEqual(['activities 0 50', 'activities 50 50', 'activities 100 50']);
    expect(batches[0]?.workouts).toHaveLength(100);
  });

  it('stops paging at a short page or once a page reaches back before the range', async () => {
    const full = ok(Array.from({ length: 50 }, (_, i) => ACTIVITY(i + 1, '2026-10-01')));
    const old = await run({ activities: () => full });
    expect(old.log.filter((l) => l.startsWith('activities'))).toHaveLength(1);
    const short = await run({ activities: () => ok([ACTIVITY(1, '2026-11-09')]) });
    expect(short.log.filter((l) => l.startsWith('activities'))).toHaveLength(1);
  });

  it('caps the activity pages', async () => {
    const full = ok(Array.from({ length: 50 }, (_, i) => ACTIVITY(i + 1, '2026-11-09')));
    const { log } = await run({ activities: () => full }, { maxActivityPages: 2 });
    expect(log.filter((l) => l.startsWith('activities'))).toHaveLength(2);
  });

  it('treats 404 / 403 and empty bodies as "no data": no batch, no problem', async () => {
    const { outcome, batches, log } = await run({
      summary: () => noData(),
      sleep: () => new GarminError({ kind: 'http', status: 403 }),
      hrv: () => EMPTY,
      weight: () => EMPTY,
      activities: () => EMPTY,
    });
    expect(outcome.status).toBe('complete');
    expect(batches).toEqual([]);
    expect(outcome.report.notes).toEqual([]);
    expect(log).toHaveLength(12);
    const hrv = outcome.report.endpoints.find((e) => e.endpoint === 'hrv');
    expect(hrv).toMatchObject({ requests: 3, results: { empty: 3 }, records: 0 });
    expect(outcome.report.endpoints.find((e) => e.endpoint === 'userSummary')?.results).toEqual({ 'HTTP 404': 3 });
  });

  it('falls back to the sleep reply\'s overnight HRV when the HRV endpoint has nothing for a night', async () => {
    const { batches, outcome } = await run({ hrv: () => EMPTY });
    const hrv = batches[2]?.biometrics.filter((b) => b.type === 'hrv') ?? [];
    expect(hrv).toHaveLength(1);
    expect(hrv[0]).toMatchObject({ value: 70, meta: { from: 'sleep' } });
    expect(outcome.report.notes.join(' ')).toContain('overnight average of the sleep reply');
  });

  it('does not ask for summary / sleep without a displayName, but still reads hrv, weight and activities', async () => {
    const { log, outcome } = await run({ profile: () => new GarminError({ kind: 'server', status: 500 }) });
    expect(log.some((l) => l.startsWith('summary') || l.startsWith('sleep'))).toBe(false);
    expect(log.filter((l) => l.startsWith('hrv'))).toHaveLength(3);
    expect(outcome.status).toBe('complete');
    expect(outcome.report.notes.join(' ')).toContain('no displayName');
  });

  it('an empty range (from after to) sends only the profile request', async () => {
    const { log, outcome } = await run({}, { range: { from: '2026-11-10', to: '2026-11-09' } });
    expect(log).toEqual(['profile']);
    expect(outcome.report.days).toBe(0);
  });

  it('reports progress', async () => {
    const seen: string[] = [];
    await run({}, { onProgress: (p) => void seen.push(`${p.step}:${p.date ?? ''}:${p.daysDone}/${p.daysTotal}`) });
    expect(seen[0]).toBe('profile::0/3');
    expect(seen).toContain('day:2026-11-10:0/3');
    expect(seen.at(-1)).toBe('day:2026-11-08:3/3');
  });
});

describe('when the run has to stop', () => {
  it('a 429 stops everything, remembers Retry-After, and keeps what was already delivered', async () => {
    let days = 0;
    const { outcome, batches, log } = await run({
      summary: () => {
        days += 1;
        return days === 2 ? new GarminError({ kind: 'rate_limited', status: 429, retryAfterSeconds: 90 }) : ok(SUMMARY(5000));
      },
    });
    expect(outcome.status).toBe('stopped');
    expect(outcome.report.stop).toMatchObject({ kind: 'rate_limited', endpoint: 'userSummary', retryAfterSec: 90 });
    expect(batches.map((b) => b.label)).toEqual(['weight', '2026-11-10']); // no activities batch: the list was empty
    expect(log.filter((l) => l.startsWith('summary'))).toHaveLength(2);
    expect(log.some((l) => l.includes('user-1 2026-11-08'))).toBe(false);
  });

  it('keeps what the stopped day already returned: its energy survives a 429 on the sleep request', async () => {
    const { outcome, batches } = await run({ sleep: (d) => (d === '2026-11-09' ? new GarminError({ kind: 'rate_limited', status: 429 }) : ok(SLEEP)) });
    expect(outcome.status).toBe('stopped');
    expect(outcome.report.stop).toMatchObject({ kind: 'rate_limited', endpoint: 'sleep' });
    expect(batches.map((b) => b.label)).toEqual(['weight', '2026-11-10', '2026-11-09']);
    const partial = batches.at(-1) as GarminBatch;
    expect(partial.energy).toHaveLength(1); // the user summary of 2026-11-09 was read before the sleep request failed
    expect(partial.biometrics.some((b) => b.type === 'sleep')).toBe(false);
  });

  it('a dead session, an unauthorized token, a dropped network and a failed token save each end the run', async () => {
    for (const kind of ['session_dead', 'unauthorized', 'network', 'timeout', 'storage'] as const) {
      const { outcome, log } = await run({ sleep: () => new GarminError({ kind, status: kind === 'session_dead' ? 401 : undefined }) });
      expect(outcome.status, kind).toBe('stopped');
      expect(outcome.report.stop?.kind, kind).toBe(kind);
      expect(log.filter((l) => l.startsWith('summary')), kind).toHaveLength(1);
    }
  });

  it('one server error on one day is a note, not a stop', async () => {
    const { outcome } = await run({ hrv: (d) => (d === '2026-11-09' ? new GarminError({ kind: 'server', status: 503 }) : ok(HRV)) });
    expect(outcome.status).toBe('complete');
    expect(outcome.report.endpoints.find((e) => e.endpoint === 'hrv')?.results).toEqual({ ok: 2, 'server error (HTTP 503)': 1 });
  });

  it('three days in a row with a server error mean Garmin is down: stop', async () => {
    const { outcome } = await run({ summary: () => new GarminError({ kind: 'server', status: 502 }) });
    expect(outcome.status).toBe('stopped');
    expect(outcome.report.stop?.kind).toBe('server');
    expect(outcome.counts.daysRead).toBe(3);
  });

  it('a day without a server error resets the streak', async () => {
    const { outcome } = await run(
      { summary: (d) => (d === '2026-11-09' ? ok(SUMMARY(1000)) : new GarminError({ kind: 'server', status: 502 })) },
      { range: { from: '2026-11-07', to: '2026-11-10' } },
    );
    expect(outcome.status).toBe('complete');
  });

  it('can be cancelled between requests', async () => {
    let n = 0;
    const { outcome, log } = await run({}, { isCancelled: () => ++n > 4 });
    expect(outcome.status).toBe('cancelled');
    expect(log.length).toBeLessThan(12);
  });

  it('a failing sink ends the run (nothing more is requested) and the error is handed back', async () => {
    const { client, log } = fakeClient({});
    const boom = new Error('JWT expired');
    const outcome = await runGarminSync({
      client,
      range: { from: '2026-11-08', to: '2026-11-10' },
      onBatch: async () => {
        throw boom;
      },
    });
    expect(outcome.status).toBe('stopped');
    expect(outcome.report.stop).toMatchObject({ kind: 'storage', endpoint: 'writer' });
    expect(outcome.writeError).toBe(boom);
    expect(log.length).toBeLessThan(12);
  });
});

describe('end to end with the real client and a fake fetch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', () => {
      throw new Error('the real fetch must never be called in tests');
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends only sequential, paced GET requests to connectapi.garmin.com', async () => {
    const clock = createClock();
    const fake = createFakeFetch((c) => {
      const path = c.url.slice(CONNECT_API_BASE.length);
      if (path.startsWith('/userprofile-service/socialProfile')) return json(200, { displayName: 'user-1' });
      if (path.startsWith('/usersummary-service/usersummary/daily/')) return json(200, SUMMARY(8000));
      if (path.startsWith('/wellness-service/wellness/dailySleepData/')) return json(200, SLEEP);
      if (path.startsWith('/hrv-service/hrv/')) return reply(200, '');
      if (path.startsWith('/weight-service/weight/dateRange')) return json(200, { dateWeightList: [] });
      if (path.startsWith('/activitylist-service/activities/search/activities')) return json(200, [ACTIVITY(5, '2026-11-10')]);
      return reply(404);
    });
    const client = new GarminConnectClient({
      fetch: fake.fetch,
      tokens: { diToken: accessToken(3600), diRefreshToken: REFRESH_TOKEN, diClientId: DEFAULT_CLIENT_ID },
      now: clock.now,
      sleep: clock.sleep,
    });
    const batches: GarminBatch[] = [];
    const outcome = await runGarminSync({
      client,
      range: { from: '2026-11-08', to: '2026-11-10' },
      onBatch: async (b) => void batches.push(b),
      now: clock.now,
    });
    expect(outcome.status).toBe('complete');
    expect(fake.calls).toHaveLength(12); // profile + activities + weight + 3 days x 3
    expect(fake.maxInFlight()).toBe(1);
    for (const c of fake.calls) {
      expect(c.init.method).toBe('GET');
      expect(c.url.startsWith(`${CONNECT_API_BASE}/`)).toBe(true);
      expect(c.url).not.toBe(DI_TOKEN_URL);
    }
    expect(clock.sleeps).toEqual(Array(11).fill(250));
    expect(batches.at(0)?.workouts).toHaveLength(1);
    // the empty HRV bodies were "no data": HRV comes from the sleep reply instead
    expect(batches.at(-1)?.biometrics.some((b) => b.type === 'hrv')).toBe(true);
  });
});

describe('the report', () => {
  it('counts requests and outcomes per endpoint, and merges the field coverage over all days', async () => {
    const { outcome } = await run({});
    const byName = Object.fromEntries(outcome.report.endpoints.map((e) => [e.endpoint, e]));
    expect(byName.profile).toMatchObject({ requests: 1, results: { ok: 1 }, records: 1 });
    expect(byName.userSummary).toMatchObject({ requests: 3, results: { ok: 3 }, records: 3 });
    expect(byName.sleep).toMatchObject({ requests: 3, records: 3 });
    expect(byName.weight).toMatchObject({ requests: 1, records: 1 });
    expect(outcome.report.endpoints.map((e) => e.endpoint)).toEqual(['profile', 'activities', 'weight', 'userSummary', 'sleep', 'hrv']);
    const steps = outcome.report.coverage.find((c) => c.endpoint === 'userSummary' && c.field === 'steps');
    expect(steps).toMatchObject({ total: 3, found: 3, matchedBy: { totalSteps: 3 } });
    expect(outcome.report.range).toEqual({ from: '2026-11-08', to: '2026-11-10' });
  });

  it('shows a field that matched nothing as found 0', async () => {
    const { outcome } = await run({ summary: () => ok({ restingHeartRate: 50 }) });
    const active = outcome.report.coverage.find((c) => c.endpoint === 'userSummary' && c.field === 'activeKcal');
    expect(active).toMatchObject({ total: 3, found: 0 });
    expect(active?.tried).toContain('activeKilocalories');
  });
});

describe('workout details from the activity list', () => {
  it('hands each workout the heart rate, zones and training effect the list already carries (no extra request)', async () => {
    const withHr = { ...ACTIVITY(1, '2026-11-09'), averageHR: 150, maxHR: 171, aerobicTrainingEffect: 3.1, hrTimeInZone_2: 600, hrTimeInZone_3: 300 };
    const { batches, log } = await run({ activities: () => ok([withHr, ACTIVITY(2, '2026-11-09')]) }, { now: () => Date.UTC(2026, 10, 10, 12) });
    const workouts = batches[0]?.workouts ?? [];
    expect(workouts).toHaveLength(2);
    expect(workouts[0]?.details).toMatchObject({
      v: 1,
      level: 'summary',
      fetchedAt: '2026-11-10T12:00:00.000Z',
      typeKey: 'running',
      avgHr: 150,
      maxHr: 171,
      trainingEffect: { aerobic: 3.1 },
      hrZones: [{ zone: 2, seconds: 600 }, { zone: 3, seconds: 300 }],
    });
    expect(workouts[1]?.details).toMatchObject({ level: 'summary', calories: 300 });
    // the sync still makes exactly the same requests as before: nothing per activity
    expect(log.filter((l) => l.startsWith('activities'))).toEqual(['activities 0 50']);
    expect(log.some((l) => l.includes('/activity-service/'))).toBe(false);
  });
});
