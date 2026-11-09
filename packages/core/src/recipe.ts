import { scaleNutrients, sumNutrientsDetailed, type DiaryEntryAmount } from './diary';
import { NUTRIENT_CODES, type NutrientCode } from './nutrients';
import type { NutrientMap } from './types';

/** Inputs for {@link computeRecipe}. */
export interface RecipeInput {
  /** Raw ingredients: nutrients per 100 g and the grams used. */
  ingredients: readonly DiaryEntryAmount[];
  /** Number of servings the recipe makes (> 0, fractions allowed). */
  servings: number;
  /**
   * Weight of the finished dish in grams (after cooking / evaporation).
   * Defaults to the raw ingredient weight.
   */
  finalWeightG?: number;
}

/** Result of {@link computeRecipe}. */
export interface RecipeResult {
  /** Total nutrients of the whole recipe (known amounts only). */
  totalNutrients: NutrientMap;
  /** Sum of the ingredient weights. */
  totalRawWeightG: number;
  /** Finished weight (given, else the raw weight). */
  finalWeightG: number;
  /** Nutrients per 100 g of the FINISHED dish: `total * 100 / finalWeightG`. */
  per100g: NutrientMap;
  /** Nutrients per serving: `total / servings`. */
  perServing: NutrientMap;
  /** Grams of one serving of the finished dish: `finalWeightG / servings`. */
  servingWeightG: number;
  /**
   * Nutrients known for only SOME of the (non-zero-weight) ingredients; the
   * totals of these are lower bounds. A nutrient unknown for ALL ingredients is
   * simply absent from the result.
   */
  incompleteNutrients: NutrientCode[];
}

function scaleMap(map: NutrientMap, factor: number): NutrientMap {
  const out: NutrientMap = {};
  for (const code of NUTRIENT_CODES) {
    const v = map[code];
    if (v !== undefined) out[code] = v * factor;
  }
  return out;
}

/**
 * Computes nutrition for a recipe.
 *
 * ```
 * total        = sum(ingredient.per100g * ingredient.grams / 100)
 * per100g      = total * 100 / finalWeightG       (finalWeightG defaults to the raw weight)
 * perServing   = total / servings
 * servingWeightG = finalWeightG / servings
 * ```
 *
 * Cooking that loses water (finalWeightG < raw weight) concentrates the
 * nutrients per 100 g; the totals are unchanged. Nutrient losses from heat are
 * not modelled.
 *
 * Unknown vs zero: a nutrient with no data in ANY ingredient is absent from
 * the result (unknown), an explicit 0 stays 0, and a nutrient with data in only
 * some ingredients is summed over the known ones and listed in
 * `incompleteNutrients`. Ingredients with 0 g are ignored for that check.
 * Computed nutrients (net carbs, omega-3/6) are summed like any other key; call
 * `deriveNutrients` on the result to recompute them.
 *
 * @throws RangeError for non-positive servings / final weight, negative grams
 */
export function computeRecipe(input: RecipeInput): RecipeResult {
  const { ingredients, servings } = input;
  if (!Number.isFinite(servings) || servings <= 0) throw new RangeError('servings must be > 0');
  for (const ing of ingredients) {
    if (!Number.isFinite(ing.grams) || ing.grams < 0) {
      throw new RangeError('ingredient grams must be >= 0');
    }
  }

  const totalRawWeightG = ingredients.reduce((acc, ing) => acc + ing.grams, 0);
  const finalWeightG = input.finalWeightG ?? totalRawWeightG;
  if (input.finalWeightG !== undefined && (!Number.isFinite(finalWeightG) || finalWeightG <= 0)) {
    throw new RangeError('finalWeightG must be > 0');
  }

  const scaled = ingredients.filter((ing) => ing.grams > 0).map((ing) => scaleNutrients(ing.per100g, ing.grams));
  const { totals, incompleteNutrients } = sumNutrientsDetailed(scaled);

  const hasWeight = finalWeightG > 0;
  return {
    totalNutrients: totals,
    totalRawWeightG,
    finalWeightG,
    per100g: hasWeight ? scaleMap(totals, 100 / finalWeightG) : {},
    perServing: scaleMap(totals, 1 / servings),
    servingWeightG: finalWeightG / servings,
    incompleteNutrients,
  };
}
