/**
 * Cronometer-style daily energy in the app, run through the app's own modules via the `@/` alias:
 *  - data/energy.ts `computeDayEnergy`: which exercise rows count, the device workout kcal / minutes that separate tracker
 *    activity from exercise, and `remaining` for both views of the third circle (Target and Balance)
 *  - components/diary/energy-view.ts: the rows of the breakdown sheet and the props of the energy summary
 *  - data/energy-mode.ts: the Target / Balance preference (one PATCH of the profile row) and `enableDeviceEnergyMode`
 *    (Static -> Device-adjusted once, never again after the user went back to Static)
 * The browser run (scenarios.ts) clicks the same controls on the dashboard and in the settings.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { ANON_KEY, BACKEND_ORIGIN, FIXED_NOW_MS, STORAGE_KEY } from './constants';
import { USER, buildFixtures } from './fixtures';
import { createMockBackend } from './mock-backend';
import { SEED_SESSION_TTL_SECONDS, buildSession } from './session';

const holder = vi.hoisted(() => ({ client: null as any }));
const spies = vi.hoisted(() => ({ setQueryData: vi.fn(), invalidateQueries: vi.fn(async () => undefined) }));

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: true,
  supabase: new Proxy({}, { get: (_target, prop) => holder.client[prop] }),
}));
// The real query client persists its cache with AsyncStorage (React Native); only what the app does to it matters here.
vi.mock('@/lib/query', () => ({
  queryClient: { setQueryData: spies.setQueryData, invalidateQueries: spies.invalidateQueries },
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

/** Imports an app module through the `@/` alias at run time (untyped: this package knows nothing about the app). */
const load = (specifier: string): Promise<any> => import(/* @vite-ignore */ specifier);

function connect(variant: Parameters<typeof buildFixtures>[0] = 'default') {
  const fx = buildFixtures(variant);
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

const suite = lib ? describe : describe.skip;

// ----------------------------------------------------------------------------------------------------- test data

/** Cronometer's example person: BMR 1394, baseline 279, maintain-weight target 1673. */
const targets = (over: { target?: number; bmr?: number; baseline?: number } = {}): any => {
  const bmr = over.bmr ?? 1394;
  const baseline = over.baseline ?? 279;
  const target = over.target ?? bmr + baseline;
  return {
    bmr,
    baselineActivityKcal: baseline,
    energy: { target, maintenance: bmr + baseline, delta: target - bmr - baseline, floor: 1200, flooredBy: 0, belowBmr: false },
  };
};

let seq = 0;
const at = (hhmm: string): string => `2026-11-10T${hhmm}:00.000Z`;
const exerciseRow = (o: Record<string, unknown> = {}): any => ({
  id: `ex-${++seq}`,
  entry_date: '2026-11-10',
  activity_code: null,
  name: 'Exercise',
  minutes: null,
  kcal: 0,
  source: 'manual',
  external_id: null,
  started_at: null,
  ended_at: null,
  counts_toward_energy: true,
  ...o,
});
/** A workout recorded by a watch: informational (counts_toward_energy = false), its energy is inside the daily active kcal. */
const workout = (source: string, kcal: number, start: string, end: string, minutes: number | null = null): any =>
  exerciseRow({ name: 'Workout', source, kcal, minutes, started_at: at(start), ended_at: at(end), counts_toward_energy: false, external_id: `${source}-${start}` });
const manual = (kcal: number, minutes: number | null, start?: string, end?: string): any =>
  exerciseRow({ kcal, minutes, started_at: start ? at(start) : null, ended_at: end ? at(end) : null });
const deviceRow = (source: string, active: number | null, resting: number | null = null): any => ({
  local_date: '2026-11-10',
  source,
  active_kcal: active,
  resting_kcal: resting,
  steps: null,
  updated_at: null,
});

const base = { tefEnabled: false, consumedKcal: 0, exercise: [] as any[], deviceRows: [] as any[] };

suite('data/energy.ts computeDayEnergy: Burned = BMR + adjusted baseline + tracker activity + exercise (+ TEF)', () => {
  it("Cronometer's example without a device: a 60 min / 500 kcal ride -> adjusted baseline 261.5625, Burned 2155.5625, above baseline 482.5625", async () => {
    const { computeDayEnergy } = await load('@/data/energy');
    const r = computeDayEnergy({ ...base, mode: 'static', targets: targets(), exercise: [manual(500, 60)] });
    expect(r.breakdown).toMatchObject({ bmr: 1394, adjustedBaseline: 261.5625, trackerActivity: 0, exercise: 500, tef: 0, total: 2155.5625 });
    expect(r.exerciseBurnedKcal).toBe(482.5625);
    expect(r.targetKcal).toBe(1673);
    // Target view: (1673 + 482.5625) - consumed ; Balance view: Burned - consumed
    expect(computeDayEnergy({ ...base, mode: 'static', targets: targets(), exercise: [manual(500, 60)], consumedKcal: 1800 }).remaining).toEqual({
      target: 1673 + 482.5625 - 1800,
      balance: 2155.5625 - 1800,
    });
  });

  it('an empty day: Burned = BMR + the whole baseline, remaining = target - consumed in both views', async () => {
    const { computeDayEnergy } = await load('@/data/energy');
    for (const mode of ['static', 'device_adjusted'] as const) {
      const r = computeDayEnergy({ ...base, mode, targets: targets(), consumedKcal: 500 });
      expect(r.breakdown.total).toBe(1673);
      expect(r.breakdown.adjustedBaseline).toBe(279);
      expect(r.exerciseBurnedKcal).toBe(0);
      expect(r.remaining).toEqual({ target: 1173, balance: 1173 });
    }
  });

  it('a weight-loss target keeps its deficit in the Target view while Balance is the plain deficit', async () => {
    const { computeDayEnergy } = await load('@/data/energy');
    const r = computeDayEnergy({ ...base, mode: 'static', targets: targets({ target: 1673 - 500 }), consumedKcal: 1500 });
    expect(r.remaining).toEqual({ target: 1173 - 1500, balance: 1673 - 1500 });
  });

  it('TEF is part of Burned (the Balance view and the Expenditure circle) but never widens the Target budget', async () => {
    const { computeDayEnergy } = await load('@/data/energy');
    const off = computeDayEnergy({ ...base, mode: 'static', targets: targets(), consumedKcal: 2000 });
    const on = computeDayEnergy({ ...base, mode: 'static', targets: targets(), consumedKcal: 2000, tefEnabled: true });
    expect(on.breakdown.tef).toBe(200);
    expect(on.breakdown.total).toBe(off.breakdown.total + 200);
    expect(on.exerciseBurnedKcal).toBe(off.exerciseBurnedKcal);
    expect(on.remaining.target).toBe(off.remaining.target);
    expect(on.remaining.balance).toBe(off.remaining.balance + 200);
  });

  describe('device_adjusted with a Garmin day (daily active energy includes the workouts)', () => {
    const run = (extra: Record<string, unknown> = {}) => {
      return load('@/data/energy').then(({ computeDayEnergy }) =>
        computeDayEnergy({
          ...base,
          mode: 'device_adjusted',
          targets: targets(),
          deviceRows: [deviceRow('garmin', 600, 1100)],
          exercise: [
            workout('garmin', 500, '07:00', '08:00', 60), // the watch's 60 minute ride
            manual(300, 30, '07:15', '07:45'), // the same ride logged by hand: dropped
            manual(200, 30, '08:10', '08:40'), // a separate run: counted
          ],
          ...extra,
        }),
      );
    };

    it('workout kcal go to Exercise, the rest of the active energy is Tracker activity, overlapping manual entries are dropped', async () => {
      const r = await run();
      expect(r.breakdown.trackerActivity).toBe(100); // 600 - 500
      expect(r.breakdown.exercise).toBe(700); // 500 watch + 200 manual run; the overlapping 300 is not counted twice
      // 90 minutes of exercise (60 + 30) take 90/60 * 279/16 = 26.15625 of baseline, tracker activity takes 100
      expect(r.breakdown.adjustedBaseline).toBeCloseTo(279 - 100 - 26.15625, 10);
      expect(r.breakdown.total).toBeCloseTo(1394 + 152.84375 + 100 + 700, 10);
      expect(r.exerciseBurnedKcal).toBeCloseTo(152.84375 + 100 + 700 - 279, 10);
    });

    it('does not read the device resting energy (a day-so-far counter) and ignores it for the budget', async () => {
      const a = await run({ deviceRows: [deviceRow('garmin', 600, 100)] });
      const b = await run({ deviceRows: [deviceRow('garmin', 600, 1100)] });
      expect(a.breakdown).toEqual(b.breakdown);
    });

    it('counts the same session recorded by a second source only once (the chosen source\'s workouts)', async () => {
      const r = await run({
        exercise: [workout('garmin', 500, '07:00', '08:00', 60), workout('apple_health', 480, '07:00', '08:00', 60)],
      });
      expect(r.breakdown.exercise).toBe(500);
      expect(r.breakdown.trackerActivity).toBe(100);
      expect(r.breakdown.adjustedBaseline).toBeCloseTo(279 - 100 - 17.4375, 10);
    });

    it('prefers Garmin over Apple Health for the daily total, and the matching source for the workouts', async () => {
      const r = await run({
        deviceRows: [deviceRow('apple_health', 900, 1000), deviceRow('garmin', 600, 1100)],
        exercise: [workout('apple_health', 800, '07:00', '08:00', 60)],
      });
      // the chosen daily row is Garmin's; the Apple Health workout is not inside it, so it is not exercise here
      expect(r.breakdown.exercise).toBe(0);
      expect(r.breakdown.trackerActivity).toBe(600);
    });

    it('takes the duration from started_at / ended_at when the minutes column is empty, and 0 for an entry without a duration', async () => {
      const r = await run({
        exercise: [workout('garmin', 500, '07:00', '08:30', null), manual(100, null)],
      });
      expect(r.breakdown.exercise).toBe(600);
      expect(r.breakdown.adjustedBaseline).toBeCloseTo(279 - 100 - (279 / 16) * 1.5, 10); // 90 minutes; the manual one has none
    });

    it('a partial day (a little tracker activity so far) keeps Burned at BMR + baseline and shows the tracker', async () => {
      const r = await run({ deviceRows: [deviceRow('garmin', 120, 400)], exercise: [], deviceDayComplete: false });
      expect(r.breakdown.trackerActivity).toBe(120);
      expect(r.breakdown.adjustedBaseline).toBe(159);
      expect(r.breakdown.total).toBe(1673);
      expect(r.remaining).toEqual({ target: 1673, balance: 1673 });
    });

    it('device workouts without a daily total from the device do not count (their energy would be lost, not added)', async () => {
      const r = await run({ deviceRows: [], exercise: [workout('garmin', 500, '07:00', '08:00', 60), manual(200, 30, '08:10', '08:40')] });
      expect(r.breakdown.exercise).toBe(200);
      expect(r.breakdown.trackerActivity).toBe(0);
      expect(r.breakdown.adjustedBaseline).toBeCloseTo(279 - 8.71875, 10); // only the 30 manual minutes
    });
  });

  it('static never reads the watch: not the daily total, not the workouts', async () => {
    const { computeDayEnergy } = await load('@/data/energy');
    const r = computeDayEnergy({
      ...base,
      mode: 'static',
      targets: targets(),
      deviceRows: [deviceRow('garmin', 900, 1500)],
      exercise: [workout('garmin', 500, '07:00', '08:00', 60)],
    });
    expect(r.breakdown).toMatchObject({ trackerActivity: 0, exercise: 0, adjustedBaseline: 279, total: 1673 });
  });

  it('device_total is the device total: resting + active; only the budget widening uses our BMR and baseline', async () => {
    const { computeDayEnergy } = await load('@/data/energy');
    const r = computeDayEnergy({
      ...base,
      mode: 'device_total',
      targets: targets(),
      consumedKcal: 2000,
      tefEnabled: true,
      deviceRows: [deviceRow('apple_health', 700, 1500)],
      exercise: [workout('apple_health', 300, '07:00', '08:00', 60), manual(999, 60)],
    });
    expect(r.breakdown).toMatchObject({ bmr: 1500, adjustedBaseline: 0, trackerActivity: 400, exercise: 300, tef: 200, total: 2400 });
    expect(r.exerciseBurnedKcal).toBe(1500 + 700 - 1673); // 527: device figures above our own BMR + baseline
    expect(r.remaining).toEqual({ target: 1673 + 527 - 2000, balance: 2400 - 2000 });
    // a day that is not finished: the resting counter so far (e.g. 801) never stands in for a whole day's BMR
    const partial = computeDayEnergy({ ...base, mode: 'device_total', targets: targets(), deviceRows: [deviceRow('garmin', 150, 801)], deviceDayComplete: false });
    expect(partial.breakdown.bmr).toBe(1394);
    expect(partial.breakdown.total).toBe(1394 + 150);
  });

  it('without targets nothing can be computed (no breakdown, no remaining), the manual exercise is still reported', async () => {
    const { computeDayEnergy } = await load('@/data/energy');
    const r = computeDayEnergy({ ...base, mode: 'static', targets: undefined, exercise: [manual(250, 30)] });
    expect(r.breakdown).toBeUndefined();
    expect(r.targetKcal).toBeUndefined();
    expect(r.remaining).toBeUndefined();
    expect(r.exerciseBurnedKcal).toBe(250);
  });

  it('exerciseMinutesOf: the duration column, else the span between start and end, else 0', async () => {
    const { exerciseMinutesOf } = await load('@/data/energy');
    expect(exerciseMinutesOf({ minutes: 45, started_at: null, ended_at: null })).toBe(45);
    expect(exerciseMinutesOf({ minutes: '30', started_at: null, ended_at: null })).toBe(30); // numeric columns can arrive as strings
    expect(exerciseMinutesOf({ minutes: null, started_at: at('07:00'), ended_at: at('07:50') })).toBe(50);
    expect(exerciseMinutesOf({ minutes: 0, started_at: at('07:00'), ended_at: at('07:20') })).toBe(20);
    expect(exerciseMinutesOf({ minutes: null, started_at: at('08:00'), ended_at: at('07:00') })).toBe(0);
    expect(exerciseMinutesOf({ minutes: null, started_at: at('07:00'), ended_at: null })).toBe(0);
    expect(exerciseMinutesOf({ minutes: null, started_at: null, ended_at: null })).toBe(0);
  });
});

suite('components/diary/energy-view.ts: the breakdown the sheet lists and the props of the energy summary', () => {
  it('lists BMR, adjusted baseline activity, exercise and TEF without a device; tracker activity only with one', async () => {
    const { computeDayEnergy } = await load('@/data/energy');
    const { energyBreakdownRows } = await load('@/components/diary/energy-view');
    const day = computeDayEnergy({ ...base, mode: 'static', targets: targets(), consumedKcal: 1000, tefEnabled: true, exercise: [manual(500, 60)] });
    const rows = energyBreakdownRows(day.breakdown, { hasDevice: false });
    expect(rows.map((r: any) => r.key)).toEqual(['bmr', 'adjustedBaseline', 'exercise', 'tef']);
    expect(rows.map((r: any) => Math.round(r.kcal))).toEqual([1394, 262, 500, 100]);
    expect(rows.map((r: any) => r.label)).toEqual(['Basal metabolic rate (BMR)', 'Adjusted baseline activity', 'Exercise', 'Thermic effect of food']);
    const withDevice = energyBreakdownRows(day.breakdown, { hasDevice: true });
    expect(withDevice.map((r: any) => r.key)).toEqual(['bmr', 'adjustedBaseline', 'trackerActivity', 'exercise', 'tef']);
    // the listed parts add up to the total
    expect(withDevice.reduce((sum: number, r: any) => sum + r.kcal, 0)).toBeCloseTo(day.breakdown.total, 9);
  });

  it('hides the adjusted baseline once tracker activity and exercise replaced all of it, and TEF when it is 0', async () => {
    const { computeDayEnergy } = await load('@/data/energy');
    const { energyBreakdownRows } = await load('@/components/diary/energy-view');
    const day = computeDayEnergy({ ...base, mode: 'device_adjusted', targets: targets(), deviceRows: [deviceRow('garmin', 400)], tefEnabled: true });
    const rows = energyBreakdownRows(day.breakdown, { hasDevice: true });
    expect(rows.map((r: any) => r.key)).toEqual(['bmr', 'trackerActivity', 'exercise']);
    expect(rows.find((r: any) => r.key === 'trackerActivity').kcal).toBe(400);
  });

  it('energySummaryProps passes the numbers of the chosen view and a tracker flag only for a device mode with a device row', async () => {
    const { computeDayEnergy } = await load('@/data/energy');
    const { energySummaryProps } = await load('@/components/diary/energy-view');
    const toggle = vi.fn();
    const day = computeDayEnergy({ ...base, mode: 'device_adjusted', targets: targets(), consumedKcal: 1000, deviceRows: [deviceRow('garmin', 450)] });
    const energy = {
      consumedKcal: 1000,
      expenditureKcal: day.breakdown.total,
      targetKcal: day.targetKcal,
      exerciseBurnedKcal: day.exerciseBurnedKcal,
      remainingKcal: day.remaining.balance,
      summaryMode: 'balance',
      breakdown: day.breakdown,
      deviceEnergy: deviceRow('garmin', 450),
      mode: 'device_adjusted',
    };
    const props = energySummaryProps(energy, toggle);
    expect(props).toMatchObject({ consumed: 1000, expenditure: 1394 + 450, target: 1673, aboveBaseline: 171, remaining: 1394 + 450 - 1000, summaryMode: 'balance', hasDevice: true });
    expect(props.onToggleSummaryMode).toBe(toggle);
    expect(energySummaryProps({ ...energy, mode: 'static' }, toggle).hasDevice).toBe(false);
    expect(energySummaryProps({ ...energy, deviceEnergy: undefined }, toggle).hasDevice).toBe(false);
  });

  it('thirdCircle: Remaining / Over in Target, Deficit / Surplus in Balance, always an absolute value', async () => {
    const { thirdCircle } = await load('@/components/diary/energy-view');
    expect(thirdCircle('target', 355.6)).toEqual({ caption: 'Remaining', kcal: 355.6, negative: false });
    expect(thirdCircle('target', -120)).toEqual({ caption: 'Over', kcal: 120, negative: true });
    expect(thirdCircle('balance', 355.6)).toEqual({ caption: 'Deficit', kcal: 355.6, negative: false });
    expect(thirdCircle('balance', -120)).toEqual({ caption: 'Surplus', kcal: 120, negative: true });
    expect(thirdCircle('balance', undefined)).toEqual({ caption: 'Balance', kcal: undefined, negative: false });
  });
});

suite('data/energy-mode.ts', () => {
  it('Target <-> Balance is ONE update of the profile row and survives a reload', async () => {
    const { updateProfileRow, fetchProfileRow } = await load('@/data/profile');
    const { backend } = connect();
    expect((await fetchProfileRow()).energy_summary_mode).toBe('target');
    const row = await updateProfileRow({ energy_summary_mode: 'balance' });
    expect(row.energy_summary_mode).toBe('balance');
    expect(backend.mutationsOf('profiles', 'update')).toHaveLength(1);
    expect(backend.mutationsOf('profiles', 'update')[0]?.payload).toEqual({ energy_summary_mode: 'balance' });
    expect((await fetchProfileRow()).energy_summary_mode).toBe('balance');
    await updateProfileRow({ energy_summary_mode: 'target' });
    expect(backend.rows('profiles')[0]?.energy_summary_mode).toBe('target');
    // the database refuses any other value
    await expect(updateProfileRow({ energy_summary_mode: 'remaining' })).rejects.toBeTruthy();
    expect(backend.rows('profiles')[0]?.energy_summary_mode).toBe('target');
    expect(backend.unhandled).toEqual([]);
  });

  it('the energy settings save the third circle together with the other energy settings', async () => {
    const { energyDraftFromProfile, energyDraftToPatch, energyDraftEqual } = await load('@/components/settings/energy-draft');
    const { backend } = connect();
    const profile = backend.rows('profiles')[0];
    const draft = energyDraftFromProfile(profile);
    expect(draft.summaryMode).toBe('target');
    expect(energyDraftToPatch({ ...draft, summaryMode: 'balance' })).toMatchObject({ energy_summary_mode: 'balance', energy_mode: 'static' });
    expect(energyDraftEqual(draft, { ...draft, summaryMode: 'balance' })).toBe(false);
    expect(energyDraftFromProfile({ ...profile, energy_summary_mode: undefined }).summaryMode).toBe('target'); // an old cached profile
  });

  describe('enableDeviceEnergyMode', () => {
    it('Static -> Device-adjusted once; the profile caches are refreshed', async () => {
      const { enableDeviceEnergyMode, DEVICE_ENERGY_MODE_NOTICE } = await load('@/data/energy-mode');
      const { backend } = connect();
      spies.setQueryData.mockClear();
      spies.invalidateQueries.mockClear();
      expect(await enableDeviceEnergyMode()).toBe('switched');
      const update = backend.mutationsOf('profiles', 'update');
      expect(update).toHaveLength(1);
      expect(update[0]?.payload).toMatchObject({ energy_mode: 'device_adjusted' });
      expect(Number.isNaN(Date.parse((update[0]?.payload as any).energy_mode_auto_switched_at))).toBe(false);
      expect(backend.rows('profiles')[0]).toMatchObject({ energy_mode: 'device_adjusted' });
      expect(backend.rows('profiles')[0]?.energy_mode_auto_switched_at).toBeTruthy();
      expect(spies.setQueryData).toHaveBeenCalledTimes(1);
      expect(spies.invalidateQueries.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(DEVICE_ENERGY_MODE_NOTICE).toBe(
        'Energy mode is now Device-adjusted: your budget follows your watch. You can change it in Profile & targets.',
      );
      // asking again changes nothing
      expect(await enableDeviceEnergyMode()).toBe('already');
      expect(backend.mutationsOf('profiles', 'update')).toHaveLength(1);
    });

    it("never flips it again after the user went back to Static on purpose ('kept')", async () => {
      const { enableDeviceEnergyMode } = await load('@/data/energy-mode');
      const { updateProfileRow } = await load('@/data/profile');
      const { backend } = connect();
      expect(await enableDeviceEnergyMode()).toBe('switched');
      await updateProfileRow({ energy_mode: 'static' }); // the user's own choice in Profile & targets
      const writes = backend.mutationsOf('profiles', 'update').length;
      expect(await enableDeviceEnergyMode()).toBe('kept');
      expect(await enableDeviceEnergyMode()).toBe('kept');
      expect(backend.mutationsOf('profiles', 'update')).toHaveLength(writes);
      expect(backend.rows('profiles')[0]?.energy_mode).toBe('static');
    });

    it("leaves a device mode alone ('already'), also Device total, without any write", async () => {
      const { enableDeviceEnergyMode } = await load('@/data/energy-mode');
      const { updateProfileRow } = await load('@/data/profile');
      const { backend } = connect();
      await updateProfileRow({ energy_mode: 'device_total' });
      const writes = backend.mutationsOf('profiles', 'update').length;
      expect(await enableDeviceEnergyMode()).toBe('already');
      expect(backend.mutationsOf('profiles', 'update')).toHaveLength(writes);
      expect(backend.rows('profiles')[0]).toMatchObject({ energy_mode: 'device_total', energy_mode_auto_switched_at: null });
    });

    it('the decision with injected dependencies: no profile row = kept, a failing write is not swallowed', async () => {
      const { enableDeviceEnergyModeWith } = await load('@/data/energy-mode');
      const written: unknown[] = [];
      const deps = (profile: unknown) => ({
        readProfile: async () => profile,
        writeProfile: async (patch: unknown) => {
          written.push(patch);
          return { user_id: 'u' };
        },
        now: () => new Date('2026-11-10T09:00:00.000Z'),
      });
      expect(await enableDeviceEnergyModeWith(deps(null))).toBe('kept');
      expect(await enableDeviceEnergyModeWith(deps({ energy_mode: 'static', energy_mode_auto_switched_at: '2026-11-01T00:00:00Z' }))).toBe('kept');
      expect(written).toEqual([]);
      expect(await enableDeviceEnergyModeWith(deps({ energy_mode: 'static', energy_mode_auto_switched_at: null }))).toBe('switched');
      expect(written).toEqual([{ energy_mode: 'device_adjusted', energy_mode_auto_switched_at: '2026-11-10T09:00:00.000Z' }]);
      await expect(
        enableDeviceEnergyModeWith({ ...deps({ energy_mode: 'static', energy_mode_auto_switched_at: null }), writeProfile: async () => { throw new Error('offline'); } }),
      ).rejects.toThrow('offline');
    });
  });

  it('summary-mode helpers (core): toggle and normalise', async () => {
    const core = await import('../../../packages/core/src');
    expect(core.nextEnergySummaryMode('target')).toBe('balance');
    expect(core.nextEnergySummaryMode('balance')).toBe('target');
    expect(core.normalizeEnergySummaryMode(undefined)).toBe('target');
  });
});
