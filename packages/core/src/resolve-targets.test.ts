import { describe, expect, it } from 'vitest';
import { applyOverrides } from './dri';
import { computeBmr, computeEnergyTarget, baselineActivityKcal } from './energy';
import {
  DEFAULT_MACRO_MODE,
  MACRO_DRIVEN_NUTRIENTS,
  MACRO_PRESET_MODES,
  macroModeFromColumns,
  macroModeToColumns,
  parseBirthdateInput,
  resolveTargets,
  tryComputeMacroTargets,
  type ResolveTargetsInput,
} from './resolve-targets';

const ON_DATE = '2026-11-10';

const male: ResolveTargetsInput = {
  sex: 'male',
  birthdate: '1990-06-15', // 36 on ON_DATE
  heightCm: 180,
  weightKg: 80,
  onDate: ON_DATE,
};

const female: ResolveTargetsInput = {
  sex: 'female',
  birthdate: '1990-06-15',
  heightCm: 160,
  weightKg: 60,
  onDate: ON_DATE,
};

describe('resolveTargets - energy', () => {
  it('uses Mifflin, sedentary and no goal by default', () => {
    const r = resolveTargets(male);
    expect(r.age).toBe(36);
    // 10*80 + 6.25*180 - 5*36 + 5
    expect(r.bmr).toBe(1750);
    expect(r.bmrFormula).toBe('mifflin');
    expect(r.activityLevel).toBe('sedentary');
    expect(r.baselineActivityKcal).toBeCloseTo(350, 6);
    expect(r.rateKgPerWeek).toBe(0);
    expect(r.energy.maintenance).toBeCloseTo(2100, 6);
    expect(r.energy.target).toBeCloseTo(2100, 6);
    expect(r.energy.delta).toBe(0);
    expect(r.exceedsSafeLossRate).toBe(false);
  });

  it('applies the goal rate (-0.5 kg/week = -550 kcal/day)', () => {
    const r = resolveTargets({ ...male, rateKgPerWeek: -0.5, activityLevel: 'sedentary' });
    expect(r.energy.delta).toBeCloseTo(-550, 6);
    expect(r.energy.target).toBeCloseTo(1550, 6);
    expect(r.energy.flooredBy).toBe(0);
    // 1550 is still below the 1750 kcal BMR, so the UI must warn
    expect(r.energy.belowBmr).toBe(true);
    expect(resolveTargets({ ...male, rateKgPerWeek: -0.25 }).energy.belowBmr).toBe(false);
  });

  it('applies the energy floor and flags below-BMR and unsafe loss rates', () => {
    const r = resolveTargets({ ...female, rateKgPerWeek: -1 });
    // BMR 1259 + 20% = 1510.8, minus 1100 = 410.8, floored to 1200
    expect(r.bmr).toBeCloseTo(1259, 6);
    expect(r.energy.target).toBe(1200);
    expect(r.energy.flooredBy).toBeCloseTo(789.2, 6);
    expect(r.energy.belowBmr).toBe(true);
    expect(r.maxSafeLossRateKgPerWeek).toBeCloseTo(0.6, 9);
    expect(r.exceedsSafeLossRate).toBe(true);
  });

  it('does not treat weight gain or a loss within 1 %/week as unsafe', () => {
    expect(resolveTargets({ ...male, rateKgPerWeek: 0.5 }).exceedsSafeLossRate).toBe(false);
    expect(resolveTargets({ ...male, rateKgPerWeek: -0.8 }).exceedsSafeLossRate).toBe(false);
    expect(resolveTargets({ ...male, rateKgPerWeek: -0.81 }).exceedsSafeLossRate).toBe(true);
  });

  it('matches the core primitives it composes', () => {
    const r = resolveTargets({ ...male, activityLevel: 'moderate', rateKgPerWeek: -0.25 });
    const bmr = computeBmr(
      { sex: 'male', age: 36, weightKg: 80, heightCm: 180, bodyFatPct: null, manualBmr: null },
      'mifflin',
    );
    const baseline = baselineActivityKcal(bmr, 'moderate');
    const energy = computeEnergyTarget({ bmr, baselineActivityKcal: baseline, rateKgPerWeek: -0.25, sex: 'male' });
    expect(r.bmr).toBe(bmr);
    expect(r.baselineActivityKcal).toBe(baseline);
    expect(r.energy).toEqual(energy);
  });

  it('computes the age on the given date, not today', () => {
    expect(resolveTargets({ ...male, onDate: '2026-06-14' }).age).toBe(35);
    expect(resolveTargets({ ...male, onDate: '2026-06-15' }).age).toBe(36);
  });

  it('reports the effective BMR formula after fallbacks', () => {
    expect(resolveTargets({ ...male, bmrFormula: 'katch_mcardle' }).bmrFormula).toBe('mifflin');
    expect(resolveTargets({ ...male, bmrFormula: 'cunningham', bodyFatPct: null }).bmrFormula).toBe('mifflin');
    expect(resolveTargets({ ...male, bmrFormula: 'manual' }).bmrFormula).toBe('mifflin');

    const katch = resolveTargets({ ...male, bmrFormula: 'katch_mcardle', bodyFatPct: 20 });
    expect(katch.bmrFormula).toBe('katch_mcardle');
    expect(katch.bmr).toBeCloseTo(370 + 21.6 * 64, 6);

    const cunningham = resolveTargets({ ...male, bmrFormula: 'cunningham', bodyFatPct: 20 });
    expect(cunningham.bmr).toBeCloseTo(500 + 22 * 64, 6);

    const manual = resolveTargets({ ...male, bmrFormula: 'manual', bmrOverride: 1822 });
    expect(manual.bmrFormula).toBe('manual');
    expect(manual.bmr).toBe(1822);

    const harris = resolveTargets({ ...male, bmrFormula: 'harris_benedict' });
    expect(harris.bmrFormula).toBe('harris_benedict');
    expect(harris.bmr).toBeCloseTo(88.362 + 13.397 * 80 + 4.799 * 180 - 5.677 * 36, 6);
  });

  it('ignores an out-of-range body fat value instead of throwing', () => {
    expect(resolveTargets({ ...male, bodyFatPct: 150 }).bodyFatPct).toBeNull();
    expect(resolveTargets({ ...male, bodyFatPct: -3 }).bodyFatPct).toBeNull();
    expect(resolveTargets({ ...male, bodyFatPct: 22.5 }).bodyFatPct).toBe(22.5);
  });

  it('throws on non-positive weight/height or malformed dates', () => {
    expect(() => resolveTargets({ ...male, weightKg: 0 })).toThrow(RangeError);
    expect(() => resolveTargets({ ...male, heightCm: -1 })).toThrow(RangeError);
    expect(() => resolveTargets({ ...male, birthdate: 'nope' })).toThrow(RangeError);
  });
});

describe('resolveTargets - macros', () => {
  it('defaults to 30/40/30 ratios', () => {
    const r = resolveTargets({ ...male, rateKgPerWeek: -0.5 });
    expect(r.macroMode).toEqual(DEFAULT_MACRO_MODE);
    expect(r.macroError).toBeNull();
    expect(r.macros.energyKcal).toBeCloseTo(1550, 6);
    expect(r.macros.protein.grams).toBeCloseTo((1550 * 0.3) / 4, 6);
    expect(r.macros.carbs.grams).toBeCloseTo((1550 * 0.4) / 4, 6);
    expect(r.macros.fat.grams).toBeCloseTo((1550 * 0.3) / 9, 6);
  });

  it('uses fixed grams as typed', () => {
    const r = resolveTargets({ ...male, macroMode: { mode: 'fixed', proteinG: 150, carbsG: 200, fatG: 70 } });
    expect(r.macroError).toBeNull();
    expect(r.macros.protein.grams).toBe(150);
    expect(r.macros.fat.grams).toBe(70);
    expect(r.macros.macroKcal).toBe(150 * 4 + 200 * 4 + 70 * 9);
  });

  it('keto mode derives protein from lean mass and fat from the remainder', () => {
    const r = resolveTargets({
      ...male,
      bodyFatPct: 20,
      macroMode: MACRO_PRESET_MODES.keto,
    });
    expect(r.macroMode.mode).toBe('keto');
    expect(r.macros.protein.grams).toBeCloseTo(1.5 * 64, 6);
    expect(r.macros.carbs.grams).toBe(20);
    expect(r.macros.macroKcal).toBeCloseTo(r.energy.target, 6);
  });

  it('falls back to the default ratios and reports why when the mode is invalid', () => {
    const r = resolveTargets({
      ...male,
      macroMode: { mode: 'ratios', proteinPct: 50, carbsPct: 50, fatPct: 50 },
    });
    expect(r.macroMode).toEqual(DEFAULT_MACRO_MODE);
    expect(r.macroError).toMatch(/sum to 100/);
    expect(r.macros.protein.pct).toBeCloseTo(30, 6);
  });

  it('falls back when a keto request exceeds the energy target', () => {
    const r = resolveTargets({
      ...female,
      macroMode: { mode: 'keto', netCarbsG: 250, proteinGPerKgLean: 3 },
    });
    expect(r.macroMode).toEqual(DEFAULT_MACRO_MODE);
    expect(r.macroError).toMatch(/exceed the energy target/);
  });

  it('tryComputeMacroTargets returns errors instead of throwing', () => {
    const bad = tryComputeMacroTargets({ mode: 'ratios', proteinPct: 10, carbsPct: 10, fatPct: 10 }, 2000, {
      weightKg: 80,
    });
    expect(bad.macros).toBeNull();
    expect(bad.error).toMatch(/sum to 100/);
    const ok = tryComputeMacroTargets(DEFAULT_MACRO_MODE, 2000, { weightKg: 80 });
    expect(ok.error).toBeNull();
    expect(ok.macros?.protein.grams).toBeCloseTo(150, 6);
  });

  it('every preset is a valid mode at a typical target', () => {
    for (const mode of Object.values(MACRO_PRESET_MODES)) {
      const attempt = tryComputeMacroTargets(mode, 2000, { weightKg: 80, bodyFatPct: 20 });
      expect(attempt.error).toBeNull();
    }
  });
});

describe('resolveTargets - nutrient targets', () => {
  it('drives protein / net carbs / fat from the macro targets', () => {
    const r = resolveTargets({ ...male, rateKgPerWeek: -0.5 });
    expect(r.nutrients.PROTEIN_G).toEqual({ min: r.macros.protein.grams, kind: 'CUSTOM' });
    expect(r.nutrients.FAT_G).toEqual({ min: r.macros.fat.grams, kind: 'CUSTOM' });
    expect(r.nutrients.NET_CARBS_G).toEqual({ min: r.macros.carbs.grams, kind: 'CUSTOM' });
    expect(r.nutrients.CARBS_G).toBeUndefined();
    expect(r.nutrients.ENERGY_KCAL).toBeUndefined();
    for (const code of MACRO_DRIVEN_NUTRIENTS) {
      if (code === 'CARBS_G') continue;
      expect(r.nutrients[code]).toBeDefined();
    }
  });

  it('targets total carbs when net carbs is off (except in keto mode)', () => {
    const total = resolveTargets({ ...male, netCarbs: false });
    expect(total.nutrients.CARBS_G?.min).toBeCloseTo(total.macros.carbs.grams, 6);
    expect(total.nutrients.NET_CARBS_G).toBeUndefined();

    const keto = resolveTargets({ ...male, netCarbs: false, bodyFatPct: 20, macroMode: MACRO_PRESET_MODES.keto });
    expect(keto.nutrients.NET_CARBS_G?.min).toBe(20);
    expect(keto.nutrients.CARBS_G).toBeUndefined();
  });

  it('derives energy-proportional DRI targets from the energy target', () => {
    const r = resolveTargets({ ...male, rateKgPerWeek: -0.5 });
    expect(r.nutrients.FIBER_G?.min).toBeCloseTo((14 * 1550) / 1000, 6);
    expect(r.nutrients.SATURATED_FAT_G?.max).toBeCloseTo((0.1 * 1550) / 9, 6);
    expect(r.nutrients.SODIUM_MG).toEqual({ max: 2300, kind: 'CDRR' });
  });

  it('selects pregnancy values for pregnant women only', () => {
    const base = { ...female, birthdate: '1998-01-01' };
    expect(resolveTargets(base).nutrients.FOLATE_UG?.min).toBe(400);
    expect(resolveTargets({ ...base, pregnant: true }).nutrients.FOLATE_UG?.min).toBe(600);
    expect(resolveTargets({ ...male, pregnant: true }).nutrients.FOLATE_UG?.min).toBe(400);
  });

  it('exposes limits that cover only supplements / synthetic / preformed forms as scopedUl, never as max', () => {
    const r = resolveTargets(male);
    expect(r.nutrients.MAGNESIUM_MG?.max).toBeUndefined();
    expect(r.nutrients.MAGNESIUM_MG?.scopedUl).toEqual({ value: 350, scope: 'supplement_only' });
    expect(r.nutrients.MAGNESIUM_MG?.min).toBe(420);
    expect(r.nutrients.VITAMIN_C_MG?.max).toBe(2000);
    // a custom minimum above the scoped UL is valid and keeps the information
    const custom = resolveTargets({ ...male, overrides: { MAGNESIUM_MG: { min: 500 } } });
    expect(custom.nutrients.MAGNESIUM_MG).toEqual({
      min: 500,
      kind: 'CUSTOM',
      scopedUl: { value: 350, scope: 'supplement_only' },
    });
  });

  it('applies user overrides last', () => {
    const r = resolveTargets({
      ...male,
      overrides: {
        SODIUM_MG: { max: 2000 },
        CALCIUM_MG: null,
        PROTEIN_G: { min: 180 },
      },
    });
    expect(r.nutrients.SODIUM_MG).toEqual({ max: 2000, kind: 'CUSTOM' });
    expect(r.nutrients.CALCIUM_MG).toBeUndefined();
    expect(r.nutrients.PROTEIN_G?.min).toBe(180);
    const plain = resolveTargets(male);
    expect(applyOverrides(plain.nutrients, {}).IRON_MG).toEqual(r.nutrients.IRON_MG);
  });
});

describe('macro mode <-> table columns', () => {
  it('round-trips every mode', () => {
    const modes = [
      MACRO_PRESET_MODES.balanced,
      { mode: 'fixed', proteinG: 120, carbsG: 180, fatG: 60 },
      MACRO_PRESET_MODES.keto,
      { mode: 'protein_per_kg', proteinGPerKg: 2, fatPct: 25 },
      { mode: 'protein_per_kg', proteinGPerKg: 1.8 },
    ] as const;
    for (const mode of modes) {
      expect(macroModeFromColumns(macroModeToColumns(mode))).toEqual(mode);
    }
  });

  it('leaves unused columns null', () => {
    expect(macroModeToColumns(MACRO_PRESET_MODES.keto)).toEqual({
      mode: 'keto',
      protein_pct: null,
      carbs_pct: null,
      fat_pct: null,
      protein_g: null,
      carbs_g: null,
      fat_g: null,
      protein_g_per_kg: 1.5,
      net_carbs_g: 20,
    });
  });

  it('accepts numeric strings and rejects incomplete or invalid rows', () => {
    expect(macroModeFromColumns({ mode: 'ratios', protein_pct: '30', carbs_pct: '40', fat_pct: '30' })).toEqual(
      DEFAULT_MACRO_MODE,
    );
    expect(macroModeFromColumns({ mode: 'ratios', protein_pct: 30, carbs_pct: 40, fat_pct: null })).toBeNull();
    expect(macroModeFromColumns({ mode: 'ratios', protein_pct: 30, carbs_pct: 40, fat_pct: 40 })).toBeNull();
    expect(macroModeFromColumns({ mode: 'keto', net_carbs_g: 20 })).toBeNull();
    expect(macroModeFromColumns({ mode: 'weird' })).toBeNull();
    expect(macroModeFromColumns({})).toBeNull();
  });
});

describe('parseBirthdateInput', () => {
  const ok = (text: string) => {
    const r = parseBirthdateInput(text, ON_DATE);
    if (!r.ok) throw new Error(r.error);
    return r;
  };
  const err = (text: string) => {
    const r = parseBirthdateInput(text, ON_DATE);
    if (r.ok) throw new Error('expected an error');
    return r.error;
  };

  it('parses ISO dates', () => {
    expect(ok('1990-06-15')).toEqual({ ok: true, iso: '1990-06-15', age: 36 });
    expect(ok(' 1990-6-5 ')).toEqual({ ok: true, iso: '1990-06-05', age: 36 });
  });

  it('parses DD.MM.YYYY, with optional trailing dot and spaces', () => {
    expect(ok('15.06.1990')).toEqual({ ok: true, iso: '1990-06-15', age: 36 });
    expect(ok('5.6.1990.')).toEqual({ ok: true, iso: '1990-06-05', age: 36 });
    expect(ok('15. 6. 1990.').iso).toBe('1990-06-15');
  });

  it('computes the age relative to the given date', () => {
    expect(ok('1990-11-10').age).toBe(36);
    expect(ok('1990-11-11').age).toBe(35);
  });

  it('accepts 29 February only in leap years', () => {
    expect(ok('1992-02-29').iso).toBe('1992-02-29');
    expect(err('1993-02-29')).toMatch(/does not exist/);
    expect(err('31.04.1990')).toMatch(/does not exist/);
    expect(err('1990-13-01')).toMatch(/does not exist/);
  });

  it('rejects bad formats, empty input, future dates and implausible ages', () => {
    expect(err('')).toMatch(/Enter your birthdate/);
    expect(err('06/15/1990')).toMatch(/YYYY-MM-DD or DD.MM.YYYY/);
    expect(err('15 June 1990')).toMatch(/YYYY-MM-DD or DD.MM.YYYY/);
    expect(err('2027-01-01')).toMatch(/future/);
    expect(err('2020-01-01')).toMatch(/aged 14/);
    expect(err('1890-01-01')).toMatch(/year/);
  });
});
