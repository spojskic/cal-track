/**
 * barcode-lookup orchestration (pure: all I/O is injected).
 *
 *   local DB (user-scoped, RLS)  ->  USDA FDC Branded  ->  Open Food Facts
 *
 * The first source with a usable product wins; remote products are saved with
 * the service role (global branded food) so the next lookup is a local hit.
 */
import { buildFoodRow, type BuiltFood, type MapResult } from './food-row.ts';
import type { StoredFood, UpsertResult } from './food-store.ts';
import { mapFdcBranded, selectFdcMatches } from './fdc-branded.ts';
import { fdcQueryCode, normalizeGtin, offProductCode, toGtin14 } from './gtin.ts';
import {
  apiError,
  asRecord,
  fetchUpstreamJson,
  ok,
  rateLimited,
  type ApiResult,
  type FetchLike,
} from './http.ts';
import { mapOffProduct, offProductFromResponse } from './off-product.ts';

export const FDC_SEARCH_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search';
export const OFF_PRODUCT_URL = 'https://world.openfoodfacts.org/api/v2/product';
export const OFF_PRODUCT_FIELDS =
  'code,product_name,brands,nutriments,serving_size,serving_quantity,serving_quantity_unit,countries_tags,categories_tags_en,nutrition_data_per';
export const DEFAULT_OFF_USER_AGENT = 'cal-track/0.1 (contact not configured)';

export interface BarcodeEnv {
  FDC_API_KEY?: string;
  OFF_USER_AGENT?: string;
}

export interface BarcodeLookupDeps {
  fetch: FetchLike;
  /** Best food visible to the signed-in user for this GTIN-14, with portions (RLS applies). */
  localLookup: (gtin14: string) => Promise<StoredFood | null>;
  /** Saves a global branded food (service role) and returns the stored row + portions. */
  upsertFood: (built: BuiltFood) => Promise<UpsertResult>;
  env: BarcodeEnv;
  /** Per upstream request timeout (default 8000 ms). */
  timeoutMs?: number;
  log?: (message: string, detail?: unknown) => void;
}

type MappedOk = Extract<MapResult, { ok: true }>;

export type LookupSource = 'local' | 'fdc_branded' | 'off';

type RemoteResult =
  | { kind: 'found'; mapped: MappedOk }
  | { kind: 'miss' }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'error'; reason: string };

/** FDC: search by barcode and accept only hits whose gtinUpc is this GTIN-14. */
async function lookupFdc(gtin14: string, deps: BarcodeLookupDeps): Promise<RemoteResult> {
  const key = deps.env.FDC_API_KEY;
  if (!key) return { kind: 'miss' }; // not configured: behave as if FDC had nothing
  const url =
    `${FDC_SEARCH_URL}?query=${encodeURIComponent(fdcQueryCode(gtin14))}` +
    `&dataType=Branded&pageSize=5&api_key=${encodeURIComponent(key)}`;
  const res = await fetchUpstreamJson(
    deps.fetch,
    url,
    { headers: { Accept: 'application/json' } },
    deps.timeoutMs,
  );
  if (res.kind === 'rate_limited') return res;
  if (res.kind === 'error') return { kind: 'error', reason: res.reason };
  if (res.kind === 'not_found') return { kind: 'miss' };
  for (const item of selectFdcMatches(res.json, gtin14)) {
    const mapped = mapFdcBranded(item);
    if (mapped.ok) return { kind: 'found', mapped };
    deps.log?.('fdc item skipped', mapped.reason);
  }
  return { kind: 'miss' };
}

/** OFF: exactly one product request. */
async function lookupOff(gtin14: string, deps: BarcodeLookupDeps): Promise<RemoteResult> {
  const code = offProductCode(gtin14);
  const url = `${OFF_PRODUCT_URL}/${code}.json?fields=${OFF_PRODUCT_FIELDS}`;
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
  if (res.kind === 'rate_limited') return res;
  if (res.kind === 'error') return { kind: 'error', reason: res.reason };
  if (res.kind === 'not_found') return { kind: 'miss' };
  const parsed = offProductFromResponse(res.json);
  if (!parsed) return { kind: 'miss' };
  // OFF may answer for a different code than requested: never save a product under another barcode.
  const returned = toGtin14(parsed.product.code ?? parsed.code ?? code);
  if (returned !== gtin14) {
    deps.log?.('off code mismatch', { requested: gtin14, returned });
    return { kind: 'miss' };
  }
  const mapped = mapOffProduct(parsed.product, { fallbackCode: parsed.code ?? code });
  if (!mapped.ok) {
    deps.log?.('off product skipped', mapped.reason);
    return { kind: 'miss' };
  }
  return { kind: 'found', mapped };
}

async function saveAndRespond(
  mapped: MappedOk,
  deps: BarcodeLookupDeps,
  warning: string | undefined,
): Promise<ApiResult> {
  const built = buildFoodRow(mapped.product);
  if (!built) return apiError(422, 'unusable_product', 'The product has no usable nutrition data.');
  let stored: UpsertResult;
  try {
    stored = await deps.upsertFood(built);
  } catch (err) {
    deps.log?.('upsert failed', err);
    return apiError(
      500,
      'save_failed',
      'The product was found but could not be saved. Please retry.',
    );
  }
  return ok({
    food: stored.food,
    portions: stored.portions,
    source: built.food.source,
    ...(warning ? { warning } : {}),
  });
}

/** POST { gtin } handler. Never throws for expected failures; unexpected ones propagate to handleHttp (500). */
export async function barcodeLookup(body: unknown, deps: BarcodeLookupDeps): Promise<ApiResult> {
  const gtin = normalizeGtin(asRecord(body)?.gtin);
  if (!gtin.ok) return apiError(400, 'invalid_gtin', gtin.message);
  const warning = gtin.warning;
  const gtin14 = gtin.gtin14;

  // (a) local DB
  const local = await deps.localLookup(gtin14);
  if (local) {
    return ok({
      food: local.food,
      portions: local.portions,
      source: 'local' satisfies LookupSource,
      ...(warning ? { warning } : {}),
    });
  }

  // (b) FDC
  const fdc = await lookupFdc(gtin14, deps);
  if (fdc.kind === 'found') return saveAndRespond(fdc.mapped, deps, warning);

  // (c) Open Food Facts (one request)
  const off = await lookupOff(gtin14, deps);
  if (off.kind === 'found') return saveAndRespond(off.mapped, deps, warning);
  if (off.kind === 'rate_limited') {
    return rateLimited(
      off.retryAfterSeconds,
      { upstream: 'off' },
      'Open Food Facts is rate limiting requests. Please try again shortly.',
    );
  }
  if (off.kind === 'error') {
    deps.log?.('off lookup failed', off.reason);
    return apiError(
      502,
      'upstream_error',
      'Open Food Facts is unavailable right now. Please try again.',
      {
        upstream: 'off',
      },
    );
  }

  // Both missed. If FDC could not answer, we cannot claim the barcode is unknown.
  if (fdc.kind === 'rate_limited') {
    return rateLimited(
      fdc.retryAfterSeconds,
      { upstream: 'fdc' },
      'The USDA database is rate limiting requests. Please try again later.',
    );
  }
  if (fdc.kind === 'error') {
    deps.log?.('fdc lookup failed', fdc.reason);
    return apiError(
      502,
      'upstream_error',
      'The USDA database is unavailable right now. Please try again.',
      {
        upstream: 'fdc',
      },
    );
  }

  return apiError(404, 'not_found', 'No product found for this barcode.', {
    gtin14,
    ...(warning ? { warning } : {}),
  });
}
