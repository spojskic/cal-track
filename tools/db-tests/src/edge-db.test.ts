import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFoodRow, type BuiltFood } from '../../../supabase/functions/_shared/food-row.ts';
import { mapFdcBranded } from '../../../supabase/functions/_shared/fdc-branded.ts';
import { mapOffProduct } from '../../../supabase/functions/_shared/off-product.ts';
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
} from './harness';

const OFF_CODE = '4006381333931';
const OFF_GTIN14 = '04006381333931';

const offProduct = (
  nutriments: Record<string, number> = {},
  extra: Record<string, unknown> = {},
) => ({
  code: OFF_CODE,
  product_name: 'Dark chocolate',
  brands: 'Choco,Brand',
  nutrition_data_per: '100g',
  serving_size: '25 g',
  serving_quantity: 25,
  countries_tags: ['en:germany'],
  nutriments: {
    'energy-kcal_100g': 560,
    proteins_100g: 7,
    carbohydrates_100g: 45,
    fat_100g: 38,
    salt_100g: 0.05,
    ...nutriments,
  },
  ...extra,
});

function built(product: unknown): BuiltFood {
  const mapped = mapOffProduct(product);
  if (!mapped.ok) throw new Error(mapped.reason);
  const row = buildFoodRow(mapped.product);
  if (!row) throw new Error('no row');
  return row;
}

describe('upsert_branded_food (edge function save path)', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createDb();
    await createUsers(db);
  });
  afterAll(async () => {
    await db.close();
  });

  type Result = {
    action: string;
    food: Record<string, any>;
    portions: Array<Record<string, any>>;
  };

  const upsert = async (b: BuiltFood): Promise<Result> =>
    asService(db, async () => {
      const r = await db.query<{ r: Result }>(
        'select public.upsert_branded_food($1::jsonb, $2::jsonb) as r',
        [JSON.stringify(b.food), JSON.stringify(b.portions)],
      );
      return r.rows[0]!.r;
    });

  const foodRows = async (source: string, sourceId: string) =>
    (
      await db.query<{
        id: string;
        archived: boolean;
        version: number;
        source_id: string;
        supersedes: string | null;
      }>(
        `select id, archived, version, source_id, supersedes from public.foods where source = $1 and source_id like $2 || '%' order by version`,
        [source, sourceId],
      )
    ).rows;

  it('inserts a global branded food and its portions', async () => {
    const b = built(offProduct());
    const res = await upsert(b);
    expect(res.action).toBe('inserted');
    expect(res.food).toMatchObject({
      source: 'off',
      source_id: OFF_CODE,
      kind: 'branded',
      owner_id: null,
      name: 'Dark chocolate',
      brand: 'Choco',
      gtin14: OFF_GTIN14,
      nutrients: { ENERGY_KCAL: 560, PROTEIN_G: 7, CARBS_G: 45, FAT_G: 38, SODIUM_MG: 20 },
      carb_basis: 'excludes_fiber',
      density_g_per_ml: null,
      popularity: 0,
      version: 1,
      archived: false,
    });
    expect(res.food.completeness).toBeCloseTo(b.food.completeness, 4);
    expect(res.food).not.toHaveProperty('search');
    expect(res.food).not.toHaveProperty('search_text');
    expect(res.portions.map((p) => [p.label, Number(p.grams), p.sort_order])).toEqual([
      ['100 g', 100, 0],
      ['1 serving (25 g)', 25, 1],
    ]);
  });

  it('is findable by get_food_by_gtin (any GTIN length) for every user, with readable portions', async () => {
    for (const uid of [USER_A, USER_B]) {
      for (const code of [OFF_CODE, OFF_GTIN14]) {
        const found = await asUser(db, uid, () =>
          db.query<{ id: string; name: string; source: string }>(
            'select id, name, source from public.get_food_by_gtin($1)',
            [code],
          ),
        );
        expect(found.rows).toHaveLength(1);
        expect(found.rows[0]).toMatchObject({ name: 'Dark chocolate', source: 'off' });
        const portions = await asUser(db, uid, () =>
          db.query(
            'select label from public.food_portions where food_id = $1 order by sort_order',
            [found.rows[0]!.id],
          ),
        );
        expect(portions.rows).toHaveLength(2);
      }
    }
  });

  it('re-running the same upsert is idempotent (no new rows, no write)', async () => {
    const before = await db.query<{ id: string; updated_at: string }>(
      `select id, updated_at::text from public.foods where source = 'off' and source_id = $1`,
      [OFF_CODE],
    );
    const again = await upsert(built(offProduct()));
    expect(again.action).toBe('unchanged');
    expect(again.food.id).toBe(before.rows[0]!.id);
    const rows = await foodRows('off', OFF_CODE);
    expect(rows).toHaveLength(1);
    const after = await db.query<{ updated_at: string }>(
      `select updated_at::text from public.foods where id = $1`,
      [before.rows[0]!.id],
    );
    expect(after.rows[0]!.updated_at).toBe(before.rows[0]!.updated_at);
    const portions = await db.query(`select 1 from public.food_portions where food_id = $1`, [
      before.rows[0]!.id,
    ]);
    expect(portions.rows).toHaveLength(2);
  });

  it('updates metadata in place', async () => {
    const res = await upsert(built(offProduct({}, { product_name: 'Dark chocolate 85%' })));
    expect(res.action).toBe('updated');
    expect(res.food.name).toBe('Dark chocolate 85%');
    expect(await foodRows('off', OFF_CODE)).toHaveLength(1);
    // restore for the following tests
    await upsert(built(offProduct()));
  });

  it('replaces portions when only they differ', async () => {
    const res = await upsert(built(offProduct({}, { serving_quantity: 40, serving_size: '40 g' })));
    expect(res.action).toBe('updated');
    expect(res.portions.map((p) => Number(p.grams))).toEqual([100, 40]);
    const n = await db.query(`select 1 from public.food_portions where food_id = $1`, [
      res.food.id,
    ]);
    expect(n.rows).toHaveLength(2);
    await upsert(built(offProduct()));
  });

  it('changes nutrients of an UNREFERENCED food in place', async () => {
    const res = await upsert(built(offProduct({ 'energy-kcal_100g': 570, proteins_100g: 8 })));
    expect(res.action).toBe('updated');
    expect(res.food.nutrients).toMatchObject({ ENERGY_KCAL: 570, PROTEIN_G: 8 });
    expect(res.food.version).toBe(1);
    expect(await foodRows('off', OFF_CODE)).toHaveLength(1);
    await upsert(built(offProduct()));
  });

  it('supersedes a REFERENCED food instead of rewriting history', async () => {
    const original = await db.query<{ id: string }>(
      `select id from public.foods where source = 'off' and source_id = $1`,
      [OFF_CODE],
    );
    const oldId = original.rows[0]!.id;
    await insertDiary(db, { user_id: USER_A, entry_date: '2026-11-10', food_id: oldId, grams: 50 });

    // metadata-only change of a referenced food is still an in-place update
    const meta = await upsert(
      built(offProduct({}, { product_name: 'Dark chocolate (new label)' })),
    );
    expect(meta.action).toBe('updated');
    expect(meta.food.id).toBe(oldId);

    // nutrient change -> new version
    const res = await upsert(
      built(
        offProduct({ 'energy-kcal_100g': 580 }, { product_name: 'Dark chocolate (new label)' }),
      ),
    );
    expect(res.action).toBe('superseded');
    expect(res.food.id).not.toBe(oldId);
    expect(res.food).toMatchObject({
      source_id: OFF_CODE,
      version: 2,
      supersedes: oldId,
      archived: false,
      nutrients: { ENERGY_KCAL: 580 },
    });
    expect(res.portions).toHaveLength(2);

    const rows = await foodRows('off', OFF_CODE);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: oldId,
      archived: true,
      version: 1,
      source_id: `${OFF_CODE}#v1`,
    });

    // the diary still points at the old version, whose nutrients did not change
    const diary = await db.query<{ food_id: string }>(
      `select food_id from public.diary_entries where user_id = $1`,
      [USER_A],
    );
    expect(diary.rows).toEqual([{ food_id: oldId }]);
    const old = await db.query<{ nutrients: Record<string, number> }>(
      `select nutrients from public.foods where id = $1`,
      [oldId],
    );
    expect(old.rows[0]!.nutrients.ENERGY_KCAL).toBe(560);

    // lookups now return the new version only
    const found = await asUser(db, USER_B, () =>
      db.query<{ id: string }>('select id from public.get_food_by_gtin($1)', [OFF_CODE]),
    );
    expect(found.rows).toEqual([{ id: res.food.id }]);

    // and the next identical upsert is a no-op again
    const same = await upsert(
      built(
        offProduct({ 'energy-kcal_100g': 580 }, { product_name: 'Dark chocolate (new label)' }),
      ),
    );
    expect(same.action).toBe('unchanged');
    expect(same.food.id).toBe(res.food.id);
  });

  it('keeps FDC and OFF rows with the same source_id apart', async () => {
    const fdc = mapFdcBranded({
      fdcId: 424242,
      description: 'DARK CHOCOLATE',
      gtinUpc: '4006381333931',
      brandName: 'CHOCO',
      servingSize: 30,
      servingSizeUnit: 'g',
      foodNutrients: [{ nutrientId: 1008, unitName: 'KCAL', value: 550 }],
    });
    if (!fdc.ok) throw new Error(fdc.reason);
    const res = await upsert(buildFoodRow(fdc.product)!);
    expect(res.action).toBe('inserted');
    expect(res.food).toMatchObject({
      source: 'fdc_branded',
      source_id: '424242',
      carb_basis: 'includes_fiber',
    });
    const same = await upsert(buildFoodRow(fdc.product)!);
    expect(same.action).toBe('unchanged');
  });

  it('stores ml servings with density 1', async () => {
    const b = built(
      offProduct(
        {},
        {
          code: '5449000000996',
          serving_quantity: 330,
          serving_quantity_unit: 'ml',
          serving_size: '1 can (330 ml)',
        },
      ),
    );
    const res = await upsert(b);
    expect(res.food.density_g_per_ml).toBe(1);
    expect(res.portions.map((p) => [p.label, Number(p.grams)])).toEqual([
      ['100 g', 100],
      ['1 can (330 ml)', 330],
    ]);
  });

  it('works with the documented importer SQL shape (README) for the built row', async () => {
    const b = built(offProduct({}, { code: '7622210449283', product_name: 'Biscuits' }));
    const f = b.food;
    const sql = `insert into public.foods
      (source, source_id, kind, owner_id, name, brand, gtin14, category,
       nutrients, completeness, carb_basis, density_g_per_ml, popularity)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13)
      on conflict (source, source_id) where source_id is not null and owner_id is null
      do update set name = excluded.name, brand = excluded.brand, gtin14 = excluded.gtin14,
                    category = excluded.category, completeness = excluded.completeness
      returning id, (xmax = 0) as inserted`;
    const params = [
      f.source,
      f.source_id,
      f.kind,
      f.owner_id,
      f.name,
      f.brand,
      f.gtin14,
      f.category,
      JSON.stringify(f.nutrients),
      f.completeness,
      f.carb_basis,
      f.density_g_per_ml,
      f.popularity,
    ];
    const first = await asService(db, () =>
      db.query<{ id: string; inserted: boolean }>(sql, params),
    );
    const second = await asService(db, () =>
      db.query<{ id: string; inserted: boolean }>(sql, params),
    );
    expect(first.rows[0]!.inserted).toBe(true);
    expect(second.rows[0]!.inserted).toBe(false);
    expect(second.rows[0]!.id).toBe(first.rows[0]!.id);
    // the RPC treats that row as already stored
    const viaRpc = await upsert(b);
    expect(viaRpc.food.id).toBe(first.rows[0]!.id);
  });

  it('is atomic: a bad portion leaves no food behind', async () => {
    const b = built(offProduct({}, { code: '9999999999994', product_name: 'Atomic test' }));
    b.portions[1] = { label: 'bad', amount: 1, unit: 'serving', grams: 0, sort_order: 1 };
    const err = await asService(db, () =>
      expectError(
        db.query('select public.upsert_branded_food($1::jsonb, $2::jsonb)', [
          JSON.stringify(b.food),
          JSON.stringify(b.portions),
        ]),
      ),
    );
    expect(err.code).toBe('23514');
    expect(await foodRows('off', '9999999999994')).toHaveLength(0);
  });

  it('rejects other sources and malformed input', async () => {
    const b = built(offProduct());
    const call = (food: unknown, portions: unknown = []) =>
      asService(db, () =>
        expectError(
          db.query('select public.upsert_branded_food($1::jsonb, $2::jsonb)', [
            JSON.stringify(food),
            JSON.stringify(portions),
          ]),
        ),
      );
    expect((await call({ ...b.food, source: 'custom' })).code).toBe('22023');
    expect((await call({ ...b.food, source: 'fdc_foundation' })).code).toBe('22023');
    expect((await call({ ...b.food, source_id: ' ' })).code).toBe('22023');
    expect((await call({ ...b.food, source_id: null })).code).toBe('22023');
    expect((await call(b.food, { not: 'an array' })).code).toBe('22023');
  });

  it('is callable by service_role only', async () => {
    const b = built(offProduct());
    const call = () =>
      expectError(
        db.query('select public.upsert_branded_food($1::jsonb, $2::jsonb)', [
          JSON.stringify(b.food),
          JSON.stringify(b.portions),
        ]),
      );
    for (const err of [await asUser(db, USER_A, call), await asAnon(db, call)]) {
      expect(err.message).toMatch(/permission denied/);
    }
  });
});

describe('consume_rate_limit (online-search throttle)', () => {
  let db: PGlite;
  const GLOBAL = '00000000-0000-0000-0000-000000000000';

  beforeAll(async () => {
    db = await createDb();
    await createUsers(db);
  });
  afterAll(async () => {
    await db.close();
  });

  const consume = (
    user: string | null,
    bucket: string | null,
    max: number | null,
    windowSeconds: number | null,
  ) =>
    asService(db, async () => {
      const r = await db.query<{ wait: number }>(
        'select public.consume_rate_limit($1, $2, $3, $4) as wait',
        [user, bucket, max, windowSeconds],
      );
      return r.rows[0]!.wait;
    });

  const row = async (user: string, bucket: string) =>
    (
      await db.query<{ count: number; window_start: string }>(
        'select count, window_start::text from private.edge_rate_limits where user_id = $1 and bucket = $2',
        [user, bucket],
      )
    ).rows[0];

  it('allows max requests per window, then returns the seconds to wait', async () => {
    const results: number[] = [];
    for (let i = 0; i < 6; i++) results.push(await consume(USER_A, 'online-search', 3, 60));
    expect(results.slice(0, 3)).toEqual([0, 0, 0]);
    for (const wait of results.slice(3)) {
      expect(wait).toBeGreaterThanOrEqual(1);
      expect(wait).toBeLessThanOrEqual(60);
    }
  });

  it('caps the counter at max + 1 so rejected attempts cannot grow it', async () => {
    expect((await row(USER_A, 'online-search'))!.count).toBe(4);
  });

  it('keeps users and buckets independent', async () => {
    expect(await consume(USER_B, 'online-search', 3, 60)).toBe(0);
    expect(await consume(USER_A, 'other-bucket', 3, 60)).toBe(0);
    expect(await consume(GLOBAL, 'online-search-global', 8, 60)).toBe(0); // sentinel user, no auth.users row needed
    expect(await consume(USER_A, 'online-search', 3, 60)).toBeGreaterThan(0); // still blocked
  });

  it('starts a fresh window when the previous one has expired', async () => {
    await db.query(
      `update private.edge_rate_limits set window_start = window_start - interval '61 seconds' where user_id = $1 and bucket = 'online-search'`,
      [USER_A],
    );
    expect(await consume(USER_A, 'online-search', 3, 60)).toBe(0);
    expect((await row(USER_A, 'online-search'))!.count).toBe(1);
    expect(await consume(USER_A, 'online-search', 3, 60)).toBe(0);
    expect(await consume(USER_A, 'online-search', 3, 60)).toBe(0);
    expect(await consume(USER_A, 'online-search', 3, 60)).toBeGreaterThan(0);
  });

  it('the wait shrinks as the window ages', async () => {
    const wait = await consume(USER_A, 'online-search', 3, 60);
    await db.query(
      `update private.edge_rate_limits set window_start = window_start - interval '50 seconds' where user_id = $1 and bucket = 'online-search'`,
      [USER_A],
    );
    const later = await consume(USER_A, 'online-search', 3, 60);
    expect(later).toBeGreaterThan(0);
    expect(later).toBeLessThanOrEqual(10);
    expect(later).toBeLessThan(wait);
  });

  it('rejects invalid arguments', async () => {
    const bad: Array<[string | null, string | null, number | null, number | null]> = [
      [null, 'b', 1, 1],
      [USER_A, null, 1, 1],
      [USER_A, '  ', 1, 1],
      [USER_A, 'x'.repeat(65), 1, 1],
      [USER_A, 'b', 0, 1],
      [USER_A, 'b', null, 1],
      [USER_A, 'b', 1, 0],
      [USER_A, 'b', 1, 86401],
    ];
    for (const args of bad) {
      const err = await asService(db, () =>
        expectError(db.query('select public.consume_rate_limit($1, $2, $3, $4)', args)),
      );
      expect(err.code, JSON.stringify(args)).toBe('22023');
    }
  });

  it('cannot be called by clients, and the table is closed to them (clients cannot reset their own limit)', async () => {
    const call = () =>
      expectError(
        db.query(`select public.consume_rate_limit($1, 'online-search', 1000, 1)`, [USER_A]),
      );
    for (const err of [await asUser(db, USER_A, call), await asAnon(db, call)]) {
      expect(err.message).toMatch(/permission denied/);
    }
    const readErr = await asUser(db, USER_A, () =>
      expectError(db.query('select * from private.edge_rate_limits')),
    );
    expect(readErr.message).toMatch(/permission denied/);
    const writeErr = await asUser(db, USER_A, () =>
      expectError(db.query(`delete from private.edge_rate_limits`)),
    );
    expect(writeErr.message).toMatch(/permission denied/);
  });

  it('has RLS enabled on the table and a fixed search_path on the SECURITY DEFINER function', async () => {
    const rls = await db.query<{ relrowsecurity: boolean }>(
      `select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'private' and c.relname = 'edge_rate_limits'`,
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true }]);
    const policies = await db.query(
      `select 1 from pg_policies where schemaname = 'private' and tablename = 'edge_rate_limits'`,
    );
    expect(policies.rows).toHaveLength(0);
    const fn = await db.query<{ prosecdef: boolean; proconfig: string[] }>(
      `select prosecdef, proconfig from pg_proc where proname = 'consume_rate_limit'`,
    );
    expect(fn.rows[0]!.prosecdef).toBe(true);
    expect(fn.rows[0]!.proconfig).toContain('search_path=""');
  });
});
