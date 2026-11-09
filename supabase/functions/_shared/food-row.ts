/**
 * Final `foods` / `food_portions` row builder (pure).
 *
 * Both source mappers (FDC branded, Open Food Facts) produce a
 * {@link MappedProduct}; `buildFoodRow` turns it into the row shape of the
 * `upsert_branded_food` RPC (migration 20261110000012):
 *
 *   insert into foods (source, source_id, kind, owner_id, name, brand, gtin14, category,
 *                      nutrients, completeness, carb_basis, density_g_per_ml, popularity)
 */
import { CATALOG_UNITS, COMPUTED_CODES, NON_COMPUTED_CODES } from './nutrient-map.generated.ts';

export type FoodSource = 'fdc_branded' | 'off';
export type CarbBasis = 'includes_fiber' | 'excludes_fiber';

/** Source-independent product, nutrients per 100 g in CATALOG units (kcal, g, mg, ug). */
export interface MappedProduct {
  source: FoodSource;
  sourceId: string;
  gtin14: string | null;
  name: string;
  brand: string | null;
  category: string | null;
  /** code -> amount per 100 g (may still contain junk; the builder cleans it). */
  nutrients: Record<string, number>;
  carbBasis: CarbBasis;
  /** One serving as printed on the pack; `ml` servings are treated as 1 g/ml. */
  serving: { grams: number; unit: 'g' | 'ml'; label: string } | null;
}

export type MapResult = { ok: true; product: MappedProduct } | { ok: false; reason: string };

export interface FoodRow {
  source: FoodSource;
  source_id: string;
  kind: 'branded';
  owner_id: null;
  name: string;
  brand: string | null;
  gtin14: string | null;
  category: string | null;
  nutrients: Record<string, number>;
  completeness: number;
  carb_basis: CarbBasis;
  density_g_per_ml: number | null;
  popularity: number;
}

export interface PortionRow {
  label: string;
  amount: number | null;
  unit: string | null;
  grams: number;
  sort_order: number;
}

export interface BuiltFood {
  food: FoodRow;
  portions: PortionRow[];
}

const COMPUTED = new Set(COMPUTED_CODES);
const NON_COMPUTED_TOTAL = NON_COMPUTED_CODES.length;

/** Grams per catalog unit (for the "more than 100 g per 100 g" plausibility check). */
const GRAMS_PER_UNIT: Readonly<Record<string, number>> = { g: 1, mg: 1e-3, ug: 1e-6 };

/** Max plausible energy density in kcal per 100 g (pure fat is ~900). */
const MAX_KCAL_PER_100G = 1000;

/** Round to `digits` significant digits (default 4). */
export function roundSig(value: number, digits = 4): number {
  if (value === 0) return 0;
  return Number(value.toPrecision(digits));
}

/**
 * Keeps only plausible catalog nutrients: known, non-computed codes whose
 * value is a finite number >= 0 (NaN / negative / Infinity are dropped), not
 * more than 100 g per 100 g, energy not above 1000 kcal per 100 g. Values are
 * rounded to 4 significant digits.
 */
export function cleanNutrients(raw: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [code, value] of Object.entries(raw)) {
    const unit = CATALOG_UNITS[code];
    if (!unit || COMPUTED.has(code)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    if (unit === 'kcal') {
      if (value > MAX_KCAL_PER_100G) continue;
    } else {
      const gramsPerUnit = GRAMS_PER_UNIT[unit];
      if (gramsPerUnit !== undefined && value * gramsPerUnit > 100) continue;
    }
    out[code] = roundSig(value);
  }
  return out;
}

/** Fraction (0..1, 4 decimals) of non-computed catalog nutrients that are present. */
export function computeCompleteness(nutrients: Record<string, number>): number {
  let present = 0;
  for (const code of NON_COMPUTED_CODES) {
    if (typeof nutrients[code] === 'number' && Number.isFinite(nutrients[code])) present += 1;
  }
  return Number((present / NON_COMPUTED_TOTAL).toFixed(4));
}

/** True when the text has letters and none of them is lower case ("NUTELLA HAZELNUT SPREAD"). */
export function isAllCaps(text: string): boolean {
  return /[A-Za-z]/.test(text) && text === text.toUpperCase() && text !== text.toLowerCase();
}

/**
 * Title-cases text that SHOUTS (ALL CAPS) and leaves mixed-case text alone.
 * "CHOCOLATE CHIP COOKIES, 12 OZ" -> "Chocolate Chip Cookies, 12 Oz";
 * apostrophes do not start a new word ("NATURE'S" -> "Nature's").
 */
export function titleCaseIfAllCaps(text: string): string {
  if (!isAllCaps(text)) return text;
  return text.toLowerCase().replace(/(^|[\s\-/(,&.])([a-z])/g, (_m, sep: string, ch: string) => {
    return sep + ch.toUpperCase();
  });
}

function cleanText(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  const t = value.replace(/\s+/g, ' ').trim();
  if (t === '') return null;
  return t.length > max ? t.slice(0, max).trimEnd() : t;
}

const MAX_SERVING_G = 5000;

/**
 * Builds the `foods` row and its portions. Returns null when nothing usable is
 * left (no valid name or no nutrient survived cleaning).
 *
 * Portions: always `100 g` (sort 0); plus `1 serving (...)` (sort 1) when the
 * product states a serving size. `ml` servings count 1 ml = 1 g and set
 * `density_g_per_ml = 1` (both sources report their per-100 value per 100 g/ml
 * with no density information).
 */
export function buildFoodRow(product: MappedProduct): BuiltFood | null {
  const name = cleanText(product.name, 200);
  if (!name) return null;
  const nutrients = cleanNutrients(product.nutrients);
  if (Object.keys(nutrients).length === 0) return null;

  const portions: PortionRow[] = [
    { label: '100 g', amount: 100, unit: 'g', grams: 100, sort_order: 0 },
  ];
  let density: number | null = null;
  const s = product.serving;
  if (s && Number.isFinite(s.grams) && s.grams > 0 && s.grams <= MAX_SERVING_G) {
    const grams = Number(s.grams.toFixed(2));
    if (grams > 0) {
      portions.push({
        label: cleanText(s.label, 100) ?? `1 serving (${grams} ${s.unit})`,
        amount: 1,
        unit: 'serving',
        grams,
        sort_order: 1,
      });
      if (s.unit === 'ml') density = 1;
    }
  }

  return {
    food: {
      source: product.source,
      source_id: product.sourceId,
      kind: 'branded',
      owner_id: null,
      name,
      brand: cleanText(product.brand, 100),
      gtin14: product.gtin14,
      category: cleanText(product.category, 100),
      nutrients,
      completeness: computeCompleteness(nutrients),
      carb_basis: product.carbBasis,
      density_g_per_ml: density,
      popularity: 0,
    },
    portions,
  };
}
