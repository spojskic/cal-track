import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USER_A, asUser, createDb, createUsers } from './harness';

/**
 * Regression guard for a Postgres/RLS pitfall: with row level security on `foods`,
 * an invoker query using `tsvector @@ tsquery` or pg_trgm's `<%` cannot use the
 * GIN indexes (those operators are not leakproof) and degrades to a full table
 * scan on every keystroke. search_foods() therefore ranks inside the SECURITY
 * DEFINER helper private.search_foods_ranked(). This test loads a realistic
 * volume and asserts, via buffer counts (deterministic, unlike timings), that a
 * search through the public RPC touches a small fraction of the heap.
 */
describe('search_foods scales (uses the GIN indexes under RLS)', () => {
  let db: PGlite;
  let heapPages = 0;

  const pagesTouched = async (sql: string): Promise<number> => {
    const r = await db.query<{ 'QUERY PLAN': Array<{ Plan: Record<string, number> }> }>(
      `explain (analyze, buffers, format json) ${sql}`,
    );
    const plan = r.rows[0]!['QUERY PLAN'][0]!.Plan;
    return (plan['Shared Hit Blocks'] ?? 0) + (plan['Shared Read Blocks'] ?? 0);
  };

  let word = '';
  let typo = '';

  beforeAll(async () => {
    db = await createDb();
    await createUsers(db);
    // 20k foods named from a 3000-word pseudo-random vocabulary (like real food
    // names: a few shared words, many distinctive ones), ~30 nutrient keys each.
    await db.exec(`
      create temp table vocab as
        select g as i, translate(substr(md5('w' || g), 1, 7), '0123456789', 'ghijklmnop') as w
        from generate_series(1, 3000) g;
      insert into public.foods (source, source_id, kind, name, nutrients, completeness, popularity)
      select (array['fdc_foundation','fdc_sr_legacy','cnf','cofid','fdc_fndds'])[1 + (g % 5)],
             'id' || g, 'generic',
             (select w from vocab where i = 1 + (g % 3000)) || ', '
               || (select w from vocab where i = 1 + ((g * 7) % 3000)) || ' '
               || (select w from vocab where i = 1 + ((g * 13) % 3000)) || ' raw',
             (select jsonb_object_agg('NUT_' || k, round((random() * 100)::numeric, 3)) from generate_series(1, 30) k),
             random(), (random() * 1000)::int
      from generate_series(1, 20000) g;
      analyze public.foods;
    `);
    word = (await db.query<{ w: string }>(`select w from vocab where i = 1234`)).rows[0]!.w;
    typo = word.slice(0, 3) + word.slice(4); // one letter missing
    heapPages = (
      await db.query<{ n: number }>(
        `select relpages::int as n from pg_class where relname = 'foods'`,
      )
    ).rows[0]!.n;
  });
  afterAll(async () => {
    await db.close();
  });

  it('fixture is big enough to make a sequential scan obvious', () => {
    expect(heapPages).toBeGreaterThan(2000);
  });

  it('prefix search: matches only the foods containing the word, via the indexes', async () => {
    await asUser(db, USER_A, async () => {
      await db.query(`select * from public.search_foods($1)`, [word]); // warm catalog caches
      const pages = await pagesTouched(`select * from public.search_foods('${word}')`);
      expect(pages, `${pages} pages touched, heap has ${heapPages}`).toBeLessThan(heapPages * 0.1);
      const rows = (
        await db.query<{ name: string }>(`select name from public.search_foods($1, 100)`, [word])
      ).rows;
      expect(rows.length).toBeGreaterThanOrEqual(5);
      expect(rows.every((r) => r.name.includes(word))).toBe(true);
    });
  });

  it('typo fallback: finds the same foods through the trigram index without a table scan', async () => {
    await asUser(db, USER_A, async () => {
      await db.query(`select * from public.search_foods($1)`, [typo]);
      const pages = await pagesTouched(`select * from public.search_foods('${typo}')`);
      expect(pages, `${pages} pages touched, heap has ${heapPages}`).toBeLessThan(heapPages * 0.1);
      const exact = (
        await db.query<{ id: string }>(`select id from public.search_foods($1, 100)`, [word])
      ).rows;
      const fuzzy = (
        await db.query<{ id: string }>(`select id from public.search_foods($1, 100)`, [typo])
      ).rows;
      expect(fuzzy.length).toBeGreaterThan(0);
      expect(exact.map((r) => r.id).filter((id) => !fuzzy.some((f) => f.id === id))).toEqual([]);
    });
  });

  it('no match: a tiny index probe', async () => {
    await asUser(db, USER_A, async () => {
      await db.query(`select * from public.search_foods('zzzxx')`);
      const pages = await pagesTouched(`select * from public.search_foods('zzzxx')`);
      expect(pages, `${pages} pages touched, heap has ${heapPages}`).toBeLessThan(heapPages * 0.1);
    });
  });

  it('a common word is capped at max_results and ranked descending', async () => {
    const rows = await asUser(
      db,
      USER_A,
      async () =>
        (
          await db.query<{ name: string; rank: number }>(
            `select name, rank from public.search_foods('raw', 25)`,
          )
        ).rows,
    );
    expect(rows).toHaveLength(25);
    expect(rows.every((r) => /raw/.test(r.name))).toBe(true);
    const ranks = rows.map((r) => r.rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });
});
