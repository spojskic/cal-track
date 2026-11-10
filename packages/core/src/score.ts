import type { Targets } from './dri';
import { NUTRIENT_CODES, type NutrientCode } from './nutrients';
import type { NutrientMap } from './types';

/** Default penalty strength for exceeding a limit. */
export const DEFAULT_SCORE_LAMBDA = 0.5;

/** Nutrients that count double in the score. */
export const KEY_NUTRIENT_WEIGHTS: Readonly<Partial<Record<NutrientCode, number>>> = {
  PROTEIN_G: 2,
  FIBER_G: 2,
  CALCIUM_MG: 2,
  IRON_MG: 2,
  POTASSIUM_MG: 2,
  MAGNESIUM_MG: 2,
  VITAMIN_D_UG: 2,
  B12_UG: 2,
  FOLATE_UG: 2,
};

/** Options of {@link nutritionScore}. */
export interface ScoreOptions {
  /** Per-nutrient weight overrides (default: 2 for key nutrients, otherwise 1). */
  weights?: Partial<Record<NutrientCode, number>>;
  /** Penalty strength (default 0.5). */
  lambda?: number;
  /**
   * Also penalise upper limits that apply only to supplements / synthetic / preformed
   * forms (`Target.scopedUl`). Off by default because the app cannot separate
   * those forms in total intake, so e.g. food magnesium would be wrongly
   * compared with the 350 mg supplement UL.
   */
  penalizeScopedLimits?: boolean;
}

/** Score details for one nutrient. */
export interface NutrientScore {
  weight: number;
  /** Intake amount, undefined when unknown. */
  intake?: number;
  min?: number;
  max?: number;
  /** `min(intake / min, 1)` when a min target and intake exist. */
  fulfillment?: number;
  /** `max(0, intake / max - 1)` when a (penalised) max target and intake exist. */
  excess?: number;
}

/** Result of {@link nutritionScore}. */
export interface NutritionScoreResult {
  /** Integer 0..100. */
  score: number;
  /** Share (0..1) of targeted nutrients that have intake data. */
  coverage: number;
  perNutrient: Partial<Record<NutrientCode, NutrientScore>>;
}

/**
 * Daily nutrition quality score.
 *
 * ```
 * base    = sum(w * min(intake / min, 1)) / sum(w)        over nutrients with a min target and known intake
 * penalty = lambda * sum(w * max(0, intake / max - 1))     over nutrients with a max target and known intake
 * score   = round(100 * clamp(base - penalty, 0, 1))
 * ```
 *
 * Weights `w` are 2 for key nutrients (protein, fiber, calcium, iron,
 * potassium, magnesium, vitamin D, B12, folate), otherwise 1, unless overridden
 * via `options.weights`. `lambda` defaults to 0.5. Unknown intake is skipped
 * (not counted as 0) and lowers `coverage` instead. The penalty is not
 * normalised, so a 100% overshoot of one weight-1 limit costs 50 points.
 *
 * `coverage` = nutrients with a target and known intake / nutrients with a target.
 *
 * @param intake  day totals in catalog units (missing key = unknown)
 * @param targets targets from `selectTargets` / `applyOverrides`
 */
export function nutritionScore(
  intake: NutrientMap,
  targets: Targets,
  options: ScoreOptions = {},
): NutritionScoreResult {
  const lambda = options.lambda ?? DEFAULT_SCORE_LAMBDA;
  const perNutrient: Partial<Record<NutrientCode, NutrientScore>> = {};

  let weightedFulfillment = 0;
  let weightSum = 0;
  let penaltySum = 0;
  let targeted = 0;
  let withData = 0;

  for (const code of NUTRIENT_CODES) {
    const target = targets[code];
    if (!target) continue;
    const hasMin = typeof target.min === 'number' && target.min > 0;
    // `max` limits total intake; a scoped UL only counts when explicitly asked for.
    const limit =
      typeof target.max === 'number' && target.max > 0
        ? target.max
        : options.penalizeScopedLimits && target.scopedUl && target.scopedUl.value > 0
          ? target.scopedUl.value
          : undefined;
    const hasMax = limit !== undefined;
    if (!hasMin && !hasMax) continue;

    targeted += 1;
    const raw = intake[code];
    const known = typeof raw === 'number' && Number.isFinite(raw);
    const weight = options.weights?.[code] ?? KEY_NUTRIENT_WEIGHTS[code] ?? 1;
    const entry: NutrientScore = { weight };
    if (hasMin) entry.min = target.min;
    if (limit !== undefined) entry.max = limit;

    if (known) {
      withData += 1;
      const amount = Math.max(0, raw);
      entry.intake = amount;
      if (hasMin) {
        const fulfillment = Math.min(amount / (target.min as number), 1);
        entry.fulfillment = fulfillment;
        weightedFulfillment += weight * fulfillment;
        weightSum += weight;
      }
      if (limit !== undefined) {
        const excess = Math.max(0, amount / limit - 1);
        entry.excess = excess;
        penaltySum += weight * excess;
      }
    }
    perNutrient[code] = entry;
  }

  const base = weightSum > 0 ? weightedFulfillment / weightSum : 0;
  const raw = base - lambda * penaltySum;
  const score = Math.round(100 * Math.min(1, Math.max(0, raw)));
  return { score, coverage: targeted > 0 ? withData / targeted : 0, perNutrient };
}
