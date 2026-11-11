// Pure recipe nutrition math (no React, no Supabase, no app imports) so it can be unit-tested.
import {
  COMPUTED_NUTRIENT_CODES,
  completeness as computeCompleteness,
  computeRecipe,
  estimateEnergyKcal,
  isNutrientCode,
  type CarbBasis,
  type NutrientCode,
  type NutrientMap,
} from '@ration/core';

const COMPUTED: ReadonlySet<string> = new Set<string>(COMPUTED_NUTRIENT_CODES);

/** One ingredient: its food's per-100 g nutrients as stored, that food's carb basis, and the grams used. */
export interface NutritionIngredient {
  nutrients: NutrientMap;
  carbBasis: CarbBasis;
  grams: number;
}

export const round = (value: number, decimals: number): number => Number(value.toFixed(decimals));

/**
 * Prepares one ingredient's per-100 g map for summing:
 * - keeps only known catalog codes with finite values; computed codes (net carbs, omega totals) are dropped,
 *   the app derives them at read time;
 * - a missing energy value is estimated from the macros (exactly what the diary does for that food);
 * - an `excludes_fiber` (EU style) CARBS_G becomes `includes_fiber` (US style) by adding the fiber, when
 *   fiber is known. Without fiber the value is left as is (it cannot be converted).
 */
export function normalizeIngredientNutrients(nutrients: NutrientMap, carbBasis: CarbBasis): NutrientMap {
  const out: NutrientMap = {};
  for (const [key, value] of Object.entries(nutrients)) {
    if (!isNutrientCode(key) || COMPUTED.has(key)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    out[key] = value;
  }
  if (out.ENERGY_KCAL === undefined) {
    const estimate = estimateEnergyKcal(out, carbBasis);
    if (estimate !== undefined) out.ENERGY_KCAL = estimate;
  }
  if (carbBasis === 'excludes_fiber' && out.CARBS_G !== undefined && out.FIBER_G !== undefined) {
    out.CARBS_G = out.CARBS_G + out.FIBER_G;
  }
  return out;
}

export interface RecipeNutrition {
  /** Whole recipe (all servings), unrounded. */
  total: NutrientMap;
  /** Per 100 g of the FINISHED dish (final cooked weight when given), rounded for storage. includes_fiber basis. */
  per100g: NutrientMap;
  /** Per serving, unrounded. includes_fiber basis. */
  perServing: NutrientMap;
  /** Sum of the ingredient weights. */
  rawWeightG: number;
  /** Finished weight: the given cooked weight, else the raw weight. */
  finalWeightG: number;
  /** Grams of one serving: finalWeightG / servings. */
  servingWeightG: number;
  /** Nutrients known for only SOME ingredients (their totals understate the truth), without computed codes. */
  incompleteNutrients: NutrientCode[];
  /** Share (0..1) of the catalog covered by per100g. */
  completeness: number;
}

/**
 * Nutrition of a recipe from its ingredients. Uses core `computeRecipe` (unknown-vs-zero semantics, final
 * cooked weight) after normalising every ingredient (see {@link normalizeIngredientNutrients}).
 *
 * Returns null when the inputs cannot produce a result: no servings, no ingredient weight. A non-positive
 * `finalWeightG` is ignored (the raw weight is used) so a half-typed field does not blank a live preview.
 */
export function computeRecipeNutrition(
  ingredients: readonly NutritionIngredient[],
  servings: number,
  finalWeightG?: number | null,
): RecipeNutrition | null {
  if (!Number.isFinite(servings) || servings <= 0) return null;
  const usable = ingredients.filter((i) => Number.isFinite(i.grams) && i.grams > 0);
  if (usable.length === 0) return null;

  const cooked = finalWeightG !== null && finalWeightG !== undefined && Number.isFinite(finalWeightG) && finalWeightG > 0;
  const result = computeRecipe({
    ingredients: usable.map((i) => ({
      per100g: normalizeIngredientNutrients(i.nutrients, i.carbBasis),
      grams: i.grams,
    })),
    servings,
    ...(cooked ? { finalWeightG: finalWeightG as number } : {}),
  });

  const per100g: NutrientMap = {};
  for (const [key, value] of Object.entries(result.per100g)) {
    if (!isNutrientCode(key) || COMPUTED.has(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) per100g[key] = round(value, 5);
  }

  return {
    total: result.totalNutrients,
    per100g,
    perServing: result.perServing,
    rawWeightG: result.totalRawWeightG,
    finalWeightG: result.finalWeightG,
    servingWeightG: result.servingWeightG,
    incompleteNutrients: result.incompleteNutrients.filter((c) => !COMPUTED.has(c)),
    completeness: computeCompleteness(per100g),
  };
}

export interface RecipePortionRow {
  label: string;
  amount: number | null;
  unit: string | null;
  /** Grams of `amount` units (food_portions convention). */
  grams: number;
  sort_order: number;
}

/**
 * Portions stored on the recipe food: "1 serving" (= servingWeightG), "Full recipe" (= finished weight; omitted
 * for a single-serving recipe, where it would be identical) and "100 g".
 */
export function recipePortionRows(servingWeightG: number, finalWeightG: number, servings: number): RecipePortionRow[] {
  const rows: RecipePortionRow[] = [];
  if (servingWeightG > 0) {
    rows.push({ label: '1 serving', amount: 1, unit: 'serving', grams: round(servingWeightG, 3), sort_order: rows.length });
  }
  if (finalWeightG > 0 && Math.abs(servings - 1) > 1e-9) {
    rows.push({ label: 'Full recipe', amount: null, unit: null, grams: round(finalWeightG, 3), sort_order: rows.length });
  }
  rows.push({ label: '100 g', amount: 100, unit: 'g', grams: 100, sort_order: rows.length });
  return rows;
}
