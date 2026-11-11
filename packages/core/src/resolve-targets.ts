import { ZodError } from 'zod';
import { DRI_MIN_AGE, applyOverrides, selectTargets, type TargetOverride, type Targets } from './dri';
import {
  ageFromBirthdate,
  baselineActivityKcal,
  computeBmr,
  computeEnergyTarget,
  maxSafeLossRateKgPerWeek,
  resolveBmrFormula,
  type EnergyTarget,
} from './energy';
import {
  MacroModeSchema,
  MacroTargetError,
  computeMacroTargets,
  type MacroMode,
  type MacroProfile,
  type MacroTargets,
} from './macros';
import type { NutrientCode } from './nutrients';
import type { ActivityLevel, BmrFormula, Sex } from './types';

/*
 * Target resolution
 * =================
 * One pure function that turns plain profile / body / goal / macro / override inputs
 * into everything the app needs to show targets: age, BMR, baseline activity,
 * energy target (with floor), macro targets and per-nutrient targets.
 * The app's `useTargets` hook and the onboarding / settings live previews all feed it.
 */

/** Used when the user never picked an activity level. */
export const DEFAULT_ACTIVITY_LEVEL: ActivityLevel = 'sedentary';

/** Used when the user has no macro targets yet: 30 % protein, 40 % carbs, 30 % fat. */
export const DEFAULT_MACRO_MODE: MacroMode = { mode: 'ratios', proteinPct: 30, carbsPct: 40, fatPct: 30 };

/** Starting points for the macro style picker (all editable afterwards). */
export const MACRO_PRESET_MODES = {
  balanced: { mode: 'ratios', proteinPct: 30, carbsPct: 40, fatPct: 30 },
  high_protein: { mode: 'ratios', proteinPct: 40, carbsPct: 30, fatPct: 30 },
  low_carb: { mode: 'ratios', proteinPct: 30, carbsPct: 20, fatPct: 50 },
  keto: { mode: 'keto', netCarbsG: 20, proteinGPerKgLean: 1.5 },
} as const satisfies Record<string, MacroMode>;

export type MacroPresetId = keyof typeof MACRO_PRESET_MODES;

/**
 * Nutrients whose target is driven by the macro targets (see {@link resolveTargets}).
 * They are edited in the macro target editor, not as individual nutrient overrides.
 */
export const MACRO_DRIVEN_NUTRIENTS: readonly NutrientCode[] = [
  'PROTEIN_G',
  'CARBS_G',
  'NET_CARBS_G',
  'FAT_G',
];

// ------------------------------------------------------------ macro helpers

/** Result of {@link tryComputeMacroTargets}. */
export interface MacroAttempt {
  macros: MacroTargets | null;
  /** Human readable reason when `macros` is null. */
  error: string | null;
}

/**
 * Like `computeMacroTargets`, but returns the validation / infeasibility error
 * instead of throwing it. Useful for live previews while a user is typing.
 */
export function tryComputeMacroTargets(
  mode: MacroMode,
  energyKcal: number,
  profile: MacroProfile,
): MacroAttempt {
  try {
    return { macros: computeMacroTargets(mode, energyKcal, profile), error: null };
  } catch (e) {
    if (e instanceof MacroTargetError) return { macros: null, error: e.message };
    if (e instanceof ZodError) {
      return { macros: null, error: e.issues[0]?.message ?? 'Invalid macro targets.' };
    }
    throw e;
  }
}

/** Columns of `public.macro_targets` that describe a {@link MacroMode}. */
export interface MacroTargetColumns {
  mode: MacroMode['mode'];
  protein_pct: number | null;
  carbs_pct: number | null;
  fat_pct: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  protein_g_per_kg: number | null;
  net_carbs_g: number | null;
}

/** Maps a macro mode to table columns (unused columns are null). */
export function macroModeToColumns(mode: MacroMode): MacroTargetColumns {
  const empty: MacroTargetColumns = {
    mode: mode.mode,
    protein_pct: null,
    carbs_pct: null,
    fat_pct: null,
    protein_g: null,
    carbs_g: null,
    fat_g: null,
    protein_g_per_kg: null,
    net_carbs_g: null,
  };
  switch (mode.mode) {
    case 'ratios':
      return { ...empty, protein_pct: mode.proteinPct, carbs_pct: mode.carbsPct, fat_pct: mode.fatPct };
    case 'fixed':
      return { ...empty, protein_g: mode.proteinG, carbs_g: mode.carbsG, fat_g: mode.fatG };
    case 'keto':
      return { ...empty, net_carbs_g: mode.netCarbsG, protein_g_per_kg: mode.proteinGPerKgLean };
    case 'protein_per_kg':
      return { ...empty, protein_g_per_kg: mode.proteinGPerKg, fat_pct: mode.fatPct ?? null };
  }
}

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Inverse of {@link macroModeToColumns}. Returns null for an incomplete or invalid row. */
export function macroModeFromColumns(row: {
  mode?: unknown;
  protein_pct?: unknown;
  carbs_pct?: unknown;
  fat_pct?: unknown;
  protein_g?: unknown;
  carbs_g?: unknown;
  fat_g?: unknown;
  protein_g_per_kg?: unknown;
  net_carbs_g?: unknown;
}): MacroMode | null {
  let candidate: unknown;
  switch (row.mode) {
    case 'ratios':
      candidate = {
        mode: 'ratios',
        proteinPct: num(row.protein_pct),
        carbsPct: num(row.carbs_pct),
        fatPct: num(row.fat_pct),
      };
      break;
    case 'fixed':
      candidate = {
        mode: 'fixed',
        proteinG: num(row.protein_g),
        carbsG: num(row.carbs_g),
        fatG: num(row.fat_g),
      };
      break;
    case 'keto':
      candidate = {
        mode: 'keto',
        netCarbsG: num(row.net_carbs_g),
        proteinGPerKgLean: num(row.protein_g_per_kg),
      };
      break;
    case 'protein_per_kg':
      candidate = { mode: 'protein_per_kg', proteinGPerKg: num(row.protein_g_per_kg), fatPct: num(row.fat_pct) };
      break;
    default:
      return null;
  }
  const parsed = MacroModeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// ------------------------------------------------------- birthdate parsing

/** Result of {@link parseBirthdateInput}. */
export type BirthdateParse = { ok: true; iso: string; age: number } | { ok: false; error: string };

const MAX_AGE = 120;

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Parses a typed birthdate. Accepts `YYYY-MM-DD` and `DD.MM.YYYY` (an optional
 * trailing dot and spaces are tolerated, e.g. `15. 3. 1990.`) and returns the
 * ISO date plus the age on `onDateISO`. Rejects non-existent dates, future
 * dates, and ages below {@link DRI_MIN_AGE} or above 120.
 */
export function parseBirthdateInput(text: string, onDateISO: string): BirthdateParse {
  const s = text.trim().replace(/\s+/g, '');
  if (s === '') return { ok: false, error: 'Enter your birthdate.' };

  let y: number;
  let m: number;
  let d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  const eu = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\.?$/.exec(s);
  if (iso) {
    y = Number(iso[1]);
    m = Number(iso[2]);
    d = Number(iso[3]);
  } else if (eu) {
    d = Number(eu[1]);
    m = Number(eu[2]);
    y = Number(eu[3]);
  } else {
    return { ok: false, error: 'Use the format YYYY-MM-DD or DD.MM.YYYY.' };
  }

  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return { ok: false, error: 'That date does not exist.' };
  }
  const normalized = `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
  if (normalized > onDateISO) return { ok: false, error: 'Birthdate cannot be in the future.' };
  const age = ageFromBirthdate(normalized, onDateISO);
  if (age < DRI_MIN_AGE) {
    return { ok: false, error: `Ration is designed for people aged ${DRI_MIN_AGE} and over.` };
  }
  if (age > MAX_AGE) return { ok: false, error: 'Please check the year of your birthdate.' };
  return { ok: true, iso: normalized, age };
}

// ---------------------------------------------------------------- resolver

/** Plain inputs of {@link resolveTargets}. Metric units everywhere. */
export interface ResolveTargetsInput {
  sex: Sex;
  /** `YYYY-MM-DD`. */
  birthdate: string;
  heightCm: number;
  weightKg: number;
  /** Body fat percentage; values outside [0, 100) are ignored. */
  bodyFatPct?: number | null;
  /** Default {@link DEFAULT_ACTIVITY_LEVEL}. */
  activityLevel?: ActivityLevel | null;
  /** Default 'mifflin'. Falls back to Mifflin when body fat / manual value is missing. */
  bmrFormula?: BmrFormula | null;
  bmrOverride?: number | null;
  /** Signed kg/week (negative = lose). Default 0. */
  rateKgPerWeek?: number | null;
  /** Default {@link DEFAULT_MACRO_MODE}. */
  macroMode?: MacroMode | null;
  /** When true the carbohydrate target is a NET carbs target. Default true (profile default). */
  netCarbs?: boolean;
  pregnant?: boolean;
  lactating?: boolean;
  /** User overrides (from `nutrient_targets`), applied last. */
  overrides?: Partial<Record<NutrientCode, TargetOverride | null>>;
  /** Local date `YYYY-MM-DD` the targets are for (used for age). */
  onDate: string;
}

/** Output of {@link resolveTargets}. */
export interface ResolvedTargetsCore {
  age: number;
  weightKg: number;
  bodyFatPct: number | null;
  activityLevel: ActivityLevel;
  /** The BMR formula that was effectively used (after fallbacks). */
  bmrFormula: BmrFormula;
  bmr: number;
  baselineActivityKcal: number;
  rateKgPerWeek: number;
  energy: EnergyTarget;
  /** Positive kg/week: 1 % of body weight. */
  maxSafeLossRateKgPerWeek: number;
  /** True when the goal is a LOSS faster than {@link maxSafeLossRateKgPerWeek}. */
  exceedsSafeLossRate: boolean;
  /** The macro mode actually used; the default ratios when the requested one was rejected. */
  macroMode: MacroMode;
  macros: MacroTargets;
  /** Why the requested macro mode was rejected (null when it was used as given). */
  macroError: string | null;
  /**
   * Per-nutrient min/max: DRI (`selectTargets`), then the macro targets for
   * {@link MACRO_DRIVEN_NUTRIENTS} (as `min`, kind 'CUSTOM'), then `overrides`.
   * There is no ENERGY_KCAL entry - use `energy.target`.
   */
  nutrients: Targets;
}

function validBodyFat(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 100 ? v : null;
}

/**
 * Resolves all targets from plain inputs.
 *
 * - age = completed years on `onDate`
 * - `bmr = computeBmr(...)`, `baselineActivity = bmr * activity fraction`
 * - energy target = `computeEnergyTarget` (goal rate, sex-based floor)
 * - macros = the requested mode, or {@link DEFAULT_MACRO_MODE} (with `macroError`) if it is
 *   invalid or does not fit the energy target
 * - nutrients = `selectTargets` + macro-driven targets + `applyOverrides`
 *
 * @throws RangeError for non-positive weight / height or a malformed birthdate / onDate.
 */
export function resolveTargets(input: ResolveTargetsInput): ResolvedTargetsCore {
  const age = ageFromBirthdate(input.birthdate, input.onDate);
  const bodyFatPct = validBodyFat(input.bodyFatPct);
  const activityLevel = input.activityLevel ?? DEFAULT_ACTIVITY_LEVEL;
  const rate = typeof input.rateKgPerWeek === 'number' && Number.isFinite(input.rateKgPerWeek) ? input.rateKgPerWeek : 0;

  const bmrProfile = {
    sex: input.sex,
    age,
    weightKg: input.weightKg,
    heightCm: input.heightCm,
    bodyFatPct,
    manualBmr: input.bmrOverride ?? null,
  };
  const requestedFormula = input.bmrFormula ?? 'mifflin';
  const bmrFormula = resolveBmrFormula(bmrProfile, requestedFormula);
  const bmr = computeBmr(bmrProfile, requestedFormula);
  const baseline = baselineActivityKcal(bmr, activityLevel);

  const energy = computeEnergyTarget({
    bmr,
    baselineActivityKcal: baseline,
    rateKgPerWeek: rate,
    sex: input.sex,
  });

  const maxLoss = maxSafeLossRateKgPerWeek(input.weightKg);

  const macroProfile: MacroProfile = { weightKg: input.weightKg, bodyFatPct };
  const requestedMode = input.macroMode ?? DEFAULT_MACRO_MODE;
  let macroMode = requestedMode;
  let attempt = tryComputeMacroTargets(requestedMode, energy.target, macroProfile);
  const macroError = attempt.error;
  if (!attempt.macros) {
    macroMode = DEFAULT_MACRO_MODE;
    attempt = tryComputeMacroTargets(DEFAULT_MACRO_MODE, energy.target, macroProfile);
  }
  const macros = attempt.macros as MacroTargets;

  const base = selectTargets({
    sex: input.sex,
    age,
    pregnant: input.pregnant,
    lactating: input.lactating,
    weightKg: input.weightKg,
    energyKcal: energy.target,
  });
  const useNet = (input.netCarbs ?? true) || macroMode.mode === 'keto';
  const withMacros: Targets = {
    ...base,
    PROTEIN_G: { min: macros.protein.grams, kind: 'CUSTOM' },
    FAT_G: { min: macros.fat.grams, kind: 'CUSTOM' },
  };
  delete withMacros.CARBS_G;
  delete withMacros.NET_CARBS_G;
  withMacros[useNet ? 'NET_CARBS_G' : 'CARBS_G'] = { min: macros.carbs.grams, kind: 'CUSTOM' };

  const nutrients = applyOverrides(withMacros, input.overrides ?? {});

  return {
    age,
    weightKg: input.weightKg,
    bodyFatPct,
    activityLevel,
    bmrFormula,
    bmr,
    baselineActivityKcal: baseline,
    rateKgPerWeek: rate,
    energy,
    maxSafeLossRateKgPerWeek: maxLoss,
    exceedsSafeLossRate: rate < 0 && -rate > maxLoss,
    macroMode,
    macros,
    macroError,
    nutrients,
  };
}
