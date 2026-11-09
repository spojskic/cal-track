import { describe, expect, it } from 'vitest';
import {
  addNutrients,
  completeness,
  deriveNutrients,
  estimateEnergyKcal,
  scaleNutrients,
  sumEntries,
  sumNutrients,
  sumNutrientsDetailed,
} from './diary';
import { NUTRIENTS } from './nutrients';
import type { NutrientMap } from './types';

describe('scaleNutrients', () => {
  it('scales per-100g values to grams', () => {
    const out = scaleNutrients({ PROTEIN_G: 20, FAT_G: 0, ENERGY_KCAL: 250 }, 150);
    expect(out.PROTEIN_G).toBeCloseTo(30, 10);
    expect(out.FAT_G).toBe(0);
    expect(out.ENERGY_KCAL).toBeCloseTo(375, 10);
  });

  it('keeps unknown nutrients unknown and ignores non-finite values', () => {
    const out = scaleNutrients({ PROTEIN_G: 10, FIBER_G: Number.NaN }, 200);
    expect(out.PROTEIN_G).toBeCloseTo(20, 10);
    expect('FIBER_G' in out).toBe(false);
    expect('FAT_G' in out).toBe(false);
  });

  it('returns zeros (not unknown) for 0 grams of a known nutrient', () => {
    expect(scaleNutrients({ PROTEIN_G: 10 }, 0)).toEqual({ PROTEIN_G: 0 });
  });
});

describe('addNutrients / sumNutrients', () => {
  it('treats unknown + known as known', () => {
    const out = addNutrients({ PROTEIN_G: 10, CALCIUM_MG: 5 }, { PROTEIN_G: 5, IRON_MG: 2 });
    expect(out).toEqual({ PROTEIN_G: 15, CALCIUM_MG: 5, IRON_MG: 2 });
  });

  it('keeps unknown-only nutrients unknown and explicit zero as zero', () => {
    const out = sumNutrients([{ PROTEIN_G: 0 }, { FAT_G: 4 }]);
    expect(out.PROTEIN_G).toBe(0);
    expect(out.FAT_G).toBe(4);
    expect('FIBER_G' in out).toBe(false);
  });

  it('sums an empty list to an empty map', () => {
    expect(sumNutrients([])).toEqual({});
  });

  it('does not mutate inputs', () => {
    const a: NutrientMap = { PROTEIN_G: 1 };
    const b: NutrientMap = { PROTEIN_G: 2 };
    addNutrients(a, b);
    expect(a).toEqual({ PROTEIN_G: 1 });
    expect(b).toEqual({ PROTEIN_G: 2 });
  });

  it('reports incomplete nutrients (known for some, not all)', () => {
    const { totals, incompleteNutrients } = sumNutrientsDetailed([
      { PROTEIN_G: 5, VITAMIN_C_MG: 10 },
      { PROTEIN_G: 7 },
      { PROTEIN_G: 1, VITAMIN_C_MG: 0 },
    ]);
    expect(totals).toEqual({ PROTEIN_G: 13, VITAMIN_C_MG: 10 });
    expect(incompleteNutrients).toEqual(['VITAMIN_C_MG']);
  });
});

describe('sumEntries', () => {
  it('sums scaled per-100g entries', () => {
    const out = sumEntries([
      { per100g: { ENERGY_KCAL: 200, PROTEIN_G: 10 }, grams: 50 }, // 100 kcal, 5 g
      { per100g: { ENERGY_KCAL: 100 }, grams: 150 }, // 150 kcal, protein unknown
    ]);
    expect(out.ENERGY_KCAL).toBeCloseTo(250, 10);
    expect(out.PROTEIN_G).toBeCloseTo(5, 10);
  });
});

describe('deriveNutrients - net carbs', () => {
  const food: NutrientMap = { CARBS_G: 50, FIBER_G: 8, SUGAR_ALCOHOLS_G: 5 };

  it('includes_fiber basis subtracts fiber and sugar alcohols', () => {
    expect(deriveNutrients(food, { carbBasis: 'includes_fiber' }).NET_CARBS_G).toBe(37);
  });

  it('includes_fiber basis with fiber_only ignores sugar alcohols', () => {
    expect(
      deriveNutrients(food, { carbBasis: 'includes_fiber', netCarbMode: 'fiber_only' }).NET_CARBS_G,
    ).toBe(42);
  });

  it('excludes_fiber basis does not subtract fiber again', () => {
    expect(deriveNutrients(food, { carbBasis: 'excludes_fiber' }).NET_CARBS_G).toBe(45);
    expect(
      deriveNutrients(food, { carbBasis: 'excludes_fiber', netCarbMode: 'fiber_only' }).NET_CARBS_G,
    ).toBe(50);
  });

  it('defaults to includes_fiber with sugar alcohols', () => {
    expect(deriveNutrients(food).NET_CARBS_G).toBe(37);
  });

  it('never goes below zero', () => {
    expect(deriveNutrients({ CARBS_G: 5, FIBER_G: 8 }).NET_CARBS_G).toBe(0);
  });

  it('treats missing fiber as 0 and leaves net carbs unknown without carbs', () => {
    expect(deriveNutrients({ CARBS_G: 20 }).NET_CARBS_G).toBe(20);
    expect('NET_CARBS_G' in deriveNutrients({ FIBER_G: 3, NET_CARBS_G: 99 })).toBe(false);
  });

  it('recomputes a stale NET_CARBS_G', () => {
    expect(deriveNutrients({ CARBS_G: 30, FIBER_G: 10, NET_CARBS_G: 99 }).NET_CARBS_G).toBe(20);
  });
});

describe('deriveNutrients - omega fatty acids', () => {
  it('sums omega-3 and omega-6 components', () => {
    const out = deriveNutrients({
      ALA_G: 1.0,
      EPA_G: 0.2,
      DPA_G: 0.05,
      DHA_G: 0.3,
      LINOLEIC_G: 10,
      ARACHIDONIC_G: 0.5,
    });
    expect(out.OMEGA3_G).toBeCloseTo(1.55, 10);
    expect(out.OMEGA6_G).toBeCloseTo(10.5, 10);
  });

  it('uses the known components only and stays unknown with none', () => {
    expect(deriveNutrients({ DHA_G: 0.3 }).OMEGA3_G).toBeCloseTo(0.3, 10);
    const none = deriveNutrients({ PROTEIN_G: 1 });
    expect('OMEGA3_G' in none).toBe(false);
    expect('OMEGA6_G' in none).toBe(false);
  });
});

describe('deriveNutrients - energy fallback', () => {
  it('estimates 4P + 4C + 9F when energy is missing', () => {
    expect(deriveNutrients({ PROTEIN_G: 10, CARBS_G: 20, FAT_G: 5 }).ENERGY_KCAL).toBe(165);
  });

  it('uses available carbs (carbs - fiber) on the includes_fiber basis', () => {
    // 25 total carbs, 5 fiber => 20 available => 4*10 + 4*20 + 9*5 = 165
    expect(deriveNutrients({ PROTEIN_G: 10, CARBS_G: 25, FIBER_G: 5, FAT_G: 5 }).ENERGY_KCAL).toBe(165);
    expect(
      deriveNutrients(
        { PROTEIN_G: 10, CARBS_G: 25, FIBER_G: 5, FAT_G: 5 },
        { carbBasis: 'excludes_fiber' },
      ).ENERGY_KCAL,
    ).toBe(185);
  });

  it('adds 7 kcal per gram of alcohol', () => {
    expect(deriveNutrients({ PROTEIN_G: 0, CARBS_G: 0, FAT_G: 0, ALCOHOL_G: 10 }).ENERGY_KCAL).toBe(70);
  });

  it('never overrides a present energy value', () => {
    expect(deriveNutrients({ ENERGY_KCAL: 999, PROTEIN_G: 10 }).ENERGY_KCAL).toBe(999);
  });

  it('treats a missing macro as 0 but needs at least one macro', () => {
    expect(deriveNutrients({ PROTEIN_G: 10 }).ENERGY_KCAL).toBe(40);
    expect('ENERGY_KCAL' in deriveNutrients({ VITAMIN_C_MG: 5 })).toBe(false);
    expect(estimateEnergyKcal({})).toBeUndefined();
  });

  it('does not mutate its input', () => {
    const input: NutrientMap = { CARBS_G: 10, FAT_G: 1 };
    deriveNutrients(input);
    expect(input).toEqual({ CARBS_G: 10, FAT_G: 1 });
  });
});

describe('completeness', () => {
  const nonComputed = NUTRIENTS.filter((n) => !n.computed);

  it('is 0 for an empty map', () => {
    expect(completeness({})).toBe(0);
  });

  it('counts non-computed nutrients only', () => {
    expect(completeness({ PROTEIN_G: 5, FAT_G: 0 })).toBeCloseTo(2 / nonComputed.length, 10);
    expect(completeness({ NET_CARBS_G: 5, OMEGA3_G: 1 })).toBe(0);
  });

  it('is 1 when every non-computed nutrient is present', () => {
    const full: NutrientMap = {};
    for (const n of nonComputed) full[n.code] = 1;
    expect(completeness(full)).toBe(1);
  });
});
