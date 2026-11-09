import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USER_A, USER_B, asUser, createDb, createUsers, insertFood } from './harness';

interface Totals {
  entry_date: string;
  kcal: string;
  protein_g: string;
  carbs_g: string;
  fat_g: string;
  fiber_g: string;
  entry_count: number;
  nutrients: Record<string, number>;
}

describe('daily_totals trigger', () => {
  let db: PGlite;
  let apple: string;
  let chicken: string;
  let groupId: string;

  const D1 = '2026-11-10';
  const D2 = '2026-11-11';

  /** Totals as the user sees them (through RLS), keyed by date. */
  const totalsFor = (uid: string) =>
    asUser(db, uid, async () => {
      const r = await db.query<Totals>(
        `select to_char(entry_date, 'YYYY-MM-DD') as entry_date, kcal, protein_g, carbs_g, fat_g, fiber_g,
                entry_count, nutrients
           from public.daily_totals order by entry_date`,
      );
      return Object.fromEntries(r.rows.map((t) => [t.entry_date, t]));
    });

  /** Diary writes go through the authenticated role, like the app. */
  const log = (
    uid: string,
    date: string,
    foodId: string,
    grams: number,
    mealGroup: string | null = null,
  ) =>
    asUser(db, uid, async () => {
      const r = await db.query<{ id: string }>(
        `insert into public.diary_entries (user_id, entry_date, food_id, grams, meal_group_id)
         values ($1, $2, $3, $4, $5) returning id`,
        [uid, date, foodId, grams, mealGroup],
      );
      return r.rows[0]!.id;
    });
  const asA = <T>(fn: () => Promise<T>) => asUser(db, USER_A, fn);

  beforeAll(async () => {
    db = await createDb();
    await createUsers(db);
    apple = await insertFood(db, {
      name: 'Apple, raw',
      nutrients: {
        ENERGY_KCAL: 52,
        PROTEIN_G: 0.3,
        CARBS_G: 13.8,
        FAT_G: 0.2,
        FIBER_G: 2.4,
        VITC_MG: 4.6,
      },
    });
    // chicken: CARBS_G / FIBER_G / VITC_MG intentionally unknown (missing keys)
    chicken = await insertFood(db, {
      name: 'Chicken breast, raw',
      nutrients: { ENERGY_KCAL: 120, PROTEIN_G: 22.5, FAT_G: 2.6, B12_UG: 0.3 },
    });
    groupId = (
      await db.query<{ id: string }>(
        `select id from public.meal_groups where user_id = $1 order by sort_order limit 1`,
        [USER_A],
      )
    ).rows[0]!.id;
  });

  afterAll(async () => {
    await db.close();
  });

  it('has no row for a day without entries', async () => {
    expect(await totalsFor(USER_A)).toEqual({});
  });

  let appleEntry: string;
  let chickenEntry: string;

  it('INSERT creates the day: scales per-100 g nutrients by grams', async () => {
    appleEntry = await log(USER_A, D1, apple, 200, groupId);
    const t = (await totalsFor(USER_A))[D1]!;
    expect(Number(t.kcal)).toBeCloseTo(104, 4);
    expect(Number(t.protein_g)).toBeCloseTo(0.6, 4);
    expect(Number(t.carbs_g)).toBeCloseTo(27.6, 4);
    expect(Number(t.fat_g)).toBeCloseTo(0.4, 4);
    expect(Number(t.fiber_g)).toBeCloseTo(4.8, 4);
    expect(t.entry_count).toBe(1);
    expect(t.nutrients).toEqual({
      ENERGY_KCAL: 104,
      PROTEIN_G: 0.6,
      CARBS_G: 27.6,
      FAT_G: 0.4,
      FIBER_G: 4.8,
      VITC_MG: 9.2,
    });
  });

  it('a second entry adds up across all nutrients; unknown keys are omitted, not zeroed', async () => {
    chickenEntry = await log(USER_A, D1, chicken, 150);
    const t = (await totalsFor(USER_A))[D1]!;
    expect(t.entry_count).toBe(2);
    expect(Number(t.kcal)).toBeCloseTo(104 + 180, 4);
    expect(Number(t.protein_g)).toBeCloseTo(0.6 + 33.75, 4);
    expect(Number(t.carbs_g)).toBeCloseTo(27.6, 4); // chicken has no CARBS_G
    expect(t.nutrients.ENERGY_KCAL).toBeCloseTo(284, 4);
    expect(t.nutrients.PROTEIN_G).toBeCloseTo(34.35, 4);
    expect(t.nutrients.FAT_G).toBeCloseTo(0.4 + 3.9, 4);
    expect(t.nutrients.VITC_MG).toBeCloseTo(9.2, 4); // apple only
    expect(t.nutrients.B12_UG).toBeCloseTo(0.45, 4); // chicken only
    expect(Object.keys(t.nutrients).sort()).toEqual([
      'B12_UG',
      'CARBS_G',
      'ENERGY_KCAL',
      'FAT_G',
      'FIBER_G',
      'PROTEIN_G',
      'VITC_MG',
    ]);
  });

  it('a day whose foods lack a nutrient has no key for it and a 0 summary column', async () => {
    await log(USER_A, '2026-11-20', chicken, 100);
    const t = (await totalsFor(USER_A))['2026-11-20']!;
    expect(t.nutrients).toEqual({ ENERGY_KCAL: 120, PROTEIN_G: 22.5, FAT_G: 2.6, B12_UG: 0.3 });
    expect(Number(t.carbs_g)).toBe(0);
    expect(Number(t.fiber_g)).toBe(0);
    await asA(() => db.query(`delete from public.diary_entries where entry_date = '2026-11-20'`));
  });

  it('UPDATE of grams recomputes the day', async () => {
    await asA(() =>
      db.query(`update public.diary_entries set grams = 100 where id = $1`, [appleEntry]),
    );
    const t = (await totalsFor(USER_A))[D1]!;
    expect(Number(t.kcal)).toBeCloseTo(52 + 180, 4);
    expect(t.nutrients.VITC_MG).toBeCloseTo(4.6, 4);
    expect(t.entry_count).toBe(2);
  });

  it('UPDATE of food_id recomputes the day', async () => {
    await asA(() =>
      db.query(`update public.diary_entries set food_id = $1 where id = $2`, [chicken, appleEntry]),
    );
    let t = (await totalsFor(USER_A))[D1]!;
    expect(Number(t.kcal)).toBeCloseTo(120 + 180, 4);
    expect(t.nutrients.VITC_MG).toBeUndefined();
    await asA(() =>
      db.query(`update public.diary_entries set food_id = $1 where id = $2`, [apple, appleEntry]),
    );
    t = (await totalsFor(USER_A))[D1]!;
    expect(Number(t.kcal)).toBeCloseTo(52 + 180, 4);
  });

  it('UPDATE of unrelated columns (note, meal group) leaves totals intact', async () => {
    const before = (await totalsFor(USER_A))[D1]!;
    await asA(() =>
      db.query(
        `update public.diary_entries set note = 'tasty', meal_group_id = null where id = $1`,
        [appleEntry],
      ),
    );
    expect((await totalsFor(USER_A))[D1]).toEqual(before);
  });

  it('moving an entry to another date recomputes BOTH days', async () => {
    await asA(() =>
      db.query(`update public.diary_entries set entry_date = $1 where id = $2`, [D2, appleEntry]),
    );
    const t = await totalsFor(USER_A);
    expect(t[D1]!.entry_count).toBe(1);
    expect(Number(t[D1]!.kcal)).toBeCloseTo(180, 4);
    expect(t[D1]!.nutrients.VITC_MG).toBeUndefined();
    expect(t[D2]!.entry_count).toBe(1);
    expect(Number(t[D2]!.kcal)).toBeCloseTo(52, 4);
    expect(t[D2]!.nutrients.VITC_MG).toBeCloseTo(4.6, 4);
  });

  it('moving the last entry of a day removes that day’s row', async () => {
    await asA(() =>
      db.query(`update public.diary_entries set entry_date = $1 where id = $2`, [D1, appleEntry]),
    );
    const t = await totalsFor(USER_A);
    expect(Object.keys(t)).toEqual([D1]);
    expect(t[D1]!.entry_count).toBe(2);
  });

  it('DELETE recomputes and finally removes the row', async () => {
    await asA(() => db.query(`delete from public.diary_entries where id = $1`, [chickenEntry]));
    let t = await totalsFor(USER_A);
    expect(t[D1]!.entry_count).toBe(1);
    expect(Number(t[D1]!.kcal)).toBeCloseTo(52, 4);
    await asA(() => db.query(`delete from public.diary_entries where id = $1`, [appleEntry]));
    t = await totalsFor(USER_A);
    expect(t).toEqual({});
  });

  it('handles multi-row statements and keeps users separate', async () => {
    await asA(() =>
      db.query(
        `insert into public.diary_entries (user_id, entry_date, food_id, grams)
         values ($1, $2, $3, 100), ($1, $2, $3, 50), ($1, $2, $4, 100)`,
        [USER_A, D1, apple, chicken],
      ),
    );
    await log(USER_B, D1, chicken, 300);

    const a = (await totalsFor(USER_A))[D1]!;
    expect(a.entry_count).toBe(3);
    expect(Number(a.kcal)).toBeCloseTo(52 + 26 + 120, 4);
    const b = (await totalsFor(USER_B))[D1]!;
    expect(b.entry_count).toBe(1);
    expect(Number(b.kcal)).toBeCloseTo(360, 4);

    // clearing all of A's day with one statement
    await asA(() => db.query(`delete from public.diary_entries where entry_date = $1`, [D1]));
    expect(await totalsFor(USER_A)).toEqual({});
    expect(Object.keys(await totalsFor(USER_B))).toEqual([D1]);
  });

  it('matches a from-scratch SQL recomputation of the nutrient sums', async () => {
    for (const [food, grams, date] of [
      [apple, 37, D1],
      [chicken, 183, D1],
      [apple, 12.5, D2],
      [chicken, 99.9, D1],
    ] as const) {
      await log(USER_A, date, food, grams);
    }
    const expected = await db.query<{ entry_date: string; code: string; total: string }>(
      `select to_char(e.entry_date, 'YYYY-MM-DD') as entry_date, kv.key as code,
              sum((kv.value)::numeric * e.grams / 100)::text as total
         from public.diary_entries e
         join public.foods f on f.id = e.food_id
         cross join lateral jsonb_each(f.nutrients) kv
        where e.user_id = $1
        group by 1, 2`,
      [USER_A],
    );
    const totals = await totalsFor(USER_A);
    expect(expected.rows.length).toBeGreaterThan(0);
    for (const row of expected.rows) {
      expect(
        totals[row.entry_date]!.nutrients[row.code],
        `${row.entry_date} ${row.code}`,
      ).toBeCloseTo(Number(row.total), 3);
    }
  });

  it('is a cache clients cannot write, yet the trigger works for them (SECURITY DEFINER)', async () => {
    // all inserts above ran as `authenticated`, which has SELECT only on daily_totals
    const t = await totalsFor(USER_A);
    expect(Object.keys(t).length).toBeGreaterThan(0);
  });

  it('is cleaned up with the user', async () => {
    await db.query(`delete from auth.users where id = $1`, [USER_A]);
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from public.daily_totals where user_id = $1`,
      [USER_A],
    );
    expect(r.rows[0]!.n).toBe(0);
  });
});
