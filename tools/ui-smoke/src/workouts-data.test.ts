/**
 * The data layer of the Workouts section against the mock backend through the real supabase-js client, so a column or a filter the real
 * database (PostgREST) would reject fails here too:
 *  - data/workouts.ts: the paged list (newest first, source filters, only two keys of `details`), one workout with its details,
 *    saving details, the helpers for the quiet pass and the coach
 *  - health/writer.ts: the Garmin sync fills `details` with the list summary and never replaces full details
 *  - ai/workout-context.ts: the coach's workout text, with the Garmin runner replaced by a fake (Garmin is never called)
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ANON_KEY, BACKEND_ORIGIN, FIXED_NOW_MS, STORAGE_KEY, TODAY } from './constants';
import { GARMIN_RUN_SUMMARY, GARMIN_STRENGTH_DETAILS, IDS, USER, buildFixtures, localIso } from './fixtures';
import { createMockBackend } from './mock-backend';
import { SEED_SESSION_TTL_SECONDS, buildSession } from './session';

const holder = vi.hoisted(() => ({ client: null as any, runner: { calls: [] as string[], outcome: null as any } }));

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: true,
  supabase: new Proxy({}, { get: (_target, prop) => holder.client[prop] }),
}));

// The coach's lazy read goes through the Garmin runner, which needs the phone (secure storage, fetch). A fake stands in for it.
vi.mock('@/health/garmin-details-runner', () => ({
  ensureWorkoutDetails: async (target: { id: string }) => {
    holder.runner.calls.push(target.id);
    return holder.runner.outcome ?? { status: 'skipped', reason: 'unavailable', message: 'x' };
  },
}));

const here = dirname(fileURLToPath(import.meta.url));
const appRequire = createRequire(join(here, '..', '..', '..', 'apps', 'app', 'package.json'));

async function loadSupabase(): Promise<{ createClient: (url: string, key: string, options: unknown) => any } | null> {
  try {
    return (await import(pathToFileURL(appRequire.resolve('@supabase/supabase-js')).href)) as never;
  } catch {
    return null;
  }
}

const lib = await loadSupabase();

/** App modules are untyped here on purpose (this package's tsconfig knows nothing about React Native). */
const load = (specifier: string): Promise<any> => import(/* @vite-ignore */ specifier);

function connect(extraRows: Record<string, unknown>[] = [], variant: Parameters<typeof buildFixtures>[0] = 'default') {
  const fx = buildFixtures(variant);
  fx.seed.tables.exercise_entries = [...(fx.seed.tables.exercise_entries ?? []), ...extraRows] as never;
  const backend = createMockBackend(fx.seed);
  const session = buildSession(USER, { nowMs: FIXED_NOW_MS, ttlSeconds: SEED_SESSION_TTL_SECONDS });
  const store = new Map<string, string>([[STORAGE_KEY, JSON.stringify(session)]]);
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const res = backend.handle({ method: req.method, url: req.url, headers, body: init?.body == null ? null : String(init.body) });
    return new Response(res.body === '' || res.status === 204 ? null : res.body, { status: res.status, headers: res.headers });
  };
  holder.client = (lib as NonNullable<typeof lib>).createClient(BACKEND_ORIGIN, ANON_KEY, {
    auth: {
      storage: { getItem: async (k: string) => store.get(k) ?? null, setItem: async (k: string, v: string) => void store.set(k, v), removeItem: async (k: string) => void store.delete(k) },
      autoRefreshToken: false,
      persistSession: true,
      detectSessionInUrl: false,
    },
    global: { fetch: fetchImpl },
  });
  return { backend, fx };
}

/** `n` extra manual workouts, one per day going back from `from`, so the list has more than one page. */
function manyRows(n: number, from = '2026-09-30'): Record<string, unknown>[] {
  const [y, m, d] = from.split('-').map(Number) as [number, number, number];
  return Array.from({ length: n }, (_, i) => {
    const day = new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10);
    return {
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      user_id: USER.id,
      entry_date: day,
      name: `Gym ${i + 1}`,
      minutes: 30,
      kcal: 100,
      source: 'manual',
      counts_toward_energy: true,
    };
  });
}

const suite = lib ? describe : describe.skip;

beforeEach(() => {
  holder.runner.calls = [];
  holder.runner.outcome = null;
});

suite('data/workouts.ts against the mock backend', () => {
  it('lists every exercise entry newest first (by day, then by start time), with two keys of the details', async () => {
    const { fetchWorkoutsPage } = await load('@/data/workouts');
    const { backend } = connect();
    const page = await fetchWorkoutsPage(0, 'all');
    expect(page.map((r: any) => r.id)).toEqual([
      IDS.workout.strength, // today 09:00
      IDS.workout.run, // today 07:00
      IDS.workout.walk, // yesterday
      IDS.workout.garminStrength, // two days ago
      IDS.workout.garminRun, // five days ago
      IDS.workout.garminOld, // twelve days ago
    ]);
    const strength = page.find((r: any) => r.id === IDS.workout.garminStrength);
    expect(strength).toMatchObject({ name: 'Strength training', source: 'garmin', avg_hr: 118, type_key: 'strength_training', minutes: 50, kcal: 245, counts_toward_energy: false });
    expect(page.find((r: any) => r.id === IDS.workout.run)).toMatchObject({ avg_hr: null, type_key: null, source: 'manual' });
    // the list never loads the whole details object
    expect(Object.keys(strength)).not.toContain('details');
    const query = decodeURIComponent(backend.calls.find((c) => c.target === 'exercise_entries')?.query ?? '');
    expect(query).toContain('details->avgHr');
    expect(query).not.toMatch(/select=[^&]*\bdetails\b(?!->)/);
    expect(backend.unhandled).toEqual([]);
    expect(backend.warnings).toEqual([]);
  });

  it('filters by source: Garmin, the phone health app (Apple Health + Health Connect), manual', async () => {
    const { fetchWorkoutsPage } = await load('@/data/workouts');
    const { backend } = connect([
      { id: stableId(901), user_id: USER.id, entry_date: TODAY, name: 'Hike', minutes: 120, kcal: 600, source: 'health_connect', external_id: 'hc-1', counts_toward_energy: false },
    ]);
    const ids = async (filter: string) => (await fetchWorkoutsPage(0, filter)).map((r: any) => r.source);
    expect((await ids('garmin')).sort()).toEqual(['garmin', 'garmin', 'garmin']);
    expect((await ids('health')).sort()).toEqual(['apple_health', 'health_connect']);
    expect((await ids('manual')).sort()).toEqual(['manual', 'manual']);
    expect(await ids('all')).toHaveLength(7);
    expect(backend.calls.filter((c) => c.status >= 400)).toEqual([]);
  });

  it('pages 50 at a time with an offset, and the last page is short', async () => {
    const { fetchWorkoutsPage, WORKOUT_PAGE_SIZE } = await load('@/data/workouts');
    connect(manyRows(120));
    expect(WORKOUT_PAGE_SIZE).toBe(50);
    const p1 = await fetchWorkoutsPage(0, 'all');
    const p2 = await fetchWorkoutsPage(50, 'all');
    const p3 = await fetchWorkoutsPage(100, 'all');
    expect([p1.length, p2.length, p3.length]).toEqual([50, 50, 26]); // 6 fixture rows + 120
    const all = [...p1, ...p2, ...p3];
    expect(new Set(all.map((r: any) => r.id)).size).toBe(126);
    const dates = all.map((r: any) => r.entry_date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('a workout without a start time comes after the timed ones of its day', async () => {
    const { fetchWorkoutsPage } = await load('@/data/workouts');
    connect([{ id: stableId(902), user_id: USER.id, entry_date: TODAY, name: 'No clock', minutes: 10, kcal: 50, source: 'manual', counts_toward_energy: true }]);
    const page = await fetchWorkoutsPage(0, 'all');
    expect(page.slice(0, 3).map((r: any) => r.name)).toEqual(['Traditional Strength Training', 'Running, treadmill, general', 'No clock']);
  });

  it('opens one workout with its parsed details', async () => {
    const { fetchWorkout } = await load('@/data/workouts');
    const { backend } = connect();
    const w = await fetchWorkout(IDS.workout.garminStrength);
    expect(w).toMatchObject({ id: IDS.workout.garminStrength, name: 'Strength training', source: 'garmin', external_id: 'garmin:activity:12345678901', minutes: 50, kcal: 245 });
    expect(w.details).toMatchObject({ v: 1, level: 'full', avgHr: 118, typeKey: 'strength_training' });
    expect(w.details.sets).toHaveLength(11);
    expect(w.details.hrZones).toHaveLength(5);
    expect((await fetchWorkout(IDS.workout.run)).details).toBeNull();
    expect((await fetchWorkout(IDS.workout.garminRun)).details).toMatchObject({ level: 'summary' });
    expect(backend.calls.filter((c) => c.status >= 400)).toEqual([]);
  });

  it('an unknown id is null; something that is not an id never reaches the database', async () => {
    const { fetchWorkout } = await load('@/data/workouts');
    const { backend } = connect();
    expect(await fetchWorkout(IDS.missing)).toBeNull();
    const before = backend.calls.length;
    for (const bad of ['not-an-id', '', "1' or '1'='1", '../x']) expect(await fetchWorkout(bad)).toBeNull();
    expect(backend.calls.length).toBe(before);
  });

  it('unreadable details in the database are simply no details (never a crash)', async () => {
    const { fetchWorkout } = await load('@/data/workouts');
    connect([
      { id: stableId(903), user_id: USER.id, entry_date: TODAY, name: 'Odd', minutes: 10, kcal: 50, source: 'garmin', external_id: 'garmin:activity:5', counts_toward_energy: false, details: { v: 7, source: 'garmin', surprise: true } },
    ]);
    expect((await fetchWorkout(stableId(903))).details).toBeNull();
  });

  it('saves details into the row and nothing else', async () => {
    const { saveWorkoutDetails, fetchWorkout } = await load('@/data/workouts');
    const { backend } = connect();
    const before = { ...backend.rows('exercise_entries').find((r) => r.id === IDS.workout.garminOld) };
    const details = { v: 1, source: 'garmin', level: 'full', fetchedAt: '2026-11-10T11:00:00.000Z', typeKey: 'cycling', avgHr: 131, distanceM: 28000 };
    await saveWorkoutDetails(IDS.workout.garminOld, details);
    const after = backend.rows('exercise_entries').find((r) => r.id === IDS.workout.garminOld) as Record<string, unknown>;
    expect(after.details).toEqual(details);
    expect({ ...after, details: undefined }).toEqual({ ...before, details: undefined });
    const m = backend.mutationsOf('exercise_entries', 'update');
    expect(m).toHaveLength(1);
    expect(Object.keys(m[0]?.payload as object)).toEqual(['details']);
    expect((await fetchWorkout(IDS.workout.garminOld)).details).toMatchObject({ avgHr: 131 });
  });

  it('the newest Garmin workouts for the quiet pass, and the workouts up to a day for the coach', async () => {
    const { fetchNewestGarminWorkouts, fetchWorkoutsUpTo } = await load('@/data/workouts');
    const { pickQuietTargets } = await load('@/health/garmin-details');
    connect();
    const garmin = await fetchNewestGarminWorkouts(12);
    expect(garmin.map((r: any) => r.id)).toEqual([IDS.workout.garminStrength, IDS.workout.garminRun, IDS.workout.garminOld]);
    // strength has full details: the quiet pass takes the summary-only run and the one without details
    expect(pickQuietTargets(garmin).map((r: any) => r.id)).toEqual([IDS.workout.garminRun, IDS.workout.garminOld]);
    const upTo = await fetchWorkoutsUpTo('2026-11-08');
    expect(upTo.map((r: any) => r.id)).toEqual([IDS.workout.garminStrength, IDS.workout.garminRun, IDS.workout.garminOld]);
  });
});

suite('health/writer.ts: the sync fills details with the list summary and keeps full details', () => {
  const SUMMARY = { v: 1, source: 'garmin', level: 'summary', fetchedAt: '2026-11-10T11:30:00.000Z', typeKey: 'strength_training', avgHr: 121 };
  const row = (external_id: string, over: Record<string, unknown> = {}) => ({
    user_id: USER.id,
    entry_date: TODAY,
    activity_code: null,
    name: 'Strength training',
    minutes: 50,
    kcal: 245,
    source: 'garmin',
    external_id,
    started_at: localIso(TODAY, '08:00'),
    ended_at: localIso(TODAY, '08:50'),
    counts_toward_energy: false,
    ...over,
  });

  it('new rows keep their details; rows without details stay without', async () => {
    const { createSupabaseWriter } = await load('@/health/writer');
    const { backend } = connect();
    await createSupabaseWriter().upsertExercises([row('garmin:activity:1', { details: SUMMARY }), row('garmin:activity:2')]);
    const rows = backend.rows('exercise_entries');
    expect(rows.find((r) => r.external_id === 'garmin:activity:1')?.details).toEqual(SUMMARY);
    expect(rows.find((r) => r.external_id === 'garmin:activity:2')?.details).toBeNull();
    expect(backend.mutations.filter((m) => !m.ok)).toEqual([]);
  });

  it('an existing row without details gets the summary; a summary is replaced by a newer one; FULL details are never replaced', async () => {
    const { createSupabaseWriter } = await load('@/health/writer');
    const { backend } = connect();
    const newer = { ...SUMMARY, avgHr: 125, fetchedAt: '2026-11-10T12:00:00.000Z' };
    // the three fixture Garmin rows: full (strength), summary (run), none (ride)
    await createSupabaseWriter().upsertExercises([
      row('garmin:activity:12345678901', { details: newer, minutes: 52 }),
      row('garmin:activity:12345678902', { details: newer, minutes: 32 }),
      row('garmin:activity:12345678903', { details: newer, minutes: 76 }),
    ]);
    const byId = (id: string) => backend.rows('exercise_entries').find((r) => r.external_id === id) as Record<string, any>;
    expect(byId('garmin:activity:12345678901').details).toEqual(GARMIN_STRENGTH_DETAILS); // untouched
    expect(byId('garmin:activity:12345678901').minutes).toBe(52); // but the rest of the row is refreshed
    expect(byId('garmin:activity:12345678902').details).toEqual(newer); // summary -> newer summary
    expect(byId('garmin:activity:12345678902').details).not.toEqual(GARMIN_RUN_SUMMARY);
    expect(byId('garmin:activity:12345678903').details).toEqual(newer); // none -> summary
    expect(backend.mutations.filter((m) => !m.ok)).toEqual([]);
  });

  it('a sync row without details never clears stored details (mixed batch, one write per column set)', async () => {
    const { createSupabaseWriter } = await load('@/health/writer');
    const { backend } = connect();
    await createSupabaseWriter().upsertExercises([
      row('garmin:activity:12345678901', { minutes: 55 }), // full details stored, none in the row
      row('garmin:activity:12345678902', { details: SUMMARY, minutes: 33 }),
    ]);
    const byId = (id: string) => backend.rows('exercise_entries').find((r) => r.external_id === id) as Record<string, any>;
    expect(byId('garmin:activity:12345678901')).toMatchObject({ minutes: 55, details: GARMIN_STRENGTH_DETAILS });
    expect(byId('garmin:activity:12345678902')).toMatchObject({ minutes: 33, details: SUMMARY });
    const updates = backend.mutations.filter((m) => m.table === 'exercise_entries' && m.op !== 'insert');
    // never one bulk upsert whose rows have different columns (PostgREST would write null into the missing ones)
    for (const u of updates) {
      const keySets = new Set((Array.isArray(u.payload) ? u.payload : [u.payload]).map((p) => Object.keys(p as object).sort().join(',')));
      expect(keySets.size).toBe(1);
    }
    expect(updates.length).toBeGreaterThanOrEqual(2);
  });

  it('the user keeps counts_toward_energy and activity_code on existing rows, as before', async () => {
    const { createSupabaseWriter } = await load('@/health/writer');
    const { backend } = connect();
    await createSupabaseWriter().upsertExercises([row('garmin:activity:12345678903', { counts_toward_energy: false, activity_code: 'RUN_TREADMILL', details: SUMMARY })]);
    const r = backend.rows('exercise_entries').find((x) => x.external_id === 'garmin:activity:12345678903') as Record<string, any>;
    expect(r.activity_code).toBeNull();
  });
});

suite('ai/workout-context.ts: the coach text of one workout', () => {
  it('returns null for an id that is not one of the user workouts', async () => {
    const { loadWorkoutCoachContext } = await load('@/ai/workout-context');
    connect();
    expect(await loadWorkoutCoachContext(IDS.missing)).toBeNull();
    expect(await loadWorkoutCoachContext('nonsense')).toBeNull();
    expect(holder.runner.calls).toEqual([]);
  });

  /** A Garmin strength session whose details were read a moment ago (relative to the REAL clock, which the loader uses). */
  const freshGarmin = () => ({
    id: stableId(910),
    user_id: USER.id,
    entry_date: TODAY,
    name: 'Strength training',
    minutes: 40,
    kcal: 200,
    source: 'garmin',
    external_id: 'garmin:activity:777',
    started_at: localIso(TODAY, '18:00'),
    ended_at: localIso(TODAY, '18:40'),
    counts_toward_energy: false,
    details: { ...GARMIN_STRENGTH_DETAILS, fetchedAt: new Date().toISOString() },
  });

  it('a Garmin workout with fresh full details: no Garmin read at all, previous workouts of the same type included', async () => {
    const { loadWorkoutCoachContext } = await load('@/ai/workout-context');
    connect([freshGarmin()]);
    const text = (await loadWorkoutCoachContext(stableId(910))) as string;
    expect(holder.runner.calls).toEqual([]);
    expect(text).toContain('Workout: Strength training (strength)');
    expect(text).toContain('Heart rate: average 118 bpm, max 162 bpm, lowest 78 bpm');
    expect(text).toContain('Bench press: 4 x 8 @ 60 kg, 4 x 6 @ 70 kg');
    // the Apple Health strength session of this morning and the Garmin one of two days ago, newest first
    expect(text).toContain('Previous 2 workouts of this type (newest first, for comparison):');
    expect(text).toMatch(/Tue 10 Nov: 45 min, 210 kcal\n {2}Sun 8 Nov: 50 min, avg 118 bpm, 245 kcal\nNot available/);
    expect(text).toContain('Not available: nothing important is missing.');
    expect(text.length).toBeLessThanOrEqual(2500);
  });

  it('the second call is two database reads and no Garmin call', async () => {
    const { loadWorkoutCoachContext } = await load('@/ai/workout-context');
    const { backend } = connect([freshGarmin()]);
    await loadWorkoutCoachContext(stableId(910));
    const before = backend.calls.length;
    await loadWorkoutCoachContext(stableId(910));
    expect(backend.calls.length - before).toBe(2);
    expect(holder.runner.calls).toEqual([]);
  });

  it('a Garmin workout without details gets one quick read first and uses its result', async () => {
    const { loadWorkoutCoachContext } = await load('@/ai/workout-context');
    connect();
    holder.runner.outcome = {
      status: 'done',
      details: { v: 1, source: 'garmin', level: 'full', fetchedAt: new Date().toISOString(), typeKey: 'cycling', avgHr: 133, maxHr: 171, distanceM: 28000, avgSpeedMps: 6.2 },
    };
    const text = (await loadWorkoutCoachContext(IDS.workout.garminOld)) as string;
    expect(holder.runner.calls).toEqual([IDS.workout.garminOld]);
    expect(text).toContain('Heart rate: average 133 bpm, max 171 bpm');
    expect(text).toContain('Distance: 28 km; Average speed: 22.3 km/h');
    expect(text).not.toContain('Garmin details have not been read');
  });

  it('when the read fails, the coach still gets the workout and is told what is missing; the next turns do not wait again', async () => {
    const { loadWorkoutCoachContext } = await load('@/ai/workout-context');
    connect();
    holder.runner.outcome = { status: 'failed', code: 'network', message: 'offline' };
    const text = (await loadWorkoutCoachContext(IDS.workout.garminOld)) as string;
    expect(text).toContain('Source: Garmin');
    expect(text.split('\n').pop()).toContain('No heart-rate data recorded');
    expect(text.split('\n').pop()).toContain('Garmin details have not been read');
    await loadWorkoutCoachContext(IDS.workout.garminOld);
    expect(holder.runner.calls).toEqual([IDS.workout.garminOld]); // not tried again within a few minutes
  });

  it('a read that takes too long does not hold up the chat turn', async () => {
    const { loadWorkoutCoachContext } = await load('@/ai/workout-context');
    connect();
    holder.runner.outcome = new Promise(() => undefined) as never;
    vi.useFakeTimers();
    try {
      const pending = loadWorkoutCoachContext(IDS.workout.garminRun);
      // the database reads need a few ticks before the read starts; then the 3.5 s limit passes
      for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(250);
      const text = (await pending) as string;
      expect(holder.runner.calls).toEqual([IDS.workout.garminRun]);
      expect(text).toContain('Workout: Running (running)');
      expect(text).toContain('Heart rate: average 150 bpm'); // what the sync already stored is still told
    } finally {
      vi.useRealTimers();
    }
  });

  it('manual and Apple Health workouts never trigger a Garmin read', async () => {
    const { loadWorkoutCoachContext } = await load('@/ai/workout-context');
    connect();
    const manual = (await loadWorkoutCoachContext(IDS.workout.run)) as string;
    const apple = (await loadWorkoutCoachContext(IDS.workout.strength)) as string;
    expect(holder.runner.calls).toEqual([]);
    expect(manual).toContain('Running, treadmill, general');
    expect(apple).toContain('Source: Apple Health');
    // the previous Garmin / other strength sessions are found for the Apple Health one
    expect(apple).toContain('Previous 1 workouts of this type');
  });

  it('exports exactly one function', async () => {
    const mod = await load('@/ai/workout-context');
    expect(Object.keys(mod)).toEqual(['loadWorkoutCoachContext']);
  });
});

function stableId(n: number): string {
  return `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
}
