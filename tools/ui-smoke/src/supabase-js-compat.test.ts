/**
 * Contract test: the REAL supabase-js client (the one the app ships) talks to the mock backend, using the exact
 * query chains of the app's data hooks. This is the closest thing to running the app that is possible without a
 * browser: it proves the mock understands what supabase-js really sends (URL syntax, Prefer / Accept headers,
 * embedded selects, referencedTable, upsert options, single / maybeSingle, rpc, functions.invoke, auth).
 *
 * The client is resolved from apps/app (pnpm) so no dependency is added to this package; the suite is skipped
 * when it is not installed.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ANON_KEY, BACKEND_ORIGIN, FIXED_NOW_MS, STORAGE_KEY, TODAY } from './constants';
import { BARCODES, IDS, USER, addDays, buildFixtures } from './fixtures';
import { createMockBackend } from './mock-backend';
import { SEED_SESSION_TTL_SECONDS, buildSession } from './session';

const here = dirname(fileURLToPath(import.meta.url));

type Client = {
  from: (t: string) => any;
  rpc: (fn: string, args?: Record<string, unknown>) => any;
  auth: any;
  functions: { invoke: (name: string, opts?: unknown) => Promise<{ data: any; error: any }> };
};

async function loadCreateClient(): Promise<((url: string, key: string, options: unknown) => Client) | null> {
  try {
    const require = createRequire(join(here, '..', '..', '..', 'apps', 'app', 'package.json'));
    const mod = (await import(pathToFileURL(require.resolve('@supabase/supabase-js')).href)) as { createClient: (url: string, key: string, options: unknown) => Client };
    return mod.createClient;
  } catch {
    return null;
  }
}

const createClient = await loadCreateClient();

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: async (k: string) => data.get(k) ?? null,
    setItem: async (k: string, v: string) => void data.set(k, v),
    removeItem: async (k: string) => void data.delete(k),
    data,
  };
}

function connect(variant: Parameters<typeof buildFixtures>[0] = 'default', signedIn = true) {
  const fx = buildFixtures(variant);
  const backend = createMockBackend(fx.seed);
  const session = buildSession(USER, { nowMs: FIXED_NOW_MS, ttlSeconds: SEED_SESSION_TTL_SECONDS });
  const storage = memoryStorage(signedIn ? { [STORAGE_KEY]: JSON.stringify(session) } : {});
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const body = init?.body === undefined || init.body === null ? null : String(init.body);
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const res = backend.handle({ method: req.method, url: req.url, headers, body });
    const empty = res.body === '' || res.status === 204;
    return new Response(empty ? null : res.body, { status: res.status, headers: res.headers });
  };
  const supabase = (createClient as NonNullable<typeof createClient>)(BACKEND_ORIGIN, ANON_KEY, {
    auth: { storage, autoRefreshToken: false, persistSession: true, detectSessionInUrl: false },
    global: { fetch: fetchImpl },
  });
  return { supabase, backend, fx, storage };
}

const suite = createClient ? describe : describe.skip;

suite('supabase-js against the mock backend (query chains copied from apps/app/src/data)', () => {
  it('accepts the pre-seeded session without any network round trip', async () => {
    const { supabase, backend } = connect();
    const { data } = await supabase.auth.getSession();
    expect(data.session?.user.id).toBe(USER.id);
    expect(data.session?.access_token).toContain('.');
    expect(backend.calls).toHaveLength(0);
  });

  it('signs in with a password (and reports bad credentials)', async () => {
    const { supabase, storage } = connect('default', false);
    const bad = await supabase.auth.signInWithPassword({ email: USER.email, password: 'nope' });
    expect(bad.error?.message).toBe('Invalid login credentials');
    const ok = await supabase.auth.signInWithPassword({ email: ` ${USER.email} `.trim(), password: USER.password });
    expect(ok.error).toBeNull();
    expect(ok.data.session?.user.id).toBe(USER.id);
    expect(JSON.parse(storage.data.get(STORAGE_KEY) as string).refresh_token).toBeTruthy();
    expect((await supabase.auth.signOut()).error).toBeNull();
    expect(storage.data.has(STORAGE_KEY)).toBe(false);
  });

  it('data/profile.ts: maybeSingle, update().select().single(), upsert onConflict', async () => {
    const { supabase, backend } = connect();
    const profile = await supabase.from('profiles').select('*').maybeSingle();
    expect(profile.error).toBeNull();
    expect(profile.data).toMatchObject({ user_id: USER.id, unit_system: 'metric', onboarded: true });
    const updated = await supabase.from('profiles').update({ unit_system: 'imperial' }).eq('user_id', USER.id).select('*').single();
    expect(updated.error).toBeNull();
    expect(updated.data.unit_system).toBe('imperial');
    const upsert = await supabase.from('profiles').upsert({ user_id: USER.id, onboarded: true, timezone: 'Europe/Sarajevo' }, { onConflict: 'user_id' }).select('*').single();
    expect(upsert.error).toBeNull();
    expect(upsert.data.timezone).toBe('Europe/Sarajevo');
    expect(backend.mutationsOf('profiles', 'upsert')).toHaveLength(1);
    expect(backend.mutationsOf('profiles', 'update')).toHaveLength(1);
  });

  it('data/diary.ts: the day query with an embedded food, and the dashboard totals', async () => {
    const { supabase } = connect();
    const entries = await supabase
      .from('diary_entries')
      .select('id,entry_date,meal_group_id,food_id,grams,amount,portion_label,source,note,logged_at,foods(name,brand,kind,nutrients,carb_basis)')
      .eq('entry_date', TODAY)
      .order('logged_at', { ascending: true });
    expect(entries.error).toBeNull();
    expect(entries.data).toHaveLength(15);
    expect(entries.data[0].foods.name).toBe('Oats, rolled, dry');
    expect(entries.data[0].foods.nutrients.ENERGY_KCAL).toBe(379);

    const totals = await supabase
      .from('daily_totals')
      .select('entry_date,kcal,protein_g,carbs_g,fat_g,fiber_g,entry_count')
      .gte('entry_date', addDays(TODAY, -89))
      .lte('entry_date', TODAY)
      .order('entry_date', { ascending: true });
    expect(totals.error).toBeNull();
    expect(totals.data).toHaveLength(8);
    expect(totals.data.at(-1).entry_date).toBe(TODAY);
  });

  it('data/diary.ts: add, update, move, delete, copy day', async () => {
    const { supabase, backend, fx } = connect();
    const added = await supabase
      .from('diary_entries')
      .insert({ user_id: USER.id, entry_date: TODAY, meal_group_id: IDS.mealGroup.lunch, food_id: IDS.food.egg, grams: 100, amount: null, portion_label: null, source: 'manual', ai_confidence: null, note: null })
      .select('id')
      .single();
    expect(added.error).toBeNull();
    expect(added.data.id).toMatch(/^[0-9a-f-]{36}$/);
    const upd = await supabase.from('diary_entries').update({ grams: 150, amount: 3, portion_label: 'x' }).eq('id', added.data.id);
    expect(upd.error).toBeNull();
    const mv = await supabase.from('diary_entries').update({ meal_group_id: IDS.mealGroup.dinner }).eq('id', added.data.id);
    expect(mv.error).toBeNull();
    expect(backend.rows('diary_entries').find((e) => e.id === added.data.id)).toMatchObject({ grams: 150, meal_group_id: IDS.mealGroup.dinner });
    const del = await supabase.from('diary_entries').delete().eq('id', added.data.id);
    expect(del.error).toBeNull();

    const src = await supabase.from('diary_entries').select('meal_group_id,food_id,grams,amount,portion_label,note,logged_at').eq('entry_date', addDays(TODAY, -1)).order('logged_at', { ascending: true });
    const copy = await supabase.from('diary_entries').insert(
      src.data.map((s: any) => ({ user_id: USER.id, entry_date: TODAY, meal_group_id: s.meal_group_id, food_id: s.food_id, grams: s.grams, amount: s.amount, portion_label: s.portion_label, note: s.note, source: 'copy' })),
    );
    expect(copy.error).toBeNull();
    expect(backend.rows('diary_entries').filter((e) => e.entry_date === TODAY && e.source === 'copy')).toHaveLength(12);
    void fx;
  });

  it('data/foods.ts: search rpc, food detail, recents, favourites, my foods, barcode', async () => {
    const { supabase } = connect();
    const search = await supabase.rpc('search_foods', { q: 'cevapi', max_results: 40, kinds: ['custom', 'recipe'] });
    expect(search.error).toBeNull();
    expect(search.data.map((r: any) => r.name)).toEqual(['Ćevapi']);

    const [food, portions] = await Promise.all([
      supabase.from('foods').select('id,source,source_id,kind,owner_id,name,brand,gtin14,category,nutrients,completeness,carb_basis,density_g_per_ml,version,archived').eq('id', IDS.food.banana).maybeSingle(),
      supabase.from('food_portions').select('id,label,amount,unit,grams,sort_order').eq('food_id', IDS.food.banana).order('sort_order', { ascending: true }).order('id', { ascending: true }),
    ]);
    expect(food.error).toBeNull();
    expect(food.data.name).toBe('Banana, raw');
    expect(portions.data.map((p: any) => p.label)).toEqual(['1 medium (7" to 7-7/8" long)', '1 cup, sliced']);
    const missing = await supabase.from('foods').select('id').eq('id', IDS.missing).maybeSingle();
    expect(missing.error).toBeNull();
    expect(missing.data).toBeNull();

    const recent = await supabase.from('food_usage').select('food_id,last_used_at,use_count,foods(id,source,kind,name,brand,nutrients,completeness,archived)').order('last_used_at', { ascending: false }).limit(60);
    expect(recent.error).toBeNull();
    expect(recent.data[0].foods.name).toBeTruthy();
    const favs = await supabase.from('favorites').select('food_id,created_at,foods(id,source,kind,name,brand,nutrients,completeness,archived)').order('created_at', { ascending: false }).limit(300);
    expect(favs.data).toHaveLength(5);
    const mine = await supabase.from('foods').select('id,source,kind,name,brand,nutrients,completeness').not('owner_id', 'is', null).eq('archived', false).in('kind', ['custom', 'ai_estimate', 'recipe']).order('name', { ascending: true }).limit(500);
    expect(mine.data.map((f: any) => f.name)).toEqual(['Burek sa sirom', 'Piletina s rižom', 'Vrhnje za kuhanje', 'Ćevapi']);

    const byGtin = await supabase.rpc('get_food_by_gtin', { gtin: `0${BARCODES.nutella}` });
    expect(byGtin.data[0].id).toBe(IDS.food.nutella);
    const miss = await supabase.rpc('get_food_by_gtin', { gtin: `0${BARCODES.unknown}` });
    expect(miss.data).toEqual([]);
  });

  it('data/foods.ts: favourites toggle (upsert ignoreDuplicates + delete) and custom food creation', async () => {
    const { supabase, backend } = connect();
    const add = await supabase.from('favorites').upsert({ user_id: USER.id, food_id: IDS.food.egg }, { onConflict: 'user_id,food_id', ignoreDuplicates: true });
    expect(add.error).toBeNull();
    const again = await supabase.from('favorites').upsert({ user_id: USER.id, food_id: IDS.food.egg }, { onConflict: 'user_id,food_id', ignoreDuplicates: true });
    expect(again.error).toBeNull();
    expect(backend.rows('favorites')).toHaveLength(6);
    const rm = await supabase.from('favorites').delete().eq('user_id', USER.id).eq('food_id', IDS.food.egg);
    expect(rm.error).toBeNull();
    expect(backend.rows('favorites')).toHaveLength(5);

    const created = await supabase
      .from('foods')
      .insert({ name: 'Domaći hljeb', brand: null, gtin14: null, nutrients: { ENERGY_KCAL: 250 }, completeness: 0.02, carb_basis: 'includes_fiber', density_g_per_ml: null, owner_id: USER.id, source: 'custom', kind: 'custom' })
      .select('id')
      .single();
    expect(created.error).toBeNull();
    const portion = await supabase.from('food_portions').insert([{ food_id: created.data.id, label: '1 kriška', amount: 1, unit: 'kriška', grams: 40, sort_order: 0 }]);
    expect(portion.error).toBeNull();
    // the app's own rollback path when the portion insert fails
    const bad = await supabase.from('food_portions').insert([{ food_id: created.data.id, label: 'x', amount: 1, unit: 'x', grams: 0, sort_order: 0 }]);
    expect(bad.error?.code).toBe('23514');
  });

  it('data/foods.ts: update a logged food -> immutability trigger -> supersede_food', async () => {
    const { supabase } = connect();
    const first = await supabase.from('foods').update({ name: 'Ćevapi', nutrients: { ENERGY_KCAL: 270 } }).eq('id', IDS.food.cevapi).select('id').single();
    expect(first.error?.code).toBe('23001');
    const rpc = await supabase.rpc('supersede_food', { p_food_id: IDS.food.cevapi });
    expect(rpc.error).toBeNull();
    const second = await supabase.from('foods').update({ nutrients: { ENERGY_KCAL: 270 } }).eq('id', rpc.data).select('id').single();
    expect(second.error).toBeNull();
    const del = await supabase.from('food_portions').delete().eq('food_id', rpc.data);
    expect(del.error).toBeNull();
    const next = await supabase.from('foods').select('id').eq('supersedes', IDS.food.cevapi).maybeSingle();
    expect(next.data.id).toBe(rpc.data);
  });

  it('data/recipes.ts: list, detail with aliased embeds, fetch by ids, create', async () => {
    const { supabase, backend } = connect();
    const list = await supabase
      .from('foods')
      .select('id,name,nutrients,completeness,recipes!food_id(servings,final_weight_g,recipe_ingredients(grams))')
      .eq('kind', 'recipe')
      .eq('archived', false)
      .not('owner_id', 'is', null)
      .order('name', { ascending: true })
      .limit(500);
    expect(list.error).toBeNull();
    expect(list.data[0].recipes.recipe_ingredients).toHaveLength(5);

    const ingredients = await supabase
      .from('recipe_ingredients')
      .select('id,ingredient_food_id,grams,sort_order,food:foods!ingredient_food_id(id,name,brand,kind,source,nutrients,carb_basis,density_g_per_ml,archived)')
      .eq('recipe_food_id', IDS.food.recipeChickenRice)
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true });
    expect(ingredients.error).toBeNull();
    expect(ingredients.data[0].food.name).toBe('Chicken breast, skinless, boneless, raw');
    const recipe = await supabase.from('recipes').select('servings,final_weight_g,notes').eq('food_id', IDS.food.recipeChickenRice).maybeSingle();
    expect(recipe.data).toMatchObject({ servings: 2, final_weight_g: 900 });

    const byIds = await supabase.from('foods').select('id,name,brand,kind,source,nutrients,carb_basis,density_g_per_ml,archived,food_portions(id,label,amount,unit,grams,sort_order)').in('id', [IDS.food.oats, IDS.food.egg]);
    expect(byIds.data).toHaveLength(2);
    expect(byIds.data[0].food_portions.length).toBeGreaterThan(0);

    const food = await supabase.from('foods').insert({ name: 'Zobena kaša', nutrients: { ENERGY_KCAL: 90 }, completeness: 0.02, carb_basis: 'includes_fiber', owner_id: USER.id, source: 'recipe', kind: 'recipe' }).select('id').single();
    expect(food.error).toBeNull();
    const r = await supabase.from('recipes').insert({ food_id: food.data.id, user_id: USER.id, servings: 2, final_weight_g: null, notes: null });
    expect(r.error).toBeNull();
    const ing = await supabase.from('recipe_ingredients').insert([{ recipe_food_id: food.data.id, ingredient_food_id: IDS.food.oats, grams: 40, sort_order: 0 }]);
    expect(ing.error).toBeNull();
    expect(backend.rows('recipe_ingredients')).toHaveLength(6);
    // cleanup path used on failures
    const clean = await supabase.from('foods').delete().eq('id', food.data.id);
    expect(clean.error).toBeNull();
    expect(backend.rows('recipes')).toHaveLength(1);
  });

  it('data/saved-meals.ts: list with nested embed, create, log', async () => {
    const { supabase, backend } = connect();
    const meals = await supabase
      .from('saved_meals')
      .select('id,name,saved_meal_items(id,food_id,grams,sort_order,foods(name,brand,kind,nutrients,carb_basis,archived))')
      .order('name', { ascending: true })
      .limit(500);
    expect(meals.error).toBeNull();
    expect(meals.data).toHaveLength(2);
    expect(meals.data[0].saved_meal_items.length).toBe(3);
    const one = await supabase.from('saved_meals').select('id,name').eq('id', IDS.savedMeal.breakfast).maybeSingle();
    expect(one.data.name).toBe('Moj doručak');
    const items = await supabase.from('saved_meal_items').select('food_id,grams,sort_order').eq('saved_meal_id', IDS.savedMeal.breakfast).order('sort_order', { ascending: true });
    const log = await supabase.from('diary_entries').insert(
      items.data.map((i: any) => ({ user_id: USER.id, entry_date: TODAY, meal_group_id: IDS.mealGroup.breakfast, food_id: i.food_id, grams: i.grams, source: 'copy' })),
    );
    expect(log.error).toBeNull();
    const created = await supabase.from('saved_meals').insert({ user_id: USER.id, name: 'Užina' }).select('id').single();
    const ins = await supabase.from('saved_meal_items').insert([{ saved_meal_id: created.data.id, food_id: IDS.food.almonds, grams: 28, sort_order: 0 }]).select('id');
    expect(ins.data).toHaveLength(1);
    const del = await supabase.from('saved_meal_items').delete().in('id', [ins.data[0].id]);
    expect(del.error).toBeNull();
    expect(backend.rows('saved_meals')).toHaveLength(3);
  });

  it('data/weight.ts + goals.ts + targets.ts: biometrics, goals, macro targets, overrides, onboarding writes', async () => {
    const { supabase, backend } = connect('not-onboarded');
    expect((await supabase.from('biometrics').select('entry_date,value,unit,recorded_at').eq('type', 'weight').order('entry_date', { ascending: false }).order('recorded_at', { ascending: false }).limit(1)).data).toEqual([]);
    const weight = await supabase.from('biometrics').insert([
      { user_id: USER.id, entry_date: TODAY, type: 'weight', value: 82, unit: 'kg', source: 'manual' },
      { user_id: USER.id, entry_date: TODAY, type: 'body_fat', value: 19.5, unit: 'percent', source: 'manual' },
    ]);
    expect(weight.error).toBeNull();
    const deactivate = await supabase.from('weight_goals').update({ active: false }).eq('active', true);
    expect(deactivate.error).toBeNull();
    const goal = await supabase.from('weight_goals').insert({ user_id: USER.id, start_weight_kg: 82, target_weight_kg: 77, rate_kg_per_week: -0.5, start_date: TODAY, active: true });
    expect(goal.error).toBeNull();
    const delMacro = await supabase.from('macro_targets').delete().is('weekday', null).eq('effective_from', TODAY);
    expect(delMacro.error).toBeNull();
    const macro = await supabase.from('macro_targets').insert({ user_id: USER.id, weekday: null, effective_from: TODAY, mode: 'ratios', protein_pct: 30, carbs_pct: 40, fat_pct: 30, protein_g: null, carbs_g: null, fat_g: null, protein_g_per_kg: null, net_carbs_g: null });
    expect(macro.error).toBeNull();
    const read = await supabase.from('macro_targets').select('*').is('weekday', null).lte('effective_from', TODAY).order('effective_from', { ascending: false }).limit(1);
    expect(read.data[0]).toMatchObject({ mode: 'ratios', protein_pct: 30 });
    const activeGoal = await supabase.from('weight_goals').select('id,start_weight_kg,target_weight_kg,rate_kg_per_week,start_date,active').eq('active', true).order('start_date', { ascending: false }).limit(1);
    expect(activeGoal.data[0].rate_kg_per_week).toBe(-0.5);
    const override = await supabase.from('nutrient_targets').upsert({ user_id: USER.id, nutrient_code: 'MAGNESIUM_MG', min_value: 500, max_value: null }, { onConflict: 'user_id,nutrient_code' });
    expect(override.error).toBeNull();
    expect((await supabase.from('nutrient_targets').select('nutrient_code,min_value,max_value')).data).toHaveLength(1);
    expect((await supabase.from('nutrient_targets').delete().eq('nutrient_code', 'MAGNESIUM_MG')).error).toBeNull();
    const profile = await supabase.from('profiles').upsert({ user_id: USER.id, sex: 'male', birthdate: '1992-03-15', height_cm: 182, unit_system: 'metric', activity_level: 'light', timezone: 'Europe/Sarajevo', onboarded: true }, { onConflict: 'user_id' }).select('*').single();
    expect(profile.error).toBeNull();
    expect(backend.mutationsOf('profiles', 'upsert')).toHaveLength(1);
  });

  it('data/activity.ts + activity-write.ts: day parts, water, notes, exercise, FK fallback', async () => {
    const { supabase, backend } = connect();
    for (const [table, column] of [['exercise_entries', 'entry_date'], ['biometrics', 'entry_date'], ['notes', 'entry_date'], ['daily_energy', 'local_date']] as const) {
      const res = await supabase.from(table).select('*').eq(column, TODAY);
      expect(res.error, table).toBeNull();
      expect(res.data.length, table).toBeGreaterThan(0);
    }
    const water = await supabase.from('water_entries').select('ml').eq('entry_date', TODAY);
    expect(water.data.reduce((s: number, r: any) => s + r.ml, 0)).toBe(1080);
    const add = await supabase.from('water_entries').insert({ user_id: USER.id, entry_date: TODAY, ml: 500 }).select('id').single();
    expect(add.error).toBeNull();
    const last = await supabase.from('water_entries').select('id, ml').eq('entry_date', TODAY).order('logged_at', { ascending: false }).limit(1).maybeSingle();
    expect(last.data.id).toBe(add.data.id);
    expect((await supabase.from('water_entries').delete().eq('id', last.data.id)).error).toBeNull();
    const note = await supabase.from('notes').insert({ user_id: USER.id, entry_date: TODAY, body: 'x' }).select('id').single();
    expect(note.error).toBeNull();
    const badCode = await supabase.from('exercise_entries').insert({ user_id: USER.id, entry_date: TODAY, activity_code: 'NOT_A_CODE', name: 'x', minutes: 1, kcal: 1, source: 'manual', started_at: null, ended_at: null, counts_toward_energy: true }).select('id').single();
    expect(badCode.error?.code).toBe('23503'); // the app retries without the code
    const retry = await supabase.from('exercise_entries').insert({ user_id: USER.id, entry_date: TODAY, activity_code: null, name: 'x', minutes: 1, kcal: 1, source: 'manual', started_at: null, ended_at: null, counts_toward_energy: true }).select('id').single();
    expect(retry.error).toBeNull();
    const recent = await supabase.from('biometrics').select('*').eq('type', 'bp_systolic').lte('entry_date', TODAY).order('entry_date', { ascending: false }).order('recorded_at', { ascending: false }).limit(1).maybeSingle();
    expect(recent.data.value).toBe(118);
    expect(backend.unhandled).toEqual([]);
  });

  it('data/coach.ts + health/*: threads with referenced-table order/limit, messages, integrations, grounding', async () => {
    const { supabase, backend } = connect();
    const threads = await supabase
      .from('coach_threads')
      .select('id,title,created_at,updated_at,coach_messages(role,content,created_at)')
      .order('updated_at', { ascending: false })
      .limit(100)
      .order('created_at', { ascending: false, referencedTable: 'coach_messages' })
      .limit(1, { referencedTable: 'coach_messages' });
    expect(threads.error).toBeNull();
    expect(threads.data).toHaveLength(3);
    expect(threads.data.every((t: any) => t.coach_messages.length === 1)).toBe(true);
    const messages = await supabase.from('coach_messages').select('id,thread_id,role,content,created_at').eq('thread_id', IDS.thread['1']).order('created_at', { ascending: true }).limit(500);
    expect(messages.data.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    const created = await supabase.from('coach_threads').insert({ user_id: USER.id, title: 'Nova' }).select('id,title,created_at,updated_at').single();
    const msg = await supabase.from('coach_messages').insert({ thread_id: created.data.id, user_id: USER.id, role: 'user', content: 'hej' }).select('id,thread_id,role,content,created_at').single();
    expect(msg.error).toBeNull();
    expect((await supabase.from('coach_threads').update({ updated_at: new Date().toISOString() }).eq('id', created.data.id)).error).toBeNull();
    expect((await supabase.from('coach_threads').update({ title: 'x' }).eq('id', created.data.id)).error).toBeNull();
    const removed = await supabase.rpc('delete_all_my_coach_data');
    expect(removed.data).toBe(4);

    const integ = await supabase.from('integrations').upsert({ user_id: USER.id, provider: 'apple_health', enabled: true }, { onConflict: 'user_id,provider' }).select('id, user_id, provider, enabled, settings, backfill_date, last_sync_at').single();
    expect(integ.error).toBeNull();
    const fetched = await supabase.from('integrations').select('id, user_id, provider, enabled, settings, backfill_date, last_sync_at').eq('user_id', USER.id).eq('provider', 'apple_health').maybeSingle();
    expect(fetched.data.enabled).toBe(true);
    const ext = await supabase.from('exercise_entries').select('id, external_id').eq('user_id', USER.id).eq('source', 'apple_health').in('external_id', ['a', 'HK-WORKOUT-2026-11-10-0900']);
    expect(ext.data).toHaveLength(1);
    const energy = await supabase.from('daily_energy').upsert([{ user_id: USER.id, local_date: TODAY, source: 'apple_health', active_kcal: 500, resting_kcal: 1500, steps: 9000 }], { onConflict: 'user_id,local_date,source' });
    expect(energy.error).toBeNull();
    expect(backend.rows('daily_energy')).toHaveLength(1);
    const sleep = await supabase.from('biometrics').select('entry_date,type,value,unit').in('type', ['sleep_duration', 'sleep_score']).gte('entry_date', addDays(TODAY, -13)).lte('entry_date', TODAY);
    expect(sleep.error).toBeNull();
    expect(backend.unhandled).toEqual([]);
  });

  it('count: exact + head, ranges and the rest of the PostgREST surface supabase-js can send', async () => {
    const { supabase } = connect();
    const head = await supabase.from('foods').select('*', { count: 'exact', head: true });
    expect(head.error).toBeNull();
    expect(head.count).toBe(31);
    expect(head.data).toBeNull();
    const counted = await supabase.from('foods').select('id,name', { count: 'exact' }).order('name').range(0, 4);
    expect(counted.data).toHaveLength(5);
    expect(counted.count).toBe(31);
    const like = await supabase.from('foods').select('name').ilike('name', '%chicken%').or('kind.eq.generic,kind.eq.recipe');
    expect(like.data).toHaveLength(2);
    const single = await supabase.from('foods').select('id').eq('id', IDS.missing).single();
    expect(single.error?.code).toBe('PGRST116');
    const many = await supabase.from('foods').select('id').maybeSingle();
    expect(many.error?.code).toBe('PGRST116'); // more than one row
  });

  it('functions.invoke: undeployed Edge Functions fail like the gateway (the app classifies the error)', async () => {
    const { supabase, backend } = connect();
    const res = await supabase.functions.invoke('barcode-lookup', { body: { gtin: '03017620422003' } });
    expect(res.data).toBeNull();
    expect(res.error?.name).toBe('FunctionsHttpError');
    expect(res.error?.context.status).toBe(404);
    const body = await res.error?.context.json();
    expect(body).toMatchObject({ code: 'NOT_FOUND', error: 'not_deployed' });
    expect(String(body.message)).toMatch(/function/i); // data/foods.ts isGatewayNotFound()
    expect(backend.calls.at(-1)).toMatchObject({ kind: 'function', target: 'barcode-lookup' });
  });

  it('schema mismatches surface as errors instead of silently empty data', async () => {
    const { supabase } = connect();
    expect((await supabase.from('foods').select('id,calories')).error?.code).toBe('42703');
    expect((await supabase.from('diary').select('*')).error?.code).toBe('PGRST205');
    expect((await supabase.from('foods').select('name,nutrients(code)')).error?.code).toBe('PGRST200');
    expect((await supabase.from('diary_entries').update({ grams: 1 }).select('id')).error?.code).toBe('21000');
  });
});
