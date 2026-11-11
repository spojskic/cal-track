// Pure (no React Native imports): the sentence under the nutrition score ring that says WHY the score is what it is.
// The score is `base - penalty` (packages/core/src/score.ts): the weighted share of the targets that were reached, minus a penalty for
// every nutrient that went over a limit. A day can reach many targets and still score 0% when a limit (sodium, saturated fat, added
// sugars, ...) was exceeded by a lot, which looks wrong unless the screen says so.
import { NUTRIENT_BY_CODE, type NutrientCode, type NutrientScore, type NutritionScoreResult } from '@ration/core';

export interface OverLimit {
  code: NutrientCode;
  name: string;
  /** Intake as a percentage of the limit (above 100). */
  percent: number;
}

export interface ScoreDetails {
  /** Weighted average of how far the targets with a minimum were reached (each capped at 100%), in percent. Undefined without data. */
  reachedPercent: number | undefined;
  /** The nutrients over a limit, the ones that cost the most points first. */
  overLimits: OverLimit[];
}

export function scoreDetails(score: NutritionScoreResult, maxOverLimits = 3): ScoreDetails {
  let weighted = 0;
  let weights = 0;
  const over: (OverLimit & { cost: number })[] = [];
  for (const [code, entry] of Object.entries(score.perNutrient) as [NutrientCode, NutrientScore][]) {
    if (entry.fulfillment !== undefined) {
      weighted += entry.weight * entry.fulfillment;
      weights += entry.weight;
    }
    if (entry.excess !== undefined && entry.excess > 0 && entry.intake !== undefined && entry.max !== undefined && entry.max > 0) {
      over.push({
        code,
        name: NUTRIENT_BY_CODE[code]?.name ?? code,
        percent: Math.round((entry.intake / entry.max) * 100),
        cost: entry.weight * entry.excess,
      });
    }
  }
  over.sort((a, b) => b.cost - a.cost);
  return {
    reachedPercent: weights > 0 ? Math.round((100 * weighted) / weights) : undefined,
    overLimits: over.slice(0, maxOverLimits).map(({ code, name, percent }) => ({ code, name, percent })),
  };
}

/** "Targets reached: 31% on average. Over a limit: Sodium 187%, Saturated fat 150% (going over a limit takes points off)." */
export function scoreDetailText(score: NutritionScoreResult): string | undefined {
  const { reachedPercent, overLimits } = scoreDetails(score);
  const parts: string[] = [];
  if (reachedPercent !== undefined) parts.push(`Targets reached: ${reachedPercent}% on average.`);
  if (overLimits.length > 0) {
    parts.push(`Over a limit: ${overLimits.map((o) => `${o.name} ${o.percent}%`).join(', ')} (going over a limit takes points off).`);
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}
