import { z } from 'zod';
import { KCAL_PER_G } from './diary';

/**
 * Macro nutrient targets.
 *
 * Energy factors: protein 4, carbohydrate 4, fat 9, alcohol 7 kcal per gram.
 */

/** Thrown when a macro mode cannot be satisfied with the given energy target. */
export class MacroTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MacroTargetError';
  }
}

const pct = z.number().min(0).max(100);
const nonNeg = z.number().min(0);

/**
 * Macro mode configuration (validated with zod).
 *
 * - `ratios`: percent of energy per macro; the three must sum to 100 (+-0.01).
 *   `grams = kcal * pct / 100 / factor`.
 * - `fixed`: grams per macro, as typed by the user.
 * - `keto`: fixed net carbs (g), protein in g per kg of LEAN mass, fat takes
 *   the remaining energy (`/ 9`). Errors if nothing is left for fat.
 * - `protein_per_kg`: protein in g per kg of body weight, fat as a percent of
 *   total energy (default 30), carbs take the remaining energy (`/ 4`).
 */
export const MacroModeSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('ratios'),
      proteinPct: pct,
      carbsPct: pct,
      fatPct: pct,
    })
    .refine((v) => Math.abs(v.proteinPct + v.carbsPct + v.fatPct - 100) <= 0.01, {
      message: 'Macro percentages must sum to 100',
    }),
  z.object({
    mode: z.literal('fixed'),
    proteinG: nonNeg,
    carbsG: nonNeg,
    fatG: nonNeg,
  }),
  z.object({
    mode: z.literal('keto'),
    netCarbsG: nonNeg,
    proteinGPerKgLean: nonNeg,
  }),
  z.object({
    mode: z.literal('protein_per_kg'),
    proteinGPerKg: nonNeg,
    fatPct: pct.optional(),
  }),
]);

export type MacroMode = z.infer<typeof MacroModeSchema>;

/** Body data needed by the per-kg modes. */
export interface MacroProfile {
  weightKg: number;
  /** Used to derive lean mass when `leanMassKg` is not given. */
  bodyFatPct?: number | null;
  leanMassKg?: number | null;
}

/** One macro in the result. */
export interface MacroAmount {
  grams: number;
  kcal: number;
  /** Share of the sum of macro kcal (the three shares add up to 100). */
  pct: number;
}

/** Result of {@link computeMacroTargets}. */
export interface MacroTargets {
  /** The energy target the macros were derived from. */
  energyKcal: number;
  protein: MacroAmount;
  carbs: MacroAmount;
  fat: MacroAmount;
  /** Sum of the macro kcal (equals `energyKcal` except for `fixed` mode). */
  macroKcal: number;
  /** Non-fatal notes (e.g. lean mass unknown). */
  warnings: string[];
}

/** Energy in kcal of a macro split: `4P + 4C + 9F + 7*alcohol`. */
export function kcalFromMacros(m: {
  proteinG: number;
  carbsG: number;
  fatG: number;
  alcoholG?: number;
}): number {
  return (
    m.proteinG * KCAL_PER_G.protein +
    m.carbsG * KCAL_PER_G.carbs +
    m.fatG * KCAL_PER_G.fat +
    (m.alcoholG ?? 0) * KCAL_PER_G.alcohol
  );
}

function leanMassOf(profile: MacroProfile, warnings: string[]): number {
  if (typeof profile.leanMassKg === 'number' && profile.leanMassKg > 0) return profile.leanMassKg;
  if (typeof profile.bodyFatPct === 'number' && profile.bodyFatPct >= 0 && profile.bodyFatPct < 100) {
    return profile.weightKg * (1 - profile.bodyFatPct / 100);
  }
  warnings.push('Lean mass unknown; total body weight was used for the protein target.');
  return profile.weightKg;
}

function build(
  energyKcal: number,
  proteinG: number,
  carbsG: number,
  fatG: number,
  warnings: string[],
): MacroTargets {
  const pKcal = proteinG * KCAL_PER_G.protein;
  const cKcal = carbsG * KCAL_PER_G.carbs;
  const fKcal = fatG * KCAL_PER_G.fat;
  const macroKcal = pKcal + cKcal + fKcal;
  const share = (k: number) => (macroKcal > 0 ? (k / macroKcal) * 100 : 0);
  return {
    energyKcal,
    protein: { grams: proteinG, kcal: pKcal, pct: share(pKcal) },
    carbs: { grams: carbsG, kcal: cKcal, pct: share(cKcal) },
    fat: { grams: fatG, kcal: fKcal, pct: share(fKcal) },
    macroKcal,
    warnings,
  };
}

/**
 * Computes gram / kcal / percent macro targets for an energy target.
 *
 * @param mode      macro mode (validated; a ZodError is thrown on bad input)
 * @param energyKcal daily energy target, must be > 0
 * @param profile   body data for per-kg modes
 * @throws MacroTargetError when the mode leaves negative energy for a macro
 */
export function computeMacroTargets(
  mode: MacroMode,
  energyKcal: number,
  profile: MacroProfile,
): MacroTargets {
  const m = MacroModeSchema.parse(mode);
  const energy = z.number().positive().parse(energyKcal);
  const warnings: string[] = [];

  switch (m.mode) {
    case 'ratios': {
      const g = (p: number, factor: number) => (energy * p) / 100 / factor;
      return build(
        energy,
        g(m.proteinPct, KCAL_PER_G.protein),
        g(m.carbsPct, KCAL_PER_G.carbs),
        g(m.fatPct, KCAL_PER_G.fat),
        warnings,
      );
    }
    case 'fixed':
      return build(energy, m.proteinG, m.carbsG, m.fatG, warnings);
    case 'keto': {
      const proteinG = m.proteinGPerKgLean * leanMassOf(profile, warnings);
      const fatKcal = energy - proteinG * KCAL_PER_G.protein - m.netCarbsG * KCAL_PER_G.carbs;
      if (fatKcal < 0) {
        throw new MacroTargetError(
          `Protein (${proteinG.toFixed(0)} g) and net carbs (${m.netCarbsG} g) exceed the energy target of ${energy.toFixed(0)} kcal.`,
        );
      }
      return build(energy, proteinG, m.netCarbsG, fatKcal / KCAL_PER_G.fat, warnings);
    }
    case 'protein_per_kg': {
      const proteinG = m.proteinGPerKg * profile.weightKg;
      const fatKcal = (energy * (m.fatPct ?? 30)) / 100;
      const carbKcal = energy - proteinG * KCAL_PER_G.protein - fatKcal;
      if (carbKcal < 0) {
        throw new MacroTargetError(
          `Protein (${proteinG.toFixed(0)} g) and fat (${(m.fatPct ?? 30).toFixed(0)}% of energy) exceed the energy target of ${energy.toFixed(0)} kcal.`,
        );
      }
      return build(energy, proteinG, carbKcal / KCAL_PER_G.carbs, fatKcal / KCAL_PER_G.fat, warnings);
    }
  }
}
