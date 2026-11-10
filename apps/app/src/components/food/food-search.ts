// The rules behind searching foods, as plain functions (no React, no React Native, no expo-router), so they are unit tested in
// tools/ui-smoke (food-search.test.ts). They are shared by the Add food screen (app/search.tsx) and the Foods tab (app/(app)/foods.tsx)
// through `useFoodSearchResults` (use-food-search-results.ts) and the components in FoodSearchResults.tsx, which only draw what these decide.
import type { BarcodeLookupResult, FoodSummary } from '@/data/foods';

import { foldText, trimNumber } from './format';

/** A search needs at least this many characters (the server search is not run for less). */
export const MIN_QUERY_LENGTH = 2;
/** How long the typed text has to stay unchanged before it is sent to the server. */
export const SEARCH_DEBOUNCE_MS = 250;

/** What is sent to the search: the text without the spaces around it. */
export function normalizeQuery(raw: string): string {
  return raw.trim();
}

/** True when a (normalised) query is long enough to search for. */
export function isSearchableQuery(query: string): boolean {
  return query.length >= MIN_QUERY_LENGTH;
}

// ------------------------------------------------------------------------------------------------ local filter

type Named = Pick<FoodSummary, 'name' | 'brand'>;

/** Accent-insensitive "name or brand contains the query" (the Recent / Favorites / My foods tabs filter their lists this way). */
export function matchesQuery(food: Named, query: string): boolean {
  const folded = foldText(normalizeQuery(query));
  if (folded === '') return true;
  return foldText(`${food.name} ${food.brand ?? ''}`).includes(folded);
}

export function filterFoods<T extends Named>(foods: readonly T[], query: string): T[] {
  return foods.filter((food) => matchesQuery(food, query));
}

// ------------------------------------------------------------------------------------------------ the view of a search

/** What the typed text and its debounced copy mean for the screen. */
export interface SearchView {
  /** The debounced, normalised text: what the filters and the "Create custom food" name use. */
  query: string;
  /** What the server search is asked for: `query`, or '' when nothing is to be searched (disabled, or too short). */
  request: string;
  /** The TYPED text is long enough: the results take the place of the library list at once, and the library is back as soon as the text is short again. */
  searching: boolean;
  /** Searching, but the typed text is not the debounced text yet (the answer for what was typed is still to be asked for). */
  settling: boolean;
}

export function searchView(input: { typed: string; debounced: string; enabled?: boolean }): SearchView {
  const enabled = input.enabled ?? true;
  const typed = normalizeQuery(input.typed);
  const query = normalizeQuery(input.debounced);
  const searching = enabled && isSearchableQuery(typed);
  return {
    query,
    request: enabled && isSearchableQuery(query) ? query : '',
    searching,
    settling: searching && typed !== query,
  };
}

/** What the results area shows. */
export type ResultsStatus =
  /** Not searching (the text is too short, or the search is off). */
  | 'idle'
  /** Nothing to show yet: the debounce is running or the server has not answered. */
  | 'loading'
  | 'error'
  | 'empty'
  | 'results';

/** Rows win over everything (the previous answer stays up while the next one loads); then loading, then an error, else "nothing found". */
export function resultsStatus(input: {
  searching: boolean;
  settling: boolean;
  rowCount: number;
  isLoading: boolean;
  error: unknown;
}): ResultsStatus {
  if (!input.searching) return 'idle';
  if (input.rowCount > 0) return 'results';
  if (input.settling || input.isLoading) return 'loading';
  if (input.error) return 'error';
  return 'empty';
}

export function noFoodsFoundText(query: string): string {
  return `No foods found for \u201C${query}\u201D.`;
}

// ------------------------------------------------------------------------------------------------ online search

export type OnlineMutationStatus = 'idle' | 'pending' | 'error' | 'success';

/** What the "Cannot find it?" card says about the last online search. */
export type OnlineOutcome = 'none' | 'error' | 'empty' | 'results';

export interface OnlineView {
  /** The "Cannot find it?" card is shown. */
  visible: boolean;
  outcome: OnlineOutcome;
}

/**
 * The online card is offered under the answer of the local search (not while that is loading, and only when the online lookup is
 * switched on). The outcome of an online search counts only for the text it was asked for: after the text changes the card goes back to
 * its button.
 */
export function onlineView(input: {
  lookupEnabled: boolean;
  searching: boolean;
  settling: boolean;
  searchLoading: boolean;
  /** The debounced, normalised query. */
  query: string;
  /** The text the last online search was asked for (as it was sent), if any. */
  asked: string | undefined;
  status: OnlineMutationStatus;
  resultCount: number;
}): OnlineView {
  const visible = input.lookupEnabled && input.searching && !input.settling && !input.searchLoading;
  const forThisQuery = input.asked !== undefined && normalizeQuery(input.asked) === input.query && isSearchableQuery(input.query);
  let outcome: OnlineOutcome = 'none';
  if (forThisQuery && input.status === 'error') outcome = 'error';
  else if (forThisQuery && input.status === 'success') outcome = input.resultCount === 0 ? 'empty' : 'results';
  return { visible, outcome };
}

/** What happens after tapping an online result: its food was found (or imported) and opens, or the reason it did not. */
export type OnlineImportStep = { kind: 'open'; foodId: string } | { kind: 'error'; message: string };

export function onlineImportStep(res: BarcodeLookupResult): OnlineImportStep {
  if (res.status === 'found') return { kind: 'open', foodId: res.foodId };
  if (res.status === 'rateLimited') return { kind: 'error', message: 'Too many lookups right now. Wait a moment and try again.' };
  if (res.status === 'unavailable') return { kind: 'error', message: res.message };
  return { kind: 'error', message: 'Could not load that product. Try another result or create a custom food.' };
}

// ------------------------------------------------------------------------------------------------ quick add feedback

export const NO_MEAL_MESSAGE = 'Pick a meal first. No meal group is available yet.';

/** The toast after a quick add: "Added 1 serving of Banana to Snacks · Today". */
export function quickAddMessage(input: { amount: number; label: string; name: string; mealName: string | undefined; day: string }): string {
  return `Added ${trimNumber(input.amount)} ${input.label} of ${input.name} to ${input.mealName ?? 'diary'} \u00B7 ${input.day}`;
}

/** The line above the results of the Foods tab: where the "+" on a row adds to. */
export function quickAddCaption(mealName: string | undefined, day: string): string {
  return `Quick add goes to ${mealName ?? 'your diary'} \u00B7 ${day}`;
}

// ------------------------------------------------------------------------------------------------ keyboard

/** Escape empties a search field that has text in it (a hardware keyboard on the web or a tablet). */
export function clearsOnKey(key: string, value: string): boolean {
  return key === 'Escape' && value.length > 0;
}
