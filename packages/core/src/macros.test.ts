import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { MacroTargetError, computeMacroTargets, kcalFromMacros, type MacroMode } from './macros';

describe('ratios mode', () => {
  it('30/40/30 at 2000 kcal => 150 g P, 200 g C, 66.67 g F', () => {
    const r = computeMacroTargets(
      { mode: 'ratios', proteinPct: 30, carbsPct: 40, fatPct: 30 },
      2000,
      { weightKg: 80 },
    );
    expect(r.protein.grams).toBeCloseTo(150, 10); // 2000 * .30 / 4
    expect(r.carbs.grams).toBeCloseTo(200, 10); // 2000 * .40 / 4
    expect(r.fat.grams).toBeCloseTo(66.6667, 4); // 2000 * .30 / 9
    expect(r.protein.kcal).toBeCloseTo(600, 10);
    expect(r.carbs.kcal).toBeCloseTo(800, 10);
    expect(r.fat.kcal).toBeCloseTo(600, 10);
    expect(r.macroKcal).toBeCloseTo(2000, 10);
    expect(r.protein.pct).toBeCloseTo(30, 10);
    expect(r.carbs.pct).toBeCloseTo(40, 10);
    expect(r.fat.pct).toBeCloseTo(30, 10);
    expect(r.warnings).toEqual([]);
  });

  it('rejects percentages that do not sum to 100', () => {
    expect(() =>
      computeMacroTargets({ mode: 'ratios', proteinPct: 30, carbsPct: 40, fatPct: 40 }, 2000, { weightKg: 80 }),
    ).toThrow(ZodError);
    expect(() =>
      computeMacroTargets({ mode: 'ratios', proteinPct: -10, carbsPct: 60, fatPct: 50 }, 2000, { weightKg: 80 }),
    ).toThrow(ZodError);
  });

  it('accepts tiny rounding error in the sum', () => {
    const r = computeMacroTargets(
      { mode: 'ratios', proteinPct: 33.33, carbsPct: 33.33, fatPct: 33.34 },
      1800,
      { weightKg: 70 },
    );
    expect(r.macroKcal).toBeCloseTo(1800, 6);
  });
});

describe('fixed mode', () => {
  it('uses the given grams and reports percentages of macro energy', () => {
    const r = computeMacroTargets({ mode: 'fixed', proteinG: 150, carbsG: 200, fatG: 70 }, 2000, { weightKg: 80 });
    expect(r.protein.kcal).toBe(600);
    expect(r.carbs.kcal).toBe(800);
    expect(r.fat.kcal).toBe(630);
    expect(r.macroKcal).toBe(2030);
    expect(r.energyKcal).toBe(2000);
    expect(r.protein.pct + r.carbs.pct + r.fat.pct).toBeCloseTo(100, 10);
    expect(r.protein.pct).toBeCloseTo((600 / 2030) * 100, 10);
  });
});

describe('keto mode', () => {
  const mode: MacroMode = { mode: 'keto', netCarbsG: 25, proteinGPerKgLean: 1.6 };

  it('fixes carbs and protein per kg lean mass, and gives the rest to fat', () => {
    // lean = 80 * (1 - 0.25) = 60 kg -> protein 96 g (384 kcal); carbs 25 g (100 kcal)
    // fat = (2000 - 384 - 100) / 9 = 168.44 g
    const r = computeMacroTargets(mode, 2000, { weightKg: 80, bodyFatPct: 25 });
    expect(r.protein.grams).toBeCloseTo(96, 10);
    expect(r.carbs.grams).toBe(25);
    expect(r.fat.grams).toBeCloseTo(168.4444, 3);
    expect(r.macroKcal).toBeCloseTo(2000, 8);
    expect(r.fat.pct).toBeCloseTo(75.8, 8);
    expect(r.carbs.pct).toBeCloseTo(5, 8);
    expect(r.warnings).toEqual([]);
  });

  it('prefers an explicit lean mass over body fat', () => {
    const r = computeMacroTargets(mode, 2000, { weightKg: 80, bodyFatPct: 25, leanMassKg: 50 });
    expect(r.protein.grams).toBeCloseTo(80, 10);
  });

  it('warns and falls back to body weight when lean mass is unknown', () => {
    const r = computeMacroTargets(mode, 2000, { weightKg: 80 });
    expect(r.protein.grams).toBeCloseTo(128, 10);
    expect(r.warnings).toHaveLength(1);
  });

  it('throws when protein and carbs exceed the energy target', () => {
    // protein 2.0 * 60 = 120 g (480) + carbs 50 g (200) = 680 > 500
    expect(() =>
      computeMacroTargets(
        { mode: 'keto', netCarbsG: 50, proteinGPerKgLean: 2 },
        500,
        { weightKg: 80, bodyFatPct: 25 },
      ),
    ).toThrow(MacroTargetError);
  });

  it('allows exactly zero fat', () => {
    // 100 kcal carbs + 100 kcal protein = 200
    const r = computeMacroTargets(
      { mode: 'keto', netCarbsG: 25, proteinGPerKgLean: 1 },
      200,
      { weightKg: 25, leanMassKg: 25 },
    );
    expect(r.fat.grams).toBe(0);
  });
});

describe('protein_per_kg mode', () => {
  it('uses 30% fat by default and gives the rest to carbs', () => {
    // protein 1.6 * 80 = 128 g (512 kcal) ; fat 600 kcal = 66.67 g ; carbs (2000-512-600)/4 = 222 g
    const r = computeMacroTargets({ mode: 'protein_per_kg', proteinGPerKg: 1.6 }, 2000, { weightKg: 80 });
    expect(r.protein.grams).toBeCloseTo(128, 10);
    expect(r.fat.grams).toBeCloseTo(66.6667, 4);
    expect(r.carbs.grams).toBeCloseTo(222, 10);
    expect(r.macroKcal).toBeCloseTo(2000, 8);
  });

  it('accepts a custom fat percentage', () => {
    // fat 25% = 500 kcal = 55.56 g ; carbs (2000 - 512 - 500)/4 = 247 g
    const r = computeMacroTargets({ mode: 'protein_per_kg', proteinGPerKg: 1.6, fatPct: 25 }, 2000, { weightKg: 80 });
    expect(r.fat.grams).toBeCloseTo(55.5556, 4);
    expect(r.carbs.grams).toBeCloseTo(247, 10);
  });

  it('throws when protein and fat leave negative energy for carbs', () => {
    expect(() =>
      computeMacroTargets({ mode: 'protein_per_kg', proteinGPerKg: 3, fatPct: 60 }, 1000, { weightKg: 80 }),
    ).toThrow(MacroTargetError);
  });
});

describe('validation and helpers', () => {
  it('rejects non-positive energy and unknown modes', () => {
    expect(() => computeMacroTargets({ mode: 'fixed', proteinG: 1, carbsG: 1, fatG: 1 }, 0, { weightKg: 70 })).toThrow(
      ZodError,
    );
    expect(() =>
      computeMacroTargets({ mode: 'nope' } as unknown as MacroMode, 2000, { weightKg: 70 }),
    ).toThrow(ZodError);
  });

  it('kcalFromMacros uses 4/4/9/7', () => {
    expect(kcalFromMacros({ proteinG: 150, carbsG: 200, fatG: 70 })).toBe(2030);
    expect(kcalFromMacros({ proteinG: 150, carbsG: 200, fatG: 70, alcoholG: 10 })).toBe(2100);
  });
});
