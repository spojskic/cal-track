/**
 * The friends feature as the mock backend answers it (supabase/migrations/20261110000109_friends.sql): the friendships table and its
 * grants, the five RPCs, the foods / recipes visibility and the search ranking, driven through HTTP-shaped calls like the app's
 * supabase-js client does (mock-backend.test.ts / invite-admin.test.ts are the patterns).
 */
import { describe, expect, it } from 'vitest';

import { computeRecipe, isNutrientCode, type NutrientMap } from '../../../packages/core/src';

import { ANON_KEY, APP_ORIGIN, BACKEND_ORIGIN, FIXED_NOW_MS } from './constants';
import { FIXTURE_VARIANTS, FRIEND_FOOD_KEYS, FRIEND_KEYS, FRIEND_USERS, IDS, USER, buildFixtures } from './fixtures';
import { DAILY_REQUEST_LIMIT } from './friends';
import { createMockBackend, type MockBackend, type MockSeed, type Row } from './mock-backend';
import { CLIENT_RPCS, KNOWN_TABLES, SCHEMA } from './schema';
import { SEED_SESSION_TTL_SECONDS, buildSession, stableUuid, type MockUser } from './session';

// ----------------------------------------------------------------------------- helpers

interface Reply {
  status: number;
  headers: Record<string, string>;
  json: any;
  text: string;
}

type Client = (method: string, path: string, init?: { body?: unknown; headers?: Record<string, string> }) => Reply;

const tokenOf = (user: MockUser): string => buildSession(user, { nowMs: FIXED_NOW_MS, ttlSeconds: SEED_SESSION_TTL_SECONDS }).access_token;

function clientFor(backend: MockBackend, token: string | null): Client {
  return (method, path, init = {}) => {
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

/** A backend on the 'friends' fixtures (or a variation of them) with one client per person; `demo` is the signed-in user. */
function setup(seed: MockSeed = buildFixtures('friends').seed) {
  const backend = createMockBackend(seed);
  const as = (user: MockUser | null): Client => clientFor(backend, user ? tokenOf(user) : null);
  return {
    backend,
    as,
    demo: as(USER),
    anna: as(FRIEND_USERS.anna),
    ben: as(FRIEND_USERS.ben),
    dora: as(FRIEND_USERS.dora),
    carl: as(FRIEND_USERS.carl),
    anon: as(null),
  };
}

/** The 'friends' seed, changed by `mutate` before the backend is created (tables are plain rows), plus more accounts. */
function seedWith(mutate?: (tables: Record<string, Row[]>) => void, extraUsers: MockUser[] = []): MockSeed {
  const seed = structuredClone(buildFixtures('friends').seed);
  seed.users.push(...extraUsers);
  mutate?.(seed.tables);
  return seed;
}

const extraUsers = (n: number): MockUser[] =>
  Array.from({ length: n }, (_, i) => ({
    id: stableUuid(`user:extra:${i}`),
    email: `extra${String(i).padStart(2, '0')}@example.com`,
    password: 'x',
    createdAt: '2026-10-05T09:00:00+00:00',
  }));

const rpc = (c: Client, name: string, body: unknown = {}, query = '', headers: Record<string, string> = {}): Reply =>
  c('POST', `/rest/v1/rpc/${name}${query}`, { body, headers });
const send = (c: Client, email: unknown): Reply => rpc(c, 'send_friend_request', { p_email: email });
const respond = (c: Client, id: string, accept: boolean | null): Reply => rpc(c, 'respond_friend_request', { p_id: id, p_accept: accept });
const list = (c: Client): any[] => rpc(c, 'list_friendships').json;
const friendIds = (c: Client): string[] => rpc(c, 'my_friend_ids').json;
const search = (c: Client, q: string, extra: Record<string, unknown> = {}): any[] => rpc(c, 'search_foods', { q, max_results: 40, ...extra }).json;

/** Names of the foods somebody owns that this client can see (`owner_id is not null`), sorted. */
const ownedNames = (c: Client, filter = ''): string[] =>
  (c('GET', `/rest/v1/foods?select=name&owner_id=not.is.null${filter}&limit=1000`).json as { name: string }[]).map((f) => f.name).sort();

const OWN_FOODS = ['Burek sa sirom', 'Piletina s rižom', 'Vrhnje za kuhanje', 'Ćevapi'];
const ANNA_SHARED = ['Anna hummus', 'Anna lentil soup', 'Anna spice mix'];

const logEntry = (food: string, extra: Record<string, unknown> = {}) => ({
  user_id: USER.id,
  entry_date: '2026-11-10',
  meal_group_id: IDS.mealGroup.lunch,
  food_id: food,
  grams: 60,
  ...extra,
});

const RLS_DIARY = { code: '42501', message: 'new row violates row-level security policy for table "diary_entries"' };

// ----------------------------------------------------------------------------- schema and fixtures

describe('friends: schema, RPC list and fixtures', () => {
  it('knows the friendships table (delete is the only write grant) and the five RPCs with their argument names', () => {
    expect(KNOWN_TABLES).toContain('friendships');
    const def = SCHEMA.friendships!;
    expect(Object.keys(def.columns)).toEqual(['id', 'requester_id', 'addressee_id', 'status', 'created_at', 'responded_at']);
    expect(def.writeGrants).toEqual(['delete']);
    expect(CLIENT_RPCS.my_friend_ids).toEqual({ args: [], required: [] });
    expect(CLIENT_RPCS.my_used_food).toEqual({ args: ['p_food_id'], required: ['p_food_id'] });
    expect(CLIENT_RPCS.send_friend_request).toEqual({ args: ['p_email'], required: ['p_email'] });
    expect(CLIENT_RPCS.respond_friend_request).toEqual({ args: ['p_id', 'p_accept'], required: ['p_id', 'p_accept'] });
    expect(CLIENT_RPCS.list_friendships).toEqual({ args: [], required: [] });
  });

  it('adds the variant, and every variant (the new one included) still builds a consistent database', () => {
    expect(FIXTURE_VARIANTS).toContain('friends');
    for (const variant of FIXTURE_VARIANTS) {
      expect(createMockBackend(buildFixtures(variant).seed).integrityErrors(), variant).toEqual([]);
    }
    for (const variant of FIXTURE_VARIANTS.filter((v) => v !== 'friends')) {
      expect(buildFixtures(variant).seed.tables.friendships, variant).toEqual([]);
      expect(buildFixtures(variant).seed.users, variant).toHaveLength(1);
    }
  });

  it('is the default variant plus Anna, Ben, Dora and Carl: the demo user stays users[0], nothing else changes', () => {
    const base = buildFixtures('default').seed;
    const fr = buildFixtures('friends').seed;
    expect(fr.users[0]).toEqual(USER);
    expect(fr.users.map((u) => u.email)).toEqual([USER.email, 'anna@example.com', 'ben@example.com', 'dora@example.com', 'carl@example.com']);
    expect(FRIEND_KEYS.map((k) => IDS.friend[k])).toEqual(fr.users.slice(1).map((u) => u.id));
    expect(new Set(fr.users.map((u) => u.id)).size).toBe(5);

    const changed = ['foods', 'food_portions', 'recipes', 'recipe_ingredients', 'profiles', 'friendships'];
    for (const [name, rows] of Object.entries(base.tables)) {
      if (changed.includes(name)) expect(fr.tables[name]!.slice(0, rows.length), name).toEqual(rows);
      else expect(fr.tables[name], name).toEqual(rows);
    }
    expect(fr.tables.foods).toHaveLength(base.tables.foods!.length + FRIEND_FOOD_KEYS.length);
    expect(fr.tables.profiles!.slice(1).map((p) => p.display_name)).toEqual(['Anna', 'Ben', 'Dora', 'Carl']);
    expect(fr.tables.profiles![0]).toEqual(base.tables.profiles![0]);
  });

  it('seeds Anna (friend), Ben (incoming), Dora (outgoing) and Carl (no relation)', () => {
    const rows = buildFixtures('friends').seed.tables.friendships!;
    expect(rows.map((r) => [r.id, r.requester_id, r.addressee_id, r.status])).toEqual([
      [IDS.friendship.anna, IDS.friend.anna, USER.id, 'accepted'],
      [IDS.friendship.ben, IDS.friend.ben, USER.id, 'pending'],
      [IDS.friendship.dora, USER.id, IDS.friend.dora, 'pending'],
    ]);
    expect(rows[0]!.responded_at).not.toBeNull();
    expect(rows[1]!.responded_at).toBeNull();
    expect(rows[2]!.responded_at).toBeNull();
    expect(rows.some((r) => r.requester_id === IDS.friend.carl || r.addressee_id === IDS.friend.carl)).toBe(false);
  });

  it('seeds the six foods with owners, kinds and believable per-100 g nutrients; ids are exported in IDS.food', () => {
    const fr = buildFixtures('friends').seed.tables;
    const foods = new Map(fr.foods!.map((f) => [f.id as string, f] as const));
    const expected: [keyof typeof IDS.food, string, string, string][] = [
      ['annaHummus', 'Anna hummus', 'custom', IDS.friend.anna],
      ['annaSpice', 'Anna spice mix', 'custom', IDS.friend.anna],
      ['annaSoup', 'Anna lentil soup', 'recipe', IDS.friend.anna],
      ['annaShake', 'Anna protein shake', 'ai_estimate', IDS.friend.anna],
      ['carlSauce', 'Carl pasta sauce', 'custom', IDS.friend.carl],
      ['benGranola', 'Ben granola', 'custom', IDS.friend.ben],
    ];
    expect(expected.map((e) => e[0])).toEqual([...FRIEND_FOOD_KEYS]);
    for (const [key, name, kind, owner] of expected) {
      const food = foods.get(IDS.food[key]);
      expect(food, key).toMatchObject({ name, kind, source: kind, owner_id: owner, archived: false });
      const n = food!.nutrients as Record<string, number>;
      for (const [code, value] of Object.entries(n)) {
        expect(isNutrientCode(code), `${name}: ${code}`).toBe(true);
        expect(Number.isFinite(value) && value >= 0, `${name}.${code}`).toBe(true);
      }
      const atwater = (n.PROTEIN_G ?? 0) * 4 + (n.CARBS_G ?? 0) * 4 + (n.FAT_G ?? 0) * 9;
      expect(Math.abs((n.ENERGY_KCAL ?? 0) - atwater) / (n.ENERGY_KCAL ?? 1), name).toBeLessThan(0.3);
    }
    // hummus, the spice mix, the sauce and the granola have portions; the soup has the serving portions of a recipe
    const portionsOf = (key: keyof typeof IDS.food) => fr.food_portions!.filter((p) => p.food_id === IDS.food[key]).map((p) => p.label);
    expect(portionsOf('annaHummus')).toEqual(['2 tbsp']);
    expect(portionsOf('annaSoup')).toEqual(['1 serving', 'Full recipe', '100 g']);
  });

  it("stores Anna's soup nutrients exactly as its ingredients add up (a global food and her spice mix)", () => {
    const fr = buildFixtures('friends').seed.tables;
    const foods = new Map(fr.foods!.map((f) => [f.id as string, f] as const));
    const recipe = fr.recipes!.find((r) => r.food_id === IDS.food.annaSoup)!;
    expect(recipe).toMatchObject({ user_id: IDS.friend.anna, servings: 4, final_weight_g: 1400 });
    const ingredients = fr.recipe_ingredients!.filter((i) => i.recipe_food_id === IDS.food.annaSoup).sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
    expect(ingredients.map((i) => foods.get(i.ingredient_food_id as string)!.name)).toEqual(['Lentils, boiled', 'Anna spice mix']);
    const expected = computeRecipe({
      ingredients: ingredients.map((i) => ({ per100g: foods.get(i.ingredient_food_id as string)!.nutrients as NutrientMap, grams: Number(i.grams) })),
      servings: 4,
      finalWeightG: 1400,
    });
    const stored = foods.get(IDS.food.annaSoup)!.nutrients as Record<string, number>;
    for (const code of ['ENERGY_KCAL', 'PROTEIN_G', 'CARBS_G', 'FAT_G', 'FIBER_G', 'SODIUM_MG'] as const) {
      expect(stored[code], code).toBeCloseTo(expected.per100g[code] as number, 3);
    }
    expect(stored.ENERGY_KCAL!).toBeGreaterThan(40);
    expect(stored.ENERGY_KCAL!).toBeLessThan(120);
  });

  it('refuses a seed with a friendship that breaks the table constraints', () => {
    const bad = (row: Row) => () => createMockBackend(seedWith((t) => t.friendships!.push(row)));
    const base = { id: stableUuid('bad:friendship'), created_at: '2026-11-01T10:00:00+00:00', responded_at: null };
    expect(bad({ ...base, requester_id: USER.id, addressee_id: USER.id, status: 'pending' })).toThrow(/friendships_not_self/);
    expect(bad({ ...base, requester_id: USER.id, addressee_id: IDS.friend.carl, status: 'blocked' })).toThrow(/friendships_status_check/);
    // one row per PAIR, whoever asked first
    expect(bad({ ...base, requester_id: USER.id, addressee_id: IDS.friend.anna, status: 'pending' })).toThrow(/friendships_pair_uk/);
    expect(bad({ ...base, requester_id: USER.id, addressee_id: stableUuid('nobody'), status: 'pending' })).toThrow(/friendships_addressee_id_fkey/);
  });
});

// ----------------------------------------------------------------------------- the table

describe('friends: the friendships table through REST', () => {
  it('shows a client only its own rows', () => {
    const { demo, anna, ben, carl, anon } = setup();
    const ids = (c: Client) => (c('GET', '/rest/v1/friendships?select=id&order=id.asc').json as { id: string }[]).map((r) => r.id);
    expect(ids(demo).sort()).toEqual([IDS.friendship.anna, IDS.friendship.ben, IDS.friendship.dora].sort());
    expect(ids(anna)).toEqual([IDS.friendship.anna]);
    expect(ids(ben)).toEqual([IDS.friendship.ben]);
    expect(ids(carl)).toEqual([]);
    const refused = anon('GET', '/rest/v1/friendships?select=id');
    expect(refused.status).toBe(401);
    expect(refused.json.code).toBe('42501');
    expect(demo('GET', '/rest/v1/friendships?select=*&limit=1').json[0]).toHaveProperty('responded_at');
  });

  it('refuses INSERT and UPDATE (upsert too) like a missing grant, and records only failed mutations', () => {
    const { demo, anon, backend } = setup();
    const before = JSON.stringify(backend.rows('friendships'));
    const denied = { code: '42501', message: 'permission denied for table friendships' };

    const ins = demo('POST', '/rest/v1/friendships', { body: { requester_id: USER.id, addressee_id: IDS.friend.carl, status: 'accepted' } });
    expect(ins.status).toBe(403);
    expect(ins.json).toMatchObject(denied);

    const upsert = demo('POST', '/rest/v1/friendships?on_conflict=id', {
      body: { id: IDS.friendship.ben, requester_id: IDS.friend.ben, addressee_id: USER.id, status: 'accepted' },
      headers: { prefer: 'resolution=merge-duplicates' },
    });
    expect(upsert.status).toBe(403);
    expect(upsert.json).toMatchObject(denied);

    for (const patch of [{ status: 'accepted' }, { responded_at: '2026-11-10T10:00:00+00:00' }]) {
      const up = demo('PATCH', `/rest/v1/friendships?id=eq.${IDS.friendship.ben}`, { body: patch, headers: REP });
      expect(up.status).toBe(403);
      expect(up.json).toMatchObject(denied);
    }

    const anonymous = anon('POST', '/rest/v1/friendships', { body: { requester_id: USER.id, addressee_id: IDS.friend.carl } });
    expect(anonymous.status).toBe(401);
    expect(anonymous.json.code).toBe('42501');

    expect(JSON.stringify(backend.rows('friendships'))).toBe(before);
    expect(backend.mutationsOf('friendships')).toEqual([]);
    expect(backend.mutations.filter((m) => m.table === 'friendships' && !m.ok).map((m) => [m.op, m.status])).toEqual([
      ['insert', 403],
      ['upsert', 403],
      ['update', 403],
      ['update', 403],
      ['insert', 401],
    ]);
  });

  it('lets either side delete the row: cancel a request, decline one, remove a friend; the delete is recorded like other table writes', () => {
    const { demo, anna, dora, backend } = setup();
    // the requester cancels
    expect(demo('DELETE', `/rest/v1/friendships?id=eq.${IDS.friendship.dora}`).status).toBe(204);
    // the addressee declines (the demo user, Ben's request)
    const declined = demo('DELETE', `/rest/v1/friendships?id=eq.${IDS.friendship.ben}`, { headers: REP });
    expect(declined.status).toBe(200);
    expect(declined.json.map((r: any) => r.id)).toEqual([IDS.friendship.ben]);
    expect(backend.rows('friendships').map((r) => r.id)).toEqual([IDS.friendship.anna]);
    // a friend removes the friendship (the requester of the accepted row)
    expect(anna('DELETE', `/rest/v1/friendships?id=eq.${IDS.friendship.anna}`).status).toBe(204);
    expect(backend.rows('friendships')).toEqual([]);
    expect(backend.mutationsOf('friendships', 'delete').map((m) => m.rows)).toEqual([1, 1, 1]);
    expect(backend.mutationsOf('friendships', 'delete')[0]!.filter).toContain(IDS.friendship.dora);
    void dora;
  });

  it("does not let a stranger delete somebody else's row (0 rows, nothing changes) and needs a WHERE clause", () => {
    const { carl, dora, backend } = setup();
    const res = carl('DELETE', `/rest/v1/friendships?id=eq.${IDS.friendship.anna}`, { headers: REP });
    expect(res.status).toBe(200);
    expect(res.json).toEqual([]);
    expect(backend.rows('friendships')).toHaveLength(3);
    expect(backend.mutationsOf('friendships', 'delete')[0]).toMatchObject({ rows: 0, ok: true });
    expect(dora('DELETE', '/rest/v1/friendships').json.code).toBe('21000');
  });
});

// ----------------------------------------------------------------------------- list_friendships

describe('friends: list_friendships()', () => {
  it('lists both kinds of rows newest first with the other person (direction, user_id, name, e-mail)', () => {
    const { demo } = setup();
    const r = rpc(demo, 'list_friendships');
    expect(r.status).toBe(200);
    expect(r.json.map((f: any) => [f.id, f.status, f.direction, f.user_id, f.display_name, f.email])).toEqual([
      [IDS.friendship.ben, 'pending', 'incoming', IDS.friend.ben, 'Ben', 'ben@example.com'],
      [IDS.friendship.dora, 'pending', 'outgoing', IDS.friend.dora, 'Dora', 'dora@example.com'],
      [IDS.friendship.anna, 'accepted', 'incoming', IDS.friend.anna, 'Anna', 'anna@example.com'],
    ]);
    expect(Object.keys(r.json[0])).toEqual(['id', 'status', 'direction', 'user_id', 'display_name', 'email', 'created_at', 'responded_at']);
    expect(r.json.map((f: any) => f.created_at)).toEqual(['2026-11-10T08:15:00+00:00', '2026-11-08T17:30:00+00:00', '2026-11-01T19:10:00+00:00']);
    expect(r.json.map((f: any) => f.responded_at)).toEqual([null, null, '2026-11-01T20:00:00+00:00']);
  });

  it('shows the same rows from the other side with the direction turned around', () => {
    const { anna, ben, dora, carl } = setup();
    expect(list(anna)).toMatchObject([{ id: IDS.friendship.anna, status: 'accepted', direction: 'outgoing', user_id: USER.id, display_name: 'Demo', email: USER.email }]);
    expect(list(ben)).toMatchObject([{ id: IDS.friendship.ben, status: 'pending', direction: 'outgoing', user_id: USER.id }]);
    expect(list(dora)).toMatchObject([{ id: IDS.friendship.dora, status: 'pending', direction: 'incoming', user_id: USER.id }]);
    expect(list(carl)).toEqual([]);
  });

  it('falls back to the local part of the e-mail when the profile has no (or a blank) name', () => {
    const { demo } = setup(
      seedWith((t) => {
        t.profiles!.find((p) => p.user_id === IDS.friend.dora)!.display_name = '   ';
        t.profiles = t.profiles!.filter((p) => p.user_id !== IDS.friend.ben);
      }),
    );
    expect(list(demo).map((f) => [f.email, f.display_name])).toEqual([
      ['ben@example.com', 'ben'],
      ['dora@example.com', 'dora'],
      ['anna@example.com', 'Anna'],
    ]);
  });

  it('is filtered, ordered and paged by PostgREST like any function that returns a table; unknown parameters are reported', () => {
    const { demo, backend } = setup();
    const pending = rpc(demo, 'list_friendships', {}, '?status=eq.pending');
    expect(pending.json.map((f: any) => f.id)).toEqual([IDS.friendship.ben, IDS.friendship.dora]);
    expect(rpc(demo, 'list_friendships', {}, '?direction=eq.outgoing').json.map((f: any) => f.id)).toEqual([IDS.friendship.dora]);
    const page = rpc(demo, 'list_friendships', {}, '?order=created_at.asc&limit=2&offset=1', { prefer: 'count=exact' });
    expect(page.json.map((f: any) => f.id)).toEqual([IDS.friendship.dora, IDS.friendship.ben]);
    expect(page.headers['content-range']).toBe('1-2/3');
    expect(backend.warnings).toEqual([]);
    rpc(demo, 'list_friendships', {}, '?email=eq.x');
    expect(backend.warnings.some((w) => w.includes('email=eq.x'))).toBe(true);
  });

  it('takes no arguments, needs a signed-in caller and does not count as a mutation', () => {
    const { demo, anon, backend } = setup();
    expect(rpc(demo, 'list_friendships', { p_x: 1 }).json.code).toBe('PGRST202');
    expect(rpc(anon, 'list_friendships').status).toBe(401);
    expect(backend.mutations.filter((m) => m.table.startsWith('rpc:'))).toEqual([]);
  });
});

// ----------------------------------------------------------------------------- send_friend_request

describe('friends: send_friend_request(p_email)', () => {
  it('an unknown e-mail answers exactly like a known one and creates nothing', () => {
    const { demo, backend } = setup();
    const unknown = send(demo, 'nobody@example.com');
    expect(unknown.status).toBe(200);
    expect(unknown.json).toBe('sent');
    expect(backend.rows('friendships')).toHaveLength(3);
    expect(list(demo)).toHaveLength(3);
    // the known stranger gets the same answer ...
    expect(send(demo, 'carl@example.com').json).toBe(unknown.json);
    // ... but only that one leaves a row behind
    expect(backend.rows('friendships')).toHaveLength(4);
    expect(backend.mutationsOf('rpc:send_friend_request', 'rpc').map((m) => [m.payload, m.ok, m.status])).toEqual([
      [{ p_email: 'nobody@example.com' }, true, 200],
      [{ p_email: 'carl@example.com' }, true, 200],
    ]);
  });

  it('sends a request to an existing account: a pending row from the caller, outgoing for them and incoming for the other', () => {
    const { demo, carl, backend } = setup();
    expect(send(demo, 'carl@example.com').json).toBe('sent');
    const row = backend.rows('friendships').find((r) => r.addressee_id === IDS.friend.carl)!;
    expect(row).toMatchObject({ requester_id: USER.id, status: 'pending', responded_at: null });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(String(row.created_at)).toMatch(/^2026-11-10T11:00:00\.\d+\+00:00$/);
    expect(list(demo)[0]).toMatchObject({ id: row.id, direction: 'outgoing', display_name: 'Carl', email: 'carl@example.com', status: 'pending' });
    expect(list(carl)[0]).toMatchObject({ id: row.id, direction: 'incoming', display_name: 'Demo', status: 'pending' });
  });

  it('trims and ignores the case of the address', () => {
    const { demo, backend } = setup();
    expect(send(demo, '  CARL@Example.COM ').json).toBe('sent');
    expect(backend.rows('friendships').filter((r) => r.addressee_id === IDS.friend.carl)).toHaveLength(1);
  });

  it('answers already_requested, already_friends and (when they had asked first) accepted', () => {
    const { demo, backend } = setup();
    expect(send(demo, 'carl@example.com').json).toBe('sent');
    expect(send(demo, 'carl@example.com').json).toBe('already_requested');
    expect(send(demo, 'dora@example.com').json).toBe('already_requested');
    expect(send(demo, 'anna@example.com').json).toBe('already_friends');
    expect(backend.rows('friendships')).toHaveLength(4); // none of the three answers created a row

    // Ben had asked the demo user: asking back accepts the same row instead of creating a second one
    const ben = backend.rows('friendships').find((r) => r.id === IDS.friendship.ben)!;
    expect(ben.status).toBe('pending');
    expect(send(demo, 'ben@example.com').json).toBe('accepted');
    expect(backend.rows('friendships')).toHaveLength(4);
    expect(ben).toMatchObject({ id: IDS.friendship.ben, status: 'accepted', requester_id: IDS.friend.ben, addressee_id: USER.id });
    expect(String(ben.responded_at)).toMatch(/^2026-11-10T11:00:00\.\d+\+00:00$/);
    expect(list(demo).find((f) => f.id === IDS.friendship.ben)).toMatchObject({ status: 'accepted', direction: 'incoming' });
    expect(send(demo, 'ben@example.com').json).toBe('already_friends');
  });

  it("accepts from the other side too: Dora asking the person who asked her", () => {
    const { dora, demo, backend } = setup();
    expect(send(dora, USER.email).json).toBe('accepted');
    expect(backend.rows('friendships').find((r) => r.id === IDS.friendship.dora)).toMatchObject({ status: 'accepted', requester_id: USER.id });
    expect(friendIds(demo).sort()).toEqual([IDS.friend.anna, IDS.friend.dora].sort());
  });

  it('refuses your own address (22023, HTTP 400), however it is written, and creates nothing', () => {
    const { demo, backend } = setup();
    for (const email of [USER.email, `  ${USER.email.toUpperCase()} `]) {
      const r = send(demo, email);
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ code: '22023', message: 'that is your own e-mail address', details: null, hint: null });
    }
    expect(backend.rows('friendships')).toHaveLength(3);
    expect(backend.mutationsOf('rpc:send_friend_request')).toEqual([]);
    expect(backend.mutations.filter((m) => m.table === 'rpc:send_friend_request' && !m.ok).map((m) => [m.status, m.error])).toEqual([
      [400, '22023: that is your own e-mail address'],
      [400, '22023: that is your own e-mail address'],
    ]);
  });

  it('refuses a malformed address (22023, HTTP 400) before it looks anybody up', () => {
    const { demo, backend } = setup();
    const bad: unknown[] = ['', '   ', 'nope', 'a@b', 'a@b.c', 'a b@c.de', 'a@@b.cd', '@b.cd', '\tcarl@example.com', `${'a'.repeat(250)}@example.com`, null];
    for (const email of bad) {
      const r = send(demo, email);
      expect(r.status, JSON.stringify(email)?.slice(0, 40)).toBe(400);
      expect(r.json).toEqual({ code: '22023', message: 'that is not a valid e-mail address', details: null, hint: null });
    }
    expect(backend.rows('friendships')).toHaveLength(3);
    expect(rpc(demo, 'send_friend_request', {}).json.code).toBe('PGRST202'); // p_email is required by name
    expect(rpc(demo, 'send_friend_request', { email: 'carl@example.com' }).json.code).toBe('PGRST202');
  });

  it('needs a signed-in caller', () => {
    const { anon, backend } = setup();
    expect(send(anon, 'carl@example.com').status).toBe(401);
    expect(backend.rows('friendships')).toHaveLength(3);
  });

  describe('the limit of 20 requests a day', () => {
    const people = extraUsers(DAILY_REQUEST_LIMIT + 5);
    const emailOf = (i: number) => people[i]!.email;

    it('lets 20 through and refuses the 21st with SQLSTATE 54000 (PostgREST answers class 54 with HTTP 500, not 400)', () => {
      const { demo, backend } = setup(seedWith(undefined, people));
      for (let i = 0; i < DAILY_REQUEST_LIMIT; i += 1) expect(send(demo, emailOf(i)).json, `request ${i + 1}`).toBe('sent');
      expect(backend.rows('friendships')).toHaveLength(3 + DAILY_REQUEST_LIMIT);

      const over = send(demo, emailOf(DAILY_REQUEST_LIMIT));
      expect(over.status).toBe(500);
      expect(over.json).toEqual({ code: '54000', message: 'too many friend requests today, try again tomorrow', details: null, hint: null });
      expect(backend.rows('friendships')).toHaveLength(3 + DAILY_REQUEST_LIMIT);
      expect(backend.mutations.filter((m) => m.table === 'rpc:send_friend_request' && !m.ok).map((m) => [m.status, m.error])).toEqual([
        [500, '54000: too many friend requests today, try again tomorrow'],
      ]);
      expect(backend.calls.at(-1)).toMatchObject({ kind: 'rpc', target: 'send_friend_request', status: 500 });
    });

    it('still answers everything that creates no new request: unknown e-mail, repeats, friends, and accepting a request that came in', () => {
      const { demo, backend } = setup(seedWith(undefined, people));
      for (let i = 0; i < DAILY_REQUEST_LIMIT; i += 1) send(demo, emailOf(i));
      expect(send(demo, 'nobody@example.com').json).toBe('sent');
      expect(send(demo, emailOf(0)).json).toBe('already_requested');
      expect(send(demo, 'anna@example.com').json).toBe('already_friends');
      expect(send(demo, 'ben@example.com').json).toBe('accepted');
      expect(backend.rows('friendships')).toHaveLength(3 + DAILY_REQUEST_LIMIT);
      expect(send(demo, 'carl@example.com').json.code).toBe('54000');
    });

    it('counts the rows that exist: cancelling a request frees a place (the SQL does not remember deleted rows)', () => {
      const { demo, backend } = setup(seedWith(undefined, people));
      for (let i = 0; i < DAILY_REQUEST_LIMIT; i += 1) send(demo, emailOf(i));
      expect(send(demo, emailOf(DAILY_REQUEST_LIMIT)).json.code).toBe('54000');
      const first = backend.rows('friendships').find((r) => r.addressee_id === people[0]!.id)!;
      expect(demo('DELETE', `/rest/v1/friendships?id=eq.${first.id}`).status).toBe(204);
      expect(send(demo, emailOf(DAILY_REQUEST_LIMIT)).json).toBe('sent');
    });

    const seeded = (ageMs: number) =>
      seedWith((t) => {
        t.friendships!.push(
          ...people.slice(0, DAILY_REQUEST_LIMIT).map((p, i) => ({
            id: stableUuid(`old-request:${i}`),
            requester_id: USER.id,
            addressee_id: p.id,
            status: 'pending',
            created_at: new Date(FIXED_NOW_MS - ageMs).toISOString(),
            responded_at: null,
          })),
        );
      }, people);

    it('only counts the last 24 hours', () => {
      const old = setup(seeded(25 * 3_600_000));
      expect(send(old.demo, emailOf(DAILY_REQUEST_LIMIT)).json).toBe('sent');
      const recent = setup(seeded(23 * 3_600_000));
      expect(send(recent.demo, emailOf(DAILY_REQUEST_LIMIT)).json.code).toBe('54000');
    });

    it('only counts requests the caller sent, not the ones they received', () => {
      const { carl, backend } = setup(seedWith(undefined, people));
      // 25 people ask Carl; Carl has sent none himself
      for (const p of people) expect(send(clientFor(backend, tokenOf(p)), 'carl@example.com').json).toBe('sent');
      expect(send(carl, 'anna@example.com').json).toBe('sent');
    });
  });
});

// ----------------------------------------------------------------------------- respond_friend_request

describe('friends: respond_friend_request(p_id, p_accept)', () => {
  it('accepts a request that was sent to the caller: true, status accepted, responded_at set', () => {
    const { demo, backend } = setup();
    const r = respond(demo, IDS.friendship.ben, true);
    expect(r.status).toBe(200);
    expect(r.json).toBe(true);
    const row = backend.rows('friendships').find((f) => f.id === IDS.friendship.ben)!;
    expect(row).toMatchObject({ status: 'accepted', requester_id: IDS.friend.ben, addressee_id: USER.id });
    expect(String(row.responded_at)).toMatch(/^2026-11-10T11:00:00\.\d+\+00:00$/);
    expect(list(demo).find((f) => f.id === IDS.friendship.ben)).toMatchObject({ status: 'accepted', direction: 'incoming' });
    expect(backend.mutationsOf('rpc:respond_friend_request', 'rpc').map((m) => [m.payload, m.ok])).toEqual([[{ p_id: IDS.friendship.ben, p_accept: true }, true]]);
    // once accepted there is nothing pending any more
    expect(respond(demo, IDS.friendship.ben, true).json).toBe(false);
    expect(respond(demo, IDS.friendship.ben, false).json).toBe(false);
    expect(backend.rows('friendships')).toHaveLength(3);
  });

  it('declines by deleting the row', () => {
    const { demo, ben, backend } = setup();
    expect(respond(demo, IDS.friendship.ben, false).json).toBe(true);
    expect(backend.rows('friendships').map((f) => f.id)).toEqual([IDS.friendship.anna, IDS.friendship.dora]);
    expect(list(demo).map((f) => f.id)).toEqual([IDS.friendship.dora, IDS.friendship.anna]);
    expect(list(ben)).toEqual([]);
    expect(backend.mutationsOf('rpc:respond_friend_request', 'rpc')[0]!.payload).toEqual({ p_id: IDS.friendship.ben, p_accept: false });
  });

  it('a NULL p_accept is not true, so it declines (`if p_accept then ... else delete`)', () => {
    const { demo, backend } = setup();
    expect(respond(demo, IDS.friendship.ben, null).json).toBe(true);
    expect(backend.rows('friendships').some((f) => f.id === IDS.friendship.ben)).toBe(false);
  });

  it('only the addressee of a pending request can answer it: everything else is false and changes nothing', () => {
    const { demo, ben, carl, backend } = setup();
    const before = JSON.stringify(backend.rows('friendships'));
    for (const accept of [true, false]) {
      expect(respond(demo, IDS.friendship.dora, accept).json, 'the requester').toBe(false);
      expect(respond(demo, IDS.friendship.anna, accept).json, 'an accepted row').toBe(false);
      expect(respond(demo, stableUuid('no such request'), accept).json, 'an unknown id').toBe(false);
      expect(respond(carl, IDS.friendship.ben, accept).json, 'a stranger').toBe(false);
      expect(respond(ben, IDS.friendship.ben, accept).json, 'the requester, own request').toBe(false);
    }
    expect(JSON.stringify(backend.rows('friendships'))).toBe(before);
    // the calls themselves succeeded: they are recorded as successful mutations
    const recorded = backend.mutationsOf('rpc:respond_friend_request', 'rpc');
    expect(recorded).toHaveLength(10);
    expect(recorded.every((m) => m.ok && m.status === 200)).toBe(true);
  });

  it('the other person can answer too: Dora accepts the request of the demo user', () => {
    const { dora, backend } = setup();
    expect(respond(dora, IDS.friendship.dora, true).json).toBe(true);
    expect(backend.rows('friendships').find((f) => f.id === IDS.friendship.dora)).toMatchObject({ status: 'accepted', requester_id: USER.id });
  });

  it('checks its arguments: a bad uuid is 22P02 (recorded as failed), a missing one is PGRST202; needs a signed-in caller', () => {
    const { demo, anon, backend } = setup();
    const bad = rpc(demo, 'respond_friend_request', { p_id: 'not-a-uuid', p_accept: true });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('22P02');
    expect(backend.mutations.filter((m) => m.table === 'rpc:respond_friend_request' && !m.ok)).toHaveLength(1);
    expect(rpc(demo, 'respond_friend_request', { p_id: IDS.friendship.ben }).json.code).toBe('PGRST202');
    expect(rpc(demo, 'respond_friend_request', { p_accept: true }).json.code).toBe('PGRST202');
    expect(respond(anon, IDS.friendship.ben, true).status).toBe(401);
  });
});

// ----------------------------------------------------------------------------- the policy helpers

describe('friends: my_friend_ids() and my_used_food(p_food_id)', () => {
  it('my_friend_ids answers an array of the accepted friends only', () => {
    const { demo, anna, ben, carl, dora } = setup();
    expect(rpc(demo, 'my_friend_ids').json).toEqual([IDS.friend.anna]);
    expect(friendIds(anna)).toEqual([USER.id]);
    expect(friendIds(ben)).toEqual([]); // a pending request is not a friendship
    expect(friendIds(dora)).toEqual([]);
    expect(friendIds(carl)).toEqual([]);
    respond(demo, IDS.friendship.ben, true);
    expect(friendIds(demo)).toEqual([IDS.friend.anna, IDS.friend.ben]);
    expect(friendIds(ben)).toEqual([USER.id]);
    expect(rpc(demo, 'my_friend_ids', { x: 1 }).json.code).toBe('PGRST202');
  });

  it('my_used_food is true for a diary entry, a recipe ingredient, a saved meal item or a favourite of the caller', () => {
    const { demo, anna } = setup();
    const used = (c: Client, id: string) => rpc(c, 'my_used_food', { p_food_id: id }).json;
    // the demo library uses its foods in the diary, in recipes, saved meals and favourites; the friends' foods nowhere yet
    expect(used(demo, IDS.food.oats)).toBe(true);
    expect(used(demo, IDS.food.chickenRaw)).toBe(true); // a favourite and a recipe ingredient, never in the diary
    for (const id of [IDS.food.annaHummus, IDS.food.annaSpice, IDS.food.annaSoup, IDS.food.carlSauce]) expect(used(demo, id)).toBe(false);
    expect(used(anna, IDS.food.oats)).toBe(false); // other people's uses do not count

    expect(demo('POST', '/rest/v1/favorites', { body: { user_id: USER.id, food_id: IDS.food.annaHummus } }).status).toBe(201);
    expect(used(demo, IDS.food.annaHummus)).toBe(true);
    expect(used(demo, IDS.food.annaSoup)).toBe(false);
    expect(demo('POST', '/rest/v1/saved_meal_items', { body: { saved_meal_id: IDS.savedMeal.lunch, food_id: IDS.food.annaSoup, grams: 350 } }).status).toBe(201);
    expect(used(demo, IDS.food.annaSoup)).toBe(true);
    expect(used(demo, IDS.food.annaSpice)).toBe(false);
    expect(demo('POST', '/rest/v1/recipe_ingredients', { body: { recipe_food_id: IDS.food.recipeChickenRice, ingredient_food_id: IDS.food.annaSpice, grams: 5 } }).status).toBe(201);
    expect(used(demo, IDS.food.annaSpice)).toBe(true);
    respond(demo, IDS.friendship.ben, true);
    expect(used(demo, IDS.food.benGranola)).toBe(false);
    expect(demo('POST', '/rest/v1/diary_entries', { body: logEntry(IDS.food.benGranola) }).status).toBe(201);
    expect(used(demo, IDS.food.benGranola)).toBe(true);
    expect(used(anna, IDS.food.annaHummus)).toBe(false); // the owner does not "use" it by owning it
  });

  it('my_used_food validates its argument', () => {
    const { demo, anon } = setup();
    expect(rpc(demo, 'my_used_food', { p_food_id: 'x' }).json.code).toBe('22P02');
    expect(rpc(demo, 'my_used_food', {}).json.code).toBe('PGRST202');
    expect(rpc(demo, 'my_used_food', { p_food_id: IDS.missing }).json).toBe(false);
    expect(rpc(anon, 'my_used_food', { p_food_id: IDS.food.oats }).status).toBe(401);
  });
});

// ----------------------------------------------------------------------------- foods, portions, recipes

describe('friends: what a friend can read', () => {
  it("shows the demo user Anna's hummus, spice mix and soup, and nothing of the shake, Carl's sauce or Ben's granola", () => {
    const { demo } = setup();
    expect(ownedNames(demo)).toEqual([...ANNA_SHARED, ...OWN_FOODS]);
    for (const id of [IDS.food.annaShake, IDS.food.carlSauce, IDS.food.benGranola]) {
      expect(demo('GET', `/rest/v1/foods?select=id&id=eq.${id}`).json).toEqual([]);
      expect(demo('GET', `/rest/v1/foods?select=id&id=eq.${id}`, { headers: ONE }).status).toBe(406);
    }
    expect(demo('GET', '/rest/v1/foods?select=id&limit=1000').json).toHaveLength(31 + ANNA_SHARED.length); // the default catalogue and library, plus three
    // everything of a visible food is readable: the full row
    const hummus = demo('GET', `/rest/v1/foods?select=*&id=eq.${IDS.food.annaHummus}`, { headers: ONE });
    expect(hummus.json).toMatchObject({ name: 'Anna hummus', kind: 'custom', owner_id: IDS.friend.anna });
    expect(Object.keys(hummus.json.nutrients).length).toBeGreaterThan(10);
  });

  it("shows archived friends' foods too (the policy does not look at `archived`; the app hides them)", () => {
    const { demo, anna } = setup();
    expect(anna('PATCH', `/rest/v1/foods?id=eq.${IDS.food.annaHummus}`, { body: { archived: true } }).status).toBe(204);
    expect(demo('GET', `/rest/v1/foods?select=name,archived&id=eq.${IDS.food.annaHummus}`).json).toEqual([{ name: 'Anna hummus', archived: true }]);
  });

  it('lets portions follow their food', () => {
    const { demo } = setup();
    const portions = (ids: string[]) => demo('GET', `/rest/v1/food_portions?select=label,grams&food_id=in.(${ids.join(',')})`).json as { label: string; grams: number }[];
    expect(portions([IDS.food.annaHummus])).toEqual([{ label: '2 tbsp', grams: 30 }]);
    expect(portions([IDS.food.annaSoup]).map((p) => p.label).sort()).toEqual(['1 serving', '100 g', 'Full recipe']);
    expect(portions([IDS.food.annaShake, IDS.food.carlSauce, IDS.food.benGranola])).toEqual([]);
    const embedded = demo('GET', `/rest/v1/foods?select=name,food_portions(label)&id=eq.${IDS.food.annaSpice}`).json;
    expect(embedded).toEqual([{ name: 'Anna spice mix', food_portions: [{ label: '1 tsp' }] }]);
  });

  it("shows Anna's recipe row and its ingredients next to the demo user's own", () => {
    const { demo, anna } = setup();
    const recipes = demo('GET', '/rest/v1/recipes?select=food_id,user_id,servings,final_weight_g&order=servings.asc').json;
    expect(recipes).toEqual([
      { food_id: IDS.food.recipeChickenRice, user_id: USER.id, servings: 2, final_weight_g: 900 },
      { food_id: IDS.food.annaSoup, user_id: IDS.friend.anna, servings: 4, final_weight_g: 1400 },
    ]);
    const ingredients = demo('GET', `/rest/v1/recipe_ingredients?select=grams,food:foods!ingredient_food_id(name)&recipe_food_id=eq.${IDS.food.annaSoup}&order=sort_order.asc`).json;
    expect(ingredients).toEqual([
      { grams: 700, food: { name: 'Lentils, boiled' } },
      { grams: 12, food: { name: 'Anna spice mix' } },
    ]);
    expect(demo('GET', '/rest/v1/recipe_ingredients?select=id').json).toHaveLength(5 + 2);
    // the recipe of a food, embedded the way the app reads it
    const soup = demo('GET', `/rest/v1/foods?select=name,recipes!food_id(servings,notes,recipe_ingredients(grams))&id=eq.${IDS.food.annaSoup}`, { headers: ONE }).json;
    expect(soup.recipes).toMatchObject({ servings: 4 });
    expect(soup.recipes.recipe_ingredients).toHaveLength(2);
    // and the other way round: Anna reads the demo user's recipe
    expect(anna('GET', `/rest/v1/recipe_ingredients?select=id&recipe_food_id=eq.${IDS.food.recipeChickenRice}`).json).toHaveLength(5);
  });

  it("is mutual: Anna sees the demo user's custom foods and recipe, but not the AI estimate", () => {
    const { anna } = setup();
    expect(ownedNames(anna)).toEqual(['Anna hummus', 'Anna lentil soup', 'Anna protein shake', 'Anna spice mix', 'Piletina s rižom', 'Vrhnje za kuhanje', 'Ćevapi']);
  });

  it('shares nothing else: no diary, weight, targets, profile, favourites, saved meals, notes, water, workouts or coach chats', () => {
    const { anna, demo } = setup();
    for (const table of [
      'diary_entries',
      'daily_totals',
      'food_usage',
      'meal_groups',
      'biometrics',
      'weight_goals',
      'macro_targets',
      'nutrient_targets',
      'favorites',
      'saved_meals',
      'saved_meal_items',
      'notes',
      'water_entries',
      'exercise_entries',
      'daily_energy',
      'coach_threads',
      'coach_messages',
    ]) {
      expect(anna('GET', `/rest/v1/${table}?select=*`).json, table).toEqual([]);
    }
    expect(anna('GET', '/rest/v1/profiles?select=user_id,display_name').json).toEqual([{ user_id: IDS.friend.anna, display_name: 'Anna' }]);
    expect(demo('GET', '/rest/v1/profiles?select=user_id').json).toEqual([{ user_id: USER.id }]);
  });

  it('follows the life of a request: nothing while pending, Ben\'s granola after accept, gone again after the friendship is removed', () => {
    const { demo, ben } = setup();
    expect(ownedNames(demo, `&owner_id=eq.${IDS.friend.ben}`)).toEqual([]);
    expect(ownedNames(ben, `&owner_id=eq.${USER.id}`)).toEqual([]);
    respond(demo, IDS.friendship.ben, true);
    expect(ownedNames(demo, `&owner_id=eq.${IDS.friend.ben}`)).toEqual(['Ben granola']);
    expect(ownedNames(ben, `&owner_id=eq.${USER.id}`)).toEqual(['Piletina s rižom', 'Vrhnje za kuhanje', 'Ćevapi']);
    expect(ben('DELETE', `/rest/v1/friendships?id=eq.${IDS.friendship.ben}`).status).toBe(204);
    expect(ownedNames(demo, `&owner_id=eq.${IDS.friend.ben}`)).toEqual([]);
    expect(ownedNames(ben, `&owner_id=eq.${USER.id}`)).toEqual([]);
  });

  it('a declined request shares nothing, and Carl stays invisible all along', () => {
    const { demo } = setup();
    respond(demo, IDS.friendship.ben, false);
    expect(ownedNames(demo)).toEqual([...ANNA_SHARED, ...OWN_FOODS]);
    expect(ownedNames(demo, `&owner_id=eq.${IDS.friend.carl}`)).toEqual([]);
  });

  it('ends with the friendship: from either side, the foods, portions, recipes and ingredients are gone', () => {
    const { demo, anna, backend } = setup();
    expect(demo('DELETE', `/rest/v1/friendships?id=eq.${IDS.friendship.anna}`).status).toBe(204);
    expect(ownedNames(demo)).toEqual(OWN_FOODS);
    expect(demo('GET', `/rest/v1/food_portions?select=id&food_id=eq.${IDS.food.annaHummus}`).json).toEqual([]);
    expect(demo('GET', '/rest/v1/recipes?select=food_id').json).toEqual([{ food_id: IDS.food.recipeChickenRice }]);
    expect(demo('GET', '/rest/v1/recipe_ingredients?select=id').json).toHaveLength(5);
    expect(friendIds(demo)).toEqual([]);
    expect(ownedNames(anna)).toEqual(['Anna hummus', 'Anna lentil soup', 'Anna protein shake', 'Anna spice mix']);
    expect(backend.integrityErrors()).toEqual([]);

    // asking again starts over: a new pending row, nothing visible until she accepts
    expect(send(demo, 'anna@example.com').json).toBe('sent');
    expect(ownedNames(demo)).toEqual(OWN_FOODS);
    expect(respond(anna, backend.rows('friendships').find((f) => f.requester_id === USER.id && f.addressee_id === IDS.friend.anna)!.id as string, true).json).toBe(true);
    expect(ownedNames(demo)).toEqual([...ANNA_SHARED, ...OWN_FOODS]);
  });

  it.each([
    ['a diary entry', IDS.food.annaHummus, 'Anna hummus', (c: Client) => c('POST', '/rest/v1/diary_entries', { body: logEntry(IDS.food.annaHummus) })],
    ['a favourite', IDS.food.annaHummus, 'Anna hummus', (c: Client) => c('POST', '/rest/v1/favorites', { body: { user_id: USER.id, food_id: IDS.food.annaHummus } })],
    [
      'a recipe ingredient',
      IDS.food.annaSpice,
      'Anna spice mix',
      (c: Client) => c('POST', '/rest/v1/recipe_ingredients', { body: { recipe_food_id: IDS.food.recipeChickenRice, ingredient_food_id: IDS.food.annaSpice, grams: 5, sort_order: 9 } }),
    ],
    [
      'a saved meal item',
      IDS.food.annaSoup,
      'Anna lentil soup',
      (c: Client) => c('POST', '/rest/v1/saved_meal_items', { body: { saved_meal_id: IDS.savedMeal.lunch, food_id: IDS.food.annaSoup, grams: 350, sort_order: 9 } }),
    ],
  ])('keeps the one food used in %s after the friendship ends, and hides all the others', (_use, foodId, name, use) => {
    const { demo } = setup();
    const portionsBefore = demo('GET', `/rest/v1/food_portions?select=id&food_id=eq.${foodId}`).json.length;
    expect(use(demo).status).toBe(201);
    expect(demo('DELETE', `/rest/v1/friendships?id=eq.${IDS.friendship.anna}`).status).toBe(204);
    expect(ownedNames(demo, `&owner_id=eq.${IDS.friend.anna}`)).toEqual([name]);
    expect(demo('GET', `/rest/v1/food_portions?select=id&food_id=eq.${foodId}`).json).toHaveLength(portionsBefore); // portions follow
    // the recipe rows of the former friend are not readable any more, even when the soup itself stays visible
    expect(demo('GET', `/rest/v1/recipes?select=food_id&user_id=eq.${IDS.friend.anna}`).json).toEqual([]);
    // visible, but no longer found by the search (private.search_foods_ranked applies the friends rule only)
    expect(search(demo, name.split(' ')[1]!).map((r) => r.name)).not.toContain(name);
  });

  it('drops the used food again as soon as the use is gone', () => {
    const { demo } = setup();
    expect(demo('POST', '/rest/v1/diary_entries', { body: logEntry(IDS.food.annaHummus) }).status).toBe(201);
    demo('DELETE', `/rest/v1/friendships?id=eq.${IDS.friendship.anna}`);
    expect(ownedNames(demo, `&owner_id=eq.${IDS.friend.anna}`)).toEqual(['Anna hummus']);
    // an embedded read of the diary still has the food
    expect(demo('GET', `/rest/v1/diary_entries?select=grams,foods(name)&food_id=eq.${IDS.food.annaHummus}`).json).toEqual([{ grams: 60, foods: { name: 'Anna hummus' } }]);
    expect(demo('DELETE', `/rest/v1/diary_entries?food_id=eq.${IDS.food.annaHummus}`).status).toBe(204);
    expect(ownedNames(demo, `&owner_id=eq.${IDS.friend.anna}`)).toEqual([]);
  });
});

// ----------------------------------------------------------------------------- writes stay owner-only

describe('friends: a friend cannot change what is shared', () => {
  it('updating or deleting a friend\'s food, portion, recipe or ingredient affects 0 rows, like a foreign food always did', () => {
    const { demo, backend } = setup();
    const tables = ['foods', 'food_portions', 'recipes', 'recipe_ingredients'];
    const snapshot = () => JSON.stringify(tables.map((t) => backend.rows(t)));
    const before = snapshot();

    const attempts: [string, string, Record<string, unknown>][] = [
      ['foods', `id=eq.${IDS.food.annaHummus}`, { name: 'Mine now' }],
      ['food_portions', `food_id=eq.${IDS.food.annaHummus}`, { grams: 1 }],
      ['recipes', `food_id=eq.${IDS.food.annaSoup}`, { servings: 1 }],
      ['recipe_ingredients', `recipe_food_id=eq.${IDS.food.annaSoup}`, { grams: 1 }],
    ];
    for (const [table, filter, patch] of attempts) {
      const up = demo('PATCH', `/rest/v1/${table}?${filter}`, { body: patch, headers: REP });
      expect(up.status, `PATCH ${table}`).toBe(200);
      expect(up.json, `PATCH ${table}`).toEqual([]);
      expect(demo('PATCH', `/rest/v1/${table}?${filter}`, { body: patch }).status, `PATCH ${table}`).toBe(204);
      const del = demo('DELETE', `/rest/v1/${table}?${filter}`, { headers: REP });
      expect(del.status, `DELETE ${table}`).toBe(200);
      expect(del.json, `DELETE ${table}`).toEqual([]);
      expect(demo('DELETE', `/rest/v1/${table}?${filter}`).status, `DELETE ${table}`).toBe(204);
    }
    expect(snapshot()).toBe(before);
    expect(backend.mutations.filter((m) => tables.includes(m.table)).every((m) => m.ok && m.rows === 0)).toBe(true);
  });

  it("refuses to create rows under a friend's food or recipe (row level security, 403)", () => {
    const { demo, backend } = setup();
    const tries: [string, Record<string, unknown>][] = [
      ['food_portions', { food_id: IDS.food.annaHummus, label: 'x', grams: 10 }],
      ['recipe_ingredients', { recipe_food_id: IDS.food.annaSoup, ingredient_food_id: IDS.food.oats, grams: 10 }],
      ['recipes', { food_id: IDS.food.annaSoup, user_id: IDS.friend.anna }],
      ['foods', { owner_id: IDS.friend.anna, source: 'custom', kind: 'custom', name: 'Fake Anna food' }],
    ];
    for (const [table, body] of tries) {
      const r = demo('POST', `/rest/v1/${table}`, { body });
      expect(r.status, table).toBe(403);
      expect(r.json.code, table).toBe('42501');
    }
    const merge = demo('POST', '/rest/v1/foods?on_conflict=id', {
      body: { id: IDS.food.annaHummus, owner_id: USER.id, source: 'custom', kind: 'custom', name: 'Taken over' },
      headers: { prefer: 'resolution=merge-duplicates' },
    });
    expect(merge.status).toBe(403);
    expect(backend.rows('foods').find((f) => f.id === IDS.food.annaHummus)).toMatchObject({ name: 'Anna hummus', owner_id: IDS.friend.anna });
  });

  it("supersede_food on a friend's food: visible but not updatable (insufficient privilege); on a stranger's: not found", () => {
    const { demo, backend } = setup();
    const friends = rpc(demo, 'supersede_food', { p_food_id: IDS.food.annaHummus });
    expect(friends.status).toBe(403);
    expect(friends.json.code).toBe('42501');
    expect(friends.json.message).toMatch(/may not be modified/);
    const stranger = rpc(demo, 'supersede_food', { p_food_id: IDS.food.carlSauce });
    expect(stranger.status).toBe(400);
    expect(stranger.json.code).toBe('P0002');
    expect(backend.rows('foods').find((f) => f.id === IDS.food.annaHummus)).toMatchObject({ archived: false, version: 1 });
  });
});

// ----------------------------------------------------------------------------- using a friend's food

describe("friends: logging and using a friend's food", () => {
  it("logs a friend's custom food and recipe in the diary (usage and daily totals follow)", () => {
    const { demo, backend } = setup();
    const kcalBefore = demo('GET', '/rest/v1/daily_totals?select=kcal&entry_date=eq.2026-11-10', { headers: ONE }).json.kcal;
    const hummus = demo('POST', '/rest/v1/diary_entries?select=id,food_id,grams', { body: logEntry(IDS.food.annaHummus, { grams: 100 }), headers: { ...ONE, ...REP } });
    expect(hummus.status).toBe(201);
    expect(hummus.json).toMatchObject({ food_id: IDS.food.annaHummus, grams: 100 });
    expect(demo('POST', '/rest/v1/diary_entries', { body: logEntry(IDS.food.annaSoup, { grams: 350, source: 'recipe' }) }).status).toBe(201);
    expect(backend.rows('food_usage').find((u) => u.user_id === USER.id && u.food_id === IDS.food.annaHummus)).toMatchObject({ use_count: 1 });
    const after = demo('GET', '/rest/v1/daily_totals?select=kcal&entry_date=eq.2026-11-10', { headers: ONE }).json.kcal;
    expect(after).toBeGreaterThan(kcalBefore + 229);
    expect(backend.mutationsOf('diary_entries', 'insert')).toHaveLength(2);
  });

  it("refuses a stranger's food, an AI estimate of a friend, and a pending friend's food (row level security: 403 / 42501)", () => {
    const { demo, backend } = setup();
    for (const [what, id] of [
      ['Carl (no relation)', IDS.food.carlSauce],
      ["Anna's AI estimate", IDS.food.annaShake],
      ["Ben's food while his request is pending", IDS.food.benGranola],
    ] as const) {
      const r = demo('POST', '/rest/v1/diary_entries', { body: logEntry(id) });
      expect(r.status, what).toBe(403);
      expect(r.json, what).toMatchObject(RLS_DIARY);
    }
    expect(backend.mutationsOf('diary_entries', 'insert')).toEqual([]);
    expect(backend.mutations.filter((m) => m.table === 'diary_entries' && !m.ok).map((m) => m.status)).toEqual([403, 403, 403]);
    // ... until Ben's request is accepted
    respond(demo, IDS.friendship.ben, true);
    expect(demo('POST', '/rest/v1/diary_entries', { body: logEntry(IDS.food.benGranola) }).status).toBe(201);
  });

  it('a food that does not exist at all still ends in the foreign key error, as before', () => {
    const { demo } = setup();
    expect(demo('POST', '/rest/v1/diary_entries', { body: logEntry(stableUuid('nope')) }).json.code).toBe('23503');
  });

  it("checks the same for favourites, saved meal items and recipe ingredients", () => {
    const { demo, backend } = setup();
    const refused = (r: Reply, table: string) => {
      expect(r.status, table).toBe(403);
      expect(r.json.code, table).toBe('42501');
      expect(r.json.message, table).toContain(table);
    };
    refused(demo('POST', '/rest/v1/favorites', { body: { user_id: USER.id, food_id: IDS.food.carlSauce } }), 'favorites');
    refused(demo('POST', '/rest/v1/saved_meal_items', { body: { saved_meal_id: IDS.savedMeal.lunch, food_id: IDS.food.carlSauce, grams: 10 } }), 'saved_meal_items');
    refused(demo('POST', '/rest/v1/recipe_ingredients', { body: { recipe_food_id: IDS.food.recipeChickenRice, ingredient_food_id: IDS.food.annaShake, grams: 10 } }), 'recipe_ingredients');
    expect(demo('POST', '/rest/v1/favorites', { body: { user_id: USER.id, food_id: IDS.food.annaHummus } }).status).toBe(201);
    expect(demo('POST', '/rest/v1/saved_meal_items', { body: { saved_meal_id: IDS.savedMeal.lunch, food_id: IDS.food.annaSpice, grams: 10 } }).status).toBe(201);
    expect(demo('POST', '/rest/v1/recipe_ingredients', { body: { recipe_food_id: IDS.food.recipeChickenRice, ingredient_food_id: IDS.food.annaSpice, grams: 10 } }).status).toBe(201);
    expect(backend.integrityErrors()).toEqual([]);
  });

  it("cannot point an existing entry at a stranger's food either (update and upsert), but can at a friend's", () => {
    const { demo, backend } = setup();
    const entry = backend.rows('diary_entries')[0]!;
    const patch = (food: string) => demo('PATCH', `/rest/v1/diary_entries?id=eq.${entry.id}`, { body: { food_id: food } });
    const refused = patch(IDS.food.carlSauce);
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject(RLS_DIARY);
    expect(backend.rows('diary_entries')[0]!.food_id).toBe(entry.food_id);

    const upsert = demo('POST', '/rest/v1/diary_entries?on_conflict=id', {
      body: { id: entry.id, user_id: USER.id, entry_date: entry.entry_date, food_id: IDS.food.carlSauce, grams: entry.grams },
      headers: { prefer: 'resolution=merge-duplicates' },
    });
    expect(upsert.status).toBe(403);
    expect(backend.rows('diary_entries')[0]!.food_id).toBe(entry.food_id);

    expect(patch(IDS.food.annaHummus).status).toBe(204);
    expect(backend.rows('diary_entries')[0]!.food_id).toBe(IDS.food.annaHummus);
  });

  it('keeps editing an old entry working after the friendship ended (its food stays visible through the entry itself)', () => {
    const { demo, backend } = setup();
    expect(demo('POST', '/rest/v1/diary_entries?select=id', { body: logEntry(IDS.food.annaHummus), headers: { ...ONE, ...REP } }).status).toBe(201);
    const id = backend.rows('diary_entries').find((e) => e.food_id === IDS.food.annaHummus)!.id;
    demo('DELETE', `/rest/v1/friendships?id=eq.${IDS.friendship.anna}`);
    expect(demo('PATCH', `/rest/v1/diary_entries?id=eq.${id}`, { body: { grams: 90 } }).status).toBe(204);
    expect(backend.rows('diary_entries').find((e) => e.id === id)).toMatchObject({ grams: 90 });
    // the food can still be logged again (it is visible), another food of the former friend cannot
    expect(demo('POST', '/rest/v1/diary_entries', { body: logEntry(IDS.food.annaHummus, { grams: 20 }) }).status).toBe(201);
    expect(demo('POST', '/rest/v1/diary_entries', { body: logEntry(IDS.food.annaSpice) }).status).toBe(403);
  });
});

// ----------------------------------------------------------------------------- barcode and search

describe('friends: barcode lookup and search', () => {
  it("get_food_by_gtin is not changed: a friend's food is visible but never the answer", () => {
    const gtin = '03017620422999';
    const { demo, anna } = setup(seedWith((t) => void (t.foods!.find((f) => f.id === IDS.food.annaHummus)!.gtin14 = gtin)));
    expect(rpc(demo, 'get_food_by_gtin', { gtin }).json).toEqual([]);
    expect(demo('GET', `/rest/v1/foods?select=name&gtin14=eq.${gtin}`).json).toEqual([{ name: 'Anna hummus' }]);
    demo('POST', '/rest/v1/diary_entries', { body: logEntry(IDS.food.annaHummus) });
    expect(rpc(demo, 'get_food_by_gtin', { gtin }).json).toEqual([]); // not even once it is used
    expect(rpc(anna, 'get_food_by_gtin', { gtin }).json.map((f: any) => f.name)).toEqual(['Anna hummus']); // her own food
  });

  it("finds a friend's food and recipe, but not Carl's, Ben's (pending) or an AI estimate", () => {
    const { demo, anna } = setup();
    expect(search(demo, 'hummus').map((r) => [r.name, r.kind, r.source])).toEqual([['Anna hummus', 'custom', 'custom']]);
    expect(search(demo, 'sauce')).toEqual([]);
    expect(search(demo, 'pasta').map((r) => r.name)).toEqual(['Pasta, cooked, enriched']);
    expect(search(demo, 'granola')).toEqual([]);
    expect(search(demo, 'protein shake')).toEqual([]);
    expect(search(demo, 'shake', { kinds: ['ai_estimate'] })).toEqual([]);
    expect(search(anna, 'shake').map((r) => r.name)).toEqual(['Anna protein shake']); // her own, of course

    const lentil = search(demo, 'lentil');
    expect(lentil.map((r) => r.name).sort()).toEqual(['Anna lentil soup', 'Lentils, boiled']);
    expect(search(demo, 'lentil', { kinds: ['recipe'] }).map((r) => [r.name, r.kind])).toEqual([['Anna lentil soup', 'recipe']]);
    expect(Object.keys(search(demo, 'hummus')[0]!).sort()).toEqual(['brand', 'carbs_100g', 'completeness', 'fat_100g', 'id', 'kcal_100g', 'kind', 'name', 'protein_100g', 'rank', 'source']);
  });

  it('follows the request: found after it is accepted, gone when the friendship ends, never when it is declined', () => {
    const { demo } = setup();
    respond(demo, IDS.friendship.ben, true);
    expect(search(demo, 'granola').map((r) => r.name)).toEqual(['Ben granola']);
    demo('DELETE', `/rest/v1/friendships?id=eq.${IDS.friendship.ben}`);
    expect(search(demo, 'granola')).toEqual([]);
    expect(search(demo, 'hummus')).toHaveLength(1);
    demo('DELETE', `/rest/v1/friendships?id=eq.${IDS.friendship.anna}`);
    expect(search(demo, 'hummus')).toEqual([]);
  });

  it("leaves a friend's archived food out of the search", () => {
    const { demo, anna } = setup();
    anna('PATCH', `/rest/v1/foods?id=eq.${IDS.food.annaHummus}`, { body: { archived: true } });
    expect(search(demo, 'hummus')).toEqual([]);
    expect(demo('GET', `/rest/v1/foods?select=id&id=eq.${IDS.food.annaHummus}`).json).toHaveLength(1);
  });

  it("ranks a friend's food 0.30 below an own food with the same name match (own +0.60, friends' +0.30, global 0)", () => {
    const { demo, backend } = setup();
    const hummus = backend.rows('foods').find((f) => f.id === IDS.food.annaHummus)!;
    const created = demo('POST', '/rest/v1/foods?select=id', {
      body: {
        name: 'Anna hummus',
        source: 'custom',
        kind: 'custom',
        owner_id: USER.id,
        nutrients: hummus.nutrients,
        completeness: hummus.completeness,
        popularity: hummus.popularity,
      },
      headers: { ...ONE, ...REP },
    });
    expect(created.status).toBe(201);
    const found = search(demo, 'hummus');
    expect(found.map((r) => r.id)).toEqual([created.json.id, IDS.food.annaHummus]);
    expect(found[0]!.rank - found[1]!.rank).toBeCloseTo(0.3, 5);

    // the same ordering from the other side: for Anna the food she owns comes first
    const anna = clientFor(backend, tokenOf(FRIEND_USERS.anna));
    expect(search(anna, 'hummus').map((r) => r.id)).toEqual([IDS.food.annaHummus, created.json.id]);
    expect(search(anna, 'hummus')[0]!.rank - search(anna, 'hummus')[1]!.rank).toBeCloseTo(0.3, 5);
  });

  it("gives a friend's food +0.30 over the same food without an owner (global 0, own +0.60)", () => {
    const { demo } = setup(
      seedWith((t) => {
        const hummus = t.foods!.find((f) => f.id === IDS.food.annaHummus)!;
        // an identical row without an owner: the personal part of the ranking is the only difference
        t.foods!.push({ ...hummus, id: stableUuid('global hummus'), owner_id: null, kind: 'generic' });
      }),
    );
    const found = search(demo, 'hummus');
    expect(found).toHaveLength(2);
    const friend = found.find((r) => r.id === IDS.food.annaHummus)!;
    const global = found.find((r) => r.id === stableUuid('global hummus'))!;
    expect(friend.rank - global.rank).toBeCloseTo(0.3, 5);
  });
});

// ----------------------------------------------------------------------------- a request from scratch

describe('friends: a request from Carl to the demo user, end to end', () => {
  it('asks, waits, is accepted, shares, and ends', () => {
    const { carl, demo, backend } = setup();
    expect(send(carl, USER.email).json).toBe('sent');
    expect(list(demo)[0]).toMatchObject({ direction: 'incoming', status: 'pending', display_name: 'Carl', email: 'carl@example.com' });
    expect(ownedNames(demo, `&owner_id=eq.${IDS.friend.carl}`)).toEqual([]);

    const row = backend.rows('friendships').find((f) => f.requester_id === IDS.friend.carl)!;
    expect(respond(demo, row.id as string, true).json).toBe(true);
    expect(ownedNames(demo, `&owner_id=eq.${IDS.friend.carl}`)).toEqual(['Carl pasta sauce']);
    expect(search(demo, 'sauce').map((r) => r.name)).toEqual(['Carl pasta sauce']);
    expect(demo('POST', '/rest/v1/diary_entries', { body: logEntry(IDS.food.carlSauce) }).status).toBe(201);
    expect(friendIds(demo).sort()).toEqual([IDS.friend.anna, IDS.friend.carl].sort());

    expect(carl('DELETE', `/rest/v1/friendships?id=eq.${row.id}`).status).toBe(204);
    expect(ownedNames(demo, `&owner_id=eq.${IDS.friend.carl}`)).toEqual(['Carl pasta sauce']); // used by the diary entry
    expect(search(demo, 'sauce')).toEqual([]);
    expect(backend.integrityErrors()).toEqual([]);
  });
});
