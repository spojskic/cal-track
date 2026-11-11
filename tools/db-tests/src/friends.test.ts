import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MIGRATIONS_DIR,
  USER_A,
  USER_B,
  USER_C,
  asAnon,
  asUser,
  createDb,
  createUsers,
  expectError,
  insertDiary,
  insertFood,
  withRole,
} from './harness';

const DENIED = /permission denied/;
// A is "me"; B is a friend; C is a stranger; D has an account but no relation to anybody.
const USER_D = '00000000-0000-4000-8000-00000000000d';

interface Friendship {
  id: string;
  status: string;
  direction: string;
  user_id: string;
  display_name: string;
  email: string;
  created_at: string;
  responded_at: string | null;
}

describe('friends (migration 20261110000109)', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createDb();
    await createUsers(db, [
      { id: USER_A, email: 'alice@example.com' },
      { id: USER_B, email: 'Bob@Example.com' },
      { id: USER_C, email: 'carol@example.com' },
      { id: USER_D, email: 'dave@example.com' },
    ]);
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec(`
      delete from public.friendships;
      delete from public.favorites;
      delete from public.diary_entries;
      delete from public.saved_meal_items;
      delete from public.saved_meals;
      delete from public.recipe_ingredients;
      delete from public.recipes;
      delete from public.food_portions;
      delete from public.foods where owner_id is not null;
      delete from auth.users where email like 'bulk%@example.com';
    `);
  });

  /** Writes a friendship row the way the functions do, as the owner role (a test fixture, not a client path). */
  const link = async (requester: string, addressee: string, status: 'pending' | 'accepted' = 'accepted') => {
    const r = await db.query<{ id: string }>(
      `insert into public.friendships (requester_id, addressee_id, status, responded_at)
       values ($1, $2, $3, case when $3 = 'accepted' then now() end) returning id`,
      [requester, addressee, status],
    );
    return r.rows[0]!.id;
  };

  const rows = <T>(userId: string, sql: string, params: unknown[] = []) =>
    asUser(db, userId, async () => (await db.query<T>(sql, params)).rows);

  const send = (userId: string, email: string) =>
    asUser(db, userId, async () => (await db.query<{ r: string }>('select public.send_friend_request($1) as r', [email])).rows[0]!.r);

  const respond = (userId: string, id: string, accept: boolean) =>
    asUser(db, userId, async () => (await db.query<{ r: boolean }>('select public.respond_friend_request($1, $2) as r', [id, accept])).rows[0]!.r);

  const visibleFoodNames = async (userId: string) =>
    (await rows<{ name: string }>(userId, 'select name from public.foods where owner_id is not null order by name')).map((r) => r.name);

  const customFood = (owner: string, name: string, extra: Record<string, unknown> = {}) =>
    insertFood(db, { name, source: 'custom', kind: 'custom', owner_id: owner, nutrients: { ENERGY_KCAL: 200 }, ...extra });

  describe('the migration file', () => {
    it('loads pg_trgm before it creates a function that SETs a pg_trgm parameter (a non-superuser gets 42501 otherwise, as on the real project)', () => {
      const sql = readFileSync(join(MIGRATIONS_DIR, '20261110000109_friends.sql'), 'utf8');
      const setAt = sql.indexOf('set pg_trgm.word_similarity_threshold');
      expect(setAt).toBeGreaterThan(0);
      // PGlite runs as a superuser and cannot show the failure, so the order is pinned here
      const loadAt = sql.indexOf("select extensions.similarity('a', 'a');");
      expect(loadAt).toBeGreaterThan(0);
      expect(loadAt).toBeLessThan(setAt);
      // the other pg_trgm-setting function is the one of migration 8: the same attribute, so the same rule
      expect(readFileSync(join(MIGRATIONS_DIR, '20261110000008_search_functions.sql'), 'utf8')).toContain('set pg_trgm.word_similarity_threshold');
    });
  });

  describe('the table', () => {
    it('is closed to anon; signed-in users read only their own rows', async () => {
      await link(USER_A, USER_B);
      await link(USER_C, USER_D, 'pending');
      expect(await rows(USER_A, 'select 1 from public.friendships')).toHaveLength(1);
      expect(await rows(USER_B, 'select 1 from public.friendships')).toHaveLength(1);
      expect(await rows(USER_C, 'select 1 from public.friendships')).toHaveLength(1);
      await asAnon(db, async () => {
        expect((await expectError(db.query('select 1 from public.friendships'))).message).toMatch(DENIED);
      });
    });

    it('a client can neither insert nor update a row (only the functions can)', async () => {
      const id = await link(USER_A, USER_C, 'pending');
      await asUser(db, USER_A, async () => {
        expect((await expectError(db.query(`insert into public.friendships (requester_id, addressee_id) values ($1, $2)`, [USER_A, USER_B]))).message).toMatch(DENIED);
        expect((await expectError(db.query(`update public.friendships set status = 'accepted' where id = $1`, [id]))).message).toMatch(DENIED);
      });
      await asUser(db, USER_C, async () => {
        expect((await expectError(db.query(`update public.friendships set status = 'accepted' where id = $1`, [id]))).message).toMatch(DENIED);
      });
    });

    it('either side can delete a row (cancel, decline, remove); a third person deletes nothing', async () => {
      const a = await link(USER_A, USER_B);
      const b = await link(USER_C, USER_A, 'pending');
      await asUser(db, USER_D, async () => {
        expect((await db.query('delete from public.friendships')).affectedRows).toBe(0);
      });
      await asUser(db, USER_B, async () => {
        expect((await db.query('delete from public.friendships where id = $1', [a])).affectedRows).toBe(1);
      });
      await asUser(db, USER_A, async () => {
        expect((await db.query('delete from public.friendships where id = $1', [b])).affectedRows).toBe(1);
      });
      expect((await db.query('select 1 from public.friendships')).rows).toEqual([]);
    });

    it('one row per PAIR whoever asked first, and nobody is their own friend', async () => {
      await link(USER_A, USER_B, 'pending');
      expect((await expectError(link(USER_B, USER_A, 'pending'))).code).toBe('23505');
      expect((await expectError(link(USER_C, USER_C, 'pending'))).code).toBe('23514');
    });

    it('rows go with the account (on delete cascade)', async () => {
      await db.query(`insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000e1', 'temp@example.com')`);
      await link(USER_A, '00000000-0000-4000-8000-0000000000e1');
      await db.query(`delete from auth.users where id = '00000000-0000-4000-8000-0000000000e1'`);
      expect((await db.query('select 1 from public.friendships')).rows).toEqual([]);
    });
  });

  describe('send_friend_request', () => {
    it('sends a request to an account by e-mail (any case, spaces around): a pending row from me to them', async () => {
      expect(await send(USER_A, '  BOB@example.com ')).toBe('sent');
      const r = await db.query<{ requester_id: string; addressee_id: string; status: string }>('select requester_id, addressee_id, status from public.friendships');
      expect(r.rows).toEqual([{ requester_id: USER_A, addressee_id: USER_B, status: 'pending' }]);
    });

    it('answers "sent" for an e-mail without an account, like for one with an account, and creates nothing', async () => {
      expect(await send(USER_A, 'nobody@example.com')).toBe('sent');
      expect((await db.query('select 1 from public.friendships')).rows).toEqual([]);
    });

    it('refuses your own address and a malformed one (22023)', async () => {
      for (const email of ['alice@example.com', 'ALICE@example.com', '', 'alice', 'a@b', 'a b@example.com', `${'a'.repeat(250)}@example.com`]) {
        const err = await expectError(send(USER_A, email));
        expect(err.code, email).toBe('22023');
      }
      expect((await db.query('select 1 from public.friendships')).rows).toEqual([]);
    });

    it('asking twice says "already_requested"; asking a friend says "already_friends"', async () => {
      expect(await send(USER_A, 'bob@example.com')).toBe('sent');
      expect(await send(USER_A, 'bob@example.com')).toBe('already_requested');
      expect((await db.query('select 1 from public.friendships')).rows).toHaveLength(1);
      await db.query(`update public.friendships set status = 'accepted'`);
      expect(await send(USER_A, 'bob@example.com')).toBe('already_friends');
      expect(await send(USER_B, 'alice@example.com')).toBe('already_friends');
    });

    it('asking somebody who already asked you accepts their request', async () => {
      await send(USER_B, 'alice@example.com');
      expect(await send(USER_A, 'bob@example.com')).toBe('accepted');
      const r = await db.query<{ status: string; responded: boolean }>('select status, responded_at is not null as responded from public.friendships');
      expect(r.rows).toEqual([{ status: 'accepted', responded: true }]);
    });

    it('allows 20 new requests in a day and refuses the 21st with 54000; requests older than a day do not count', async () => {
      const others: string[] = [];
      for (let i = 0; i < 21; i++) {
        const id = `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`;
        await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `bulk${i}@example.com`]);
        others.push(`bulk${i}@example.com`);
      }
      for (let i = 0; i < 20; i++) expect(await send(USER_A, others[i]!)).toBe('sent');
      const err = await expectError(send(USER_A, others[20]!));
      expect(err.code).toBe('54000');
      expect(err.message).toMatch(/too many friend requests/);
      await db.query(`update public.friendships set created_at = now() - interval '2 days' where requester_id = $1`, [USER_A]);
      expect(await send(USER_A, others[20]!)).toBe('sent');
      // someone else is not limited by my requests
      expect(await send(USER_B, 'dave@example.com')).toBe('sent');
      await db.query(`delete from auth.users where email like 'bulk%@example.com'`);
    });

    it('needs a signed-in user: anon is refused, and a JWT without a sub gets 42501', async () => {
      await asAnon(db, async () => {
        expect((await expectError(db.query(`select public.send_friend_request('bob@example.com')`))).message).toMatch(DENIED);
      });
      await withRole(db, 'authenticated', null, async () => {
        expect((await expectError(db.query(`select public.send_friend_request('bob@example.com')`))).code).toBe('42501');
      });
    });
  });

  describe('respond_friend_request', () => {
    it('the addressee accepts: the row becomes accepted, with the time', async () => {
      const id = await link(USER_A, USER_B, 'pending');
      expect(await respond(USER_B, id, true)).toBe(true);
      const r = await db.query<{ status: string; responded: boolean }>('select status, responded_at is not null as responded from public.friendships');
      expect(r.rows).toEqual([{ status: 'accepted', responded: true }]);
    });

    it('the addressee declines: the row is deleted (and the sender may ask again later)', async () => {
      const id = await link(USER_A, USER_B, 'pending');
      expect(await respond(USER_B, id, false)).toBe(true);
      expect((await db.query('select 1 from public.friendships')).rows).toEqual([]);
      expect(await send(USER_A, 'bob@example.com')).toBe('sent');
    });

    it('nobody else can answer it: not the sender, not a stranger, not twice; unknown ids say false', async () => {
      const id = await link(USER_A, USER_B, 'pending');
      expect(await respond(USER_A, id, true)).toBe(false);
      expect(await respond(USER_A, id, false)).toBe(false);
      expect(await respond(USER_C, id, true)).toBe(false);
      expect(await respond(USER_C, id, false)).toBe(false);
      expect((await db.query<{ status: string }>('select status from public.friendships')).rows).toEqual([{ status: 'pending' }]);
      expect(await respond(USER_B, id, true)).toBe(true);
      expect(await respond(USER_B, id, true)).toBe(false); // already accepted
      expect(await respond(USER_B, id, false)).toBe(false); // a decline cannot undo a friendship
      expect((await db.query<{ status: string }>('select status from public.friendships')).rows).toEqual([{ status: 'accepted' }]);
      expect(await respond(USER_B, '00000000-0000-4000-8000-000000000999', true)).toBe(false);
    });

    it('a missing answer (NULL) is refused and leaves the request alone', async () => {
      const id = await link(USER_A, USER_B, 'pending');
      const err = await asUser(db, USER_B, () => expectError(db.query('select public.respond_friend_request($1, null)', [id])));
      expect(err.code).toBe('22004');
      expect((await db.query<{ status: string }>('select status from public.friendships')).rows).toEqual([{ status: 'pending' }]);
    });

    it('needs a signed-in user', async () => {
      const id = await link(USER_A, USER_B, 'pending');
      await asAnon(db, async () => {
        expect((await expectError(db.query('select public.respond_friend_request($1, true)', [id]))).message).toMatch(DENIED);
      });
    });
  });

  describe('list_friendships and my_friend_ids', () => {
    it('lists my friends and requests with the other person (name, e-mail, direction), newest first, and nothing of other pairs', async () => {
      await link(USER_A, USER_B); // accepted
      const incoming = await link(USER_C, USER_A, 'pending');
      await link(USER_D, USER_C, 'pending'); // not mine
      await db.query(`update public.friendships set created_at = now() - interval '3 days' where status = 'accepted'`);
      await db.query(`update public.profiles set display_name = 'Robert' where user_id = $1`, [USER_B]);
      const list = await rows<Friendship>(USER_A, 'select * from public.list_friendships()');
      expect(list.map((r) => [r.direction, r.status, r.email, r.display_name])).toEqual([
        ['incoming', 'pending', 'carol@example.com', 'carol'],
        ['outgoing', 'accepted', 'Bob@Example.com', 'Robert'],
      ]);
      expect(list[0]).toMatchObject({ id: incoming, user_id: USER_C, responded_at: null });
      expect(list[1]!.responded_at).not.toBeNull();
      expect(Object.keys(list[0]!)).toEqual(['id', 'status', 'direction', 'user_id', 'display_name', 'email', 'created_at', 'responded_at']);
      // the same pair seen from the other side
      expect((await rows<Friendship>(USER_B, 'select * from public.list_friendships()')).map((r) => [r.direction, r.email])).toEqual([['incoming', 'alice@example.com']]);
      expect(await rows(USER_D, 'select * from public.list_friendships()')).toHaveLength(1);
    });

    it('falls back to the part of the e-mail before the @ when the profile has no name', async () => {
      await link(USER_A, USER_B);
      await db.query(`update public.profiles set display_name = null where user_id = $1`, [USER_B]);
      expect((await rows<Friendship>(USER_A, 'select * from public.list_friendships()'))[0]!.display_name).toBe('Bob');
    });

    it('my_friend_ids has the accepted friends from either side and no pending ones', async () => {
      await link(USER_A, USER_B);
      await link(USER_C, USER_A);
      await link(USER_A, USER_D, 'pending');
      const ids = (await rows<{ id: string }>(USER_A, 'select public.my_friend_ids() as id')).map((r) => r.id).sort();
      expect(ids).toEqual([USER_B, USER_C].sort());
      expect((await rows<{ id: string }>(USER_B, 'select public.my_friend_ids() as id')).map((r) => r.id)).toEqual([USER_A]);
      expect(await rows(USER_D, 'select public.my_friend_ids() as id')).toEqual([]);
    });

    it('the functions are for signed-in users only', async () => {
      const r = await db.query<{ fn: string; role: string; ok: boolean }>(
        `select p.proname as fn, r.rolname as role, has_function_privilege(r.rolname, p.oid, 'execute') as ok
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
           cross join (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
          where p.proname in ('my_friend_ids', 'my_used_food', 'send_friend_request', 'respond_friend_request', 'list_friendships')
          order by 1, 2`,
      );
      expect(r.rows).toHaveLength(15);
      for (const x of r.rows) expect(x.ok, `${x.fn} for ${x.role}`).toBe(x.role !== 'anon');
      const definer = await db.query<{ proname: string; prosecdef: boolean; fixed: boolean }>(
        `select p.proname, p.prosecdef, exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') as fixed
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
          where p.proname in ('my_friend_ids', 'my_used_food', 'send_friend_request', 'respond_friend_request', 'list_friendships')`,
      );
      expect(definer.rows).toHaveLength(5);
      for (const f of definer.rows) expect([f.proname, f.prosecdef, f.fixed]).toEqual([f.proname, true, true]);
    });
  });

  describe('what friends see', () => {
    let hummus: string;
    let soup: string;
    let spice: string;
    let shake: string;
    let oldFood: string;

    beforeEach(async () => {
      hummus = await customFood(USER_A, 'Hummus classic');
      spice = await customFood(USER_A, 'Spice mix');
      soup = await insertFood(db, { name: 'Lentil soup', source: 'recipe', kind: 'recipe', owner_id: USER_A, nutrients: { ENERGY_KCAL: 90 } });
      shake = await insertFood(db, { name: 'Protein shake', source: 'ai_estimate', kind: 'ai_estimate', owner_id: USER_A, nutrients: { ENERGY_KCAL: 120 } });
      oldFood = await customFood(USER_A, 'Old hummus', { archived: true });
      await db.query('insert into public.food_portions (food_id, label, grams) values ($1, $2, $3)', [hummus, '1 tbsp', 15]);
      await db.query('insert into public.recipes (food_id, user_id, servings) values ($1, $2, 4)', [soup, USER_A]);
      await db.query('insert into public.recipe_ingredients (recipe_food_id, ingredient_food_id, grams) values ($1, $2, 20)', [soup, spice]);
    });

    it('nobody sees them before they are friends, and a pending request shares nothing in either direction', async () => {
      expect(await visibleFoodNames(USER_B)).toEqual([]);
      await link(USER_A, USER_B, 'pending');
      await link(USER_C, USER_A, 'pending');
      expect(await visibleFoodNames(USER_B)).toEqual([]);
      expect(await visibleFoodNames(USER_C)).toEqual([]);
    });

    it('a friend sees custom foods and recipes (also archived ones), not AI estimates; a stranger sees nothing; the owner sees all', async () => {
      await link(USER_A, USER_B);
      expect(await visibleFoodNames(USER_B)).toEqual(['Hummus classic', 'Lentil soup', 'Old hummus', 'Spice mix']);
      expect(await visibleFoodNames(USER_C)).toEqual([]);
      expect(await visibleFoodNames(USER_A)).toEqual(['Hummus classic', 'Lentil soup', 'Old hummus', 'Protein shake', 'Spice mix']);
      // it works from either side of the row
      expect(await visibleFoodNames(USER_A)).not.toContain('Bob');
      const bobs = await customFood(USER_B, 'Bobs bread');
      expect(await visibleFoodNames(USER_A)).toContain('Bobs bread');
      expect((await rows<{ id: string }>(USER_C, 'select id from public.foods where id = $1', [bobs]))).toEqual([]);
    });

    it('portions, the recipe row and its ingredients come with the food', async () => {
      await link(USER_B, USER_A);
      expect(await rows(USER_B, 'select 1 from public.food_portions where food_id = $1', [hummus])).toHaveLength(1);
      expect(await rows(USER_B, 'select 1 from public.recipes where food_id = $1', [soup])).toHaveLength(1);
      expect(await rows(USER_B, 'select 1 from public.recipe_ingredients where recipe_food_id = $1', [soup])).toHaveLength(1);
      for (const sql of [
        'select 1 from public.food_portions where food_id = $1',
        'select 1 from public.recipes where food_id = $1',
        'select 1 from public.recipe_ingredients where recipe_food_id = $1',
      ]) {
        expect(await rows(USER_C, sql, [sql.includes('food_portions') ? hummus : soup]), sql).toEqual([]);
      }
    });

    it('a friend cannot change or delete anything of the owner (foods, portions, recipes, ingredients)', async () => {
      await link(USER_A, USER_B);
      await asUser(db, USER_B, async () => {
        for (const sql of [
          `update public.foods set name = 'mine now' where id = '${hummus}'`,
          `delete from public.foods where id = '${hummus}'`,
          `update public.food_portions set grams = 1 where food_id = '${hummus}'`,
          `delete from public.food_portions where food_id = '${hummus}'`,
          `update public.recipes set servings = 1 where food_id = '${soup}'`,
          `delete from public.recipes where food_id = '${soup}'`,
          `update public.recipe_ingredients set grams = 1 where recipe_food_id = '${soup}'`,
          `delete from public.recipe_ingredients where recipe_food_id = '${soup}'`,
        ]) {
          expect((await db.query(sql)).affectedRows, sql).toBe(0);
        }
        // nor create things in the owner's name or add to the owner's recipe
        expect((await expectError(db.query(`insert into public.foods (source, kind, owner_id, name) values ('custom', 'custom', '${USER_A}', 'planted')`))).code).toBe('42501');
        expect((await expectError(db.query(`insert into public.recipe_ingredients (recipe_food_id, ingredient_food_id, grams) values ('${soup}', '${hummus}', 5)`))).code).toBe('42501');
      });
      expect((await db.query<{ name: string }>('select name from public.foods where id = $1', [hummus])).rows[0]!.name).toBe('Hummus classic');
    });

    it('a friend logs the food, uses it in their own recipe and saved meal, and favourites it', async () => {
      await link(USER_A, USER_B);
      const entry = await asUser(db, USER_B, () => insertDiary(db, { user_id: USER_B, entry_date: '2026-11-10', food_id: hummus, grams: 30 }));
      expect(entry).toBeTruthy();
      await asUser(db, USER_B, async () => {
        await db.query('insert into public.favorites (user_id, food_id) values ($1, $2)', [USER_B, spice]);
        const bobSoup = (await db.query<{ id: string }>(`insert into public.foods (source, kind, owner_id, name) values ('recipe', 'recipe', $1, 'Bobs stew') returning id`, [USER_B])).rows[0]!.id;
        await db.query('insert into public.recipes (food_id, user_id, servings) values ($1, $2, 2)', [bobSoup, USER_B]);
        await db.query('insert into public.recipe_ingredients (recipe_food_id, ingredient_food_id, grams) values ($1, $2, 50)', [bobSoup, hummus]);
        const meal = (await db.query<{ id: string }>(`insert into public.saved_meals (user_id, name) values ($1, 'Lunch') returning id`, [USER_B])).rows[0]!.id;
        await db.query('insert into public.saved_meal_items (saved_meal_id, food_id, grams) values ($1, $2, 40)', [meal, soup]);
      });
      // 30 g of a 200 kcal / 100 g food: the totals trigger reads the friend's food too
      expect(Number((await db.query<{ kcal: string }>('select kcal from public.daily_totals where user_id = $1', [USER_B])).rows[0]!.kcal)).toBe(60);
    });

    it('a stranger cannot log, favourite or reuse a food they cannot see', async () => {
      await link(USER_A, USER_B);
      await asUser(db, USER_C, async () => {
        expect((await expectError(insertDiary(db, { user_id: USER_C, entry_date: '2026-11-10', food_id: hummus, grams: 30 }))).code).toBe('42501');
        expect((await expectError(db.query('insert into public.favorites (user_id, food_id) values ($1, $2)', [USER_C, hummus]))).code).toBe('42501');
      });
      // and the AI estimate of a friend is not reachable either
      await asUser(db, USER_B, async () => {
        expect((await expectError(insertDiary(db, { user_id: USER_B, entry_date: '2026-11-10', food_id: shake, grams: 30 }))).code).toBe('42501');
      });
    });

    it('a stranger cannot reach a food through a saved meal, a recipe ingredient or by re-pointing an entry; food_usage does not reveal it', async () => {
      await link(USER_A, USER_B);
      const oats = await customFood(USER_C, 'Carols oats');
      await asUser(db, USER_C, async () => {
        const entry = await insertDiary(db, { user_id: USER_C, entry_date: '2026-11-10', food_id: oats, grams: 30 });
        const meal = (await db.query<{ id: string }>(`insert into public.saved_meals (user_id, name) values ($1, 'Lunch') returning id`, [USER_C])).rows[0]!.id;
        const stew = (await db.query<{ id: string }>(`insert into public.foods (source, kind, owner_id, name) values ('recipe', 'recipe', $1, 'Carols stew') returning id`, [USER_C])).rows[0]!.id;
        await db.query('insert into public.recipes (food_id, user_id, servings) values ($1, $2, 2)', [stew, USER_C]);
        const attempts: Array<[string, unknown[]]> = [
          ['insert into public.saved_meal_items (saved_meal_id, food_id, grams) values ($1, $2, 40)', [meal, hummus]],
          ['insert into public.recipe_ingredients (recipe_food_id, ingredient_food_id, grams) values ($1, $2, 50)', [stew, hummus]],
          ['update public.diary_entries set food_id = $1 where id = $2', [hummus, entry]],
        ];
        for (const [sql, params] of attempts) expect((await expectError(db.query(sql, params))).code, sql).toBe('42501');
        // food_usage only counts how often the person used a food; it is not one of the things that make a food visible
        await db.query('insert into public.food_usage (user_id, food_id) values ($1, $2) on conflict do nothing', [USER_C, hummus]).catch(() => undefined);
      });
      expect(await visibleFoodNames(USER_C)).toEqual(['Carols oats', 'Carols stew']);
    });

    it('a former friend who logged a recipe keeps the food and its portions, but not the recipe rows or the ingredients', async () => {
      const row = await link(USER_A, USER_B);
      await asUser(db, USER_B, () => insertDiary(db, { user_id: USER_B, entry_date: '2026-11-10', food_id: soup, grams: 250 }));
      await db.query('insert into public.food_portions (food_id, label, grams) values ($1, $2, $3)', [soup, '1 bowl', 300]);
      expect(await rows(USER_B, 'select 1 from public.recipe_ingredients where recipe_food_id = $1', [soup])).toHaveLength(1);
      await db.query('delete from public.friendships where id = $1', [row]);
      expect(await visibleFoodNames(USER_B)).toEqual(['Lentil soup']);
      expect(await rows(USER_B, 'select 1 from public.food_portions where food_id = $1', [soup])).toHaveLength(1);
      expect(await rows(USER_B, 'select 1 from public.recipes where food_id = $1', [soup])).toEqual([]);
      expect(await rows(USER_B, 'select 1 from public.recipe_ingredients where recipe_food_id = $1', [soup])).toEqual([]);
    });

    it('ending the friendship hides what you did not use and keeps what you did (diary, recipe ingredient, saved meal, favourite)', async () => {
      const row = await link(USER_A, USER_B);
      await customFood(USER_A, 'Never touched');
      const loggedOnly = await customFood(USER_A, 'Logged');
      const inRecipe = await customFood(USER_A, 'In a recipe');
      const inMeal = await customFood(USER_A, 'In a meal');
      const faved = await customFood(USER_A, 'Faved');
      await asUser(db, USER_B, async () => {
        await insertDiary(db, { user_id: USER_B, entry_date: '2026-11-10', food_id: loggedOnly, grams: 10 });
        await db.query('insert into public.favorites (user_id, food_id) values ($1, $2)', [USER_B, faved]);
        const stew = (await db.query<{ id: string }>(`insert into public.foods (source, kind, owner_id, name) values ('recipe', 'recipe', $1, 'Bobs stew') returning id`, [USER_B])).rows[0]!.id;
        await db.query('insert into public.recipes (food_id, user_id, servings) values ($1, $2, 2)', [stew, USER_B]);
        await db.query('insert into public.recipe_ingredients (recipe_food_id, ingredient_food_id, grams) values ($1, $2, 50)', [stew, inRecipe]);
        const meal = (await db.query<{ id: string }>(`insert into public.saved_meals (user_id, name) values ($1, 'Lunch') returning id`, [USER_B])).rows[0]!.id;
        await db.query('insert into public.saved_meal_items (saved_meal_id, food_id, grams) values ($1, $2, 40)', [meal, inMeal]);
      });
      expect(await visibleFoodNames(USER_B)).toContain('Never touched');

      await asUser(db, USER_A, async () => {
        expect((await db.query('delete from public.friendships where id = $1', [row])).affectedRows).toBe(1);
      });

      const after = await visibleFoodNames(USER_B);
      expect(after).not.toContain('Never touched');
      expect(after).not.toContain('Hummus classic');
      expect(after).not.toContain('Lentil soup');
      expect(after).toEqual(expect.arrayContaining(['Logged', 'In a recipe', 'In a meal', 'Faved', 'Bobs stew']));
      // ...but they can no longer be found by search, and the friend's recipe rows are gone again
      expect(await rows(USER_B, 'select 1 from public.recipes where food_id = $1', [soup])).toEqual([]);
      const found = await rows<{ name: string }>(USER_B, `select name from public.search_foods('logged')`);
      expect(found).toEqual([]);
      // using a food does not widen what a stranger sees
      expect(await visibleFoodNames(USER_C)).toEqual([]);
    });

    it('a used food stops being visible once nothing of yours uses it any more', async () => {
      const row = await link(USER_A, USER_B);
      const entry = await asUser(db, USER_B, () => insertDiary(db, { user_id: USER_B, entry_date: '2026-11-10', food_id: hummus, grams: 30 }));
      await db.query('delete from public.friendships where id = $1', [row]);
      expect(await visibleFoodNames(USER_B)).toContain('Hummus classic');
      await asUser(db, USER_B, () => db.query('delete from public.diary_entries where id = $1', [entry]));
      expect(await visibleFoodNames(USER_B)).not.toContain('Hummus classic');
    });

    it("the owner cannot delete a food a friend has logged (the foreign key holds): the app archives it instead", async () => {
      await link(USER_A, USER_B);
      await asUser(db, USER_B, () => insertDiary(db, { user_id: USER_B, entry_date: '2026-11-10', food_id: hummus, grams: 30 }));
      await asUser(db, USER_A, async () => {
        expect((await expectError(db.query('delete from public.foods where id = $1', [hummus]))).code).toBe('23503');
        expect((await db.query('update public.foods set archived = true where id = $1', [hummus])).affectedRows).toBe(1);
      });
      // an archived food stays visible to the friend who uses it
      expect(await visibleFoodNames(USER_B)).toContain('Hummus classic');
    });

    it('a friend of a friend sees nothing: sharing is between two people only', async () => {
      await link(USER_A, USER_B);
      await link(USER_B, USER_C);
      expect(await visibleFoodNames(USER_C)).toEqual([]);
    });
  });

  describe('search', () => {
    it("finds a friend's custom foods and recipes, ranks them below your own, and never finds a stranger's or an AI estimate", async () => {
      await link(USER_A, USER_B);
      await customFood(USER_A, 'Hummus classic');
      await insertFood(db, { name: 'Hummus soup', source: 'recipe', kind: 'recipe', owner_id: USER_A });
      await insertFood(db, { name: 'Hummus shake', source: 'ai_estimate', kind: 'ai_estimate', owner_id: USER_A });
      await customFood(USER_C, 'Hummus carol');
      await customFood(USER_B, 'Hummus classic');
      const found = await rows<{ name: string; kind: string; rank: number }>(USER_B, `select name, kind, rank from public.search_foods('hummus')`);
      expect(found.map((r) => r.name).sort()).toEqual(['Hummus classic', 'Hummus classic', 'Hummus soup']);
      // equal text match: my own food first, the friend's second
      const classics = found.filter((r) => r.name === 'Hummus classic');
      const mine = (await rows<{ id: string }>(USER_B, `select id from public.foods where owner_id = $1 and name = 'Hummus classic'`, [USER_B]))[0]!.id;
      const ranked = await rows<{ id: string; rank: number }>(USER_B, `select id, rank from public.search_foods('hummus classic')`);
      expect(ranked[0]!.id).toBe(mine);
      expect(ranked[0]!.rank).toBeGreaterThan(ranked[1]!.rank);
      expect(classics).toHaveLength(2);
      // the stranger sees only their own
      expect((await rows<{ name: string }>(USER_C, `select name from public.search_foods('hummus')`)).map((r) => r.name)).toEqual(['Hummus carol']);
    });

    it('stops finding them when the friendship ends, and does not find them while only requested', async () => {
      const row = await link(USER_A, USER_B, 'pending');
      await customFood(USER_A, 'Hummus classic');
      expect(await rows(USER_B, `select 1 from public.search_foods('hummus')`)).toEqual([]);
      await db.query(`update public.friendships set status = 'accepted' where id = $1`, [row]);
      expect(await rows(USER_B, `select 1 from public.search_foods('hummus')`)).toHaveLength(1);
      await db.query('delete from public.friendships where id = $1', [row]);
      expect(await rows(USER_B, `select 1 from public.search_foods('hummus')`)).toEqual([]);
    });

    it('the kinds filter still applies', async () => {
      await link(USER_A, USER_B);
      await customFood(USER_A, 'Hummus classic');
      await insertFood(db, { name: 'Hummus soup', source: 'recipe', kind: 'recipe', owner_id: USER_A });
      const recipes = await rows<{ name: string }>(USER_B, `select name from public.search_foods('hummus', 25, array['recipe'])`);
      expect(recipes.map((r) => r.name)).toEqual(['Hummus soup']);
    });
  });
});
