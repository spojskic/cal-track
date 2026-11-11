// OWNER: recipes agent. Saved meals: named lists of (food, grams) that can be logged into a diary meal group.
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  deriveNutrients,
  scaleNutrients,
  sumNutrients,
  type CarbBasis,
  type NutrientMap,
} from '@ration/core';

import { requireUserId } from '@/lib/auth-user';
import { supabase } from '@/lib/supabase';
import { isUuid } from '@/lib/uuid';

import { cleanNutrients } from './foods';
import { keys } from './keys';

type Row = any;

export const savedMealKeys = {
  all: ['saved_meals'] as const,
  list: ['saved_meals', 'list'] as const,
  detail: (id: string) => ['saved_meals', 'detail', id] as const,
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

export interface SavedMealItem {
  id: string;
  foodId: string;
  grams: number;
  sortOrder: number;
  food: {
    name: string;
    brand: string | null;
    kind: string;
    carbBasis: CarbBasis;
    /** Per 100 g. */
    nutrients: NutrientMap;
    archived: boolean;
  };
  /** Scaled to `grams` and derived (net carbs, energy fallback). Missing key = unknown. */
  nutrients: NutrientMap;
  kcal: number | undefined;
}

export interface SavedMeal {
  id: string;
  name: string;
  items: SavedMealItem[];
  /** Sum over the items; macros are 0 when no item has data. */
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

export interface SavedMealItemInput {
  foodId: string;
  grams: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------

const MEAL_SELECT =
  'id,name,saved_meal_items(id,food_id,grams,sort_order,foods(name,brand,kind,nutrients,carb_basis,archived))';

function mapMeal(row: Row): SavedMeal {
  const rawItems = Array.isArray(row.saved_meal_items) ? (row.saved_meal_items as Row[]) : [];
  const items: SavedMealItem[] = rawItems
    .map((r): SavedMealItem => {
      const joined = one<Row>(r.foods);
      const carbBasis: CarbBasis = joined?.carb_basis === 'excludes_fiber' ? 'excludes_fiber' : 'includes_fiber';
      const nutrientsPer100 = cleanNutrients(joined?.nutrients);
      const grams = toNumber(r.grams) ?? 0;
      const nutrients = deriveNutrients(scaleNutrients(nutrientsPer100, grams), { carbBasis });
      return {
        id: String(r.id),
        foodId: String(r.food_id),
        grams,
        sortOrder: toNumber(r.sort_order) ?? 0,
        food: {
          name: joined?.name ?? 'Unknown food',
          brand: joined?.brand ?? null,
          kind: joined?.kind ?? 'custom',
          carbBasis,
          nutrients: nutrientsPer100,
          archived: Boolean(joined?.archived),
        },
        nutrients,
        kcal: nutrients.ENERGY_KCAL,
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  const totals = sumNutrients(items.map((i) => i.nutrients));
  return {
    id: String(row.id),
    name: String(row.name),
    items,
    kcal: totals.ENERGY_KCAL ?? 0,
    proteinG: totals.PROTEIN_G ?? 0,
    carbsG: totals.CARBS_G ?? 0,
    fatG: totals.FAT_G ?? 0,
  };
}

/** The user's saved meals with items and totals, A-Z. */
export function useSavedMeals(options: { enabled?: boolean } = {}): UseQueryResult<SavedMeal[]> {
  return useQuery({
    queryKey: savedMealKeys.list,
    enabled: options.enabled ?? true,
    queryFn: async (): Promise<SavedMeal[]> => {
      const { data, error } = await supabase
        .from('saved_meals')
        .select(MEAL_SELECT)
        .order('name', { ascending: true })
        .limit(500);
      if (error) throw error;
      return ((data ?? []) as Row[]).map(mapMeal);
    },
  });
}

/** One saved meal. Data is null when it does not exist. */
export function useSavedMeal(id: string | undefined): UseQueryResult<SavedMeal | null> {
  return useQuery({
    queryKey: savedMealKeys.detail(id ?? ''),
    enabled: Boolean(id),
    queryFn: async (): Promise<SavedMeal | null> => {
      // An id that is not a UUID can never exist; answer "not found" without sending it to Postgres.
      if (!isUuid(id)) return null;
      const { data, error } = await supabase.from('saved_meals').select(MEAL_SELECT).eq('id', id).maybeSingle();
      if (error) throw error;
      return data ? mapMeal(data as Row) : null;
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------------------------

function validateMeal(name: string, items: readonly SavedMealItemInput[]): { name: string; items: SavedMealItemInput[] } {
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('Give the meal a name.');
  if (items.length === 0) throw new Error('Add at least one food.');
  const clean = items.map((i) => {
    if (!i.foodId) throw new Error('An item has no food.');
    if (!Number.isFinite(i.grams) || i.grams <= 0 || i.grams > MAX_GRAMS) {
      throw new Error('Every item needs an amount greater than 0.');
    }
    return { foodId: i.foodId, grams: Number(i.grams.toFixed(3)) };
  });
  return { name: trimmed, items: clean };
}

function itemRows(mealId: string, items: readonly SavedMealItemInput[]) {
  return items.map((i, index) => ({ saved_meal_id: mealId, food_id: i.foodId, grams: i.grams, sort_order: index }));
}

function invalidateSavedMeals(qc: ReturnType<typeof useQueryClient>): void {
  void qc.invalidateQueries({ queryKey: savedMealKeys.all });
}

/**
 * Creates a saved meal from a list of foods + grams (for example the entries of a diary meal group, or foods
 * picked from scratch). Resolves with the new id; a failed item insert removes the meal again.
 */
export function useCreateSavedMeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; items: SavedMealItemInput[] }): Promise<{ id: string }> => {
      const userId = await requireUserId();
      const meal = validateMeal(input.name, input.items);
      const { data, error } = await supabase
        .from('saved_meals')
        .insert({ user_id: userId, name: meal.name })
        .select('id')
        .single();
      if (error) throw error;
      const id = String((data as Row).id);
      const ins = await supabase.from('saved_meal_items').insert(itemRows(id, meal.items));
      if (ins.error) {
        await supabase.from('saved_meals').delete().eq('id', id);
        throw ins.error;
      }
      return { id };
    },
    onSuccess: () => invalidateSavedMeals(qc),
  });
}

/**
 * Renames a saved meal and replaces its items (new rows are inserted before the old ones are removed, so a
 * failure leaves the previous items in place).
 */
export function useUpdateSavedMeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; name: string; items: SavedMealItemInput[] }): Promise<void> => {
      const meal = validateMeal(input.name, input.items);
      const existing = await supabase.from('saved_meal_items').select('id').eq('saved_meal_id', input.id);
      if (existing.error) throw existing.error;
      const oldIds = ((existing.data ?? []) as Row[]).map((r) => String(r.id));

      const rename = await supabase.from('saved_meals').update({ name: meal.name }).eq('id', input.id).select('id').single();
      if (rename.error) throw rename.error;

      const ins = await supabase.from('saved_meal_items').insert(itemRows(input.id, meal.items)).select('id');
      if (ins.error) throw ins.error;
      if (oldIds.length > 0) {
        const del = await supabase.from('saved_meal_items').delete().in('id', oldIds);
        if (del.error) {
          const newIds = ((ins.data ?? []) as Row[]).map((r) => String(r.id));
          if (newIds.length > 0) await supabase.from('saved_meal_items').delete().in('id', newIds);
          throw del.error;
        }
      }
    },
    onSuccess: () => invalidateSavedMeals(qc),
  });
}

/** Deletes a saved meal (its items go with it). Logged diary entries are unaffected. */
export function useDeleteSavedMeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const { error } = await supabase.from('saved_meals').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => invalidateSavedMeals(qc),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------------------------------------------

/**
 * Maps food ids to their current (non-archived) version by following `supersedes` links, so a saved meal
 * never logs a stale version of a food that was edited after the meal was saved. Ids without a newer version
 * (or on lookup errors) map to themselves.
 */
async function resolveCurrentFoodIds(ids: readonly string[]): Promise<Map<string, string>> {
  const current = new Map<string, string>(ids.map((id) => [id, id]));
  let pending = new Set(ids);
  for (let depth = 0; depth < 5 && pending.size > 0; depth += 1) {
    const found = await supabase.from('foods').select('id,archived').in('id', Array.from(pending));
    if (found.error) break;
    const archived = ((found.data ?? []) as Row[]).filter((r) => r.archived).map((r) => String(r.id));
    if (archived.length === 0) break;
    const next = await supabase.from('foods').select('id,supersedes').in('supersedes', archived);
    if (next.error) break;
    const successor = new Map(((next.data ?? []) as Row[]).map((r) => [String(r.supersedes), String(r.id)] as const));
    const nextPending = new Set<string>();
    for (const [original, now] of current) {
      const newer = successor.get(now);
      if (newer) {
        current.set(original, newer);
        nextPending.add(newer);
      }
    }
    pending = nextPending;
  }
  return current;
}

export interface LogSavedMealRequest {
  savedMealId: string;
  /** Local YYYY-MM-DD. */
  date: string;
  mealGroupId: string;
}

/**
 * Logs every item of a saved meal as a diary entry (source 'copy') in a meal group. Arguments can be given to
 * the hook, or at `mutate` time (which wins), e.g. when the saved meal is chosen from a list. Resolves with the
 * number of entries added.
 */
export function useLogSavedMeal(savedMealId?: string, target?: { date: string; mealGroupId: string }) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (override: Partial<LogSavedMealRequest> | void): Promise<number> => {
      const o = override ?? {};
      const mealId = o.savedMealId ?? savedMealId;
      const date = o.date ?? target?.date;
      const mealGroupId = o.mealGroupId ?? target?.mealGroupId;
      if (!mealId) throw new Error('Pick a saved meal.');
      if (!date) throw new Error('Pick a date.');
      if (!mealGroupId) throw new Error('Pick a meal to add it to.');

      const userId = await requireUserId();
      const { data, error } = await supabase
        .from('saved_meal_items')
        .select('food_id,grams,sort_order')
        .eq('saved_meal_id', mealId)
        .order('sort_order', { ascending: true });
      if (error) throw error;
      const items = (data ?? []) as Row[];
      if (items.length === 0) return 0;

      const current = await resolveCurrentFoodIds(items.map((i) => String(i.food_id)));
      const rows = items.map((i) => ({
        user_id: userId,
        entry_date: date,
        meal_group_id: mealGroupId,
        food_id: current.get(String(i.food_id)) ?? String(i.food_id),
        grams: toNumber(i.grams) ?? 0,
        source: 'copy' as const,
      }));
      const ins = await supabase.from('diary_entries').insert(rows);
      if (ins.error) throw ins.error;
      return rows.length;
    },
    onSettled: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['day'] }),
        qc.invalidateQueries({ queryKey: keys.recentFoods }),
      ]);
    },
  });
}
