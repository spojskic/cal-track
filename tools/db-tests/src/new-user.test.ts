import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USER_A, USER_B, USER_C, asUser, createDb, expectError } from './harness';

describe('handle_new_user', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it('creates a profile with sane defaults and the four default meal groups', async () => {
    await db.query(`insert into auth.users (id, email) values ($1, 'alice@example.com')`, [USER_A]);

    const p = await db.query<Record<string, unknown>>(
      `select * from public.profiles where user_id = $1`,
      [USER_A],
    );
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({
      user_id: USER_A,
      display_name: 'alice',
      unit_system: 'metric',
      timezone: 'UTC',
      bmr_formula: 'mifflin',
      bmr_override: null,
      tef_enabled: true,
      energy_mode: 'static',
      net_carbs: true,
      pregnant: false,
      lactating: false,
      coach_auto_delete: true,
      onboarded: false,
      sex: null,
      birthdate: null,
      height_cm: null,
      activity_level: null,
    });

    const g = await db.query<{ name: string; sort_order: number; hidden: boolean }>(
      `select name, sort_order, hidden from public.meal_groups where user_id = $1 order by sort_order`,
      [USER_A],
    );
    expect(g.rows).toEqual([
      { name: 'Breakfast', sort_order: 0, hidden: false },
      { name: 'Lunch', sort_order: 10, hidden: false },
      { name: 'Dinner', sort_order: 20, hidden: false },
      { name: 'Snacks', sort_order: 30, hidden: false },
    ]);
  });

  it('gives every user their own profile and groups, even without an email', async () => {
    await db.query(
      `insert into auth.users (id, email) values ($1, 'bob@example.com'), ($2, null)`,
      [USER_B, USER_C],
    );
    const r = await db.query<{ user_id: string; groups: number; display_name: string | null }>(
      `select p.user_id, p.display_name, (select count(*)::int from public.meal_groups m where m.user_id = p.user_id) as groups
         from public.profiles p order by p.user_id`,
    );
    expect(r.rows).toEqual([
      { user_id: USER_A, display_name: 'alice', groups: 4 },
      { user_id: USER_B, display_name: 'bob', groups: 4 },
      { user_id: USER_C, display_name: null, groups: 4 },
    ]);
    const total = await db.query<{ n: number }>(
      `select count(*)::int as n from public.meal_groups`,
    );
    expect(total.rows[0]!.n).toBe(12);
  });

  it('is visible to (and editable by) the new user through RLS', async () => {
    await asUser(db, USER_A, async () => {
      const own = await db.query<{ n: number }>(`select count(*)::int as n from public.profiles`);
      expect(own.rows[0]!.n).toBe(1);
      const up = await db.query<{ unit_system: string; onboarded: boolean }>(
        `update public.profiles set unit_system = 'imperial', onboarded = true, timezone = 'Europe/Sarajevo'
          where user_id = $1 returning unit_system, onboarded`,
        [USER_A],
      );
      expect(up.rows).toEqual([{ unit_system: 'imperial', onboarded: true }]);
      const hide = await db.query(
        `update public.meal_groups set hidden = true where name = 'Snacks' returning 1`,
      );
      expect(hide.rows).toHaveLength(1);
    });
  });

  it('bumps profiles.updated_at on update', async () => {
    const before = await db.query<{ ok: boolean }>(
      `select updated_at <= now() as ok from public.profiles where user_id = $1`,
      [USER_B],
    );
    expect(before.rows[0]!.ok).toBe(true);
    await db.query(
      `update public.profiles set updated_at = now() - interval '1 day' where user_id = $1`,
      [USER_B],
    );
    await db.query(`update public.profiles set display_name = 'Bobby' where user_id = $1`, [
      USER_B,
    ]);
    const after = await db.query<{ fresh: boolean }>(
      `select updated_at > now() - interval '1 minute' as fresh from public.profiles where user_id = $1`,
      [USER_B],
    );
    expect(after.rows[0]!.fresh).toBe(true);
  });

  it('enforces profile enums', async () => {
    for (const set of [
      `unit_system = 'stones'`,
      `energy_mode = 'magic'`,
      `bmr_formula = 'guess'`,
      `activity_level = 'extreme'`,
      `sex = 'robot'`,
    ]) {
      const err = await expectError(
        db.query(`update public.profiles set ${set} where user_id = $1`, [USER_B]),
      );
      expect(err.message, set).toMatch(/violates check constraint/);
    }
  });

  it('cannot be invoked directly by clients', async () => {
    const err = await asUser(db, USER_A, () =>
      expectError(db.query(`select public.handle_new_user()`)),
    );
    expect(err.message).toMatch(/permission denied/);
  });

  it('removes profile and meal groups when the auth user is deleted', async () => {
    await db.query(`delete from auth.users where id = $1`, [USER_C]);
    const r = await db.query<{ p: number; g: number }>(
      `select (select count(*)::int from public.profiles where user_id = $1) as p,
              (select count(*)::int from public.meal_groups where user_id = $1) as g`,
      [USER_C],
    );
    expect(r.rows[0]).toEqual({ p: 0, g: 0 });
  });

  it('deleting a meal group un-assigns diary entries instead of deleting them', async () => {
    await db.query(
      `insert into public.foods (source, kind, name) values ('cnf', 'generic', 'Bread')`,
    );
    const food = (await db.query<{ id: string }>(`select id from public.foods limit 1`)).rows[0]!
      .id;
    const group = (
      await db.query<{ id: string }>(
        `select id from public.meal_groups where user_id = $1 and name = 'Lunch'`,
        [USER_B],
      )
    ).rows[0]!.id;
    await db.query(
      `insert into public.diary_entries (user_id, entry_date, food_id, grams, meal_group_id) values ($1, '2026-11-10', $2, 80, $3)`,
      [USER_B, food, group],
    );
    await db.query(`delete from public.meal_groups where id = $1`, [group]);
    const r = await db.query<{ meal_group_id: string | null; user_id: string }>(
      `select meal_group_id, user_id from public.diary_entries where user_id = $1`,
      [USER_B],
    );
    expect(r.rows).toEqual([{ meal_group_id: null, user_id: USER_B }]);
  });
});
