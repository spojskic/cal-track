import {
  cleanNutrients,
  type FoodSummary,
} from '@/data/foods';
import {
  parseNumber,
  scaleNutrients,
  sumNutrientsDetailed,
  type NutrientMap,
} from '@ration/core';
import type { MatchedItem, NutrientEstimate, ParsedMealItem } from '@ration/ai';

import { cachedSummary } from '@/ai/search-adapter';

/**
 * Editable review state shared by the meal review (photo / describe) and the AI recipe screen.
 * The AI only identified the food and estimated grams; nutrients come from the food database
 * (`choice.kind === 'food'`) unless nothing matched, in which case the LLM estimate is used and
 * flagged `choice.kind === 'estimate'` (saved as an `ai_estimate` food, never presented as verified).
 */

export type ItemChoice =
  | { kind: 'food'; food: FoodSummary }
  | { kind: 'estimate' }
  | { kind: 'none' };

export interface ReviewItem {
  key: string;
  /** Short name as identified by the AI. */
  name: string;
  /** The phrase as the user wrote it (describe flow). */
  originalText?: string;
  preparation?: string;
  /** Editable amount in grams (text so users can type "1." or ""). */
  gramsText: string;
  gramsLow?: number;
  gramsHigh?: number;
  /** 0..1, or null for foods the user added by hand. */
  confidence: number | null;
  choice: ItemChoice;
  /** Other database foods the matcher considered, for quick swapping. */
  alternatives: FoodSummary[];
  /** LLM nutrient estimate for an unmatched food (per 100 g), when one was obtained. */
  estimate: NutrientEstimate | null;
  /** Set once the entry was written to the diary, so a retry never duplicates it. */
  added?: boolean;
}

let seq = 0;
export function nextKey(): string {
  seq += 1;
  return `review-${seq}`;
}

export function formatGrams(n: number): string {
  return String(Number(n.toFixed(1)));
}

export function itemGrams(item: Pick<ReviewItem, 'gramsText'>): number {
  const n = parseNumber(item.gramsText);
  return n !== null && Number.isFinite(n) && n > 0 ? n : 0;
}

/** Per-100 g macros known from a search row (unknown stays absent, never 0). */
export function summaryNutrients(food: FoodSummary): NutrientMap {
  const out: NutrientMap = {};
  if (food.kcal100g !== null) out.ENERGY_KCAL = food.kcal100g;
  if (food.protein100g !== null) out.PROTEIN_G = food.protein100g;
  if (food.carbs100g !== null) out.CARBS_G = food.carbs100g;
  if (food.fat100g !== null) out.FAT_G = food.fat100g;
  return out;
}

/** Per-100 g nutrients behind the current choice, or null when nothing is chosen. */
export function itemPer100(item: ReviewItem): NutrientMap | null {
  if (item.choice.kind === 'food') return summaryNutrients(item.choice.food);
  if (item.choice.kind === 'estimate' && item.estimate) return cleanNutrients(item.estimate.per100g);
  return null;
}

export function itemNutrients(item: ReviewItem): NutrientMap | null {
  const per100 = itemPer100(item);
  if (!per100) return null;
  return scaleNutrients(per100, itemGrams(item));
}

export interface ReviewTotals {
  totals: NutrientMap;
  /** Items without usable numbers: the totals are a lower bound. */
  incomplete: boolean;
}

export function sumReviewItems(items: readonly ReviewItem[]): ReviewTotals {
  const maps: NutrientMap[] = [];
  let incomplete = false;
  for (const item of items) {
    const n = itemNutrients(item);
    if (n) maps.push(n);
    else incomplete = true;
  }
  const { totals, incompleteNutrients } = sumNutrientsDetailed(maps);
  return { totals, incomplete: incomplete || incompleteNutrients.includes('ENERGY_KCAL') };
}

/** True when the nutrition behind this item is (or was) an AI estimate. */
export function isAiEstimateItem(item: ReviewItem): boolean {
  if (item.choice.kind === 'estimate') return true;
  return item.choice.kind === 'food' && item.choice.food.source === 'ai_estimate';
}

/** Item can be saved: a food (or estimate) is chosen and the amount is a positive number. */
export function isItemReady(item: ReviewItem): boolean {
  if (item.choice.kind === 'none') return false;
  if (item.choice.kind === 'estimate' && !item.estimate) return false;
  return itemGrams(item) > 0;
}

/** Why an item is not ready (for the inline hint), or null. */
export function itemProblem(item: ReviewItem): string | null {
  if (item.choice.kind === 'none') return 'No match in the food database. Choose a food or remove this item.';
  if (itemGrams(item) <= 0) return 'Enter an amount in grams.';
  return null;
}

/** The ai_confidence to store: the AI's confidence, capped by the estimate's own confidence. */
export function itemStoredConfidence(item: ReviewItem): number | undefined {
  if (item.confidence === null) return undefined;
  let c = item.confidence;
  if (item.choice.kind === 'estimate' && item.estimate) c = Math.min(c, item.estimate.confidence);
  return Math.min(1, Math.max(0, c));
}

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export function confidenceLevel(c: number): ConfidenceLevel {
  return c >= 0.75 ? 'high' : c >= 0.5 ? 'medium' : 'low';
}

/** A manually added food (from search) with a default amount. */
export function manualItem(food: FoodSummary, grams = 100): ReviewItem {
  return {
    key: nextKey(),
    name: food.name,
    gramsText: formatGrams(grams),
    confidence: null,
    choice: { kind: 'food', food },
    alternatives: [],
    estimate: null,
  };
}

/**
 * Builds review items from the matcher output and the (optional) LLM estimates. `estimates` is aligned
 * 1:1 with `matched`; entries are null when no estimate was requested or the model gave nothing usable.
 */
export function buildReviewItems(
  matched: readonly MatchedItem[],
  estimates: readonly (NutrientEstimate | null)[],
): ReviewItem[] {
  return matched.map((m, i): ReviewItem => {
    const item: ParsedMealItem = m.item;
    const best = m.best ? cachedSummary(m.best.id) : null;
    const estimate = estimates[i] ?? null;
    const alternatives = m.alternatives
      .map((a) => cachedSummary(a.id))
      .filter((f): f is FoodSummary => f !== null && f.id !== best?.id);
    const choice: ItemChoice = best
      ? { kind: 'food', food: best }
      : estimate
        ? { kind: 'estimate' }
        : { kind: 'none' };
    return {
      key: nextKey(),
      name: item.name,
      originalText: item.originalText,
      preparation: item.preparation,
      gramsText: formatGrams(item.grams),
      gramsLow: item.gramsLow,
      gramsHigh: item.gramsHigh,
      confidence: item.confidence,
      choice,
      alternatives,
      estimate: best ? null : estimate,
    };
  });
}

/** Name for a newly created ai_estimate food: the user's own wording if there is one. */
export function estimateFoodName(item: ReviewItem): string {
  const raw = (item.originalText?.trim() || item.name).replace(/\s+/g, ' ');
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** Summary row for a freshly created ai_estimate food, so a retry reuses it instead of creating another. */
export function summaryForNewEstimate(id: string, item: ReviewItem): FoodSummary {
  const per100g = item.estimate?.per100g ?? {};
  return {
    id,
    name: estimateFoodName(item),
    brand: null,
    kind: 'ai_estimate',
    source: 'ai_estimate',
    kcal100g: per100g.ENERGY_KCAL ?? null,
    protein100g: per100g.PROTEIN_G ?? null,
    carbs100g: per100g.CARBS_G ?? null,
    fat100g: per100g.FAT_G ?? null,
    completeness: null,
  };
}
