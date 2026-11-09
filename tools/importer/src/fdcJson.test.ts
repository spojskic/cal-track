import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { main } from './cli';
import { loadFdc } from './fdc';
import { splitJsonArray, loadFdcJson } from './fdcJson';
import { REAL_FOUNDATION_JSON_NAME, SR_FIXTURE, realFoundationJson, realSrLegacyFiles } from './fixtures';
import { loadFdcArchive } from './load';
import { formatReport, summarize } from './report';
import { memorySource, openSource, withSource } from './source';
import { FakePg, makeStoredZip } from './test-utils';
import { writeFoods } from './db';
import type { ImportFood } from './types';

// ---------------------------------------------------------------- helpers

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

async function* chunked(text: string, size: number): AsyncGenerator<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

const nutrient = (id: number, unitName: string, amount: number | undefined, name = `n${id}`) => ({
  type: 'FoodNutrient',
  id: 1000000 + id,
  nutrient: { id, number: String(id), name, rank: 1, unitName },
  ...(amount === undefined ? {} : { amount }),
});

interface FoodOpts {
  fdcId?: number;
  description?: string;
  dataType?: string;
  foodCategory?: unknown;
  wweiaFoodCategory?: unknown;
  foodNutrients?: unknown[];
  foodPortions?: unknown[];
}

const jsonFood = (o: FoodOpts = {}) => ({
  fdcId: o.fdcId ?? 100,
  description: o.description ?? 'Test food',
  dataType: o.dataType ?? 'Foundation',
  foodCategory: o.foodCategory ?? { description: 'Test category' },
  ...(o.wweiaFoodCategory ? { wweiaFoodCategory: o.wweiaFoodCategory } : {}),
  foodNutrients: o.foodNutrients ?? [
    nutrient(1008, 'kcal', 100),
    nutrient(1003, 'g', 5),
    nutrient(1004, 'g', 2),
    nutrient(1005, 'g', 15),
  ],
  foodPortions: o.foodPortions ?? [],
});

const doc = (key: string, foods: unknown[]): Record<string, string> => ({
  'FoodData_Central_test_food_json.json': JSON.stringify({ [key]: foods }),
});

const byId = (foods: ImportFood[], id: string): ImportFood => {
  const f = foods.find((x) => x.sourceId === id);
  if (!f) throw new Error(`food ${id} not found`);
  return f;
};

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'cal-importer-json-'));
  dirs.push(d);
  return d;
};

// ---------------------------------------------------------------- splitter

describe('splitJsonArray', () => {
  const sample = JSON.stringify({
    meta: { note: 'x' },
    SurveyFoods: [
      { a: 1, s: 'brace } and ] and { [ in a string', t: 'quote \\" and backslash \\\\', n: { deep: [1, [2, { x: '}' }]] } },
      { b: [] },
      { c: 'unicode \u00b5g \u2603' },
    ],
    other: [{ z: 1 }],
  });
  const expected = (JSON.parse(sample) as { SurveyFoods: unknown[] }).SurveyFoods;

  it('yields every element as its own JSON text, whatever the chunk boundaries', async () => {
    for (const size of [1, 2, 3, 5, 7, 13, 64, 10_000]) {
      const items = await collect(splitJsonArray(chunked(sample, size), (k) => k === 'SurveyFoods'));
      expect(items.map((i) => i.key)).toEqual(['SurveyFoods', 'SurveyFoods', 'SurveyFoods']);
      expect(items.map((i) => JSON.parse(i.json)), `chunk size ${size}`).toEqual(expected);
    }
  });

  it('skips arrays whose key is not accepted and stops after the first accepted array', async () => {
    const text = '{"first":[{"a":1}],"FoundationFoods":[{"b":2},{"b":3}],"FoundationFoods2":[{"c":4}]}';
    const items = await collect(splitJsonArray(chunked(text, 4), (k) => k === 'FoundationFoods'));
    expect(items.map((i) => JSON.parse(i.json))).toEqual([{ b: 2 }, { b: 3 }]);
  });

  it('accepts a top-level array (key "")', async () => {
    const items = await collect(splitJsonArray(chunked('[{"a":1}, {"a":2}]', 3)));
    expect(items.map((i) => [i.key, JSON.parse(i.json)])).toEqual([['', { a: 1 }], ['', { a: 2 }]]);
  });

  it('yields nothing for an empty array or a document without a wanted array', async () => {
    expect(await collect(splitJsonArray(chunked('{"FoundationFoods":[]}', 5), () => true))).toEqual([]);
    expect(await collect(splitJsonArray(chunked('{"x":1}', 5), () => true))).toEqual([]);
  });

  it('splits the real Foundation excerpt exactly like JSON.parse', async () => {
    const text = realFoundationJson();
    const whole = (JSON.parse(text) as { FoundationFoods: unknown[] }).FoundationFoods;
    const items = await collect(splitJsonArray(chunked(text, 4096), (k) => k === 'FoundationFoods'));
    expect(items.map((i) => JSON.parse(i.json))).toEqual(whole);
  });
});

// ---------------------------------------------------------------- loader

describe('loadFdcJson', () => {
  it('detects the dataset from the top-level key and maps source / kind / source_id', async () => {
    for (const [key, dataset, source] of [
      ['FoundationFoods', 'foundation', 'fdc_foundation'],
      ['SRLegacyFoods', 'sr_legacy', 'fdc_sr_legacy'],
      ['SurveyFoods', 'fndds', 'fdc_fndds'],
    ] as const) {
      const res = await loadFdcJson(memorySource(doc(key, [jsonFood({ fdcId: 321358 })])));
      expect(res.dataset).toBe(dataset);
      expect(res.stats.source).toBe(source);
      expect(res.foods[0]).toMatchObject({ source, sourceId: '321358', kind: 'generic', carbBasis: 'includes_fiber' });
    }
  });

  it('rejects a --dataset that contradicts the file, branded files and non-FDC JSON', async () => {
    await expect(
      loadFdcJson(memorySource(doc('SurveyFoods', [jsonFood()])), { dataset: 'sr_legacy' }),
    ).rejects.toThrow(/SurveyFoods.*fndds.*--dataset sr_legacy/);
    await expect(loadFdcJson(memorySource(doc('BrandedFoods', [jsonFood()])))).rejects.toThrow(/out of scope/);
    await expect(loadFdcJson(memorySource({ 'x.json': '{"hello":[1,2]}' }))).rejects.toThrow(/no FoundationFoods/);
    await expect(loadFdcJson(memorySource({ 'x.csv': 'a\n1\n' }))).rejects.toThrow(/No \.json file/);
    await expect(loadFdcJson(memorySource({ 'x.json': '{"FoundationFoods":[{"a":}]}' }))).rejects.toThrow(/invalid JSON in food #1/);
  });

  it('infers the dataset of a top-level array from food.dataType', async () => {
    const files = { 'search.json': JSON.stringify([jsonFood({ dataType: 'SR Legacy' })]) };
    expect((await loadFdcJson(memorySource(files))).dataset).toBe('sr_legacy');
    const unknown = { 'search.json': JSON.stringify([jsonFood({ dataType: 'Mystery' })]) };
    await expect(loadFdcJson(memorySource(unknown))).rejects.toThrow(/pass --dataset/);
    expect((await loadFdcJson(memorySource(unknown), { dataset: 'fndds' })).dataset).toBe('fndds');
  });

  it('maps nutrients by nutrient.id and normalises units (µg, mg, g, kJ, IU)', async () => {
    const food = jsonFood({
      foodNutrients: [
        nutrient(1062, 'kJ', 418.4), // energy only in kJ -> 100 kcal
        nutrient(1003, 'g', 5),
        nutrient(1004, 'g', 2),
        nutrient(1005, 'g', 15),
        nutrient(1093, 'g', 0.643), // sodium delivered in g -> 643 mg
        nutrient(1103, 'mg', 0.0123), // selenium in mg -> 12.3 ug
        nutrient(1178, '\u00b5g', 0.16), // B12, micro sign
        nutrient(1162, 'MG', 38), // upper case
        nutrient(1110, 'IU', 200), // vitamin D only as IU -> 5 ug
        nutrient(2000, 'g', 7.5),
      ],
    });
    const { foods, stats } = await loadFdcJson(memorySource(doc('FoundationFoods', [food])));
    expect(foods[0]?.nutrients).toEqual({
      ENERGY_KCAL: 100,
      PROTEIN_G: 5,
      FAT_G: 2,
      CARBS_G: 15,
      SODIUM_MG: 643,
      SELENIUM_UG: 12.3,
      B12_UG: 0.16,
      VITAMIN_C_MG: 38,
      VITAMIN_D_UG: 5,
      SUGARS_G: 7.5,
    });
    expect(stats.energySources.kj).toBe(1);
  });

  it('follows the energy fallback chain 1008 > 2048 > 2047 > kJ > macros', async () => {
    const energy = (e: unknown[]) =>
      loadFdcJson(memorySource(doc('FoundationFoods', [jsonFood({ foodNutrients: [...e, nutrient(1003, 'g', 5), nutrient(1004, 'g', 2), nutrient(1005, 'g', 15)] })])));
    expect((await energy([nutrient(1008, 'kcal', 90), nutrient(2048, 'kcal', 91), nutrient(2047, 'kcal', 92)])).foods[0]?.nutrients.ENERGY_KCAL).toBe(90);
    expect((await energy([nutrient(2048, 'kcal', 91), nutrient(2047, 'kcal', 92)])).foods[0]?.nutrients.ENERGY_KCAL).toBe(91);
    expect((await energy([nutrient(2047, 'kcal', 92)])).foods[0]?.nutrients.ENERGY_KCAL).toBe(92);
    expect((await energy([nutrient(1062, 'kJ', 418.4)])).foods[0]?.nutrients.ENERGY_KCAL).toBe(100);
    expect((await energy([])).foods[0]?.nutrients.ENERGY_KCAL).toBe(98); // 4*5 + 9*2 + 4*15 - computed from macros
  });

  it('skips entries without amount, rejects negatives, first usable entry wins for duplicates', async () => {
    const food = jsonFood({
      foodNutrients: [
        nutrient(1008, 'kcal', 100),
        nutrient(1003, 'g', 5),
        nutrient(1004, 'g', 2),
        nutrient(1005, 'g', 15),
        nutrient(1087, 'mg', undefined), // Foundation "Vitamin A" style: no amount at all
        nutrient(1089, 'mg', -3), // negative: dropped (not a carbs-by-difference value)
        nutrient(1090, 'mg', undefined), // duplicate: first entry has no amount ...
        nutrient(1090, 'mg', 20), // ... so the first USABLE one wins
        nutrient(1090, 'mg', 99),
        nutrient(1091, 'mg', 30),
        nutrient(1091, 'mg', 31),
      ],
    });
    const { foods, stats } = await loadFdcJson(memorySource(doc('FoundationFoods', [food])));
    const n = foods[0]?.nutrients;
    expect(n).toMatchObject({ MAGNESIUM_MG: 20, PHOSPHORUS_MG: 30 });
    expect('CALCIUM_MG' in (n ?? {})).toBe(false);
    expect('IRON_MG' in (n ?? {})).toBe(false);
    expect(stats.invalidAmounts).toBe(1);
  });

  it('stores tiny negative carbohydrate-by-difference as 0 (raw meat) and counts it', async () => {
    const food = jsonFood({
      foodNutrients: [nutrient(2048, 'kcal', 120), nutrient(1003, 'g', 20), nutrient(1004, 'g', 3), nutrient(1005, 'g', -0.428)],
    });
    const { foods, stats } = await loadFdcJson(memorySource(doc('FoundationFoods', [food])));
    expect(foods[0]?.nutrients.CARBS_G).toBe(0);
    expect(stats.clampedAmounts).toBe(1);
    const big = jsonFood({ foodNutrients: [nutrient(1008, 'kcal', 120), nutrient(1005, 'g', -5), nutrient(1003, 'g', 5), nutrient(1004, 'g', 5)] });
    const res = await loadFdcJson(memorySource(doc('FoundationFoods', [big])));
    expect('CARBS_G' in (res.foods[0]?.nutrients ?? {})).toBe(false); // -5 g is a data error, not noise
  });

  it('uses the Foundation-specific fallbacks verified on the real data', async () => {
    const food = jsonFood({
      foodNutrients: [
        nutrient(1085, 'g', 94.5, 'Total fat (NLEA)'), // only fat entry of oils
        nutrient(1177, '\u00b5g', 100, 'Folate, total'),
        nutrient(2023, 'g', 0.1, 'PUFA 20:5c'),
        nutrient(2025, 'g', 0.2, 'PUFA 22:6 c'),
        nutrient(2024, 'g', 0.05, 'PUFA 22:5 c'),
        nutrient(2022, 'g', 0.03, 'PUFA 20:4c'),
        nutrient(2033, 'g', 3, 'Total dietary fiber (AOAC 2011.25)'),
        nutrient(1050, 'g', 2, 'Carbohydrate, by summation'),
      ],
    });
    const { foods } = await loadFdcJson(memorySource(doc('FoundationFoods', [food])));
    expect(foods[0]?.nutrients).toMatchObject({
      FAT_G: 94.5,
      FOLATE_UG: 100,
      EPA_G: 0.1,
      DHA_G: 0.2,
      DPA_G: 0.05,
      ARACHIDONIC_G: 0.03,
      FIBER_G: 3,
      CARBS_G: 2,
    });
    // a pure oil has no protein / carbs entries; fat alone (>= 90 g) is enough for an energy estimate
    const oil = jsonFood({ foodNutrients: [nutrient(1085, 'g', 94.5)] });
    const res = await loadFdcJson(memorySource(doc('FoundationFoods', [oil])));
    expect(res.foods[0]?.nutrients.ENERGY_KCAL).toBe(850.5);
    expect(res.stats.energySources.macros).toBe(1);
  });

  it('keeps 1004 over 1085 and 1190 over 1177 when both exist', async () => {
    const food = jsonFood({
      foodNutrients: [nutrient(1008, 'kcal', 100), nutrient(1004, 'g', 10), nutrient(1085, 'g', 9), nutrient(1190, '\u00b5g', 50), nutrient(1177, '\u00b5g', 40)],
    });
    const { foods } = await loadFdcJson(memorySource(doc('SRLegacyFoods', [food])));
    expect(foods[0]?.nutrients).toMatchObject({ FAT_G: 10, FOLATE_UG: 50 });
  });

  it('counts source nutrients the catalog does not track', async () => {
    const food = jsonFood({
      foodNutrients: [nutrient(1008, 'kcal', 100), nutrient(1002, 'g', 0.5, 'Nitrogen'), nutrient(1265, 'g', 1, 'SFA 16:0')],
    });
    const { stats } = await loadFdcJson(memorySource(doc('FoundationFoods', [food, jsonFood({ fdcId: 101, foodNutrients: [nutrient(1008, 'kcal', 50), nutrient(1002, 'g', 0.1, 'Nitrogen')] })])));
    expect(stats.unmapped.get(1002)).toEqual({ name: 'Nitrogen', unit: 'g', count: 2 });
    expect(stats.unmapped.get(1265)?.count).toBe(1);
    expect(stats.unmapped.has(1008)).toBe(false);
  });

  it('builds portions from foodPortions: amount ?? value, unit name, modifier, portionDescription, gramWeight', async () => {
    const portions = [
      { amount: 2, value: 2, measureUnit: { id: 1001, name: 'tablespoon' }, modifier: '', gramWeight: 33.9, sequenceNumber: 2 },
      { value: 1, measureUnit: { id: 1000, name: 'cup' }, modifier: 'chopped', gramWeight: 125, sequenceNumber: 1 }, // value only
      { amount: 1, measureUnit: { id: 1000, name: 'cup' }, portionDescription: 'shredded', gramWeight: 105, sequenceNumber: 3 },
      { amount: 1, measureUnit: { id: 1121, name: 'RACC' }, gramWeight: 30, sequenceNumber: 4 },
      { amount: 1, measureUnit: { id: 9999, name: 'undetermined' }, modifier: 'large', gramWeight: 50, sequenceNumber: 5 },
      { amount: 1, measureUnit: { id: 1000, name: 'cup' }, gramWeight: 0, sequenceNumber: 6 }, // dropped
      { amount: 1, measureUnit: { id: 9999, name: 'undetermined' }, gramWeight: 40, sequenceNumber: 7 }, // no label: dropped
    ];
    const { foods, stats } = await loadFdcJson(memorySource(doc('FoundationFoods', [jsonFood({ foodPortions: portions })])));
    expect(foods[0]?.portions.map((p) => [p.label, p.grams, p.sortOrder])).toEqual([
      ['1 cup, chopped', 125, 0],
      ['2 tablespoon', 33.9, 1], // grams = mass of `amount` units
      ['1 cup, shredded', 105, 2],
      ['1 serving (RACC)', 30, 3],
      ['1 large', 50, 4],
      ['100 g', 100, 5],
    ]);
    expect(foods[0]?.portions[1]).toMatchObject({ amount: 2, unit: 'tablespoon' });
    expect(stats.portionsDropped).toBe(2);
  });

  it('FNDDS: WWEIA category, portionDescription labels with unit "undetermined"', async () => {
    const food = jsonFood({
      fdcId: 2001,
      dataType: 'Survey (FNDDS)',
      foodCategory: undefined,
      wweiaFoodCategory: { wweiaFoodCategoryCode: 1004, wweiaFoodCategoryDescription: 'Milk, whole' },
      foodPortions: [
        { portionDescription: '1 cup', measureUnit: { id: 9999, name: 'undetermined' }, modifier: '8036', gramWeight: 244, sequenceNumber: 1, amount: 1 },
        { portionDescription: 'Quantity not specified', measureUnit: { id: 9999, name: 'undetermined' }, modifier: '9999', gramWeight: 244, sequenceNumber: 2 },
        { portionDescription: '1 fl oz', measureUnit: { id: 9999, name: 'undetermined' }, gramWeight: 30.5, sequenceNumber: 3, value: 1 },
      ],
    });
    const { foods } = await loadFdcJson(memorySource(doc('SurveyFoods', [{ ...food, foodCategory: undefined }])));
    expect(foods[0]?.category).toBe('Milk, whole');
    expect(foods[0]?.portions.map((p) => [p.label, p.grams])).toEqual([['1 cup', 244], ['1 fl oz', 30.5], ['100 g', 100]]);
  });

  it('category: foodCategory.description (or a plain string), name hygiene, foods without fdcId are not imported', async () => {
    const foods = [
      jsonFood({ fdcId: 1, description: '  Messy \u00a0  name ,', foodCategory: { description: 'Dairy and Egg Products' } }),
      jsonFood({ fdcId: 2, foodCategory: 'Plain string category' }),
      { ...jsonFood({ fdcId: 3 }), fdcId: undefined },
      jsonFood({ fdcId: 4, description: '   ' }),
    ];
    const res = await loadFdcJson(memorySource(doc('SRLegacyFoods', foods)));
    expect(res.foods.map((f) => [f.sourceId, f.name, f.category])).toEqual([
      ['1', 'Messy name', 'Dairy and Egg Products'],
      ['2', 'Test food', 'Plain string category'],
    ]);
    expect(res.stats.dropped.no_name).toBe(2);
    expect(res.stats.foodsFound).toBe(4);
  });

  it('drops foods without energy and honours --limit', async () => {
    const noEnergy = jsonFood({ fdcId: 7, foodNutrients: [nutrient(1051, 'g', 80), nutrient(1003, 'g', 1)] });
    const res = await loadFdcJson(memorySource(doc('FoundationFoods', [jsonFood({ fdcId: 5 }), noEnergy, jsonFood({ fdcId: 6 })])));
    expect(res.foods.map((f) => f.sourceId)).toEqual(['5', '6']);
    expect(res.stats.dropped.no_energy).toBe(1);
    const limited = await loadFdcJson(memorySource(doc('FoundationFoods', [jsonFood({ fdcId: 5 }), jsonFood({ fdcId: 6 })])), { limit: 1 });
    expect(limited.foods.map((f) => f.sourceId)).toEqual(['5']);
    expect(limited.stats.foodsFound).toBe(1);
  });
});

// -------------------------------------------------------- real excerpts

describe('real FDC excerpts', () => {
  const foundationFiles = { [REAL_FOUNDATION_JSON_NAME]: realFoundationJson() };

  it('real Foundation JSON: hummus, olive oil, chicken breast', async () => {
    const { foods, stats, dataset } = await loadFdcJson(memorySource(foundationFiles));
    expect(dataset).toBe('foundation');
    expect(stats.foodsFound).toBe(3);
    expect(foods).toHaveLength(3);
    expect(stats.unitMismatches).toBe(0);

    const hummus = byId(foods, '321358');
    expect(hummus).toMatchObject({ name: 'Hummus, commercial', category: 'Legumes and Legume Products', source: 'fdc_foundation' });
    expect(hummus.nutrients).toMatchObject({ ENERGY_KCAL: 229, PROTEIN_G: 7.35, FAT_G: 17.1, CARBS_G: 14.9, FIBER_G: 5.4, SODIUM_MG: 438 });
    expect(Object.keys(hummus.nutrients).length).toBeGreaterThan(40);
    expect(hummus.nutrients.FOLATE_UG).toBe(36); // Foundation has no DFE (1190): total folate 1177 is the fallback
    expect(hummus.nutrients.VITAMIN_E_MG).toBe(1.74);
    expect(hummus.nutrients.VITAMIN_C_MG).toBe(0); // an analysed zero stays 0
    expect('VITAMIN_D_UG' in hummus.nutrients).toBe(false); // not analysed: unknown, not 0
    expect(hummus.portions.map((p) => [p.label, p.grams])).toEqual([
      ['2 tablespoon', 33.9],
      ['1 serving (RACC)', 30],
      ['100 g', 100],
    ]);

    const oil = byId(foods, '748608');
    expect(oil.nutrients.FAT_G).toBe(93.7); // from "Total fat (NLEA)" 1085
    expect(oil.nutrients.ENERGY_KCAL).toBe(843.3); // 9 x fat: no energy entry in the file
    expect(oil.portions.map((p) => [p.label, p.grams])).toEqual([['100 milliliter', 90.7], ['100 g', 100]]);

    const chicken = byId(foods, '2727569');
    expect(chicken.nutrients.CARBS_G).toBe(0); // -0.428 g "by difference" is noise
    expect(chicken.nutrients.ENERGY_KCAL).toBe(133); // Atwater specific (2048) beats general (127)
    expect(stats.clampedAmounts).toBe(1);
    expect(stats.energySources).toMatchObject({ kcal: 1, atwater_specific: 1, atwater_general: 0, macros: 1 });
  });

  it('real SR Legacy CSV: butter, egg, apples (and --dataset is inferred from food.csv)', async () => {
    const src = memorySource(realSrLegacyFiles());
    const { foods, stats, dataset, format } = await loadFdcArchive(src, {});
    expect([dataset, format]).toEqual(['sr_legacy', 'csv']);
    expect(stats.foodsFound).toBe(3);
    expect(foods).toHaveLength(3);

    const butter = byId(foods, '173410');
    expect(butter).toMatchObject({ name: 'Butter, salted', category: 'Dairy and Egg Products', source: 'fdc_sr_legacy' });
    expect(butter.nutrients).toMatchObject({ ENERGY_KCAL: 717, PROTEIN_G: 0.85, FAT_G: 81.11, CARBS_G: 0.06, SODIUM_MG: 643 });
    expect(butter.portions.map((p) => p.label)).toEqual(['1 pat (1" sq, 1/3" high)', '1 tbsp', '1 cup', '1 stick', '100 g']);

    const egg = byId(foods, '171287');
    expect(egg.portions.map((p) => [p.label, p.grams]).slice(0, 3)).toEqual([['1 large', 50], ['1 extra large', 56], ['1 jumbo', 63]]);

    const apple = byId(foods, '171688');
    expect(apple.name).toContain("Apples, raw, with skin (Includes foods for USDA's Food Distribution Program)");
    expect(apple.category).toBe('Fruits and Fruit Juices');
    expect(stats.unmapped.get(1104)?.name).toBe('Vitamin A, IU'); // IU vitamin A is not tracked
    expect(stats.warnings).toEqual([]); // every mapped id exists in the real nutrient.csv with a usable unit
  });

  it('the real JSON and CSV paths produce the same shape and are idempotent when written', async () => {
    const json = await loadFdcJson(memorySource(foundationFiles));
    const csv = await loadFdc(memorySource(realSrLegacyFiles()), { dataset: 'sr_legacy' });
    const db = new FakePg();
    const all = [...json.foods, ...csv.foods];
    expect(await writeFoods(db, all)).toMatchObject({ inserted: 6, unchanged: 0 });
    expect(await writeFoods(db, all)).toMatchObject({ inserted: 0, updated: 0, unchanged: 6, portionRowsInserted: 0 });
    for (const f of all) expect(JSON.stringify(f.nutrients)).not.toMatch(/null|NaN/);
  });
});

// ------------------------------------------------- containers and auto-detect

describe('sources and auto-detection', () => {
  it('reads the .json file out of a zip (no folder) without extracting it', async () => {
    const dir = await tmp();
    const zipPath = join(dir, 'foundation.zip');
    await writeFile(zipPath, makeStoredZip({ [REAL_FOUNDATION_JSON_NAME]: realFoundationJson() }));
    const res = await withSource(zipPath, (src) => loadFdcArchive(src, {}));
    expect(res).toMatchObject({ dataset: 'foundation', format: 'json', label: 'Foundation Foods' });
    expect(res.foods).toHaveLength(3);
  });

  it('reads a plain .json path and a directory containing one', async () => {
    const dir = await tmp();
    const file = join(dir, REAL_FOUNDATION_JSON_NAME);
    await writeFile(file, realFoundationJson());
    const src = await openSource(file);
    expect(src.kind).toBe('file');
    expect(src.jsonNames()).toEqual([REAL_FOUNDATION_JSON_NAME]);
    try {
      expect((await loadFdcArchive(src, {})).foods).toHaveLength(3);
    } finally {
      await src.close();
    }
    const viaDir = await withSource(dir, (s) => loadFdcArchive(s, { dataset: 'foundation' }));
    expect(viaDir.foods).toHaveLength(3);
  });

  it('auto-detects CSV archives and requires a complete set of tables', async () => {
    const res = await loadFdcArchive(memorySource(SR_FIXTURE), { dataset: 'sr_legacy' });
    expect(res.format).toBe('csv');
    expect(res.stats.kept).toBe(7);
  });

  it('reports an incomplete CSV archive with an actionable message (Foundation CSV zip of Oct 2026)', async () => {
    const incomplete = memorySource({
      'nutrient.csv': 'id,name,unit_name,nutrient_nbr,rank\n',
      'foundation_food.csv': 'fdc_id,NDB_number,footnote\n',
      'food_category.csv': 'id,code,description\n',
      'measure_unit.csv': 'id,name\n',
    });
    const err = await loadFdcArchive(incomplete, { dataset: 'foundation' }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/food\.csv, food_nutrient\.csv not found/);
    expect(message).toMatch(/archive is incomplete/);
    expect(message).toMatch(/JSON archive/);
    expect(message).toMatch(/download/);
    await expect(loadFdcArchive(memorySource({}), {})).rejects.toThrow(/No FDC data found/);
  });

  it('CSV without --dataset needs a recognisable data_type', async () => {
    const files = { ...SR_FIXTURE, 'food.csv': SR_FIXTURE['food.csv']!.replaceAll('sr_legacy_food', 'branded_food') };
    await expect(loadFdcArchive(memorySource(files), {})).rejects.toThrow(/pass --dataset/);
  });

  it('indexes .json entries but never .xlsx / junk', async () => {
    const dir = await tmp();
    const zipPath = join(dir, 'x.zip');
    await writeFile(
      zipPath,
      makeStoredZip({
        'top/data.json': '{"FoundationFoods":[]}',
        '__MACOSX/top/._data.json': 'junk',
        'top/Field Descriptions.xlsx': 'x',
        'top/': '',
      }),
    );
    const src = await openSource(zipPath);
    try {
      expect(src.jsonNames()).toEqual(['data.json']);
      expect(src.list()).toEqual(['data']);
    } finally {
      await src.close();
    }
  });
});

// ---------------------------------------------------------------------- cli

describe('cli with JSON archives', () => {
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { log: (m: string) => out.push(m), error: (m: string) => err.push(m), env: {} as NodeJS.ProcessEnv } };
  };
  const writeZip = async (): Promise<string> => {
    const dir = await tmp();
    const zipPath = join(dir, 'foundation_json.zip');
    await writeFile(zipPath, makeStoredZip({ [REAL_FOUNDATION_JSON_NAME]: realFoundationJson() }));
    return zipPath;
  };

  it('fdc --path <json zip> --dry-run works without --dataset and prints the detected dataset', async () => {
    const zip = await writeZip();
    const c = capture();
    expect(await main(['fdc', '--path', zip, '--dry-run'], c.io)).toBe(0);
    const text = c.out.join('\n');
    expect(text).toContain('[fdc_foundation] Foundation Foods');
    expect(text).toContain('foods found 3, kept 3, dropped 0');
    expect(text).toContain('source nutrients not in the catalog:');
    expect(text).toContain('negative carbohydrate-by-difference (> -1 g) stored as 0: 1');
  });

  it('fails when --dataset contradicts the JSON file', async () => {
    const zip = await writeZip();
    const c = capture();
    expect(await main(['fdc', '--dataset', 'fndds', '--path', zip, '--dry-run'], c.io)).toBe(1);
    expect(c.err.join('\n')).toMatch(/FoundationFoods.*--dataset fndds/);
  });

  it('prints the actionable message for an incomplete CSV zip', async () => {
    const dir = await tmp();
    const zipPath = join(dir, 'foundation_csv.zip');
    await writeFile(zipPath, makeStoredZip({ 'rel/nutrient.csv': 'id\n', 'rel/foundation_food.csv': 'fdc_id\n' }));
    const c = capture();
    expect(await main(['fdc', '--dataset', 'foundation', '--path', zipPath, '--dry-run'], c.io)).toBe(1);
    expect(c.err.join('\n')).toMatch(/archive is incomplete.*JSON archive.*download/s);
  });

  it('download: --format must be json or csv and Foundation has no CSV', async () => {
    for (const args of [
      ['download', 'foundation', '--format', 'csv'],
      ['download', 'fndds', '--format', 'xml'],
    ]) {
      const c = capture();
      expect(await main(args, c.io), args.join(' ')).toBe(2);
    }
    const c = capture();
    await main(['help'], c.io);
    expect(c.out.join('\n')).toContain('--format json|csv');
  });

  it('all: uses a cached JSON archive and falls back to a cached CSV archive', async () => {
    const cache = await tmp();
    await writeFile(join(cache, 'FoodData_Central_foundation_food_json_2026-10-29.zip'), makeStoredZip({ [REAL_FOUNDATION_JSON_NAME]: realFoundationJson() }));
    const csvFiles = Object.fromEntries(Object.entries(realSrLegacyFiles()).map(([k, v]) => [`rel/${k}`, v]));
    await writeFile(join(cache, 'FoodData_Central_sr_legacy_food_csv_2018-04.zip'), makeStoredZip(csvFiles));
    const c = capture();
    expect(await main(['all', '--cache-dir', cache, '--dry-run', '--only', 'foundation,sr_legacy'], c.io)).toBe(0);
    const text = c.out.join('\n');
    expect(text).toContain('[fdc_foundation]');
    expect(text).toContain('[fdc_sr_legacy]');
    expect(text).toContain('Total: 6 foods');
  });
});

// ------------------------------------------------------------------- report

describe('report for unmapped nutrients', () => {
  it('lists the most frequent source nutrients without a catalog entry', async () => {
    const res = await loadFdcJson(memorySource({ [REAL_FOUNDATION_JSON_NAME]: realFoundationJson() }));
    const text = formatReport([summarize('Foundation Foods', res.foods, res.stats)], { dryRun: true });
    expect(text).toMatch(/source nutrients not in the catalog: \d+ distinct; most frequent: Nitrogen \(1002\)/);
  });
});
