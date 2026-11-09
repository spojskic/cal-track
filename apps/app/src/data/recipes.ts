// OWNER: recipes agent. Recipes (a `foods` row of kind 'recipe' + `recipes` + `recipe_ingredients`), the ingredient
// food lookup used by the recipe / saved meal editors, and the default-serving lookup used by pick mode.
//
// Nutrition: per-100 g values of the recipe food come from core `computeRecipe` over the ingredient foods
// (see components/recipes/nutrition.ts): carbs of `excludes_fiber` ingredients are converted to `includes_fiber`
// first, the final cooked weight (when given) sets the per-100 g density, and the recipe food is stored with
// carb_basis 'includes_fiber'.
//
// Versioning: nutrients of a logged food (or of a food used as an ingredient) are immutable. Editing such a
// recipe goes through `supersede_food`: the old row is archived and keeps its recipe / ingredient rows (old diary
// entries keep pointing to it), the new version gets copies. Unlogged recipes are updated in place.
import { keepPreviousData, useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { CarbBasis, NutrientMap } from '@cal/core';

import {
  computeRecipeNutrition,
  recipePortionRows,
  round,
  type RecipeNutrition,
} from '@/components/recipes/nutrition';
import { supabase } from '@/lib/supabase';

import {
  cleanNutrients,
  portionUnitLabel,
  toFoodSource,
  type FoodKind,
  type FoodPortion,
  type FoodSource,
} from './foods';
import { keys } from './keys';
import { requireUserId } from './profile';
import { savedMealKeys } from './saved-meals';

type Row = any;

export const recipeKeys = {
  all: ['recipes'] as const,
  list: ['recipes', 'list'] as const,
  detail: (id: string) => ['recipes', 'detail', id] as const,
  foods: (ids: readonly string[]) => ['recipes', 'foods', ids] as const,
};

const MAX_GRAMS = 1_000_000;

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------

/** Input of {@link useCreateRecipe}. Keep this shape stable: the AI recipe flow imports it. */
export interface RecipeInput {
  name: string;
  /** Number of servings the recipe makes (> 0, fractions allowed). */
  servings: number;
  /** Weight of the finished dish in grams (after cooking). Omit / null = the raw ingredient weight. */
  finalWeightG?: number | null;
  notes?: string;
  ingredients: { foodId: string; grams: number }[];
}

export interface UpdateRecipeInput extends RecipeInput {
  /** Food id of the recipe version being edited. */
  foodId: string;
}

/** A food as needed by the recipe / saved meal editors: nutrients (per 100 g), basis, density and portions. */
export interface IngredientFood {
  id: string;
  name: string;
  brand: string | null;
  kind: FoodKind;
  source: FoodSource;
  nutrients: NutrientMap;
  carbBasis: CarbBasis;
  densityGPerMl: number | null;
  /** True for an older version that was replaced by an edit. */
  archived: boolean;
  /** Empty when the food was loaded without portions (recipe detail). */
  portions: FoodPortion[];
}

export interface RecipeIngredientLine {
  id: string;
  foodId: string;
  grams: number;
  sortOrder: number;
  /** null if the food is not readable any more. */
  food: IngredientFood | null;
}

export interface RecipeDetail {
  /** Food id of this recipe version (kind 'recipe'). */
  foodId: string;
  name: string;
  version: number;
  /** True for an older version (replaced by an edit) or a deleted recipe. */
  archived: boolean;
  /** The newer version that replaced this one, if any. */
  supersededById: string | null;
  ownerId: string | null;
  /** Stored per-100 g nutrients of the finished dish (includes_fiber basis). */
  nutrients: NutrientMap;
  carbBasis: CarbBasis;
  completeness: number;
  servings: number;
  /** As entered; null = not weighed (raw weight is used). */
  finalWeightG: number | null;
  notes: string | null;
  ingredients: RecipeIngredientLine[];
  /** Sum of the ingredient weights. */
  rawWeightG: number;
  /** Finished weight: finalWeightG, else the raw weight. */
  effectiveWeightG: number;
  servingWeightG: number;
}

export interface RecipeSummary {
  id: string;
  name: string;
  servings: number;
  finalWeightG: number | null;
  servingWeightG: number | null;
  kcal100g: number | null;
  kcalPerServing: number | null;
  proteinPerServing: number | null;
  carbsPerServing: number | null;
  fatPerServing: number | null;
  completeness: number | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------------------------------

function toPortion(row: Row): FoodPortion {
  const amount = toNumber(row.amount);
  const rowGrams = toNumber(row.grams) ?? 0;
  const divisor = amount && amount > 0 ? amount : 1;
  const label = String(row.label ?? '').trim();
  return {
    id: String(row.id),
    label,
    unitLabel: portionUnitLabel(label, amount),
    amount,
    unit: row.unit ?? null,
    rowGrams,
    gramsPerUnit: rowGrams / divisor,
    defaultAmount: amount && amount > 0 ? amount : 1,
    sortOrder: toNumber(row.sort_order) ?? 0,
  };
}

function toIngredientFood(row: Row): IngredientFood {
  const portions = (Array.isArray(row.food_portions) ? (row.food_portions as Row[]) : [])
    .map(toPortion)
    .filter((p) => p.gramsPerUnit > 0)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  return {
    id: String(row.id),
    name: String(row.name),
    brand: row.brand ?? null,
    kind: row.kind as FoodKind,
    source: toFoodSource(row.source, 'custom'),
    nutrients: cleanNutrients(row.nutrients),
    carbBasis: row.carb_basis === 'excludes_fiber' ? 'excludes_fiber' : 'includes_fiber',
    densityGPerMl: toNumber(row.density_g_per_ml),
    archived: Boolean(row.archived),
    portions,
  };
}

const INGREDIENT_COLUMNS = 'id,name,brand,kind,source,nutrients,carb_basis,density_g_per_ml,archived';
const INGREDIENT_WITH_PORTIONS = `${INGREDIENT_COLUMNS},food_portions(id,label,amount,unit,grams,sort_order)`;

/** Foods (own + global) by id with nutrients and portions. Unknown / unreadable ids are simply absent. */
export async function fetchFoodsByIds(ids: readonly string[]): Promise<IngredientFood[]> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  const out: IngredientFood[] = [];
  for (let i = 0; i < unique.length; i += 60) {
    const chunk = unique.slice(i, i + 60);
    const { data, error } = await supabase.from('foods').select(INGREDIENT_WITH_PORTIONS).in('id', chunk);
    if (error) throw error;
    for (const row of (data ?? []) as Row[]) out.push(toIngredientFood(row));
  }
  return out;
}

/**
 * Batched food lookup for editors. `foods` is rebuilt from cached data on every render of the same result, so
 * it is safe to read during render; entries are absent while loading or when the food is not readable.
 */
export function useFoodsByIds(ids: readonly string[]) {
  const unique = Array.from(new Set(ids.filter(Boolean))).sort();
  const query = useQuery({
    queryKey: recipeKeys.foods(unique),
    enabled: unique.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    queryFn: () => fetchFoodsByIds(unique),
  });
  const foods = new Map<string, IngredientFood>();
  for (const f of query.data ?? []) foods.set(f.id, f);
  return {
    foods,
    isLoading: query.isLoading,
    /** True while (re)loading, including when new ids are fetched next to already cached ones. */
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Default serving (pick mode)
// ---------------------------------------------------------------------------------------------------------------

export interface DefaultServingInfo {
  /** Grams of the default serving (> 0). */
  grams: number;
  amount: number;
  label: string;
}

/** First portion of a food as defined (grams of `amount` units), else 100 g. Never throws on missing portions. */
export async function fetchDefaultServing(foodId: string): Promise<DefaultServingInfo> {
  const { data, error } = await supabase
    .from('food_portions')
    .select('id,label,amount,unit,grams,sort_order')
    .eq('food_id', foodId)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true })
    .limit(1);
  if (error) throw error;
  const first = ((data ?? []) as Row[]).map(toPortion).find((p) => p.rowGrams > 0);
  return first
    ? { grams: first.rowGrams, amount: first.defaultAmount, label: first.unitLabel }
    : { grams: 100, amount: 100, label: 'g' };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------

/** Loads one recipe version with its ingredient foods. null = no such recipe (or not a recipe). */
export async function fetchRecipeDetail(foodId: string): Promise<RecipeDetail | null> {
  const [foodRes, recipeRes, ingredientRes] = await Promise.all([
    supabase
      .from('foods')
      .select('id,name,kind,owner_id,nutrients,completeness,carb_basis,version,archived')
      .eq('id', foodId)
      .maybeSingle(),
    supabase.from('recipes').select('servings,final_weight_g,notes').eq('food_id', foodId).maybeSingle(),
    supabase
      .from('recipe_ingredients')
      .select(`id,ingredient_food_id,grams,sort_order,food:foods!ingredient_food_id(${INGREDIENT_COLUMNS})`)
      .eq('recipe_food_id', foodId)
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true }),
  ]);
  if (foodRes.error) throw foodRes.error;
  if (recipeRes.error) throw recipeRes.error;
  if (ingredientRes.error) throw ingredientRes.error;
  const food = foodRes.data as Row | null;
  const recipe = recipeRes.data as Row | null;
  if (!food || !recipe || food.kind !== 'recipe') return null;

  let supersededById: string | null = null;
  if (food.archived) {
    const next = await supabase.from('foods').select('id').eq('supersedes', foodId).maybeSingle();
    supersededById = next.data?.id ? String(next.data.id) : null;
  }

  const ingredients: RecipeIngredientLine[] = ((ingredientRes.data ?? []) as Row[]).map((r) => {
    const joined = one<Row>(r.food);
    return {
      id: String(r.id),
      foodId: String(r.ingredient_food_id),
      grams: toNumber(r.grams) ?? 0,
      sortOrder: toNumber(r.sort_order) ?? 0,
      food: joined ? toIngredientFood(joined) : null,
    };
  });
  const servings = toNumber(recipe.servings) ?? 1;
  const finalWeightG = toNumber(recipe.final_weight_g);
  const rawWeightG = ingredients.reduce((sum, i) => sum + i.grams, 0);
  const effectiveWeightG = finalWeightG && finalWeightG > 0 ? finalWeightG : rawWeightG;
  const nutrients = cleanNutrients(food.nutrients);
  return {
    foodId: String(food.id),
    name: String(food.name),
    version: toNumber(food.version) ?? 1,
    archived: Boolean(food.archived),
    supersededById,
    ownerId: food.owner_id ?? null,
    nutrients,
    carbBasis: food.carb_basis === 'excludes_fiber' ? 'excludes_fiber' : 'includes_fiber',
    completeness: toNumber(food.completeness) ?? 0,
    servings,
    finalWeightG,
    notes: recipe.notes ?? null,
    ingredients,
    rawWeightG,
    effectiveWeightG,
    servingWeightG: servings > 0 ? effectiveWeightG / servings : effectiveWeightG,
  };
}

/** One recipe (a specific version) with its ingredients. Data is null when it does not exist. */
export function useRecipe(foodId: string | undefined): UseQueryResult<RecipeDetail | null> {
  return useQuery({
    queryKey: recipeKeys.detail(foodId ?? ''),
    enabled: Boolean(foodId),
    queryFn: () => fetchRecipeDetail(foodId as string),
  });
}

/** The nutrition of a loaded recipe recomputed from its ingredient foods (for completeness hints). */
export function recipeNutritionOf(recipe: RecipeDetail): RecipeNutrition | null {
  const ingredients = recipe.ingredients
    .filter((i) => i.food !== null)
    .map((i) => ({
      nutrients: (i.food as IngredientFood).nutrients,
      carbBasis: (i.food as IngredientFood).carbBasis,
      grams: i.grams,
    }));
  return computeRecipeNutrition(ingredients, recipe.servings, recipe.finalWeightG);
}

/** The user's current (non-archived) recipes, A-Z. */
export function useRecipes(options: { enabled?: boolean } = {}): UseQueryResult<RecipeSummary[]> {
  return useQuery({
    queryKey: recipeKeys.list,
    enabled: options.enabled ?? true,
    queryFn: async (): Promise<RecipeSummary[]> => {
      const { data, error } = await supabase
        .from('foods')
        .select('id,name,nutrients,completeness,recipes!food_id(servings,final_weight_g,recipe_ingredients(grams))')
        .eq('kind', 'recipe')
        .eq('archived', false)
        .not('owner_id', 'is', null)
        .order('name', { ascending: true })
        .limit(500);
      if (error) throw error;
      const out: RecipeSummary[] = [];
      for (const row of (data ?? []) as Row[]) {
        const recipe = one<Row>(row.recipes);
        if (!recipe) continue;
        const nutrients = cleanNutrients(row.nutrients);
        const servings = toNumber(recipe.servings) ?? 1;
        const finalWeightG = toNumber(recipe.final_weight_g);
        const raw = (Array.isArray(recipe.recipe_ingredients) ? (recipe.recipe_ingredients as Row[]) : []).reduce(
          (sum, r) => sum + (toNumber(r.grams) ?? 0),
          0,
        );
        const weight = finalWeightG && finalWeightG > 0 ? finalWeightG : raw;
        const servingWeightG = servings > 0 && weight > 0 ? weight / servings : null;
        const perServing = (v: number | undefined): number | null =>
          v === undefined || servingWeightG === null ? null : (v * servingWeightG) / 100;
        out.push({
          id: String(row.id),
          name: String(row.name),
          servings,
          finalWeightG,
          servingWeightG,
          kcal100g: nutrients.ENERGY_KCAL ?? null,
          kcalPerServing: perServing(nutrients.ENERGY_KCAL),
          proteinPerServing: perServing(nutrients.PROTEIN_G),
          carbsPerServing: perServing(nutrients.CARBS_G),
          fatPerServing: perServing(nutrients.FAT_G),
          completeness: toNumber(row.completeness),
        });
      }
      return out;
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------------------------

interface PreparedRecipe {
  name: string;
  servings: number;
  finalWeightG: number | null;
  notes: string | null;
  ingredients: { foodId: string; grams: number }[];
  nutrition: RecipeNutrition;
}

/** Validates the input, loads the ingredient foods and computes the recipe nutrition. */
async function prepareRecipe(input: RecipeInput, selfFoodId?: string): Promise<PreparedRecipe> {
  const name = input.name.trim();
  if (name === '') throw new Error('Give the recipe a name.');
  if (!Number.isFinite(input.servings) || input.servings <= 0) throw new Error('Servings must be greater than 0.');
  const finalWeightG = input.finalWeightG ?? null;
  if (finalWeightG !== null && (!Number.isFinite(finalWeightG) || finalWeightG <= 0)) {
    throw new Error('The final weight must be greater than 0, or left empty.');
  }
  if (input.ingredients.length === 0) throw new Error('Add at least one ingredient.');
  const ingredients = input.ingredients.map((i) => {
    if (!i.foodId) throw new Error('An ingredient has no food.');
    if (selfFoodId && i.foodId === selfFoodId) throw new Error('A recipe cannot contain itself.');
    if (!Number.isFinite(i.grams) || i.grams <= 0 || i.grams > MAX_GRAMS) {
      throw new Error('Every ingredient needs an amount greater than 0.');
    }
    return { foodId: i.foodId, grams: round(i.grams, 3) };
  });

  const foods = new Map((await fetchFoodsByIds(ingredients.map((i) => i.foodId))).map((f) => [f.id, f] as const));
  const missing = ingredients.find((i) => !foods.has(i.foodId));
  if (missing) throw new Error('An ingredient could not be found. It may have been deleted.');

  const nutrition = computeRecipeNutrition(
    ingredients.map((i) => {
      const food = foods.get(i.foodId) as IngredientFood;
      return { nutrients: food.nutrients, carbBasis: food.carbBasis, grams: i.grams };
    }),
    input.servings,
    finalWeightG,
  );
  if (!nutrition) throw new Error('The recipe has no weight. Check the ingredient amounts.');
  const notes = input.notes?.trim();
  return { name, servings: input.servings, finalWeightG, notes: notes ? notes : null, ingredients, nutrition };
}

function foodPayload(p: PreparedRecipe) {
  return {
    name: p.name,
    nutrients: p.nutrition.per100g,
    completeness: p.nutrition.completeness,
    carb_basis: 'includes_fiber' as const,
  };
}

function recipeRow(p: PreparedRecipe) {
  return { servings: p.servings, final_weight_g: p.finalWeightG, notes: p.notes };
}

function ingredientRows(foodId: string, p: PreparedRecipe) {
  return p.ingredients.map((i, index) => ({
    recipe_food_id: foodId,
    ingredient_food_id: i.foodId,
    grams: i.grams,
    sort_order: index,
  }));
}

function portionRows(foodId: string, p: PreparedRecipe) {
  return recipePortionRows(p.nutrition.servingWeightG, p.nutrition.finalWeightG, p.servings).map((r) => ({
    food_id: foodId,
    ...r,
  }));
}

/** Inserts the recipe, ingredient and portion rows of a recipe food that already exists. */
async function insertChildren(foodId: string, userId: string, p: PreparedRecipe): Promise<void> {
  const recipe = await supabase.from('recipes').insert({ food_id: foodId, user_id: userId, ...recipeRow(p) });
  if (recipe.error) throw recipe.error;
  const ingredients = await supabase.from('recipe_ingredients').insert(ingredientRows(foodId, p));
  if (ingredients.error) throw ingredients.error;
  const portions = await supabase.from('food_portions').insert(portionRows(foodId, p));
  if (portions.error) throw portions.error;
}

/** Creates the food, then its children; removes the food again (cascade) if a later insert fails. */
async function createRecipeRows(userId: string, p: PreparedRecipe): Promise<string> {
  const { data, error } = await supabase
    .from('foods')
    .insert({ ...foodPayload(p), owner_id: userId, source: 'recipe', kind: 'recipe' })
    .select('id')
    .single();
  if (error) throw error;
  const foodId = String((data as Row).id);
  try {
    await insertChildren(foodId, userId, p);
  } catch (e) {
    await supabase.from('foods').delete().eq('id', foodId);
    throw e;
  }
  return foodId;
}

function isRestrictViolation(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  return e?.code === '23001' || /immutable|is referenced by/i.test(e?.message ?? '');
}

interface RecipeSnapshot {
  food: { name: string; nutrients: unknown; completeness: number | null; carb_basis: string };
  recipe: { servings: number; final_weight_g: number | null; notes: string | null };
  ingredients: Row[];
  portions: Row[];
}

async function loadSnapshot(foodId: string, userId: string): Promise<RecipeSnapshot> {
  const [food, recipe, ingredients, portions] = await Promise.all([
    supabase
      .from('foods')
      .select('name,nutrients,completeness,carb_basis,owner_id,kind,archived')
      .eq('id', foodId)
      .maybeSingle(),
    supabase.from('recipes').select('servings,final_weight_g,notes').eq('food_id', foodId).maybeSingle(),
    supabase.from('recipe_ingredients').select('ingredient_food_id,grams,sort_order').eq('recipe_food_id', foodId),
    supabase.from('food_portions').select('label,amount,unit,grams,sort_order').eq('food_id', foodId),
  ]);
  for (const r of [food, recipe, ingredients, portions]) if (r.error) throw r.error;
  const f = food.data as Row | null;
  if (!f || !recipe.data || f.kind !== 'recipe') throw new Error('Recipe not found.');
  if (f.owner_id !== userId) throw new Error('You can only edit your own recipes.');
  if (f.archived) throw new Error('This version of the recipe was replaced. Open the current version to edit it.');
  return {
    food: { name: f.name, nutrients: f.nutrients, completeness: f.completeness, carb_basis: f.carb_basis },
    recipe: recipe.data as RecipeSnapshot['recipe'],
    ingredients: (ingredients.data ?? []) as Row[],
    portions: (portions.data ?? []) as Row[],
  };
}

/** Best-effort restore of an in-place update that failed half way. Never throws. */
async function restoreSnapshot(foodId: string, s: RecipeSnapshot): Promise<void> {
  try {
    await supabase.from('recipe_ingredients').delete().eq('recipe_food_id', foodId);
    if (s.ingredients.length > 0) {
      await supabase
        .from('recipe_ingredients')
        .insert(s.ingredients.map((r) => ({ ...r, recipe_food_id: foodId })));
    }
    await supabase.from('food_portions').delete().eq('food_id', foodId);
    if (s.portions.length > 0) {
      await supabase.from('food_portions').insert(s.portions.map((r) => ({ ...r, food_id: foodId })));
    }
    await supabase.from('recipes').update(s.recipe).eq('food_id', foodId);
    await supabase.from('foods').update(s.food).eq('id', foodId);
  } catch {
    // Nothing more can be done; the original error is reported.
  }
}

async function replaceChildren(foodId: string, p: PreparedRecipe): Promise<void> {
  const recipe = await supabase.from('recipes').update(recipeRow(p)).eq('food_id', foodId);
  if (recipe.error) throw recipe.error;
  const delIngredients = await supabase.from('recipe_ingredients').delete().eq('recipe_food_id', foodId);
  if (delIngredients.error) throw delIngredients.error;
  const insIngredients = await supabase.from('recipe_ingredients').insert(ingredientRows(foodId, p));
  if (insIngredients.error) throw insIngredients.error;
  const delPortions = await supabase.from('food_portions').delete().eq('food_id', foodId);
  if (delPortions.error) throw delPortions.error;
  const insPortions = await supabase.from('food_portions').insert(portionRows(foodId, p));
  if (insPortions.error) throw insPortions.error;
}

export interface UpdateRecipeResult {
  /** The recipe version to open afterwards (a new id when superseded). */
  foodId: string;
  /** The version that was edited. */
  previousFoodId: string;
  /** True when a new version was created because the recipe is logged or used as an ingredient. */
  superseded: boolean;
}

async function updateRecipeRows(userId: string, input: UpdateRecipeInput): Promise<UpdateRecipeResult> {
  const foodId = input.foodId;
  const p = await prepareRecipe(input, foodId);
  const snapshot = await loadSnapshot(foodId, userId);

  const first = await supabase.from('foods').update(foodPayload(p)).eq('id', foodId).select('id').single();
  if (!first.error) {
    try {
      await replaceChildren(foodId, p);
    } catch (e) {
      await restoreSnapshot(foodId, snapshot);
      throw e;
    }
    return { foodId, previousFoodId: foodId, superseded: false };
  }
  if (!isRestrictViolation(first.error)) throw first.error;

  // Logged / used as an ingredient: create the next version and edit that one.
  const rpc = await supabase.rpc('supersede_food', { p_food_id: foodId });
  if (rpc.error) throw rpc.error;
  const newId = String(rpc.data);
  try {
    const upd = await supabase.from('foods').update(foodPayload(p)).eq('id', newId).select('id').single();
    if (upd.error) throw upd.error;
    // supersede_food copied the old portions (old weights): replace them with the new ones.
    const stale = await supabase.from('food_portions').delete().eq('food_id', newId);
    if (stale.error) throw stale.error;
    await insertChildren(newId, userId, p);
  } catch (e) {
    await supabase.from('foods').delete().eq('id', newId);
    await supabase.from('foods').update({ archived: false }).eq('id', foodId);
    throw e;
  }

  // Best effort: keep favorites and saved meals on the current version.
  try {
    const fav = await supabase.from('favorites').select('food_id').eq('food_id', foodId).maybeSingle();
    if (fav.data) {
      await supabase
        .from('favorites')
        .upsert({ user_id: userId, food_id: newId }, { onConflict: 'user_id,food_id', ignoreDuplicates: true });
    }
    await supabase.from('saved_meal_items').update({ food_id: newId }).eq('food_id', foodId);
  } catch {
    // ignore
  }
  return { foodId: newId, previousFoodId: foodId, superseded: true };
}

/**
 * Marks everything a recipe change can touch as stale. The returned promise covers the recipe queries only (so
 * the screen opened next shows fresh data); lists, search, the diary and saved meals refresh in the background.
 */
function invalidateRecipeCaches(qc: ReturnType<typeof useQueryClient>, ids: readonly string[]): Promise<unknown> {
  void Promise.all([
    qc.invalidateQueries({ queryKey: keys.myFoods }),
    qc.invalidateQueries({ queryKey: keys.favorites }),
    qc.invalidateQueries({ queryKey: keys.recentFoods }),
    qc.invalidateQueries({ queryKey: savedMealKeys.all }),
    qc.invalidateQueries({ queryKey: ['food_search'] }),
    qc.invalidateQueries({ queryKey: ['day'] }),
  ]);
  return Promise.all([
    qc.invalidateQueries({ queryKey: recipeKeys.all }),
    ...ids.map((id) => qc.invalidateQueries({ queryKey: keys.food(id) })),
  ]);
}

/**
 * Creates a recipe: a `foods` row (kind/source 'recipe', owned by the user) with the computed per-100 g
 * nutrients, its `recipes` + `recipe_ingredients` rows and the portions "1 serving", "Full recipe", "100 g".
 * Resolves with the recipe's food id. Partial rows are removed if a later insert fails.
 */
export function useCreateRecipe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RecipeInput): Promise<{ foodId: string }> => {
      const userId = await requireUserId();
      const prepared = await prepareRecipe(input);
      return { foodId: await createRecipeRows(userId, prepared) };
    },
    onSuccess: (res) => {
      void invalidateRecipeCaches(qc, [res.foodId]);
    },
  });
}

/**
 * Updates a recipe. In place when it was never logged or used as an ingredient; otherwise the immutability
 * trigger rejects the nutrient change and a new version is created via `supersede_food` (old diary entries keep
 * the old version, which is archived). Open `foodId` of the result afterwards.
 */
export function useUpdateRecipe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateRecipeInput): Promise<UpdateRecipeResult> => {
      const userId = await requireUserId();
      return updateRecipeRows(userId, input);
    },
    onSuccess: (res) => invalidateRecipeCaches(qc, [res.foodId, res.previousFoodId]),
  });
}

/** Copies a recipe (ingredients, servings, weight, notes) into a new recipe named "<name> (copy)". */
export function useDuplicateRecipe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (foodId: string): Promise<{ foodId: string }> => {
      const userId = await requireUserId();
      const source = await fetchRecipeDetail(foodId);
      if (!source) throw new Error('Recipe not found.');
      const prepared = await prepareRecipe({
        name: `${source.name} (copy)`,
        servings: source.servings,
        finalWeightG: source.finalWeightG,
        ...(source.notes ? { notes: source.notes } : {}),
        ingredients: source.ingredients.map((i) => ({ foodId: i.foodId, grams: i.grams })),
      });
      return { foodId: await createRecipeRows(userId, prepared) };
    },
    onSuccess: (res) => invalidateRecipeCaches(qc, [res.foodId]),
  });
}

/**
 * Deletes a recipe by archiving its food: it disappears from search and the lists, while old diary entries and
 * recipes that use it keep working.
 */
export function useDeleteRecipe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (foodId: string): Promise<void> => {
      const { error } = await supabase.from('foods').update({ archived: true }).eq('id', foodId).select('id').single();
      if (error) throw error;
    },
    onSuccess: (_d, foodId) => invalidateRecipeCaches(qc, [foodId]),
  });
}
