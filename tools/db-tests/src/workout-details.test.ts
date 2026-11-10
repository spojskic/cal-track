// Migration 20261110000105_workout_details.sql: exercise_entries.details (jsonb, nullable) holds what a device knows about a workout
// (heart rate, zones, sets, ...). Owner-only like the rest of the table, small, always an object, and a sync never clears it.
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
  asService,
  asUser,
  createDb,
  createUsers,
  expectError,
} from './harness';

const FILE = '20261110000105_workout_details.sql';
const sql = readFileSync(join(MIGRATIONS_DIR, FILE), 'utf8');

const DETAILS = {
  v: 1,
  source: 'garmin',
  level: 'full',
  fetchedAt: '2026-11-10T09:12:44.000Z',
  typeKey: 'strength_training',
  avgHr: 128,
  maxHr: 171,
  hrZones: [{ zone: 1, seconds: 300, lowBpm: 95 }],
  trainingEffect: { aerobic: 3.1, anaerobic: 1.2 },
  sets: [{ exercise: 'Bench press', guess: true, reps: 8, weightKg: 60, durationSec: 31, restSec: 90 }],
};

async function insertWorkout(db: PGlite, userId: string, externalId: string | null, details: unknown = null): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into public.exercise_entries (user_id, entry_date, name, minutes, kcal, source, external_id, counts_toward_energy, details)
     values ($1, '2026-11-09', 'Strength', 50, 245, $2, $3, false, $4::jsonb) returning id`,
    [userId, externalId ? 'garmin' : 'manual', externalId, details === null ? null : JSON.stringify(details)],
  );
  return r.rows[0]!.id;
}

describe('workout details (migration 20261110000105)', () => {
  describe('on a database that had workouts before the migration', () => {
    let db: PGlite;

    beforeAll(async () => {
      db = await createDb({ migrate: false });
      for (const file of applicableMigrationFiles().filter((f) => f < FILE)) {
        await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      }
      await createUsers(db);
      await db.query(
        `insert into public.exercise_entries (user_id, entry_date, name, minutes, kcal, source, external_id, counts_toward_energy)
         values ($1, '2026-11-08', 'Run', 30, 300, 'manual', null, true),
                ($1, '2026-11-09', 'Strength', 50, 245, 'garmin', 'garmin:activity:1', false)`,
        [USER_A],
      );
      await db.exec(sql);
    });
    afterAll(async () => {
      await db.close();
    });

    it('adds a nullable jsonb column and leaves every existing row as it was', async () => {
      const cols = await db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
        `select column_name, data_type, is_nullable, column_default from information_schema.columns
          where table_schema = 'public' and table_name = 'exercise_entries' and column_name = 'details'`,
      );
      expect(cols.rows).toEqual([{ column_name: 'details', data_type: 'jsonb', is_nullable: 'YES', column_default: null }]);
      const rows = await db.query<Record<string, unknown>>(
        `select name, kcal::int as kcal, source, external_id, counts_toward_energy, details from public.exercise_entries order by entry_date`,
      );
      expect(rows.rows).toEqual([
        { name: 'Run', kcal: 300, source: 'manual', external_id: null, counts_toward_energy: true, details: null },
        { name: 'Strength', kcal: 245, source: 'garmin', external_id: 'garmin:activity:1', counts_toward_energy: false, details: null },
      ]);
    });

    it('is idempotent: applying it again changes nothing, the stored details survive', async () => {
      await db.query(`update public.exercise_entries set details = $1::jsonb where external_id = 'garmin:activity:1'`, [JSON.stringify(DETAILS)]);
      await db.exec(sql);
      await db.exec(sql);
      const r = await db.query<{ details: unknown }>(`select details from public.exercise_entries where external_id = 'garmin:activity:1'`);
      expect(r.rows[0]!.details).toEqual(DETAILS);
      const cols = await db.query(`select 1 from information_schema.columns where table_name = 'exercise_entries' and column_name = 'details'`);
      expect(cols.rows).toHaveLength(1);
      const checks = await db.query<{ conname: string }>(
        `select conname from pg_constraint where conrelid = 'public.exercise_entries'::regclass and contype = 'c'
            and pg_get_constraintdef(oid) like '%details%' order by conname`,
      );
      expect(checks.rows.map((c) => c.conname)).toEqual(['exercise_entries_details_object_check', 'exercise_entries_details_size_check']);
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

    it('the owner writes and reads the details of a workout through RLS, like any other column', async () => {
      const id = await asUser(db, USER_A, () => insertWorkout(db, USER_A, 'garmin:activity:10', DETAILS));
      const read = await asUser(db, USER_A, () =>
        db.query<{ details: typeof DETAILS; hr: string }>(
          `select details, details->>'avgHr' as hr from public.exercise_entries where id = $1`,
          [id],
        ),
      );
      expect(read.rows[0]!.details).toEqual(DETAILS);
      expect(read.rows[0]!.hr).toBe('128');
      // the list screens select single keys instead of the whole object
      const key = await asUser(db, USER_A, () =>
        db.query<{ avg_hr: number }>(`select (details->'avgHr') as avg_hr from public.exercise_entries where id = $1`, [id]),
      );
      expect(key.rows[0]!.avg_hr).toBe(128);

      const update = await asUser(db, USER_A, () =>
        db.query<{ details: { avgHr: number } }>(
          `update public.exercise_entries set details = $2::jsonb where id = $1 returning details`,
          [id, JSON.stringify({ ...DETAILS, avgHr: 131 })],
        ),
      );
      expect(update.rows[0]!.details.avgHr).toBe(131);
    });

    it('can clear the details again (set back to null)', async () => {
      const id = await asUser(db, USER_A, () => insertWorkout(db, USER_A, 'garmin:activity:11', DETAILS));
      await asUser(db, USER_A, () => db.query(`update public.exercise_entries set details = null where id = $1`, [id]));
      const r = await db.query<{ details: unknown }>(`select details from public.exercise_entries where id = $1`, [id]);
      expect(r.rows[0]!.details).toBeNull();
    });

    it('another user cannot read or change them, and anon has no access', async () => {
      const id = await asUser(db, USER_A, () => insertWorkout(db, USER_A, 'garmin:activity:12', DETAILS));
      await asUser(db, USER_B, async () => {
        const read = await db.query(`select details from public.exercise_entries where id = $1`, [id]);
        expect(read.rows).toHaveLength(0);
        const write = await db.query(`update public.exercise_entries set details = '{"v":1}'::jsonb where id = $1 returning id`, [id]);
        expect(write.rows).toHaveLength(0);
        const forged = await expectError(insertWorkout(db, USER_A, 'garmin:activity:13', DETAILS));
        expect(forged.message).toMatch(/row-level security/);
      });
      const still = await db.query<{ details: unknown }>(`select details from public.exercise_entries where id = $1`, [id]);
      expect(still.rows[0]!.details).toEqual(DETAILS);
      const anon = await asAnon(db, () => expectError(db.query(`select details from public.exercise_entries`)));
      expect(anon.message).toMatch(/permission denied/);
    });

    it('service_role can read it (support, exports)', async () => {
      const r = await asService(db, () => db.query<{ n: string }>(`select count(*)::text as n from public.exercise_entries where details is not null`));
      expect(Number(r.rows[0]!.n)).toBeGreaterThan(0);
    });

    it('only accepts a JSON object: a number, a string, an array and a boolean are refused', async () => {
      const id = await asUser(db, USER_A, () => insertWorkout(db, USER_A, null, null));
      for (const bad of ['5', '"text"', '[1,2]', 'true']) {
        const err = await asUser(db, USER_A, () =>
          expectError(db.query(`update public.exercise_entries set details = $2::jsonb where id = $1`, [id, bad])),
        );
        expect(err.message, bad).toMatch(/exercise_entries_details_object_check/);
      }
      // json null is not SQL null either; the app stores SQL null
      const jsonNull = await asUser(db, USER_A, () =>
        expectError(db.query(`update public.exercise_entries set details = 'null'::jsonb where id = $1`, [id])),
      );
      expect(jsonNull.message).toMatch(/exercise_entries_details_object_check/);
    });

    it('stays small: a few kilobytes pass, a megabyte does not', async () => {
      const sets = Array.from({ length: 120 }, (_, i) => ({ exercise: 'Bench press', reps: 8, weightKg: 60, durationSec: 30 + i, restSec: 90 }));
      const ok = await asUser(db, USER_A, () => insertWorkout(db, USER_A, 'garmin:activity:14', { ...DETAILS, sets }));
      expect(ok).toBeTruthy();
      const huge = { ...DETAILS, note: 'x'.repeat(150_000) };
      const err = await asUser(db, USER_A, () => expectError(insertWorkout(db, USER_A, 'garmin:activity:15', huge)));
      expect(err.message).toMatch(/exercise_entries_details_size_check/);
    });

    it('a sync-style update by id with an explicit column list leaves the details alone', async () => {
      const id = await asUser(db, USER_A, () => insertWorkout(db, USER_A, 'garmin:activity:16', DETAILS));
      await asUser(db, USER_A, () =>
        db.query(
          `insert into public.exercise_entries (id, user_id, entry_date, name, minutes, kcal, source, external_id, counts_toward_energy)
           values ($1, $2, '2026-11-09', 'Strength (renamed)', 55, 260, 'garmin', 'garmin:activity:16', false)
           on conflict (id) do update set name = excluded.name, minutes = excluded.minutes, kcal = excluded.kcal`,
          [id, USER_A],
        ),
      );
      const r = await db.query<{ name: string; details: unknown }>(`select name, details from public.exercise_entries where id = $1`, [id]);
      expect(r.rows[0]).toEqual({ name: 'Strength (renamed)', details: DETAILS });
    });

    it('the (user, source, external id) uniqueness the sync relies on is untouched', async () => {
      await asUser(db, USER_A, () => insertWorkout(db, USER_A, 'garmin:activity:17', null));
      const err = await asUser(db, USER_A, () => expectError(insertWorkout(db, USER_A, 'garmin:activity:17', DETAILS)));
      expect(err.message).toMatch(/exercise_entries_external_uidx|duplicate key/);
      // the same id for another user is fine
      await asUser(db, USER_B, () => insertWorkout(db, USER_B, 'garmin:activity:17', DETAILS));
    });

    it('disconnecting Garmin with "delete data" removes the workouts and their details', async () => {
      await asUser(db, USER_A, async () => {
        await db.query(`delete from public.exercise_entries where user_id = $1 and source = 'garmin'`, [USER_A]);
      });
      const left = await db.query<{ n: string }>(`select count(*)::text as n from public.exercise_entries where user_id = $1 and source = 'garmin'`, [USER_A]);
      expect(left.rows[0]!.n).toBe('0');
    });
  });
});
