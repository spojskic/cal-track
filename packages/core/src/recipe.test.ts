import { describe, expect, it } from 'vitest';
import { computeRecipe } from './recipe';
import type { NutrientMap } from './types';

const A: { per100g: NutrientMap; grams: number } = {
  per100g: { ENERGY_KCAL: 400, PROTEIN_G: 10, VITAMIN_C_MG: 0 },
  grams: 200,
};
const B: { per100g: NutrientMap; grams: number } = {
  per100g: { ENERGY_KCAL: 100, PROTEIN_G: 2, SODIUM_MG: 50 },
  grams: 300,
};

describe('computeRecipe', () => {
  it('computes totals, per-100g (final weight) and per-serving', () => {
    // total: energy 800 + 300 = 1100, protein 20 + 6 = 26, sodium 150
    // raw 500 g, cooked down to 400 g, 5 servings
    const r = computeRecipe({ ingredients: [A, B], servings: 5, finalWeightG: 400 });
    expect(r.totalRawWeightG).toBe(500);
    expect(r.finalWeightG).toBe(400);
    expect(r.totalNutrients.ENERGY_KCAL).toBeCloseTo(1100, 10);
    expect(r.totalNutrients.PROTEIN_G).toBeCloseTo(26, 10);
    expect(r.totalNutrients.SODIUM_MG).toBeCloseTo(150, 10);
    // per 100 g of the cooked dish = total * 100 / 400
    expect(r.per100g.ENERGY_KCAL).toBeCloseTo(275, 10);
    expect(r.per100g.PROTEIN_G).toBeCloseTo(6.5, 10);
    expect(r.per100g.SODIUM_MG).toBeCloseTo(37.5, 10);
    // per serving = total / 5 ; serving weight = 400 / 5
    expect(r.perServing.ENERGY_KCAL).toBeCloseTo(220, 10);
    expect(r.perServing.PROTEIN_G).toBeCloseTo(5.2, 10);
    expect(r.servingWeightG).toBeCloseTo(80, 10);
  });

  it('uses the raw weight when no final weight is given', () => {
    const r = computeRecipe({ ingredients: [A, B], servings: 5 });
    expect(r.finalWeightG).toBe(500);
    expect(r.per100g.ENERGY_KCAL).toBeCloseTo(220, 10); // 1100 * 100 / 500
    expect(r.servingWeightG).toBeCloseTo(100, 10);
  });

  it('losing water concentrates per-100g values but keeps totals and servings', () => {
    const raw = computeRecipe({ ingredients: [A, B], servings: 4 });
    const cooked = computeRecipe({ ingredients: [A, B], servings: 4, finalWeightG: 250 });
    expect(cooked.totalNutrients).toEqual(raw.totalNutrients);
    expect(cooked.perServing).toEqual(raw.perServing);
    expect(cooked.per100g.ENERGY_KCAL as number).toBeCloseTo((raw.per100g.ENERGY_KCAL as number) * 2, 10);
  });

  it('keeps unknown nutrients unknown and explicit zero as zero', () => {
    const r = computeRecipe({ ingredients: [A, B], servings: 1 });
    expect('FIBER_G' in r.totalNutrients).toBe(false);
    expect('FIBER_G' in r.per100g).toBe(false);
    expect('FIBER_G' in r.perServing).toBe(false);
    expect(r.totalNutrients.VITAMIN_C_MG).toBe(0);
    expect(r.perServing.VITAMIN_C_MG).toBe(0);
  });

  it('flags nutrients known for only some ingredients', () => {
    const r = computeRecipe({ ingredients: [A, B], servings: 1 });
    // vitamin C only in A, sodium only in B ; energy and protein in both
    expect(r.incompleteNutrients.sort()).toEqual(['SODIUM_MG', 'VITAMIN_C_MG']);
  });

  it('ignores zero-gram ingredients when judging completeness', () => {
    const r = computeRecipe({ ingredients: [A, { per100g: {}, grams: 0 }], servings: 2 });
    expect(r.incompleteNutrients).toEqual([]);
    expect(r.totalNutrients.ENERGY_KCAL).toBeCloseTo(800, 10);
  });

  it('supports fractional servings and a single ingredient', () => {
    const r = computeRecipe({ ingredients: [A], servings: 0.5 });
    expect(r.perServing.PROTEIN_G).toBeCloseTo(40, 10); // 20 g total / 0.5
    expect(r.servingWeightG).toBeCloseTo(400, 10);
  });

  it('handles an empty recipe', () => {
    const r = computeRecipe({ ingredients: [], servings: 2 });
    expect(r.totalNutrients).toEqual({});
    expect(r.per100g).toEqual({});
    expect(r.totalRawWeightG).toBe(0);
    expect(r.servingWeightG).toBe(0);
  });

  it('validates input', () => {
    expect(() => computeRecipe({ ingredients: [A], servings: 0 })).toThrow(RangeError);
    expect(() => computeRecipe({ ingredients: [A], servings: -1 })).toThrow(RangeError);
    expect(() => computeRecipe({ ingredients: [A], servings: 1, finalWeightG: 0 })).toThrow(RangeError);
    expect(() => computeRecipe({ ingredients: [{ per100g: {}, grams: -5 }], servings: 1 })).toThrow(RangeError);
  });
});
