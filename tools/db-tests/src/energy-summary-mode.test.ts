// Migration 20261110000103_energy_summary_mode.sql: two profile preferences for the energy summary
//   energy_summary_mode ('target' | 'balance', default 'target') and energy_mode_auto_switched_at (timestamptz, default null).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MIGRATIONS_DIR,
  USER_A,
  USER_B,
  applicableMigrationFiles,
  asAnon,
  asUser,
  createDb,
  createUsers,
  expectError,
} from './harness';

const FILE = '20261110000103_energy_summary_mode.sql';
const sql = readFileSync(join(MIGRATIONS_DIR, FILE), 'utf8');

describe('energy summary preferences (migration 20261110000103)', () => {
  describe('on a database that had profiles before the migration', () => {
    let db: PGlite;

    beforeAll(async () => {
      db = await createDb({ migrate: false });
      for (const file of applicableMigrationFiles().filter((f) => f < FILE)) {
        await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      }
      await createUsers(db);
      await db.query(`update public.profiles set energy_mode = 'device_total' where user_id = $1`, [USER_B]);
      await db.exec(sql);
    });
    afterAll(async () => {
      await db.close();
    });

    it('does not exist before, and gives existing rows the defaults without touching anything else', async () => {
      const r = await db.query<Record<string, unknown>>(
        `select user_id, energy_mode, energy_summary_mode, energy_mode_auto_switched_at from public.profiles order by user_id`,
      );
      expect(r.rows).toEqual([
        { user_id: USER_A, energy_mode: 'static', energy_summary_mode: 'target', energy_mode_auto_switched_at: null },
        { user_id: USER_B, energy_mode: 'device_total', energy_summary_mode: 'target', energy_mode_auto_switched_at: null },
      ]);
    });

    it('is idempotent: applying it again changes nothing', async () => {
      await db.query(`update public.profiles set energy_summary_mode = 'balance' where user_id = $1`, [USER_A]);
      await db.exec(sql);
      await db.exec(sql);
      const r = await db.query<{ energy_summary_mode: string }>(
        `select energy_summary_mode from public.profiles where user_id = $1`,
        [USER_A],
      );
      expect(r.rows[0]!.energy_summary_mode).toBe('balance'); // the user's choice survives a re-run
      const cols = await db.query<{ column_name: string; is_nullable: string; column_default: string | null; data_type: string }>(
        `select column_name, is_nullable, column_default, data_type from information_schema.columns
          where table_schema = 'public' and table_name = 'profiles'
            and column_name in ('energy_summary_mode', 'energy_mode_auto_switched_at') order by column_name`,
      );
      expect(cols.rows).toEqual([
        { column_name: 'energy_mode_auto_switched_at', is_nullable: 'YES', column_default: null, data_type: 'timestamp with time zone' },
        { column_name: 'energy_summary_mode', is_nullable: 'NO', column_default: "'target'::text", data_type: 'text' },
      ]);
      const checks = await db.query<{ conname: string }>(
        `select conname from pg_constraint where conrelid = 'public.profiles'::regclass and contype = 'c'
          and pg_get_constraintdef(oid) like '%energy_summary_mode%'`,
      );
      expect(checks.rows).toHaveLength(1);
    });
  });

  describe('with all migrations applied', () => {
    let db: PGlite;

    beforeAll(async () => {
      db = await createDb();
      await createUsers(db);
    });
    afterAll(async () => {
      await db.close();
    });

    it('a new user starts with the Target view and no automatic mode switch', async () => {
      const r = await db.query<Record<string, unknown>>(
        `select energy_summary_mode, energy_mode_auto_switched_at from public.profiles where user_id = $1`,
        [USER_A],
      );
      expect(r.rows).toEqual([{ energy_summary_mode: 'target', energy_mode_auto_switched_at: null }]);
    });

    it('the owner can switch to Balance and back, and record the automatic switch, through RLS', async () => {
      await asUser(db, USER_A, async () => {
        const balance = await db.query<{ energy_summary_mode: string }>(
          `update public.profiles set energy_summary_mode = 'balance' where user_id = $1 returning energy_summary_mode`,
          [USER_A],
        );
        expect(balance.rows).toEqual([{ energy_summary_mode: 'balance' }]);
        const switched = await db.query<{ energy_mode: string; at: boolean }>(
          `update public.profiles set energy_mode = 'device_adjusted', energy_mode_auto_switched_at = now()
            where user_id = $1 returning energy_mode, energy_mode_auto_switched_at is not null as at`,
          [USER_A],
        );
        expect(switched.rows).toEqual([{ energy_mode: 'device_adjusted', at: true }]);
        const back = await db.query<{ energy_summary_mode: string }>(
          `update public.profiles set energy_summary_mode = 'target' where user_id = $1 returning energy_summary_mode`,
          [USER_A],
        );
        expect(back.rows).toEqual([{ energy_summary_mode: 'target' }]);
      });
    });

    it('rejects any other value and a null Target / Balance preference', async () => {
      for (const set of [`energy_summary_mode = 'remaining'`, `energy_summary_mode = ''`, `energy_summary_mode = null`]) {
        const err = await expectError(db.query(`update public.profiles set ${set} where user_id = $1`, [USER_B]));
        expect(err.message, set).toMatch(/violates (check|not-null) constraint/);
      }
    });

    it("cannot be read or written across users, and anon has no access", async () => {
      await asUser(db, USER_B, async () => {
        const other = await db.query(`select energy_summary_mode from public.profiles where user_id = $1`, [USER_A]);
        expect(other.rows).toHaveLength(0);
        const write = await db.query(
          `update public.profiles set energy_summary_mode = 'balance' where user_id = $1 returning 1`,
          [USER_A],
        );
        expect(write.rows).toHaveLength(0);
      });
      const a = await db.query<{ energy_summary_mode: string }>(
        `select energy_summary_mode from public.profiles where user_id = $1`,
        [USER_A],
      );
      expect(a.rows[0]!.energy_summary_mode).toBe('target');
      const err = await asAnon(db, () => expectError(db.query(`select energy_summary_mode from public.profiles`)));
      expect(err.message).toMatch(/permission denied/);
    });
  });
});
