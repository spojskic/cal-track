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

interface Hit {
  id: string;
  name: string;
  brand: string | null;
  kind: string;
  source: string;
  kcal_100g: string | null;
  protein_100g: string | null;
  carbs_100g: string | null;
  fat_100g: string | null;
  completeness: number | null;
  rank: number;
}

describe('search_foods', () => {
  let db: PGlite;
  const ids: Record<string, string> = {};

  const search = (uid: string, q: string | null, max?: number, kinds?: string[] | null) =>
    asUser(db, uid, async () => {
      const r = await db.query<Hit>('select * from public.search_foods($1, $2, $3)', [
        q,
        max ?? 25,
        kinds ?? null,
      ]);
      return r.rows;
    });
  const names = (rows: Hit[]) => rows.map((r) => r.name);

  beforeAll(async () => {
    db = await createDb();
    await createUsers(db);

    // --- global foods (inserted as the superuser = service-side importer) ---
    ids.chickenFoundation = await insertFood(db, {
      name: 'Chicken breast, raw',
      source: 'fdc_foundation',
      source_id: 'f-1',
      nutrients: { ENERGY_KCAL: 120, PROTEIN_G: 22.5, CARBS_G: 0, FAT_G: 2.6 },
      completeness: 0.9,
    });
    ids.chickenSr = await insertFood(db, {
      name: 'Chicken breast, roasted',
      source: 'fdc_sr_legacy',
      source_id: 's-1',
      nutrients: { ENERGY_KCAL: 165 },
      completeness: 0.9,
    });
    ids.chickenBranded = await insertFood(db, {
      name: 'Chicken breast fillet',
      brand: 'Acme Farms',
      source: 'fdc_branded',
      source_id: 'b-1',
      kind: 'branded',
      nutrients: { ENERGY_KCAL: 110 },
      completeness: 0.9,
    });
    ids.chickenArchived = await insertFood(db, {
      name: 'Chicken breast, discontinued',
      source: 'fdc_foundation',
      source_id: 'f-old',
      archived: true,
    });

    ids.bananaFoundation = await insertFood(db, {
      name: 'Banana, raw',
      source: 'fdc_foundation',
      source_id: 'ba-f',
      completeness: 0.8,
    });
    ids.bananaBranded = await insertFood(db, {
      name: 'Banana, raw',
      source: 'fdc_branded',
      source_id: 'ba-b',
      kind: 'branded',
      completeness: 0.8,
    });

    ids.milkFoundation = await insertFood(db, {
      name: 'Milk, whole',
      source: 'fdc_foundation',
      source_id: 'm-f',
      completeness: 0.8,
    });
    ids.milkBranded = await insertFood(db, {
      name: 'Milk, whole',
      source: 'fdc_branded',
      source_id: 'm-b',
      kind: 'branded',
      completeness: 0.8,
    });

    // same name in every source -> source quality order
    for (const [source, kind] of [
      ['ai_estimate', 'ai_estimate'],
      ['off', 'branded'],
      ['fdc_branded', 'branded'],
      ['fdc_fndds', 'generic'],
      ['cofid', 'generic'],
      ['cnf', 'generic'],
      ['fdc_sr_legacy', 'generic'],
      ['fdc_foundation', 'generic'],
    ] as const) {
      ids[`rice_${source}`] = await insertFood(db, {
        name: 'Rice, white, cooked',
        source,
        source_id: `rice-${source}`,
        kind,
        completeness: 0.8,
      });
    }

    // --- user-owned foods ---
    ids.cevapiA = await insertFood(db, {
      name: 'Ćevapi',
      source: 'custom',
      kind: 'custom',
      owner_id: USER_A,
      nutrients: { ENERGY_KCAL: 250 },
    });
    ids.vrhnjeA = await insertFood(db, {
      name: 'Vrhnje za kuhanje',
      source: 'custom',
      kind: 'custom',
      owner_id: USER_A,
    });
    ids.cevapiB = await insertFood(db, {
      name: 'Ćevapi sa lukom',
      source: 'custom',
      kind: 'custom',
      owner_id: USER_B,
    });
    ids.soupA = await insertFood(db, {
      name: 'Chicken soup (homemade)',
      source: 'custom',
      kind: 'custom',
      owner_id: USER_A,
    });
  });

  afterAll(async () => {
    await db.close();
  });

  it('returns the documented summary shape only', async () => {
    const rows = await search(USER_A, 'chicken breast raw');
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        'brand',
        'carbs_100g',
        'completeness',
        'fat_100g',
        'id',
        'kcal_100g',
        'kind',
        'name',
        'protein_100g',
        'rank',
        'source',
      ].sort(),
    );
    const top = rows.find((r) => r.id === ids.chickenFoundation)!;
    expect(Number(top.kcal_100g)).toBe(120);
    expect(Number(top.protein_100g)).toBe(22.5);
    expect(Number(top.carbs_100g)).toBe(0);
    expect(Number(top.fat_100g)).toBe(2.6);
    // unknown nutrients stay NULL (never coerced to 0)
    const sr = rows.find((r) => r.id === ids.chickenSr)!;
    expect(sr.protein_100g).toBeNull();
  });

  describe('diacritics and case', () => {
    it.each(['cevapi', 'ćevapi', 'Ćevapi', 'ĆEVAPI', 'cEvApI', 'cevap', 'ćevap'])(
      "%s finds the custom food 'Ćevapi'",
      async (q) => {
        const rows = await search(USER_A, q);
        expect(names(rows)).toContain('Ćevapi');
      },
    );

    it("'vrhnje' finds 'Vrhnje za kuhanje' and multi-word prefixes work", async () => {
      expect(names(await search(USER_A, 'vrhnje'))).toContain('Vrhnje za kuhanje');
      expect(names(await search(USER_A, 'vrhnje kuh'))).toEqual(['Vrhnje za kuhanje']);
      expect(names(await search(USER_A, 'kuhanje vrhnje'))).toEqual(['Vrhnje za kuhanje']);
    });

    it("does not leak another user's custom foods", async () => {
      expect(names(await search(USER_A, 'cevapi'))).not.toContain('Ćevapi sa lukom');
      expect(names(await search(USER_B, 'cevapi'))).toEqual(['Ćevapi sa lukom']);
    });
  });

  describe('typo tolerance', () => {
    it.each([
      'chiken',
      'chiken breast',
      'chicen',
      'chikken',
      'chickn',
      'chicken brest',
      'chiken brest',
    ])("'%s' finds chicken breast", async (q) => {
      const rows = await search(USER_A, q);
      expect(names(rows)).toContain('Chicken breast, raw');
    });

    it('does not fuzzy-match unrelated foods', async () => {
      expect(await search(USER_A, 'zzzzqq')).toEqual([]);
      expect(names(await search(USER_A, 'chiken'))).not.toContain('Banana, raw');
    });
  });

  describe('robustness', () => {
    it.each([
      '',
      '   ',
      '!!!',
      "'; drop table public.foods; --",
      '& | ! ( ) : * <->',
      'a:*b',
      '\\',
      '"unbalanced',
      '%',
      '_',
    ])('survives hostile / degenerate input %j', async (q) => {
      const rows = await search(USER_A, q);
      expect(Array.isArray(rows)).toBe(true);
    });

    it('returns nothing for null / empty queries', async () => {
      expect(await search(USER_A, null)).toEqual([]);
      expect(await search(USER_A, '')).toEqual([]);
    });

    it('treats LIKE wildcards literally', async () => {
      expect(await search(USER_A, '%')).toEqual([]);
    });

    it('clamps max_results (min 1, max 100) and honours it', async () => {
      expect(await search(USER_A, 'chicken', 2)).toHaveLength(2);
      expect(await search(USER_A, 'chicken', 0)).toHaveLength(1);
      expect(await search(USER_A, 'chicken', -5)).toHaveLength(1);
    });

    it('matches single-character prefixes via full-text only', async () => {
      const rows = await search(USER_A, 'c');
      expect(names(rows)).toEqual(expect.arrayContaining(['Chicken breast, raw', 'Ćevapi']));
    });
  });

  describe('visibility', () => {
    it('hides archived foods', async () => {
      const rows = await search(USER_A, 'chicken breast');
      expect(names(rows)).not.toContain('Chicken breast, discontinued');
      expect(rows.map((r) => r.id)).not.toContain(ids.chickenArchived);
    });

    it('filters by kinds (and treats an empty array as "no filter")', async () => {
      const branded = await search(USER_A, 'chicken', 25, ['branded']);
      expect(branded.map((r) => r.id)).toEqual([ids.chickenBranded]);

      const custom = await search(USER_A, 'chicken', 25, ['custom']);
      expect(names(custom)).toEqual(['Chicken soup (homemade)']);

      const customOrBranded = await search(USER_A, 'chicken', 25, ['custom', 'branded']);
      expect(new Set(names(customOrBranded))).toEqual(
        new Set(['Chicken soup (homemade)', 'Chicken breast fillet']),
      );

      const none = await search(USER_A, 'chicken', 25, []);
      expect(none.length).toBeGreaterThanOrEqual(4);
    });

    it('is permission-denied for anon', async () => {
      const err = await asAnon(db, () =>
        expectError(db.query(`select * from public.search_foods('chicken')`)),
      );
      expect(err.message).toMatch(/permission denied/);
    });

    it('service_role (RLS bypass) still only sees global foods, never other users’ custom foods', async () => {
      const rows = await asService(
        db,
        async () => (await db.query<Hit>(`select * from public.search_foods('cevapi')`)).rows,
      );
      expect(rows).toEqual([]);
    });
  });

  describe('ranking', () => {
    it("puts the user's own custom food first", async () => {
      const rows = await search(USER_A, 'chicken');
      expect(rows[0]!.name).toBe('Chicken soup (homemade)');
      const bob = await search(USER_B, 'chicken');
      expect(bob[0]!.name).toBe('Chicken breast, raw');
    });

    it('ranks generic Foundation above Branded for identical text', async () => {
      const rows = await search(USER_B, 'banana');
      expect(rows.map((r) => r.id)).toEqual([ids.bananaFoundation, ids.bananaBranded]);
      expect(rows[0]!.rank).toBeGreaterThan(rows[1]!.rank);
    });

    it('orders identical text by source quality: foundation > sr_legacy > cnf > cofid > fndds > branded > off > ai_estimate', async () => {
      const rows = await search(USER_B, 'rice white cooked');
      expect(rows.map((r) => r.source)).toEqual([
        'fdc_foundation',
        'fdc_sr_legacy',
        'cnf',
        'cofid',
        'fdc_fndds',
        'fdc_branded',
        'off',
        'ai_estimate',
      ]);
    });

    it('prefers a closer text match within the same source tier', async () => {
      const rows = await search(USER_B, 'chicken breast raw');
      expect(rows[0]!.id).toBe(ids.chickenFoundation);
    });

    it('returns rows ordered by rank descending', async () => {
      const rows = await search(USER_A, 'chicken');
      const ranks = rows.map((r) => r.rank);
      expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    });

    it('boosts foods the user logs frequently (food_usage via diary trigger)', async () => {
      // Before any usage both users see the Foundation milk first.
      expect((await search(USER_A, 'milk whole'))[0]!.id).toBe(ids.milkFoundation);
      expect((await search(USER_B, 'milk whole'))[0]!.id).toBe(ids.milkFoundation);

      for (let i = 0; i < 5; i++) {
        await insertDiary(db, {
          user_id: USER_A,
          entry_date: '2026-11-10',
          food_id: ids.milkBranded!,
          grams: 200,
        });
      }

      const alice = await search(USER_A, 'milk whole');
      expect(alice[0]!.id).toBe(ids.milkBranded);
      expect(alice[1]!.id).toBe(ids.milkFoundation);

      // Bob logged nothing: unchanged for him.
      const bob = await search(USER_B, 'milk whole');
      expect(bob[0]!.id).toBe(ids.milkFoundation);

      const usage = await db.query<{ use_count: number }>(
        `select use_count from public.food_usage where user_id = $1 and food_id = $2`,
        [USER_A, ids.milkBranded],
      );
      expect(usage.rows).toEqual([{ use_count: 5 }]);
    });

    it('boosts favourites', async () => {
      const before = await search(USER_B, 'banana');
      expect(before[0]!.id).toBe(ids.bananaFoundation);
      await asUser(db, USER_B, () =>
        db.query('insert into public.favorites (user_id, food_id) values ($1, $2)', [
          USER_B,
          ids.bananaBranded,
        ]),
      );
      const after = await search(USER_B, 'banana');
      expect(after[0]!.id).toBe(ids.bananaBranded);
    });
  });
});
