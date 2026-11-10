/**
 * Runs the app's OWN data-layer functions (apps/app/src/data/*, health/*) against the mock backend through the
 * real supabase-js client. `@/lib/supabase` is replaced by a client that talks to the mock, everything else is the
 * production code. Only plain async functions are called (the React hooks need a renderer); they contain the
 * queries that matter. Skipped when the app's dependencies are not installed.
 */
import { readFileSync, readdirSync } from 'node:fs';
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

const stripComments = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Imports an app module through the `@/` alias at run time. The specifier is a variable on purpose: this package's
 * tsconfig knows nothing about the app (React Native types, JSX), so the modules stay untyped (`any`) here.
 */
const load = (specifier: string): Promise<any> => import(/* @vite-ignore */ specifier);

function connect(variant: Parameters<typeof buildFixtures>[0] = 'default', signedIn = true) {
  const fx = buildFixtures(variant);
  const backend = createMockBackend(fx.seed);
  const session = buildSession(USER, { nowMs: FIXED_NOW_MS, ttlSeconds: SEED_SESSION_TTL_SECONDS });
  const store = new Map<string, string>(signedIn ? [[STORAGE_KEY, JSON.stringify(session)]] : []);
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
    const { upsertProfileRow } = await load('@/data/profile');
    const { requireUserId } = await load('@/lib/auth-user');
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

  it('lib/auth-user.ts: the user id comes from the local session (no auth request), signed out throws', async () => {
    const { requireUserId, SIGNED_OUT_MESSAGE } = await load('@/lib/auth-user');
    const signedIn = connect();
    expect(await requireUserId()).toBe(USER.id);
    expect(await requireUserId()).toBe(USER.id);
    expect(signedIn.backend.calls.filter((c) => c.kind === 'auth')).toEqual([]); // `auth.getUser()` would call /auth/v1/user each time
    connect('default', false);
    await expect(requireUserId()).rejects.toThrow(SIGNED_OUT_MESSAGE);
    expect(SIGNED_OUT_MESSAGE).toBe('You are signed out. Please sign in again.');
  });

  it('no module of the app asks the auth server for the user id (one network request per write)', () => {
    const appSrc = join(here, '..', '..', '..', 'apps', 'app', 'src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && /auth\.getUser\(/.test(stripComments(readFileSync(path, 'utf8')))) offenders.push(path.slice(appSrc.length + 1));
      }
    };
    walk(appSrc);
    expect(offenders).toEqual([]); // use `requireUserId()` from '@/lib/auth-user' (the local session)
  });

  it('components/diary/targets-view.ts: a supplement-only upper limit never makes a bar or ring red or counts as over the limit', async () => {
    const { effectiveTarget, buildHighlights } = await load('@/components/diary/targets-view');
    const { nutrientStatus } = await load('@/components/charts/nutrient-status');
    const { nutritionScore, resolveTargets } = await import('../../../packages/core/src');
    const resolved = resolveTargets({ sex: 'male', birthdate: '1992-03-15', heightCm: 182, weightKg: 80, onDate: TODAY });
    const targets = { ...resolved, nutrients: resolved.nutrients };

    for (const code of ['MAGNESIUM_MG', 'VITAMIN_A_UG', 'VITAMIN_E_MG', 'B3_NIACIN_MG', 'FOLATE_UG']) {
      const t = effectiveTarget(code, targets, true);
      expect(t?.min, code).toBeGreaterThan(0);
      expect(t?.max, code).toBeUndefined();
      expect(t?.scopedUl?.value, code).toBeGreaterThan(0);
    }
    expect(effectiveTarget('VITAMIN_C_MG', targets, true)?.max).toBe(2000); // a total-intake UL stays a maximum

    // intake far above every scoped UL
    const totals = { MAGNESIUM_MG: 1200, VITAMIN_A_UG: 9000, VITAMIN_E_MG: 3000, B3_NIACIN_MG: 120, FOLATE_UG: 3000, ENERGY_KCAL: 2000 };
    const colors = { danger: 'DANGER', success: 'SUCCESS', carbs: 'NEUTRAL' };
    const rings = buildHighlights({ colors, totals, hasEntries: true, targets, netCarbs: true }) as { key: string; color: string; fraction: number }[];
    const scoped = rings.filter((r) => ['MAGNESIUM_MG', 'VITAMIN_A_UG', 'VITAMIN_E_MG', 'B3_NIACIN_MG', 'FOLATE_UG'].includes(r.key));
    expect(scoped.length).toBeGreaterThan(0);
    for (const ring of scoped) expect(ring.color, ring.key).toBe('SUCCESS');
    // the bars of the nutrient tables use the same bounds
    for (const code of ['MAGNESIUM_MG', 'VITAMIN_A_UG', 'FOLATE_UG'] as const) {
      const t = effectiveTarget(code, targets, true);
      expect(nutrientStatus(totals[code], t?.min, t?.max), code).toBe('ok');
    }

    const score = nutritionScore(totals, resolved.nutrients);
    for (const code of ['MAGNESIUM_MG', 'VITAMIN_A_UG', 'VITAMIN_E_MG', 'B3_NIACIN_MG', 'FOLATE_UG'] as const) {
      expect(score.perNutrient[code]?.excess, code).toBeUndefined();
    }
  });

  it('components/food/serving.ts amountWarning: warns about absurd amounts, offers grams only when that is plausible', async () => {
    const { amountWarning, isGramOption } = await load('@/components/food/serving');
    // 200 x "breast, boneless (174 g)"
    expect(amountWarning({ grams: 34800, kcal: 41760, amount: 200, inGrams: false })).toEqual({
      message: 'That is 34.8 kg - did you mean grams?',
      gramsAlternative: 200,
    });
    // already in grams: nothing to switch to
    expect(amountWarning({ grams: 34800, kcal: 41760, amount: 34800, inGrams: true })).toEqual({
      message: 'That is 34.8 kg - please check the amount.',
      gramsAlternative: null,
    });
    // reading the number as grams would be absurd as well
    expect(amountWarning({ grams: 6_000_000, kcal: 1, amount: 6000, inGrams: false })?.gramsAlternative).toBeNull();
    // energy only: 1 kg of oil is 9000 kcal
    expect(amountWarning({ grams: 1000, kcal: 9000, amount: 5, inGrams: false })).toEqual({
      message: 'That is 9000 kcal - did you mean grams?',
      gramsAlternative: 5,
    });
    expect(amountWarning({ grams: 1000, kcal: 9000, amount: 1000, inGrams: true })?.message).toBe('That is 9000 kcal - please check the amount.');
    // ordinary and unknown amounts do not warn
    expect(amountWarning({ grams: 200, kcal: 330, amount: 200, inGrams: true })).toBeNull();
    expect(amountWarning({ grams: 5000, kcal: 5000, amount: 5000, inGrams: true })).toBeNull();
    expect(amountWarning({ grams: null, amount: null, inGrams: false })).toBeNull();
    expect(isGramOption({ key: 'g', label: 'g', gramsPerUnit: 1 })).toBe(true);
    expect(isGramOption({ key: 'p:1', label: 'G', gramsPerUnit: 1 })).toBe(true);
    expect(isGramOption({ key: 'p:2', label: 'g', gramsPerUnit: 1.5 })).toBe(false);
    expect(isGramOption({ key: 'oz', label: 'oz', gramsPerUnit: 28.35 })).toBe(false);
  });

  it('lib/uuid.ts: only canonical uuids are sent to the database', async () => {
    const { isUuid } = await load('@/lib/uuid');
    expect(isUuid('70d7298e-57b3-4137-ae26-eed81ab766fd')).toBe(true);
    expect(isUuid('70D7298E-57B3-4137-AE26-EED81AB766FD')).toBe(true);
    for (const bad of ['not-a-uuid', '', undefined, null, '70d7298e57b34137ae26eed81ab766fd', '70d7298e-57b3-4137-ae26-eed81ab766fd ', "'; drop table foods;--"]) {
      expect(isUuid(bad), String(bad)).toBe(false);
    }
  });

  it('foods.ts updateFoodRows: a rename is saved in place, changed nutrients of a logged food fall back to supersede_food', async () => {
    const { updateFoodRows } = await load('@/data/foods');
    const input = (backend: ReturnType<typeof connect>['backend'], over: Record<string, unknown> = {}) => {
      const row = backend.rows('foods').find((f) => f.id === IDS.food.cevapi) as Record<string, unknown>;
      return { name: 'Ćevapi', nutrients: { ...(row.nutrients as object) }, carbBasis: row.carb_basis, densityGPerMl: null, servings: [{ name: 'porcija (10 komada)', grams: 200 }], ...over };
    };

    const renamed = connect();
    expect(await updateFoodRows(IDS.food.cevapi, input(renamed.backend, { name: 'Ćevapi (domaći)' }))).toEqual({ id: IDS.food.cevapi, superseded: false });
    expect(renamed.backend.mutationsOf('rpc:supersede_food', 'rpc')).toEqual([]);
    expect(renamed.backend.mutations.filter((m) => !m.ok)).toEqual([]);

    // The cevapi are logged (diary entries): the mock rejects the in-place nutrient update like the trigger does.
    const { backend } = connect();
    const nutrients = { ...(input(backend).nutrients as Record<string, number>), ENERGY_KCAL: 270 };
    const result = await updateFoodRows(IDS.food.cevapi, input(backend, { nutrients }));
    expect(result.superseded).toBe(true);
    expect(result.id).not.toBe(IDS.food.cevapi);
    const rejected = backend.mutations.find((m) => m.table === 'foods' && m.op === 'update' && !m.ok);
    expect(rejected?.error).toContain('23001');
    expect(backend.mutationsOf('rpc:supersede_food', 'rpc')).toHaveLength(1);
    const old = backend.rows('foods').find((f) => f.id === IDS.food.cevapi) as Record<string, any>;
    const next = backend.rows('foods').find((f) => f.id === result.id) as Record<string, any>;
    expect(old.archived).toBe(true);
    expect(old.nutrients.ENERGY_KCAL).toBe(258);
    expect(next).toMatchObject({ version: 2, supersedes: IDS.food.cevapi, archived: false });
    expect(next.nutrients.ENERGY_KCAL).toBe(270);
    expect(backend.rows('food_portions').filter((p) => p.food_id === result.id)).toHaveLength(1);
    expect(backend.rows('diary_entries').some((e) => e.food_id === IDS.food.cevapi)).toBe(true);
    expect(backend.integrityErrors()).toEqual([]);
    expect(backend.unhandled).toEqual([]);
  });

  it('recipes.ts updateRecipeRows: servings are saved in place, a changed ingredient amount supersedes the logged recipe', async () => {
    const { updateRecipeRows } = await load('@/data/recipes');
    const recipeId = IDS.food.recipeChickenRice;
    const ingredients = (backend: ReturnType<typeof connect>['backend'], chickenGrams = 300) =>
      backend
        .rows('recipe_ingredients')
        .filter((r) => r.recipe_food_id === recipeId)
        .map((r) => ({ foodId: r.ingredient_food_id as string, grams: r.ingredient_food_id === IDS.food.chickenRaw ? chickenGrams : Number(r.grams) }));

    const inPlace = connect();
    const kept = await updateRecipeRows(USER.id, { foodId: recipeId, name: 'Piletina s rižom', servings: 3, finalWeightG: 900, notes: '', ingredients: ingredients(inPlace.backend) });
    expect(kept).toEqual({ foodId: recipeId, previousFoodId: recipeId, superseded: false });
    expect(inPlace.backend.mutationsOf('rpc:supersede_food', 'rpc')).toEqual([]);
    expect(inPlace.backend.mutations.filter((m) => !m.ok)).toEqual([]);
    expect(inPlace.backend.rows('recipes').find((r) => r.food_id === recipeId)?.servings).toBe(3);

    const { backend } = connect();
    const next = await updateRecipeRows(USER.id, { foodId: recipeId, name: 'Piletina s rižom', servings: 2, finalWeightG: 900, notes: '', ingredients: ingredients(backend, 250) });
    expect(next.superseded).toBe(true);
    expect(next.foodId).not.toBe(recipeId);
    expect(backend.mutations.find((m) => m.table === 'foods' && m.op === 'update' && !m.ok)?.error).toContain('23001');
    expect(backend.mutationsOf('rpc:supersede_food', 'rpc')).toHaveLength(1);
    expect(backend.rows('foods').find((f) => f.id === recipeId)?.archived).toBe(true);
    expect(backend.rows('foods').find((f) => f.id === next.foodId)).toMatchObject({ version: 2, supersedes: recipeId, archived: false });
    const chicken = (id: string) => backend.rows('recipe_ingredients').find((r) => r.recipe_food_id === id && r.ingredient_food_id === IDS.food.chickenRaw)?.grams;
    expect(chicken(next.foodId)).toBe(250);
    expect(chicken(recipeId)).toBe(300); // the logged version keeps its ingredients
    expect(backend.integrityErrors()).toEqual([]);
    expect(backend.unhandled).toEqual([]);
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
