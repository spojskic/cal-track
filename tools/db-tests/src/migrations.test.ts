import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MIGRATIONS_DIR,
  applicableMigrationFiles,
  applyMigrations,
  asAnon,
  asUser,
  createDb,
  createUsers,
  expectError,
  migrationFiles,
  skippedMigrationFiles,
  USER_A,
} from './harness';

describe('migrations', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createDb({ migrate: false });
  });
  afterAll(async () => {
    await db.close();
  });

  it('discovers the migration files, with the supabase-only one last and skipped', () => {
    const all = migrationFiles();
    expect(all.length).toBeGreaterThanOrEqual(10);
    expect(all).toEqual([...all].sort());
    const skipped = skippedMigrationFiles();
    expect(skipped).toHaveLength(1);
    expect(all[all.length - 1]).toBe(skipped[0]);
    expect(applicableMigrationFiles()).not.toContain(skipped[0]);
  });

  it('applies all non-Supabase migrations cleanly', async () => {
    await applyMigrations(db);
    const r = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' order by 1`,
    );
    expect(r.rows.map((x) => x.relname)).toEqual(
      [
        'app_settings',
        'biometrics',
        'coach_messages',
        'coach_threads',
        'daily_energy',
        'daily_totals',
        'diary_entries',
        'dri_values',
        'exercise_activities',
        'exercise_entries',
        'fasts',
        'favorites',
        'food_portions',
        'food_usage',
        'foods',
        'integrations',
        'macro_targets',
        'meal_groups',
        'notes',
        'nutrient_targets',
        'nutrients',
        'profiles',
        'recipe_ingredients',
        'recipes',
        'saved_meal_items',
        'saved_meals',
        'water_entries',
        'weight_goals',
      ].sort(),
    );
  });

  it('is idempotent: applying every migration a second (and third) time succeeds', async () => {
    await createUsers(db); // existing users must survive the profile/meal-group backfill
    await applyMigrations(db);
    await applyMigrations(db);
    const r = await db.query<{ profiles: number; groups: number }>(
      `select (select count(*)::int from public.profiles) as profiles,
              (select count(*)::int from public.meal_groups) as groups`,
    );
    expect(r.rows[0]).toEqual({ profiles: 2, groups: 8 });
    const seed = await db.query<{ value: number }>(
      `select value::int as value from public.app_settings where key = 'coach_retention_days'`,
    );
    expect(seed.rows).toEqual([{ value: 90 }]);
  });

  it('the supabase-only migration guards pg_cron and is not executed here', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, skippedMigrationFiles()[0]!), 'utf8');
    expect(sql).toMatch(/pg_available_extensions/);
    expect(sql).toMatch(/cron\.schedule/);
    expect(sql).toMatch(/purge_old_coach_messages/);
    expect(sql).toMatch(/0 3 \* \* \*/);
  });

  it('enables RLS on every public table', async () => {
    const r = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
       order by 1`,
    );
    expect(r.rows).toEqual([]);
  });

  it('gives every SECURITY DEFINER function a fixed search_path', async () => {
    const r = await db.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private') and p.prosecdef
         and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`,
    );
    expect(r.rows).toEqual([]);
  });

  it('has an owner policy (user_id) on every user-owned table', async () => {
    const r = await db.query<{ table_name: string }>(
      `select c.table_name from information_schema.columns c
       where c.table_schema = 'public' and c.column_name = 'user_id'
         and not exists (select 1 from pg_policies p
                         where p.schemaname = 'public' and p.tablename = c.table_name
                           and p.roles = '{authenticated}')
       order by 1`,
    );
    expect(r.rows).toEqual([]);
  });

  it('anon has no privileges on any public table or client RPC', async () => {
    const tables = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' order by 1`,
    );
    await asAnon(db, async () => {
      for (const { relname } of tables.rows) {
        const err = await expectError(db.query(`select 1 from public.${relname} limit 1`));
        expect(err.message, relname).toMatch(/permission denied/);
      }
      for (const fn of ['search_foods($1)', 'get_food_by_gtin($1)']) {
        const err = await expectError(db.query(`select * from public.${fn}`, ['x']));
        expect(err.message, fn).toMatch(/permission denied/);
      }
    });
  });

  it('search_foods is SECURITY INVOKER; only the private ranking helper is SECURITY DEFINER', async () => {
    const r = await db.query<{ nspname: string; proname: string; prosecdef: boolean }>(
      `select n.nspname, p.proname, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where p.proname in ('search_foods', 'search_foods_ranked', 'get_food_by_gtin', 'delete_all_my_coach_data', 'supersede_food')
       order by 1, 2`,
    );
    expect(r.rows).toEqual([
      { nspname: 'private', proname: 'search_foods_ranked', prosecdef: true },
      { nspname: 'public', proname: 'delete_all_my_coach_data', prosecdef: false },
      { nspname: 'public', proname: 'get_food_by_gtin', prosecdef: false },
      { nspname: 'public', proname: 'search_foods', prosecdef: false },
      { nspname: 'public', proname: 'supersede_food', prosecdef: false },
    ]);
  });

  it('the private schema is closed to anon, and the Data API exposes only `public`', async () => {
    const err = await asAnon(db, () =>
      expectError(db.query(`select * from private.search_foods_ranked('x')`)),
    );
    expect(err.message).toMatch(/permission denied/);
    const toml = readFileSync(join(MIGRATIONS_DIR, '../config.toml'), 'utf8');
    expect(toml).toMatch(/^schemas\s*=\s*\["public"\]/m);
  });

  it('search GIN indexes use fastupdate = off (no pending-list scan penalty)', async () => {
    const r = await db.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes
       where schemaname = 'public' and indexname in ('foods_search_gin_idx', 'foods_search_text_trgm_idx') order by 1`,
    );
    expect(r.rows).toHaveLength(2);
    for (const i of r.rows)
      expect(i.indexdef, i.indexname).toMatch(/USING gin .*fastupdate='?off'?/i);
  });

  it('keeps SECURITY DEFINER internals away from clients', async () => {
    await asUser(db, USER_A, async () => {
      for (const sql of [
        `select public.purge_old_coach_messages()`,
        `select public.recompute_daily_totals(auth.uid(), current_date)`,
        `select public.handle_new_user()`,
      ]) {
        const err = await expectError(db.query(sql));
        expect(err.message, sql).toMatch(/permission denied/);
      }
    });
  });
});
