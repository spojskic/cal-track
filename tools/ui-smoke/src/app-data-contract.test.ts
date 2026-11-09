/**
 * Runs the app's OWN data-layer functions (apps/app/src/data/*, health/*) against the mock backend through the
 * real supabase-js client. `@/lib/supabase` is replaced by a client that talks to the mock, everything else is the
 * production code. Only plain async functions are called (the React hooks need a renderer); they contain the
 * queries that matter. Skipped when the app's dependencies are not installed.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { ANON_KEY, BACKEND_ORIGIN, FIXED_NOW_MS, STORAGE_KEY, TODAY } from './constants';
import { BARCODES, IDS, USER, buildFixtures } from './fixtures';
import { createMockBackend } from './mock-backend';
import { SEED_SESSION_TTL_SECONDS, buildSession } from './session';

const holder = vi.hoisted(() => ({ client: null as any }));

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: true,
  supabase: new Proxy({}, { get: (_target, prop) => holder.client[prop] }),
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

/**
 * Imports an app module through the `@/` alias at run time. The specifier is a variable on purpose: this package's
 * tsconfig knows nothing about the app (React Native types, JSX), so the modules stay untyped (`any`) here.
 */
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

suite('apps/app data layer against the mock backend', () => {
  it('foods.ts lookupBarcode: local hit, graceful degradation when the edge function is missing, invalid input', async () => {
    const { lookupBarcode } = await load('@/data/foods');
    const { backend } = connect();
    expect(await lookupBarcode(BARCODES.nutella)).toEqual({ status: 'found', foodId: IDS.food.nutella, origin: 'local' });
    const unknown = await lookupBarcode(BARCODES.unknown);
    expect(unknown.status).toBe('unavailable'); // 404 "Requested function was not found" => not deployed, not "product missing"
    expect(await lookupBarcode('abc')).toMatchObject({ status: 'invalid' });
    expect(backend.calls.filter((c) => c.kind === 'function').map((c) => c.target)).toEqual(['barcode-lookup']);
    expect(backend.unhandled).toEqual([]);
  });

  it('recipes.ts: fetchRecipeDetail, fetchFoodsByIds, fetchDefaultServing', async () => {
    const { fetchRecipeDetail, fetchFoodsByIds, fetchDefaultServing } = await load('@/data/recipes');
    const { backend } = connect();
    const recipe = await fetchRecipeDetail(IDS.food.recipeChickenRice);
    expect(recipe).toMatchObject({ name: 'Piletina s rižom', servings: 2, finalWeightG: 900, archived: false });
    expect(recipe?.ingredients).toHaveLength(5);
    expect(recipe?.ingredients[0]?.food?.name).toBe('Chicken breast, skinless, boneless, raw');
    expect(recipe?.servingWeightG).toBe(450);
    expect(await fetchRecipeDetail(IDS.food.egg)).toBeNull(); // not a recipe
    expect(await fetchRecipeDetail(IDS.missing)).toBeNull();
    const foods = await fetchFoodsByIds([IDS.food.oats, IDS.food.banana, IDS.missing]);
    expect(foods.map((f: { name: string }) => f.name).sort()).toEqual(['Banana, raw', 'Oats, rolled, dry']);
    expect(foods.find((f: { name: string }) => f.name === 'Banana, raw')?.portions[0]?.gramsPerUnit).toBe(118);
    expect(await fetchDefaultServing(IDS.food.oats)).toMatchObject({ grams: 40, amount: 0.5, label: 'cup' });
    expect(await fetchDefaultServing(IDS.food.chickenCooked)).toMatchObject({ grams: 140 });
    expect(backend.unhandled).toEqual([]);
  });

  it('weight.ts / goals.ts / profile.ts / targets.ts: the onboarding save sequence', async () => {
    const { insertBodyReadings } = await load('@/data/weight');
    const { saveWeightGoalRow, saveMacroTargetRow } = await load('@/data/goals');
    const { upsertProfileRow, requireUserId } = await load('@/data/profile');
    const { backend } = connect('not-onboarded');
    expect(await requireUserId()).toBe(USER.id);
    const date = await insertBodyReadings({ weightKg: 82, bodyFatPct: 19.5 });
    expect(date).toBe(TODAY);
    await saveWeightGoalRow({ rateKgPerWeek: -0.5, targetWeightKg: 77, startWeightKg: 82, replace: true });
    await saveMacroTargetRow({ mode: 'ratios', proteinPct: 30, carbsPct: 40, fatPct: 30 });
    const profile = await upsertProfileRow({ sex: 'male', birthdate: '1992-03-15', height_cm: 182, unit_system: 'metric', activity_level: 'light', timezone: 'Europe/Sarajevo', onboarded: true });
    expect(profile).toMatchObject({ user_id: USER.id, onboarded: true, sex: 'male' });
    expect(backend.rows('biometrics').map((b) => [b.type, b.value])).toEqual([['weight', 82], ['body_fat', 19.5]]);
    expect(backend.rows('weight_goals')).toHaveLength(1);
    expect(backend.rows('macro_targets')).toHaveLength(1);
    // saving the weight goal again without `replace` updates in place
    await saveWeightGoalRow({ rateKgPerWeek: 0, startWeightKg: 82 });
    expect(backend.rows('weight_goals')).toHaveLength(1);
    expect(backend.rows('weight_goals')[0]?.rate_kg_per_week).toBe(0);
    // and the macro target of the same day is replaced, not duplicated
    await saveMacroTargetRow({ mode: 'ratios', proteinPct: 40, carbsPct: 30, fatPct: 30 });
    expect(backend.rows('macro_targets')).toHaveLength(1);
    expect(backend.unhandled).toEqual([]);
    expect(backend.mutations.filter((m) => !m.ok)).toEqual([]);
  });

  it('ai-foods.ts: saving an AI estimate creates an owned ai_estimate food', async () => {
    const { createAiEstimateFood } = await load('@/data/ai-foods');
    const { backend } = connect();
    const created = await createAiEstimateFood({
      name: 'Sarma',
      estimate: { per100g: { ENERGY_KCAL: 120, PROTEIN_G: 7, CARBS_G: 8, FAT_G: 6 }, confidence: 0.5, assumptions: [] } as never,
    });
    const row = backend.rows('foods').find((f) => f.id === created.id);
    expect(row).toMatchObject({ kind: 'ai_estimate', source: 'ai_estimate', owner_id: USER.id, name: 'Sarma' });
  });

  it('coach.ts: threads, messages and the grounding queries', async () => {
    const coach = await load('@/data/coach');
    const { backend } = connect();
    const thread = await coach.createCoachThread('Koliko vode trebam piti?');
    expect(thread.id).toMatch(/^[0-9a-f-]{36}$/);
    const msg = await coach.appendCoachMessage(thread.id, 'user', 'Koliko vode trebam piti?', { touch: true });
    expect(msg).toMatchObject({ role: 'user' });
    const grounding = await coach.fetchCoachGrounding(TODAY);
    expect(grounding.dailyTotals?.length).toBeGreaterThan(5);
    expect(grounding.weight?.at(-1)?.kg).toBe(80);
    expect(grounding.exercise).not.toBeNull();
    expect(grounding.deviceEnergy).not.toBeNull();
    expect(grounding.biometrics).not.toBeNull();
    expect(backend.unhandled).toEqual([]);
    expect(backend.calls.filter((c) => c.status >= 400)).toEqual([]);
  });

  it('health/writer.ts + integration-store.ts: idempotent device sync writes', async () => {
    const { createSupabaseWriter } = await load('@/health/writer');
    const { fetchIntegration, saveIntegration } = await load('@/health/integration-store');
    const { backend } = connect();
    const writer = createSupabaseWriter();
    const exercise = (external_id: string, minutes: number) =>
      ({
        user_id: USER.id,
        entry_date: TODAY,
        name: 'Cycling',
        minutes,
        kcal: 200,
        source: 'apple_health',
        external_id,
        started_at: `${TODAY}T08:00:00+01:00`,
        ended_at: `${TODAY}T08:30:00+01:00`,
        counts_toward_energy: true,
        activity_code: null,
      }) as never;
    await writer.upsertExercises([exercise('w-1', 30)]);
    await writer.upsertExercises([exercise('w-1', 45), exercise('w-2', 20)]); // w-1 updated, w-2 inserted
    const rows = backend.rows('exercise_entries').filter((e) => e.source === 'apple_health' && String(e.external_id).startsWith('w-'));
    expect(rows.map((r) => [r.external_id, r.minutes])).toEqual([['w-1', 45], ['w-2', 20]]);
    await writer.upsertDailyEnergy([{ user_id: USER.id, local_date: TODAY, source: 'apple_health', active_kcal: 500, resting_kcal: 1500, steps: 9000 }] as never);
    await writer.upsertDailyEnergy([{ user_id: USER.id, local_date: TODAY, source: 'apple_health', active_kcal: 600, resting_kcal: 1500, steps: 9500 }] as never);
    expect(backend.rows('daily_energy')).toHaveLength(1);
    expect(backend.rows('daily_energy')[0]?.active_kcal).toBe(600);

    expect(await fetchIntegration('apple_health', USER.id)).toBeNull();
    const saved = await saveIntegration(USER.id, 'apple_health', { enabled: true, settings: { weight: true } });
    expect(saved).toMatchObject({ provider: 'apple_health', enabled: true });
    await saveIntegration(USER.id, 'apple_health', { last_sync_at: '2026-11-10T11:00:00+00:00' });
    expect(backend.rows('integrations')).toHaveLength(1);
    expect(backend.rows('integrations')[0]).toMatchObject({ enabled: true, last_sync_at: '2026-11-10T11:00:00+00:00' });
    expect(backend.unhandled).toEqual([]);
    expect(backend.mutations.filter((m) => !m.ok)).toEqual([]);
  });
});
