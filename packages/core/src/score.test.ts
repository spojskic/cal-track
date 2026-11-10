import { describe, expect, it } from 'vitest';
import { applyOverrides, selectTargets, type Targets } from './dri';
import { NUTRIENT_CODES } from './nutrients';
import { KEY_NUTRIENT_WEIGHTS, nutritionScore } from './score';
import type { NutrientMap } from './types';

const targets: Targets = {
  PROTEIN_G: { min: 100, kind: 'RDA' }, // key nutrient, weight 2
  VITAMIN_C_MG: { min: 100, kind: 'RDA' }, // weight 1
  SODIUM_MG: { max: 2000, kind: 'CDRR' }, // limit only, weight 1
};

describe('nutritionScore', () => {
  it('is the weighted mean of capped fulfilment', () => {
    // protein 50% (w2) and vitamin C 100% (w1): (2*0.5 + 1*1) / 3 = 0.6667 -> 67
    const r = nutritionScore({ PROTEIN_G: 50, VITAMIN_C_MG: 100, SODIUM_MG: 1000 }, targets);
    expect(r.score).toBe(67);
    expect(r.coverage).toBe(1);
    expect(r.perNutrient.PROTEIN_G).toMatchObject({ weight: 2, fulfillment: 0.5, intake: 50, min: 100 });
    expect(r.perNutrient.VITAMIN_C_MG).toMatchObject({ weight: 1, fulfillment: 1 });
    expect(r.perNutrient.SODIUM_MG).toMatchObject({ max: 2000, excess: 0 });
  });

  it('caps fulfilment at 100% so overshooting a minimum does not help', () => {
    const r = nutritionScore({ PROTEIN_G: 500, VITAMIN_C_MG: 1000 }, targets);
    expect(r.score).toBe(100);
    expect(r.perNutrient.PROTEIN_G?.fulfillment).toBe(1);
  });

  it('penalises exceeding a limit with lambda 0.5', () => {
    // sodium 3000 vs 2000 => excess 0.5 ; penalty 0.5 * 1 * 0.5 = 0.25 ; 0.66667 - 0.25 = 0.41667 -> 42
    const r = nutritionScore({ PROTEIN_G: 50, VITAMIN_C_MG: 100, SODIUM_MG: 3000 }, targets);
    expect(r.perNutrient.SODIUM_MG?.excess).toBeCloseTo(0.5, 10);
    expect(r.score).toBe(42);
  });

  it('supports a custom lambda and custom weights', () => {
    const intake: NutrientMap = { PROTEIN_G: 50, VITAMIN_C_MG: 100, SODIUM_MG: 3000 };
    // lambda 0: no penalty
    expect(nutritionScore(intake, targets, { lambda: 0 }).score).toBe(67);
    // all weights 1: base (0.5 + 1)/2 = 0.75 ; sodium weight 4 => penalty 0.5*4*0.5 = 1 -> 0
    const weights = { PROTEIN_G: 1, VITAMIN_C_MG: 1, SODIUM_MG: 4 };
    expect(nutritionScore(intake, targets, { weights }).score).toBe(0);
    expect(nutritionScore({ PROTEIN_G: 50, VITAMIN_C_MG: 100 }, targets, { weights }).score).toBe(75);
  });

  it('skips unknown intake and lowers coverage instead of counting zero', () => {
    const r = nutritionScore({ PROTEIN_G: 50, SODIUM_MG: 1000 }, targets);
    expect(r.score).toBe(50); // only protein counts: 0.5
    expect(r.coverage).toBeCloseTo(2 / 3, 10);
    expect(r.perNutrient.VITAMIN_C_MG?.intake).toBeUndefined();
  });

  it('treats an explicit zero as a real zero', () => {
    const r = nutritionScore({ PROTEIN_G: 100, VITAMIN_C_MG: 0 }, targets);
    expect(r.score).toBe(67); // (2*1 + 1*0)/3
  });

  it('never goes below 0 or above 100', () => {
    expect(nutritionScore({ PROTEIN_G: 1, SODIUM_MG: 100000 }, targets).score).toBe(0);
    expect(nutritionScore({ PROTEIN_G: 100, VITAMIN_C_MG: 100 }, targets).score).toBe(100);
  });

  it('returns 0 with zero coverage when nothing is targeted or known', () => {
    expect(nutritionScore({ PROTEIN_G: 10 }, {})).toEqual({ score: 0, coverage: 0, perNutrient: {} });
    const r = nutritionScore({}, targets);
    expect(r.score).toBe(0);
    expect(r.coverage).toBe(0);
  });

  it('ignores limits that only apply to supplements unless asked', () => {
    const t: Targets = {
      MAGNESIUM_MG: { min: 400, kind: 'RDA', scopedUl: { value: 350, scope: 'supplement_only' } },
    };
    const ignored = nutritionScore({ MAGNESIUM_MG: 400 }, t);
    expect(ignored.score).toBe(100);
    expect(ignored.perNutrient.MAGNESIUM_MG?.excess).toBeUndefined();
    // excess = 400/350 - 1 = 0.142857 ; magnesium weight 2 ; penalty 0.5 * 2 * 0.142857 = 0.142857
    const penalised = nutritionScore({ MAGNESIUM_MG: 400 }, t, { penalizeScopedLimits: true });
    expect(penalised.score).toBe(86);
    expect(penalised.perNutrient.MAGNESIUM_MG?.max).toBe(350);
  });

  it('never counts the scoped UL of real selectTargets output as an excess for food intake', () => {
    const t = selectTargets({ sex: 'male', age: 30, weightKg: 80, energyKcal: 2500 });
    const r = nutritionScore({ MAGNESIUM_MG: 900, VITAMIN_A_UG: 9000, FOLATE_UG: 3000, B3_NIACIN_MG: 90 }, t);
    for (const code of ['MAGNESIUM_MG', 'VITAMIN_A_UG', 'FOLATE_UG', 'B3_NIACIN_MG'] as const) {
      expect(r.perNutrient[code]?.excess, code).toBeUndefined();
      expect(r.perNutrient[code]?.fulfillment, code).toBe(1);
    }
    expect(r.score).toBe(100);
  });

  it('still penalises a user-set total max on a nutrient that also has a scoped UL', () => {
    const t = applyOverrides(selectTargets({ sex: 'male', age: 30, weightKg: 80, energyKcal: 2500 }), {
      MAGNESIUM_MG: { max: 450 },
    });
    expect(nutritionScore({ MAGNESIUM_MG: 450 }, t).perNutrient.MAGNESIUM_MG?.excess).toBe(0);
    expect(nutritionScore({ MAGNESIUM_MG: 900 }, t).perNutrient.MAGNESIUM_MG?.excess).toBe(1);
    // the user limit wins over the scoped UL even when scoped limits are penalised
    expect(nutritionScore({ MAGNESIUM_MG: 900 }, t, { penalizeScopedLimits: true }).perNutrient.MAGNESIUM_MG?.max).toBe(450);
  });

  it('weights the nine key nutrients double', () => {
    expect(Object.keys(KEY_NUTRIENT_WEIGHTS).sort()).toEqual(
      ['B12_UG', 'CALCIUM_MG', 'FIBER_G', 'FOLATE_UG', 'IRON_MG', 'MAGNESIUM_MG', 'POTASSIUM_MG', 'PROTEIN_G', 'VITAMIN_D_UG'].sort(),
    );
    for (const w of Object.values(KEY_NUTRIENT_WEIGHTS)) expect(w).toBe(2);
  });

  it('scores 100 when intake meets every minimum from selectTargets', () => {
    const t = selectTargets({ sex: 'female', age: 30, weightKg: 60, energyKcal: 2000 });
    const intake: NutrientMap = {};
    for (const code of NUTRIENT_CODES) {
      const target = t[code];
      if (target?.min !== undefined) intake[code] = target.min;
    }
    const r = nutritionScore(intake, t);
    expect(r.score).toBe(100);
    expect(r.coverage).toBeGreaterThan(0.8);
    expect(r.coverage).toBeLessThan(1); // limit-only nutrients (sodium, caffeine, ...) have no data
  });

  it('works with overridden targets', () => {
    const t = applyOverrides(selectTargets({ sex: 'male', age: 30, weightKg: 80, energyKcal: 2500 }), {
      PROTEIN_G: { min: 160 },
    });
    expect(nutritionScore({ PROTEIN_G: 80 }, t).perNutrient.PROTEIN_G?.fulfillment).toBe(0.5);
  });
});
