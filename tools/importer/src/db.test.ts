import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FOODS_CONFLICT_TARGET,
  buildFoodsUpsert,
  buildPgConfig,
  buildPortionsInsert,
  getDatabaseSizeMb,
  redactSecrets,
  urlSecrets,
  writeFoods,
} from './db';
import { loadFdc } from './fdc';
import { SR_FIXTURE } from './fixtures';
import { memorySource } from './source';
import { FakePg } from './test-utils';
import type { ImportFood } from './types';

function food(id: string, over: Partial<ImportFood> = {}): ImportFood {
  return {
    source: 'fdc_sr_legacy',
    sourceId: id,
    kind: 'generic',
    name: `Food ${id}`,
    category: 'Cat',
    nutrients: { ENERGY_KCAL: 52, PROTEIN_G: 0.3 },
    completeness: 0.0233,
    carbBasis: 'includes_fiber',
    portions: [
      { label: '1 cup', amount: 1, unit: 'cup', grams: 240, sortOrder: 0 },
      { label: '100 g', amount: 100, unit: 'g', grams: 100, sortOrder: 1 },
    ],
    ...over,
  };
}

const normalizeSql = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

describe('SQL builders', () => {
  it('upserts with the exact partial-index conflict target', () => {
    const q = buildFoodsUpsert([food('1'), food('2')]);
    expect(q.text).toContain('INSERT INTO public.foods AS f (source, source_id, kind, name, category, nutrients, completeness, carb_basis)');
    expect(q.text).toContain('ON CONFLICT (source, source_id) WHERE source_id IS NOT NULL AND owner_id IS NULL');
    expect(q.text).toContain('DO UPDATE SET');
    expect(q.text).toContain('IS DISTINCT FROM');
    expect(q.text).toMatch(/OR \(\(f\.nutrients, f\.completeness, f\.carb_basis\)\s+IS DISTINCT FROM .*AND NOT \(EXISTS/s);
    expect(q.text).toContain('RETURNING f.id, f.source, f.source_id, (f.xmax = 0) AS inserted');
    expect(q.text).toContain('$6::jsonb');
    expect(q.text).toContain('$14::jsonb'); // second row
    expect(q.values).toHaveLength(16);
    expect(q.values[5]).toBe('{"ENERGY_KCAL":52,"PROTEIN_G":0.3}');
    expect(q.values.slice(0, 5)).toEqual(['fdc_sr_legacy', '1', 'generic', 'Food 1', 'Cat']);
  });

  it('protects nutrients of foods referenced by diary entries / recipes', () => {
    const q = buildFoodsUpsert([food('1')]);
    expect(q.text).toContain('public.diary_entries');
    expect(q.text).toContain('public.recipe_ingredients');
    expect(q.text).toMatch(/nutrients = CASE WHEN \(EXISTS .* THEN f\.nutrients ELSE EXCLUDED\.nutrients END/s);
  });

  it('never interpolates data into the SQL text', () => {
    const q = buildFoodsUpsert([food("1'; DROP TABLE foods; --", { name: "Robert'); --" })]);
    expect(q.text).not.toContain('DROP TABLE');
    expect(q.text).not.toContain('Robert');
    expect(q.values).toContain("Robert'); --");
  });

  it('rejects empty batches', () => {
    expect(() => buildFoodsUpsert([])).toThrow();
    expect(() => buildPortionsInsert([])).toThrow();
  });

  it('inserts portions with 6 typed parameters per row', () => {
    const p = { label: '1 cup', amount: 1, unit: 'cup', grams: 240, sortOrder: 0 };
    const q = buildPortionsInsert([
      { foodId: 'a', portion: p },
      { foodId: 'b', portion: { ...p, amount: null, unit: null } },
    ]);
    expect(q.text).toContain('INSERT INTO public.food_portions (food_id, label, amount, unit, grams, sort_order)');
    expect(q.text).toContain('$1::uuid, $2::text, $3::numeric, $4::text, $5::numeric, $6::int');
    expect(q.text).toContain('$7::uuid');
    expect(q.values).toEqual(['a', '1 cup', 1, 'cup', 240, 0, 'b', '1 cup', null, null, 240, 0]);
  });

  it('conflict target matches the unique index in the foods migration', () => {
    const dir = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));
    let sql = '';
    try {
      const file = readdirSync(dir).find((f) => /foods\.sql$/.test(f));
      sql = file ? readFileSync(dir + file, 'utf8') : '';
    } catch {
      return; // migration directory not available in this checkout
    }
    if (sql === '') return;
    const m = /create unique index[^;]*foods_global_source_uidx[^;]*;/i.exec(sql);
    expect(m, 'foods_global_source_uidx not found in the migration').not.toBeNull();
    const index = normalizeSql(m?.[0] ?? '');
    // "(source, source_id) where source_id is not null and owner_id is null"
    expect(index).toContain(normalizeSql(FOODS_CONFLICT_TARGET));
  });
});

describe('writeFoods with a fake client', () => {
  it('inserts foods and portions in one transaction per batch', async () => {
    const db = new FakePg();
    const stats = await writeFoods(db, [food('1'), food('2'), food('3')], { batchSize: 2 });
    expect(stats).toMatchObject({ foods: 3, inserted: 3, updated: 0, unchanged: 0, batches: 2, portionRowsInserted: 6 });
    expect(db.count('BEGIN')).toBe(2);
    expect(db.commits).toBe(2);
    expect(db.rollbacks).toBe(0);
    expect(db.foods.size).toBe(3);
    expect(db.portions).toHaveLength(6);
    // every upsert statement carries the partial-index conflict target
    const upserts = db.queries.filter((q) => q.text.startsWith('INSERT INTO public.foods'));
    expect(upserts).toHaveLength(2);
    for (const u of upserts) expect(u.text).toContain('ON CONFLICT (source, source_id) WHERE source_id IS NOT NULL AND owner_id IS NULL');
    // statements are issued in order BEGIN, upsert, ids, portions lookup, delete, insert, COMMIT
    expect(db.queries.slice(0, 7).map((q) => q.text.split(/\s+/).slice(0, 3).join(' '))).toEqual([
      'BEGIN',
      'INSERT INTO public.foods',
      'SELECT f.id, f.source,',
      'SELECT food_id, label,',
      'DELETE FROM public.food_portions',
      'INSERT INTO public.food_portions',
      'COMMIT',
    ]);
  });

  it('is idempotent: an identical re-run changes and rewrites nothing', async () => {
    const db = new FakePg();
    const foods = [food('1'), food('2'), food('3')];
    await writeFoods(db, foods);
    const idsBefore = [...db.foods.values()].map((f) => f.id).sort();
    const queriesBefore = db.queries.length;

    const again = await writeFoods(db, foods);
    expect(again).toMatchObject({ inserted: 0, updated: 0, unchanged: 3, portionsReplacedFor: 0, portionRowsInserted: 0 });
    expect([...db.foods.values()].map((f) => f.id).sort()).toEqual(idsBefore); // same row ids
    expect(db.portions).toHaveLength(6);
    const rerun = db.queries.slice(queriesBefore);
    expect(rerun.some((q) => q.text.startsWith('DELETE FROM public.food_portions'))).toBe(false);
    expect(rerun.some((q) => q.text.startsWith('INSERT INTO public.food_portions'))).toBe(false);
  });

  it('is idempotent on a real parsed dataset', async () => {
    const { foods } = await loadFdc(memorySource(SR_FIXTURE), { dataset: 'sr_legacy' });
    const db = new FakePg();
    const first = await writeFoods(db, foods);
    const second = await writeFoods(db, foods);
    expect(first.inserted).toBe(foods.length);
    expect(second).toMatchObject({ inserted: 0, updated: 0, unchanged: foods.length, portionRowsInserted: 0 });
    expect(db.foods.size).toBe(foods.length);
  });

  it('updates changed foods and replaces only changed portions', async () => {
    const db = new FakePg();
    await writeFoods(db, [food('1'), food('2')]);
    const stats = await writeFoods(db, [
      food('1', { nutrients: { ENERGY_KCAL: 60 }, completeness: 0.02 }),
      food('2', { portions: [{ label: '1 slice', amount: 1, unit: 'slice', grams: 30, sortOrder: 0 }, { label: '100 g', amount: 100, unit: 'g', grams: 100, sortOrder: 1 }] }),
    ]);
    expect(stats).toMatchObject({ inserted: 0, updated: 1, unchanged: 1, portionsReplacedFor: 1, portionRowsInserted: 2 });
    expect(db.foods.get('fdc_sr_legacy\u0000' + '1')?.nutrients).toEqual({ ENERGY_KCAL: 60 });
    expect(db.portionsOf('fdc_sr_legacy', '2').map((p) => p.label)).toEqual(['1 slice', '100 g']);
    expect(db.portionsOf('fdc_sr_legacy', '1').map((p) => p.label)).toEqual(['1 cup', '100 g']);
    expect(db.portions).toHaveLength(4);
  });

  it('renames/recategorises foods without touching their portions', async () => {
    const db = new FakePg();
    await writeFoods(db, [food('1')]);
    const stats = await writeFoods(db, [food('1', { name: 'Renamed', category: 'Other' })]);
    expect(stats).toMatchObject({ updated: 1, portionsReplacedFor: 0 });
    expect(db.foods.get('fdc_sr_legacy\u00001')).toMatchObject({ name: 'Renamed', category: 'Other' });
  });

  it('keeps nutrients of referenced foods (immutable history) but refreshes the name', async () => {
    const db = new FakePg();
    await writeFoods(db, [food('1')]);
    const id = [...db.foods.values()][0]?.id as string;
    db.referencedIds.add(id);
    const stats = await writeFoods(db, [food('1', { name: 'Renamed', nutrients: { ENERGY_KCAL: 99 } })]);
    expect(stats.updated).toBe(1);
    const row = db.foods.get('fdc_sr_legacy\u00001');
    expect(row?.name).toBe('Renamed');
    expect(row?.nutrients).toEqual({ ENERGY_KCAL: 52, PROTEIN_G: 0.3 });
  });

  it('stays idempotent for referenced foods whose source nutrients differ (nothing to write)', async () => {
    const db = new FakePg();
    await writeFoods(db, [food('1')]);
    db.referencedIds.add([...db.foods.values()][0]?.id as string);
    const stale = [food('1', { nutrients: { ENERGY_KCAL: 99 } })];
    expect(await writeFoods(db, stale)).toMatchObject({ updated: 0, unchanged: 1 });
    expect(db.foods.get('fdc_sr_legacy\u00001')?.nutrients).toEqual({ ENERGY_KCAL: 52, PROTEIN_G: 0.3 });
  });

  it('separates the same source_id across sources', async () => {
    const db = new FakePg();
    await writeFoods(db, [food('1'), food('1', { source: 'fdc_foundation' }), food('1', { source: 'cnf' })]);
    expect(db.foods.size).toBe(3);
  });

  it('ignores duplicate (source, source_id) inputs instead of failing the upsert', async () => {
    const db = new FakePg();
    const stats = await writeFoods(db, [food('1'), food('1', { name: 'Last wins' })]);
    expect(stats).toMatchObject({ foods: 1, inserted: 1, duplicatesInInput: 1 });
    expect(db.foods.get('fdc_sr_legacy\u00001')?.name).toBe('Last wins');
  });

  it('rolls the batch back and reports it when a statement fails', async () => {
    const db = new FakePg();
    await writeFoods(db, [food('9')]);
    db.failWhen = (text) => text.startsWith('INSERT INTO public.food_portions');
    await expect(writeFoods(db, [food('1'), food('2')], { batchSize: 10 })).rejects.toThrow(/batch 1 \(foods 1-2\) failed: simulated failure/);
    expect(db.rollbacks).toBe(1);
    expect(db.foods.size).toBe(1); // nothing from the failed batch persisted
    expect(db.portions).toHaveLength(2);
  });

  it('handles an empty input without touching the database', async () => {
    const db = new FakePg();
    const stats = await writeFoods(db, []);
    expect(stats).toMatchObject({ foods: 0, batches: 0 });
    expect(db.queries).toEqual([]);
  });

  it('reads the database size in MB', async () => {
    expect(await getDatabaseSizeMb(new FakePg())).toBe(50);
    expect(await getDatabaseSizeMb({ query: async () => { throw new Error('no'); } })).toBeNull();
  });
});

describe('connection hygiene', () => {
  const url = 'postgresql://postgres:s3cr%40t!@db.abcdefgh.supabase.co:5432/postgres?sslmode=require';

  it('uses TLS for remote hosts and not for localhost; strips sslmode from the URL', () => {
    const remote = buildPgConfig(url);
    expect(remote.ssl).toEqual({ rejectUnauthorized: false });
    expect(remote.connectionString).not.toContain('sslmode');
    expect(buildPgConfig('postgresql://postgres:pw@localhost:54322/postgres').ssl).toBe(false);
    expect(buildPgConfig('postgresql://postgres:pw@db.x.supabase.co/postgres?sslmode=disable').ssl).toBe(false);
    expect(buildPgConfig('postgresql://postgres:pw@localhost/postgres', true).ssl).toEqual({ rejectUnauthorized: false });
  });

  it('redacts the URL and the password (encoded and decoded) from messages', () => {
    const secrets = urlSecrets(url);
    expect(secrets).toContain('s3cr%40t!');
    expect(secrets).toContain('s3cr@t!');
    const msg = `connect failed for ${url} (password s3cr@t! / s3cr%40t!)`;
    const out = redactSecrets(msg, secrets);
    expect(out).not.toContain('s3cr');
    expect(out).not.toContain('postgresql://');
  });

  it('copes with an unparseable URL', () => {
    expect(urlSecrets('not a url')).toEqual(['not a url']);
  });
});
