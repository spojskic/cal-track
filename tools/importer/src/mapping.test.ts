import {
  FDC_CONVERTED_IDS,
  NUTRIENTS,
  NUTRIENT_BY_CODE,
  NUTRIENT_BY_FDC_ID,
  type NutrientCode,
} from '@cal/core';
import { describe, expect, it } from 'vitest';
import { buildCnfRules } from './cnf';
import {
  SUPPLEMENTAL_FDC_RULES,
  buildFdcRules,
  normalizeUnit,
  resolveNutrients,
  roundSig,
  sanitizeAmount,
  unitFactor,
  validAmount,
} from './mapping';

const rules = buildFdcRules();
const noUnits = (): string | undefined => undefined;
const amounts = (entries: Array<[number, number]>): Map<number, number> => new Map(entries);

describe('units', () => {
  it('normalises unit names', () => {
    expect(normalizeUnit('KCAL')).toBe('kcal');
    expect(normalizeUnit('kJ')).toBe('kj');
    expect(normalizeUnit('UG')).toBe('ug');
    expect(normalizeUnit('µg')).toBe('ug'); // micro sign
    expect(normalizeUnit('μg')).toBe('ug'); // greek mu
    expect(normalizeUnit('Âµg')).toBe('ug'); // mojibake
    expect(normalizeUnit('mcg')).toBe('ug');
    expect(normalizeUnit(' mg ')).toBe('mg');
    expect(normalizeUnit('IU')).toBe('iu');
    expect(normalizeUnit('')).toBeUndefined();
    expect(normalizeUnit(undefined)).toBeUndefined();
  });

  it('converts between mass units and kJ -> kcal', () => {
    expect(unitFactor('g', 'mg')).toBe(1000);
    expect(unitFactor('g', 'ug')).toBe(1_000_000);
    expect(unitFactor('mg', 'ug')).toBe(1000);
    expect(unitFactor('ug', 'mg')).toBe(0.001);
    expect(unitFactor('mg', 'g')).toBe(0.001);
    expect(unitFactor('mg', 'mg')).toBe(1);
    expect(unitFactor('kj', 'kcal')).toBeCloseTo(1 / 4.184, 10);
    expect(unitFactor(undefined, 'mg')).toBe(1);
  });

  it('cannot convert unrelated units', () => {
    expect(unitFactor('iu', 'ug')).toBeNull();
    expect(unitFactor('kcal', 'g')).toBeNull();
    expect(unitFactor('mcg_re', 'ug')).toBeNull();
    expect(unitFactor('kj', 'mg')).toBeNull();
  });

  it('rounds to 4 significant digits', () => {
    expect(roundSig(52.34567)).toBe(52.35);
    expect(roundSig(0.00123456)).toBe(0.001235);
    expect(roundSig(1234.5678)).toBe(1235);
    expect(roundSig(0)).toBe(0);
    expect(roundSig(643)).toBe(643);
  });

  it('validAmount rejects negative / non-finite / null', () => {
    expect(validAmount(0)).toBe(0);
    expect(validAmount(1.5)).toBe(1.5);
    expect(validAmount(-0.1)).toBeNull();
    expect(validAmount(null)).toBeNull();
    expect(validAmount(Number.NaN)).toBeNull();
  });
});

describe('resolveNutrients', () => {
  it('maps ids to catalog codes in catalog units', () => {
    const r = resolveNutrients(
      amounts([
        [1008, 52],
        [1003, 0.26],
        [1093, 1],
      ]),
      rules,
      noUnits,
    );
    expect(r.nutrients).toEqual({ ENERGY_KCAL: 52, PROTEIN_G: 0.26, SODIUM_MG: 1 });
    expect(r.energySource).toBe('kcal');
  });

  it('ignores ids the catalog does not track', () => {
    const r = resolveNutrients(amounts([[1008, 52], [9999, 5]]), rules, noUnits);
    expect(Object.keys(r.nutrients)).toEqual(['ENERGY_KCAL']);
  });

  it('keeps a missing nutrient absent (unknown != 0) and an explicit zero as 0', () => {
    const r = resolveNutrients(amounts([[1008, 0], [1003, 0]]), rules, noUnits);
    expect(r.nutrients.ENERGY_KCAL).toBe(0);
    expect(r.nutrients.PROTEIN_G).toBe(0);
    expect('FAT_G' in r.nutrients).toBe(false);
  });

  describe('energy fallback chain', () => {
    it('1008 kcal first', () => {
      const r = resolveNutrients(amounts([[1008, 50], [2048, 60], [2047, 70], [1062, 800]]), rules, noUnits);
      expect(r.nutrients.ENERGY_KCAL).toBe(50);
      expect(r.energySource).toBe('kcal');
    });
    it('then 2048 Atwater specific', () => {
      const r = resolveNutrients(amounts([[2048, 60], [2047, 70], [1062, 800]]), rules, noUnits);
      expect(r.nutrients.ENERGY_KCAL).toBe(60);
      expect(r.energySource).toBe('atwater_specific');
    });
    it('then 2047 Atwater general', () => {
      const r = resolveNutrients(amounts([[2047, 70], [1062, 800]]), rules, noUnits);
      expect(r.nutrients.ENERGY_KCAL).toBe(70);
      expect(r.energySource).toBe('atwater_general');
    });
    it('then kJ / 4.184', () => {
      const r = resolveNutrients(amounts([[1062, 418.4]]), rules, (id) => (id === 1062 ? 'kJ' : undefined));
      expect(r.nutrients.ENERGY_KCAL).toBe(100);
      expect(r.energySource).toBe('kj');
    });
    it('ignores a kJ rule whose source unit is not kJ', () => {
      const r = resolveNutrients(amounts([[1062, 418.4]]), rules, () => 'KCAL');
      expect(r.nutrients.ENERGY_KCAL).toBeUndefined();
      expect(r.unitMismatches).toBe(1);
    });
    it('finally computes energy from the macros (needs two macros)', () => {
      const r = resolveNutrients(amounts([[1003, 10], [1004, 5], [1005, 20]]), rules, noUnits);
      expect(r.nutrients.ENERGY_KCAL).toBe(165); // 4*10 + 9*5 + 4*20
      expect(r.energySource).toBe('macros');
      const fiber = resolveNutrients(amounts([[1003, 10], [1004, 5], [1005, 20], [1079, 5]]), rules, noUnits);
      expect(fiber.nutrients.ENERGY_KCAL).toBe(145); // fibre is not available carbohydrate
      const one = resolveNutrients(amounts([[1003, 10]]), rules, noUnits);
      expect(one.nutrients.ENERGY_KCAL).toBeUndefined();
      expect(one.energySource).toBeNull();
    });
  });

  describe('vitamin D', () => {
    const iuUnit = (id: number): string | undefined => (id === 1110 ? 'IU' : id === 1114 ? 'UG' : undefined);
    it('converts IU at 40 IU = 1 ug when D (ug) is missing', () => {
      const r = resolveNutrients(amounts([[1110, 200]]), rules, iuUnit);
      expect(r.nutrients.VITAMIN_D_UG).toBe(5);
    });
    it('prefers D in ug over the IU value', () => {
      const r = resolveNutrients(amounts([[1110, 40], [1114, 2]]), rules, iuUnit);
      expect(r.nutrients.VITAMIN_D_UG).toBe(2);
    });
  });

  it('converts g -> mg and g -> ug when the source unit is larger than the catalog unit', () => {
    const unitOf = (id: number): string | undefined => (id === 1093 ? 'G' : id === 1103 ? 'MG' : undefined);
    const r = resolveNutrients(amounts([[1093, 0.643], [1103, 0.0123]]), rules, unitOf);
    expect(r.nutrients.SODIUM_MG).toBe(643); // 0.643 g
    expect(r.nutrients.SELENIUM_UG).toBe(12.3); // 0.0123 mg
  });

  it('skips amounts whose unit cannot be converted and reports them', () => {
    const r = resolveNutrients(amounts([[1106, 10]]), rules, () => 'MCG_RE'); // RAE given as RE
    expect(r.nutrients.VITAMIN_A_UG).toBeUndefined();
    expect(r.unitMismatches).toBe(1);
  });

  it('falls through to the next id when a higher-priority unit is unusable', () => {
    const unitOf = (id: number): string | undefined => (id === 2000 ? 'SP_GR' : 'G');
    const r = resolveNutrients(amounts([[2000, 3], [1063, 10.4]]), rules, unitOf);
    expect(r.nutrients.SUGARS_G).toBe(10.4);
    expect(r.unitMismatches).toBe(1);
  });

  it('prefers 2000 Total Sugars over 1063', () => {
    const r = resolveNutrients(amounts([[2000, 3], [1063, 4]]), rules, noUnits);
    expect(r.nutrients.SUGARS_G).toBe(3);
    expect(resolveNutrients(amounts([[1063, 4]]), rules, noUnits).nutrients.SUGARS_G).toBe(4);
  });

  it('uses supplemental fallbacks (fibre AOAC 2011.25, carbs by summation)', () => {
    const r = resolveNutrients(amounts([[2033, 3.1], [1050, 20]]), rules, noUnits);
    expect(r.nutrients.FIBER_G).toBe(3.1);
    expect(r.nutrients.CARBS_G).toBe(20);
    const both = resolveNutrients(amounts([[1079, 2], [2033, 3.1], [1005, 21], [1050, 20]]), rules, noUnits);
    expect(both.nutrients.FIBER_G).toBe(2);
    expect(both.nutrients.CARBS_G).toBe(21);
  });

  it('never stores computed nutrients (net carbs, omega-3/6)', () => {
    const r = resolveNutrients(
      amounts([[1005, 20], [1079, 2], [1404, 0.1], [1316, 0.5]]),
      rules,
      noUnits,
    );
    expect('NET_CARBS_G' in r.nutrients).toBe(false);
    expect('OMEGA3_G' in r.nutrients).toBe(false);
    expect('OMEGA6_G' in r.nutrients).toBe(false);
  });
});

describe('real-data rules', () => {
  it('sanitizeAmount stores small negative by-difference values as 0, all other negatives are rejected', () => {
    expect(sanitizeAmount(-0.428, true)).toEqual({ value: 0, clamped: true });
    expect(sanitizeAmount(-0.999, true)).toEqual({ value: 0, clamped: true });
    expect(sanitizeAmount(-1, true)).toEqual({ value: null, clamped: false });
    expect(sanitizeAmount(-5, true)).toEqual({ value: null, clamped: false });
    expect(sanitizeAmount(-0.4, false)).toEqual({ value: null, clamped: false });
    expect(sanitizeAmount(3.2, true)).toEqual({ value: 3.2, clamped: false });
    expect(sanitizeAmount(null, true)).toEqual({ value: null, clamped: false });
  });

  it('a lone macro >= 90 g (pure oil) is enough to estimate energy; a smaller lone macro is not', () => {
    expect(resolveNutrients(amounts([[1085, 94.5]]), rules, noUnits).nutrients).toEqual({ FAT_G: 94.5, ENERGY_KCAL: 850.5 });
    expect(resolveNutrients(amounts([[1004, 90]]), rules, noUnits).nutrients.ENERGY_KCAL).toBe(810);
    expect(resolveNutrients(amounts([[1004, 50]]), rules, noUnits).nutrients.ENERGY_KCAL).toBeUndefined();
    expect(resolveNutrients(amounts([[1003, 1.53]]), rules, noUnits).nutrients.ENERGY_KCAL).toBeUndefined();
  });

  it('Foundation fallbacks: NLEA fat, total folate, all-cis EPA/DPA/DHA/ARA', () => {
    const r = resolveNutrients(
      amounts([[1085, 20], [1177, 36], [2023, 0.1], [2024, 0.02], [2025, 0.2], [2022, 0.03]]),
      rules,
      noUnits,
    );
    expect(r.nutrients).toMatchObject({ FAT_G: 20, FOLATE_UG: 36, EPA_G: 0.1, DPA_G: 0.02, DHA_G: 0.2, ARACHIDONIC_G: 0.03 });
    const both = resolveNutrients(amounts([[1004, 18], [1085, 20], [1190, 40], [1177, 36], [1278, 0.5], [2023, 0.1]]), rules, noUnits);
    expect(both.nutrients).toMatchObject({ FAT_G: 18, FOLATE_UG: 40, EPA_G: 0.5 }); // canonical ids win
  });

  it('does not map the ids that differ from the catalog nutrient (2016/2018 PUFA c, 2068 Vitamin E, 1002 Nitrogen)', () => {
    for (const id of [2016, 2018, 2068, 1002, 1104, 1187, 1232]) expect(rules.ids.has(id), String(id)).toBe(false);
  });
});

describe('catalog consistency', () => {
  const catalogCodes = new Set<string>(NUTRIENTS.map((n) => n.code));

  it('every FDC rule points at a stored (non-computed) nutrient of the core catalog', () => {
    for (const rule of rules.rules) {
      const entry = NUTRIENT_BY_CODE[rule.code];
      expect(entry, `${rule.code} for FDC id ${rule.id}`).toBeDefined();
      expect(catalogCodes.has(rule.code)).toBe(true);
      expect(entry.computed, `${rule.code} is computed`).toBeFalsy();
    }
  });

  it('every id core knows (canonical, alternate, converted) has an importer rule', () => {
    const ruleIds = new Set(rules.rules.map((r) => r.id));
    for (const id of NUTRIENT_BY_FDC_ID.keys()) expect(ruleIds.has(id), `FDC id ${id}`).toBe(true);
    for (const id of FDC_CONVERTED_IDS.keys()) expect(ruleIds.has(id), `converted id ${id}`).toBe(true);
  });

  it('rule ids resolve to the same nutrient core assigns (no silent re-mapping)', () => {
    for (const rule of rules.rules) {
      const core = NUTRIENT_BY_FDC_ID.get(rule.id) ?? (FDC_CONVERTED_IDS.get(rule.id) ? { code: FDC_CONVERTED_IDS.get(rule.id)?.code } : undefined);
      if (core) expect(core.code).toBe(rule.code);
    }
  });

  it('supplemental rules target existing, non-computed nutrients that have no core FDC id yet', () => {
    for (const s of SUPPLEMENTAL_FDC_RULES) {
      expect(NUTRIENT_BY_CODE[s.code], s.code).toBeDefined();
      expect(NUTRIENT_BY_CODE[s.code].computed).toBeFalsy();
    }
  });

  it('every non-computed nutrient with an FDC id is reachable; computed ones are not mapped', () => {
    const mapped = new Set(rules.rules.map((r) => r.code));
    for (const n of NUTRIENTS) {
      if (n.computed) expect(mapped.has(n.code)).toBe(false);
      else if (n.fdcId !== null) expect(mapped.has(n.code)).toBe(true);
    }
  });

  it('every CNF rule points at a stored nutrient of the core catalog', () => {
    const cnf = buildCnfRules();
    for (const rule of cnf.rules) {
      const entry = NUTRIENT_BY_CODE[rule.code as NutrientCode];
      expect(entry, `${rule.code} for CNF code ${rule.id}`).toBeDefined();
      expect(entry.computed).toBeFalsy();
    }
  });
});
