// Pure logic of the app's Garmin link (apps/app/src/health/garmin*.ts). The app has no test runner of its own; these modules
// import nothing from react-native / expo / supabase on purpose, so they run here. Garmin is NEVER called: every client is a
// fake, every store is a Map.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GarminError, type GarminSyncSource, type GarminTokens } from '../../../packages/garmin/src/index.ts';
import { describe, expect, it } from 'vitest';
import {
  GARMIN_BACKFILL_DAYS,
  GARMIN_HOW_IT_WORKS,
  GARMIN_IMPORTS_NOTE,
  GARMIN_MAX_INCREMENTAL_DAYS,
  GARMIN_SIGNED_OUT_NOTE,
  GARMIN_UNOFFICIAL_NOTE,
  GARMIN_WEB_NOTE,
  RATE_LIMIT_DEFAULT_MS,
  RATE_LIMIT_MAX_MS,
  RATE_LIMIT_MIN_MS,
  deriveGarminState,
  describeStop,
  isDueByInterval,
  isRateLimited,
  parseGarminSettings,
  parseLocalState,
  planGarminRange,
  rateLimitedUntil,
  serializeGarminSettings,
  serializeLocalState,
  EMPTY_LOCAL_STATE,
  type GarminLocalState,
} from '../../../apps/app/src/health/garmin.ts';
import {
  executeGarminSync,
  localWallClockMs,
  toBiometricPoints,
  toDailyEnergyPoints,
  toWorkoutPoints,
  writeGarminBatch,
  type GarminDeps,
  type GarminIntegrationPatch,
  type GarminIntegrationRow,
} from '../../../apps/app/src/health/garmin-sync.ts';
import { TOKEN_KEYS, createTokenStore, type SecretStore } from '../../../apps/app/src/health/garmin-token-store.ts';
import type {
  BiometricRowInput,
  DailyEnergyRowInput,
  ExerciseRowInput,
  SyncWriter,
} from '../../../apps/app/src/health/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

// ---------------------------------------------------------------------------------------------------------------------
// settings, state, planning
// ---------------------------------------------------------------------------------------------------------------------

describe('Garmin settings (integrations.settings of the provider = garmin row)', () => {
  it('parses defensively and keeps unknown keys on write', () => {
    expect(parseGarminSettings(null)).toEqual({ connectedAt: null, needsSignIn: false, lastSummary: null });
    expect(parseGarminSettings({ connected_at: '2026-11-10T08:00:00Z', needs_sign_in: true, last_summary: '3 workouts' })).toEqual({
      connectedAt: '2026-11-10T08:00:00Z',
      needsSignIn: true,
      lastSummary: '3 workouts',
    });
    expect(parseGarminSettings({ needs_sign_in: 'yes', last_summary: 5 }).needsSignIn).toBe(false);
    const out = serializeGarminSettings({ connectedAt: null, needsSignIn: false, lastSummary: null }, { future: 1, connected_at: 'x', last_summary: 'old' });
    expect(out).toEqual({ future: 1, needs_sign_in: false });
  });

  it('never has a place for a token', () => {
    const out = serializeGarminSettings({ connectedAt: 'x', needsSignIn: true, lastSummary: 'y' });
    expect(Object.keys(out).sort()).toEqual(['connected_at', 'last_summary', 'needs_sign_in']);
  });
});

describe('deriveGarminState', () => {
  const on = { enabled: true, settings: {} };
  it('web is always web', () => {
    expect(deriveGarminState({ native: false, row: on, hasTokens: true })).toBe('web');
  });
  it('needs the row AND the tokens of this phone', () => {
    expect(deriveGarminState({ native: true, row: null, hasTokens: false })).toBe('not_connected');
    expect(deriveGarminState({ native: true, row: { enabled: false, settings: {} }, hasTokens: true })).toBe('not_connected');
    expect(deriveGarminState({ native: true, row: on, hasTokens: true })).toBe('connected');
    // a second phone with the same account: the row says connected, this phone has no token
    expect(deriveGarminState({ native: true, row: on, hasTokens: false })).toBe('not_connected');
  });
  it('a dead session asks for a new sign-in even though the token was deleted', () => {
    expect(deriveGarminState({ native: true, row: { enabled: true, settings: { needs_sign_in: true } }, hasTokens: false })).toBe('needs_sign_in');
    expect(deriveGarminState({ native: true, row: { enabled: false, settings: { needs_sign_in: true } }, hasTokens: false })).toBe('not_connected');
  });
});

describe('texts of the card', () => {
  it('the web note says the phone app is needed', () => {
    expect(GARMIN_WEB_NOTE).toContain('Garmin sync runs in the iPhone and Android app');
  });
  it('the connect sentence says what is kept where, and that nothing is written to Garmin', () => {
    expect(GARMIN_HOW_IT_WORKS).toContain("Garmin's own page");
    expect(GARMIN_HOW_IT_WORKS).toContain('never sees your password');
    expect(GARMIN_HOW_IT_WORKS).toContain("this phone's secure storage");
    expect(GARMIN_HOW_IT_WORKS).toContain('saves it to your Cal Track account');
    expect(GARMIN_HOW_IT_WORKS).toContain('Nothing is written to Garmin');
    expect(GARMIN_UNOFFICIAL_NOTE).toContain('not an official Garmin integration');
    expect(GARMIN_UNOFFICIAL_NOTE).toContain('stop working when Garmin changes it');
    expect(GARMIN_IMPORTS_NOTE).toContain('14 days');
    expect(GARMIN_SIGNED_OUT_NOTE).toContain('Sign in to Garmin again');
  });
});

describe('planGarminRange', () => {
  const today = '2026-11-10';
  it('a backfill is the last 14 days, today included', () => {
    expect(GARMIN_BACKFILL_DAYS).toBe(14);
    expect(planGarminRange({ mode: 'backfill', today, lastSyncAt: null })).toEqual({ from: '2026-10-28', to: '2026-11-10' });
    expect(planGarminRange({ mode: 'backfill', today, lastSyncAt: '2026-11-10T07:00:00Z' })).toEqual({ from: '2026-10-28', to: '2026-11-10' });
  });
  it('an incremental run re-reads today and the two days before it', () => {
    const justNow = new Date(2026, 10, 10, 9, 0, 0).toISOString();
    expect(planGarminRange({ mode: 'incremental', today, lastSyncAt: justNow })).toEqual({ from: '2026-11-08', to: '2026-11-10' });
  });
  it('fills the hole since the last good sync, but never reaches back further than 7 days', () => {
    const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0, 0).toISOString();
    expect(planGarminRange({ mode: 'incremental', today, lastSyncAt: at(2026, 11, 6) })).toEqual({ from: '2026-11-05', to: '2026-11-10' });
    expect(GARMIN_MAX_INCREMENTAL_DAYS).toBe(7);
    expect(planGarminRange({ mode: 'incremental', today, lastSyncAt: at(2026, 10, 1) })).toEqual({ from: '2026-11-04', to: '2026-11-10' });
  });
  it('a run that never finished (no last sync) is a backfill', () => {
    expect(planGarminRange({ mode: 'incremental', today, lastSyncAt: null })).toEqual({ from: '2026-10-28', to: '2026-11-10' });
  });
  it('survives an unreadable last-sync time', () => {
    expect(planGarminRange({ mode: 'incremental', today, lastSyncAt: 'garbage' })).toEqual({ from: '2026-11-08', to: '2026-11-10' });
  });
});

describe('rate limit and throttle', () => {
  const now = 1_000_000;
  it('Retry-After wins within [5 min, 6 h]; without one it is 30 minutes', () => {
    expect(rateLimitedUntil(now)).toBe(now + RATE_LIMIT_DEFAULT_MS);
    expect(rateLimitedUntil(now, 90)).toBe(now + RATE_LIMIT_MIN_MS);
    expect(rateLimitedUntil(now, 20 * 60)).toBe(now + 20 * 60_000);
    expect(rateLimitedUntil(now, 99 * 3600)).toBe(now + RATE_LIMIT_MAX_MS);
    expect(rateLimitedUntil(now, 0)).toBe(now + RATE_LIMIT_MIN_MS);
  });
  it('is limited until the time has passed', () => {
    expect(isRateLimited(null, now)).toBe(false);
    expect(isRateLimited(now + 1, now)).toBe(true);
    expect(isRateLimited(now, now)).toBe(false);
  });
  it('the foreground throttle lets a run through once per interval', () => {
    const tenMin = 10 * 60_000;
    expect(isDueByInterval(null, now, tenMin)).toBe(true);
    expect(isDueByInterval(now - tenMin + 1, now, tenMin)).toBe(false);
    expect(isDueByInterval(now - tenMin, now, tenMin)).toBe(true);
  });
});

describe('local state (this phone only)', () => {
  it('round-trips and survives garbage', () => {
    const state: GarminLocalState = { rateLimitedUntilMs: 5, report: 'r', reportAtMs: 6, lastIssue: 'x' };
    expect(parseLocalState(serializeLocalState(state))).toEqual(state);
    for (const bad of [null, undefined, '', 'not json', '[]', '5', '{"rateLimitedUntilMs":"soon","report":5}']) {
      expect(parseLocalState(bad)).toEqual(EMPTY_LOCAL_STATE);
    }
  });
});

describe('describeStop', () => {
  it('speaks plainly for each ending', () => {
    expect(describeStop({ kind: 'rate_limited', message: 'm' }, new Date(2026, 10, 10, 15, 42).getTime())).toBe(
      'Garmin asked the app to slow down. Cal Track will try again after 15:42.',
    );
    expect(describeStop({ kind: 'session_dead', message: 'm' }, null)).toBe(GARMIN_SIGNED_OUT_NOTE);
    expect(describeStop({ kind: 'network', message: 'm' }, null)).toContain('Could not reach Garmin');
    expect(describeStop({ kind: 'server', message: 'Garmin is down' }, null)).toBe('Garmin is down');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// token store
// ---------------------------------------------------------------------------------------------------------------------

class MapStore implements SecretStore {
  readonly items = new Map<string, string>();
  async get(key: string) {
    return this.items.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.items.set(key, value);
  }
  async delete(key: string) {
    this.items.delete(key);
  }
}

const TOKENS: GarminTokens = { diToken: 'ACCESS-TOKEN-SECRET', diRefreshToken: 'REFRESH-TOKEN-SECRET', diClientId: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2' };
const USER = '00000000-0000-4000-8000-00000000000a';
const OTHER = '00000000-0000-4000-8000-00000000000b';

describe('token store', () => {
  it('stores each secret under its own key and hands the pair back', async () => {
    const kv = new MapStore();
    const store = createTokenStore(kv);
    expect(await store.has(USER)).toBe(false);
    await store.save(USER, TOKENS);
    expect([...kv.items.keys()].sort()).toEqual(Object.values(TOKEN_KEYS).sort());
    expect(await store.load(USER)).toEqual(TOKENS);
    expect(await store.has(USER)).toBe(true);
  });
  it('never hands tokens to another Cal Track user of the same phone', async () => {
    const store = createTokenStore(new MapStore());
    await store.save(USER, TOKENS);
    expect(await store.load(OTHER)).toBeNull();
    expect(await store.has(OTHER)).toBe(false);
  });
  it('a rotated pair replaces the old one', async () => {
    const store = createTokenStore(new MapStore());
    await store.save(USER, TOKENS);
    await store.save(USER, { ...TOKENS, diToken: 'NEW', diRefreshToken: 'ROTATED' });
    expect(await store.load(USER)).toMatchObject({ diToken: 'NEW', diRefreshToken: 'ROTATED' });
  });
  it('clear removes everything; an incomplete set is no set', async () => {
    const kv = new MapStore();
    const store = createTokenStore(kv);
    await store.save(USER, TOKENS);
    kv.items.delete(TOKEN_KEYS.refresh);
    expect(await store.load(USER)).toBeNull();
    await store.save(USER, TOKENS);
    await store.clear();
    expect(kv.items.size).toBe(0);
    expect(await store.load(USER)).toBeNull();
  });
  it('writes the refresh token first, so a failing later write cannot lose the way to renew', async () => {
    class Failing extends MapStore {
      override async set(key: string, value: string) {
        if (key === TOKEN_KEYS.access) throw new Error('keychain locked');
        await super.set(key, value);
      }
    }
    const kv = new Failing();
    await expect(createTokenStore(kv).save(USER, TOKENS)).rejects.toThrow('keychain locked');
    expect(kv.items.get(TOKEN_KEYS.refresh)).toBe('REFRESH-TOKEN-SECRET');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// package rows -> the app's rows
// ---------------------------------------------------------------------------------------------------------------------

class MemoryWriter implements SyncWriter {
  energy = new Map<string, DailyEnergyRowInput>();
  exercises = new Map<string, ExerciseRowInput>();
  biometrics = new Map<string, BiometricRowInput>();
  fail: Error | null = null;
  upserts = 0;
  /** Same conflict keys as the database: (user, day, source) and (user, source, external_id). */
  async upsertDailyEnergy(rows: DailyEnergyRowInput[]) {
    if (this.fail) throw this.fail;
    this.upserts += 1;
    for (const r of rows) this.energy.set(`${r.user_id}|${r.local_date}|${r.source}`, r);
  }
  async upsertExercises(rows: ExerciseRowInput[]) {
    if (this.fail) throw this.fail;
    for (const r of rows) this.exercises.set(`${r.user_id}|${r.source}|${r.external_id}`, r);
  }
  async upsertBiometrics(rows: BiometricRowInput[]) {
    if (this.fail) throw this.fail;
    for (const r of rows) this.biometrics.set(`${r.user_id}|${r.source}|${r.external_id}`, r);
  }
}

describe('adapters', () => {
  it('energy keeps unknown as null (never a fake 0)', () => {
    expect(toDailyEnergyPoints([{ date: '2026-11-09', activeKcal: 600, steps: 9000 }])).toEqual([
      { date: '2026-11-09', activeKcal: 600, restingKcal: null, steps: 9000 },
    ]);
  });

  it('a workout uses Garmin\'s GMT start when it has one, else the wall clock of this phone', () => {
    const start = Date.UTC(2026, 10, 9, 6, 30, 0);
    const [withGmt] = toWorkoutPoints([{ externalId: 'garmin:activity:1', name: 'Run', typeKey: 'running', date: '2026-11-09', startLocal: '2026-11-09 07:30:00', startMs: start, durationSec: 1800, kcal: 412 }]);
    expect(withGmt).toEqual({
      externalId: 'garmin:activity:1',
      date: '2026-11-09',
      startedAt: '2026-11-09T06:30:00.000Z',
      endedAt: '2026-11-09T07:00:00.000Z',
      name: 'Run',
      minutes: 30,
      kcal: 412,
    });
    const [local] = toWorkoutPoints([{ externalId: 'garmin:activity:2', name: 'Walk', typeKey: 'walking', date: '2026-11-09', startLocal: '2026-11-09 18:00:00', durationSec: 600 }]);
    expect(local?.startedAt).toBe(new Date(2026, 10, 9, 18, 0, 0).toISOString());
    expect(local?.kcal).toBe(0);
    expect(localWallClockMs('nonsense')).toBeNull();
  });

  it('a biometric without a timestamp is recorded at local noon of its day', () => {
    const [b] = toBiometricPoints([{ date: '2026-11-09', type: 'stress', value: 31, unit: 'score', externalId: 'garmin:stress:2026-11-09' }]);
    expect(b?.recordedAt).toBe(new Date(2026, 10, 9, 12, 0, 0).toISOString());
  });
});

describe('writeGarminBatch', () => {
  const batch = {
    label: '2026-11-09',
    energy: [{ date: '2026-11-09', activeKcal: 612.4, restingKcal: 2038, totalKcal: 2650, steps: 9876 }],
    workouts: [{ externalId: 'garmin:activity:1', name: 'Morning run', typeKey: 'running', date: '2026-11-09', startLocal: '2026-11-09 06:30:00', startMs: Date.UTC(2026, 10, 9, 5, 30), durationSec: 1801, kcal: 412 }],
    biometrics: [
      { date: '2026-11-09', type: 'resting_heart_rate' as const, value: 52, unit: 'bpm', externalId: 'garmin:resting_heart_rate:2026-11-09' },
      { date: '2026-11-09', type: 'sleep' as const, value: 8.67, unit: 'hr', externalId: 'garmin:sleep:2026-11-09', recordedAtMs: Date.UTC(2026, 10, 9, 5), meta: { score: 93, staged: true } },
      { date: '2026-11-09', type: 'stress' as const, value: 31, unit: 'score', externalId: 'garmin:stress:2026-11-09' },
    ],
  };

  it('writes source = garmin rows in the shapes the app already uses', async () => {
    const w = new MemoryWriter();
    const written = await writeGarminBatch(w, USER, batch);
    expect([...w.energy.values()]).toEqual([
      { user_id: USER, local_date: '2026-11-09', source: 'garmin', active_kcal: 612, resting_kcal: 2038, steps: 9876 },
    ]);
    const [run] = [...w.exercises.values()];
    expect(run).toMatchObject({
      user_id: USER,
      entry_date: '2026-11-09',
      activity_code: null,
      name: 'Morning run',
      minutes: 30,
      kcal: 412,
      source: 'garmin',
      external_id: 'garmin:activity:1',
      started_at: '2026-11-09T05:30:00.000Z',
      ended_at: '2026-11-09T06:00:01.000Z',
      counts_toward_energy: false,
    });
    expect([...w.biometrics.values()].map((b) => [b.type, b.value, b.unit, b.source, b.external_id])).toEqual([
      ['resting_heart_rate', 52, 'bpm', 'garmin', 'garmin:resting_heart_rate:2026-11-09'],
      ['sleep', 8.67, 'hr', 'garmin', 'garmin:sleep:2026-11-09'],
      ['stress', 31, 'score', 'garmin', 'garmin:stress:2026-11-09'],
    ]);
    expect(w.biometrics.get(`${USER}|garmin|garmin:sleep:2026-11-09`)?.meta).toEqual({ score: 93, staged: true });
    expect(written).toEqual({
      energyDates: ['2026-11-09'],
      workoutIds: ['garmin:activity:1'],
      biometrics: [
        { type: 'resting_heart_rate', externalId: 'garmin:resting_heart_rate:2026-11-09' },
        { type: 'sleep', externalId: 'garmin:sleep:2026-11-09' },
        { type: 'stress', externalId: 'garmin:stress:2026-11-09' },
      ],
    });
  });

  it('the day\'s totals are cumulative: a later pull REPLACES the stored values, it is never added', async () => {
    const w = new MemoryWriter();
    await writeGarminBatch(w, USER, { ...batch, workouts: [], biometrics: [], energy: [{ date: '2026-11-09', activeKcal: 120, restingKcal: 801, steps: 2400 }] });
    await writeGarminBatch(w, USER, { ...batch, workouts: [], biometrics: [], energy: [{ date: '2026-11-09', activeKcal: 612, restingKcal: 2038, steps: 9876 }] });
    expect(w.energy.size).toBe(1);
    expect([...w.energy.values()][0]).toMatchObject({ active_kcal: 612, resting_kcal: 2038, steps: 9876 });
  });

  it('a re-sync updates the workout and the weigh-in instead of duplicating them', async () => {
    const w = new MemoryWriter();
    await writeGarminBatch(w, USER, batch);
    await writeGarminBatch(w, USER, { ...batch, workouts: batch.workouts.map((x) => ({ ...x, kcal: 430 })) });
    expect(w.exercises.size).toBe(1);
    expect([...w.exercises.values()][0]?.kcal).toBe(430);
    expect(w.biometrics.size).toBe(3);
  });

  it('keeps Garmin and Apple Health rows of the same day apart (different source = different row)', async () => {
    const w = new MemoryWriter();
    await writeGarminBatch(w, USER, batch);
    w.energy.set(`${USER}|2026-11-09|apple_health`, { user_id: USER, local_date: '2026-11-09', source: 'apple_health', active_kcal: 500, resting_kcal: 1800, steps: 8000 });
    expect(w.energy.size).toBe(2);
  });

  it('drops empty rows and writes nothing for an empty batch', async () => {
    const w = new MemoryWriter();
    const written = await writeGarminBatch(w, USER, { label: 'x', energy: [{ date: '2026-11-09' }], workouts: [], biometrics: [] });
    expect(written).toEqual({ energyDates: [], workoutIds: [], biometrics: [] });
    expect(w.upserts).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// one whole run
// ---------------------------------------------------------------------------------------------------------------------

const NOW = new Date(2026, 10, 10, 12, 0, 0).getTime();
const SECRETS = ['ACCESS-TOKEN-SECRET', 'REFRESH-TOKEN-SECRET', 'ROTATED-REFRESH-SECRET', 'ROTATED-ACCESS-SECRET'];

const SUMMARY = { restingHeartRate: 52, totalSteps: 9000, averageStressLevel: 31, totalKilocalories: 2650, activeKilocalories: 612, bmrKilocalories: 2038 };
const ok = (data: unknown) => ({ status: 200, empty: false, data });

interface Harness {
  deps: GarminDeps;
  writer: MemoryWriter;
  row: { value: GarminIntegrationRow | null };
  patches: GarminIntegrationPatch[];
  local: { value: GarminLocalState };
  localPatches: Partial<GarminLocalState>[];
  tokens: { value: GarminTokens | null; user: string | null };
  clock: { t: number };
  calls: string[];
  clientsCreated: number;
  progress: string[];
}

function harness(opts: {
  signedIn?: boolean;
  row?: GarminIntegrationRow | null;
  hasTokens?: boolean;
  source?: Partial<GarminSyncSource>;
  local?: GarminLocalState;
  rotate?: boolean;
} = {}): Harness {
  const writer = new MemoryWriter();
  const h: Harness = {
    writer,
    row: { value: opts.row === undefined ? { enabled: true, settings: { connected_at: '2026-11-01T00:00:00Z' }, last_sync_at: null } : opts.row },
    patches: [],
    local: { value: opts.local ?? EMPTY_LOCAL_STATE },
    localPatches: [],
    tokens: { value: opts.hasTokens === false ? null : TOKENS, user: USER },
    clock: { t: NOW },
    calls: [],
    clientsCreated: 0,
    progress: [],
    deps: undefined as unknown as GarminDeps,
  };
  const source: GarminSyncSource = {
    profile: async () => (h.calls.push('profile'), ok({ displayName: 'user-1' })),
    userSummary: async (_n, date) => (h.calls.push(`summary ${date}`), ok(SUMMARY)),
    sleep: async (_n, date) => (h.calls.push(`sleep ${date}`), ok({ dailySleepDTO: { sleepTimeSeconds: 27000, sleepScores: { overall: { value: 81 } } } })),
    hrv: async (date) => (h.calls.push(`hrv ${date}`), ok({ hrvSummary: { lastNightAvg: 62 } })),
    weightRange: async () => (h.calls.push('weight'), ok({ dateWeightList: [{ samplePk: 1, calendarDate: '2026-11-09', weight: 81500 }] })),
    activities: async () => (h.calls.push('activities'), ok([{ activityId: 7, startTimeLocal: '2026-11-09 06:30:00', duration: 1800, calories: 300, activityType: { typeKey: 'running' } }])),
    ...opts.source,
  };
  h.deps = {
    now: () => h.clock.t,
    today: () => '2026-11-10',
    userId: async () => (opts.signedIn === false ? null : USER),
    integration: {
      load: async () => h.row.value,
      save: async (_u, patch) => {
        h.patches.push(patch);
        const cur = h.row.value ?? { enabled: false, settings: {}, last_sync_at: null };
        h.row.value = {
          enabled: patch.enabled ?? cur.enabled,
          settings: patch.settings ?? cur.settings,
          last_sync_at: patch.last_sync_at === undefined ? cur.last_sync_at : patch.last_sync_at,
        };
        return h.row.value;
      },
    },
    tokens: {
      load: async (userId) => (userId === h.tokens.user ? h.tokens.value : null),
      save: async (userId, t) => {
        h.tokens.value = t;
        h.tokens.user = userId;
      },
      clear: async () => {
        h.tokens.value = null;
      },
    },
    local: {
      load: async () => h.local.value,
      save: async (patch) => {
        h.localPatches.push(patch);
        h.local.value = { ...h.local.value, ...patch };
      },
    },
    createClient: (tokens, onTokensChanged) => {
      h.clientsCreated += 1;
      if (opts.rotate) {
        // what GarminConnectClient does on a refresh: hand the rotated pair to the callback and carry on with it
        const rotated = { ...tokens, diToken: 'ROTATED-ACCESS-SECRET', diRefreshToken: 'ROTATED-REFRESH-SECRET' };
        const original = source.profile;
        source.profile = async () => {
          await onTokensChanged(rotated);
          return original();
        };
      }
      return source;
    },
    writer,
    appInfo: 'Cal Track 0.1.0 (ios)',
    onProgress: (m) => h.progress.push(m),
  };
  return h;
}

const everything = (h: Harness, extra: unknown) => JSON.stringify([h.patches, h.localPatches, h.local.value, extra, [...h.writer.energy.values()], [...h.writer.exercises.values()], [...h.writer.biometrics.values()]]);

describe('executeGarminSync: before it reads anything', () => {
  it('skips when signed out, not connected, waiting for a new sign-in, without a token on this phone, or rate limited', async () => {
    const cases: Array<[string, Harness, string]> = [
      ['signed out', harness({ signedIn: false }), 'signed_out'],
      ['no row', harness({ row: null }), 'not_connected'],
      ['switched off', harness({ row: { enabled: false, settings: {}, last_sync_at: null } }), 'not_connected'],
      ['needs sign-in', harness({ row: { enabled: true, settings: { needs_sign_in: true }, last_sync_at: null } }), 'needs_sign_in'],
      ['no tokens on this phone', harness({ hasTokens: false }), 'not_connected'],
      ['rate limited', harness({ local: { ...EMPTY_LOCAL_STATE, rateLimitedUntilMs: NOW + 60_000 } }), 'rate_limited'],
    ];
    for (const [name, h, reason] of cases) {
      const out = await executeGarminSync(h.deps, { mode: 'incremental' });
      expect(out, name).toMatchObject({ status: 'skipped', reason });
      expect(h.clientsCreated, name).toBe(0);
      expect(h.calls, name).toEqual([]);
      expect(h.writer.upserts, name).toBe(0);
    }
  });

  it('runs again once the rate-limit time has passed', async () => {
    const h = harness({ local: { ...EMPTY_LOCAL_STATE, rateLimitedUntilMs: NOW + 60_000 } });
    h.clock.t = NOW + 60_001;
    expect((await executeGarminSync(h.deps, { mode: 'incremental' })).status).toBe('done');
  });
});

describe('executeGarminSync: a good run', () => {
  it('right after sign-in reads the last 14 days (paced by the client), writes them, and books the result', async () => {
    const h = harness({ row: { enabled: true, settings: { connected_at: '2026-11-10T08:00:00Z', keep: 1 }, last_sync_at: null } });
    const out = await executeGarminSync(h.deps, { mode: 'backfill' });
    expect(out).toMatchObject({ status: 'done', complete: true, range: { from: '2026-10-28', to: '2026-11-10' } });
    expect(h.calls.filter((c) => c.startsWith('summary'))).toHaveLength(14);
    expect(h.calls[0]).toBe('profile');
    expect(h.calls.filter((c) => c.startsWith('summary'))[0]).toBe('summary 2026-11-10'); // newest first

    // rows: source garmin, one energy row per day, workouts informational
    expect(h.writer.energy.size).toBe(14);
    expect([...h.writer.energy.values()].every((r) => r.source === 'garmin' && r.user_id === USER)).toBe(true);
    expect([...h.writer.exercises.values()].every((r) => r.counts_toward_energy === false && r.source === 'garmin')).toBe(true);
    const types = new Set([...h.writer.biometrics.values()].map((b) => b.type));
    expect([...types].sort()).toEqual(['hrv', 'resting_heart_rate', 'sleep', 'sleep_score', 'stress', 'weight']);

    // booking: summary sentence, last_sync_at moved, settings kept, no tokens anywhere
    const saved = h.row.value;
    expect(saved?.last_sync_at).toBe(new Date(NOW).toISOString());
    expect(saved?.settings).toMatchObject({ keep: 1, needs_sign_in: false, connected_at: '2026-11-10T08:00:00Z' });
    expect((saved?.settings as { last_summary: string }).last_summary).toMatch(/14 days of energy, 1 workout, 1 weight/);
    expect(h.local.value.lastIssue).toBeNull();
    expect(h.local.value.rateLimitedUntilMs).toBeNull();
    expect(h.progress).toContain('Looking up your Garmin account');
    expect(h.progress.some((m) => /^Reading 2026-11-10 \(1 of 14\)$/.test(m))).toBe(true);
  });

  it('later runs re-read only the last days', async () => {
    const h = harness({ row: { enabled: true, settings: {}, last_sync_at: new Date(2026, 10, 10, 9, 0, 0).toISOString() } });
    const out = await executeGarminSync(h.deps, { mode: 'incremental' });
    expect(out).toMatchObject({ status: 'done', range: { from: '2026-11-08', to: '2026-11-10' } });
    expect(h.calls.filter((c) => c.startsWith('summary'))).toEqual(['summary 2026-11-10', 'summary 2026-11-09', 'summary 2026-11-08']);
  });

  it('persists a rotated refresh token before going on', async () => {
    const h = harness({ rotate: true });
    await executeGarminSync(h.deps, { mode: 'incremental' });
    expect(h.tokens.value).toMatchObject({ diToken: 'ROTATED-ACCESS-SECRET', diRefreshToken: 'ROTATED-REFRESH-SECRET' });
  });

  it('keeps a copy of the report for "Copy sync report": endpoints and fields, no values and no tokens', async () => {
    const h = harness({ rotate: true });
    await executeGarminSync(h.deps, { mode: 'incremental' });
    const report = h.local.value.report ?? '';
    expect(report).toContain('Cal Track - Garmin sync report');
    expect(report).toContain('App: Cal Track 0.1.0 (ios)');
    expect(report).toContain('userSummary: /usersummary-service/usersummary/daily/{displayName}?calendarDate={date}');
    expect(report).toContain('found 14 of 14 via totalSteps');
    for (const value of ['9000', '2650', '2038', '612', 'user-1', '81500', '81.5']) expect(report, value).not.toContain(value);
    for (const secret of SECRETS) expect(report, secret).not.toContain(secret);
  });

  it('a cancelled run saves what it read but does not move last_sync_at', async () => {
    const h = harness();
    let n = 0;
    const out = await executeGarminSync(h.deps, { mode: 'backfill', isCancelled: () => ++n > 8 });
    expect(out).toMatchObject({ status: 'done', complete: false });
    expect(h.row.value?.last_sync_at).toBeNull();
    expect(h.writer.energy.size).toBeGreaterThan(0);
  });
});

describe('executeGarminSync: when Garmin says no', () => {
  const failing = (error: GarminError): Partial<GarminSyncSource> => ({
    userSummary: async () => {
      throw error;
    },
  });

  it('HTTP 400 / 401 from the refresh = a dead session: tokens deleted, integration marked, run stopped, no retry loop', async () => {
    const h = harness({ source: failing(new GarminError({ kind: 'session_dead', status: 401 })) });
    const out = await executeGarminSync(h.deps, { mode: 'incremental' });
    expect(out).toMatchObject({ status: 'failed', code: 'needs_sign_in', error: GARMIN_SIGNED_OUT_NOTE });
    expect(h.tokens.value).toBeNull();
    expect(h.row.value?.enabled).toBe(true); // the user still wants Garmin
    expect(parseGarminSettings(h.row.value?.settings).needsSignIn).toBe(true);
    expect(h.row.value?.last_sync_at).toBeNull();
    expect(h.calls.filter((c) => c.startsWith('summary'))).toEqual([]); // stopped at the first failing request
    expect(deriveGarminState({ native: true, row: h.row.value, hasTokens: h.tokens.value !== null })).toBe('needs_sign_in');

    // every later run is skipped without a single request to Garmin, until the user signs in again
    const again = await executeGarminSync(h.deps, { mode: 'incremental' });
    expect(again).toMatchObject({ status: 'skipped', reason: 'needs_sign_in' });
    expect(h.clientsCreated).toBe(1);
  });

  it('HTTP 429 stops the run, remembers the time (Retry-After within limits) and blocks later runs until then', async () => {
    let days = 0;
    const h = harness({
      source: {
        userSummary: async (_n, date) => {
          days += 1;
          if (days === 3) throw new GarminError({ kind: 'rate_limited', status: 429, retryAfterSeconds: 20 * 60 });
          h.calls.push(`summary ${date}`);
          return ok(SUMMARY);
        },
      },
    });
    const out = await executeGarminSync(h.deps, { mode: 'backfill' });
    const until = NOW + 20 * 60_000;
    expect(out).toMatchObject({ status: 'failed', code: 'rate_limited' });
    expect((out as { error: string }).error).toContain('slow down');
    expect(h.local.value.rateLimitedUntilMs).toBe(until);
    expect(h.local.value.lastIssue).toContain('slow down');
    // the two days before the 429 were saved; the run did not pretend to be complete
    expect(h.writer.energy.size).toBe(2);
    expect(h.row.value?.last_sync_at).toBeNull();
    expect(h.tokens.value).not.toBeNull(); // a 429 is not a dead session
    expect((out as { summary: string | null }).summary).toMatch(/2 days of energy/);

    h.clock.t = NOW + 10 * 60_000;
    expect(await executeGarminSync(h.deps, { mode: 'incremental' })).toMatchObject({ status: 'skipped', reason: 'rate_limited' });
    h.clock.t = until + 1;
    days = 99;
    expect((await executeGarminSync(h.deps, { mode: 'incremental' })).status).toBe('done');
    expect(h.local.value.rateLimitedUntilMs).toBeNull();
  });

  it('a dropped network is reported plainly and is not a reason to sign in again', async () => {
    const h = harness({ source: failing(new GarminError({ kind: 'network' })) });
    const out = await executeGarminSync(h.deps, { mode: 'incremental' });
    expect(out).toMatchObject({ status: 'failed', code: 'network' });
    expect((out as { error: string }).error).toContain('Could not reach Garmin');
    expect(h.tokens.value).not.toBeNull();
    expect(parseGarminSettings(h.row.value?.settings).needsSignIn).toBe(false);
    expect(h.row.value?.last_sync_at).toBeNull();
  });

  it('a failing database write ends the run with the reason', async () => {
    const h = harness();
    h.writer.fail = Object.assign(new Error('JWT expired'), { code: 'PGRST301' });
    const out = await executeGarminSync(h.deps, { mode: 'incremental' });
    expect(out).toMatchObject({ status: 'failed', code: 'write_failed' });
    expect((out as { error: string }).error).toContain('JWT expired');
    expect(h.row.value?.last_sync_at).toBeNull();
    expect(h.tokens.value).not.toBeNull();
  });

  it('nothing that was saved or returned contains a token, even when Garmin\'s error text echoes one', async () => {
    const leak = new GarminError({ kind: 'server', status: 500, message: `boom ${TOKENS.diToken} ${TOKENS.diRefreshToken}`, secrets: [TOKENS.diToken, TOKENS.diRefreshToken] });
    for (const source of [failing(leak), failing(new GarminError({ kind: 'session_dead', status: 400 })), failing(new GarminError({ kind: 'rate_limited', status: 429 }))]) {
      const h = harness({ rotate: true, source });
      const out = await executeGarminSync(h.deps, { mode: 'backfill' });
      const text = everything(h, out);
      for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// guards over the source itself
// ---------------------------------------------------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

describe('source guards', () => {
  const appSrc = join(repoRoot, 'apps', 'app', 'src');
  const garminFiles = walk(appSrc).filter((f) => /garmin/i.test(relative(appSrc, f)));
  const rel = (f: string) => relative(repoRoot, f);

  it('finds the Garmin files (guards against a broken filter)', () => {
    expect(garminFiles.map(rel)).toEqual(expect.arrayContaining([
      'apps/app/src/health/garmin.ts',
      'apps/app/src/health/garmin-runner.ts',
      'apps/app/src/health/garmin-token-store.ts',
      'apps/app/src/data/garmin.ts',
      'apps/app/src/components/health/GarminCard.tsx',
      'apps/app/src/app/settings/garmin-sign-in.tsx',
    ]));
  });

  it('no Garmin file logs anything (tokens must never reach a log)', () => {
    for (const f of garminFiles) expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });

  it('only the token store (and the package) names the token fields; nothing else can put one into Supabase or a log', () => {
    const allowed = new Set(['apps/app/src/health/garmin-token-store.ts']);
    for (const f of garminFiles) {
      if (allowed.has(rel(f))) continue;
      expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(/diToken|diRefreshToken|refresh_token|access_token|accessToken|refreshToken/);
    }
  });

  it('Supabase is touched only by the runner glue and the sign-in/out actions; the tokens are stored in the secure store only', () => {
    const usesSupabase = garminFiles.filter((f) => /from '@\/lib\/supabase'/.test(readFileSync(f, 'utf8'))).map(rel);
    expect(usesSupabase).toEqual(['apps/app/src/health/garmin-actions.ts']);
    const tokensFile = readFileSync(join(appSrc, 'health', 'garmin-tokens.ts'), 'utf8');
    expect(tokensFile).toContain("from 'expo-secure-store'");
    expect(tokensFile).not.toMatch(/from '@react-native-async-storage/);
    const withoutComments = readFileSync(join(appSrc, 'health', 'garmin-local.ts'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(withoutComments).not.toMatch(/token/i); // the phone-local state has no place for one
  });

  it('"delete imported data" deletes by the garmin source for the signed-in user only', () => {
    const actions = readFileSync(join(appSrc, 'health', 'garmin-actions.ts'), 'utf8');
    expect(actions).toContain(".delete().eq('user_id', userId).eq('source', 'garmin')");
    expect(actions.match(/\.delete\(\)/g)).toHaveLength(1);
  });

  it('the web build has no feature flag and no Garmin edge function or rpc calls any more', () => {
    for (const f of walk(appSrc)) {
      const text = readFileSync(f, 'utf8');
      expect(text, rel(f)).not.toContain('EXPO_PUBLIC_GARMIN_ENABLED');
      expect(text, rel(f)).not.toMatch(/garmin_connection_status|garmin-oauth|garmin-webhook|garmin-disconnect/);
    }
  });

  it('the Garmin package sends a POST to the token endpoint only, and a GET to everything else', () => {
    const pkg = join(repoRoot, 'packages', 'garmin', 'src');
    const methodUses: Record<string, string[]> = {};
    for (const f of walk(pkg)) {
      const hits = [...readFileSync(f, 'utf8').matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1] as string);
      if (hits.length > 0) methodUses[relative(pkg, f)] = hits;
    }
    // auth.ts: the type of a token request and the two builders (refresh, ticket exchange); client.ts: every data request;
    // http.ts: the `'GET' | 'POST'` union of the injectable fetch (the regex sees its first member).
    expect(methodUses).toEqual({ 'auth.ts': ['POST', 'POST', 'POST'], 'client.ts': ['GET'], 'http.ts': ['GET'] });
  });

  it('nothing of the reference\'s write endpoints was ported (no workout-service, no create_workout)', () => {
    const pkg = join(repoRoot, 'packages', 'garmin', 'src');
    for (const f of walk(pkg)) {
      const text = readFileSync(f, 'utf8');
      expect(text, rel(f)).not.toMatch(/['"`][^'"`\n]*workout-service/); // no endpoint path
      expect(text, rel(f)).not.toMatch(/\bcreate_?[Ww]orkout\s*[(:]/); // no method (a comment saying it is not ported is fine)
    }
  });
});
