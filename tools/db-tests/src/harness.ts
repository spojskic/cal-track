import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';

const here = dirname(fileURLToPath(import.meta.url));

/** supabase/migrations, relative to this file (tools/db-tests/src). */
export const MIGRATIONS_DIR = resolve(here, '../../../supabase/migrations');

/**
 * Migrations whose file name contains this marker need real Supabase
 * (pg_cron, vault, ...) and are skipped by the harness.
 */
export const SUPABASE_ONLY_MARKER = 'supabase_only';

/** Stable UUIDs for the fixture users. */
export const USER_A = '00000000-0000-4000-8000-00000000000a';
export const USER_B = '00000000-0000-4000-8000-00000000000b';
export const USER_C = '00000000-0000-4000-8000-00000000000c';

/**
 * What a hosted Supabase project provides before the first migration runs:
 * the API roles, the `auth` schema (users table + auth.uid()), the `extensions`
 * schema, and Supabase's default privileges (every new object in `public` is
 * handed to anon / authenticated / service_role - our grants migration then
 * tightens that, which these tests verify).
 */
export const SUPABASE_STUBS_SQL = /* sql */ `
  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;

  create schema if not exists extensions;
  create schema if not exists auth;

  create table auth.users (
    id    uuid primary key default gen_random_uuid(),
    email text
  );

  create function auth.uid() returns uuid
    language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

  grant usage on schema public, extensions, auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;

  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

/** Migration file names (sorted) that the harness applies. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{14}_.+\.sql$/.test(f))
    .sort();
}

export function applicableMigrationFiles(): string[] {
  return migrationFiles().filter((f) => !f.includes(SUPABASE_ONLY_MARKER));
}

export function skippedMigrationFiles(): string[] {
  return migrationFiles().filter((f) => f.includes(SUPABASE_ONLY_MARKER));
}

export async function applyMigrations(db: PGlite): Promise<void> {
  for (const file of applicableMigrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await db.exec(sql);
    } catch (err) {
      throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
    }
  }
}

export interface CreateDbOptions {
  /** Apply the migrations (default true). */
  migrate?: boolean;
}

/** Fresh in-memory Postgres with Supabase stubs (+ migrations). */
export async function createDb(opts: CreateDbOptions = {}): Promise<PGlite> {
  const db = new PGlite({ extensions: { unaccent, pg_trgm } });
  await db.waitReady;
  await db.exec(SUPABASE_STUBS_SQL);
  if (opts.migrate ?? true) await applyMigrations(db);
  return db;
}

/** Create auth users (fires handle_new_user). */
export async function createUsers(
  db: PGlite,
  users: Array<{ id: string; email: string }> = [
    { id: USER_A, email: 'alice@example.com' },
    { id: USER_B, email: 'bob@example.com' },
  ],
): Promise<void> {
  for (const u of users) {
    await db.query('insert into auth.users (id, email) values ($1, $2)', [u.id, u.email]);
  }
}

export type ApiRole = 'anon' | 'authenticated' | 'service_role';

/**
 * Run `fn` the way PostgREST would: `set role <role>` plus the JWT `sub` claim.
 * Always restores the superuser session afterwards.
 */
export async function withRole<T>(
  db: PGlite,
  role: ApiRole,
  userId: string | null,
  fn: (db: PGlite) => Promise<T>,
): Promise<T> {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId ?? '']);
  await db.exec(`set role ${role}`);
  try {
    return await fn(db);
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
  }
}

export const asUser = <T>(db: PGlite, userId: string, fn: (db: PGlite) => Promise<T>) =>
  withRole(db, 'authenticated', userId, fn);

export const asAnon = <T>(db: PGlite, fn: (db: PGlite) => Promise<T>) =>
  withRole(db, 'anon', null, fn);

export const asService = <T>(db: PGlite, fn: (db: PGlite) => Promise<T>) =>
  withRole(db, 'service_role', null, fn);

export interface FoodInput {
  name: string;
  source?: string;
  source_id?: string | null;
  kind?: string;
  owner_id?: string | null;
  brand?: string | null;
  gtin14?: string | null;
  category?: string | null;
  nutrients?: Record<string, number>;
  completeness?: number | null;
  carb_basis?: string;
  density_g_per_ml?: number | null;
  popularity?: number;
  archived?: boolean;
}

/**
 * Insert a food (as the current role) and return its id. Defaults to a global
 * generic Foundation food.
 */
export async function insertFood(db: PGlite, f: FoodInput): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into public.foods
       (source, source_id, kind, owner_id, name, brand, gtin14, category, nutrients,
        completeness, carb_basis, density_g_per_ml, popularity, archived)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14)
     returning id`,
    [
      f.source ?? 'fdc_foundation',
      f.source_id ?? null,
      f.kind ?? 'generic',
      f.owner_id ?? null,
      f.name,
      f.brand ?? null,
      f.gtin14 ?? null,
      f.category ?? null,
      JSON.stringify(f.nutrients ?? {}),
      f.completeness ?? null,
      f.carb_basis ?? 'includes_fiber',
      f.density_g_per_ml ?? null,
      f.popularity ?? 0,
      f.archived ?? false,
    ],
  );
  return r.rows[0]!.id;
}

/** Insert a diary entry (as the current role) and return its id. */
export async function insertDiary(
  db: PGlite,
  e: {
    user_id: string;
    entry_date: string;
    food_id: string;
    grams: number;
    meal_group_id?: string | null;
  },
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into public.diary_entries (user_id, entry_date, food_id, grams, meal_group_id)
     values ($1, $2, $3, $4, $5) returning id`,
    [e.user_id, e.entry_date, e.food_id, e.grams, e.meal_group_id ?? null],
  );
  return r.rows[0]!.id;
}

/** Run a query expected to fail and return the Postgres error. */
export async function expectError(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await promise;
  } catch (err) {
    return err as Error & { code?: string };
  }
  throw new Error('expected the statement to fail, but it succeeded');
}
