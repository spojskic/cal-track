import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readCsv } from './csv';
import {
  catalogChecks,
  collectFoodNutrients,
  collectFoodPortions,
  loadFdc,
  readNutrientMeta,
} from './fdc';
import { FNDDS_FIXTURE, FOOD_NUTRIENT_CSV, MEASURE_UNIT_CSV, NUTRIENT_CSV, SR_FIXTURE } from './fixtures';
import { buildFdcRules } from './mapping';
import { memorySource, openSource } from './source';
import { makeStoredZip } from './test-utils';
import { newStats, type ImportFood } from './types';

async function* rows(text: string) {
  yield* readCsv(
    (async function* () {
      for (let i = 0; i < text.length; i += 11) yield text.slice(i, i + 11);
    })(),
  );
}

const byId = (foods: ImportFood[], id: string): ImportFood => {
  const f = foods.find((x) => x.sourceId === id);
  if (!f) throw new Error(`food ${id} not found`);
  return f;
};

describe('food_nutrient streaming and grouping', () => {
  it('groups unsorted rows per fdc_id for wanted foods and tracked nutrients only', async () => {
    const stats = newStats('fdc_sr_legacy');
    const wanted = new Set([1001, 1002]);
    const grouped = await collectFoodNutrients(rows(FOOD_NUTRIENT_CSV), wanted, new Set([1003, 1004, 1008]), stats);
    expect([...grouped.keys()].sort()).toEqual([1001, 1002]);
    // 1001: rows 2,3,4 are interleaved with other foods; the duplicate energy row (99999) is ignored
    expect(Object.fromEntries(grouped.get(1001) ?? [])).toEqual({ 1008: 52, 1003: 0.26, 1004: 0.17 });
    expect(Object.fromEntries(grouped.get(1002) ?? [])).toEqual({ 1004: 81.11, 1008: 717, 1003: 0.85 });
  });

  it('drops negative and non-numeric amounts and counts them', async () => {
    const stats = newStats('fdc_sr_legacy');
    const grouped = await collectFoodNutrients(rows(FOOD_NUTRIENT_CSV), new Set([1001]), new Set([1087, 1089, 1008]), stats);
    expect(Object.fromEntries(grouped.get(1001) ?? [])).toEqual({ 1008: 52 });
    expect(stats.invalidAmounts).toBe(2); // -5 and "abc"
  });

  it('stores small negative carbohydrate-by-difference as 0 and counts unmapped nutrients', async () => {
    const stats = newStats('fdc_sr_legacy');
    const csv = [
      '"id","fdc_id","nutrient_id","amount"',
      '"1","1","1005","-0.428"',
      '"2","2","1005","-3"',
      '"3","1","1087","-0.4"',
      '"4","1","1002","0.2"',
      '"5","2","1002","0.3"',
      '"6","3","1002","9"', // food not wanted: not counted
    ].join('\n');
    const grouped = await collectFoodNutrients(rows(csv), new Set([1, 2]), new Set([1005, 1087]), stats);
    expect(grouped.get(1)?.get(1005)).toBe(0);
    expect(grouped.get(2)?.has(1005) ?? false).toBe(false);
    expect(grouped.get(1)?.has(1087) ?? false).toBe(false);
    expect(stats.clampedAmounts).toBe(1);
    expect(stats.invalidAmounts).toBe(2);
    expect(stats.unmapped.get(1002)?.count).toBe(2);
  });

  it('does not buffer foods that are not wanted', async () => {
    const stats = newStats('fdc_sr_legacy');
    const grouped = await collectFoodNutrients(rows(FOOD_NUTRIENT_CSV), new Set([424242]), new Set([1008]), stats);
    expect(grouped.size).toBe(0);
  });

  it('reads portion rows only for wanted foods', async () => {
    const stats = newStats('fdc_sr_legacy');
    const { FOOD_PORTION_CSV } = await import('./fixtures');
    const units = new Map([['1000', 'cup'], ['1001', 'tablespoon'], ['9999', 'undetermined']]);
    const grouped = await collectFoodPortions(rows(FOOD_PORTION_CSV), new Set([1001]), units, stats);
    expect([...grouped.keys()]).toEqual([1001]);
    expect(grouped.get(1001)?.map((p) => p.label)).toEqual(['1 medium (3" dia)', '1 cup, chopped']);
    expect(stats.portionsDropped).toBe(1); // grams 0
  });
});

describe('nutrient.csv', () => {
  it('reads unit and number, and the importer rules match the real file layout', async () => {
    const meta = await readNutrientMeta(rows(NUTRIENT_CSV));
    expect(meta.get(1008)).toEqual({ name: 'Energy', unit: 'KCAL', nbr: '208' });
    expect(meta.get(1062)?.unit).toBe('kJ');
  });

  it('reports ids missing from the file and unit mismatches', async () => {
    const meta = await readNutrientMeta(rows(NUTRIENT_CSV));
    const warnings = catalogChecks(meta, buildFdcRules());
    expect(warnings.some((w) => /not present in nutrient\.csv/.test(w))).toBe(true);

    const odd = new Map(meta);
    odd.set(1093, { name: 'Sodium, Na', unit: 'PH', nbr: '307' });
    odd.set(1062, { name: 'Energy', unit: 'KCAL', nbr: '268' });
    const w2 = catalogChecks(odd, buildFdcRules());
    expect(w2.some((w) => w.includes('1093') && w.includes('cannot convert'))).toBe(true);
    expect(w2.some((w) => w.includes('1062') && w.includes('expected kj'))).toBe(true);
  });

  it('returns no warnings for an empty nutrient table', () => {
    expect(catalogChecks(new Map(), buildFdcRules())).toEqual([]);
  });
});

describe('loadFdc (SR Legacy fixture)', () => {
  it('imports the right foods with mapped nutrients, categories, portions and quality filters', async () => {
    const { foods, stats } = await loadFdc(memorySource(SR_FIXTURE), { dataset: 'sr_legacy' });

    expect(stats.foodsFound).toBe(9); // branded food 1006 is ignored
    expect(stats.kept).toBe(7);
    expect(foods.map((f) => f.sourceId)).toEqual(['1001', '1002', '1004', '1007', '1008', '1009', '1010']);
    expect(stats.dropped).toMatchObject({ no_energy: 1, impossible_macros: 1, no_name: 0, impossible_energy: 0 });

    const apple = byId(foods, '1001');
    expect(apple).toMatchObject({
      source: 'fdc_sr_legacy',
      kind: 'generic',
      name: 'Apples, raw, with skin', // whitespace collapsed
      category: 'Fruits and Fruit Juices',
      carbBasis: 'includes_fiber',
    });
    expect(apple.nutrients).toEqual({
      ENERGY_KCAL: 52,
      PROTEIN_G: 0.26,
      FAT_G: 0.17,
      CARBS_G: 13.81,
      FIBER_G: 2.4,
      SODIUM_MG: 1,
      SUGARS_G: 10.39,
    });
    expect('CALCIUM_MG' in apple.nutrients).toBe(false); // negative amount dropped, stays unknown
    expect('IRON_MG' in apple.nutrients).toBe(false); // non-numeric dropped
    expect(apple.completeness).toBeGreaterThan(0);
    expect(apple.completeness).toBeLessThan(0.2);
    expect(apple.portions).toEqual([
      { label: '1 cup, chopped', amount: 1, unit: 'cup', grams: 125, sortOrder: 0 },
      { label: '1 medium (3" dia)', amount: 1, unit: 'medium (3" dia)', grams: 182, sortOrder: 1 },
      { label: '100 g', amount: 100, unit: 'g', grams: 100, sortOrder: 2 },
    ]);

    const butter = byId(foods, '1002');
    expect(butter.nutrients.VITAMIN_D_UG).toBe(0); // explicit zero is kept
    expect(butter.nutrients.SODIUM_MG).toBe(643);
    expect(butter.portions.map((p) => p.label)).toEqual(['1 tablespoon', '100 g']);

    // fallbacks
    expect(byId(foods, '1004').nutrients.ENERGY_KCAL).toBe(130); // 544 kJ / 4.184
    expect(byId(foods, '1007').nutrients.VITAMIN_D_UG).toBe(5); // 200 IU / 40
    expect(byId(foods, '1008').nutrients.ENERGY_KCAL).toBe(200); // Atwater specific
    expect(byId(foods, '1009').nutrients.VITAMIN_D_UG).toBe(2); // ug beats IU
    expect(byId(foods, '1010').nutrients.ENERGY_KCAL).toBe(165); // from macros

    expect(stats.energySources).toEqual({ kcal: 4, atwater_specific: 1, atwater_general: 0, kj: 1, macros: 1 });
    expect(stats.nutrientEntries).toBe(foods.reduce((a, f) => a + Object.keys(f.nutrients).length, 0));
    expect(stats.rowsRead['food_nutrient.csv']).toBe(42);
  });

  it('never stores computed nutrients', async () => {
    const { foods } = await loadFdc(memorySource(SR_FIXTURE), { dataset: 'sr_legacy' });
    for (const f of foods) {
      expect('NET_CARBS_G' in f.nutrients).toBe(false);
      expect('OMEGA3_G' in f.nutrients).toBe(false);
      expect('OMEGA6_G' in f.nutrients).toBe(false);
    }
  });

  it('honours --limit (first N foods in food.csv order)', async () => {
    const { foods, stats } = await loadFdc(memorySource(SR_FIXTURE), { dataset: 'sr_legacy', limit: 2 });
    expect(foods.map((f) => f.sourceId)).toEqual(['1001', '1002']);
    expect(stats.foodsFound).toBe(2);
  });

  it('warns and returns nothing when the data_type has no foods', async () => {
    const { foods, stats } = await loadFdc(memorySource(SR_FIXTURE), { dataset: 'foundation' });
    expect(foods).toEqual([]);
    expect(stats.warnings.some((w) => w.includes('foundation_food'))).toBe(true);
  });

  it('fails clearly when the archive misses food.csv', async () => {
    const { 'food.csv': _drop, ...rest } = SR_FIXTURE;
    await expect(loadFdc(memorySource(rest), { dataset: 'sr_legacy' })).rejects.toThrow(/food\.csv not found/);
  });

  it('works without food_portion.csv (only 100 g portions)', async () => {
    const { 'food_portion.csv': _drop, ...rest } = SR_FIXTURE;
    const { foods, stats } = await loadFdc(memorySource(rest), { dataset: 'sr_legacy' });
    expect(foods.every((f) => f.portions.length === 1 && f.portions[0]?.label === '100 g')).toBe(true);
    expect(stats.warnings.some((w) => w.includes('food_portion.csv'))).toBe(true);
  });

  it('works with a measure_unit.csv that only has id,name', async () => {
    expect(MEASURE_UNIT_CSV.split('\n')[0]).toBe('"id","name"');
  });
});

describe('loadFdc (FNDDS fixture)', () => {
  it('uses fdc_id as source_id, WWEIA categories and portion_description labels', async () => {
    const { foods, stats } = await loadFdc(memorySource(FNDDS_FIXTURE), { dataset: 'fndds' });
    expect(stats.foodsFound).toBe(3);
    expect(foods.map((f) => f.sourceId)).toEqual(['2001', '2002', '2003']);
    expect(foods.every((f) => f.source === 'fdc_fndds' && f.kind === 'generic')).toBe(true);

    const milk = byId(foods, '2001');
    expect(milk.category).toBe('Milk, whole');
    expect(milk.portions.map((p) => [p.label, p.grams])).toEqual([
      ['1 cup', 244],
      ['1 fl oz', 30.5],
      ['100 g', 100],
    ]); // "Quantity not specified" dropped
    expect(byId(foods, '2002').category).toBe('Apples');
    expect(byId(foods, '2002').portions[0]?.label).toBe('1 medium');
    expect(byId(foods, '2003').category).toBe('Coffee'); // text in food.csv.food_category_id
  });
});

describe('zip and directory sources', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  async function expected() {
    return (await loadFdc(memorySource(SR_FIXTURE), { dataset: 'sr_legacy' })).foods;
  }

  it('reads an extracted directory (nested release folder, any file-name case)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cal-importer-dir-'));
    dirs.push(root);
    const nested = join(root, 'FoodData_Central_sr_legacy_food_csv_2018-04');
    await mkdir(nested, { recursive: true });
    for (const [name, content] of Object.entries(SR_FIXTURE)) {
      await writeFile(join(nested, name.replace('food_nutrient', 'Food_Nutrient')), content);
    }
    const src = await openSource(root);
    try {
      const { foods } = await loadFdc(src, { dataset: 'sr_legacy' });
      expect(foods).toEqual(await expected());
    } finally {
      await src.close();
    }
  });

  it('streams the needed entries out of a .zip without extracting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cal-importer-zip-'));
    dirs.push(root);
    const top = 'FoodData_Central_sr_legacy_food_csv_2018-04/';
    const files: Record<string, string> = { [top]: '', '__MACOSX/._food.csv': 'junk' };
    for (const [name, content] of Object.entries(SR_FIXTURE)) files[top + name] = content;
    files[`${top}Download API Field Descriptions.xlsx`] = 'not a csv';
    const zipPath = join(root, 'sr.zip');
    await writeFile(zipPath, makeStoredZip(files));

    const src = await openSource(zipPath);
    try {
      expect(src.kind).toBe('zip');
      expect(src.has('food_nutrient.csv')).toBe(true);
      expect(src.list()).not.toContain('downloadapifielddescriptions'); // only .csv entries are indexed
      const { foods, stats } = await loadFdc(src, { dataset: 'sr_legacy' });
      expect(foods).toEqual(await expected());
      expect(stats.kept).toBe(7);
    } finally {
      await src.close();
    }
  });

  it('rejects unsupported paths', async () => {
    await expect(openSource('/definitely/not/here.zip')).rejects.toThrow(/Path not found/);
    const root = await mkdtemp(join(tmpdir(), 'cal-importer-bad-'));
    dirs.push(root);
    const file = join(root, 'x.txt');
    await writeFile(file, 'x');
    await expect(openSource(file)).rejects.toThrow(/Expected a \.zip/);
  });
});
