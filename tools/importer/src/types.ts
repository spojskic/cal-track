import type { CarbBasis, NutrientMap } from '@cal/core';

/** Values of `public.foods.source` this importer writes. */
export type ImportSource = 'fdc_foundation' | 'fdc_sr_legacy' | 'fdc_fndds' | 'cnf';

/**
 * One serving size of a food.
 *
 * `grams` is the mass of ONE serving AS DESCRIBED BY `label` (FDC `gram_weight`
 * semantics): "8 fl oz" -> grams = 244, amount = 8, unit = "fl oz". `amount` /
 * `unit` are descriptive metadata only.
 */
export interface ImportPortion {
  label: string;
  amount: number | null;
  unit: string | null;
  grams: number;
  sortOrder: number;
}

/** A food ready to be written to `public.foods` / `public.food_portions`. */
export interface ImportFood {
  source: ImportSource;
  sourceId: string;
  kind: 'generic';
  name: string;
  category: string | null;
  /** Per 100 g, catalog units, rounded to 4 significant digits. Absent key = unknown. */
  nutrients: NutrientMap;
  /** 0..1, `completeness()` from @cal/core. */
  completeness: number;
  carbBasis: CarbBasis;
  portions: ImportPortion[];
}

/** Why a parsed food was not imported. */
export type DropReason =
  | 'no_name'
  | 'no_energy'
  | 'impossible_macros'
  | 'impossible_energy'
  | 'excluded_category';

export const DROP_REASONS: readonly DropReason[] = [
  'no_name',
  'no_energy',
  'impossible_macros',
  'impossible_energy',
  'excluded_category',
];

/** Which input produced a food's ENERGY_KCAL. */
export type EnergySource = 'kcal' | 'atwater_specific' | 'atwater_general' | 'kj' | 'macros';

/** A source nutrient the catalog does not track (counted over kept AND dropped foods). */
export interface UnmappedNutrient {
  name: string;
  unit: string;
  /** Number of (food, nutrient) entries seen. */
  count: number;
}

/** Counters collected while parsing one dataset. */
export interface DatasetStats {
  source: ImportSource;
  /** Foods of the right data type found in the input (before limit/filters). */
  foodsFound: number;
  /** Foods that were turned into an ImportFood. */
  kept: number;
  dropped: Record<DropReason, number>;
  energySources: Record<EnergySource, number>;
  /** Sum over kept foods of the number of stored nutrients. */
  nutrientEntries: number;
  /** Source amounts skipped because the unit could not be converted. */
  unitMismatches: number;
  /** Source amounts skipped because they were negative or not a number. */
  invalidAmounts: number;
  /** Small negative "carbohydrate by difference" values stored as 0 (analytical noise). */
  clampedAmounts: number;
  portionsKept: number;
  portionsDropped: number;
  /** Source nutrient id -> info for nutrients that have no mapping rule. */
  unmapped: Map<number, UnmappedNutrient>;
  /** Rows (CSV) / foods (JSON) scanned per input file (name -> count). */
  rowsRead: Record<string, number>;
  warnings: string[];
}

export function newStats(source: ImportSource): DatasetStats {
  return {
    source,
    foodsFound: 0,
    kept: 0,
    dropped: {
      no_name: 0,
      no_energy: 0,
      impossible_macros: 0,
      impossible_energy: 0,
      excluded_category: 0,
    },
    energySources: { kcal: 0, atwater_specific: 0, atwater_general: 0, kj: 0, macros: 0 },
    nutrientEntries: 0,
    unitMismatches: 0,
    invalidAmounts: 0,
    clampedAmounts: 0,
    portionsKept: 0,
    portionsDropped: 0,
    unmapped: new Map(),
    rowsRead: {},
    warnings: [],
  };
}

/** Result of loading one dataset. */
export interface LoadResult {
  foods: ImportFood[];
  stats: DatasetStats;
  /** Display label when only known after reading the input (auto-detected dataset). */
  label?: string;
}

/** Counts one unmapped (food, nutrient) entry. */
export function bumpUnmapped(stats: DatasetStats, id: number, name: string, unit: string): void {
  const existing = stats.unmapped.get(id);
  if (existing) existing.count += 1;
  else stats.unmapped.set(id, { name, unit, count: 1 });
}

export type Logger = (message: string) => void;
