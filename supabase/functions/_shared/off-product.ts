/**
 * Open Food Facts product -> {@link MappedProduct} (pure).
 *
 * Open Food Facts (OFF) `nutriments`:
 *  - `energy-kcal_100g` is kcal, `energy-kj_100g` / `energy_100g` are kJ;
 *  - every other `<key>_100g` is GRAMS per 100 g (also vitamins and minerals),
 *    converted to the catalog unit with the factors in OFF_NUTRIENT_MAP;
 *  - `salt_100g` is grams of salt: sodium_mg = salt_g / 2.5 * 1000;
 *  - `nutrition_data_per` is '100g' or 'serving' (how the label was entered).
 *
 * Written from the documented OFF format; not verified against live payloads.
 */
import { toGtin14 } from './gtin.ts';
import { asRecord } from './http.ts';
import { OFF_NUTRIENT_MAP } from './nutrient-map.generated.ts';
import { cleanNutrients, type CarbBasis, type MapResult, type MappedProduct } from './food-row.ts';

const KJ_PER_KCAL = 4.184;
/** Salt (NaCl) is 40% sodium: sodium = salt / 2.5. */
const SALT_PER_SODIUM = 2.5;

export interface OffMapOptions {
  /** Code to use when the product object has no `code` (e.g. the code that was requested). */
  fallbackCode?: string;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim().replace(',', '.'));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function positive(value: unknown): number | undefined {
  const n = numeric(value);
  return n !== undefined && n > 0 ? n : undefined;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t === '' ? null : t;
}

/**
 * Carbohydrate labelling differs by region:
 *  - United States / Canada: "Total Carbohydrate" INCLUDES dietary fiber
 *    (net carbs = carbs - fiber);
 *  - EU / UK and most other markets (Regulation (EU) 1169/2011): "carbohydrate"
 *    means available carbohydrate and EXCLUDES fibre, which is declared separately.
 * OFF does not record which convention a label used, so the countries the
 * product is sold in are the best signal. A product sold in the US/Canada is
 * assumed to carry the North-American convention, everything else (and unknown)
 * the European one. This is a heuristic and can be wrong for imports.
 */
export function carbBasisFromCountries(countriesTags: unknown): CarbBasis {
  if (Array.isArray(countriesTags)) {
    for (const tag of countriesTags) {
      if (tag === 'en:united-states' || tag === 'en:canada') return 'includes_fiber';
    }
  }
  return 'excludes_fiber';
}

/** First brand of OFF's comma-separated `brands` ("Ferrero,Nutella" -> "Ferrero"). */
function firstBrand(brands: unknown): string | null {
  const first = text(brands)?.split(',')[0]?.trim();
  return first ? first : null;
}

/** Most specific English category tag ("en:spreads" / "Sweet spreads" -> "Sweet spreads"). */
function categoryFromTags(product: Record<string, unknown>): string | null {
  const english = product.categories_tags_en;
  let tag: string | null = null;
  if (Array.isArray(english)) {
    const list = english.filter((t): t is string => typeof t === 'string' && t.trim() !== '');
    tag = list[list.length - 1] ?? null;
  } else if (Array.isArray(product.categories_tags)) {
    const list = product.categories_tags.filter(
      (t): t is string => typeof t === 'string' && t.startsWith('en:'),
    );
    tag = list[list.length - 1] ?? null;
  }
  if (!tag) return null;
  const cleaned = tag.replace(/^en:/, '').replace(/-/g, ' ').trim();
  return cleaned === '' ? null : cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function servingFromProduct(product: Record<string, unknown>): MappedProduct['serving'] {
  const quantity = positive(product.serving_quantity);
  if (quantity === undefined) return null;
  const sizeText = text(product.serving_size);
  const rawUnit = text(product.serving_quantity_unit)?.toLowerCase();
  const unit: 'g' | 'ml' =
    rawUnit === 'ml' || (rawUnit !== 'g' && sizeText !== null && /\d\s*ml\b/i.test(sizeText))
      ? 'ml'
      : 'g';
  const amount = `${Number(quantity.toFixed(2))} ${unit}`;
  let label: string;
  if (sizeText && sizeText.includes('(')) label = sizeText;
  else label = `1 serving (${sizeText ?? amount})`;
  return { grams: quantity, unit, label };
}

/** Maps one OFF `product` object. */
export function mapOffProduct(input: unknown, options: OffMapOptions = {}): MapResult {
  const product = asRecord(input);
  if (!product) return { ok: false, reason: 'not_an_object' };

  const rawCode = text(product.code) ?? options.fallbackCode ?? null;
  const code = rawCode ? rawCode.trim() : null;
  if (!code) return { ok: false, reason: 'no_code' };

  const nutriments = asRecord(product.nutriments) ?? {};

  // Per-serving labels: only usable when we know how many grams a serving is.
  const perServing = product.nutrition_data_per === 'serving';
  const servingQuantity = positive(product.serving_quantity);
  if (perServing && servingQuantity === undefined) {
    return { ok: false, reason: 'per_serving_without_quantity' };
  }
  const suffix = perServing ? '_serving' : '_100g';
  const scale = perServing ? 100 / (servingQuantity as number) : 1;
  const read = (key: string): number | undefined => {
    const v = numeric(nutriments[key + suffix]);
    return v === undefined ? undefined : v * scale;
  };

  const raw: Record<string, number> = {};
  for (const [key, entry] of Object.entries(OFF_NUTRIENT_MAP)) {
    const v = read(key);
    if (v !== undefined) raw[entry.code] = v * entry.factor;
  }

  // Energy: kcal key first, else kJ (`energy-kj`, then the plain `energy` key, which is kJ).
  if (raw.ENERGY_KCAL === undefined) {
    const kj = read('energy-kj') ?? read('energy');
    if (kj !== undefined) raw.ENERGY_KCAL = kj / KJ_PER_KCAL;
  }
  // Sodium: `sodium` key first, else derived from salt (grams -> mg).
  if (raw.SODIUM_MG === undefined) {
    const salt = read('salt');
    if (salt !== undefined) raw.SODIUM_MG = (salt / SALT_PER_SODIUM) * 1000;
  }

  const nutrients = cleanNutrients(raw);
  const hasEnergyOrMacros = ['ENERGY_KCAL', 'PROTEIN_G', 'CARBS_G', 'FAT_G'].some(
    (c) => nutrients[c] !== undefined,
  );
  if (!hasEnergyOrMacros) return { ok: false, reason: 'no_nutrition_data' };

  const brand = firstBrand(product.brands);
  const name =
    text(product.product_name) ?? text(product.product_name_en) ?? brand ?? `Product ${code}`;

  return {
    ok: true,
    product: {
      source: 'off',
      sourceId: code,
      gtin14: toGtin14(code),
      name,
      brand,
      category: categoryFromTags(product),
      nutrients,
      carbBasis: carbBasisFromCountries(product.countries_tags),
      serving: servingFromProduct(product),
    },
  };
}

/**
 * Reads a `/api/v2/product/<code>.json` response: `{ code, status: 1, product: {...} }`
 * (`status: 0` = not found). Returns the product object or null.
 */
export function offProductFromResponse(
  json: unknown,
): { product: Record<string, unknown>; code?: string } | null {
  const root = asRecord(json);
  if (!root) return null;
  if (root.status === 0 || root.status === '0') return null;
  const product = asRecord(root.product);
  if (!product) return null;
  const code = text(root.code) ?? undefined;
  return code ? { product, code } : { product };
}
