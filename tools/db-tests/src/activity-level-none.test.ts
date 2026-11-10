// Migration 20261110000104_activity_level_none.sql: profiles.activity_level also accepts 'none' (baseline activity 0).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, USER_A, USER_B, applicableMigrationFiles, createDb, createUsers, expectError } from './harness';

const FILE = '20261110000104_activity_level_none.sql';
const sql = readFileSync(join(MIGRATIONS_DIR, FILE), 'utf8');

describe('activity level none (migration 20261110000104)', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createDb({ migrate: false });
    for (const file of applicableMigrationFiles().filter((f) => f < FILE)) {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    }
    await createUsers(db);
    await db.query(`update public.profiles set activity_level = 'light' where user_id = $1`, [USER_B]);
  });
  afterAll(async () => {
    await db.close();
  });

  it("rejects 'none' before the migration", async () => {
    const err = await expectError(db.query(`update public.profiles set activity_level = 'none' where user_id = $1`, [USER_A]));
    expect(err.code).toBe('23514'); // check_violation
  });

  it("accepts 'none' and the four old levels afterwards, still rejects anything else, and keeps existing rows", async () => {
    await db.exec(sql);
    for (const level of ['none', 'sedentary', 'light', 'moderate', 'very']) {
      await db.query(`update public.profiles set activity_level = $2 where user_id = $1`, [USER_A, level]);
      const r = await db.query<{ activity_level: string }>(`select activity_level from public.profiles where user_id = $1`, [USER_A]);
      expect(r.rows[0]!.activity_level).toBe(level);
    }
    const bad = await expectError(db.query(`update public.profiles set activity_level = 'extreme' where user_id = $1`, [USER_A]));
    expect(bad.code).toBe('23514');
    const b = await db.query<{ activity_level: string }>(`select activity_level from public.profiles where user_id = $1`, [USER_B]);
    expect(b.rows[0]!.activity_level).toBe('light'); // untouched by the migration
    await db.query(`update public.profiles set activity_level = null where user_id = $1`, [USER_A]); // unset stays allowed
  });

  it('is idempotent', async () => {
    await db.exec(sql);
    await db.exec(sql);
    await db.query(`update public.profiles set activity_level = 'none' where user_id = $1`, [USER_A]);
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_constraint where conname = 'profiles_activity_level_check' and conrelid = 'public.profiles'::regclass`,
    );
    expect(r.rows[0]!.n).toBe(1);
  });
});
