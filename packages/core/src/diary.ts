import { NUTRIENTS, NUTRIENT_CODES, type NutrientCode } from './nutrients';
import type { CarbBasis, NetCarbMode, NutrientMap } from './types';

/** Calories per gram of each energy-providing macro (Atwater general factors). */
export const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9, alcohol: 7 } as const;

/** True for a usable amount (finite number). Everything else is "unknown". */
function isKnown(v: number | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Codes present (and finite) in a map. */
function knownCodes(map: NutrientMap): NutrientCode[] {
  return (Object.keys(map) as NutrientCode[]).filter((k) => isKnown(map[k]));
}

/**
 * Scales a per-100 g nutrient map to an arbitrary amount of food.
 *
 * `result[code] = per100g[code] * grams / 100`
 *
 * Unknown nutrients stay unknown (they are not turned into 0).
 *
 * @param per100g nutrient amounts per 100 g of food (catalog units)
 * @param grams   consumed amount in grams (>= 0)
 */
export function scaleNutrients(per100g: NutrientMap, grams: number): NutrientMap {
  const out: NutrientMap = {};
  const factor = grams / 100;
  for (const code of knownCodes(per100g)) {
    out[code] = (per100g[code] as number) * factor;
  }
  return out;
}

/**
 * Adds two nutrient maps. A nutrient present in only one map keeps that value
 * (unknown + known = known); a nutrient present in neither stays unknown.
 */
export function addNutrients(a: NutrientMap, b: NutrientMap): NutrientMap {
  const out: NutrientMap = {};
  for (const code of knownCodes(a)) out[code] = a[code] as number;
  for (const code of knownCodes(b)) out[code] = (out[code] ?? 0) + (b[code] as number);
  return out;
}

/** Result of {@link sumNutrientsDetailed}. */
export interface NutrientSum {
  /** Sum of the known amounts; unknown-only nutrients are absent. */
  totals: NutrientMap;
  /** Nutrients known for SOME but not ALL of the maps (the total is a lower bound). */
  incompleteNutrients: NutrientCode[];
}

/**
 * Sums many nutrient maps and reports which totals are incomplete.
 *
 * Semantics: unknown + known = known; unknown only stays unknown (absent).
 * A nutrient is listed in `incompleteNutrients` when it is known in at least
 * one map but missing in at least one other, i.e. the total understates the
 * truth. Output order follows the catalog.
 */
export function sumNutrientsDetailed(list: readonly NutrientMap[]): NutrientSum {
  const totals: NutrientMap = {};
  const counts: Partial<Record<NutrientCode, number>> = {};
  for (const map of list) {
    for (const code of knownCodes(map)) {
      totals[code] = (totals[code] ?? 0) + (map[code] as number);
      counts[code] = (counts[code] ?? 0) + 1;
    }
  }
  const incompleteNutrients = NUTRIENT_CODES.filter((code) => {
    const c = counts[code];
    return c !== undefined && c < list.length;
  });
  return { totals, incompleteNutrients };
}

/** Sums many nutrient maps (unknown + known = known; unknown only stays unknown). */
export function sumNutrients(list: readonly NutrientMap[]): NutrientMap {
  return sumNutrientsDetailed(list).totals;
}

/** A logged food: nutrients per 100 g and the consumed grams. */
export interface DiaryEntryAmount {
  per100g: NutrientMap;
  grams: number;
}

/**
 * Total nutrients of a set of diary entries:
 * `sum(per100g * grams / 100)` with unknown-vs-zero semantics of {@link sumNutrients}.
 */
export function sumEntries(entries: readonly DiaryEntryAmount[]): NutrientMap {
  return sumNutrients(entries.map((e) => scaleNutrients(e.per100g, e.grams)));
}

/** Options for {@link deriveNutrients}. Defaults: `includes_fiber`, `fiber_and_sugar_alcohols`. */
export interface DeriveOptions {
  carbBasis?: CarbBasis;
  netCarbMode?: NetCarbMode;
}

/**
 * Available (digestible) carbohydrate in grams, or undefined when carbs are unknown.
 * `includes_fiber`: carbs - fiber (missing fiber counts as 0, floor 0); `excludes_fiber`: carbs.
 */
function availableCarbsG(map: NutrientMap, basis: CarbBasis): number | undefined {
  const carbs = map.CARBS_G;
  if (!isKnown(carbs)) return undefined;
  if (basis === 'excludes_fiber') return carbs;
  const fiber = isKnown(map.FIBER_G) ? map.FIBER_G : 0;
  return Math.max(0, carbs - fiber);
}

/**
 * Atwater-style energy estimate from macros:
 * `4 * protein + 4 * availableCarbs + 9 * fat + 7 * alcohol` (kcal).
 *
 * Returns `undefined` when none of protein, carbs and fat is known. A single
 * missing macro among the three is treated as 0 (so the value is then a lower
 * bound); alcohol is optional. Fiber (about 2 kcal/g) and sugar-alcohol energy
 * are ignored on purpose.
 */
export function estimateEnergyKcal(
  map: NutrientMap,
  carbBasis: CarbBasis = 'includes_fiber',
): number | undefined {
  const protein = isKnown(map.PROTEIN_G) ? map.PROTEIN_G : undefined;
  const fat = isKnown(map.FAT_G) ? map.FAT_G : undefined;
  const carbs = availableCarbsG(map, carbBasis);
  if (protein === undefined && fat === undefined && carbs === undefined) return undefined;
  const alcohol = isKnown(map.ALCOHOL_G) ? map.ALCOHOL_G : 0;
  return (
    KCAL_PER_G.protein * (protein ?? 0) +
    KCAL_PER_G.carbs * (carbs ?? 0) +
    KCAL_PER_G.fat * (fat ?? 0) +
    KCAL_PER_G.alcohol * alcohol
  );
}

/** Sums the known components; undefined when none is known. */
function sumKnown(map: NutrientMap, codes: readonly NutrientCode[]): number | undefined {
  let total: number | undefined;
  for (const code of codes) {
    const v = map[code];
    if (isKnown(v)) total = (total ?? 0) + v;
  }
  return total;
}

/**
 * Returns a copy of `map` with the computed nutrients filled in.
 *
 * - `NET_CARBS_G` (needs `CARBS_G`; recomputed even if present):
 *   - `includes_fiber`:  `carbs - fiber - sugarAlcohols`
 *   - `excludes_fiber`:  `carbs - sugarAlcohols` (carbs already exclude fiber)
 *   - with `netCarbMode: 'fiber_only'` the sugar-alcohol term is dropped.
 *   Missing fiber / sugar alcohols count as 0; the result is never below 0.
 * - `OMEGA3_G` = ALA + EPA + DPA + DHA, `OMEGA6_G` = LA + ARA. The sum of the
 *   KNOWN components is used; unknown if none is known.
 * - `ENERGY_KCAL` is filled from {@link estimateEnergyKcal} ONLY when missing.
 *
 * The input map is not mutated.
 */
export function deriveNutrients(map: NutrientMap, opts: DeriveOptions = {}): NutrientMap {
  const carbBasis = opts.carbBasis ?? 'includes_fiber';
  const netCarbMode = opts.netCarbMode ?? 'fiber_and_sugar_alcohols';
  const out: NutrientMap = { ...map };

  // Net carbs
  if (isKnown(map.CARBS_G)) {
    const fiber = carbBasis === 'includes_fiber' && isKnown(map.FIBER_G) ? map.FIBER_G : 0;
    const alcohols =
      netCarbMode === 'fiber_and_sugar_alcohols' && isKnown(map.SUGAR_ALCOHOLS_G)
        ? map.SUGAR_ALCOHOLS_G
        : 0;
    out.NET_CARBS_G = Math.max(0, map.CARBS_G - fiber - alcohols);
  } else {
    delete out.NET_CARBS_G;
  }

  // Omega fatty acids
  const omega3 = sumKnown(map, ['ALA_G', 'EPA_G', 'DPA_G', 'DHA_G']);
  if (omega3 !== undefined) out.OMEGA3_G = omega3;
  else delete out.OMEGA3_G;
  const omega6 = sumKnown(map, ['LINOLEIC_G', 'ARACHIDONIC_G']);
  if (omega6 !== undefined) out.OMEGA6_G = omega6;
  else delete out.OMEGA6_G;

  // Energy fallback
  if (!isKnown(map.ENERGY_KCAL)) {
    const kcal = estimateEnergyKcal(map, carbBasis);
    if (kcal !== undefined) out.ENERGY_KCAL = kcal;
    else delete out.ENERGY_KCAL;
  }

  return out;
}

const NON_COMPUTED_COUNT = NUTRIENTS.filter((n) => !n.computed).length;

/**
 * Data completeness of a food / day: the fraction (0..1) of NON-computed
 * catalog nutrients that have a known value. Computed nutrients (net carbs,
 * omega-3/6) are ignored so deriving them does not inflate the score.
 */
export function completeness(map: NutrientMap): number {
  let present = 0;
  for (const n of NUTRIENTS) {
    if (n.computed) continue;
    if (isKnown(map[n.code])) present += 1;
  }
  return present / NON_COMPUTED_COUNT;
}
