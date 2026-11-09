/**
 * Glue between the app's food rows (search_foods RPC summaries) and the matcher's `FoodCandidate`.
 *
 * `DEFAULT_SOURCE_WEIGHTS` in pipeline.ts is keyed by short source names ('usda', 'user', 'ai', ...) while
 * the database uses 'fdc_foundation', 'custom', 'ai_estimate', ... Without this mapping every database
 * source would silently fall back to the default weight.
 */

import type { FoodCandidate } from './schemas';

/** The subset of the app's `FoodSummary` the matcher needs. */
export interface FoodRowLike {
  id: string;
  name: string;
  brand?: string | null;
  /** 'generic' | 'branded' | 'custom' | 'recipe' | 'ai_estimate' */
  kind: string;
  /** database `foods.source` */
  source: string;
  kcal100g: number | null;
  completeness: number | null;
  usageCount?: number;
}

/** Maps a database source to the key used by the matcher's source weights. */
export function matchSourceFor(source: string): string {
  if (source.startsWith('fdc_')) return 'usda';
  if (source === 'custom' || source === 'recipe') return 'user';
  if (source === 'ai_estimate') return 'ai';
  return source; // cnf | cofid | off | unknown
}

/** Kinds only the signed-in user can create (global rows are 'generic' / 'branded'). */
const USER_OWNED_KINDS = new Set(['custom', 'recipe']);

export function toFoodCandidate(row: FoodRowLike): FoodCandidate {
  const completeness = Number.isFinite(row.completeness ?? NaN) ? (row.completeness as number) : 0;
  const candidate: FoodCandidate = {
    id: row.id,
    name: row.name,
    kind: row.kind,
    source: matchSourceFor(row.source),
    kcal100g: Number.isFinite(row.kcal100g ?? NaN) ? (row.kcal100g as number) : 0,
    completeness: Math.min(1, Math.max(0, completeness)),
    // AI estimates are user rows too, but they must not get the "my food" boost over real database foods.
    isUserFood: USER_OWNED_KINDS.has(row.kind),
  };
  if (row.brand) candidate.brand = row.brand;
  if (row.usageCount !== undefined) candidate.usageCount = row.usageCount;
  return candidate;
}
