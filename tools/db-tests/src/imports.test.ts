import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USER_A, USER_B, asUser, createDb, createUsers, expectError } from './harness';

describe('external_id import idempotency', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createDb();
    await createUsers(db);
    await db.query(
      `insert into public.exercise_activities (code, name, met, category) values ('RUN', 'Running', 9.8, 'cardio')`,
    );
  });
  afterAll(async () => {
    await db.close();
  });

  const upsertExercise = (uid: string, source: string, externalId: string | null, kcal: number) =>
    asUser(db, uid, () =>
      db.query<{ id: string; kcal: string; inserted: boolean }>(
        `insert into public.exercise_entries (user_id, entry_date, activity_code, name, minutes, kcal, source, external_id, started_at)
         values ($1, '2026-11-10', 'RUN', 'Morning run', 30, $2, $3, $4, '2026-11-10T07:00:00Z')
         on conflict (user_id, source, external_id) where external_id is not null
         do update set kcal = excluded.kcal, minutes = excluded.minutes
         returning id, kcal, (xmax = 0) as inserted`,
        [uid, kcal, source, externalId],
      ),
    );

  describe('exercise_entries', () => {
    it('upsert inserts once, then updates the same row', async () => {
      const first = await upsertExercise(USER_A, 'apple_health', 'HK-1', 300);
      expect(first.rows[0]!.inserted).toBe(true);
      const second = await upsertExercise(USER_A, 'apple_health', 'HK-1', 320);
      expect(second.rows[0]!.inserted).toBe(false);
      expect(second.rows[0]!.id).toBe(first.rows[0]!.id);
      expect(Number(second.rows[0]!.kcal)).toBe(320);
      const n = await db.query<{ n: number }>(
        `select count(*)::int as n from public.exercise_entries where user_id = $1`,
        [USER_A],
      );
      expect(n.rows[0]!.n).toBe(1);
    });

    it('a plain duplicate insert violates the unique index', async () => {
      const err = await asUser(db, USER_A, () =>
        expectError(
          db.query(
            `insert into public.exercise_entries (user_id, entry_date, name, kcal, source, external_id)
           values ($1, '2026-11-10', 'dup', 1, 'apple_health', 'HK-1')`,
            [USER_A],
          ),
        ),
      );
      expect(err.code).toBe('23505');
      expect(err.message).toMatch(/exercise_entries_external_uidx/);
    });

    it('same external_id is fine for another source or another user', async () => {
      await upsertExercise(USER_A, 'garmin', 'HK-1', 100);
      await upsertExercise(USER_A, 'health_connect', 'HK-1', 100);
      await upsertExercise(USER_B, 'apple_health', 'HK-1', 100);
      const n = await db.query<{ n: number }>(
        `select count(*)::int as n from public.exercise_entries`,
      );
      expect(n.rows[0]!.n).toBe(4);
    });

    it('manual entries without external_id can repeat freely', async () => {
      for (let i = 0; i < 3; i++) {
        await asUser(db, USER_A, () =>
          db.query(
            `insert into public.exercise_entries (user_id, entry_date, name, kcal) values ($1, '2026-11-10', 'walk', 100)`,
            [USER_A],
          ),
        );
      }
      const n = await db.query<{ n: number }>(
        `select count(*)::int as n from public.exercise_entries where user_id = $1 and external_id is null`,
        [USER_A],
      );
      expect(n.rows[0]!.n).toBe(3);
    });

    it('rejects unknown sources, negative kcal and unknown activity codes', async () => {
      const bad: Array<[string, string]> = [
        [
          `insert into public.exercise_entries (user_id, entry_date, name, kcal, source) values ('${USER_A}', '2026-11-10', 'x', 1, 'fitbit')`,
          'check',
        ],
        [
          `insert into public.exercise_entries (user_id, entry_date, name, kcal) values ('${USER_A}', '2026-11-10', 'x', -1)`,
          'check',
        ],
        [
          `insert into public.exercise_entries (user_id, entry_date, name, kcal, activity_code) values ('${USER_A}', '2026-11-10', 'x', 1, 'NOPE')`,
          'foreign key',
        ],
      ];
      for (const [sql, kind] of bad) {
        const err = await asUser(db, USER_A, () => expectError(db.query(sql)));
        expect(err.message, sql).toMatch(
          kind === 'check' ? /violates check constraint/ : /foreign key/,
        );
      }
    });
  });

  describe('biometrics', () => {
    const upsert = (uid: string, source: string, externalId: string | null, value: number) =>
      asUser(db, uid, () =>
        db.query<{ id: string; value: string; inserted: boolean }>(
          `insert into public.biometrics (user_id, entry_date, type, value, unit, source, external_id, recorded_at, meta)
           values ($1, '2026-11-10', 'weight', $2, 'kg', $3, $4, '2026-11-10T06:30:00Z', '{"device":"scale"}')
           on conflict (user_id, source, external_id) where external_id is not null
           do update set value = excluded.value, recorded_at = excluded.recorded_at
           returning id, value, (xmax = 0) as inserted`,
          [uid, value, source, externalId],
        ),
      );

    it('upsert is idempotent per (user, source, external_id)', async () => {
      const a = await upsert(USER_A, 'apple_health', 'W-1', 80.2);
      const b = await upsert(USER_A, 'apple_health', 'W-1', 80.0);
      expect(a.rows[0]!.inserted).toBe(true);
      expect(b.rows[0]!.inserted).toBe(false);
      expect(b.rows[0]!.id).toBe(a.rows[0]!.id);
      expect(Number(b.rows[0]!.value)).toBe(80);

      await upsert(USER_A, 'garmin', 'W-1', 80);
      await upsert(USER_B, 'apple_health', 'W-1', 70);
      const n = await db.query<{ n: number }>(`select count(*)::int as n from public.biometrics`);
      expect(n.rows[0]!.n).toBe(3);
    });

    it('a plain duplicate violates the unique index; null external_ids may repeat', async () => {
      const err = await asUser(db, USER_A, () =>
        expectError(
          db.query(
            `insert into public.biometrics (user_id, entry_date, type, value, source, external_id)
           values ($1, '2026-11-10', 'weight', 1, 'apple_health', 'W-1')`,
            [USER_A],
          ),
        ),
      );
      expect(err.code).toBe('23505');
      for (let i = 0; i < 2; i++) {
        await asUser(db, USER_A, () =>
          db.query(
            `insert into public.biometrics (user_id, entry_date, type, value) values ($1, '2026-11-11', 'weight', 80)`,
            [USER_A],
          ),
        );
      }
    });
  });

  describe('daily_energy and integrations', () => {
    it('daily_energy upserts on (user, local_date, source) and bumps updated_at', async () => {
      const up = (steps: number) =>
        asUser(db, USER_A, () =>
          db.query<{ steps: number }>(
            `insert into public.daily_energy (user_id, local_date, source, active_kcal, resting_kcal, steps)
             values ($1, '2026-11-10', 'garmin', 500, 1700, $2)
             on conflict (user_id, local_date, source) do update set steps = excluded.steps, updated_at = now()
             returning steps`,
            [USER_A, steps],
          ),
        );
      await up(1000);
      expect((await up(8000)).rows[0]!.steps).toBe(8000);
      const n = await db.query<{ n: number }>(
        `select count(*)::int as n from public.daily_energy where user_id = $1`,
        [USER_A],
      );
      expect(n.rows[0]!.n).toBe(1);
      // a different source for the same day is a separate row
      await asUser(db, USER_A, () =>
        db.query(
          `insert into public.daily_energy (user_id, local_date, source, steps) values ($1, '2026-11-10', 'apple_health', 7000)`,
          [USER_A],
        ),
      );
    });

    it('one integration row per (user, provider); upsert works', async () => {
      const up = (enabled: boolean) =>
        asUser(db, USER_A, () =>
          db.query<{ enabled: boolean }>(
            `insert into public.integrations (user_id, provider, enabled, settings, backfill_date, secret_ref)
             values ($1, 'garmin', $2, '{"weight": true, "workouts": false}', '2026-10-01', 'vault:garmin-a')
             on conflict (user_id, provider) do update set enabled = excluded.enabled
             returning enabled`,
            [USER_A, enabled],
          ),
        );
      await up(false);
      expect((await up(true)).rows[0]!.enabled).toBe(true);
      const err = await asUser(db, USER_A, () =>
        expectError(
          db.query(`insert into public.integrations (user_id, provider) values ($1, 'garmin')`, [
            USER_A,
          ]),
        ),
      );
      expect(err.code).toBe('23505');
      const bad = await asUser(db, USER_A, () =>
        expectError(
          db.query(`insert into public.integrations (user_id, provider) values ($1, 'fitbit')`, [
            USER_A,
          ]),
        ),
      );
      expect(bad.message).toMatch(/violates check constraint/);
    });
  });

  describe('misc user tables', () => {
    it('validates water, fasts and weight goals', async () => {
      const bad = [
        `insert into public.water_entries (user_id, entry_date, ml) values ('${USER_A}', '2026-11-10', 0)`,
        `insert into public.fasts (user_id, started_at, ended_at) values ('${USER_A}', now(), now() - interval '1 hour')`,
        `insert into public.weight_goals (user_id, start_weight_kg, target_weight_kg) values ('${USER_A}', 0, 80)`,
        `insert into public.macro_targets (user_id, mode) values ('${USER_A}', 'zone')`,
        `insert into public.macro_targets (user_id, weekday) values ('${USER_A}', 7)`,
      ];
      for (const sql of bad) {
        const err = await asUser(db, USER_A, () => expectError(db.query(sql)));
        expect(err.message, sql).toMatch(/violates check constraint/);
      }
    });

    it('nutrient_targets: one override per nutrient, min <= max', async () => {
      await db.query(
        `insert into public.nutrients (code, name, unit, nutrient_group) values ('SODIUM_MG', 'Sodium', 'mg', 'minerals')`,
      );
      const ins = (min: number | null, max: number | null) =>
        asUser(db, USER_A, () =>
          db.query(
            `insert into public.nutrient_targets (user_id, nutrient_code, min_value, max_value) values ($1, 'SODIUM_MG', $2, $3)`,
            [USER_A, min, max],
          ),
        );
      await ins(null, 2300);
      const dup = await expectError(ins(null, 2000));
      expect(dup.code).toBe('23505');
      await asUser(db, USER_A, () => db.query(`delete from public.nutrient_targets`));
      const bad = await expectError(ins(3000, 2000));
      expect(bad.message).toMatch(/nutrient_targets_range/);
      const unknown = await asUser(db, USER_A, () =>
        expectError(
          db.query(
            `insert into public.nutrient_targets (user_id, nutrient_code) values ($1, 'NOPE')`,
            [USER_A],
          ),
        ),
      );
      expect(unknown.message).toMatch(/foreign key/);
    });
  });
});
