// The workout-detail read of the app (apps/app/src/health/garmin-details.ts, garmin-gate.ts, and the writer rule in writer.ts /
// garmin-sync.ts). Pure logic with every effect injected: Garmin is NEVER called, every client is a fake, every store is a variable.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GarminError, emptyDetailStats, type DetailStats, type GarminActivitySource, type GarminTokens, type WorkoutDetails } from '../../../packages/garmin/src/index.ts';
import { describe, expect, it } from 'vitest';
import { EMPTY_LOCAL_STATE, RATE_LIMIT_MIN_MS, type GarminLocalState } from '../../../apps/app/src/health/garmin.ts';
import {
  DETAIL_MESSAGES,
  endsBatch,
  ensureGarminDetails,
  pickQuietTargets,
  rateLimitedMessage,
  type DetailOutcome,
  type DetailTarget,
  type GarminDetailDeps,
} from '../../../apps/app/src/health/garmin-details.ts';
import { withGarminGate } from '../../../apps/app/src/health/garmin-gate.ts';
import type { GarminIntegrationPatch, GarminIntegrationRow } from '../../../apps/app/src/health/garmin-sync.ts';
import { toWorkoutPoints } from '../../../apps/app/src/health/garmin-sync.ts';
import { buildExerciseRows } from '../../../apps/app/src/health/rows.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const NOW = new Date(2026, 10, 10, 12, 0, 0).getTime();
const USER = 'user-1';
const TOKENS: GarminTokens = { diToken: 'ACCESS-TOKEN-SECRET', diRefreshToken: 'REFRESH-TOKEN-SECRET', diClientId: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2' };
const ok = (data: unknown) => ({ status: 200, empty: false, data });

const SUMMARY = {
  activityTypeDTO: { typeKey: 'strength_training' },
  summaryDTO: { duration: 3000, averageHR: 118, maxHR: 162, minHR: 80, calories: 245, trainingEffect: 2.3, anaerobicTrainingEffect: 0.6 },
};
const ZONES = [1, 2, 3, 4, 5].map((n) => ({ zoneNumber: n, secsInZone: n * 60, zoneLowBoundary: 90 + n * 20 }));
const SETS = {
  exerciseSets: [
    { messageIndex: 0, setType: 'ACTIVE', duration: 30, repetitionCount: 8, weight: 60000, exercises: [{ category: 'BENCH_PRESS', probability: 90 }] },
    { messageIndex: 1, setType: 'REST', duration: 90 },
  ],
};

const TARGET: DetailTarget = {
  id: 'ex-1',
  name: 'Strength training',
  source: 'garmin',
  external_id: 'garmin:activity:12345678901',
  entry_date: '2026-11-09',
  started_at: new Date(2026, 10, 9, 17, 30).toISOString(),
  details: null,
};

interface Harness {
  deps: GarminDetailDeps;
  calls: string[];
  saved: { id: string; details: WorkoutDetails }[];
  patches: GarminIntegrationPatch[];
  localPatches: Partial<GarminLocalState>[];
  tokens: { value: GarminTokens | null };
  stats: { value: DetailStats };
  clientsCreated: { n: number };
  clock: { t: number };
}

function harness(opts: {
  signedIn?: boolean;
  row?: GarminIntegrationRow | null;
  hasTokens?: boolean;
  source?: Partial<GarminActivitySource>;
  local?: GarminLocalState;
  saveFails?: boolean;
  statsFail?: boolean;
  rotate?: boolean;
} = {}): Harness {
  const h: Harness = {
    calls: [],
    saved: [],
    patches: [],
    localPatches: [],
    tokens: { value: opts.hasTokens === false ? null : TOKENS },
    stats: { value: emptyDetailStats() },
    clientsCreated: { n: 0 },
    clock: { t: NOW },
    deps: undefined as unknown as GarminDetailDeps,
  };
  let row: GarminIntegrationRow | null = opts.row === undefined ? { enabled: true, settings: { connected_at: '2026-11-01T00:00:00Z' }, last_sync_at: null } : opts.row;
  let local = opts.local ?? EMPTY_LOCAL_STATE;
  const source: GarminActivitySource = {
    activity: async (id) => (h.calls.push(`activity ${id}`), ok(SUMMARY)),
    activityHrZones: async (id) => (h.calls.push(`zones ${id}`), ok(ZONES)),
    activityExerciseSets: async (id) => (h.calls.push(`sets ${id}`), ok(SETS)),
    activitySplits: async (id) => (h.calls.push(`splits ${id}`), ok({ lapDTOs: [] })),
    ...opts.source,
  };
  h.deps = {
    now: () => h.clock.t,
    userId: async () => (opts.signedIn === false ? null : USER),
    integration: {
      load: async () => row,
      save: async (_u, patch) => {
        h.patches.push(patch);
        const cur = row ?? { enabled: false, settings: {}, last_sync_at: null };
        row = { enabled: patch.enabled ?? cur.enabled, settings: patch.settings ?? cur.settings, last_sync_at: cur.last_sync_at };
        return row;
      },
    },
    tokens: {
      load: async (u) => (u === USER ? h.tokens.value : null),
      save: async (_u, t) => {
        h.tokens.value = t;
      },
      clear: async () => {
        h.tokens.value = null;
      },
    },
    local: {
      load: async () => local,
      save: async (patch) => {
        h.localPatches.push(patch);
        local = { ...local, ...patch };
      },
    },
    stats: {
      load: async () => h.stats.value,
      save: async (s) => {
        if (opts.statsFail) throw new Error('disk full');
        h.stats.value = s;
      },
    },
    createClient: (tokens, onTokensChanged) => {
      h.clientsCreated.n += 1;
      if (opts.rotate) void onTokensChanged({ ...tokens, diToken: 'ROTATED-ACCESS', diRefreshToken: 'ROTATED-REFRESH' });
      return source;
    },
    saveDetails: async (id, details) => {
      if (opts.saveFails) throw new Error('permission denied for table exercise_entries');
      h.saved.push({ id, details });
    },
  };
  return h;
}

const failed = (o: DetailOutcome) => (o.status === 'failed' ? o : (() => { throw new Error(`expected failed, got ${o.status}`); })());
const skipped = (o: DetailOutcome) => (o.status === 'skipped' ? o : (() => { throw new Error(`expected skipped, got ${o.status}`); })());

describe('ensureGarminDetails: the happy path', () => {
  it('reads the four things of a strength session, one request at a time, and saves them into the row', async () => {
    const h = harness();
    const outcome = await ensureGarminDetails(h.deps, TARGET);
    expect(outcome.status).toBe('done');
    expect(h.calls).toEqual(['activity 12345678901', 'zones 12345678901', 'sets 12345678901']);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]?.id).toBe('ex-1');
    expect(h.saved[0]?.details).toMatchObject({
      v: 1,
      source: 'garmin',
      level: 'full',
      fetchedAt: new Date(NOW).toISOString(),
      typeKey: 'strength_training',
      avgHr: 118,
      maxHr: 162,
      minHr: 80,
      trainingEffect: { aerobic: 2.3, anaerobic: 0.6 },
      sets: [{ exercise: 'Bench press', guess: true, reps: 8, weightKg: 60, durationSec: 30, restSec: 90 }],
    });
    expect(h.saved[0]?.details.hrZones).toHaveLength(5);
  });

  it('records the detail calls for the "Copy sync report" section (endpoint outcomes, no values)', async () => {
    const h = harness();
    await ensureGarminDetails(h.deps, TARGET);
    expect(h.stats.value.reads).toBe(1);
    expect(h.stats.value.endpoints.activity).toEqual({ requests: 1, results: { ok: 1 } });
    expect(h.stats.value.endpoints.activitySets).toEqual({ requests: 1, results: { ok: 1 } });
    const json = JSON.stringify(h.stats.value);
    for (const secret of ['ACCESS-TOKEN-SECRET', 'REFRESH-TOKEN-SECRET', '12345678901', '118', '162']) expect(json, secret).not.toContain(secret);
  });

  it('a statistics problem never hides the details', async () => {
    const h = harness({ statsFail: true });
    expect((await ensureGarminDetails(h.deps, TARGET)).status).toBe('done');
    expect(h.saved).toHaveLength(1);
  });

  it('keeps a rotated refresh token (the client hands it to the token store)', async () => {
    const h = harness({ rotate: true });
    await ensureGarminDetails(h.deps, TARGET);
    await Promise.resolve();
    expect(h.tokens.value).toMatchObject({ diToken: 'ROTATED-ACCESS', diRefreshToken: 'ROTATED-REFRESH' });
  });
});

describe('ensureGarminDetails: when it does not ask Garmin at all', () => {
  it('not a Garmin workout (manual, Apple Health, no activity id)', async () => {
    for (const t of [
      { ...TARGET, source: 'manual', external_id: null },
      { ...TARGET, source: 'apple_health', external_id: 'HK-1' },
      { ...TARGET, external_id: 'garmin:sleep:2026-11-09' },
    ]) {
      const h = harness();
      expect(skipped(await ensureGarminDetails(h.deps, t)).reason).toBe('not_garmin');
      expect(h.clientsCreated.n).toBe(0);
    }
  });

  it('fresh full details are used as they are, unless forced', async () => {
    const fresh: WorkoutDetails = { v: 1, source: 'garmin', level: 'full', fetchedAt: new Date(NOW - 3_600_000).toISOString(), avgHr: 120 };
    const h = harness();
    expect(skipped(await ensureGarminDetails(h.deps, { ...TARGET, details: fresh })).reason).toBe('fresh');
    expect(h.clientsCreated.n).toBe(0);
    expect((await ensureGarminDetails(h.deps, { ...TARGET, details: fresh }, { force: true })).status).toBe('done');
  });

  it('a list summary is read again; an old full read of a recent workout too; an old workout is left alone', async () => {
    const summary: WorkoutDetails = { v: 1, source: 'garmin', level: 'summary', fetchedAt: new Date(NOW - 60_000).toISOString(), avgHr: 120 };
    expect((await ensureGarminDetails(harness().deps, { ...TARGET, details: summary })).status).toBe('done');
    const stale: WorkoutDetails = { v: 1, source: 'garmin', level: 'full', fetchedAt: new Date(NOW - 2 * 86_400_000).toISOString(), avgHr: 120 };
    expect((await ensureGarminDetails(harness().deps, { ...TARGET, details: stale })).status).toBe('done');
    const old = { ...TARGET, details: stale, entry_date: '2026-09-01', started_at: new Date(2026, 8, 1, 10).toISOString() };
    expect(skipped(await ensureGarminDetails(harness().deps, old)).reason).toBe('fresh');
  });

  it('the stored summary is the base of a full read: what the endpoints do not return is kept', async () => {
    const summary: WorkoutDetails = { v: 1, source: 'garmin', level: 'summary', fetchedAt: new Date(NOW - 60_000).toISOString(), typeKey: 'strength_training', calories: 250, maxHr: 170 };
    const h = harness({ source: { activity: async () => ({ status: 404, empty: true, data: null }) } });
    await ensureGarminDetails(h.deps, { ...TARGET, details: summary });
    expect(h.saved[0]?.details).toMatchObject({ level: 'full', calories: 250, maxHr: 170 });
  });

  it.each([
    ['signed out', { signedIn: false }, 'signed_out'],
    ['Garmin not connected', { row: { enabled: false, settings: {}, last_sync_at: null } }, 'not_connected'],
    ['no integration row', { row: null }, 'not_connected'],
    ['needs sign-in', { row: { enabled: true, settings: { needs_sign_in: true }, last_sync_at: null } }, 'needs_sign_in'],
    ['no tokens on this phone', { hasTokens: false }, 'not_connected'],
    ['rate limited', { local: { ...EMPTY_LOCAL_STATE, rateLimitedUntilMs: NOW + 60_000 } }, 'rate_limited'],
  ] as const)('%s: skipped with a clear sentence and no request', async (_label, opts, reason) => {
    const h = harness(opts as never);
    const o = skipped(await ensureGarminDetails(h.deps, TARGET));
    expect(o.reason).toBe(reason);
    expect(o.message.length).toBeGreaterThan(10);
    expect(h.clientsCreated.n).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it('the sentences name the next step', () => {
    expect(DETAIL_MESSAGES.needs_sign_in).toBe('Could not read the details from Garmin. Open Connected apps to sign in again.');
    expect(DETAIL_MESSAGES.not_connected).toContain('Open Connected apps');
    expect(rateLimitedMessage(null)).toContain('Try again later');
    expect(rateLimitedMessage(new Date(2026, 10, 10, 15, 42).getTime())).toContain('Try again after 15:42');
  });
});

describe('ensureGarminDetails: when Garmin says no', () => {
  it('a dead session (HTTP 400/401 on the refresh): tokens deleted, integration marked, "sign in again"', async () => {
    const h = harness({ source: { activity: async () => { throw new GarminError({ kind: 'session_dead', status: 401 }); } } });
    const o = failed(await ensureGarminDetails(h.deps, TARGET));
    expect(o).toMatchObject({ code: 'needs_sign_in', message: DETAIL_MESSAGES.needs_sign_in });
    expect(h.tokens.value).toBeNull();
    expect(h.patches).toHaveLength(1);
    expect((h.patches[0]?.settings as Record<string, unknown>).needs_sign_in).toBe(true);
    expect(h.saved).toEqual([]);
    // the next call does not even try
    expect(skipped(await ensureGarminDetails(h.deps, TARGET)).reason).toBe('needs_sign_in');
  });

  it('a 429: "try again later", the time Garmin asked for is remembered (the sync honours it too), nothing is saved', async () => {
    const h = harness({ source: { activityHrZones: async () => { throw new GarminError({ kind: 'rate_limited', status: 429, retryAfterSeconds: 20 * 60 }); } } });
    const o = failed(await ensureGarminDetails(h.deps, TARGET));
    expect(o.code).toBe('rate_limited');
    expect(o.message).toContain('slow down');
    expect(h.localPatches).toEqual([{ rateLimitedUntilMs: NOW + 20 * 60_000 }]);
    expect(h.calls).toEqual(['activity 12345678901']); // stopped at once
    expect(h.saved).toEqual([]);
    expect(skipped(await ensureGarminDetails(h.deps, TARGET)).reason).toBe('rate_limited');
  });

  it('a 429 without Retry-After waits at least the minimum', async () => {
    const h = harness({ source: { activity: async () => { throw new GarminError({ kind: 'rate_limited', status: 429 }); } } });
    await ensureGarminDetails(h.deps, TARGET);
    expect((h.localPatches[0]?.rateLimitedUntilMs ?? 0) - NOW).toBeGreaterThanOrEqual(RATE_LIMIT_MIN_MS);
  });

  it('a dropped network / timeout: "check your connection", nothing saved, no sign-out', async () => {
    for (const kind of ['network', 'timeout'] as const) {
      const h = harness({ source: { activity: async () => { throw new GarminError({ kind }); } } });
      const o = failed(await ensureGarminDetails(h.deps, TARGET));
      expect(o).toMatchObject({ code: 'network', message: DETAIL_MESSAGES.network });
      expect(h.tokens.value).toEqual(TOKENS);
      expect(h.saved).toEqual([]);
    }
  });

  it('a write problem is reported, not hidden, and does not contain a token', async () => {
    const h = harness({ saveFails: true });
    const o = failed(await ensureGarminDetails(h.deps, TARGET));
    expect(o.code).toBe('write_failed');
    expect(o.message).toContain('could not be saved');
    expect(o.message).not.toContain('TOKEN');
  });

  it('"no data" everywhere is a successful read with empty details, so the next opening is instant', async () => {
    const noData = async () => { throw new GarminError({ kind: 'http', status: 404 }); };
    const h = harness({ source: { activity: noData, activityHrZones: noData, activityExerciseSets: noData, activitySplits: noData } });
    const o = await ensureGarminDetails(h.deps, { ...TARGET, name: 'Walk' });
    expect(o.status).toBe('done');
    expect(h.saved[0]?.details).toMatchObject({ level: 'full' });
  });

  it('a server error on every call stores nothing and says "try again later"', async () => {
    const boom = async () => { throw new GarminError({ kind: 'server', status: 503 }); };
    const h = harness({ source: { activity: boom, activityHrZones: boom, activityExerciseSets: boom, activitySplits: boom } });
    const o = failed(await ensureGarminDetails(h.deps, TARGET));
    expect(o).toMatchObject({ code: 'other', message: DETAIL_MESSAGES.other });
    expect(h.saved).toEqual([]);
  });

  it('never throws, whatever a dependency does', async () => {
    const h = harness();
    h.deps.integration.load = async () => { throw new Error('offline'); };
    const o = failed(await ensureGarminDetails(h.deps, TARGET));
    expect(o.code).toBe('other');
  });
});

describe('the quiet pass after a sync', () => {
  const row = (n: number, over: Partial<DetailTarget> = {}): DetailTarget => ({ ...TARGET, id: `ex-${n}`, external_id: `garmin:activity:${1000 + n}`, ...over });
  const summary = { v: 1, source: 'garmin', level: 'summary', fetchedAt: new Date(NOW).toISOString(), avgHr: 120 };
  const full = { v: 1, source: 'garmin', level: 'full', fetchedAt: new Date(NOW).toISOString(), avgHr: 120 };

  it('takes the 3 newest Garmin workouts that have no full details, in order', () => {
    const rows = [row(1, { details: full }), row(2), row(3, { details: summary }), row(4, { source: 'manual', external_id: null }), row(5), row(6), row(7)];
    expect(pickQuietTargets(rows).map((r) => r.id)).toEqual(['ex-2', 'ex-3', 'ex-5']);
    expect(pickQuietTargets(rows, 1).map((r) => r.id)).toEqual(['ex-2']);
    expect(pickQuietTargets([])).toEqual([]);
  });

  it('ignores rows without a usable Garmin activity id', () => {
    expect(pickQuietTargets([row(1, { external_id: null }), row(2, { external_id: 'garmin:activity:abc' }), row(3, { source: 'apple_health' })])).toEqual([]);
  });

  it('a failure that would hit the next workout too ends the pass; a failure of one workout does not', () => {
    const out = (o: DetailOutcome) => endsBatch(o);
    expect(out({ status: 'failed', code: 'rate_limited', message: '' })).toBe(true);
    expect(out({ status: 'failed', code: 'needs_sign_in', message: '' })).toBe(true);
    expect(out({ status: 'failed', code: 'network', message: '' })).toBe(true);
    expect(out({ status: 'skipped', reason: 'rate_limited', message: '' })).toBe(true);
    expect(out({ status: 'skipped', reason: 'not_connected', message: '' })).toBe(true);
    expect(out({ status: 'failed', code: 'other', message: '' })).toBe(false);
    expect(out({ status: 'failed', code: 'write_failed', message: '' })).toBe(false);
    expect(out({ status: 'skipped', reason: 'fresh', message: '' })).toBe(false);
    expect(out({ status: 'done', details: full as WorkoutDetails })).toBe(false);
  });

  it('runs the three one after the other and stops at the first 429', async () => {
    let n = 0;
    const h = harness({
      source: {
        activity: async () => {
          n += 1;
          if (n === 2) throw new GarminError({ kind: 'rate_limited', status: 429 });
          return ok(SUMMARY);
        },
      },
    });
    const done: string[] = [];
    for (const t of pickQuietTargets([row(1), row(2), row(3)])) {
      const o = await ensureGarminDetails(h.deps, t);
      done.push(`${t.id}:${o.status}`);
      if (endsBatch(o)) break;
    }
    expect(done).toEqual(['ex-1:done', 'ex-2:failed']);
    expect(h.saved.map((s) => s.id)).toEqual(['ex-1']);
  });
});

describe('the Garmin gate (one Garmin job at a time)', () => {
  it('runs jobs strictly one after another, even when started together', async () => {
    const log: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const job = (name: string, ms: number) => async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`end ${name}`);
      running -= 1;
      return name;
    };
    const results = await Promise.all([withGarminGate(job('sync', 30)), withGarminGate(job('details', 5)), withGarminGate(job('more', 1))]);
    expect(results).toEqual(['sync', 'details', 'more']);
    expect(maxRunning).toBe(1);
    expect(log).toEqual(['start sync', 'end sync', 'start details', 'end details', 'start more', 'end more']);
  });

  it('a job that fails does not block the next one, and its error reaches its caller', async () => {
    const failing = withGarminGate(async () => {
      throw new Error('boom');
    });
    const next = withGarminGate(async () => 'still runs');
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('still runs');
  });
});

describe('the sync fills in the list summary without touching full details', () => {
  const D: Record<string, unknown> = { v: 1, source: 'garmin', level: 'summary', fetchedAt: '2026-11-10T11:00:00.000Z', avgHr: 150 };

  it('workouts from the activity list carry their details into the row builders; rows without details stay without the key', () => {
    const points = toWorkoutPoints([
      { externalId: 'garmin:activity:1', name: 'Run', typeKey: 'running', date: '2026-11-09', startLocal: '2026-11-09 07:00:00', startMs: Date.UTC(2026, 10, 9, 6), durationSec: 1800, kcal: 300, details: D as never },
      { externalId: 'garmin:activity:2', name: 'Walk', typeKey: 'walking', date: '2026-11-09', startLocal: '2026-11-09 09:00:00', startMs: Date.UTC(2026, 10, 9, 8), durationSec: 900 },
    ]);
    const rows = buildExerciseRows(USER, 'garmin', points);
    expect(rows[0]?.details).toEqual(D);
    expect('details' in (rows[1] as object)).toBe(false);
  });

  it('the writer updates existing rows with details only when they are not full yet, and never mixes column sets in one upsert', () => {
    const source = readFileSync(join(repoRoot, 'apps/app/src/health/writer.ts'), 'utf8');
    expect(source).toContain("existing.detailsLevel !== 'full'");
    expect(source).toContain("details_level:details->>level");
    expect(source).toContain('Same column set per call');
  });
});
