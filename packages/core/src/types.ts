import type { NutrientCode } from './nutrients';

/**
 * Nutrient amounts keyed by nutrient code, each in the catalog unit
 * (see `NUTRIENT_BY_CODE[code].unit`).
 *
 * A MISSING key means the amount is UNKNOWN (no data), which is different from
 * an explicit `0` (the food was analysed and contains none). Never substitute 0
 * for a missing key when aggregating - use the helpers in `diary.ts`.
 */
export type NutrientMap = Partial<Record<NutrientCode, number>>;

/** Biological sex as used by the BMR and DRI formulas. */
export type Sex = 'male' | 'female';

/** Baseline daily activity (excluding logged exercise). */
/** 'none' adds nothing for everyday movement (the baseline is 0): for people who let a watch dictate their activity. */
export type ActivityLevel = 'none' | 'sedentary' | 'light' | 'moderate' | 'very';

/**
 * How `CARBS_G` of a food is defined.
 * - `includes_fiber`: total carbohydrate (US labels, USDA) - fiber is part of it.
 * - `excludes_fiber`: available carbohydrate (UK/EU style) - fiber is not part of it.
 */
export type CarbBasis = 'includes_fiber' | 'excludes_fiber';

/**
 * What is subtracted from carbohydrates to obtain net carbs.
 * - `fiber_and_sugar_alcohols`: subtract fiber (if the basis includes it) and sugar alcohols.
 * - `fiber_only`: subtract only fiber (if the basis includes it).
 */
export type NetCarbMode = 'fiber_and_sugar_alcohols' | 'fiber_only';

/** Display unit system. Storage is always metric. */
export type UnitSystem = 'metric' | 'imperial';

/** Reproductive life stage used for DRI selection. */
export type LifeStage = 'normal' | 'pregnant' | 'lactating';

/** Resting energy formula selector. */
export type BmrFormula = 'mifflin' | 'katch_mcardle' | 'harris_benedict' | 'cunningham' | 'manual';

/** How daily energy expenditure is assembled. */
export type EnergyMode = 'static' | 'device_adjusted' | 'device_total';

/**
 * What the third circle of the energy summary shows (Cronometer's "Energy Summary 3rd Circle Display"):
 * - `target`: target (plus energy burned above the baseline) minus consumed: Remaining / Over.
 * - `balance`: expenditure minus consumed, ignoring the weight goal: Deficit / Surplus.
 */
export type EnergySummaryMode = 'target' | 'balance';

/** Macro nutrient kinds. */
export type MacroKind = 'protein' | 'carbs' | 'fat';
