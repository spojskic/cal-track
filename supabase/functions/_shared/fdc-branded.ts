/**
 * USDA FoodData Central "Branded" food -> {@link MappedProduct} (pure).
 *
 * Handles both shapes FDC returns:
 *  - search result item: `foodNutrients: [{ nutrientId, nutrientName, nutrientNumber, unitName, value }]`
 *  - food detail:        `foodNutrients: [{ nutrient: { id, name, unitName }, amount }]`
 * Branded nutrient amounts are per 100 g (or per 100 ml for liquids).
 *
 * Written from the documented FDC formats; not verified against live payloads.
 */
import { toGtin14 } from './gtin.ts';
import { asRecord } from './http.ts';
import { FDC_NUTRIENT_MAP, type FdcNutrientEntry } from './nutrient-map.generated.ts';
import {
  cleanNutrients,
  titleCaseIfAllCaps,
  type MapResult,
  type MappedProduct,
} from './food-row.ts';

const KJ_PER_KCAL = 4.184;

/** Multiplier to grams for FDC mass unit names. */
const MASS_TO_GRAMS: Readonly<Record<string, number>> = {
  G: 1,
  MG: 1e-3,
  UG: 1e-6,
  MCG: 1e-6,
  '\u00B5G': 1e-6, // micro sign
  '\u03BCG': 1e-6, // greek mu
};

function normalizeUnitName(unit: unknown): string {
  return typeof unit === 'string' ? unit.trim().toUpperCase() : '';
}

/**
 * FDC amount -> catalog unit, or undefined when the unit is unusable.
 * Usual case: the FDC unit equals the expected one. Tolerated: another mass
 * unit (mg vs g, ...) and kJ vs kcal for energy.
 */
export function convertFdcAmount(
  value: number,
  unitName: string,
  entry: FdcNutrientEntry,
): number | undefined {
  if (unitName === '' || unitName === entry.fdcUnit) return value * entry.factor;
  const from = MASS_TO_GRAMS[unitName];
  const expected = MASS_TO_GRAMS[entry.fdcUnit];
  if (from !== undefined && expected !== undefined)
    return ((value * from) / expected) * entry.factor;
  if (unitName === 'KJ' && entry.fdcUnit === 'KCAL') return (value / KJ_PER_KCAL) * entry.factor;
  if (unitName === 'KCAL' && entry.fdcUnit === 'KJ') return value * KJ_PER_KCAL * entry.factor;
  return undefined;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * `foodNutrients` -> catalog nutrients per 100 g. When several FDC ids describe
 * one nutrient the lowest `rank` wins (energy: 1008 kcal -> 2048 Atwater
 * specific -> 2047 Atwater general -> 1062 kJ).
 */
export function extractFdcNutrients(foodNutrients: unknown): Record<string, number> {
  const best = new Map<string, { rank: number; value: number }>();
  if (!Array.isArray(foodNutrients)) return {};
  for (const raw of foodNutrients) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const nutrient = asRecord(entry.nutrient);
    const id = numeric(entry.nutrientId ?? nutrient?.id);
    if (id === undefined) continue;
    const mapping = FDC_NUTRIENT_MAP[id];
    if (!mapping) continue;
    const amount = numeric(entry.value ?? entry.amount);
    if (amount === undefined) continue;
    const converted = convertFdcAmount(
      amount,
      normalizeUnitName(entry.unitName ?? nutrient?.unitName),
      mapping,
    );
    if (converted === undefined || !Number.isFinite(converted)) continue;
    const current = best.get(mapping.code);
    if (!current || mapping.rank < current.rank) {
      best.set(mapping.code, { rank: mapping.rank, value: converted });
    }
  }
  const out: Record<string, number> = {};
  for (const [code, { value }] of best) out[code] = value;
  return out;
}

/** Serving unit names FDC uses ('g' | 'ml' in the API, 'GRM' | 'MLT' in the CSV/legacy dumps). */
function servingUnit(unit: unknown): 'g' | 'ml' | null {
  const u = typeof unit === 'string' ? unit.trim().toLowerCase() : '';
  if (u === 'g' || u === 'grm' || u === 'gram' || u === 'grams') return 'g';
  if (u === 'ml' || u === 'mlt' || u === 'milliliter' || u === 'milliliters') return 'ml';
  return null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t === '' ? null : t;
}

const formatAmount = (n: number): string => String(Number(n.toFixed(2)));

/** Maps one FDC Branded food (search item or food detail). */
export function mapFdcBranded(input: unknown): MapResult {
  const item = asRecord(input);
  if (!item) return { ok: false, reason: 'not_an_object' };

  const fdcId = numeric(item.fdcId);
  if (fdcId === undefined) return { ok: false, reason: 'no_fdc_id' };

  const description = text(item.description) ?? text(item.lowercaseDescription);
  if (!description) return { ok: false, reason: 'no_name' };

  const nutrients = cleanNutrients(extractFdcNutrients(item.foodNutrients));
  if (Object.keys(nutrients).length === 0) return { ok: false, reason: 'no_nutrition_data' };

  const brandRaw = text(item.brandName) ?? text(item.brandOwner);

  let serving: MappedProduct['serving'] = null;
  const size = numeric(item.servingSize);
  const unit = servingUnit(item.servingSizeUnit);
  if (size !== undefined && size > 0 && unit) {
    const household = text(item.householdServingFullText);
    const amount = `${formatAmount(size)} ${unit}`;
    serving = {
      grams: size,
      unit,
      label: household ? `${household} (${amount})` : `1 serving (${amount})`,
    };
  }

  return {
    ok: true,
    product: {
      source: 'fdc_branded',
      sourceId: String(fdcId),
      gtin14: toGtin14(item.gtinUpc),
      name: titleCaseIfAllCaps(description),
      brand: brandRaw ? titleCaseIfAllCaps(brandRaw) : null,
      category: text(item.foodCategory) ?? text(item.brandedFoodCategory),
      nutrients,
      // US labelling: "Total Carbohydrate" includes dietary fiber.
      carbBasis: 'includes_fiber',
      serving,
    },
  };
}

// ---------------------------------------------------------------------------
// Search response helpers
// ---------------------------------------------------------------------------

/** Parses FDC dates ('2021-03-02', '3/2/2021', ISO timestamps) to epoch ms, 0 when unknown. */
export function parseFdcDate(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const s = value.trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) return Date.UTC(Number(us[3]), Number(us[1]) - 1, Number(us[2]));
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

/** Newest of `modifiedDate` / `publishedDate` / `availableDate`. */
export function fdcFreshness(item: Record<string, unknown>): number {
  return Math.max(
    parseFdcDate(item.modifiedDate),
    parseFdcDate(item.publishedDate),
    parseFdcDate(item.availableDate),
  );
}

/** The `foods` array of a search response (items that are objects). */
export function fdcSearchItems(searchJson: unknown): Record<string, unknown>[] {
  const foods = asRecord(searchJson)?.foods;
  if (!Array.isArray(foods)) return [];
  return foods.map(asRecord).filter((f): f is Record<string, unknown> => f !== null);
}

/**
 * Items of a barcode search whose `gtinUpc` normalises to `gtin14` (FDC text
 * search is fuzzy, so non-matching hits must be ignored), newest first
 * (`modifiedDate` / `publishedDate`, then highest fdcId).
 */
export function selectFdcMatches(searchJson: unknown, gtin14: string): Record<string, unknown>[] {
  return fdcSearchItems(searchJson)
    .filter((item) => {
      const type = text(item.dataType);
      return (
        (type === null || type.toLowerCase() === 'branded') && toGtin14(item.gtinUpc) === gtin14
      );
    })
    .sort((a, b) => {
      const byDate = fdcFreshness(b) - fdcFreshness(a);
      if (byDate !== 0) return byDate;
      return (numeric(b.fdcId) ?? 0) - (numeric(a.fdcId) ?? 0);
    });
}
