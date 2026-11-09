/**
 * Zod schemas for everything the LLM produces or the matcher consumes.
 *
 * These double as the JSON Schema sent to OpenRouter (strict mode), so keep
 * them free of unions/free-form records (see NutrientEstimateWireSchema).
 */

import { z } from 'zod';

const confidence = z
  .number()
  .min(0)
  .max(1)
  .describe('Confidence between 0 and 1 (0.9+ = very sure, 0.5 = guess)');

// ---------------------------------------------------------------------------
// Meal parsing
// ---------------------------------------------------------------------------

export const ParsedMealItemSchema = z.object({
  name: z.string().min(1).describe('Short English food name, e.g. "grilled chicken breast"'),
  searchTerms: z
    .array(z.string().min(1))
    .min(1)
    .max(6)
    .describe('English search terms for a nutrition database, best first, e.g. ["chicken breast grilled", "chicken breast"]'),
  originalText: z
    .string()
    .optional()
    .describe('The food phrase exactly as the user wrote it (original language), without the quantity'),
  grams: z.number().positive().max(10000).describe('Best estimate of the edible weight in grams, as eaten (cooked weight if cooked)'),
  gramsLow: z.number().positive().max(10000).optional().describe('Plausible lower bound in grams'),
  gramsHigh: z.number().positive().max(10000).optional().describe('Plausible upper bound in grams'),
  preparation: z.string().optional().describe('Cooking method or state, e.g. "fried", "raw", "boiled"'),
  brand: z.string().optional().describe('Brand name only if clearly visible or stated'),
  confidence,
});
export type ParsedMealItem = z.infer<typeof ParsedMealItemSchema>;

export const MealTypeSchema = z.enum(['breakfast', 'lunch', 'dinner', 'snack']);
export type MealType = z.infer<typeof MealTypeSchema>;

export const ParsedMealSchema = z.object({
  items: z.array(ParsedMealItemSchema).max(40),
  notes: z.string().optional().describe('Short note about anything unclear or assumed'),
  mealGuess: MealTypeSchema.optional().describe('Which meal this most likely is, only if there is a hint'),
});
export type ParsedMeal = z.infer<typeof ParsedMealSchema>;

export const RecipeDraftSchema = z.object({
  name: z.string().min(1),
  servings: z.number().positive().max(200).describe('Number of servings the recipe makes'),
  finalWeightG: z.number().positive().max(100000).optional().describe('Total cooked weight in grams, only if stated or clearly implied'),
  ingredients: z.array(ParsedMealItemSchema).min(1).max(60),
  instructions: z.string().optional().describe('Very short summary of the method, max 3 sentences'),
});
export type RecipeDraft = z.infer<typeof RecipeDraftSchema>;

// ---------------------------------------------------------------------------
// Coach guard
// ---------------------------------------------------------------------------

export const GUARD_CATEGORIES = ['on_topic', 'off_topic', 'medical_red_flag', 'eating_disorder_risk'] as const;
export const GuardCategorySchema = z.enum(GUARD_CATEGORIES);
export type GuardCategory = z.infer<typeof GuardCategorySchema>;

export const GuardResultSchema = z.object({
  category: GuardCategorySchema,
  reason: z.string().describe('One short sentence explaining the classification'),
});
export type GuardResult = z.infer<typeof GuardResultSchema>;

// ---------------------------------------------------------------------------
// Nutrient estimates (fallback when no DB match)
// ---------------------------------------------------------------------------

/** Nutrient codes the app understands. The model may add others matching NUTRIENT_CODE_PATTERN. */
export const CORE_NUTRIENT_CODES = [
  'ENERGY_KCAL',
  'PROTEIN_G',
  'CARBS_G',
  'FAT_G',
  'FIBER_G',
  'SUGARS_G',
  'SODIUM_MG',
] as const;

export const MICRO_NUTRIENT_CODES = [
  'SATURATED_FAT_G',
  'CHOLESTEROL_MG',
  'POTASSIUM_MG',
  'CALCIUM_MG',
  'IRON_MG',
  'MAGNESIUM_MG',
  'ZINC_MG',
  'VITAMIN_C_MG',
  'VITAMIN_A_UG',
  'VITAMIN_D_UG',
  'VITAMIN_B12_UG',
  'FOLATE_UG',
] as const;

export const NUTRIENT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,40}$/;

/** Public shape the app stores/displays (flagged "AI estimate" by the caller). */
export const NutrientEstimateSchema = z.object({
  per100g: z.record(z.string(), z.number()),
  confidence,
});
export type NutrientEstimate = z.infer<typeof NutrientEstimateSchema>;

/** Wire format sent to the model: arrays instead of a free-form record (strict-mode friendly). */
export const NutrientEstimateWireSchema = z.object({
  estimates: z.array(
    z.object({
      index: z.number().int().min(0).describe('Index of the food in the input list'),
      nutrients: z.array(
        z.object({
          code: z.string().describe('Nutrient code such as ENERGY_KCAL'),
          per100g: z.number().min(0).describe('Amount per 100 g of the food (kcal, g, mg or ug as in the code suffix)'),
        }),
      ),
      confidence,
    }),
  ),
});
export type NutrientEstimateWire = z.infer<typeof NutrientEstimateWireSchema>;

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export const FoodCandidateSchema = z.object({
  id: z.string(),
  name: z.string(),
  brand: z.string().optional(),
  /** e.g. 'generic' | 'branded' | 'custom' | 'recipe' */
  kind: z.string(),
  /** e.g. 'usda' | 'cnf' | 'cofid' | 'off' | 'user' */
  source: z.string(),
  kcal100g: z.number(),
  /** 0..1: share of tracked nutrients that are present. */
  completeness: z.number().min(0).max(1),
  isUserFood: z.boolean().optional(),
  usageCount: z.number().optional(),
});
export type FoodCandidate = z.infer<typeof FoodCandidateSchema>;

export const MatchedItemSchema = z.object({
  item: ParsedMealItemSchema,
  best: FoodCandidateSchema.nullable(),
  alternatives: z.array(FoodCandidateSchema).max(4),
  matchScore: z.number().min(0).max(1),
  needsEstimate: z.boolean(),
});
export type MatchedItem = z.infer<typeof MatchedItemSchema>;
