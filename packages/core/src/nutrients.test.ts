import { describe, expect, it } from 'vitest';
import {
  COMPUTED_NUTRIENT_CODES,
  FDC_CONVERTED_IDS,
  HIGHLIGHT_NUTRIENT_CODES,
  LIMIT_NUTRIENT_CODES,
  NUTRIENTS,
  NUTRIENT_BY_CODE,
  NUTRIENT_BY_FDC_ID,
  NUTRIENT_CODES,
  NUTRIENT_GROUPS,
  NUTRIENT_UNITS,
  isNutrientCode,
  nutrientsInGroup,
} from './nutrients';

describe('nutrient catalog', () => {
  it('has roughly the expected number of entries', () => {
    expect(NUTRIENTS.length).toBeGreaterThanOrEqual(80);
    expect(NUTRIENTS.length).toBeLessThanOrEqual(100);
  });

  it('has unique, UPPER_SNAKE codes', () => {
    const codes = NUTRIENTS.map((n) => n.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it('has unique fdcIds, including alternate ids', () => {
    const ids = NUTRIENTS.flatMap((n) => [n.fdcId, ...(n.fdcAltIds ?? [])]).filter(
      (id): id is number => id !== null,
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(NUTRIENT_BY_FDC_ID.size).toBe(ids.length);
  });

  it('has a non-empty entry list for every group and every group is declared', () => {
    for (const group of NUTRIENT_GROUPS) {
      expect(nutrientsInGroup(group.code).length).toBeGreaterThan(0);
      expect(group.label.length).toBeGreaterThan(0);
    }
    const declared = new Set(NUTRIENT_GROUPS.map((g) => g.code));
    for (const n of NUTRIENTS) expect(declared.has(n.group)).toBe(true);
    expect(NUTRIENT_GROUPS.map((g) => g.order)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('uses only valid units and a unit suffix in the code that matches', () => {
    const suffixToUnit: Record<string, string> = { KCAL: 'kcal', G: 'g', MG: 'mg', UG: 'ug', IU: 'iu', ML: 'ml' };
    for (const n of NUTRIENTS) {
      expect(NUTRIENT_UNITS).toContain(n.unit);
      const suffix = n.code.split('_').at(-1) as string;
      expect(suffixToUnit[suffix], `${n.code} suffix`).toBe(n.unit);
    }
  });

  it('orders entries ascending and grouped in group order', () => {
    const orders = NUTRIENTS.map((n) => n.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
    const groupRank = new Map(NUTRIENT_GROUPS.map((g) => [g.code, g.order]));
    const ranks = NUTRIENTS.map((n) => groupRank.get(n.group) as number);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('resolves FDC ids, including alternates, to the canonical nutrient', () => {
    expect(NUTRIENT_BY_FDC_ID.get(1008)?.code).toBe('ENERGY_KCAL');
    expect(NUTRIENT_BY_FDC_ID.get(2047)?.code).toBe('ENERGY_KCAL');
    expect(NUTRIENT_BY_FDC_ID.get(2048)?.code).toBe('ENERGY_KCAL');
    expect(NUTRIENT_BY_FDC_ID.get(2000)?.code).toBe('SUGARS_G');
    expect(NUTRIENT_BY_FDC_ID.get(1063)?.code).toBe('SUGARS_G');
    expect(NUTRIENT_BY_FDC_ID.get(1162)?.code).toBe('VITAMIN_C_MG');
    expect(NUTRIENT_BY_FDC_ID.get(1003)?.code).toBe('PROTEIN_G');
    expect(NUTRIENT_BY_FDC_ID.get(999999)).toBeUndefined();
  });

  it('keeps unit-converted FDC ids out of the plain lookup and exposes conversion factors', () => {
    expect(NUTRIENT_BY_FDC_ID.has(1062)).toBe(false); // kJ
    expect(NUTRIENT_BY_FDC_ID.has(1110)).toBe(false); // IU
    expect(FDC_CONVERTED_IDS.get(1062)?.code).toBe('ENERGY_KCAL');
    expect(FDC_CONVERTED_IDS.get(1062)?.factor).toBeCloseTo(0.239006, 5);
    expect(FDC_CONVERTED_IDS.get(1110)).toEqual({ code: 'VITAMIN_D_UG', factor: 1 / 40 });
  });

  it('looks up by code and validates codes', () => {
    expect(NUTRIENT_BY_CODE.VITAMIN_C_MG.unit).toBe('mg');
    expect(NUTRIENT_BY_CODE.ENERGY_KCAL.unit).toBe('kcal');
    expect(NUTRIENT_BY_CODE.VITAMIN_D_UG.unit).toBe('ug');
    expect(isNutrientCode('PROTEIN_G')).toBe(true);
    expect(isNutrientCode('NOPE')).toBe(false);
    expect(isNutrientCode('toString')).toBe(false);
    expect(NUTRIENT_CODES).toHaveLength(NUTRIENTS.length);
    for (const code of NUTRIENT_CODES) expect(NUTRIENT_BY_CODE[code].code).toBe(code);
  });

  it('marks computed nutrients without FDC ids', () => {
    expect([...COMPUTED_NUTRIENT_CODES].sort()).toEqual(['NET_CARBS_G', 'OMEGA3_G', 'OMEGA6_G']);
    for (const code of COMPUTED_NUTRIENT_CODES) expect(NUTRIENT_BY_CODE[code].fdcId).toBeNull();
  });

  it('has null FDC ids only for computed or custom nutrients', () => {
    const nullIds = NUTRIENTS.filter((n) => n.fdcId === null && !n.computed).map((n) => n.code);
    expect(nullIds.sort()).toEqual(
      ['B7_BIOTIN_UG', 'CHROMIUM_UG', 'MOLYBDENUM_UG', 'SUGAR_ALCOHOLS_G'].sort(),
    );
  });

  it('flags limit and highlight nutrients as specified', () => {
    expect([...LIMIT_NUTRIENT_CODES].sort()).toEqual(
      [
        'SODIUM_MG',
        'SATURATED_FAT_G',
        'TRANS_FAT_G',
        'ADDED_SUGARS_G',
        'CHOLESTEROL_MG',
        'CAFFEINE_MG',
        'ALCOHOL_G',
      ].sort(),
    );
    expect([...HIGHLIGHT_NUTRIENT_CODES].sort()).toEqual(
      [
        'FIBER_G',
        'IRON_MG',
        'CALCIUM_MG',
        'VITAMIN_A_UG',
        'VITAMIN_C_MG',
        'B12_UG',
        'FOLATE_UG',
        'POTASSIUM_MG',
      ].sort(),
    );
  });

  it('contains the macros and spot-checked FDC ids from the research notes', () => {
    const expected: Record<string, number> = {
      PROTEIN_G: 1003,
      FAT_G: 1004,
      CARBS_G: 1005,
      FIBER_G: 1079,
      SODIUM_MG: 1093,
      POTASSIUM_MG: 1092,
      VITAMIN_D_UG: 1114,
      B12_UG: 1178,
      FOLATE_UG: 1190,
      DHA_G: 1272,
      LEUCINE_G: 1213,
    };
    for (const [code, id] of Object.entries(expected)) {
      expect(NUTRIENT_BY_CODE[code as keyof typeof NUTRIENT_BY_CODE].fdcId).toBe(id);
    }
  });

  it('gives selected nutrients an Open Food Facts key', () => {
    expect(NUTRIENT_BY_CODE.VITAMIN_C_MG.offKey).toBe('vitamin-c');
    expect(NUTRIENT_BY_CODE.SATURATED_FAT_G.offKey).toBe('saturated-fat');
    expect(NUTRIENT_BY_CODE.ENERGY_KCAL.offKey).toBe('energy-kcal');
    const keys = NUTRIENTS.map((n) => n.offKey).filter((k): k is string => k !== undefined);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
