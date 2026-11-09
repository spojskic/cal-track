import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  USER_A,
  USER_B,
  asService,
  asUser,
  createDb,
  createUsers,
  expectError,
  insertDiary,
  insertFood,
} from './harness';

describe('foods: constraints, generated search columns, importer upsert', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createDb();
    await createUsers(db);
  });
  afterAll(async () => {
    await db.close();
  });

  it('maintains search_text (unaccented, lower, incl. brand) and the tsvector automatically', async () => {
    const id = await insertFood(db, {
      name: 'Ćevapi Šumadijski',
      brand: 'Đuro',
      source: 'custom',
      kind: 'custom',
      owner_id: USER_A,
    });
    const r = await db.query<{ search_text: string; search: string }>(
      'select search_text, search::text from public.foods where id = $1',
      [id],
    );
    expect(r.rows[0]!.search_text).toBe('cevapi sumadijski duro');
    expect(r.rows[0]!.search).toBe(`'cevapi':1 'duro':3 'sumadijski':2`);

    await db.query(`update public.foods set name = 'Žganci' where id = $1`, [id]);
    const u = await db.query<{ search_text: string }>(
      'select search_text from public.foods where id = $1',
      [id],
    );
    expect(u.rows[0]!.search_text).toBe('zganci duro');
  });

  it('immutable_unaccent() is immutable, strict and handles Bosnian/Croatian/Serbian letters', async () => {
    const meta = await db.query<{ provolatile: string; proisstrict: boolean }>(
      `select provolatile, proisstrict from pg_proc where proname = 'immutable_unaccent'`,
    );
    expect(meta.rows).toEqual([{ provolatile: 'i', proisstrict: true }]);
    const r = await db.query<{ v: string }>(`select public.immutable_unaccent('ČčĆćŽžŠšĐđ') as v`);
    expect(r.rows[0]!.v).toBe('CcCcZzSsDd');
  });

  describe('nutrients jsonb', () => {
    it.each([
      ['array', '[1,2]'],
      ['string value', '{"ENERGY_KCAL":"52"}'],
      ['null value', '{"ENERGY_KCAL":null}'],
      ['nested object', '{"ENERGY_KCAL":{"v":1}}'],
      ['boolean', '{"ENERGY_KCAL":true}'],
    ])('rejects %s', async (_label, json) => {
      const err = await expectError(
        db.query(
          `insert into public.foods (source, kind, name, nutrients) values ('cnf', 'generic', 'bad', $1::jsonb)`,
          [json],
        ),
      );
      expect(err.message).toMatch(/foods_nutrients_numeric_object/);
    });

    it('accepts numbers (incl. 0 and decimals) and the empty object', async () => {
      await insertFood(db, { name: 'ok 1', nutrients: { ENERGY_KCAL: 0, PROTEIN_G: 0.25 } });
      await insertFood(db, { name: 'ok 2', nutrients: {} });
    });
  });

  describe('check constraints', () => {
    it.each([
      ['source', `('bogus', 'generic', 'x')`],
      ['kind', `('cnf', 'bogus', 'x')`],
      ['name', `('cnf', 'generic', '   ')`],
    ])('rejects an invalid %s', async (_what, values) => {
      const err = await expectError(
        db.query(`insert into public.foods (source, kind, name) values ${values}`),
      );
      expect(err.message).toMatch(/violates check constraint/);
    });

    it('validates completeness, carb_basis and density', async () => {
      for (const [col, val] of [
        ['completeness', '1.5'],
        ['carb_basis', `'net'`],
        ['density_g_per_ml', '0'],
      ] as const) {
        const err = await expectError(
          db.query(
            `insert into public.foods (source, kind, name, ${col}) values ('cnf', 'generic', 'x', ${val})`,
          ),
        );
        expect(err.message, col).toMatch(/violates check constraint/);
      }
    });

    it('defaults: carb_basis includes_fiber, popularity 0, version 1, not archived, empty nutrients', async () => {
      const r = await db.query<Record<string, unknown>>(
        `insert into public.foods (source, kind, name) values ('cnf', 'generic', 'defaults') returning carb_basis, popularity, version, archived, nutrients, owner_id`,
      );
      expect(r.rows[0]).toEqual({
        carb_basis: 'includes_fiber',
        popularity: 0,
        version: 1,
        archived: false,
        nutrients: {},
        owner_id: null,
      });
    });
  });

  describe('importer upsert shape (global foods)', () => {
    const upsert = (nutrients: object, name = 'Almonds, raw') =>
      db.query<{ id: string; name: string; nutrients: Record<string, number> }>(
        `insert into public.foods
           (source, source_id, kind, owner_id, name, brand, gtin14, category, nutrients, completeness,
            carb_basis, density_g_per_ml, popularity)
         values ('fdc_foundation', '12345', 'generic', null, $1, null, null, 'Nuts and Seeds', $2::jsonb, 0.9,
                 'includes_fiber', null, 0)
         on conflict (source, source_id) where source_id is not null and owner_id is null
         do update set name = excluded.name, category = excluded.category, nutrients = excluded.nutrients,
                       completeness = excluded.completeness
         returning id, name, nutrients`,
        [name, JSON.stringify(nutrients)],
      );

    it('inserts once and updates in place on re-import', async () => {
      const first = await upsert({ ENERGY_KCAL: 579, PROTEIN_G: 21.2 });
      const second = await upsert({ ENERGY_KCAL: 580, PROTEIN_G: 21.2 }, 'Almonds, raw (updated)');
      expect(second.rows[0]!.id).toBe(first.rows[0]!.id);
      expect(second.rows[0]!.nutrients.ENERGY_KCAL).toBe(580);
      const n = await db.query<{ n: number }>(
        `select count(*)::int as n from public.foods where source_id = '12345'`,
      );
      expect(n.rows[0]!.n).toBe(1);
    });

    it('rejects a plain duplicate (source, source_id) among global foods but allows it for owned foods', async () => {
      await insertFood(db, { name: 'dup a', source: 'cnf', source_id: 'same' });
      const err = await expectError(
        insertFood(db, { name: 'dup b', source: 'cnf', source_id: 'same' }),
      );
      expect(err.message).toMatch(/foods_global_source_uidx|duplicate key/);
      // same pair owned by a user, and a null source_id, are fine (partial index)
      await insertFood(db, {
        name: 'dup c',
        source: 'cnf',
        source_id: 'same',
        kind: 'custom',
        owner_id: USER_A,
      });
      await insertFood(db, { name: 'null 1', source: 'cnf', source_id: null });
      await insertFood(db, { name: 'null 2', source: 'cnf', source_id: null });
    });

    it('re-importing a food that is already logged fails loudly (importer must supersede)', async () => {
      const row = await db.query<{ id: string }>(
        `select id from public.foods where source_id = '12345'`,
      );
      await insertDiary(db, {
        user_id: USER_A,
        entry_date: '2026-11-10',
        food_id: row.rows[0]!.id,
        grams: 30,
      });
      const err = await expectError(upsert({ ENERGY_KCAL: 600 }));
      expect(err.code).toBe('23001');
      expect(err.message).toMatch(/immutable/);
    });
  });

  describe('nutrient history stability (immutability trigger)', () => {
    let logged: string;
    let unlogged: string;
    let ingredient: string;
    let recipeFood: string;

    beforeAll(async () => {
      logged = await insertFood(db, {
        name: 'Rolled oats',
        source: 'fdc_foundation',
        source_id: 'oats',
        nutrients: { ENERGY_KCAL: 379, CARBS_G: 67.7, FIBER_G: 10.1 },
        density_g_per_ml: 0.4,
      });
      unlogged = await insertFood(db, {
        name: 'Unused food',
        source: 'fdc_foundation',
        source_id: 'unused',
        nutrients: { ENERGY_KCAL: 10 },
      });
      ingredient = await insertFood(db, {
        name: 'Flour',
        source: 'fdc_foundation',
        source_id: 'flour',
        nutrients: { ENERGY_KCAL: 364 },
      });
      recipeFood = await insertFood(db, {
        name: 'Bread',
        source: 'recipe',
        kind: 'recipe',
        owner_id: USER_A,
        nutrients: { ENERGY_KCAL: 250 },
      });
      await db.query(`insert into public.recipes (food_id, user_id, servings) values ($1, $2, 8)`, [
        recipeFood,
        USER_A,
      ]);
      await db.query(
        `insert into public.recipe_ingredients (recipe_food_id, ingredient_food_id, grams) values ($1, $2, 500)`,
        [recipeFood, ingredient],
      );
      await insertDiary(db, {
        user_id: USER_B,
        entry_date: '2026-11-10',
        food_id: logged,
        grams: 50,
      });
    });

    it('blocks nutrients / carb_basis / density_g_per_ml updates of a logged food', async () => {
      for (const sql of [
        `update public.foods set nutrients = '{"ENERGY_KCAL": 1}' where id = $1`,
        `update public.foods set nutrients = nutrients || '{"PROTEIN_G": 13}' where id = $1`,
        `update public.foods set carb_basis = 'excludes_fiber' where id = $1`,
        `update public.foods set density_g_per_ml = 0.5 where id = $1`,
      ]) {
        const err = await expectError(db.query(sql, [logged]));
        expect(err.code, sql).toBe('23001');
        expect(err.message, sql).toMatch(/immutable/);
      }
      const r = await db.query<{
        nutrients: Record<string, number>;
        carb_basis: string;
        density_g_per_ml: number;
      }>(`select nutrients, carb_basis, density_g_per_ml from public.foods where id = $1`, [
        logged,
      ]);
      expect(r.rows[0]).toEqual({
        nutrients: { ENERGY_KCAL: 379, CARBS_G: 67.7, FIBER_G: 10.1 },
        carb_basis: 'includes_fiber',
        density_g_per_ml: 0.4,
      });
    });

    it('also blocks it for service_role (importer) and sees references of every user', async () => {
      const err = await asService(db, () =>
        expectError(db.query(`update public.foods set nutrients = '{}' where id = $1`, [logged])),
      );
      expect(err.code).toBe('23001');
    });

    it('allows name, brand, category, popularity, completeness, archived, gtin updates on a logged food', async () => {
      const r = await db.query<{ name: string; popularity: number; archived: boolean }>(
        `update public.foods
            set name = 'Rolled oats (renamed)', brand = 'Acme', category = 'Cereals', popularity = 42,
                completeness = 0.5, archived = false, gtin14 = '12345670'
          where id = $1 returning name, popularity, archived`,
        [logged],
      );
      expect(r.rows).toEqual([{ name: 'Rolled oats (renamed)', popularity: 42, archived: false }]);
      await db.query(`update public.foods set popularity = popularity + 1 where id = $1`, [logged]);
    });

    it('allows a no-op nutrients rewrite (same values, different key order)', async () => {
      const r = await db.query(
        `update public.foods set nutrients = '{"FIBER_G": 10.1, "CARBS_G": 67.7, "ENERGY_KCAL": 379}', carb_basis = 'includes_fiber', density_g_per_ml = 0.4
          where id = $1 returning 1`,
        [logged],
      );
      expect(r.rows).toHaveLength(1);
    });

    it('allows nutrients updates on a food nothing references', async () => {
      const r = await db.query<{ nutrients: Record<string, number> }>(
        `update public.foods set nutrients = '{"ENERGY_KCAL": 11}', carb_basis = 'excludes_fiber', density_g_per_ml = 1 where id = $1 returning nutrients`,
        [unlogged],
      );
      expect(r.rows[0]!.nutrients).toEqual({ ENERGY_KCAL: 11 });
    });

    it('treats recipe ingredients as references, but not the recipe food itself', async () => {
      const err = await expectError(
        db.query(`update public.foods set nutrients = '{"ENERGY_KCAL": 1}' where id = $1`, [
          ingredient,
        ]),
      );
      expect(err.code).toBe('23001');
      const ok = await asUser(db, USER_A, () =>
        db.query(
          `update public.foods set nutrients = '{"ENERGY_KCAL": 260}' where id = $1 returning 1`,
          [recipeFood],
        ),
      );
      expect(ok.rows).toHaveLength(1);
    });

    it('fails the whole statement when any matched row is protected', async () => {
      const err = await expectError(
        db.query(`update public.foods set nutrients = '{"ENERGY_KCAL": 5}' where id in ($1, $2)`, [
          unlogged,
          logged,
        ]),
      );
      expect(err.code).toBe('23001');
      const r = await db.query<{ nutrients: Record<string, number> }>(
        `select nutrients from public.foods where id = $1`,
        [unlogged],
      );
      expect(r.rows[0]!.nutrients).toEqual({ ENERGY_KCAL: 11 });
    });

    it('becomes editable again once nothing references the food', async () => {
      const tmp = await insertFood(db, { name: 'Temp', nutrients: { ENERGY_KCAL: 1 } });
      const entry = await insertDiary(db, {
        user_id: USER_A,
        entry_date: '2026-11-10',
        food_id: tmp,
        grams: 1,
      });
      await expectError(db.query(`update public.foods set nutrients = '{}' where id = $1`, [tmp]));
      await db.query(`delete from public.diary_entries where id = $1`, [entry]);
      const r = await db.query(
        `update public.foods set nutrients = '{"ENERGY_KCAL": 2}' where id = $1 returning 1`,
        [tmp],
      );
      expect(r.rows).toHaveLength(1);
    });

    it('refuses to delete a logged food (restrict at commit) but deletes an unused one', async () => {
      const err = await expectError(db.query(`delete from public.foods where id = $1`, [logged]));
      expect(err.message).toMatch(/foreign key|violates/);
      const ok = await db.query(`delete from public.foods where id = $1 returning 1`, [unlogged]);
      expect(ok.rows).toHaveLength(1);
    });
  });

  describe('supersede_food()', () => {
    it('creates version 2 of a logged global food while history keeps the old nutrients', async () => {
      const v1 = await insertFood(db, {
        name: 'Greek yogurt',
        source: 'fdc_foundation',
        source_id: 'yog-1',
        category: 'Dairy',
        nutrients: { ENERGY_KCAL: 59, PROTEIN_G: 10 },
        completeness: 0.8,
        popularity: 7,
      });
      await db.query(
        `insert into public.food_portions (food_id, label, amount, unit, grams, sort_order) values ($1, '1 cup', 1, 'cup', 245, 1)`,
        [v1],
      );
      await insertDiary(db, { user_id: USER_A, entry_date: '2026-11-12', food_id: v1, grams: 200 });

      const v2 = await asService(
        db,
        async () =>
          (await db.query<{ id: string }>('select public.supersede_food($1) as id', [v1])).rows[0]!
            .id,
      );
      expect(v2).not.toBe(v1);

      const old = (
        await db.query<Record<string, unknown>>('select * from public.foods where id = $1', [v1])
      ).rows[0]!;
      expect(old).toMatchObject({
        archived: true,
        version: 1,
        source_id: 'yog-1#v1',
        nutrients: { ENERGY_KCAL: 59, PROTEIN_G: 10 },
      });
      const nu = (
        await db.query<Record<string, unknown>>('select * from public.foods where id = $1', [v2])
      ).rows[0]!;
      expect(nu).toMatchObject({
        archived: false,
        version: 2,
        supersedes: v1,
        source: 'fdc_foundation',
        source_id: 'yog-1',
        owner_id: null,
        name: 'Greek yogurt',
        category: 'Dairy',
        completeness: 0.8,
        popularity: 7,
      });

      const portions = await db.query<{ label: string; grams: string }>(
        'select label, grams from public.food_portions where food_id = $1',
        [v2],
      );
      expect(portions.rows).toEqual([{ label: '1 cup', grams: '245' }]);

      // the new version is editable, the diary still points at v1 with its old numbers
      await db.query(
        `update public.foods set nutrients = '{"ENERGY_KCAL": 61, "PROTEIN_G": 10.3}' where id = $1`,
        [v2],
      );
      const totals = await db.query<{ kcal: string }>(
        `select kcal from public.daily_totals where user_id = $1 and entry_date = '2026-11-12'`,
        [USER_A],
      );
      expect(Number(totals.rows[0]!.kcal)).toBeCloseTo(118, 4);

      // search shows the new version only, and a re-import can target (source, source_id) again
      const hits = await asUser(
        db,
        USER_A,
        async () =>
          (await db.query<{ id: string }>(`select id from public.search_foods('greek yogurt')`))
            .rows,
      );
      expect(hits.map((h) => h.id)).toEqual([v2]);
    });

    it('lets a user version their own logged custom food, but not global or foreign foods', async () => {
      const mine = await insertFood(db, {
        name: 'My granola',
        source: 'custom',
        kind: 'custom',
        owner_id: USER_A,
        nutrients: { ENERGY_KCAL: 450 },
      });
      await insertDiary(db, {
        user_id: USER_A,
        entry_date: '2026-11-12',
        food_id: mine,
        grams: 40,
      });

      const v2 = await asUser(
        db,
        USER_A,
        async () =>
          (await db.query<{ id: string }>('select public.supersede_food($1) as id', [mine]))
            .rows[0]!.id,
      );
      const r = await db.query<{
        owner_id: string;
        version: number;
        supersedes: string;
        source_id: string | null;
      }>('select owner_id, version, supersedes, source_id from public.foods where id = $1', [v2]);
      expect(r.rows[0]).toEqual({
        owner_id: USER_A,
        version: 2,
        supersedes: mine,
        source_id: null,
      });

      const global = await insertFood(db, {
        name: 'Global thing',
        source: 'cnf',
        source_id: 'g-1',
      });
      const onGlobal = await asUser(db, USER_A, () =>
        expectError(db.query('select public.supersede_food($1)', [global])),
      );
      expect(onGlobal.message).toMatch(/may not be modified/);
      const onForeign = await asUser(db, USER_B, () =>
        expectError(db.query('select public.supersede_food($1)', [mine])),
      );
      expect(onForeign.message).toMatch(/not found or not accessible/);
    });
  });
});
