import { describe, expect, it } from 'vitest';

import {
  ASSUMED_DENSITY_G_PER_ML,
  IU_PER_UG_VITAMIN_D,
  KJ_PER_KCAL,
  LABEL_NUTRIENTS,
  LABEL_NUTRIENT_CODES,
  LABEL_NUTRIENT_KEYS,
  SALT_PER_SODIUM,
  convertLabelAmount,
  isLabelNutrientKey,
  isPlausibleLabelAmount,
  labelToFoodDraft,
  maxLabelAmount,
  servingNameFromText,
  type LabelNutrientKey,
  type LabelReading,
  type LabelUnit,
} from './label';
import { NUTRIENT_BY_CODE, NUTRIENT_CODES } from './nutrients';

type Row = [key: LabelNutrientKey, amount: number, unit: LabelUnit, unclear?: boolean];

/** A reading with sensible empty defaults. */
function reading(rows: Row[], over: Partial<LabelReading> = {}): LabelReading {
  return {
    productName: null,
    brand: null,
    basis: 'per_100g',
    serving: { amount: null, unit: null, text: null },
    servingsPerContainer: null,
    carbohydrateIncludesFibre: null,
    nutrients: rows.map(([key, amount, unit, unclear]) => ({ key, amount, unit, unclear: unclear === true })),
    unclearFields: [],
    notes: null,
    warnings: [],
    ...over,
  };
}

describe('the fixed list of label nutrients', () => {
  it('has unique keys', () => {
    expect(new Set(LABEL_NUTRIENT_KEYS).size).toBe(LABEL_NUTRIENT_KEYS.length);
    for (const key of LABEL_NUTRIENT_KEYS) expect(isLabelNutrientKey(key)).toBe(true);
    expect(isLabelNutrientKey('toString')).toBe(false);
    expect(isLabelNutrientKey('vitamin_k2')).toBe(false);
  });

  it('maps every key to a catalog code, except energy in kJ and salt which labels print instead of a catalog nutrient', () => {
    const withoutCode = LABEL_NUTRIENT_KEYS.filter((key) => LABEL_NUTRIENTS[key].code === null);
    expect(withoutCode).toEqual(['energy_kj', 'salt']);
    const codes = LABEL_NUTRIENT_KEYS.map((key) => LABEL_NUTRIENTS[key].code).filter((c) => c !== null);
    for (const code of codes) expect(NUTRIENT_CODES).toContain(code);
    expect(new Set(codes).size).toBe(codes.length); // one-to-one
    expect([...LABEL_NUTRIENT_CODES].sort()).toEqual([...codes].sort());
  });

  it('stores each key in the unit of its catalog nutrient (ug is written mcg)', () => {
    for (const key of LABEL_NUTRIENT_KEYS) {
      const info = LABEL_NUTRIENTS[key];
      if (info.code === null) continue;
      const catalogUnit = NUTRIENT_BY_CODE[info.code].unit;
      expect(info.unit, key).toBe(catalogUnit === 'ug' ? 'mcg' : catalogUnit);
    }
    expect(LABEL_NUTRIENTS.energy_kj.unit).toBe('kj');
    expect(LABEL_NUTRIENTS.salt.unit).toBe('g');
  });

  it('covers the macros, the usual label lines and the common vitamins and minerals', () => {
    const codes = new Set(LABEL_NUTRIENT_CODES);
    for (const code of [
      'ENERGY_KCAL', 'FAT_G', 'SATURATED_FAT_G', 'TRANS_FAT_G', 'MONOUNSATURATED_FAT_G', 'POLYUNSATURATED_FAT_G',
      'CHOLESTEROL_MG', 'SODIUM_MG', 'CARBS_G', 'FIBER_G', 'SUGARS_G', 'ADDED_SUGARS_G', 'SUGAR_ALCOHOLS_G', 'PROTEIN_G',
      'VITAMIN_D_UG', 'CALCIUM_MG', 'IRON_MG', 'POTASSIUM_MG', 'VITAMIN_A_UG', 'VITAMIN_C_MG', 'VITAMIN_E_MG',
      'B6_MG', 'B12_UG', 'FOLATE_UG', 'MAGNESIUM_MG', 'ZINC_MG',
    ] as const) {
      expect(codes.has(code), code).toBe(true);
    }
  });
});

describe('convertLabelAmount', () => {
  it('keeps an amount that is already in the storage unit', () => {
    expect(convertLabelAmount('fat', 12.5, 'g')).toBe(12.5);
    expect(convertLabelAmount('sodium', 480, 'mg')).toBe(480);
    expect(convertLabelAmount('vitamin_b12', 2.4, 'mcg')).toBe(2.4);
    expect(convertLabelAmount('energy_kcal', 250, 'kcal')).toBe(250);
    expect(convertLabelAmount('energy_kj', 1046, 'kj')).toBe(1046);
  });

  it('converts between g, mg and mcg in both directions without floating point noise', () => {
    expect(convertLabelAmount('sodium', 0.48, 'g')).toBe(480);
    expect(convertLabelAmount('sodium', 0.07, 'g')).toBe(70); // 0.07 * 1000 = 70.00000000000001
    expect(convertLabelAmount('calcium', 1.2, 'g')).toBe(1200);
    expect(convertLabelAmount('calcium', 1200, 'mcg')).toBe(1.2);
    expect(convertLabelAmount('iron', 8000, 'mcg')).toBe(8);
    expect(convertLabelAmount('vitamin_b12', 0.0024, 'mg')).toBe(2.4);
    expect(convertLabelAmount('vitamin_d', 0.01, 'mg')).toBe(10);
    expect(convertLabelAmount('folate', 0.4, 'mg')).toBe(400);
    expect(convertLabelAmount('protein', 5000, 'mg')).toBe(5);
    expect(convertLabelAmount('fat', 1.5e6, 'mcg')).toBe(1.5);
    expect(convertLabelAmount('salt', 1500, 'mg')).toBe(1.5);
    expect(convertLabelAmount('cholesterol', 0.03, 'g')).toBe(30);
  });

  it('converts energy between kJ and kcal with 4.184', () => {
    expect(KJ_PER_KCAL).toBe(4.184);
    expect(convertLabelAmount('energy_kcal', 1046, 'kj')).toBe(250);
    expect(convertLabelAmount('energy_kj', 250, 'kcal')).toBe(1046);
    expect(convertLabelAmount('energy_kcal', 0, 'kj')).toBe(0);
  });

  it('converts IU of vitamin D (40 IU = 1 ug) and nothing else', () => {
    expect(IU_PER_UG_VITAMIN_D).toBe(40);
    expect(convertLabelAmount('vitamin_d', 400, 'iu')).toBe(10);
    expect(convertLabelAmount('vitamin_d', 100, 'iu')).toBe(2.5);
    expect(convertLabelAmount('vitamin_a', 5000, 'iu')).toBeNull();
    expect(convertLabelAmount('vitamin_e', 30, 'iu')).toBeNull();
    expect(convertLabelAmount('calcium', 30, 'iu')).toBeNull();
  });

  it('refuses units of a different kind and impossible amounts', () => {
    expect(convertLabelAmount('fat', 5, 'kcal')).toBeNull();
    expect(convertLabelAmount('fat', 5, 'kj')).toBeNull();
    expect(convertLabelAmount('energy_kcal', 5, 'g')).toBeNull();
    expect(convertLabelAmount('energy_kj', 5, 'mg')).toBeNull();
    expect(convertLabelAmount('fat', -1, 'g')).toBeNull();
    expect(convertLabelAmount('fat', Number.NaN, 'g')).toBeNull();
    expect(convertLabelAmount('fat', Number.POSITIVE_INFINITY, 'g')).toBeNull();
  });
});

describe('plausible amounts', () => {
  it('limits per 100 g / 100 ml tighter than per serving', () => {
    expect(maxLabelAmount('g', 'per_100g')).toBe(100);
    expect(maxLabelAmount('g', 'per_100ml')).toBe(100);
    expect(maxLabelAmount('g', 'per_serving')).toBe(1000);
    expect(isPlausibleLabelAmount(100, 'g', 'per_100g')).toBe(true);
    expect(isPlausibleLabelAmount(100.5, 'g', 'per_100g')).toBe(false);
    expect(isPlausibleLabelAmount(150, 'g', 'per_serving')).toBe(true);
    expect(isPlausibleLabelAmount(900, 'kcal', 'per_100g')).toBe(true);
    expect(isPlausibleLabelAmount(1500, 'kcal', 'per_100g')).toBe(false);
    expect(isPlausibleLabelAmount(1500, 'kcal', 'per_serving')).toBe(true);
    expect(isPlausibleLabelAmount(3700, 'kj', 'per_100g')).toBe(true);
    expect(isPlausibleLabelAmount(9000, 'kj', 'per_100g')).toBe(false);
    expect(isPlausibleLabelAmount(39000, 'mg', 'per_100g')).toBe(true);
    expect(isPlausibleLabelAmount(2_000_000, 'mcg', 'per_100g')).toBe(false);
  });

  it('rejects negative and non-finite amounts', () => {
    expect(isPlausibleLabelAmount(-1, 'g', 'per_serving')).toBe(false);
    expect(isPlausibleLabelAmount(Number.NaN, 'g', 'per_serving')).toBe(false);
    expect(isPlausibleLabelAmount(Number.POSITIVE_INFINITY, 'mg', 'per_serving')).toBe(false);
    expect(isPlausibleLabelAmount(0, 'g', 'per_100g')).toBe(true);
  });
});

describe('servingNameFromText', () => {
  it('drops the metric part in brackets and a leading "1"', () => {
    expect(servingNameFromText('1 cup (240 ml)')).toBe('cup');
    expect(servingNameFromText('2/3 cup (55g)')).toBe('2/3 cup');
    expect(servingNameFromText('1 slice (30 g)')).toBe('slice');
    expect(servingNameFromText('2 biscuits (30 g)')).toBe('2 biscuits');
    expect(servingNameFromText('1 can (330 ml)')).toBe('can');
    expect(servingNameFromText('1 bar')).toBe('bar');
    expect(servingNameFromText('about 1 tbsp (15 mL)')).toBe('about 1 tbsp');
    expect(servingNameFromText('1.5 cups')).toBe('1.5 cups');
    expect(servingNameFromText('1 portion (2 slices, 40g)')).toBe('portion');
  });

  it('falls back to "serving" when there is nothing else to call it', () => {
    expect(servingNameFromText(null)).toBe('serving');
    expect(servingNameFromText(undefined)).toBe('serving');
    expect(servingNameFromText('')).toBe('serving');
    expect(servingNameFromText('30 g')).toBe('serving');
    expect(servingNameFromText('250 ml')).toBe('serving');
    expect(servingNameFromText('1')).toBe('serving');
  });

  it('fits the 40 characters of the serving name field', () => {
    expect(servingNameFromText('x'.repeat(100))).toHaveLength(40);
  });
});

describe('labelToFoodDraft: per 100 g', () => {
  it('maps an EU label with kcal, kJ, salt and unit conversions into catalog units', () => {
    const draft = labelToFoodDraft(
      reading(
        [
          ['energy_kj', 2252, 'kj'],
          ['energy_kcal', 539, 'kcal'],
          ['fat', 30.9, 'g'],
          ['saturated_fat', 10.6, 'g'],
          ['carbohydrate', 57.5, 'g'],
          ['sugars', 56.3, 'g'],
          ['fibre', 3.4, 'g'],
          ['protein', 6.3, 'g'],
          ['salt', 0.107, 'g'],
          ['calcium', 0.12, 'g'],
          ['vitamin_d', 2.5, 'mcg'],
          ['iron', 4000, 'mcg'],
        ],
        { productName: '  Choco   Spread ', brand: 'Acme', carbohydrateIncludesFibre: false, serving: { amount: 15, unit: 'g', text: '1 tbsp (15 g)' } },
      ),
    );
    expect(draft.name).toBe('Choco Spread');
    expect(draft.brand).toBe('Acme');
    expect(draft.basis).toBe('per100g');
    expect(draft.nutrients).toEqual({
      ENERGY_KCAL: 539, // the printed kcal wins over 2252 / 4.184
      FAT_G: 30.9,
      SATURATED_FAT_G: 10.6,
      CARBS_G: 57.5,
      SUGARS_G: 56.3,
      FIBER_G: 3.4,
      PROTEIN_G: 6.3,
      SODIUM_MG: 42.8, // 0.107 g salt / 2.5 * 1000
      CALCIUM_MG: 120,
      VITAMIN_D_UG: 2.5,
      IRON_MG: 4,
    });
    expect(draft.carbBasis).toBe('excludes_fiber');
    expect(draft.servings).toEqual([{ name: 'tbsp', grams: 15 }]);
    expect(draft.densityGPerMl).toBeNull();
    expect(draft.unclear).toEqual([]);
    expect(draft.unclearFields).toEqual([]);
  });

  it('converts kJ to kcal when kcal is missing (divide by 4.184) and says so', () => {
    const draft = labelToFoodDraft(reading([['energy_kj', 1046, 'kj'], ['protein', 5, 'g']]));
    expect(draft.nutrients.ENERGY_KCAL).toBe(250);
    expect(draft.notes).toEqual(['Energy is printed in kJ only. It was converted to kcal (kJ divided by 4.184).']);

    // whole kcal, rounded (not truncated): a label prints no more precision than that
    expect(labelToFoodDraft(reading([['energy_kj', 1000, 'kj']])).nutrients.ENERGY_KCAL).toBe(239); // 239.005
    expect(labelToFoodDraft(reading([['energy_kj', 1500, 'kj']])).nutrients.ENERGY_KCAL).toBe(359); // 358.51
    expect(labelToFoodDraft(reading([['energy_kj', 255, 'kj']])).nutrients.ENERGY_KCAL).toBe(61); // 60.94
    expect(labelToFoodDraft(reading([['energy_kj', 0, 'kj']])).nutrients.ENERGY_KCAL).toBe(0);
  });

  it('does not convert kJ when kcal is printed, and warns when the two disagree', () => {
    const agree = labelToFoodDraft(reading([['energy_kj', 1046, 'kj'], ['energy_kcal', 250, 'kcal']]));
    expect(agree.nutrients.ENERGY_KCAL).toBe(250);
    expect(agree.unclear).toEqual([]);
    expect(agree.notes).toEqual([]);

    const roundedPrint = labelToFoodDraft(reading([['energy_kj', 1050, 'kj'], ['energy_kcal', 250, 'kcal']]));
    expect(roundedPrint.unclear).toEqual([]);

    const differ = labelToFoodDraft(reading([['energy_kj', 2092, 'kj'], ['energy_kcal', 250, 'kcal']]));
    expect(differ.nutrients.ENERGY_KCAL).toBe(250);
    expect(differ.unclear).toEqual(['ENERGY_KCAL']);
    expect(differ.notes[0]).toBe('The kJ (2092) and kcal (250) on the label do not match. Check the energy.');
  });

  it('calculates sodium from salt when the label has no sodium line (salt / 2.5, in mg)', () => {
    expect(SALT_PER_SODIUM).toBe(2.5);
    const draft = labelToFoodDraft(reading([['salt', 1.3, 'g'], ['protein', 5, 'g']]));
    expect(draft.nutrients.SODIUM_MG).toBe(520);
    expect(draft.nutrients).not.toHaveProperty('SALT_G');
    expect(draft.notes).toEqual(['The label lists salt, not sodium. Sodium was calculated from it (salt divided by 2.5).']);
    expect(labelToFoodDraft(reading([['salt', 0.01, 'g']])).nutrients.SODIUM_MG).toBe(4);
    expect(labelToFoodDraft(reading([['salt', 2500, 'mg']])).nutrients.SODIUM_MG).toBe(1000);
    expect(labelToFoodDraft(reading([['salt', 0, 'g']])).nutrients.SODIUM_MG).toBe(0);
  });

  it('prefers printed sodium over salt and flags a mismatch', () => {
    const agree = labelToFoodDraft(reading([['sodium', 520, 'mg'], ['salt', 1.3, 'g']]));
    expect(agree.nutrients.SODIUM_MG).toBe(520);
    expect(agree.unclear).toEqual([]);
    expect(agree.notes).toEqual([]);
    const tolerant = labelToFoodDraft(reading([['sodium', 0.5, 'g'], ['salt', 1.3, 'g']]));
    expect(tolerant.nutrients.SODIUM_MG).toBe(500);
    expect(tolerant.unclear).toEqual([]);

    const differ = labelToFoodDraft(reading([['sodium', 200, 'mg'], ['salt', 1.3, 'g']]));
    expect(differ.nutrients.SODIUM_MG).toBe(200);
    expect(differ.unclear).toEqual(['SODIUM_MG']);
    expect(differ.notes).toEqual(['The salt and sodium on the label do not match. Check the sodium.']);
  });

  it('converts sodium printed in g and vitamins printed in other mass units', () => {
    const draft = labelToFoodDraft(
      reading([['sodium', 0.48, 'g'], ['vitamin_c', 0.06, 'g'], ['vitamin_b12', 0.0024, 'mg'], ['folate', 0.4, 'mg'], ['potassium', 0.3, 'g']]),
    );
    expect(draft.nutrients).toEqual({ SODIUM_MG: 480, VITAMIN_C_MG: 60, B12_UG: 2.4, FOLATE_UG: 400, POTASSIUM_MG: 300 });
  });

  it('converts IU of vitamin D and leaves out IU of other vitamins with a note', () => {
    const draft = labelToFoodDraft(reading([['vitamin_d', 400, 'iu'], ['vitamin_a', 5000, 'iu'], ['protein', 4, 'g']]));
    expect(draft.nutrients).toEqual({ VITAMIN_D_UG: 10, PROTEIN_G: 4 });
    expect(draft.notes).toEqual([
      'Vitamin A is printed in IU, which cannot be converted to the unit Cal Track stores without knowing the form of the vitamin. It was left out.',
    ]);
  });

  it('leaves out a value in a unit of the wrong kind', () => {
    const draft = labelToFoodDraft(reading([['fat', 5, 'kcal'], ['protein', 5, 'g']]));
    expect(draft.nutrients).toEqual({ PROTEIN_G: 5 });
    expect(draft.notes).toEqual(['Fat has an unexpected unit (kcal) and was left out.']);
  });

  it('keeps 0 as 0 (printed as none) and leaves not-printed nutrients unknown', () => {
    const draft = labelToFoodDraft(reading([['trans_fat', 0, 'g'], ['cholesterol', 0, 'mg'], ['protein', 3, 'g']]));
    expect(draft.nutrients).toEqual({ TRANS_FAT_G: 0, CHOLESTEROL_MG: 0, PROTEIN_G: 3 });
    expect(draft.nutrients).not.toHaveProperty('FAT_G');
  });

  it('uses the first of a duplicated key and ignores keys that are not in the list', () => {
    const draft = labelToFoodDraft(
      reading([['protein', 5, 'g'], ['protein', 9, 'g'], ['bogus' as LabelNutrientKey, 1, 'g'], ['fat', 2, 'g']]),
    );
    expect(draft.nutrients).toEqual({ PROTEIN_G: 5, FAT_G: 2 });
  });

  it('rounds away conversion noise but not real digits', () => {
    const draft = labelToFoodDraft(reading([['calcium', 0.0003, 'g'], ['iron', 1234.5678, 'mcg'], ['zinc', 1.23456789, 'mg']]));
    expect(draft.nutrients).toEqual({ CALCIUM_MG: 0.3, IRON_MG: 1.2346, ZINC_MG: 1.2346 });
  });
});

describe('labelToFoodDraft: serving, per serving and ml', () => {
  it('keeps a per-serving label per serving, with the serving in grams (the form does the per-100 g maths)', () => {
    const draft = labelToFoodDraft(
      reading([['energy_kcal', 230, 'kcal'], ['fat', 8, 'g'], ['carbohydrate', 37, 'g'], ['protein', 3, 'g']], {
        basis: 'per_serving',
        serving: { amount: 55, unit: 'g', text: '2/3 cup' },
        servingsPerContainer: 8,
      }),
    );
    expect(draft.basis).toBe('perServing');
    expect(draft.nutrients).toEqual({ ENERGY_KCAL: 230, FAT_G: 8, CARBS_G: 37, PROTEIN_G: 3 });
    expect(draft.servings).toEqual([{ name: '2/3 cup', grams: 55 }]);
    expect(draft.densityGPerMl).toBeNull();
    expect(draft.unclearFields).toEqual([]);
  });

  it('a per-serving label without a readable serving size asks the user for it', () => {
    const draft = labelToFoodDraft(reading([['energy_kcal', 230, 'kcal'], ['protein', 3, 'g']], { basis: 'per_serving' }));
    expect(draft.basis).toBe('perServing');
    expect(draft.servings).toEqual([{ name: 'serving', grams: null }]);
    expect(draft.unclearFields).toEqual(['serving']);
    expect(draft.notes).toEqual([expect.stringMatching(/serving size could not be read.*enter the serving size in grams/)]);

    // only the household measure was read
    const withText = labelToFoodDraft(
      reading([['protein', 3, 'g']], { basis: 'per_serving', serving: { amount: null, unit: null, text: '1 bar' } }),
    );
    expect(withText.servings).toEqual([{ name: 'bar', grams: null }]);
    expect(withText.unclearFields).toEqual(['serving']);

    // an amount without a unit cannot be grams
    const noUnit = labelToFoodDraft(
      reading([['protein', 3, 'g']], { basis: 'per_serving', serving: { amount: 30, unit: null, text: null } }),
    );
    expect(noUnit.servings).toEqual([{ name: 'serving', grams: null }]);
  });

  it('a per-serving label with a serving in ml assumes 1 g per ml, sets the density and says so', () => {
    const draft = labelToFoodDraft(
      reading([['energy_kcal', 100, 'kcal'], ['sugars', 27, 'g']], {
        basis: 'per_serving',
        serving: { amount: 250, unit: 'ml', text: '1 can (250 ml)' },
      }),
    );
    expect(ASSUMED_DENSITY_G_PER_ML).toBe(1);
    expect(draft.basis).toBe('perServing');
    expect(draft.servings).toEqual([{ name: 'can', grams: 250 }]);
    expect(draft.densityGPerMl).toBe(1);
    expect(draft.notes).toEqual([expect.stringMatching(/serving is given in ml.*1 g per ml was assumed/)]);
  });

  it('a per 100 ml label is stored per 100 g with a density of 1, and says so', () => {
    const draft = labelToFoodDraft(
      reading([['energy_kcal', 42, 'kcal'], ['sugars', 10.6, 'g']], {
        basis: 'per_100ml',
        serving: { amount: 330, unit: 'ml', text: '1 can' },
      }),
    );
    expect(draft.basis).toBe('per100g');
    expect(draft.nutrients).toEqual({ ENERGY_KCAL: 42, SUGARS_G: 10.6 });
    expect(draft.densityGPerMl).toBe(1);
    expect(draft.servings).toEqual([{ name: 'can', grams: 330 }]);
    // one note about the assumption, not two
    expect(draft.notes).toHaveLength(1);
    expect(draft.notes[0]).toMatch(/values are per 100 ml.*1 g per ml was assumed/);
  });

  it('a per 100 g label with a printed serving also offers that serving', () => {
    const draft = labelToFoodDraft(
      reading([['protein', 20, 'g']], { basis: 'per_100g', serving: { amount: 30, unit: 'g', text: '1 scoop (30 g)' } }),
    );
    expect(draft.basis).toBe('per100g');
    expect(draft.servings).toEqual([{ name: 'scoop', grams: 30 }]);
  });

  it('adds no serving when the label prints none, and ignores a serving of 0', () => {
    expect(labelToFoodDraft(reading([['protein', 20, 'g']])).servings).toEqual([]);
    expect(
      labelToFoodDraft(reading([['protein', 20, 'g']], { serving: { amount: 0, unit: 'g', text: null } })).servings,
    ).toEqual([]);
  });
});

describe('labelToFoodDraft: carbohydrate basis', () => {
  const withEnergy = (kcal: number) => us().nutrients.map((x) => (x.key === 'energy_kcal' ? { ...x, amount: kcal } : x));
  const us = (over: Partial<LabelReading> = {}) =>
    reading(
      // 244 kcal if carbohydrate includes the 4 g fibre, 260 if it does not: 252 fits both equally
      [['energy_kcal', 252, 'kcal'], ['fat', 8, 'g'], ['carbohydrate', 40, 'g'], ['fibre', 4, 'g'], ['protein', 5, 'g']],
      over,
    );

  it('follows what the reader saw in the layout', () => {
    expect(labelToFoodDraft(us({ carbohydrateIncludesFibre: true })).carbBasis).toBe('includes_fiber');
    expect(labelToFoodDraft(us({ carbohydrateIncludesFibre: false })).carbBasis).toBe('excludes_fiber');
    expect(labelToFoodDraft(us({ carbohydrateIncludesFibre: true })).unclearFields).toEqual([]);
  });

  it('uses the energy of the label when it is decisive (EU: 2 kcal/g fibre, carbohydrate without fibre)', () => {
    // 4*10 + 9*5 + 4*50 + 2*10 = 305: carbs EXCLUDE fibre. Included would be 265.
    const eu = reading(
      [['energy_kcal', 305, 'kcal'], ['protein', 10, 'g'], ['fat', 5, 'g'], ['carbohydrate', 50, 'g'], ['fibre', 10, 'g']],
    );
    expect(labelToFoodDraft(eu).carbBasis).toBe('excludes_fiber');
    expect(labelToFoodDraft(eu).unclearFields).toEqual([]);
    // the energy is stronger than a wrong hint
    expect(labelToFoodDraft({ ...eu, carbohydrateIncludesFibre: true }).carbBasis).toBe('excludes_fiber');

    // 4*10 + 9*5 + 4*(50-10) + 2*10 = 265: carbs INCLUDE fibre
    const included = reading(
      [['energy_kcal', 265, 'kcal'], ['protein', 10, 'g'], ['fat', 5, 'g'], ['carbohydrate', 50, 'g'], ['fibre', 10, 'g']],
    );
    expect(labelToFoodDraft(included).carbBasis).toBe('includes_fiber');
    expect(labelToFoodDraft({ ...included, carbohydrateIncludesFibre: false }).carbBasis).toBe('includes_fiber');
  });

  it('uses energy printed in kJ only', () => {
    const eu = reading(
      [['energy_kj', 1276, 'kj'], ['protein', 10, 'g'], ['fat', 5, 'g'], ['carbohydrate', 50, 'g'], ['fibre', 10, 'g']],
    );
    expect(labelToFoodDraft(eu).nutrients.ENERGY_KCAL).toBe(305);
    expect(labelToFoodDraft(eu).carbBasis).toBe('excludes_fiber');
  });

  it('does not let the energy decide when the difference is within label rounding', () => {
    // 244 or 260: a printed 250 (US labels round to 5) does not tell
    const draft = labelToFoodDraft(us({ nutrients: withEnergy(250) }));
    expect(draft.carbBasis).toBe('includes_fiber'); // the default
    expect(draft.unclearFields).toEqual(['carbBasis']);
  });

  it('lets a weaker energy signal decide only when the layout is silent', () => {
    // 247 leans to "included" (244) by 10 kcal, which is 2.5 kcal per gram of fibre: leaning, not conclusive
    expect(labelToFoodDraft(us({ nutrients: withEnergy(247) })).carbBasis).toBe('includes_fiber');
    expect(labelToFoodDraft(us({ nutrients: withEnergy(247) })).unclearFields).toEqual([]);
    expect(labelToFoodDraft(us({ nutrients: withEnergy(257) })).carbBasis).toBe('excludes_fiber');
    expect(labelToFoodDraft(us({ nutrients: withEnergy(247), carbohydrateIncludesFibre: false })).carbBasis).toBe('excludes_fiber');
    // conclusive (3 kcal per gram of fibre or more) beats the layout
    expect(labelToFoodDraft(us({ nutrients: withEnergy(244), carbohydrateIncludesFibre: false })).carbBasis).toBe('includes_fiber');
    expect(labelToFoodDraft(us({ nutrients: withEnergy(260), carbohydrateIncludesFibre: true })).carbBasis).toBe('excludes_fiber');
  });

  it('falls back to the default, and marks the switch unclear, when nothing decides', () => {
    const draft = labelToFoodDraft(us());
    expect(draft.carbBasis).toBe('includes_fiber');
    expect(draft.unclearFields).toEqual(['carbBasis']);
    expect(draft.notes).toEqual([expect.stringMatching(/Could not tell whether the label's carbohydrate includes fibre.*left on/)]);

    const excludesByDefault = labelToFoodDraft(us(), { defaultCarbBasis: 'excludes_fiber' });
    expect(excludesByDefault.carbBasis).toBe('excludes_fiber');
    expect(excludesByDefault.notes[0]).toMatch(/left off/);
  });

  it('does not bother when no fibre is printed, since it changes nothing', () => {
    const draft = labelToFoodDraft(reading([['energy_kcal', 100, 'kcal'], ['carbohydrate', 20, 'g'], ['protein', 5, 'g'], ['fat', 0, 'g']]));
    expect(draft.carbBasis).toBe('includes_fiber');
    expect(draft.unclearFields).toEqual([]);
    expect(labelToFoodDraft(reading([['carbohydrate', 20, 'g']], { carbohydrateIncludesFibre: false })).carbBasis).toBe('excludes_fiber');
    expect(labelToFoodDraft(reading([['carbohydrate', 20, 'g'], ['fibre', 0, 'g']])).unclearFields).toEqual([]);
  });

  it('skips the energy check when sugar alcohols (2.4 kcal/g) are printed', () => {
    const draft = labelToFoodDraft(
      reading([['energy_kcal', 220, 'kcal'], ['protein', 10, 'g'], ['fat', 5, 'g'], ['carbohydrate', 50, 'g'], ['fibre', 10, 'g'], ['polyols', 20, 'g']], {
        carbohydrateIncludesFibre: false,
      }),
    );
    expect(draft.carbBasis).toBe('excludes_fiber'); // the layout, not the energy
  });
});

describe('labelToFoodDraft: unclear values', () => {
  it('lists the nutrients the reader flagged, in catalog order', () => {
    const draft = labelToFoodDraft(
      reading([['protein', 5, 'g', true], ['energy_kcal', 100, 'kcal'], ['sodium', 300, 'mg', true], ['fat', 2, 'g']]),
    );
    expect(draft.unclear).toEqual(['PROTEIN_G', 'SODIUM_MG']);
    expect(draft.unclear).toEqual(NUTRIENT_CODES.filter((c) => draft.unclear.includes(c)));
  });

  it('carries the flag of a converted value to the nutrient it became', () => {
    expect(labelToFoodDraft(reading([['energy_kj', 1046, 'kj', true]])).unclear).toEqual(['ENERGY_KCAL']);
    expect(labelToFoodDraft(reading([['salt', 1.3, 'g', true]])).unclear).toEqual(['SODIUM_MG']);
    expect(labelToFoodDraft(reading([['energy_kj', 1046, 'kj', true], ['energy_kcal', 250, 'kcal']])).unclear).toEqual([]);
  });

  it('maps the fields the reader doubted to the form fields', () => {
    const draft = labelToFoodDraft(
      reading([['protein', 5, 'g']], { unclearFields: ['productName', 'brand', 'basis', 'servingSize', 'servingsPerContainer'] }),
    );
    expect(draft.unclearFields).toEqual(['name', 'brand', 'serving', 'basis']);
  });

  it('flags values that disagree with each other', () => {
    const sugars = labelToFoodDraft(reading([['carbohydrate', 10, 'g'], ['sugars', 25, 'g']]));
    expect(sugars.unclear).toEqual(['CARBS_G', 'SUGARS_G']);
    expect(sugars.notes).toEqual(['Sugars are higher than carbohydrate. Check both.']);

    const sat = labelToFoodDraft(reading([['fat', 3, 'g'], ['saturated_fat', 9, 'g']]));
    expect(sat.unclear).toEqual(['FAT_G', 'SATURATED_FAT_G']);

    const added = labelToFoodDraft(reading([['sugars', 3, 'g'], ['added_sugars', 9, 'g']]));
    expect(added.unclear).toEqual(['SUGARS_G', 'ADDED_SUGARS_G']);

    // fibre above carbohydrate only matters when carbohydrate includes fibre
    const fibre = labelToFoodDraft(reading([['carbohydrate', 3, 'g'], ['fibre', 9, 'g']], { carbohydrateIncludesFibre: true }));
    expect(fibre.unclear).toEqual(['CARBS_G', 'FIBER_G']);
    const fibreEu = labelToFoodDraft(reading([['carbohydrate', 3, 'g'], ['fibre', 9, 'g']], { carbohydrateIncludesFibre: false }));
    expect(fibreEu.unclear).toEqual([]);

    // tiny label rounding is fine
    expect(labelToFoodDraft(reading([['carbohydrate', 10, 'g'], ['sugars', 10.4, 'g']])).unclear).toEqual([]);
  });

  it('flags macros that weigh more than the food', () => {
    const per100 = labelToFoodDraft(reading([['protein', 60, 'g'], ['carbohydrate', 40, 'g'], ['fat', 20, 'g']]));
    expect(per100.unclear).toEqual(['CARBS_G', 'FAT_G', 'PROTEIN_G']);
    const perServing = labelToFoodDraft(
      reading([['protein', 20, 'g'], ['carbohydrate', 20, 'g'], ['fat', 15, 'g']], { basis: 'per_serving', serving: { amount: 30, unit: 'g', text: null } }),
    );
    expect(perServing.unclear).toEqual(['CARBS_G', 'FAT_G', 'PROTEIN_G']);
    // unknown serving: nothing to compare with
    const unknownServing = labelToFoodDraft(reading([['protein', 20, 'g'], ['carbohydrate', 20, 'g'], ['fat', 15, 'g']], { basis: 'per_serving' }));
    expect(unknownServing.unclear).not.toContain('PROTEIN_G');
  });

  it('flags energy that does not fit protein, carbohydrate and fat', () => {
    const base: Row[] = [['protein', 10, 'g'], ['carbohydrate', 30, 'g'], ['fat', 8, 'g']]; // ~232 kcal
    const fine = labelToFoodDraft(reading([['energy_kcal', 235, 'kcal'], ...base]));
    expect(fine.unclear).toEqual([]);
    const misread = labelToFoodDraft(reading([['energy_kcal', 520, 'kcal'], ...base]));
    expect(misread.unclear).toEqual(['ENERGY_KCAL', 'CARBS_G', 'FAT_G', 'PROTEIN_G']);
    expect(misread.notes[0]).toBe('The energy (520 kcal) does not match protein, carbohydrate and fat (about 232 kcal). One of them may be misread.');
    const tooLow = labelToFoodDraft(reading([['energy_kcal', 25, 'kcal'], ...base]));
    expect(tooLow.unclear).toContain('ENERGY_KCAL');
  });

  it('does not cry wolf for drinks with alcohol or sugar alcohols (energy above the macros)', () => {
    const wine = labelToFoodDraft(reading([['energy_kcal', 83, 'kcal'], ['protein', 0.1, 'g'], ['carbohydrate', 2.6, 'g'], ['fat', 0, 'g']], { basis: 'per_100ml' }));
    expect(wine.unclear).toEqual([]);
    const sweets = labelToFoodDraft(
      reading([['energy_kcal', 320, 'kcal'], ['protein', 1, 'g'], ['carbohydrate', 75, 'g'], ['polyols', 60, 'g'], ['fat', 0, 'g']]),
    );
    expect(sweets.unclear).toEqual([]);
  });
});

describe('labelToFoodDraft: names and notes', () => {
  it('trims the name and brand, and uses null for empty ones', () => {
    const draft = labelToFoodDraft(reading([['protein', 5, 'g']], { productName: '  ', brand: ' ACME  Foods ' }));
    expect(draft.name).toBeNull();
    expect(draft.brand).toBe('ACME Foods');
    expect(labelToFoodDraft(reading([['protein', 5, 'g']], { productName: 'x'.repeat(300) })).name).toHaveLength(120);
  });

  it('puts the reader\'s note first, then its warnings, then what the app converted; no duplicates, at most 8', () => {
    const draft = labelToFoodDraft(
      reading([['energy_kj', 1046, 'kj'], ['salt', 1.3, 'g']], {
        notes: 'A per-serving column also exists.',
        warnings: ['Protein (250 g) does not look right for this label and was left out.', 'A per-serving column also exists.'],
      }),
    );
    expect(draft.notes).toEqual([
      'A per-serving column also exists.',
      'Protein (250 g) does not look right for this label and was left out.',
      'Energy is printed in kJ only. It was converted to kcal (kJ divided by 4.184).',
      'The label lists salt, not sodium. Sodium was calculated from it (salt divided by 2.5).',
    ]);
    const many = labelToFoodDraft(reading([['protein', 5, 'g']], { warnings: Array.from({ length: 20 }, (_, i) => `warning ${i}`) }));
    expect(many.notes).toHaveLength(8);
  });

  it('never invents values: an empty reading gives an empty draft', () => {
    const draft = labelToFoodDraft(reading([]));
    expect(draft.nutrients).toEqual({});
    expect(draft.unclear).toEqual([]);
    expect(draft.servings).toEqual([]);
  });

  it('does not change the reading it was given', () => {
    const input = reading([['energy_kj', 1046, 'kj'], ['salt', 1.3, 'g', true]], { warnings: ['w'] });
    const copy = JSON.parse(JSON.stringify(input));
    labelToFoodDraft(input);
    expect(input).toEqual(copy);
  });
});
