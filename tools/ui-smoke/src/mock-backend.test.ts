import { describe, expect, it } from 'vitest';

import { ANON_KEY, APP_ORIGIN, BACKEND_ORIGIN, FIXED_NOW_MS } from './constants';
import { BARCODES, IDS, USER, buildFixtures, type FixtureVariant } from './fixtures';
import { createMockBackend, type MockBackend, type MockSeed } from './mock-backend';
import { SEED_SESSION_TTL_SECONDS, buildSession, makeJwt, stableUuid } from './session';

const TOKEN = buildSession(USER, { nowMs: FIXED_NOW_MS, ttlSeconds: SEED_SESSION_TTL_SECONDS }).access_token;

interface Reply {
  status: number;
  headers: Record<string, string>;
  json: any;
  text: string;
}

function api(backend: MockBackend, token: string | null = TOKEN) {
  return (method: string, path: string, init: { body?: unknown; headers?: Record<string, string> } = {}): Reply => {
    const res = backend.handle({
      method,
      url: `${BACKEND_ORIGIN}${path}`,
      headers: {
        apikey: ANON_KEY,
        authorization: `Bearer ${token ?? ANON_KEY}`,
        origin: APP_ORIGIN,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      body: init.body === undefined ? null : JSON.stringify(init.body),
    });
    return { status: res.status, headers: res.headers, text: res.body, json: res.body ? JSON.parse(res.body) : null };
  };
}

const ONE = { accept: 'application/vnd.pgrst.object+json' };
const REP = { prefer: 'return=representation' };

function setup(variant: FixtureVariant = 'default') {
  const fx = buildFixtures(variant);
  const backend = createMockBackend(fx.seed);
  return { fx, backend, call: api(backend) };
}

describe('CORS and transport', () => {
  it('answers preflight requests for the supabase-js headers', () => {
    const { backend } = setup();
    const res = backend.handle({
      method: 'OPTIONS',
      url: `${BACKEND_ORIGIN}/rest/v1/foods`,
      headers: { origin: APP_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'apikey,authorization,content-type,prefer,x-client-info' },
    });
    expect(res.status).toBe(204);
    for (const h of ['apikey', 'authorization', 'content-type', 'prefer', 'accept', 'accept-profile', 'content-profile', 'x-client-info', 'range']) {
      expect(res.headers['access-control-allow-headers']).toContain(h);
    }
    expect(res.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    expect(res.body).toBe('');
  });

  it('adds CORS headers (and exposes Content-Range) to every response, errors included', () => {
    const { call } = setup();
    for (const reply of [call('GET', '/rest/v1/foods?limit=1'), call('GET', '/rest/v1/nope'), call('GET', '/auth/v1/user'), call('POST', '/functions/v1/barcode-lookup', { body: {} })]) {
      expect(reply.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
      expect(reply.headers['access-control-expose-headers']).toContain('Content-Range');
    }
  });

  it('records every call', () => {
    const { backend, call } = setup();
    call('GET', '/rest/v1/foods?limit=1');
    call('GET', '/rest/v1/nope');
    expect(backend.calls.map((c) => [c.kind, c.target, c.status])).toEqual([
      ['rest', 'foods', 200],
      ['rest', 'nope', 404],
    ]);
  });
});

describe('select, filters, order, pagination', () => {
  it('returns requested columns only and * without generated search columns', () => {
    const { call } = setup();
    const some = call('GET', '/rest/v1/foods?select=id,name&limit=2');
    expect(Object.keys(some.json[0])).toEqual(['id', 'name']);
    const star = call('GET', '/rest/v1/foods?select=*&limit=1');
    expect(star.json[0]).toHaveProperty('nutrients');
    expect(star.json[0]).not.toHaveProperty('search_text');
  });

  it('filters with eq / neq / in / is / not / ilike / gt', () => {
    const { call, fx } = setup();
    expect(call('GET', `/rest/v1/foods?select=name&id=eq.${fx.ids.food.egg}`).json).toEqual([{ name: 'Egg, whole, raw' }]);
    const neq = call('GET', '/rest/v1/foods?select=id&kind=neq.generic&owner_id=is.null');
    expect(neq.json.length).toBe(1); // Nutella (branded, global)
    const inList = call('GET', `/rest/v1/foods?select=name&id=in.(${fx.ids.food.egg},${fx.ids.food.milk})&order=name.asc`);
    expect(inList.json.map((r: any) => r.name)).toEqual(['Egg, whole, raw', 'Milk, whole, 3.25% fat']);
    const owned = call('GET', '/rest/v1/foods?select=name&owner_id=not.is.null&order=name.asc');
    expect(owned.json.map((r: any) => r.name)).toEqual(['Burek sa sirom', 'Piletina s rižom', 'Vrhnje za kuhanje', 'Ćevapi']);
    const ilike = call('GET', '/rest/v1/foods?select=name&name=ilike.*CHICKEN*');
    expect(ilike.json.length).toBe(2);
    const gt = call('GET', '/rest/v1/food_portions?select=grams&grams=gt.200');
    expect(gt.json.every((r: any) => r.grams > 200)).toBe(true);
    const neg = call('GET', `/rest/v1/foods?select=id&id=not.in.(${fx.ids.food.egg})&limit=100`);
    expect(neg.json.length).toBe(30);
  });

  it('supports or(...) with nested and(...)', () => {
    const { call } = setup();
    const res = call('GET', '/rest/v1/foods?select=name&or=(name.eq.Honey,and(kind.eq.recipe,name.ilike.*pilet*))&order=name.asc');
    expect(res.json.map((r: any) => r.name)).toEqual(['Honey', 'Piletina s rižom']);
  });

  it('orders with nulls semantics, limit and offset', () => {
    const { call } = setup();
    const desc = call('GET', '/rest/v1/foods?select=name,brand&order=brand.desc&limit=2');
    expect(desc.json[0].brand).toBeNull(); // Postgres sorts NULLs as the largest value: first when descending
    const nullsLast = call('GET', '/rest/v1/foods?select=name,brand&order=brand.desc.nullslast&limit=1');
    expect(nullsLast.json[0].brand).toBe('Meggle');
    const a = call('GET', '/rest/v1/foods?select=name&order=name.asc&limit=3&offset=0').json;
    const b = call('GET', '/rest/v1/foods?select=name&order=name.asc&limit=3&offset=3').json;
    expect(a.length).toBe(3);
    expect(a[2].name < b[0].name).toBe(true);
  });

  it('returns Content-Range with count=exact (and honours Range)', () => {
    const { call } = setup();
    const res = call('GET', '/rest/v1/foods?select=id&limit=5', { headers: { prefer: 'count=exact' } });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('0-4/31');
    const head = call('HEAD', '/rest/v1/foods?select=id', { headers: { prefer: 'count=exact' } });
    expect(head.status).toBe(200);
    expect(head.text).toBe('');
    expect(head.headers['content-range']).toBe('0-30/31');
    const ranged = call('GET', '/rest/v1/foods?select=id', { headers: { range: '0-9', 'range-unit': 'items', prefer: 'count=exact' } });
    expect(ranged.json.length).toBe(10);
    expect(ranged.headers['content-range']).toBe('0-9/31');
  });

  it('rejects unknown columns and invalid input like PostgREST', () => {
    const { call } = setup();
    expect(call('GET', '/rest/v1/foods?select=id,nope').json).toMatchObject({ code: '42703', message: 'column foods.nope does not exist' });
    expect(call('GET', '/rest/v1/foods?nope=eq.1').status).toBe(400);
    expect(call('GET', '/rest/v1/foods?id=eq.undefined').json.code).toBe('22P02');
    expect(call('GET', '/rest/v1/diary_entries?entry_date=eq.tomorrow').json.code).toBe('22007');
    expect(call('GET', '/rest/v1/food_portions?grams=gt.abc').json.code).toBe('22P02');
  });

  it('reports unsupported features instead of silently ignoring them', () => {
    const { call, backend } = setup();
    const res = call('GET', '/rest/v1/foods?select=name,food_portions(label)&food_portions.grams=gt.1');
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('MOCK_UNSUPPORTED');
    expect(backend.warnings.join('\n')).toContain('embedded resources');
  });

  it('applies the RLS-like scope: own rows only, global foods for everybody, nothing for anon', () => {
    const fx = buildFixtures();
    const other = { id: stableUuid('user:other'), email: 'other@ration.test', password: 'x', createdAt: '2026-10-02T00:00:00+00:00' };
    const seed: MockSeed = {
      users: [...fx.seed.users, other],
      tables: {
        ...fx.seed.tables,
        notes: [
          ...(fx.seed.tables.notes ?? []),
          { id: stableUuid('note:other'), user_id: other.id, entry_date: '2026-11-10', body: 'secret', created_at: '2026-11-10T10:00:00+00:00' },
        ],
        foods: [
          ...(fx.seed.tables.foods ?? []),
          { id: stableUuid('food:other'), source: 'custom', kind: 'custom', owner_id: other.id, name: 'Other private food', nutrients: {} },
        ],
      },
    };
    const backend = createMockBackend(seed);
    const mine = api(backend);
    expect(mine('GET', '/rest/v1/notes?select=body').json.map((n: any) => n.body)).not.toContain('secret');
    expect(mine('GET', '/rest/v1/foods?select=name&name=ilike.*other private*').json).toEqual([]);
    expect(mine('GET', '/rest/v1/foods?select=id&limit=1000').json.length).toBe(31);
    const anon = api(backend, null);
    expect(anon('GET', '/rest/v1/foods?select=id').status).toBe(401);
    // another user cannot touch my row: the update silently matches nothing
    const theirs = api(backend, buildSession(other, { nowMs: FIXED_NOW_MS, ttlSeconds: 3600 }).access_token);
    const patch = theirs('PATCH', `/rest/v1/notes?id=eq.${stableUuid('note:today')}`, { body: { body: 'hacked' }, headers: { prefer: 'return=representation' } });
    expect(patch.json).toEqual([]);
  });
});

describe('resource embedding', () => {
  it('embeds to-one relations as objects and to-many as arrays', () => {
    const { call, fx } = setup();
    const entries = call('GET', `/rest/v1/diary_entries?select=id,grams,foods(name,brand,nutrients)&entry_date=eq.2026-11-10&order=logged_at.asc`);
    expect(entries.json.length).toBe(15);
    expect(entries.json[0].foods).toMatchObject({ name: 'Oats, rolled, dry', brand: null });
    expect(Array.isArray(entries.json[0].foods)).toBe(false);
    const withPortions = call('GET', `/rest/v1/foods?select=name,food_portions(label,grams,sort_order)&id=eq.${fx.ids.food.cevapi}`);
    expect(withPortions.json[0].food_portions.map((p: any) => p.label)).toEqual(['1 ćevap', '1 porcija (10 komada)']);
  });

  it('supports aliases, hints, one-to-one embeds and nested embeds', () => {
    const { call, fx } = setup();
    const ing = call('GET', `/rest/v1/recipe_ingredients?select=id,grams,food:foods!ingredient_food_id(id,name)&recipe_food_id=eq.${fx.ids.food.recipeChickenRice}&order=sort_order.asc`);
    expect(ing.json.map((r: any) => r.food.name)).toEqual([
      'Chicken breast, skinless, boneless, raw',
      'Rice, white, long-grain, cooked',
      'Broccoli, raw',
      'Oil, olive, extra virgin',
      'Tomato, red, ripe, raw',
    ]);
    const recipes = call('GET', '/rest/v1/foods?select=id,name,recipes!food_id(servings,final_weight_g,recipe_ingredients(grams))&kind=eq.recipe&archived=eq.false&owner_id=not.is.null&order=name.asc&limit=500');
    expect(recipes.json).toHaveLength(1);
    expect(recipes.json[0].recipes).toMatchObject({ servings: 2, final_weight_g: 900 });
    expect(recipes.json[0].recipes.recipe_ingredients).toHaveLength(5);
    const meals = call('GET', '/rest/v1/saved_meals?select=id,name,saved_meal_items(id,food_id,grams,sort_order,foods(name,brand,kind,nutrients,carb_basis,archived))&order=name.asc');
    expect(meals.json).toHaveLength(2);
    expect(meals.json[0].saved_meal_items[0].foods.name).toBeTruthy();
    const usage = call('GET', '/rest/v1/food_usage?select=food_id,last_used_at,use_count,foods(id,name,archived)&order=last_used_at.desc&limit=60');
    expect(usage.json.length).toBeGreaterThan(20);
    expect(usage.json[0].foods.name).toBeTruthy();
  });

  it('supports order / limit of embedded resources (referencedTable) like the coach thread list', () => {
    const { call } = setup();
    const res = call(
      'GET',
      '/rest/v1/coach_threads?select=id,title,coach_messages(role,content,created_at)&order=updated_at.desc&limit=30&coach_messages.order=created_at.desc&coach_messages.limit=1',
    );
    expect(res.status).toBe(200);
    expect(res.json).toHaveLength(3);
    for (const thread of res.json) {
      expect(thread.coach_messages).toHaveLength(1);
      expect(thread.coach_messages[0].role).toBe('assistant'); // the newest message of every thread
    }
    expect(call('GET', '/rest/v1/coach_threads?select=id&nonsense.limit=1').json.code).toBe('PGRST108');
  });

  it('honours !inner and fails for unknown / ambiguous relationships', () => {
    const { call } = setup();
    const inner = call('GET', '/rest/v1/foods?select=name,recipes!inner(servings)');
    expect(inner.json.map((r: any) => r.name)).toEqual(['Piletina s rižom']);
    const left = call('GET', '/rest/v1/foods?select=name,recipes(servings)&limit=100');
    expect(left.json.length).toBe(31);
    expect(left.json.filter((r: any) => r.recipes === null).length).toBe(30);
    expect(call('GET', '/rest/v1/foods?select=name,diary(grams)').json.code).toBe('PGRST200');
    const ambiguous = call('GET', '/rest/v1/foods?select=name,foods(name)');
    expect(ambiguous.status).toBe(300);
    expect(ambiguous.json.code).toBe('PGRST201');
    expect(call('GET', '/rest/v1/foods?select=name,recipes!nonsense_hint(servings)').json.code).toBe('PGRST200');
  });
});

describe('single object responses', () => {
  it('returns an object for exactly one row and 406 PGRST116 otherwise', () => {
    const { call, fx } = setup();
    const one = call('GET', `/rest/v1/foods?select=id,name&id=eq.${fx.ids.food.egg}`, { headers: ONE });
    expect(one.status).toBe(200);
    expect(one.json).toEqual({ id: fx.ids.food.egg, name: 'Egg, whole, raw' });
    expect(one.headers['content-type']).toContain('application/vnd.pgrst.object+json');
    const none = call('GET', `/rest/v1/foods?select=id&id=eq.${fx.ids.missing}`, { headers: ONE });
    expect(none.status).toBe(406);
    expect(none.json).toMatchObject({ code: 'PGRST116', details: 'The result contains 0 rows' });
    const many = call('GET', '/rest/v1/foods?select=id&kind=eq.generic', { headers: ONE });
    expect(many.status).toBe(406);
    expect(many.json.details).toMatch(/contains \d+ rows/);
  });

  it('a failed single() after a mutation rolls the mutation back', () => {
    const { call, backend, fx } = setup();
    const before = backend.rows('diary_entries').length;
    const res = call('PATCH', `/rest/v1/diary_entries?entry_date=eq.2026-11-10&select=id`, { body: { grams: 1 }, headers: { ...ONE, ...REP } });
    expect(res.status).toBe(406);
    expect(backend.rows('diary_entries').filter((e) => e.grams === 1)).toHaveLength(0);
    expect(backend.rows('diary_entries')).toHaveLength(before);
    expect(backend.mutations.at(-1)).toMatchObject({ table: 'diary_entries', op: 'update', ok: false, status: 406 });
    void fx;
  });
});

describe('inserts', () => {
  const entry = (fx: ReturnType<typeof buildFixtures>, extra: Record<string, unknown> = {}) => ({
    user_id: USER.id,
    entry_date: '2026-11-10',
    meal_group_id: fx.ids.mealGroup.lunch,
    food_id: fx.ids.food.egg,
    grams: 100,
    ...extra,
  });

  it('inserts with minimal return (201, empty body) and logs the mutation', () => {
    const { call, backend, fx } = setup();
    const res = call('POST', '/rest/v1/diary_entries', { body: entry(fx) });
    expect(res.status).toBe(201);
    expect(res.text).toBe('');
    expect(backend.mutationsOf('diary_entries', 'insert')).toHaveLength(1);
    expect(backend.mutationsOf('diary_entries', 'insert')[0]?.payload).toMatchObject({ food_id: fx.ids.food.egg, grams: 100 });
  });

  it('returns the generated row for return=representation + single()', () => {
    const { call, fx } = setup();
    const res = call('POST', '/rest/v1/diary_entries?select=id,source,logged_at', { body: entry(fx), headers: { ...ONE, ...REP } });
    expect(res.status).toBe(201);
    expect(res.json.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.json.source).toBe('manual');
    expect(res.json.logged_at).toMatch(/^2026-11-10T11:00:00\.\d+\+00:00$/);
  });

  it('applies the diary trigger: food_usage and the daily_totals view follow', () => {
    const { call, backend, fx } = setup();
    const kcalBefore = call('GET', '/rest/v1/daily_totals?select=kcal,entry_count&entry_date=eq.2026-11-10', { headers: ONE }).json;
    const usageBefore = Number(backend.rows('food_usage').find((u) => u.food_id === fx.ids.food.egg)?.use_count ?? 0);
    call('POST', '/rest/v1/diary_entries', { body: entry(fx, { grams: 200 }) });
    const after = call('GET', '/rest/v1/daily_totals?select=kcal,entry_count&entry_date=eq.2026-11-10', { headers: ONE }).json;
    expect(after.entry_count).toBe(kcalBefore.entry_count + 1);
    expect(after.kcal).toBeCloseTo(kcalBefore.kcal + 143 * 2, 1);
    const usageAfter = backend.rows('food_usage').find((u) => u.food_id === fx.ids.food.egg);
    expect(usageAfter?.use_count).toBe(usageBefore + 1);
  });

  it('bulk inserts give missing keys NULL (supabase-js defaultToNull) unless missing=default', () => {
    const { call, backend, fx } = setup();
    const bulk = call('POST', '/rest/v1/notes?columns=%22user_id%22,%22entry_date%22,%22body%22,%22created_at%22', {
      body: [
        { user_id: USER.id, entry_date: '2026-11-10', body: 'a', created_at: '2026-11-10T10:00:00+00:00' },
        { user_id: USER.id, entry_date: '2026-11-10', body: 'b' },
      ],
    });
    expect(bulk.status).toBe(400); // created_at NOT NULL, explicit NULL overrides the default
    expect(bulk.json.code).toBe('23502');
    const ok = call('POST', '/rest/v1/notes', {
      body: [
        { user_id: USER.id, entry_date: '2026-11-10', body: 'a', created_at: '2026-11-10T10:00:00+00:00' },
        { user_id: USER.id, entry_date: '2026-11-10', body: 'b' },
      ],
      headers: { prefer: 'missing=default' },
    });
    expect(ok.status).toBe(201);
    expect(backend.rows('notes').filter((n) => n.body === 'b')[0]?.created_at).toBeTruthy();
    void fx;
  });

  it('enforces constraints like Postgres', () => {
    const { call, fx } = setup();
    expect(call('POST', '/rest/v1/diary_entries', { body: entry(fx, { grams: 0 }) }).json.code).toBe('23514');
    expect(call('POST', '/rest/v1/diary_entries', { body: entry(fx, { source: 'telepathy' }) }).json.code).toBe('23514');
    expect(call('POST', '/rest/v1/diary_entries', { body: entry(fx, { food_id: stableUuid('nope') }) }).json).toMatchObject({ code: '23503' });
    expect(call('POST', '/rest/v1/diary_entries', { body: entry(fx, { meal_group_id: stableUuid('nope') }) }).json.code).toBe('23503');
    expect(call('POST', '/rest/v1/diary_entries', { body: entry(fx, { entry_date: '2026-02-31' }) }).json.code).toBe('22007');
    expect(call('POST', '/rest/v1/diary_entries', { body: entry(fx, { bogus: 1 }) }).json.code).toBe('PGRST204');
    expect(call('POST', '/rest/v1/diary_entries', { body: { ...entry(fx), food_id: undefined } }).json.code).toBe('23502');
    expect(call('POST', '/rest/v1/diary_entries', { body: entry(fx, { user_id: stableUuid('someone-else') }) }).status).toBe(403);
    expect(call('POST', '/rest/v1/foods', { body: { name: '  ', source: 'custom', kind: 'custom', owner_id: USER.id } }).json.code).toBe('23514');
    // clients cannot create global / branded foods
    expect(call('POST', '/rest/v1/foods', { body: { name: 'X', source: 'off', kind: 'branded', owner_id: null } }).status).toBe(403);
    expect(call('POST', '/rest/v1/nutrients', { body: { code: 'X', name: 'x', unit: 'g', nutrient_group: 'general' } }).status).toBe(403);
    expect(call('POST', '/rest/v1/daily_totals', { body: {} }).status).toBe(403);
  });

  it('normalises GTINs like the foods trigger and validates nutrient maps', () => {
    const { call } = setup();
    const ok = call('POST', '/rest/v1/foods?select=gtin14,completeness', {
      body: { name: 'Test', source: 'custom', kind: 'custom', owner_id: USER.id, gtin14: '3017620422003', nutrients: { ENERGY_KCAL: 10 } },
      headers: { ...ONE, ...REP },
    });
    expect(ok.json.gtin14).toBe('03017620422003');
    const bad = call('POST', '/rest/v1/foods', { body: { name: 'Bad', source: 'custom', kind: 'custom', owner_id: USER.id, nutrients: { ENERGY_KCAL: 'ten' } } });
    expect(bad.json.code).toBe('23514');
  });

  it('requires a WHERE clause for update and delete (pg-safeupdate)', () => {
    const { call } = setup();
    expect(call('PATCH', '/rest/v1/diary_entries', { body: { grams: 5 } }).json).toMatchObject({ code: '21000', message: 'UPDATE requires a WHERE clause' });
    expect(call('DELETE', '/rest/v1/diary_entries').json.code).toBe('21000');
  });
});

describe('upsert', () => {
  it('merges duplicates on the primary key (profiles) and returns the merged row', () => {
    const { call, backend } = setup('not-onboarded');
    const res = call('POST', '/rest/v1/profiles?on_conflict=user_id&select=*', {
      body: { user_id: USER.id, sex: 'male', birthdate: '1992-03-15', height_cm: 182, onboarded: true },
      headers: { prefer: 'resolution=merge-duplicates, return=representation', ...ONE },
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ user_id: USER.id, sex: 'male', onboarded: true, display_name: 'demo' });
    expect(backend.rows('profiles')).toHaveLength(1);
    expect(backend.mutationsOf('profiles', 'upsert')).toHaveLength(1);
  });

  it('inserts when there is no conflict and ignores duplicates when asked', () => {
    const { call, backend, fx } = setup();
    const before = backend.rows('favorites').length;
    const dup = call('POST', '/rest/v1/favorites?on_conflict=user_id%2Cfood_id', {
      body: { user_id: USER.id, food_id: fx.ids.food.banana },
      headers: { prefer: 'resolution=ignore-duplicates' },
    });
    expect(dup.status).toBe(201);
    expect(backend.rows('favorites')).toHaveLength(before);
    call('POST', '/rest/v1/favorites?on_conflict=user_id%2Cfood_id', {
      body: { user_id: USER.id, food_id: fx.ids.food.egg },
      headers: { prefer: 'resolution=ignore-duplicates' },
    });
    expect(backend.rows('favorites')).toHaveLength(before + 1);
    const conflict = call('POST', '/rest/v1/favorites', { body: { user_id: USER.id, food_id: fx.ids.food.egg } });
    expect(conflict.status).toBe(409);
    expect(conflict.json.code).toBe('23505');
  });

  it('rejects on_conflict targets without a matching unique constraint (partial indexes)', () => {
    const { call } = setup();
    const res = call('POST', '/rest/v1/foods?on_conflict=source%2Csource_id', {
      body: { name: 'X', source: 'custom', kind: 'custom', owner_id: USER.id, source_id: '1' },
      headers: { prefer: 'resolution=merge-duplicates' },
    });
    expect(res.json.code).toBe('42P10');
  });
});

describe('update and delete', () => {
  it('patches rows, updating timestamps where the DB has triggers', () => {
    const { call, backend } = setup();
    const before = backend.rows('profiles')[0]?.updated_at;
    const res = call('PATCH', `/rest/v1/profiles?user_id=eq.${USER.id}&select=*`, { body: { unit_system: 'imperial' }, headers: { ...ONE, ...REP } });
    expect(res.status).toBe(200);
    expect(res.json.unit_system).toBe('imperial');
    expect(res.json.updated_at).not.toBe(before);
    expect(call('PATCH', `/rest/v1/profiles?user_id=eq.${USER.id}`, { body: { unit_system: 'martian' } }).json.code).toBe('23514');
    const minimal = call('PATCH', `/rest/v1/profiles?user_id=eq.${USER.id}`, { body: { tef_enabled: false } });
    expect(minimal.status).toBe(204);
  });

  it('deletes with ON DELETE CASCADE / SET NULL / restrict semantics', () => {
    const { call, backend, fx } = setup();
    // restrict: logged food cannot be deleted
    const refused = call('DELETE', `/rest/v1/foods?id=eq.${fx.ids.food.cevapi}`);
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('23503');
    expect(backend.rows('foods').some((f) => f.id === fx.ids.food.cevapi)).toBe(true);
    // cascade: an unlogged owned recipe disappears with its recipe row and ingredients
    call('DELETE', `/rest/v1/diary_entries?food_id=eq.${fx.ids.food.recipeChickenRice}`);
    const del = call('DELETE', `/rest/v1/foods?id=eq.${fx.ids.food.recipeChickenRice}&select=id`, { headers: REP });
    expect(del.status).toBe(200);
    expect(backend.rows('recipes')).toHaveLength(0);
    expect(backend.rows('recipe_ingredients')).toHaveLength(0);
    expect(backend.rows('food_portions').filter((p) => p.food_id === fx.ids.food.recipeChickenRice)).toHaveLength(0);
    // set null: deleting a meal group un-assigns its entries
    call('DELETE', `/rest/v1/meal_groups?id=eq.${fx.ids.mealGroup.snacks}`);
    expect(backend.rows('diary_entries').filter((e) => e.meal_group_id === fx.ids.mealGroup.snacks)).toHaveLength(0);
    expect(backend.rows('diary_entries').filter((e) => e.meal_group_id === null).length).toBeGreaterThan(0);
    // saved meals cascade to items
    call('DELETE', `/rest/v1/saved_meals?id=eq.${fx.ids.savedMeal.breakfast}`);
    expect(backend.rows('saved_meal_items').every((i) => i.saved_meal_id !== fx.ids.savedMeal.breakfast)).toBe(true);
    expect(backend.mutationsOf('foods', 'delete')).toHaveLength(1);
  });

  it('protects nutrients of logged foods and supports supersede_food', () => {
    const { call, backend, fx } = setup();
    const blocked = call('PATCH', `/rest/v1/foods?id=eq.${fx.ids.food.cevapi}&select=id`, { body: { nutrients: { ENERGY_KCAL: 1 } }, headers: { ...ONE, ...REP } });
    expect(blocked.status).toBe(400);
    expect(blocked.json.code).toBe('23001');
    expect(blocked.json.message).toMatch(/immutable/);
    // re-sending the same nutrients in a different key order is not a change (jsonb equality)
    const reordered = Object.fromEntries(Object.entries(fx.seed.tables.foods!.find((f) => f.id === fx.ids.food.cevapi)!.nutrients as Record<string, number>).reverse());
    expect(call('PATCH', `/rest/v1/foods?id=eq.${fx.ids.food.cevapi}`, { body: { nutrients: reordered } }).status).toBe(204);
    // a name change is fine
    expect(call('PATCH', `/rest/v1/foods?id=eq.${fx.ids.food.cevapi}`, { body: { name: 'Ćevapi (domaći)' } }).status).toBe(204);
    const sup = call('POST', '/rest/v1/rpc/supersede_food', { body: { p_food_id: fx.ids.food.cevapi } });
    expect(sup.status).toBe(200);
    const newId = sup.json as string;
    expect(newId).toMatch(/^[0-9a-f-]{36}$/);
    const old = backend.rows('foods').find((f) => f.id === fx.ids.food.cevapi);
    const next = backend.rows('foods').find((f) => f.id === newId);
    expect(old?.archived).toBe(true);
    expect(next).toMatchObject({ version: 2, supersedes: fx.ids.food.cevapi, archived: false, name: 'Ćevapi (domaći)' });
    expect(backend.rows('food_portions').filter((p) => p.food_id === newId)).toHaveLength(2);
    const updated = call('PATCH', `/rest/v1/foods?id=eq.${newId}&select=id`, { body: { nutrients: { ENERGY_KCAL: 300 } }, headers: { ...ONE, ...REP } });
    expect(updated.status).toBe(200);
    // global foods cannot be superseded by a client
    expect(call('POST', '/rest/v1/rpc/supersede_food', { body: { p_food_id: fx.ids.food.egg } }).status).toBe(403);
    expect(backend.mutationsOf('rpc:supersede_food', 'rpc')).toHaveLength(1);
  });
});

describe('foods_protect_referenced / supersede_food (the immutability trigger of the migration)', () => {
  const own = (name: string) => ({ name, source: 'custom', kind: 'custom', owner_id: USER.id, nutrients: { ENERGY_KCAL: 100, PROTEIN_G: 5 } });

  it('rejects changes of nutrients, carb_basis and density of a food that a diary entry references', () => {
    const { call, backend, fx } = setup();
    const id = fx.ids.food.cevapi;
    for (const patch of [{ nutrients: { ENERGY_KCAL: 1 } }, { carb_basis: 'excludes_fiber' }, { density_g_per_ml: 1.2 }]) {
      const res = call('PATCH', `/rest/v1/foods?id=eq.${id}`, { body: patch });
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(res.json.code).toBe('23001');
      expect(res.json.hint).toContain('supersede_food');
    }
    const food = backend.rows('foods').find((f) => f.id === id);
    expect(food?.nutrients).toMatchObject({ ENERGY_KCAL: 258 });
    expect(food?.carb_basis).not.toBe('excludes_fiber');
    // the failed updates are recorded as failed mutations and changed nothing
    expect(backend.mutations.filter((m) => m.table === 'foods' && !m.ok)).toHaveLength(3);
    expect(backend.mutationsOf('foods', 'update')).toHaveLength(0);
  });

  it('also protects a food that is only an ingredient of a recipe, and leaves an unreferenced food alone', () => {
    const { call, backend, fx } = setup();
    const created = call('POST', '/rest/v1/foods?select=id', { body: own('Domaći preljev'), headers: { ...ONE, ...REP } });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    // never referenced: nutrients can change freely
    expect(call('PATCH', `/rest/v1/foods?id=eq.${id}`, { body: { nutrients: { ENERGY_KCAL: 120 } } }).status).toBe(204);
    // referenced only by a recipe ingredient row
    const ingredient = call('POST', '/rest/v1/recipe_ingredients', { body: { recipe_food_id: fx.ids.food.recipeChickenRice, ingredient_food_id: id, grams: 20, sort_order: 9 } });
    expect(ingredient.status).toBe(201);
    expect(backend.rows('diary_entries').some((e) => e.food_id === id)).toBe(false);
    const blocked = call('PATCH', `/rest/v1/foods?id=eq.${id}`, { body: { nutrients: { ENERGY_KCAL: 130 } } });
    expect(blocked.status).toBe(400);
    expect(blocked.json.code).toBe('23001');
    // metadata stays editable
    expect(call('PATCH', `/rest/v1/foods?id=eq.${id}`, { body: { name: 'Domaći preljev 2', brand: 'Moja kuhinja' } }).status).toBe(204);
  });

  it('blocks the merge path of an upsert as well', () => {
    const { call, fx } = setup();
    const cevapi = call('GET', `/rest/v1/foods?id=eq.${fx.ids.food.cevapi}&select=*`, { headers: ONE }).json as Record<string, unknown>;
    const res = call('POST', '/rest/v1/foods?on_conflict=id', {
      body: { ...cevapi, nutrients: { ENERGY_KCAL: 5 } },
      headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('23001');
  });

  it('supersede_food archives the old row, copies the food with version + 1 and its portions, and returns the new id', () => {
    const { call, backend, fx } = setup();
    const oldPortions = backend.rows('food_portions').filter((p) => p.food_id === fx.ids.food.cevapi);
    expect(oldPortions.length).toBeGreaterThan(0);
    const v2 = call('POST', '/rest/v1/rpc/supersede_food', { body: { p_food_id: fx.ids.food.cevapi } }).json as string;
    const v3 = call('POST', '/rest/v1/rpc/supersede_food', { body: { p_food_id: v2 } }).json as string;
    const rows = backend.rows('foods');
    const row = (id: string) => rows.find((f) => f.id === id) as Record<string, unknown>;
    expect(row(fx.ids.food.cevapi).archived).toBe(true);
    expect(row(v2)).toMatchObject({ version: 2, supersedes: fx.ids.food.cevapi, archived: true, kind: 'custom', owner_id: USER.id, name: 'Ćevapi' });
    expect(row(v3)).toMatchObject({ version: 3, supersedes: v2, archived: false });
    expect(row(v3).nutrients).toEqual(row(fx.ids.food.cevapi).nutrients);
    const newPortions = backend.rows('food_portions').filter((p) => p.food_id === v2);
    expect(newPortions.map((p) => [p.label, p.grams])).toEqual(oldPortions.map((p) => [p.label, p.grams]));
    expect(newPortions.every((p) => !oldPortions.some((o) => o.id === p.id))).toBe(true); // copies, not shared rows
    // the new version is unreferenced, so its nutrients can be changed
    expect(call('PATCH', `/rest/v1/foods?id=eq.${v3}`, { body: { nutrients: { ENERGY_KCAL: 99 } } }).status).toBe(204);
    expect(backend.integrityErrors()).toEqual([]);
  });

  it('supersede_food on an unknown or foreign food fails without changing anything', () => {
    const { call, backend, fx } = setup();
    const before = JSON.stringify(backend.rows('foods'));
    const missing = call('POST', '/rest/v1/rpc/supersede_food', { body: { p_food_id: fx.ids.missing } });
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(missing.json.code).toBe('P0002');
    expect(JSON.stringify(backend.rows('foods'))).toBe(before);
    expect(backend.mutations.filter((m) => m.table === 'rpc:supersede_food' && m.ok)).toEqual([]);
    expect(backend.mutations.filter((m) => m.table === 'rpc:supersede_food' && !m.ok)).toHaveLength(1);
  });
});

describe('rpc', () => {
  it('search_foods is accent-insensitive and returns the summary row shape', () => {
    const { call } = setup();
    for (const q of ['cevapi', 'ĆEVAPI', 'ćevap', 'Cevapi']) {
      const res = call('POST', '/rest/v1/rpc/search_foods', { body: { q, max_results: 40 } });
      expect(res.status).toBe(200);
      expect(res.json[0]).toMatchObject({ name: 'Ćevapi', kind: 'custom', source: 'custom', kcal_100g: 258, protein_100g: 17.5, carbs_100g: 1, fat_100g: 20.5 });
      expect(Object.keys(res.json[0]).sort()).toEqual(['brand', 'carbs_100g', 'completeness', 'fat_100g', 'id', 'kcal_100g', 'kind', 'name', 'protein_100g', 'rank', 'source'].sort());
    }
    const chicken = call('POST', '/rest/v1/rpc/search_foods', { body: { q: 'chicken', max_results: 40 } }).json;
    expect(chicken.map((r: any) => r.name)).toEqual(expect.arrayContaining(['Chicken breast, skinless, boneless, raw', 'Chicken breast, roasted, skinless']));
    expect(chicken[0].name).toBe('Chicken breast, roasted, skinless'); // previously logged beats favourite + better source
    const typo = call('POST', '/rest/v1/rpc/search_foods', { body: { q: 'chiken breast' } }).json;
    expect(typo.length).toBeGreaterThan(0);
    expect(call('POST', '/rest/v1/rpc/search_foods', { body: { q: '   ' } }).json).toEqual([]);
    expect(call('POST', '/rest/v1/rpc/search_foods', { body: { q: 'ni' } }).json.map((r: any) => r.name)).not.toContain('Ćevapi');
  });

  it('search_foods respects kinds, max_results and visibility', () => {
    const { call } = setup();
    const recipes = call('POST', '/rest/v1/rpc/search_foods', { body: { q: 'piletina', kinds: ['recipe'] } }).json;
    expect(recipes.map((r: any) => r.name)).toEqual(['Piletina s rižom']);
    expect(call('POST', '/rest/v1/rpc/search_foods', { body: { q: 'piletina', kinds: ['generic'] } }).json).toEqual([]);
    expect(call('POST', '/rest/v1/rpc/search_foods', { body: { q: 'e', max_results: 2 } }).json.length).toBeLessThanOrEqual(2);
  });

  it('get_food_by_gtin pads any GTIN length and returns 0 or 1 row', () => {
    const { call, fx } = setup();
    for (const gtin of [BARCODES.nutella, `0${BARCODES.nutella}`, '3017-6204-22003']) {
      const res = call('POST', '/rest/v1/rpc/get_food_by_gtin', { body: { gtin } });
      expect(res.json).toHaveLength(1);
      expect(res.json[0].id).toBe(fx.ids.food.nutella);
    }
    expect(call('POST', '/rest/v1/rpc/get_food_by_gtin', { body: { gtin: BARCODES.unknown } }).json).toEqual([]);
    expect(call('POST', '/rest/v1/rpc/get_food_by_gtin', { body: { gtin: 'abc' } }).json).toEqual([]);
  });

  it('delete_all_my_coach_data returns the number of deleted threads and cascades', () => {
    const { call, backend } = setup();
    expect(backend.rows('coach_messages').length).toBe(6);
    const res = call('POST', '/rest/v1/rpc/delete_all_my_coach_data', { body: {} });
    expect(res.json).toBe(3);
    expect(backend.rows('coach_messages')).toHaveLength(0);
  });

  it('records unknown and service-only rpcs as unhandled, rejects wrong arguments', () => {
    const { call, backend } = setup();
    expect(call('POST', '/rest/v1/rpc/made_up', { body: {} }).json.code).toBe('PGRST202');
    expect(call('POST', '/rest/v1/rpc/consume_rate_limit', { body: {} }).status).toBe(403);
    expect(call('POST', '/rest/v1/rpc/search_foods', { body: { query: 'x' } }).json.code).toBe('PGRST202');
    expect(call('POST', '/rest/v1/rpc/get_food_by_gtin', { body: {} }).json.code).toBe('PGRST202');
    expect(backend.unhandled.map((u) => u.reason)).toEqual(['unknown rpc "made_up"', 'rpc "consume_rate_limit" is service_role only (not callable by the app)']);
  });
});

describe('unknown endpoints', () => {
  it('records unknown tables as unhandled with a PostgREST style 404', () => {
    const { call, backend } = setup();
    const res = call('GET', '/rest/v1/user_settings?select=*');
    expect(res.status).toBe(404);
    expect(res.json.code).toBe('PGRST205');
    expect(backend.unhandled).toHaveLength(1);
    expect(backend.unhandled[0]?.reason).toContain('user_settings');
    expect(call('GET', '/storage/v1/bucket').status).toBe(404);
    expect(backend.unhandled).toHaveLength(2);
  });
});

describe('GoTrue and Edge Functions', () => {
  it('password grant: success and invalid credentials', () => {
    const { call } = setup();
    const ok = call('POST', '/auth/v1/token?grant_type=password', { body: { email: 'DEMO@ration.test ', password: USER.password } });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ token_type: 'bearer', user: { id: USER.id, email: USER.email } });
    expect(ok.json.expires_at).toBeGreaterThan(FIXED_NOW_MS / 1000);
    const bad = call('POST', '/auth/v1/token?grant_type=password', { body: { email: USER.email, password: 'wrong' } });
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
  });

  it('refresh grant, /user and logout', () => {
    const { call, backend } = setup();
    const session = buildSession(USER, { nowMs: FIXED_NOW_MS, ttlSeconds: SEED_SESSION_TTL_SECONDS });
    const refreshed = call('POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: session.refresh_token } });
    expect(refreshed.status).toBe(200);
    expect(refreshed.json.refresh_token).not.toBe(session.refresh_token);
    const again = call('POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: refreshed.json.refresh_token } });
    expect(again.status).toBe(200);
    expect(call('POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: 'garbage' } }).status).toBe(400);
    expect(call('GET', '/auth/v1/user').json).toMatchObject({ id: USER.id, email: USER.email, aud: 'authenticated' });
    expect(api(backend, null)('GET', '/auth/v1/user').status).toBe(401);
    expect(call('POST', '/auth/v1/logout?scope=global').status).toBe(204);
  });

  it('rejects expired and foreign tokens', () => {
    const { backend } = setup();
    const expired = makeJwt({ sub: USER.id, role: 'authenticated', exp: Math.floor(FIXED_NOW_MS / 1000) - 10 });
    expect(api(backend, expired)('GET', '/rest/v1/foods?select=id').json.code).toBe('PGRST303');
    const stranger = makeJwt({ sub: stableUuid('stranger'), role: 'authenticated', exp: Math.floor(FIXED_NOW_MS / 1000) + 1000 });
    expect(api(backend, stranger)('GET', '/rest/v1/foods?select=id').status).toBe(401);
  });

  it('answers Edge Functions like the gateway does for an undeployed function', () => {
    const { call, backend } = setup();
    const res = call('POST', '/functions/v1/online-search', { body: { query: 'x' } });
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ error: 'not_deployed', code: 'NOT_FOUND' });
    expect(res.json.message).toMatch(/function/i);
    expect(backend.calls.at(-1)).toMatchObject({ kind: 'function', target: 'online-search' });
    expect(backend.unhandled).toHaveLength(0);
  });

  it('records unknown auth endpoints as unhandled', () => {
    const { call, backend } = setup();
    expect(call('POST', '/auth/v1/signup', { body: {} }).status).toBe(404);
    expect(backend.unhandled[0]?.reason).toContain('auth endpoint');
  });
});

describe('seed validation', () => {
  it('refuses a seed that violates the schema', () => {
    const fx = buildFixtures();
    const bad = structuredClone(fx.seed);
    (bad.tables.diary_entries as Record<string, unknown>[])[0]!.food_id = stableUuid('missing-food');
    expect(() => createMockBackend(bad)).toThrow(/Invalid seed.*diary_entries/);
    const unknownTable: MockSeed = { users: fx.seed.users, tables: { ...fx.seed.tables, ghosts: [{}] } };
    expect(() => createMockBackend(unknownTable)).toThrow(/unknown table "ghosts"/);
    const badRow = structuredClone(fx.seed);
    (badRow.tables.foods as Record<string, unknown>[])[0]!.kind = 'mystery';
    expect(() => createMockBackend(badRow)).toThrow(/foods\[0\]/);
  });

  it('every fixture variant builds a consistent backend', () => {
    for (const variant of ['default', 'imperial', 'not-onboarded', 'empty-diary', 'fresh-account'] as const) {
      const backend = createMockBackend(buildFixtures(variant).seed);
      expect(backend.integrityErrors()).toEqual([]);
    }
    void IDS;
  });
});
