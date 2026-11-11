// OWNER: foods agent. Food search, detail, favorites, custom foods, barcode + online lookup.
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  COMPUTED_NUTRIENT_CODES,
  completeness as computeCompleteness,
  estimateEnergyKcal,
  isNutrientCode,
  parseNumber,
  type CarbBasis,
  type NutrientMap,
} from '@ration/core';

import { requireUserId } from '@/lib/auth-user';
import { ONLINE_LOOKUP_ENABLED } from '@/lib/features';
import { supabase } from '@/lib/supabase';
import { isUuid } from '@/lib/uuid';

import { useAddDiaryEntry } from './diary-write';
import { keys } from './keys';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FoodSource =
  | 'fdc_foundation'
  | 'fdc_sr_legacy'
  | 'fdc_fndds'
  | 'fdc_branded'
  | 'cnf'
  | 'cofid'
  | 'off'
  | 'custom'
  | 'recipe'
  | 'ai_estimate';

export type FoodKind = 'generic' | 'branded' | 'custom' | 'recipe' | 'ai_estimate';

const FOOD_SOURCES: readonly FoodSource[] = [
  'fdc_foundation',
  'fdc_sr_legacy',
  'fdc_fndds',
  'fdc_branded',
  'cnf',
  'cofid',
  'off',
  'custom',
  'recipe',
  'ai_estimate',
];

export function toFoodSource(value: unknown, fallback: FoodSource = 'off'): FoodSource {
  return FOOD_SOURCES.includes(value as FoodSource) ? (value as FoodSource) : fallback;
}

/** Compact food row used by search results and the recent / favorite / my-foods lists. Per 100 g. */
export interface FoodSummary {
  id: string;
  name: string;
  brand: string | null;
  kind: FoodKind;
  source: FoodSource;
  /** null = unknown (never 0 for missing data). */
  kcal100g: number | null;
  protein100g: number | null;
  carbs100g: number | null;
  fat100g: number | null;
  /** 0..1 fraction of catalog nutrients with a known value. */
  completeness: number | null;
}

export type RecentFood = FoodSummary & { lastUsedAt: string; useCount: number };

/** Full food row (per-100 g nutrient map). */
export interface Food {
  id: string;
  source: FoodSource;
  sourceId: string | null;
  kind: FoodKind;
  /** null = global food. */
  ownerId: string | null;
  name: string;
  brand: string | null;
  gtin14: string | null;
  category: string | null;
  nutrients: NutrientMap;
  carbBasis: CarbBasis;
  densityGPerMl: number | null;
  version: number;
  archived: boolean;
}

/**
 * A serving size of a food. DB convention (food_portions): `grams` is the mass of `amount` units
 * of `unit` (amount NULL = the label itself is one unit). `gramsPerUnit` is therefore
 * `grams / (amount ?? 1)` and is what the app uses ({@link PortionUnit} of @ration/core).
 */
export interface FoodPortion {
  id: string;
  /** Row label, e.g. "1 cup, chopped". */
  label: string;
  /** Label without the leading amount ("cup, chopped"); use it next to an amount field. */
  unitLabel: string;
  amount: number | null;
  unit: string | null;
  /** Grams of `amount` units, as stored. */
  rowGrams: number;
  /** Grams of ONE unit (`unitLabel`). */
  gramsPerUnit: number;
  /** Amount to prefill when this portion is chosen (`amount ?? 1`). */
  defaultAmount: number;
  sortOrder: number;
}

export interface FoodDetail {
  food: Food;
  portions: FoodPortion[];
  /** Computed from the nutrient map (0..1). */
  completeness: number;
  /** For archived foods: the newer version that replaced it, if any. */
  supersededById: string | null;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Keeps only known catalog codes with finite numeric values. */
export function cleanNutrients(raw: unknown): NutrientMap {
  const out: NutrientMap = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isNutrientCode(key)) continue;
    const n = toNumber(value);
    if (n !== null) out[key] = n;
  }
  return out;
}

type Row = any;

function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function summaryFromFoodRow(row: Row): FoodSummary {
  const n = cleanNutrients(row.nutrients);
  return {
    id: String(row.id),
    name: String(row.name),
    brand: row.brand ?? null,
    kind: row.kind as FoodKind,
    source: toFoodSource(row.source, 'custom'),
    kcal100g: n.ENERGY_KCAL ?? null,
    protein100g: n.PROTEIN_G ?? null,
    carbs100g: n.CARBS_G ?? null,
    fat100g: n.FAT_G ?? null,
    completeness: toNumber(row.completeness) ?? computeCompleteness(n),
  };
}

function summaryFromSearchRow(row: Row): FoodSummary {
  return {
    id: String(row.id),
    name: String(row.name),
    brand: row.brand ?? null,
    kind: row.kind as FoodKind,
    source: toFoodSource(row.source, 'custom'),
    kcal100g: toNumber(row.kcal_100g),
    protein100g: toNumber(row.protein_100g),
    carbs100g: toNumber(row.carbs_100g),
    fat100g: toNumber(row.fat_100g),
    completeness: toNumber(row.completeness),
  };
}

function mapFood(row: Row): Food {
  return {
    id: String(row.id),
    source: toFoodSource(row.source, 'custom'),
    sourceId: row.source_id ?? null,
    kind: row.kind as FoodKind,
    ownerId: row.owner_id ?? null,
    name: String(row.name),
    brand: row.brand ?? null,
    gtin14: row.gtin14 ?? null,
    category: row.category ?? null,
    nutrients: cleanNutrients(row.nutrients),
    carbBasis: row.carb_basis === 'excludes_fiber' ? 'excludes_fiber' : 'includes_fiber',
    densityGPerMl: toNumber(row.density_g_per_ml),
    version: toNumber(row.version) ?? 1,
    archived: Boolean(row.archived),
  };
}

/**
 * Strips a leading amount that is just the portion's `amount` ("2 tbsp" with amount 2 -> "tbsp",
 * "1 cup, chopped" with amount 1 -> "cup, chopped"). Labels that do not start with that number
 * are returned unchanged.
 */
export function portionUnitLabel(label: string, amount: number | null): string {
  const trimmed = label.trim();
  // amount NULL = the label itself is ONE unit, so only a leading "1" is redundant.
  const expected = amount ?? 1;
  const m = /^(\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d+(?:[.,]\d+)?)\s+(.+)$/.exec(trimmed);
  if (m) {
    const lead = parseNumber(m[1] ?? '');
    if (lead !== null && Math.abs(lead - expected) < 1e-6 && m[2]) return m[2].trim();
  }
  return trimmed;
}

function mapPortion(row: Row): FoodPortion {
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

/** Human message for PostgREST errors (plain objects), Errors and unknown values. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return typeof e === 'string' && e ? e : 'Something went wrong';
}

// ---------------------------------------------------------------------------
// Barcodes
// ---------------------------------------------------------------------------

/** Digits only (separators, spaces and check-digit dashes removed). */
export function gtinDigits(input: string | null | undefined): string {
  return (input ?? '').replace(/\D/g, '');
}

/** Normalises any GTIN/UPC/EAN to GTIN-14 exactly like the DB trigger. null = unusable. */
export function normalizeGtin(input: string | null | undefined): string | null {
  const digits = gtinDigits(input);
  if (digits === '' || /^0+$/.test(digits) || digits.length > 14) return null;
  return digits.padStart(14, '0');
}

/** GS1 mod-10 check digit test for 8/12/13/14 digit codes. */
export function hasValidGtinCheckDigit(digits: string): boolean {
  if (!/^\d+$/.test(digits) || ![8, 12, 13, 14].includes(digits.length)) return false;
  const payload = digits.slice(0, -1).split('').reverse();
  let sum = 0;
  payload.forEach((ch, i) => {
    sum += Number(ch) * (i % 2 === 0 ? 3 : 1);
  });
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

/** Expands an 8-digit UPC-E code to the 12-digit UPC-A it stands for (null if not 8 digits). */
export function expandUpcE(code: string): string | null {
  const d = gtinDigits(code);
  if (d.length !== 8) return null;
  const ns = d[0] ?? '0';
  const m = d.slice(1, 7);
  const check = d[7] ?? '0';
  const last = m[5] ?? '0';
  let body: string;
  switch (last) {
    case '0':
    case '1':
    case '2':
      body = m.slice(0, 2) + last + '0000' + m.slice(2, 5);
      break;
    case '3':
      body = m.slice(0, 3) + '00000' + m.slice(3, 5);
      break;
    case '4':
      body = m.slice(0, 4) + '00000' + m.slice(4, 5);
      break;
    default:
      body = m.slice(0, 5) + '0000' + last;
  }
  return ns + body + check;
}

export type BarcodeValidation = { ok: true; gtin14: string } | { ok: false; message: string };

/** Validates user-typed or scanned barcode text (length + check digit) and normalises it. */
export function validateBarcode(input: string): BarcodeValidation {
  const digits = gtinDigits(input);
  if (digits === '') return { ok: false, message: 'Enter the digits printed under the barcode.' };
  if (![8, 12, 13, 14].includes(digits.length)) {
    return { ok: false, message: 'A barcode has 8, 12, 13 or 14 digits.' };
  }
  if (!hasValidGtinCheckDigit(digits)) {
    return { ok: false, message: 'The last digit does not match. Check the barcode for typos.' };
  }
  const gtin14 = normalizeGtin(digits);
  if (!gtin14) return { ok: false, message: 'That is not a valid barcode.' };
  return { ok: true, gtin14 };
}

export type BarcodeLookupResult =
  | { status: 'found'; foodId: string; origin: 'local' | 'remote'; warning?: string }
  | { status: 'notFound'; gtin14: string }
  | { status: 'rateLimited'; gtin14: string; retryAfterSeconds?: number }
  | { status: 'unavailable'; gtin14: string; message: string }
  | { status: 'invalid'; message: string };

interface FunctionFailure {
  status: number | null;
  body: Record<string, unknown> | null;
  retryAfter: number | null;
}

/** Reads the HTTP status/body of a supabase-js FunctionsError (null status = network/relay). */
async function readFunctionError(error: unknown): Promise<FunctionFailure> {
  const e = error as { name?: string; context?: unknown } | null;
  const ctx = e?.context as Response | undefined;
  if (e?.name === 'FunctionsHttpError' && ctx && typeof ctx.status === 'number') {
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await ctx.json();
      if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
    } catch {
      body = null;
    }
    const header = toNumber(ctx.headers?.get?.('retry-after'));
    return { status: ctx.status, body, retryAfter: header };
  }
  return { status: null, body: null, retryAfter: null };
}

function isGatewayNotFound(f: FunctionFailure): boolean {
  if (f.status !== 404 || !f.body) return false;
  const message = typeof f.body.message === 'string' ? f.body.message : '';
  return f.body.code === 'NOT_FOUND' || /function/i.test(message);
}

const NOT_DEPLOYED = 'The lookup service is not available yet. Try again later.';

function classifyBarcodeFailure(gtin14: string, f: FunctionFailure): BarcodeLookupResult {
  if (f.status === null) {
    return { status: 'unavailable', gtin14, message: 'Could not reach the lookup service. Check your connection.' };
  }
  if (isGatewayNotFound(f)) return { status: 'unavailable', gtin14, message: NOT_DEPLOYED };
  const err = typeof f.body?.error === 'string' ? f.body.error : '';
  const retry = toNumber(f.body?.retryAfterSeconds) ?? f.retryAfter ?? undefined;
  if (f.status === 429 || /rate|too many|limit/i.test(err)) {
    return retry === undefined
      ? { status: 'rateLimited', gtin14 }
      : { status: 'rateLimited', gtin14, retryAfterSeconds: retry };
  }
  if (f.status === 404 || /not.?found|no product/i.test(err)) return { status: 'notFound', gtin14 };
  return { status: 'unavailable', gtin14, message: err || 'The lookup service returned an error.' };
}

async function lookupLocal(gtin14: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('get_food_by_gtin', { gtin: gtin14 });
  if (error) return null;
  const row = one(data as Row);
  return row && row.id ? String(row.id) : null;
}

async function lookupRemote(gtin14: string): Promise<BarcodeLookupResult> {
  let res: { data: unknown; error: unknown };
  try {
    res = await supabase.functions.invoke('barcode-lookup', { body: { gtin: gtin14 } });
  } catch (e) {
    return { status: 'unavailable', gtin14, message: errorMessage(e) };
  }
  if (res.error) return classifyBarcodeFailure(gtin14, await readFunctionError(res.error));

  const body = res.data;
  if (!body || typeof body !== 'object') {
    return { status: 'unavailable', gtin14, message: 'Unexpected response from the lookup service.' };
  }
  const b = body as Record<string, unknown>;
  if (b.error) {
    return classifyBarcodeFailure(gtin14, {
      status: toNumber(b.status),
      body: b,
      retryAfter: null,
    });
  }
  const food = b.food as { id?: unknown } | null | undefined;
  if (food && typeof food === 'object') {
    const warning = typeof b.warning === 'string' ? b.warning : undefined;
    const id = food.id ? String(food.id) : await lookupLocal(gtin14);
    if (id) return warning ? { status: 'found', foodId: id, origin: 'remote', warning } : { status: 'found', foodId: id, origin: 'remote' };
    return { status: 'unavailable', gtin14, message: 'The product was found but could not be saved. Try again.' };
  }
  return { status: 'notFound', gtin14 };
}

/**
 * Barcode lookup: 1. rpc get_food_by_gtin (own + global foods), 2. edge function `barcode-lookup`
 * (Open Food Facts etc., caches the food) on a miss. Never throws.
 */
export async function lookupBarcode(rawGtin: string): Promise<BarcodeLookupResult> {
  const gtin14 = normalizeGtin(rawGtin);
  if (!gtin14) return { status: 'invalid', message: 'That does not look like a valid barcode.' };
  try {
    const localId = await lookupLocal(gtin14);
    if (localId) return { status: 'found', foodId: localId, origin: 'local' };
  } catch {
    // fall through to the remote lookup
  }
  // Without the deployed edge function only our own database is searched: "not found" offers "Create custom food".
  if (!ONLINE_LOOKUP_ENABLED) return { status: 'notFound', gtin14 };
  return lookupRemote(gtin14);
}

/**
 * Name and brand of one food (null = no such food, or not visible to this user). For flows that only need to label a
 * product they already hold the id of, e.g. a scanned barcode handed to a recipe as an ingredient.
 */
export async function fetchFoodIdentity(foodId: string): Promise<{ name: string; brand: string | null } | null> {
  if (!isUuid(foodId)) return null;
  const { data, error } = await supabase.from('foods').select('name,brand').eq('id', foodId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as Row;
  return { name: String(row.name ?? ''), brand: row.brand ? String(row.brand) : null };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const SUMMARY_COLUMNS = 'id,source,kind,name,brand,nutrients,completeness';
const FOOD_COLUMNS =
  'id,source,source_id,kind,owner_id,name,brand,gtin14,category,nutrients,completeness,carb_basis,density_g_per_ml,version,archived';

/** Server-side food search (accent-insensitive, typo tolerant). Enabled for >= 2 characters. */
export function useFoodSearch(query: string, kinds?: FoodKind[]): UseQueryResult<FoodSummary[]> {
  const q = query.trim();
  const kindList = kinds && kinds.length > 0 ? kinds : undefined;
  return useQuery({
    queryKey: keys.foodSearch(q, kindList),
    enabled: q.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    queryFn: async (): Promise<FoodSummary[]> => {
      const args: Record<string, unknown> = { q, max_results: 40 };
      if (kindList) args.kinds = kindList;
      const { data, error } = await supabase.rpc('search_foods', args);
      if (error) throw error;
      return ((data ?? []) as Row[]).map(summaryFromSearchRow);
    },
  });
}

/** One food with its portions, computed completeness and (for archived foods) its successor. */
export function useFood(id: string | undefined): UseQueryResult<FoodDetail | null> {
  return useQuery({
    queryKey: keys.food(id ?? ''),
    enabled: Boolean(id),
    queryFn: async (): Promise<FoodDetail | null> => {
      // An id that is not a UUID can never exist; answer "not found" without sending it to Postgres.
      if (!isUuid(id)) return null;
      const foodId = id;
      const [foodRes, portionRes] = await Promise.all([
        supabase.from('foods').select(FOOD_COLUMNS).eq('id', foodId).maybeSingle(),
        supabase
          .from('food_portions')
          .select('id,label,amount,unit,grams,sort_order')
          .eq('food_id', foodId)
          .order('sort_order', { ascending: true })
          .order('id', { ascending: true }),
      ]);
      if (foodRes.error) throw foodRes.error;
      if (portionRes.error) throw portionRes.error;
      if (!foodRes.data) return null;
      const food = mapFood(foodRes.data);
      let supersededById: string | null = null;
      if (food.archived) {
        const next = await supabase.from('foods').select('id').eq('supersedes', foodId).maybeSingle();
        supersededById = next.data?.id ? String(next.data.id) : null;
      }
      return {
        food,
        portions: ((portionRes.data ?? []) as Row[]).map(mapPortion).filter((p) => p.gramsPerUnit > 0),
        completeness: computeCompleteness(food.nutrients),
        supersededById,
      };
    },
  });
}

interface ListOptions {
  enabled?: boolean;
}

/** Foods the user logged most recently (archived versions are hidden). */
export function useRecentFoods(options: ListOptions = {}): UseQueryResult<RecentFood[]> {
  return useQuery({
    queryKey: keys.recentFoods,
    enabled: options.enabled ?? true,
    queryFn: async (): Promise<RecentFood[]> => {
      const { data, error } = await supabase
        .from('food_usage')
        .select(`food_id,last_used_at,use_count,foods(${SUMMARY_COLUMNS},archived)`)
        .order('last_used_at', { ascending: false })
        .limit(60);
      if (error) throw error;
      const out: RecentFood[] = [];
      for (const row of (data ?? []) as Row[]) {
        const food = one<Row>(row.foods);
        if (!food || food.archived) continue;
        out.push({
          ...summaryFromFoodRow(food),
          lastUsedAt: String(row.last_used_at),
          useCount: toNumber(row.use_count) ?? 0,
        });
      }
      return out;
    },
  });
}

/** The user's favorite foods, newest first. */
export function useFavorites(options: ListOptions = {}): UseQueryResult<FoodSummary[]> {
  return useQuery({
    queryKey: keys.favorites,
    enabled: options.enabled ?? true,
    queryFn: async (): Promise<FoodSummary[]> => {
      const { data, error } = await supabase
        .from('favorites')
        .select(`food_id,created_at,foods(${SUMMARY_COLUMNS},archived)`)
        .order('created_at', { ascending: false })
        .limit(300);
      if (error) throw error;
      const out: FoodSummary[] = [];
      for (const row of (data ?? []) as Row[]) {
        const food = one<Row>(row.foods);
        if (!food || food.archived) continue;
        out.push(summaryFromFoodRow(food));
      }
      return out;
    },
  });
}

/** Adds/removes a favorite. */
export function useToggleFavorite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ foodId, favorite }: { foodId: string; favorite: boolean }) => {
      const userId = await requireUserId();
      if (favorite) {
        const { error } = await supabase
          .from('favorites')
          .upsert({ user_id: userId, food_id: foodId }, { onConflict: 'user_id,food_id', ignoreDuplicates: true });
        if (error) throw error;
      } else {
        const { error } = await supabase.from('favorites').delete().eq('user_id', userId).eq('food_id', foodId);
        if (error) throw error;
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.favorites }),
  });
}

/** Foods the user created or saved (custom, AI estimates, recipes), A-Z. */
export function useMyFoods(options: ListOptions = {}): UseQueryResult<FoodSummary[]> {
  return useQuery({
    queryKey: keys.myFoods,
    enabled: options.enabled ?? true,
    queryFn: async (): Promise<FoodSummary[]> => {
      const { data, error } = await supabase
        .from('foods')
        .select(SUMMARY_COLUMNS)
        .not('owner_id', 'is', null)
        .eq('archived', false)
        .in('kind', ['custom', 'ai_estimate', 'recipe'])
        .order('name', { ascending: true })
        .limit(500);
      if (error) throw error;
      return ((data ?? []) as Row[]).map(summaryFromFoodRow);
    },
  });
}

// ---------------------------------------------------------------------------
// Custom food create / update
// ---------------------------------------------------------------------------

export interface FoodServingInput {
  /** Unit name, e.g. "slice". Stored as label "1 slice", amount 1, unit "slice". */
  name: string;
  /** Grams of one serving. */
  grams: number;
}

export interface FoodInput {
  name: string;
  brand?: string | null;
  /** Any barcode text; normalised to GTIN-14. */
  gtin?: string | null;
  /** Per 100 g. Computed codes (net carbs, omega totals) are ignored. */
  nutrients: NutrientMap;
  carbBasis: CarbBasis;
  densityGPerMl?: number | null;
  servings: FoodServingInput[];
}

const round = (v: number, decimals: number) => Number(v.toFixed(decimals));

/** Non-negative finite catalog values only; energy is estimated from macros when missing. */
export function prepareNutrients(input: NutrientMap, carbBasis: CarbBasis): NutrientMap {
  const out: NutrientMap = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isNutrientCode(key)) continue;
    if ((COMPUTED_NUTRIENT_CODES as readonly string[]).includes(key)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    out[key] = round(value, 5);
  }
  if (out.ENERGY_KCAL === undefined) {
    const estimate = estimateEnergyKcal(out, carbBasis);
    if (estimate !== undefined) out.ENERGY_KCAL = round(estimate, 1);
  }
  return out;
}

function portionRows(foodId: string, servings: FoodServingInput[]) {
  return servings
    .filter((s) => s.name.trim() !== '' && Number.isFinite(s.grams) && s.grams > 0)
    .map((s, i) => ({
      food_id: foodId,
      label: `1 ${s.name.trim()}`,
      amount: 1,
      unit: s.name.trim(),
      grams: round(s.grams, 3),
      sort_order: i,
    }));
}

function foodPayload(input: FoodInput) {
  const nutrients = prepareNutrients(input.nutrients, input.carbBasis);
  const brand = input.brand?.trim();
  return {
    name: input.name.trim(),
    brand: brand ? brand : null,
    gtin14: normalizeGtin(input.gtin),
    nutrients,
    completeness: computeCompleteness(nutrients),
    carb_basis: input.carbBasis,
    density_g_per_ml: input.densityGPerMl && input.densityGPerMl > 0 ? input.densityGPerMl : null,
  };
}

/** Creates a custom food (source 'custom', kind 'custom', owned by the user) with its servings. */
export function useCreateFood() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: FoodInput): Promise<{ id: string }> => {
      const userId = await requireUserId();
      const { data, error } = await supabase
        .from('foods')
        .insert({ ...foodPayload(input), owner_id: userId, source: 'custom', kind: 'custom' })
        .select('id')
        .single();
      if (error) throw error;
      const id = String((data as Row).id);
      const rows = portionRows(id, input.servings);
      if (rows.length > 0) {
        const { error: portionError } = await supabase.from('food_portions').insert(rows);
        if (portionError) {
          await supabase.from('foods').delete().eq('id', id);
          throw portionError;
        }
      }
      return { id };
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.myFoods }),
        qc.invalidateQueries({ queryKey: ['food_search'] }),
      ]);
    },
  });
}

function isRestrictViolation(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  return e?.code === '23001' || /immutable|is referenced by/i.test(e?.message ?? '');
}

/**
 * Plain-async core of {@link useUpdateFood} (exported for the data layer tests). Name/brand/barcode/servings are
 * edited in place; when the nutrients, carb basis or density of an already-logged food change, the DB trigger rejects
 * the update, so the food is superseded (`supersede_food`) and the NEW row is updated.
 */
export async function updateFoodRows(id: string, input: FoodInput): Promise<{ id: string; superseded: boolean }> {
  const userId = await requireUserId();
  const patch = foodPayload(input);
  let targetId = id;
  let superseded = false;

  const first = await supabase.from('foods').update(patch).eq('id', id).select('id').single();
  if (first.error) {
    if (!isRestrictViolation(first.error)) throw first.error;
    const rpc = await supabase.rpc('supersede_food', { p_food_id: id });
    if (rpc.error) throw rpc.error;
    targetId = String(rpc.data);
    superseded = true;
    const second = await supabase.from('foods').update(patch).eq('id', targetId).select('id').single();
    if (second.error) throw second.error;
  }

  const del = await supabase.from('food_portions').delete().eq('food_id', targetId);
  if (del.error) throw del.error;
  const rows = portionRows(targetId, input.servings);
  if (rows.length > 0) {
    const ins = await supabase.from('food_portions').insert(rows);
    if (ins.error) throw ins.error;
  }

  if (superseded) {
    const fav = await supabase.from('favorites').select('food_id').eq('food_id', id).maybeSingle();
    if (fav.data) {
      await supabase
        .from('favorites')
        .upsert({ user_id: userId, food_id: targetId }, { onConflict: 'user_id,food_id', ignoreDuplicates: true });
    }
  }
  return { id: targetId, superseded };
}

/**
 * Updates an own custom food. Name/brand/barcode/servings are edited in place. If the nutrients,
 * carb basis or density of an already-logged food change, the DB trigger rejects the update, so
 * the food is superseded (`supersede_food`) and the NEW row is updated: old diary entries keep
 * their numbers. Resolves with the id to open afterwards.
 */
export function useUpdateFood() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: FoodInput }) => updateFoodRows(id, input),
    onSuccess: async (res, vars) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.food(vars.id) }),
        qc.invalidateQueries({ queryKey: keys.food(res.id) }),
        qc.invalidateQueries({ queryKey: keys.myFoods }),
        qc.invalidateQueries({ queryKey: keys.favorites }),
        qc.invalidateQueries({ queryKey: keys.recentFoods }),
        qc.invalidateQueries({ queryKey: ['food_search'] }),
        qc.invalidateQueries({ queryKey: ['day'] }),
      ]);
    },
  });
}

// ---------------------------------------------------------------------------
// Quick add
// ---------------------------------------------------------------------------

/** Default serving of a food: its first portion as defined, else 100 g. */
export interface DefaultServing {
  grams: number;
  amount: number;
  label: string;
}

/**
 * Adds 1 default serving (first portion, else 100 g) of a food to the diary. Use `mutateAsync`
 * result to show "Added 30 g".
 */
export function useQuickAddFood() {
  const add = useAddDiaryEntry();
  return useMutation({
    mutationFn: async (v: { foodId: string; mealGroupId: string; entryDate: string }): Promise<DefaultServing> => {
      const { data, error } = await supabase
        .from('food_portions')
        .select('id,label,amount,unit,grams,sort_order')
        .eq('food_id', v.foodId)
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true })
        .limit(1);
      if (error) throw error;
      const first = ((data ?? []) as Row[]).map(mapPortion).find((p) => p.rowGrams > 0);
      const serving: DefaultServing = first
        ? { grams: first.rowGrams, amount: first.defaultAmount, label: first.unitLabel }
        : { grams: 100, amount: 100, label: 'g' };
      await add.mutateAsync({
        foodId: v.foodId,
        grams: serving.grams,
        mealGroupId: v.mealGroupId,
        entryDate: v.entryDate,
        amount: serving.amount,
        portionLabel: serving.label,
      });
      return serving;
    },
  });
}

// ---------------------------------------------------------------------------
// Online search (edge function `online-search`, explicit user action only)
// ---------------------------------------------------------------------------

export interface OnlineSearchResult {
  gtin14: string;
  name: string;
  brand: string | null;
  source: FoodSource;
  kcal100g: number | null;
  protein100g: number | null;
  carbs100g: number | null;
  fat100g: number | null;
  completeness: number | null;
}

export type OnlineSearchError = Error & {
  code: 'unavailable' | 'rateLimited' | 'failed';
  retryAfterSeconds?: number;
};

function onlineError(code: OnlineSearchError['code'], message: string, retryAfterSeconds?: number): OnlineSearchError {
  const err = new Error(message) as OnlineSearchError;
  err.code = code;
  if (retryAfterSeconds !== undefined) err.retryAfterSeconds = retryAfterSeconds;
  return err;
}

function mapOnlineResult(r: Row): OnlineSearchResult | null {
  const gtin14 = normalizeGtin(r?.gtin14 === undefined ? undefined : String(r.gtin14));
  if (!gtin14 || !r?.name) return null;
  return {
    gtin14,
    name: String(r.name),
    brand: r.brand ?? null,
    source: toFoodSource(r.source, 'off'),
    kcal100g: toNumber(r.kcal100g),
    protein100g: toNumber(r.protein100g),
    carbs100g: toNumber(r.carbs100g),
    fat100g: toNumber(r.fat100g),
    completeness: toNumber(r.completeness),
  };
}

/** Searches branded products online. Call `mutate({ query })` only on explicit user action. */
export function useOnlineSearch() {
  return useMutation<OnlineSearchResult[], OnlineSearchError, { query: string; limit?: number }>({
    mutationFn: async ({ query, limit = 20 }) => {
      let res: { data: unknown; error: unknown };
      try {
        res = await supabase.functions.invoke('online-search', { body: { query: query.trim(), limit } });
      } catch (e) {
        throw onlineError('unavailable', errorMessage(e));
      }
      if (res.error) {
        const f = await readFunctionError(res.error);
        if (f.status === null || isGatewayNotFound(f)) {
          throw onlineError('unavailable', 'Online search is not available right now. Try again later.');
        }
        const retry = toNumber(f.body?.retryAfterSeconds) ?? f.retryAfter ?? undefined;
        if (f.status === 429) {
          throw onlineError('rateLimited', 'Too many searches. Wait a moment and try again.', retry);
        }
        const message = typeof f.body?.error === 'string' ? f.body.error : 'Online search failed.';
        throw onlineError('failed', message);
      }
      const body = res.data as { results?: unknown; error?: unknown; retryAfterSeconds?: unknown } | null;
      if (body && typeof body === 'object' && body.error) {
        const retry = toNumber(body.retryAfterSeconds) ?? undefined;
        const message = typeof body.error === 'string' ? body.error : 'Online search failed.';
        throw onlineError(/rate|limit|too many/i.test(message) ? 'rateLimited' : 'failed', message, retry);
      }
      const results = Array.isArray(body?.results) ? (body?.results as Row[]) : [];
      return results.map(mapOnlineResult).filter((r): r is OnlineSearchResult => r !== null);
    },
  });
}
