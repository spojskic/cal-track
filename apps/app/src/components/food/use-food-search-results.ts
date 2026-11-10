import { useCallback } from 'react';

import { ONLINE_LOOKUP_ENABLED } from '@/lib/features';
import { useFoodSearch, useOnlineSearch, type FoodSummary, type OnlineSearchResult } from '@/data/foods';

import {
  SEARCH_DEBOUNCE_MS,
  onlineView,
  resultsStatus,
  searchView,
  type OnlineOutcome,
  type ResultsStatus,
} from './food-search';
import { useDebouncedValue } from './use-debounced-value';

/** The "Cannot find it?" part of a search: the online lookup (Open Food Facts) that only runs when the person asks for it. */
export interface OnlineSearchModel {
  /** The card is shown (the online lookup is on and the local answer is in). */
  visible: boolean;
  outcome: OnlineOutcome;
  pending: boolean;
  /** The message when the last online search failed (shown when `outcome` is 'error'). */
  errorMessage: string | null;
  results: OnlineSearchResult[];
  /** Searches online for the current query. */
  search: () => void;
}

export interface FoodSearchResultsModel {
  /** The debounced, trimmed text. */
  query: string;
  /** The typed text is long enough: show the results instead of the library. */
  searching: boolean;
  status: ResultsStatus;
  foods: FoodSummary[];
  error: unknown;
  /** The server is being asked right now (the field shows a spinner). */
  fetching: boolean;
  refetch: () => Promise<unknown>;
  online: OnlineSearchModel;
}

/**
 * Searching foods as people type: debounces the text, asks the server (`useFoodSearch`, accent-insensitive and typo tolerant), and
 * works out what the results area shows (searching, nothing found, an error, the rows) and whether the online fallback is offered.
 * Used by the Add food screen and the Foods tab; draw the result with `FoodSearchResults` (or its parts).
 *
 * `enabled: false` turns the search off (the Add food screen only searches on its "All" tab).
 */
export function useFoodSearchResults(typed: string, options: { enabled?: boolean } = {}): FoodSearchResultsModel {
  const debounced = useDebouncedValue(typed, SEARCH_DEBOUNCE_MS);
  const view = searchView({ typed, debounced, enabled: options.enabled ?? true });
  const search = useFoodSearch(view.request);
  const onlineSearch = useOnlineSearch();

  // `useFoodSearch` keeps the previous answer while the next one loads; with nothing to ask for, that answer is not for this text.
  const foods = view.request === '' ? EMPTY : (search.data ?? EMPTY);
  const status = resultsStatus({
    searching: view.searching,
    settling: view.settling,
    rowCount: foods.length,
    isLoading: search.isLoading,
    error: search.error,
  });

  const online = onlineView({
    lookupEnabled: ONLINE_LOOKUP_ENABLED,
    searching: view.searching,
    settling: view.settling,
    searchLoading: search.isLoading,
    query: view.query,
    asked: onlineSearch.variables?.query,
    status: onlineSearch.status,
    resultCount: onlineSearch.data?.length ?? 0,
  });

  const { mutate } = onlineSearch;
  const query = view.query;
  const searchOnline = useCallback(() => mutate({ query }), [mutate, query]);
  // A disabled query would still run when refetched: with nothing to ask for there is nothing to refresh.
  const { refetch: refetchSearch } = search;
  const request = view.request;
  const refetch = useCallback(() => (request === '' ? Promise.resolve() : refetchSearch()), [request, refetchSearch]);

  return {
    query,
    searching: view.searching,
    status,
    foods,
    error: search.error,
    fetching: view.searching && search.isFetching,
    refetch,
    online: {
      visible: online.visible,
      outcome: online.outcome,
      pending: onlineSearch.isPending,
      errorMessage: onlineSearch.error ? onlineSearch.error.message : null,
      results: onlineSearch.data ?? EMPTY_ONLINE,
      search: searchOnline,
    },
  };
}

const EMPTY: FoodSummary[] = [];
const EMPTY_ONLINE: OnlineSearchResult[] = [];
