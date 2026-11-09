import { describe, expect, it } from 'vitest';
import {
  CNF_CONVERSION_GRAMS,
  CNF_CONVERSION_MULTIPLIER,
  CNF_FOOD_NAME,
  cnfFilesLatin1,
  cnfFilesUtf8Bom,
} from './fixtures';
import { buildCnfRules, detectFactorMode, loadCnf } from './cnf';
import { memorySource } from './source';
import type { ImportFood } from './types';

const byId = (foods: ImportFood[], id: string): ImportFood => {
  const f = foods.find((x) => x.sourceId === id);
  if (!f) throw new Error(`food ${id} not found`);
  return f;
};

describe('CNF loader', () => {
  it('parses ISO-8859-1 files (auto-detected): accents, micro sign, NutrientID != NutrientCode', async () => {
    const { foods, stats } = await loadCnf(memorySource(cnfFilesLatin1()));
    expect(stats.foodsFound).toBe(3);
    expect(foods.map((f) => f.sourceId)).toEqual(['2', '3']);
    expect(stats.dropped.no_energy).toBe(1);

    const milk = byId(foods, '2');
    expect(milk).toMatchObject({
      source: 'cnf',
      kind: 'generic',
      name: 'Milk, 3.25% M.F.',
      category: 'Dairy and Egg Products',
      carbBasis: 'includes_fiber',
    });
    expect(milk.nutrients).toEqual({
      ENERGY_KCAL: 61,
      PROTEIN_G: 3.2,
      FAT_G: 3.3,
      CARBS_G: 4.8,
      CALCIUM_MG: 113, // NutrientID 9301 -> NutrientCode 301
      VITAMIN_A_UG: 46, // unit "µg" (0xB5 in latin1) -> ug
    });
    expect('VITAMIN_C_MG' in milk.nutrients).toBe(false); // -1 dropped
    expect(stats.invalidAmounts).toBe(1);

    const cafe = byId(foods, '3');
    expect(cafe.name).toBe('Café crème, 15% fat');
    expect(cafe.nutrients.ENERGY_KCAL).toBe(200); // 837 kJ / 4.184
    expect(stats.energySources).toMatchObject({ kcal: 1, kj: 1 });
  });

  it('parses UTF-8 files with a BOM identically', async () => {
    const latin = await loadCnf(memorySource(cnfFilesLatin1()));
    const bom = await loadCnf(memorySource(cnfFilesUtf8Bom()));
    expect(bom.foods).toEqual(latin.foods);
  });

  it('honours an explicit --encoding utf8 (and breaks on latin1 bytes)', async () => {
    const forcedUtf8 = await loadCnf(memorySource(cnfFilesLatin1()), { encoding: 'utf8' });
    expect(forcedUtf8.foods.find((f) => f.sourceId === '3')?.name).not.toBe('Café crème, 15% fat');
    const forcedLatin = await loadCnf(memorySource(cnfFilesLatin1()), { encoding: 'latin1' });
    expect(forcedLatin.foods.find((f) => f.sourceId === '3')?.name).toBe('Café crème, 15% fat');
  });

  it('matches headers regardless of case, spaces and file-name case', async () => {
    const files = {
      'food name.CSV': CNF_FOOD_NAME.replace('FoodID,FoodCode,FoodGroupID', 'FOOD ID,food_code,Food Group ID').replace('FoodDescription,', 'Food Description,'),
      ...Object.fromEntries(Object.entries(cnfFilesLatin1()).filter(([k]) => k !== 'FOOD NAME.csv')),
    };
    const { foods } = await loadCnf(memorySource(files));
    expect(foods.map((f) => f.sourceId)).toEqual(['2', '3']);
  });

  it('builds portions from MEASURE NAME x CONVERSION FACTOR (factor = multiplier of 100 g)', async () => {
    const { foods } = await loadCnf(memorySource(cnfFilesLatin1(CNF_CONVERSION_MULTIPLIER)));
    expect(byId(foods, '2').portions.map((p) => [p.label, p.grams])).toEqual([
      ['250 mL', 258],
      ['125 mL', 129],
      ['100 g', 100], // measure "100 g" is the always-present portion (not duplicated)
    ]);
    expect(byId(foods, '3').portions.map((p) => [p.label, p.grams])).toEqual([
      ['1 cup (250 mL)', 240],
      ['100 g', 100],
    ]);
  });

  it('auto-detects ConversionFactorValue given directly in grams', async () => {
    const { foods } = await loadCnf(memorySource(cnfFilesLatin1(CNF_CONVERSION_GRAMS)));
    expect(byId(foods, '2').portions.map((p) => [p.label, p.grams])).toEqual([
      ['250 mL', 258],
      ['125 mL', 129],
      ['100 g', 100],
    ]);
  });

  it('factorMode overrides auto-detection', async () => {
    const { foods } = await loadCnf(memorySource(cnfFilesLatin1(CNF_CONVERSION_MULTIPLIER)), { factorMode: 'grams' });
    const portions = byId(foods, '2').portions;
    expect(portions[0]).toMatchObject({ label: '250 mL', grams: 2.58 });
    // a "100 g" measure that would weigh 1 g is rejected; the real 100 g portion is still added
    expect(portions.filter((p) => p.label === '100 g').map((p) => p.grams)).toEqual([100]);
  });

  it('detectFactorMode uses the median', () => {
    expect(detectFactorMode([0.05, 0.15, 2.4, 0.3, 0.5])).toBe('multiplier');
    expect(detectFactorMode([5, 15, 240, 30, 50])).toBe('grams');
    expect(detectFactorMode([])).toBe('multiplier');
  });

  it('works without conversion files (100 g only) and reports it', async () => {
    const files = cnfFilesLatin1();
    delete (files as Record<string, unknown>)['CONVERSION FACTOR.csv'];
    delete (files as Record<string, unknown>)['MEASURE NAME.csv'];
    const { foods, stats } = await loadCnf(memorySource(files));
    expect(foods.every((f) => f.portions.length === 1)).toBe(true);
    expect(stats.warnings.some((w) => w.includes('CONVERSION FACTOR'))).toBe(true);
  });

  it('honours --limit', async () => {
    const { foods } = await loadCnf(memorySource(cnfFilesLatin1()), { limit: 1 });
    expect(foods.map((f) => f.sourceId)).toEqual(['2']);
  });

  it('fails clearly when required files are missing', async () => {
    const files = cnfFilesLatin1();
    delete (files as Record<string, unknown>)['NUTRIENT AMOUNT.csv'];
    await expect(loadCnf(memorySource(files))).rejects.toThrow(/NUTRIENT AMOUNT\.csv" not found/);
  });

  it('CNF rule table has unique codes, includes the energy/macro codes from the task', () => {
    const ids = buildCnfRules().ids;
    for (const code of [208, 203, 204, 205]) expect(ids.has(code)).toBe(true);
  });
});
