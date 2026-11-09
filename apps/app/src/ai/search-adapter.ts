import { toFoodCandidate, type FoodCandidate, type MatchDeps } from '@cal/ai';

import { toFoodSource, type FoodKind, type FoodSummary } from '@/data/foods';
import { supabase } from '@/lib/supabase';

/**
 * Adapter between @cal/ai `matchItems` and the app's database search (the same `search_foods` RPC the
 * search screen uses: accent-insensitive, typo tolerant, personal foods first). It remembers the full
 * summary rows (kcal + macros per 100 g) so the review screen can compute live numbers without extra queries.
 */

const CACHE_LIMIT = 3000;
const summaries = new Map<string, FoodSummary>();

function remember(list: FoodSummary[]): void {
  for (const f of list) {
    summaries.delete(f.id); // refresh insertion order
    summaries.set(f.id, f);
  }
  while (summaries.size > CACHE_LIMIT) {
    const oldest = summaries.keys().next().value;
    if (oldest === undefined) break;
    summaries.delete(oldest);
  }
}

/** The summary row for a food id seen by a previous search (null if evicted / unknown). */
export function cachedSummary(id: string): FoodSummary | null {
  return summaries.get(id) ?? null;
}

export function rememberSummaries(list: FoodSummary[]): void {
  remember(list);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function rowToSummary(row: any): FoodSummary {
  return {
    id: String(row.id),
    name: String(row.name),
    brand: row.brand ?? null,
    kind: row.kind as FoodKind,
    source: toFoodSource(row.source, 'custom'),
    kcal100g: num(row.kcal_100g),
    protein100g: num(row.protein_100g),
    carbs100g: num(row.carbs_100g),
    fat100g: num(row.fat_100g),
    completeness: num(row.completeness),
  };
}

/** One RPC call. Resolves to [] for a blank query. */
export async function searchFoodSummaries(query: string, limit = 15): Promise<FoodSummary[]> {
  const q = query.trim();
  if (q.length === 0) return [];
  const { data, error } = await supabase.rpc('search_foods', { q, max_results: limit });
  if (error) throw error;
  const list = ((data ?? []) as any[]).map(rowToSummary);
  remember(list);
  return list;
}

/** Candidates for the matcher (database sources mapped to the matcher's weight keys). */
export const foodMatchDeps: MatchDeps = {
  async searchFoods(query: string): Promise<FoodCandidate[]> {
    const list = await searchFoodSummaries(query);
    return list.map(toFoodCandidate);
  },
};
