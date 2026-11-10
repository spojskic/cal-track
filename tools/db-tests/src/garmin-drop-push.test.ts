// Migration 20261110000101_drop_garmin_push.sql: the Garmin PUSH design (migration 13) is removed again, and the pull design
// needs nothing on the server beyond the existing owner-only tables, which already accept source = 'garmin'.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MIGRATIONS_DIR,
  USER_A,
  USER_B,
  applicableMigrationFiles,
  asUser,
  createDb,
  createUsers,
  expectError,
  migrationFiles,
  skippedMigrationFiles,
} from './harness';

const DROP_FILE = '20261110000101_drop_garmin_push.sql';
const PUSH_FILE = '20261110000013_garmin_integration.sql';
const read = (file: string) => readFileSync(join(MIGRATIONS_DIR, file), 'utf8');

const GARMIN_FUNCTIONS = [
  'garmin_connection_status',
  'apply_garmin_health',
  'purge_garmin_data',
  'garmin_oauth_state_create',
  'garmin_oauth_state_consume',
  'garmin_connection_save',
  'garmin_connection_get',
  'garmin_connection_touch',
  'garmin_connection_delete',
  'garmin_push_events_record',
  'garmin_push_events_finish',
];
const GARMIN_TABLES = ['garmin_connections', 'garmin_oauth_states', 'garmin_push_events'];

const garminObjects = async (db: PGlite) => {
  const fns = await db.query<{ nspname: string; proname: string }>(
    `select n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.proname like '%garmin%' order by 1, 2`,
  );
  const tables = await db.query<{ nspname: string; relname: string }>(
    `select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relname like '%garmin%' and c.relkind in ('r', 'i', 'S', 'v') order by 1, 2`,
  );
  return { functions: fns.rows, tables: tables.rows };
};

/** Applies every migration up to (not including) the drop migration, i.e. the database the user has today. */
async function dbBeforeDrop(): Promise<PGlite> {
  const db = await createDb({ migrate: false });
  for (const file of applicableMigrationFiles().filter((f) => f < DROP_FILE)) await db.exec(read(file));
  return db;
}

describe('migration file', () => {
  it('sorts after the invite-code migration (and after the Supabase-only one) and is plain Postgres, not Supabase-only', () => {
    const all = migrationFiles();
    expect(all).toContain(DROP_FILE);
    expect(DROP_FILE > '20261110000100_invite_codes.sql').toBe(true);
    expect(DROP_FILE > skippedMigrationFiles()[0]!).toBe(true);
    // later migrations may follow it (e.g. 20261110000103_energy_summary_mode.sql): it must not be required to be the last one
    expect(all.indexOf(DROP_FILE)).toBeGreaterThan(all.indexOf('20261110000100_invite_codes.sql'));
    expect(DROP_FILE).not.toContain('supabase_only');
    expect(applicableMigrationFiles()).toContain(DROP_FILE);
  });

  it('does not touch the already applied migrations 13 and 90 (they still describe what the real database was given)', () => {
    expect(read(PUSH_FILE)).toContain('create table if not exists private.garmin_connections');
    expect(read(PUSH_FILE)).toContain('public.apply_garmin_health');
    expect(read('20261110000090_pg_cron_supabase_only.sql')).toContain("'purge-garmin-data'");
  });

  it('drops every function and table that migration 13 created (names and signatures read from migration 13)', () => {
    const push = read(PUSH_FILE);
    const drop = read(DROP_FILE).replace(/\s+/g, ' ').toLowerCase();
    const created = [...push.matchAll(/create or replace function ([a-z_.]+)\(([^)]*)\)/g)].map((m) => m[1]!);
    expect(created.sort()).toEqual(
      [...GARMIN_FUNCTIONS.map((f) => `public.${f}`), 'private.garmin_connection_status'].sort(),
    );
    for (const fn of created) expect(drop, fn).toContain(`drop function if exists ${fn}(`);
    const tables = [...push.matchAll(/create table if not exists (private\.[a-z_]+)/g)].map((m) => m[1]!);
    expect(tables.sort()).toEqual(GARMIN_TABLES.map((t) => `private.${t}`).sort());
    for (const t of tables) expect(drop, t).toContain(`drop table if exists ${t};`);
    expect(drop).toContain("cron.unschedule('purge-garmin-data')");
    expect(drop).toContain("to_regclass('cron.job')");
  });
});

describe('what the migration removes', () => {
  let before: PGlite;
  let after: PGlite;

  beforeAll(async () => {
    before = await dbBeforeDrop();
    after = await createDb();
  });
  afterAll(async () => {
    await before.close();
    await after.close();
  });

  it('the database before it has the push objects (so the test below proves something)', async () => {
    const { functions, tables } = await garminObjects(before);
    expect(functions.map((f) => f.proname).sort()).toEqual(
      [...GARMIN_FUNCTIONS, 'garmin_connection_status'].sort(),
    );
    expect(tables.filter((t) => t.relname.startsWith('garmin_connections')).length).toBeGreaterThan(0);
  });

  it('afterwards no Garmin function, table, index or sequence is left, in public or private', async () => {
    await before.exec(read(DROP_FILE));
    expect(await garminObjects(before)).toEqual({ functions: [], tables: [] });
    expect(await garminObjects(after)).toEqual({ functions: [], tables: [] });
  });

  it('keeps the private schema and its other tables (rate limiter, invite codes)', async () => {
    const r = await after.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'private' and c.relkind = 'r' order by 1`,
    );
    expect(r.rows.map((x) => x.relname)).toEqual(['edge_rate_limits', 'invite_codes']);
  });

  it('is idempotent: applying it again (and again) is a no-op', async () => {
    await after.exec(read(DROP_FILE));
    await after.exec(read(DROP_FILE));
    expect(await garminObjects(after)).toEqual({ functions: [], tables: [] });
  });

  it('also works on a database where migration 13 never ran', async () => {
    const bare = await createDb({ migrate: false });
    for (const file of applicableMigrationFiles().filter((f) => f < DROP_FILE && f !== PUSH_FILE)) await bare.exec(read(file));
    await bare.exec(read(DROP_FILE));
    expect(await garminObjects(bare)).toEqual({ functions: [], tables: [] });
    await bare.close();
  });

  it('leaves the rows the push design may have imported (the user\'s own data) untouched', async () => {
    const db = await dbBeforeDrop();
    await createUsers(db);
    await db.query(`insert into public.daily_energy (user_id, local_date, source, steps) values ($1, '2026-11-10', 'garmin', 5000)`, [USER_A]);
    await db.query(`insert into public.integrations (user_id, provider) values ($1, 'garmin')`, [USER_A]);
    await db.exec(read(DROP_FILE));
    const r = await db.query<{ n: number }>(`select count(*)::int as n from public.daily_energy where source = 'garmin'`);
    expect(r.rows[0]!.n).toBe(1);
    const i = await db.query<{ n: number }>(`select count(*)::int as n from public.integrations where provider = 'garmin'`);
    expect(i.rows[0]!.n).toBe(1);
    await db.close();
  });
});

describe('the pg_cron guard', () => {
  it('is a no-op without pg_cron (no cron schema): the plain-Postgres harness applies it', async () => {
    const db = await createDb({ migrate: false });
    expect((await db.query(`select to_regclass('cron.job') as t`)).rows[0]).toEqual({ t: null });
    for (const file of applicableMigrationFiles()) await db.exec(read(file));
    await db.close();
  });

  /** A minimal stand-in for pg_cron: cron.job and cron.unschedule(), which (like the real one) raises for an unknown job. */
  const FAKE_CRON = /* sql */ `
    create schema cron;
    create table cron.job (jobid serial primary key, jobname text unique, command text);
    create function cron.unschedule(job_name text) returns boolean language plpgsql as $$
    begin
      if not exists (select 1 from cron.job where jobname = job_name) then
        raise exception 'could not find valid entry for job %', job_name;
      end if;
      delete from cron.job where jobname = job_name;
      return true;
    end $$;
  `;

  it('unschedules the purge-garmin-data job and leaves the other jobs alone', async () => {
    const db = await dbBeforeDrop();
    await db.exec(FAKE_CRON);
    await db.exec(
      `insert into cron.job (jobname, command) values
         ('purge-old-coach-messages', 'select public.purge_old_coach_messages()'),
         ('purge-garmin-data', 'select public.purge_garmin_data()')`,
    );
    await db.exec(read(DROP_FILE));
    const jobs = await db.query<{ jobname: string }>(`select jobname from cron.job order by 1`);
    expect(jobs.rows.map((j) => j.jobname)).toEqual(['purge-old-coach-messages']);
    // second run: the job is gone, and cron.unschedule would raise for it, so the guard must skip the call
    await db.exec(read(DROP_FILE));
    expect((await db.query(`select 1 from cron.job`)).rows).toHaveLength(1);
    await db.close();
  });

  it('is fine when pg_cron exists but the job was never scheduled', async () => {
    const db = await dbBeforeDrop();
    await db.exec(FAKE_CRON);
    await db.exec(read(DROP_FILE));
    await db.close();
  });
});

describe('source = garmin works for the pull sync (owner-only tables, no server code)', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createDb();
    await createUsers(db);
  });
  afterAll(async () => {
    await db.close();
  });

  const write = (userId: string, sql: string, params: unknown[]) => asUser(db, userId, () => db.query(sql, params));

  it('accepts a garmin integration row with flags and a summary, and refuses unknown providers', async () => {
    await write(
      USER_A,
      `insert into public.integrations (user_id, provider, enabled, settings, last_sync_at)
       values ($1, 'garmin', true, '{"connected_at":"2026-11-10T08:00:00Z","needs_sign_in":false,"last_summary":"14 days of energy"}', now())
       on conflict (user_id, provider) do update set settings = excluded.settings`,
      [USER_A],
    );
    const bad = await asUser(db, USER_A, () =>
      expectError(db.query(`insert into public.integrations (user_id, provider) values ($1, 'garmin_push')`, [USER_A])),
    );
    expect(bad.message).toMatch(/violates check constraint/);
  });

  it('daily energy of a day is replaced by the latest values, never added (cumulative counters)', async () => {
    const upsert = (active: number, resting: number, steps: number) =>
      write(
        USER_A,
        `insert into public.daily_energy (user_id, local_date, source, active_kcal, resting_kcal, steps)
         values ($1, '2026-11-10', 'garmin', $2, $3, $4)
         on conflict (user_id, local_date, source) do update
           set active_kcal = excluded.active_kcal, resting_kcal = excluded.resting_kcal, steps = excluded.steps`,
        [USER_A, active, resting, steps],
      );
    await upsert(120, 801, 2400); // midday
    await upsert(612, 2038, 9876); // evening
    const r = await db.query<{ active_kcal: string; resting_kcal: string; steps: number }>(
      `select active_kcal, resting_kcal, steps from public.daily_energy where user_id = $1 and source = 'garmin' and local_date = '2026-11-10'`,
      [USER_A],
    );
    expect(r.rows).toEqual([{ active_kcal: '612', resting_kcal: '2038', steps: 9876 }]);
  });

  it('workouts and biometrics are unique per (user, source, external_id): a re-sync updates, not duplicates', async () => {
    const workout = (kcal: number) =>
      write(
        USER_A,
        `insert into public.exercise_entries (user_id, entry_date, name, minutes, kcal, source, external_id, started_at, ended_at, counts_toward_energy)
         values ($1, '2026-11-09', 'Run', 30, $2, 'garmin', 'garmin:activity:1', '2026-11-09T06:30:00Z', '2026-11-09T07:00:00Z', false)
         on conflict (user_id, source, external_id) where external_id is not null do update set kcal = excluded.kcal`,
        [USER_A, kcal],
      );
    await workout(300);
    await workout(412);
    const w = await db.query<{ kcal: string; counts_toward_energy: boolean }>(
      `select kcal, counts_toward_energy from public.exercise_entries where user_id = $1 and source = 'garmin'`,
      [USER_A],
    );
    expect(w.rows).toEqual([{ kcal: '412', counts_toward_energy: false }]);

    const weight = (value: number) =>
      write(
        USER_A,
        `insert into public.biometrics (user_id, entry_date, type, value, unit, source, external_id, recorded_at, meta)
         values ($1, '2026-11-09', 'weight', $2, 'kg', 'garmin', 'garmin:weight:1700000001', now(), '{"bmi": 24.6}')
         on conflict (user_id, source, external_id) where external_id is not null do update set value = excluded.value`,
        [USER_A, value],
      );
    await weight(81.5);
    await weight(81.2);
    const b = await db.query<{ value: string }>(`select value from public.biometrics where user_id = $1 and source = 'garmin'`, [USER_A]);
    expect(b.rows).toEqual([{ value: '81.2' }]);
  });

  it('every biometric type the Garmin sync writes is accepted (type is free text, unit is text)', async () => {
    const types: Array<[string, string]> = [
      ['resting_heart_rate', 'bpm'],
      ['stress', 'score'],
      ['body_battery', 'percent'],
      ['sleep', 'hr'],
      ['sleep_score', 'score'],
      ['hrv', 'ms'],
      ['spo2', 'percent'],
      ['respiration_rate', 'brpm'],
      ['body_fat', 'percent'],
    ];
    for (const [type, unit] of types) {
      await write(
        USER_A,
        `insert into public.biometrics (user_id, entry_date, type, value, unit, source, external_id)
         values ($1, '2026-11-09', $2, 50, $3, 'garmin', $4)`,
        [USER_A, type, unit, `garmin:${type}:2026-11-09`],
      );
    }
  });

  it('"Sign out > delete imported data" is a client delete by source: it removes only the caller\'s garmin rows', async () => {
    await write(USER_B, `insert into public.daily_energy (user_id, local_date, source, steps) values ($1, '2026-11-10', 'garmin', 4000)`, [USER_B]);
    await write(USER_B, `insert into public.daily_energy (user_id, local_date, source, steps) values ($1, '2026-11-10', 'apple_health', 7000)`, [USER_B]);
    await write(USER_A, `insert into public.daily_energy (user_id, local_date, source, steps) values ($1, '2026-11-10', 'apple_health', 6500)`, [USER_A]);

    await asUser(db, USER_A, async () => {
      for (const table of ['daily_energy', 'exercise_entries', 'biometrics']) {
        await db.query(`delete from public.${table} where source = 'garmin'`);
      }
    });

    const left = await db.query<{ user_id: string; source: string }>(
      `select user_id, source from public.daily_energy order by user_id, source`,
    );
    expect(left.rows).toEqual([
      { user_id: USER_A, source: 'apple_health' },
      { user_id: USER_B, source: 'apple_health' },
      { user_id: USER_B, source: 'garmin' },
    ]);
    for (const table of ['exercise_entries', 'biometrics']) {
      const r = await db.query<{ n: number }>(`select count(*)::int as n from public.${table} where source = 'garmin' and user_id = $1`, [USER_A]);
      expect(r.rows[0]!.n, table).toBe(0);
    }
    // the integration row and the other sources stay
    expect((await db.query(`select 1 from public.integrations where user_id = $1 and provider = 'garmin'`, [USER_A])).rows).toHaveLength(1);
  });
});
