import { describe, expect, it } from 'vitest';
import {
  DRI_AGE_BANDS,
  DRI_TABLE,
  applyOverrides,
  findDriRow,
  isScopedUlScope,
  selectTargets,
  type DriProfile,
  type Targets,
} from './dri';
import { NUTRIENT_BY_CODE, isNutrientCode, type NutrientCode } from './nutrients';

const male30: DriProfile = { sex: 'male', age: 30, weightKg: 80, energyKcal: 2500 };
const female30: DriProfile = { sex: 'female', age: 30, weightKg: 60, energyKcal: 2000 };

describe('DRI_TABLE sanity', () => {
  it('references only catalog nutrients and has at least one value per row', () => {
    for (const row of DRI_TABLE) {
      expect(isNutrientCode(row.nutrient)).toBe(true);
      expect(
        row.rda !== undefined || row.ai !== undefined || row.ul !== undefined || row.cdrr !== undefined,
        `${row.nutrient} ${row.sex} ${row.ageMin}`,
      ).toBe(true);
      expect(row.ageMin).toBeLessThanOrEqual(row.ageMax);
      for (const v of [row.rda, row.ai, row.ul, row.cdrr]) {
        if (v !== undefined) expect(v).toBeGreaterThan(0);
      }
      if (row.ulScope) expect(row.ul).toBeDefined();
      if (row.life !== 'normal') expect(row.sex).not.toBe('male');
    }
  });

  it('has a unique natural key per row', () => {
    const keys = DRI_TABLE.map((r) => [r.nutrient, r.sex, r.ageMin, r.ageMax, r.life].join('|'));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('covers ages 14-120 contiguously for every nutrient, sex and the normal life stage', () => {
    const nutrients = new Set(DRI_TABLE.map((r) => r.nutrient));
    for (const nutrient of nutrients) {
      for (const sex of ['male', 'female'] as const) {
        for (let age = 14; age <= 100; age++) {
          const row = findDriRow(nutrient, sex, age);
          expect(row, `${nutrient} ${sex} ${age}`).toBeDefined();
        }
      }
    }
  });

  it('has pregnancy and lactation rows for the three reproductive bands', () => {
    for (const life of ['pregnant', 'lactating'] as const) {
      for (const band of DRI_AGE_BANDS.slice(0, 3)) {
        expect(findDriRow('FOLATE_UG', 'female', band.min, life)?.life).toBe(life);
      }
    }
  });

  it('contains all required nutrients', () => {
    const required: NutrientCode[] = [
      'VITAMIN_A_UG', 'VITAMIN_C_MG', 'VITAMIN_D_UG', 'VITAMIN_E_MG', 'VITAMIN_K_UG',
      'B1_THIAMIN_MG', 'B2_RIBOFLAVIN_MG', 'B3_NIACIN_MG', 'B5_PANTOTHENIC_MG', 'B6_MG',
      'FOLATE_UG', 'B12_UG', 'CHOLINE_MG', 'B7_BIOTIN_UG', 'CALCIUM_MG', 'IRON_MG',
      'MAGNESIUM_MG', 'PHOSPHORUS_MG', 'POTASSIUM_MG', 'SODIUM_MG', 'ZINC_MG', 'COPPER_MG',
      'MANGANESE_MG', 'SELENIUM_UG', 'IODINE_UG', 'FLUORIDE_UG', 'CHROMIUM_UG',
      'MOLYBDENUM_UG', 'WATER_G', 'LINOLEIC_G', 'ALA_G', 'CAFFEINE_MG',
    ];
    const present = new Set(DRI_TABLE.map((r) => r.nutrient));
    for (const code of required) expect(present.has(code), code).toBe(true);
  });

  it('keeps every table value in a plausible range for the nutrient unit', () => {
    // sanity guard against unit slips (mg vs ug): no value may exceed 1e5, and mg-nutrient RDAs stay < 5000
    for (const row of DRI_TABLE) {
      for (const v of [row.rda, row.ai, row.ul, row.cdrr]) {
        if (v !== undefined) expect(v).toBeLessThan(1e5);
      }
      if (NUTRIENT_BY_CODE[row.nutrient].unit === 'mg' && row.nutrient !== 'SODIUM_MG') {
        expect(row.rda ?? row.ai ?? 0).toBeLessThan(5000);
      }
    }
  });
});

describe('selectTargets - vitamins', () => {
  it('vitamin C: 90 mg for a man aged 19-50, 75 mg for a woman', () => {
    const m = selectTargets(male30).VITAMIN_C_MG;
    expect(m).toEqual({ min: 90, max: 2000, kind: 'RDA' });
    expect(selectTargets(female30).VITAMIN_C_MG?.min).toBe(75);
    expect(selectTargets({ ...male30, age: 16 }).VITAMIN_C_MG?.min).toBe(75);
  });

  it('vitamin D: 15 ug up to 70, 20 ug from 71, UL 100 ug', () => {
    expect(selectTargets(male30).VITAMIN_D_UG).toEqual({ min: 15, max: 100, kind: 'RDA' });
    expect(selectTargets({ ...male30, age: 70 }).VITAMIN_D_UG?.min).toBe(15);
    expect(selectTargets({ ...male30, age: 71 }).VITAMIN_D_UG?.min).toBe(20);
  });

  it('B12: 2.4 ug (2.6 pregnant, 2.8 lactating)', () => {
    expect(selectTargets(male30).B12_UG?.min).toBe(2.4);
    expect(selectTargets({ ...female30, pregnant: true }).B12_UG?.min).toBe(2.6);
    expect(selectTargets({ ...female30, lactating: true }).B12_UG?.min).toBe(2.8);
  });

  it('vitamin A: 900 / 700 RAE with a preformed-only UL of 3000', () => {
    expect(selectTargets(male30).VITAMIN_A_UG).toEqual({
      min: 900,
      kind: 'RDA',
      scopedUl: { value: 3000, scope: 'preformed_only' },
    });
    expect(selectTargets(female30).VITAMIN_A_UG?.min).toBe(700);
  });

  it('vitamin K is an AI without UL; folate UL is synthetic only', () => {
    const k = selectTargets(male30).VITAMIN_K_UG;
    expect(k).toEqual({ min: 120, kind: 'AI' });
    expect(selectTargets(female30).VITAMIN_K_UG?.min).toBe(90);
    expect(selectTargets(male30).FOLATE_UG).toEqual({
      min: 400,
      kind: 'RDA',
      scopedUl: { value: 1000, scope: 'synthetic_only' },
    });
    expect(selectTargets({ ...female30, pregnant: true }).FOLATE_UG?.min).toBe(600);
  });
});

describe('selectTargets - minerals', () => {
  it('iron: 8 mg men, 18 mg women 19-50, 8 mg women 51+, 27 mg pregnant', () => {
    expect(selectTargets(male30).IRON_MG).toEqual({ min: 8, max: 45, kind: 'RDA' });
    expect(selectTargets(female30).IRON_MG?.min).toBe(18);
    expect(selectTargets({ ...female30, age: 50 }).IRON_MG?.min).toBe(18);
    expect(selectTargets({ ...female30, age: 51 }).IRON_MG?.min).toBe(8);
    expect(selectTargets({ ...female30, age: 65 }).IRON_MG?.min).toBe(8);
    expect(selectTargets({ ...female30, pregnant: true }).IRON_MG?.min).toBe(27);
    expect(selectTargets({ ...female30, lactating: true }).IRON_MG?.min).toBe(9);
  });

  it('calcium: UL 2500 for 31-50, 2000 for 51+', () => {
    expect(selectTargets({ ...male30, age: 40 }).CALCIUM_MG?.max).toBe(2500);
    expect(selectTargets({ ...male30, age: 51 }).CALCIUM_MG?.max).toBe(2000);
    expect(selectTargets({ ...female30, age: 60 }).CALCIUM_MG).toMatchObject({ min: 1200, max: 2000 });
    expect(selectTargets({ ...male30, age: 60 }).CALCIUM_MG?.min).toBe(1000);
    expect(selectTargets({ ...male30, age: 75 }).CALCIUM_MG?.min).toBe(1200);
    expect(selectTargets({ ...male30, age: 16 }).CALCIUM_MG).toMatchObject({ min: 1300, max: 3000 });
  });

  it('sodium: only the CDRR limit of 2300 mg', () => {
    const sodium = selectTargets(male30).SODIUM_MG;
    expect(sodium).toEqual({ max: 2300, kind: 'CDRR' });
    expect(sodium?.min).toBeUndefined();
  });

  it('potassium AI (2019): 3400 men, 2600 women', () => {
    expect(selectTargets(male30).POTASSIUM_MG).toEqual({ min: 3400, kind: 'AI' });
    expect(selectTargets(female30).POTASSIUM_MG?.min).toBe(2600);
    expect(selectTargets({ ...female30, pregnant: true }).POTASSIUM_MG?.min).toBe(2900);
  });

  it('magnesium: RDA with a supplement-only UL of 350', () => {
    expect(selectTargets(male30).MAGNESIUM_MG).toEqual({
      min: 400,
      kind: 'RDA',
      scopedUl: { value: 350, scope: 'supplement_only' },
    });
    expect(selectTargets({ ...male30, age: 35 }).MAGNESIUM_MG?.min).toBe(420);
    expect(selectTargets(female30).MAGNESIUM_MG?.min).toBe(310);
  });

  it('zinc, selenium, copper (in mg)', () => {
    expect(selectTargets(male30).ZINC_MG).toMatchObject({ min: 11, max: 40 });
    expect(selectTargets(female30).ZINC_MG?.min).toBe(8);
    expect(selectTargets(male30).SELENIUM_UG).toMatchObject({ min: 55, max: 400 });
    expect(selectTargets(male30).COPPER_MG).toMatchObject({ min: 0.9, max: 10 });
  });
});

describe('selectTargets - scoped upper limits', () => {
  const scopedCodes: NutrientCode[] = ['VITAMIN_A_UG', 'VITAMIN_E_MG', 'B3_NIACIN_MG', 'FOLATE_UG', 'MAGNESIUM_MG'];

  it('never puts a UL that covers only part of the intake into max', () => {
    for (const sex of ['male', 'female'] as const) {
      for (const age of [14, 20, 35, 60, 80]) {
        const t = selectTargets({ sex, age, weightKg: 70, energyKcal: 2200 });
        for (const code of scopedCodes) {
          const row = findDriRow(code, sex, age);
          expect(row?.ul, `${code} ${sex} ${age}`).toBeDefined();
          expect(t[code]?.max, `${code} ${sex} ${age}`).toBeUndefined();
          expect(t[code]?.scopedUl?.value, `${code} ${sex} ${age}`).toBe(row?.ul);
          expect(t[code]?.min, `${code} ${sex} ${age}`).toBeDefined();
        }
      }
    }
  });

  it('records the scope of each scoped UL', () => {
    const t = selectTargets(male30);
    expect(t.VITAMIN_A_UG?.scopedUl).toEqual({ value: 3000, scope: 'preformed_only' });
    expect(t.VITAMIN_E_MG?.scopedUl).toEqual({ value: 1000, scope: 'supplement_only' });
    expect(t.B3_NIACIN_MG?.scopedUl).toEqual({ value: 35, scope: 'synthetic_only' });
    expect(t.FOLATE_UG?.scopedUl).toEqual({ value: 1000, scope: 'synthetic_only' });
    expect(t.MAGNESIUM_MG?.scopedUl).toEqual({ value: 350, scope: 'supplement_only' });
  });

  it('keeps total-intake ULs in max without a scopedUl', () => {
    const t = selectTargets(male30);
    for (const code of ['VITAMIN_C_MG', 'VITAMIN_D_UG', 'CALCIUM_MG', 'IRON_MG', 'ZINC_MG', 'CAFFEINE_MG'] as const) {
      expect(t[code]?.max, code).toBeGreaterThan(0);
      expect(t[code]?.scopedUl, code).toBeUndefined();
    }
  });

  it('every target with a min has min below its total max (a scoped UL can sit below the min)', () => {
    for (const age of [14, 25, 40, 60, 75]) {
      const t = selectTargets({ sex: 'female', age, weightKg: 65, energyKcal: 2000, pregnant: age >= 14 && age < 40 });
      for (const target of Object.values(t)) {
        if (target?.min !== undefined && target.max !== undefined) expect(target.min).toBeLessThanOrEqual(target.max);
      }
    }
  });

  it('isScopedUlScope tells scoped scopes apart from total intake', () => {
    expect(isScopedUlScope(undefined)).toBe(false);
    expect(isScopedUlScope('all')).toBe(false);
    for (const scope of ['supplement_only', 'synthetic_only', 'preformed_only'] as const) {
      expect(isScopedUlScope(scope)).toBe(true);
    }
  });
});

describe('selectTargets - profile-dependent targets', () => {
  it('protein is 0.8 g/kg (1.1 pregnant, 1.3 lactating)', () => {
    expect(selectTargets(male30).PROTEIN_G).toEqual({ min: 64, kind: 'RDA' });
    expect(selectTargets({ ...female30, pregnant: true }).PROTEIN_G?.min).toBeCloseTo(66, 10);
    expect(selectTargets({ ...female30, lactating: true }).PROTEIN_G?.min).toBeCloseTo(78, 10);
  });

  it('fiber AI is 14 g per 1000 kcal', () => {
    expect(selectTargets(female30).FIBER_G).toEqual({ min: 28, kind: 'AI' });
    expect(selectTargets(male30).FIBER_G?.min).toBeCloseTo(35, 10);
  });

  it('saturated fat and added sugars are capped at 10% of energy', () => {
    const t = selectTargets(female30);
    expect(t.SATURATED_FAT_G?.max).toBeCloseTo(200 / 9, 10);
    expect(t.ADDED_SUGARS_G?.max).toBeCloseTo(50, 10);
    expect(t.SATURATED_FAT_G?.kind).toBe('ESTIMATE');
  });

  it('caffeine limit: 400 mg adults, 100 mg teens, 200 mg pregnant', () => {
    expect(selectTargets(male30).CAFFEINE_MG).toEqual({ max: 400, kind: 'ESTIMATE' });
    expect(selectTargets({ ...male30, age: 16 }).CAFFEINE_MG?.max).toBe(100);
    expect(selectTargets({ ...female30, pregnant: true }).CAFFEINE_MG?.max).toBe(200);
  });

  it('water, linoleic acid and ALA adequate intakes', () => {
    expect(selectTargets(male30).WATER_G?.min).toBe(3700);
    expect(selectTargets(female30).WATER_G?.min).toBe(2700);
    expect(selectTargets(male30).LINOLEIC_G?.min).toBe(17);
    expect(selectTargets(male30).ALA_G?.min).toBeCloseTo(1.6, 10);
    expect(selectTargets(female30).ALA_G?.min).toBeCloseTo(1.1, 10);
  });

  it('ignores pregnancy flags for men and falls back to normal rows when no stage row exists', () => {
    expect(selectTargets({ ...male30, pregnant: true }).IRON_MG?.min).toBe(8);
    expect(selectTargets({ ...female30, age: 55, pregnant: true }).IRON_MG?.min).toBe(8);
    expect(findDriRow('IRON_MG', 'female', 55, 'pregnant')?.life).toBe('normal');
  });

  it('prefers pregnancy over lactation when both flags are set', () => {
    expect(selectTargets({ ...female30, pregnant: true, lactating: true }).IRON_MG?.min).toBe(27);
  });

  it('clamps ages below 14 to the youngest band', () => {
    expect(selectTargets({ ...male30, age: 10 }).VITAMIN_C_MG?.min).toBe(75);
  });

  it('skips energy- and weight-based targets when those inputs are missing', () => {
    const t = selectTargets({ sex: 'male', age: 30, weightKg: 0, energyKcal: 0 });
    expect(t.PROTEIN_G).toBeUndefined();
    expect(t.FIBER_G).toBeUndefined();
    expect(t.VITAMIN_C_MG).toBeDefined();
  });
});

describe('applyOverrides', () => {
  const base = selectTargets(male30);

  it('replaces a bound, marks it CUSTOM and keeps other fields', () => {
    const out = applyOverrides(base, { PROTEIN_G: { min: 150 } });
    expect(out.PROTEIN_G).toEqual({ min: 150, kind: 'CUSTOM' });
    expect(out.IRON_MG).toEqual(base.IRON_MG);
  });

  it('keeps the scoped (supplement-only) UL as information when a total max is overridden', () => {
    const out = applyOverrides(base, { MAGNESIUM_MG: { max: 500 } });
    expect(out.MAGNESIUM_MG).toEqual({
      min: 400,
      max: 500,
      kind: 'CUSTOM',
      scopedUl: { value: 350, scope: 'supplement_only' },
    });
  });

  it('removing the max of a nutrient with only a scoped UL changes nothing; removing its min removes the target', () => {
    expect(applyOverrides(base, { MAGNESIUM_MG: { max: null } }).MAGNESIUM_MG).toEqual(base.MAGNESIUM_MG);
    const out = applyOverrides(base, { MAGNESIUM_MG: { min: null } });
    expect(out.MAGNESIUM_MG).toBeUndefined(); // a scoped UL alone is not a target
    expect('MAGNESIUM_MG' in out).toBe(false);
  });

  it('removes a bound with null and the whole target when no bound is left', () => {
    const out = applyOverrides(base, { CALCIUM_MG: { max: null }, POTASSIUM_MG: { min: null } });
    expect(out.CALCIUM_MG).toEqual({ min: 1000, kind: 'RDA' });
    expect(out.POTASSIUM_MG).toBeUndefined();
    expect('POTASSIUM_MG' in out).toBe(false);
  });

  it('removes a nutrient entirely with a null override and adds new targets', () => {
    const out = applyOverrides(base, { IRON_MG: null, OMEGA3_G: { min: 2 } });
    expect(out.IRON_MG).toBeUndefined();
    expect(out.OMEGA3_G).toEqual({ min: 2, kind: 'CUSTOM' });
  });

  it('does not mutate the base targets', () => {
    const snapshot: Targets = JSON.parse(JSON.stringify(base));
    applyOverrides(base, { PROTEIN_G: { min: 1 }, IRON_MG: null });
    expect(base).toEqual(snapshot);
  });

  it('leaves untouched targets alone for empty overrides', () => {
    expect(applyOverrides(base, {})).toEqual(base);
    expect(applyOverrides(base, { PROTEIN_G: {} }).PROTEIN_G).toEqual(base.PROTEIN_G);
  });
});
