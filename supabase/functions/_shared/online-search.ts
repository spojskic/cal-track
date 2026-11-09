/**
 * online-search orchestration (pure: all I/O is injected).
 *
 * Searches USDA FDC (Branded) and Open Food Facts in parallel and returns a
 * merged, de-duplicated (by GTIN-14) list of SUMMARIES. Nothing is saved:
 * when the user picks a result the app calls `barcode-lookup` with its gtin.
 */
import { FDC_SEARCH_URL, DEFAULT_OFF_USER_AGENT, type BarcodeEnv } from './barcode-lookup.ts';
import { fdcSearchItems, mapFdcBranded } from './fdc-branded.ts';
import { buildFoodRow, type FoodSource, type MapResult } from './food-row.ts';
import {
  apiError,
  asRecord,
  fetchUpstreamJson,
  ok,
  rateLimited,
  type ApiResult,
  type FetchLike,
} from './http.ts';
import { mapOffProduct } from './off-product.ts';
import { GLOBAL_RATE_LIMIT_USER, type ConsumeRateLimit } from './rate-limit.ts';

export const OFF_SEARCH_URL = 'https://world.openfoodfacts.org/cgi/search.pl';
export const OFF_SEARCH_FIELDS = 'code,product_name,brands,nutriments,serving_size';

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 20;
export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 100;

export const SEARCH_BUCKET = 'online-search';
export const GLOBAL_SEARCH_BUCKET = 'online-search-global';

export interface SearchLimits {
  /** Searches per user per window (default 5 per 60 s). */
  perUser: number;
  /** Searches over all users per window (default 8 per 60 s; OFF allows ~10 search requests/min per IP). */
  global: number;
  windowSeconds: number;
}

export const DEFAULT_SEARCH_LIMITS: SearchLimits = { perUser: 5, global: 8, windowSeconds: 60 };

export interface OnlineSearchDeps {
  fetch: FetchLike;
  env: BarcodeEnv;
  /** Verified id of the calling user. */
  userId: string;
  consumeRateLimit: ConsumeRateLimit;
  limits?: SearchLimits;
  timeoutMs?: number;
  log?: (message: string, detail?: unknown) => void;
}

export interface SearchSummary {
  gtin14: string;
  name: string;
  brand: string | null;
  source: FoodSource;
  kcal100g: number | null;
  protein100g: number | null;
  carbs100g: number | null;
  fat100g: number | null;
  completeness: number;
}

export type SourceStatus = 'ok' | 'skipped' | 'rate_limited' | 'error';

interface SourceResult {
  status: SourceStatus;
  items: SearchSummary[];
  retryAfterSeconds?: number;
}

/** MappedProduct -> summary; null when it has no barcode or no usable nutrition. */
export function summarize(mapped: MapResult): SearchSummary | null {
  if (!mapped.ok || !mapped.product.gtin14) return null;
  const built = buildFoodRow(mapped.product);
  if (!built) return null;
  const n = built.food.nutrients;
  return {
    gtin14: mapped.product.gtin14,
    name: built.food.name,
    brand: built.food.brand,
    source: mapped.product.source,
    kcal100g: n.ENERGY_KCAL ?? null,
    protein100g: n.PROTEIN_G ?? null,
    carbs100g: n.CARBS_G ?? null,
    fat100g: n.FAT_G ?? null,
    completeness: built.food.completeness,
  };
}

/**
 * Interleaves the lists (so every source is visible near the top), drops
 * duplicates by GTIN-14 (keeping the more complete record; ties keep the
 * earlier list) and caps the result.
 */
export function mergeResults(lists: SearchSummary[][], limit: number): SearchSummary[] {
  const out: SearchSummary[] = [];
  const position = new Map<string, number>();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const item = list[i];
      if (!item) continue;
      const at = position.get(item.gtin14);
      if (at === undefined) {
        position.set(item.gtin14, out.length);
        out.push(item);
      } else if (item.completeness > out[at]!.completeness) {
        out[at] = item;
      }
    }
  }
  return out.slice(0, limit);
}

async function searchFdc(
  query: string,
  limit: number,
  deps: OnlineSearchDeps,
): Promise<SourceResult> {
  const key = deps.env.FDC_API_KEY;
  if (!key) return { status: 'skipped', items: [] };
  const url =
    `${FDC_SEARCH_URL}?query=${encodeURIComponent(query)}&dataType=Branded` +
    `&pageSize=${limit}&api_key=${encodeURIComponent(key)}`;
  const res = await fetchUpstreamJson(
    deps.fetch,
    url,
    { headers: { Accept: 'application/json' } },
    deps.timeoutMs,
  );
  if (res.kind === 'rate_limited')
    return { status: 'rate_limited', items: [], retryAfterSeconds: res.retryAfterSeconds };
  if (res.kind === 'error') {
    deps.log?.('fdc search failed', res.reason);
    return { status: 'error', items: [] };
  }
  if (res.kind === 'not_found') return { status: 'ok', items: [] };
  const items: SearchSummary[] = [];
  for (const item of fdcSearchItems(res.json)) {
    const summary = summarize(mapFdcBranded(item));
    if (summary) items.push(summary);
  }
  return { status: 'ok', items };
}

async function searchOff(
  query: string,
  limit: number,
  deps: OnlineSearchDeps,
): Promise<SourceResult> {
  const url =
    `${OFF_SEARCH_URL}?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1` +
    `&page_size=${limit}&fields=${OFF_SEARCH_FIELDS}`;
  const res = await fetchUpstreamJson(
    deps.fetch,
    url,
    {
      headers: {
        'User-Agent': deps.env.OFF_USER_AGENT?.trim() || DEFAULT_OFF_USER_AGENT,
        Accept: 'application/json',
      },
    },
    deps.timeoutMs,
  );
  if (res.kind === 'rate_limited')
    return { status: 'rate_limited', items: [], retryAfterSeconds: res.retryAfterSeconds };
  if (res.kind === 'error') {
    deps.log?.('off search failed', res.reason);
    return { status: 'error', items: [] };
  }
  if (res.kind === 'not_found') return { status: 'ok', items: [] };
  const products = asRecord(res.json)?.products;
  const items: SearchSummary[] = [];
  if (Array.isArray(products)) {
    for (const product of products) {
      const summary = summarize(mapOffProduct(product));
      if (summary) items.push(summary);
    }
  }
  return { status: 'ok', items };
}

function parseRequest(body: unknown): { query: string; limit: number } | ApiResult {
  const rec = asRecord(body);
  if (!rec || typeof rec.query !== 'string') {
    return apiError(400, 'invalid_request', 'Body must be { "query": string, "limit"?: number }.');
  }
  const query = rec.query.replace(/\s+/g, ' ').trim();
  if (query.length < MIN_QUERY_LENGTH || query.length > MAX_QUERY_LENGTH) {
    return apiError(
      400,
      'invalid_query',
      `query must be ${MIN_QUERY_LENGTH}-${MAX_QUERY_LENGTH} characters long.`,
    );
  }
  let limit = DEFAULT_LIMIT;
  if (rec.limit !== undefined && rec.limit !== null) {
    if (typeof rec.limit !== 'number' || !Number.isFinite(rec.limit) || rec.limit < 1) {
      return apiError(400, 'invalid_request', `limit must be a number between 1 and ${MAX_LIMIT}.`);
    }
    limit = Math.min(MAX_LIMIT, Math.floor(rec.limit));
  }
  return { query, limit };
}

/** POST { query, limit? } handler. */
export async function onlineSearch(body: unknown, deps: OnlineSearchDeps): Promise<ApiResult> {
  const parsed = parseRequest(body);
  if ('status' in parsed) return parsed;
  const { query, limit } = parsed;

  // Throttle before touching OFF/FDC: first the caller's own budget, then the shared one.
  const limits = deps.limits ?? DEFAULT_SEARCH_LIMITS;
  const userWait = await deps.consumeRateLimit(
    deps.userId,
    SEARCH_BUCKET,
    limits.perUser,
    limits.windowSeconds,
  );
  if (userWait > 0)
    return rateLimited(userWait, { scope: 'user' }, 'Too many searches. Please wait a moment.');
  const globalWait = await deps.consumeRateLimit(
    GLOBAL_RATE_LIMIT_USER,
    GLOBAL_SEARCH_BUCKET,
    limits.global,
    limits.windowSeconds,
  );
  if (globalWait > 0) {
    return rateLimited(
      globalWait,
      { scope: 'global' },
      'Online search is busy. Please try again in a moment.',
    );
  }

  const [fdc, off] = await Promise.all([
    searchFdc(query, limit, deps),
    searchOff(query, limit, deps),
  ]);

  const failed = (r: SourceResult) => r.status === 'rate_limited' || r.status === 'error';
  const usable = [fdc, off].filter((r) => r.status === 'ok');
  if (usable.length === 0 && [fdc, off].some(failed)) {
    const waits = [fdc, off].flatMap((r) =>
      r.status === 'rate_limited' ? [r.retryAfterSeconds ?? 60] : [],
    );
    if (waits.length > 0) {
      return rateLimited(
        Math.max(...waits),
        {},
        'The food databases are rate limiting requests. Please try again shortly.',
      );
    }
    return apiError(
      502,
      'upstream_error',
      'The food databases are unavailable right now. Please try again.',
    );
  }

  const warnings: Array<{ source: FoodSource; error: 'rate_limited' | 'upstream_error' }> = [];
  if (fdc.status === 'rate_limited' || fdc.status === 'error') {
    warnings.push({
      source: 'fdc_branded',
      error: fdc.status === 'rate_limited' ? 'rate_limited' : 'upstream_error',
    });
  }
  if (off.status === 'rate_limited' || off.status === 'error') {
    warnings.push({
      source: 'off',
      error: off.status === 'rate_limited' ? 'rate_limited' : 'upstream_error',
    });
  }

  return ok({
    query,
    results: mergeResults([fdc.items, off.items], limit),
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}
