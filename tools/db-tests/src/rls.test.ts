import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  USER_A,
  USER_B,
  asAnon,
  asService,
  asUser,
  createDb,
  createUsers,
  expectError,
  insertDiary,
  insertFood,
} from './harness';

const RLS_VIOLATION = /row-level security|violates row-level/;

/** Tables with a user_id column, and a harmless column to try to update. */
const USER_TABLES: Array<{ table: string; set: string }> = [
  { table: 'profiles', set: `display_name = 'hacked'` },
  { table: 'meal_groups', set: `name = 'hacked'` },
  { table: 'weight_goals', set: `target_weight_kg = 1` },
  { table: 'macro_targets', set: `protein_g = 1` },
  { table: 'nutrient_targets', set: `min_value = 1` },
  { table: 'recipes', set: `notes = 'hacked'` },
  { table: 'saved_meals', set: `name = 'hacked'` },
  { table: 'favorites', set: `created_at = now()` },
  { table: 'food_usage', set: `use_count = 999` },
  { table: 'diary_entries', set: `grams = 1` },
  { table: 'exercise_entries', set: `kcal = 1` },
  { table: 'biometrics', set: `value = 1` },
  { table: 'daily_energy', set: `steps = 1` },
  { table: 'notes', set: `body = 'hacked'` },
  { table: 'water_entries', set: `ml = 1` },
  { table: 'fasts', set: `target_hours = 1` },
  { table: 'integrations', set: `enabled = true` },
  { table: 'coach_threads', set: `title = 'hacked'` },
  { table: 'coach_messages', set: `content = 'hacked'` },
];

describe('row level security', () => {
  let db: PGlite;
  const ids: Record<string, string> = {};

  /** Seed one row per user-owned table for `uid` (as superuser). */
  async function seedUser(uid: string, tag: string) {
    const q = (sql: string, p: unknown[] = []) => db.query<{ id?: string }>(sql, p);

    ids[`recipeFood_${tag}`] = await insertFood(db, {
      name: `Recipe ${tag}`,
      source: 'recipe',
      kind: 'recipe',
      owner_id: uid,
      nutrients: { ENERGY_KCAL: 100 },
    });
    ids[`custom_${tag}`] = await insertFood(db, {
      name: `Custom ${tag}`,
      source: 'custom',
      kind: 'custom',
      owner_id: uid,
      nutrients: { ENERGY_KCAL: 50 },
    });
    await q(`insert into public.recipes (food_id, user_id, servings) values ($1, $2, 2)`, [
      ids[`recipeFood_${tag}`],
      uid,
    ]);
    await q(
      `insert into public.recipe_ingredients (recipe_food_id, ingredient_food_id, grams) values ($1, $2, 100)`,
      [ids[`recipeFood_${tag}`], ids.apple],
    );
    const meal = await q(
      `insert into public.saved_meals (user_id, name) values ($1, 'Meal') returning id`,
      [uid],
    );
    ids[`savedMeal_${tag}`] = meal.rows[0]!.id!;
    await q(
      `insert into public.saved_meal_items (saved_meal_id, food_id, grams) values ($1, $2, 50)`,
      [ids[`savedMeal_${tag}`], ids.apple],
    );
    await q(`insert into public.favorites (user_id, food_id) values ($1, $2)`, [uid, ids.apple]);
    ids[`diary_${tag}`] = await insertDiary(db, {
      user_id: uid,
      entry_date: '2026-11-10',
      food_id: ids.apple!,
      grams: 150,
    });
    await q(
      `insert into public.weight_goals (user_id, start_weight_kg, target_weight_kg) values ($1, 90, 80)`,
      [uid],
    );
    await q(`insert into public.macro_targets (user_id, protein_g) values ($1, 150)`, [uid]);
    await q(
      `insert into public.nutrient_targets (user_id, nutrient_code, min_value) values ($1, 'PROTEIN_G', 100)`,
      [uid],
    );
    await q(
      `insert into public.exercise_entries (user_id, entry_date, name, kcal) values ($1, '2026-11-10', 'Run', 300)`,
      [uid],
    );
    await q(
      `insert into public.biometrics (user_id, entry_date, type, value, unit) values ($1, '2026-11-10', 'weight', 80, 'kg')`,
      [uid],
    );
    await q(
      `insert into public.daily_energy (user_id, local_date, source, steps) values ($1, '2026-11-10', 'garmin', 5000)`,
      [uid],
    );
    await q(
      `insert into public.notes (user_id, entry_date, body) values ($1, '2026-11-10', 'secret note')`,
      [uid],
    );
    await q(
      `insert into public.water_entries (user_id, entry_date, ml) values ($1, '2026-11-10', 250)`,
      [uid],
    );
    await q(`insert into public.fasts (user_id, started_at) values ($1, now())`, [uid]);
    await q(`insert into public.integrations (user_id, provider) values ($1, 'garmin')`, [uid]);
    const th = await q(
      `insert into public.coach_threads (user_id, title) values ($1, 'Thread') returning id`,
      [uid],
    );
    ids[`thread_${tag}`] = th.rows[0]!.id!;
    await q(
      `insert into public.coach_messages (thread_id, user_id, role, content) values ($1, $2, 'user', 'private question')`,
      [ids[`thread_${tag}`], uid],
    );
  }

  beforeAll(async () => {
    db = await createDb();
    await createUsers(db);
    await db.query(
      `insert into public.nutrients (code, name, unit, nutrient_group) values ('PROTEIN_G', 'Protein', 'g', 'macros')`,
    );
    ids.apple = await insertFood(db, {
      name: 'Apple, raw',
      source: 'fdc_foundation',
      source_id: 'apple',
      nutrients: { ENERGY_KCAL: 52 },
    });
    await seedUser(USER_A, 'a');
    await seedUser(USER_B, 'b');
  });

  afterAll(async () => {
    await db.close();
  });

  describe('owner isolation on user tables', () => {
    it.each(USER_TABLES)('$table: user A sees only own rows', async ({ table }) => {
      const rows = await asUser(
        db,
        USER_A,
        async () =>
          (await db.query<{ user_id: string }>(`select user_id from public.${table}`)).rows,
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map((r) => r.user_id))).toEqual(new Set([USER_A]));
    });

    it.each(USER_TABLES)('$table: user A cannot update user B’s rows', async ({ table, set }) => {
      const r = await asUser(db, USER_A, () =>
        db.query(`update public.${table} set ${set} where user_id = $1 returning 1`, [USER_B]),
      );
      expect(r.rows).toEqual([]);
    });

    it.each(USER_TABLES)('$table: user A cannot delete user B’s rows', async ({ table }) => {
      const r = await asUser(db, USER_A, () =>
        db.query(`delete from public.${table} where user_id = $1 returning 1`, [USER_B]),
      );
      expect(r.rows).toEqual([]);
      const still = await db.query<{ n: number }>(
        `select count(*)::int as n from public.${table} where user_id = $1`,
        [USER_B],
      );
      expect(still.rows[0]!.n).toBeGreaterThan(0);
    });

    it('child tables without user_id are isolated through their parent', async () => {
      const a = await asUser(db, USER_A, async () => ({
        ingredients: (
          await db.query<{ recipe_food_id: string }>(
            `select recipe_food_id from public.recipe_ingredients`,
          )
        ).rows,
        items: (
          await db.query<{ saved_meal_id: string }>(
            `select saved_meal_id from public.saved_meal_items`,
          )
        ).rows,
      }));
      expect(a.ingredients.map((r) => r.recipe_food_id)).toEqual([ids.recipeFood_a]);
      expect(a.items.map((r) => r.saved_meal_id)).toEqual([ids.savedMeal_a]);

      const del = await asUser(db, USER_A, async () => [
        (
          await db.query(
            `delete from public.recipe_ingredients where recipe_food_id = $1 returning 1`,
            [ids.recipeFood_b],
          )
        ).rows,
        (
          await db.query(
            `delete from public.saved_meal_items where saved_meal_id = $1 returning 1`,
            [ids.savedMeal_b],
          )
        ).rows,
      ]);
      expect(del).toEqual([[], []]);
    });

    it('user A cannot insert rows for user B', async () => {
      const attempts: Array<[string, unknown[]]> = [
        [
          `insert into public.diary_entries (user_id, entry_date, food_id, grams) values ($1, '2026-11-10', '${ids.apple}', 100)`,
          [USER_B],
        ],
        [
          `insert into public.exercise_entries (user_id, entry_date, name, kcal) values ($1, '2026-11-10', 'x', 1)`,
          [USER_B],
        ],
        [
          `insert into public.notes (user_id, entry_date, body) values ($1, '2026-11-10', 'x')`,
          [USER_B],
        ],
        [
          `insert into public.biometrics (user_id, entry_date, type, value) values ($1, '2026-11-10', 'weight', 1)`,
          [USER_B],
        ],
        [`insert into public.coach_threads (user_id, title) values ($1, 'x')`, [USER_B]],
        [
          `insert into public.integrations (user_id, provider) values ($1, 'apple_health')`,
          [USER_B],
        ],
        [`insert into public.meal_groups (user_id, name) values ($1, 'x')`, [USER_B]],
        [`insert into public.profiles (user_id) values ($1)`, [USER_B]],
      ];
      for (const [sql, params] of attempts) {
        const err = await asUser(db, USER_A, () => expectError(db.query(sql, params)));
        expect(err.message, sql).toMatch(RLS_VIOLATION);
      }
    });

    it('user A cannot re-assign an own row to user B', async () => {
      const err = await asUser(db, USER_A, () =>
        expectError(
          db.query(
            `update public.notes set user_id = $1 where id in (select id from public.notes)`,
            [USER_B],
          ),
        ),
      );
      expect(err.message).toMatch(RLS_VIOLATION);
    });

    it('user A can fully manage own rows', async () => {
      await asUser(db, USER_A, async () => {
        const ins = await db.query<{ id: string }>(
          `insert into public.notes (user_id, entry_date, body) values ($1, '2026-11-11', 'mine') returning id`,
          [USER_A],
        );
        const id = ins.rows[0]!.id;
        expect(
          (
            await db.query(`update public.notes set body = 'edited' where id = $1 returning body`, [
              id,
            ])
          ).rows,
        ).toEqual([{ body: 'edited' }]);
        expect(
          (await db.query(`delete from public.notes where id = $1 returning 1`, [id])).rows,
        ).toHaveLength(1);
      });
    });

    it('anon is denied everywhere', async () => {
      for (const { table } of USER_TABLES) {
        const err = await asAnon(db, () => expectError(db.query(`select * from public.${table}`)));
        expect(err.message, table).toMatch(/permission denied/);
      }
    });
  });

  describe('cross-user references are rejected', () => {
    it('cannot log a diary entry for another user’s private food', async () => {
      const err = await asUser(db, USER_A, () =>
        expectError(
          insertDiary(db, {
            user_id: USER_A,
            entry_date: '2026-11-10',
            food_id: ids.custom_b!,
            grams: 10,
          }),
        ),
      );
      expect(err.message).toMatch(RLS_VIOLATION);
    });

    it('cannot favourite, add to a saved meal or recipe another user’s private food', async () => {
      const fav = await asUser(db, USER_A, () =>
        expectError(
          db.query(`insert into public.favorites (user_id, food_id) values ($1, $2)`, [
            USER_A,
            ids.custom_b,
          ]),
        ),
      );
      expect(fav.message).toMatch(RLS_VIOLATION);

      const item = await asUser(db, USER_A, () =>
        expectError(
          db.query(
            `insert into public.saved_meal_items (saved_meal_id, food_id, grams) values ($1, $2, 10)`,
            [ids.savedMeal_a, ids.custom_b],
          ),
        ),
      );
      expect(item.message).toMatch(RLS_VIOLATION);

      const ing = await asUser(db, USER_A, () =>
        expectError(
          db.query(
            `insert into public.recipe_ingredients (recipe_food_id, ingredient_food_id, grams) values ($1, $2, 10)`,
            [ids.recipeFood_a, ids.custom_b],
          ),
        ),
      );
      expect(ing.message).toMatch(RLS_VIOLATION);
    });

    it('cannot add ingredients / items to another user’s recipe or saved meal', async () => {
      const ing = await asUser(db, USER_A, () =>
        expectError(
          db.query(
            `insert into public.recipe_ingredients (recipe_food_id, ingredient_food_id, grams) values ($1, $2, 10)`,
            [ids.recipeFood_b, ids.apple],
          ),
        ),
      );
      expect(ing.message).toMatch(RLS_VIOLATION);
      const item = await asUser(db, USER_A, () =>
        expectError(
          db.query(
            `insert into public.saved_meal_items (saved_meal_id, food_id, grams) values ($1, $2, 10)`,
            [ids.savedMeal_b, ids.apple],
          ),
        ),
      );
      expect(item.message).toMatch(RLS_VIOLATION);
    });

    it('cannot turn a global or foreign food into one’s own recipe row', async () => {
      const err = await asUser(db, USER_A, () =>
        expectError(
          db.query(`insert into public.recipes (food_id, user_id) values ($1, $2)`, [
            ids.recipeFood_b,
            USER_A,
          ]),
        ),
      );
      expect(err.message).toMatch(RLS_VIOLATION);
    });

    it('cannot put a diary entry into another user’s meal group (composite FK)', async () => {
      const g = await db.query<{ id: string }>(
        `select id from public.meal_groups where user_id = $1 limit 1`,
        [USER_B],
      );
      const err = await asUser(db, USER_A, () =>
        expectError(
          insertDiary(db, {
            user_id: USER_A,
            entry_date: '2026-11-10',
            food_id: ids.apple!,
            grams: 10,
            meal_group_id: g.rows[0]!.id,
          }),
        ),
      );
      expect(err.message).toMatch(/foreign key/);
    });

    it('cannot post a coach message into another user’s thread (composite FK)', async () => {
      const err = await asUser(db, USER_A, () =>
        expectError(
          db.query(
            `insert into public.coach_messages (thread_id, user_id, role, content) values ($1, $2, 'user', 'x')`,
            [ids.thread_b, USER_A],
          ),
        ),
      );
      expect(err.message).toMatch(/foreign key/);
    });
  });

  describe('foods', () => {
    it('user sees global foods and own custom foods, not other users’', async () => {
      const a = await asUser(db, USER_A, async () =>
        (await db.query<{ name: string }>(`select name from public.foods order by name`)).rows.map(
          (r) => r.name,
        ),
      );
      expect(a).toEqual(['Apple, raw', 'Custom a', 'Recipe a']);
      const b = await asUser(db, USER_B, async () =>
        (await db.query<{ name: string }>(`select name from public.foods order by name`)).rows.map(
          (r) => r.name,
        ),
      );
      expect(b).toEqual(['Apple, raw', 'Custom b', 'Recipe b']);
    });

    it('user can create, edit and delete own custom / recipe / ai_estimate foods', async () => {
      await asUser(db, USER_A, async () => {
        for (const kind of ['custom', 'recipe', 'ai_estimate']) {
          const id = await insertFood(db, {
            name: `Mine ${kind}`,
            source: kind,
            kind,
            owner_id: USER_A,
            nutrients: { ENERGY_KCAL: 1 },
          });
          const up = await db.query(
            `update public.foods set name = 'Renamed ' || name where id = $1 returning name`,
            [id],
          );
          expect(up.rows).toHaveLength(1);
          const del = await db.query(`delete from public.foods where id = $1 returning 1`, [id]);
          expect(del.rows).toHaveLength(1);
        }
      });
    });

    it('user cannot create global foods or foods of other kinds / owners', async () => {
      const attempts = [
        { name: 'g', owner_id: null, kind: 'custom', source: 'custom' },
        { name: 'g', owner_id: null, kind: 'generic', source: 'fdc_foundation' },
        { name: 'b', owner_id: USER_B, kind: 'custom', source: 'custom' },
        { name: 'k', owner_id: USER_A, kind: 'generic', source: 'custom' },
        { name: 'k', owner_id: USER_A, kind: 'branded', source: 'off' },
      ];
      for (const f of attempts) {
        const err = await asUser(db, USER_A, () => expectError(insertFood(db, f)));
        expect(err.message, JSON.stringify(f)).toMatch(RLS_VIOLATION);
      }
    });

    it('user cannot modify or delete global foods or other users’ foods', async () => {
      const r = await asUser(db, USER_A, async () => ({
        updGlobal: (
          await db.query(`update public.foods set name = 'hacked' where id = $1 returning 1`, [
            ids.apple,
          ])
        ).rows,
        delGlobal: (
          await db.query(`delete from public.foods where id = $1 returning 1`, [ids.apple])
        ).rows,
        updOther: (
          await db.query(`update public.foods set name = 'hacked' where id = $1 returning 1`, [
            ids.custom_b,
          ])
        ).rows,
        delOther: (
          await db.query(`delete from public.foods where id = $1 returning 1`, [ids.custom_b])
        ).rows,
      }));
      expect(r).toEqual({ updGlobal: [], delGlobal: [], updOther: [], delOther: [] });
    });

    it('user cannot hand an own food over to another user or make it global', async () => {
      for (const owner of [USER_B, null]) {
        const err = await asUser(db, USER_A, () =>
          expectError(
            db.query(`update public.foods set owner_id = $1 where id = $2`, [owner, ids.custom_a]),
          ),
        );
        expect(err.message).toMatch(RLS_VIOLATION);
      }
    });

    it('user cannot change an own food into a non-user kind', async () => {
      const err = await asUser(db, USER_A, () =>
        expectError(
          db.query(`update public.foods set kind = 'generic' where id = $1`, [ids.custom_a]),
        ),
      );
      expect(err.message).toMatch(RLS_VIOLATION);
    });

    it('service_role can write global foods', async () => {
      const id = await asService(db, () =>
        insertFood(db, { name: 'Imported', source: 'cnf', source_id: 'svc-1' }),
      );
      const seen = await asUser(
        db,
        USER_B,
        async () => (await db.query(`select 1 from public.foods where id = $1`, [id])).rows,
      );
      expect(seen).toHaveLength(1);
    });
  });

  describe('food_portions', () => {
    it('are visible for global and own foods only, writable for own foods only', async () => {
      await db.query(
        `insert into public.food_portions (food_id, label, amount, unit, grams) values ($1, '1 medium', 1, 'medium', 182)`,
        [ids.apple],
      );
      await db.query(
        `insert into public.food_portions (food_id, label, grams) values ($1, 'secret portion', 5)`,
        [ids.custom_b],
      );

      const seen = await asUser(
        db,
        USER_A,
        async () =>
          (await db.query<{ label: string }>(`select label from public.food_portions`)).rows,
      );
      expect(seen).toEqual([{ label: '1 medium' }]);

      await asUser(db, USER_A, async () => {
        await db.query(
          `insert into public.food_portions (food_id, label, grams) values ($1, '1 slice', 30)`,
          [ids.custom_a],
        );
        const upd = await db.query(
          `update public.food_portions set grams = 31 where food_id = $1 returning 1`,
          [ids.custom_a],
        );
        expect(upd.rows).toHaveLength(1);
      });

      const onGlobal = await asUser(db, USER_A, () =>
        expectError(
          db.query(`insert into public.food_portions (food_id, label, grams) values ($1, 'x', 1)`, [
            ids.apple,
          ]),
        ),
      );
      expect(onGlobal.message).toMatch(RLS_VIOLATION);
      const onOther = await asUser(db, USER_A, () =>
        expectError(
          db.query(`insert into public.food_portions (food_id, label, grams) values ($1, 'x', 1)`, [
            ids.custom_b,
          ]),
        ),
      );
      expect(onOther.message).toMatch(RLS_VIOLATION);

      const hit = await asUser(db, USER_A, async () => [
        (
          await db.query(
            `update public.food_portions set grams = 1 where food_id = $1 returning 1`,
            [ids.apple],
          )
        ).rows,
        (
          await db.query(`delete from public.food_portions where food_id = $1 returning 1`, [
            ids.apple,
          ])
        ).rows,
      ]);
      expect(hit).toEqual([[], []]);
    });
  });

  describe('reference tables and settings', () => {
    it('signed-in users can read but not write', async () => {
      await db.query(
        `insert into public.exercise_activities (code, name, met) values ('RUN', 'Running', 9.8)`,
      );
      await asUser(db, USER_A, async () => {
        for (const t of ['nutrients', 'exercise_activities', 'app_settings', 'dri_values']) {
          const r = await db.query(`select * from public.${t}`);
          expect(Array.isArray(r.rows), t).toBe(true);
        }
        expect((await db.query(`select * from public.nutrients`)).rows).toHaveLength(1);
        for (const sql of [
          `insert into public.nutrients (code, name, unit, nutrient_group) values ('X', 'x', 'g', 'x')`,
          `update public.nutrients set name = 'x'`,
          `delete from public.nutrients`,
          `insert into public.exercise_activities (code, name, met) values ('X', 'x', 1)`,
          `update public.app_settings set value = '1'::jsonb`,
          `delete from public.app_settings`,
        ]) {
          const err = await expectError(db.query(sql));
          expect(err.message, sql).toMatch(/permission denied/);
        }
      });
    });

    it('service_role can write reference data and settings', async () => {
      await asService(db, async () => {
        await db.query(
          `update public.app_settings set value = '30'::jsonb where key = 'coach_retention_days'`,
        );
        await db.query(
          `update public.app_settings set value = '90'::jsonb where key = 'coach_retention_days'`,
        );
      });
    });
  });

  describe('daily_totals is a read-only cache for clients', () => {
    it('user reads own totals only and can never write them', async () => {
      const rows = await asUser(
        db,
        USER_A,
        async () =>
          (await db.query<{ user_id: string }>(`select user_id from public.daily_totals`)).rows,
      );
      expect(rows).toEqual([{ user_id: USER_A }]);

      await asUser(db, USER_A, async () => {
        for (const sql of [
          `insert into public.daily_totals (user_id, entry_date, kcal) values ('${USER_A}', '2026-12-01', 1)`,
          `update public.daily_totals set kcal = 0`,
          `delete from public.daily_totals`,
        ]) {
          const err = await expectError(db.query(sql));
          expect(err.message, sql).toMatch(/permission denied/);
        }
      });
    });
  });

  describe('account deletion', () => {
    it('removes everything a user owns (profile, diary, custom foods, coach data, totals)', async () => {
      await db.query(`delete from auth.users where id = $1`, [USER_B]);
      for (const { table } of USER_TABLES) {
        const r = await db.query<{ n: number }>(
          `select count(*)::int as n from public.${table} where user_id = $1`,
          [USER_B],
        );
        expect(r.rows[0]!.n, table).toBe(0);
      }
      const rest = await db.query<{ n: number }>(
        `select count(*)::int as n from public.foods where owner_id = $1`,
        [USER_B],
      );
      expect(rest.rows[0]!.n).toBe(0);
      const totals = await db.query<{ n: number }>(
        `select count(*)::int as n from public.daily_totals where user_id = $1`,
        [USER_B],
      );
      expect(totals.rows[0]!.n).toBe(0);
      // user A untouched
      const a = await db.query<{ n: number }>(
        `select count(*)::int as n from public.diary_entries where user_id = $1`,
        [USER_A],
      );
      expect(a.rows[0]!.n).toBe(1);
    });
  });
});
