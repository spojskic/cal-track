/**
 * USDA FoodData Central CSV loader (Foundation Foods, SR Legacy, FNDDS Survey).
 *
 * Streams only the CSV files it needs; food_nutrient.csv is read row by row and
 * grouped per fdc_id, keeping only wanted foods and tracked nutrient ids, so
 * memory use is bounded by the (small) number of generic foods, never by the
 * archive size. Amounts in FDC are per 100 g.
 */
import { NUTRIENT_BY_CODE } from '@cal/core';
import { assembleFood } from './build';
import { field, parseDecimal, readCsvFile, type Row } from './csv';
import { BY_DIFFERENCE_CARB_IDS, buildFdcRules, normalizeUnit, sanitizeAmount, unitFactor, type RuleSet } from './mapping';
import { buildFdcPortion, type PortionCandidate } from './portions';
import type { FileSource } from './source';
import { bumpUnmapped, newStats, type DatasetStats, type ImportSource, type LoadResult, type Logger } from './types';

export type FdcDatasetId = 'foundation' | 'sr_legacy' | 'fndds';

/** Archive format: JSON is the primary one (small, complete); CSV is supported for SR Legacy / FNDDS. */
export type FdcFormat = 'json' | 'csv';

export interface FdcDatasetConfig {
  source: ImportSource;
  /** `food.data_type` value of the dataset's foods. */
  dataType: string;
  label: string;
}

export const FDC_DATASETS: Readonly<Record<FdcDatasetId, FdcDatasetConfig>> = {
  foundation: { source: 'fdc_foundation', dataType: 'foundation_food', label: 'Foundation Foods' },
  sr_legacy: { source: 'fdc_sr_legacy', dataType: 'sr_legacy_food', label: 'SR Legacy' },
  fndds: { source: 'fdc_fndds', dataType: 'survey_fndds_food', label: 'FNDDS Survey' },
};

export function isFdcDatasetId(value: string): value is FdcDatasetId {
  return Object.prototype.hasOwnProperty.call(FDC_DATASETS, value);
}

/** CSV tables without which a CSV archive cannot be imported. */
export const REQUIRED_CSV = ['food.csv', 'food_nutrient.csv', 'nutrient.csv'] as const;

/** Actionable error for CSV archives that lack the core tables (e.g. the Oct 2026 Foundation CSV zip). */
export function incompleteArchiveMessage(src: FileSource, label: string, absent: readonly string[]): string {
  return (
    `${absent.join(', ')} not found in the ${label} input (found: ${src.list().join(', ') || 'no CSV files'}). ` +
    'This archive is incomplete - the FDC CSV archive of some releases (e.g. Foundation Foods, Oct 2026) ' +
    'does not contain food.csv / food_nutrient.csv / food_portion.csv. ' +
    'Use the JSON archive instead: run `download <foundation|sr_legacy|fndds>` (JSON is the default) ' +
    'and pass the downloaded zip to --path.'
  );
}

export interface NutrientMeta {
  name: string;
  unit: string;
  nbr: string;
}

const intOrNull = (s: string): number | null => {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
};

/** Counts rows of an async row stream into `stats.rowsRead[name]`. */
async function* counted(rows: AsyncIterable<Row>, stats: DatasetStats, name: string): AsyncGenerator<Row> {
  let n = 0;
  try {
    for await (const row of rows) {
      n += 1;
      yield row;
    }
  } finally {
    stats.rowsRead[name] = (stats.rowsRead[name] ?? 0) + n;
  }
}

// --------------------------------------------------------------- small tables

/** nutrient.csv: id -> { name, unit_name, nutrient_nbr }. */
export async function readNutrientMeta(rows: AsyncIterable<Row>): Promise<Map<number, NutrientMeta>> {
  const meta = new Map<number, NutrientMeta>();
  for await (const row of rows) {
    const id = intOrNull(field(row, 'id', 'nutrientid'));
    if (id === null) continue;
    meta.set(id, {
      name: field(row, 'name'),
      unit: field(row, 'unitname', 'unit'),
      nbr: field(row, 'nutrientnbr'),
    });
  }
  return meta;
}

/**
 * Compares the importer's rules with nutrient.csv and returns human readable
 * warnings for ids that are missing from the file or whose unit cannot be
 * converted to the catalog unit.
 */
export function catalogChecks(
  meta: ReadonlyMap<number, NutrientMeta>,
  rules: RuleSet,
  opts: { reportAbsent?: boolean } = {},
): string[] {
  if (meta.size === 0) return [];
  const warnings: string[] = [];
  const absent: number[] = [];
  for (const rule of rules.rules) {
    const m = meta.get(rule.id);
    if (m === undefined) {
      absent.push(rule.id);
      continue;
    }
    const unit = normalizeUnit(m.unit);
    const catalogUnit = NUTRIENT_BY_CODE[rule.code].unit;
    if (rule.factor === undefined) {
      if (unitFactor(unit, catalogUnit) === null) {
        warnings.push(
          `nutrient ${rule.id} "${m.name}" has unit ${m.unit}, cannot convert to ${catalogUnit} (${rule.code}); skipped`,
        );
      }
    } else if (rule.expectUnit !== undefined && unit !== rule.expectUnit) {
      warnings.push(
        `nutrient ${rule.id} "${m.name}" has unit ${m.unit}, expected ${rule.expectUnit}; rule disabled for ${rule.code}`,
      );
    }
  }
  if (absent.length > 0 && opts.reportAbsent !== false) {
    warnings.push(
      `${absent.length} mapped nutrient id(s) not present in nutrient.csv: ${absent.slice(0, 15).join(', ')}${absent.length > 15 ? ', ...' : ''}`,
    );
  }
  return warnings;
}

interface CategoryTables {
  byId: Map<string, string>;
  byCode: Map<string, string>;
}

/** food_category.csv (id, code, description). */
export async function readFoodCategories(rows: AsyncIterable<Row>): Promise<CategoryTables> {
  const byId = new Map<string, string>();
  const byCode = new Map<string, string>();
  for await (const row of rows) {
    const description = field(row, 'description');
    if (description === '') continue;
    const id = field(row, 'id');
    const code = field(row, 'code');
    if (id !== '') byId.set(id, description);
    if (code !== '') byCode.set(code, description);
  }
  return { byId, byCode };
}

/** Value of the first column whose compact name starts with `wweia` and (not) contains `description`. */
function wweiaColumn(row: Row, wantDescription: boolean): string {
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith('wweia')) continue;
    if (key.includes('description') !== wantDescription) continue;
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return '';
}

/** wweia_food_category.csv: code -> description. */
export async function readWweiaCategories(rows: AsyncIterable<Row>): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for await (const row of rows) {
    const code = wweiaColumn(row, false);
    const description = wweiaColumn(row, true) || field(row, 'description');
    if (code !== '' && description !== '') map.set(code, description);
  }
  return map;
}

/** survey_fndds_food.csv: fdc_id -> wweia category code. */
export async function readSurveyCategoryCodes(rows: AsyncIterable<Row>): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  for await (const row of rows) {
    const id = intOrNull(field(row, 'fdcid'));
    const code = wweiaColumn(row, false);
    if (id !== null && code !== '') map.set(id, code);
  }
  return map;
}

/** measure_unit.csv: id -> name (the real file has only `id,name`). */
export async function readMeasureUnits(rows: AsyncIterable<Row>): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for await (const row of rows) {
    const id = field(row, 'id');
    const name = field(row, 'name');
    if (id !== '' && name !== '') map.set(id, name);
  }
  return map;
}

// ------------------------------------------------------------------ foods

export interface FdcFoodHeader {
  name: string;
  categoryRaw: string;
}

/**
 * food.csv: foods of one `data_type`, in file order, at most `limit` of them.
 * `foodsFound` counts the matching rows read.
 */
export async function readFoods(
  rows: AsyncIterable<Row>,
  dataType: string,
  stats: DatasetStats,
  limit?: number,
): Promise<Map<number, FdcFoodHeader>> {
  const foods = new Map<number, FdcFoodHeader>();
  for await (const row of rows) {
    if (field(row, 'datatype') !== dataType) continue;
    const id = intOrNull(field(row, 'fdcid'));
    if (id === null || foods.has(id)) continue;
    stats.foodsFound += 1;
    foods.set(id, { name: field(row, 'description'), categoryRaw: field(row, 'foodcategoryid', 'foodcategory') });
    if (limit !== undefined && foods.size >= limit) break;
  }
  return foods;
}

/**
 * food_nutrient.csv streaming + grouping: `fdc_id -> (nutrient_id -> amount)` for
 * wanted foods and tracked nutrient ids only. Negative / non-numeric amounts are
 * dropped (counted in `stats.invalidAmounts`); on duplicate (food, nutrient)
 * rows the first one wins. Rows may come in any order.
 */
export async function collectFoodNutrients(
  rows: AsyncIterable<Row>,
  wantedFoods: ReadonlySet<number>,
  wantedNutrients: ReadonlySet<number>,
  stats: DatasetStats,
  log?: Logger,
): Promise<Map<number, Map<number, number>>> {
  const grouped = new Map<number, Map<number, number>>();
  let scanned = 0;
  for await (const row of rows) {
    scanned += 1;
    if (log && scanned % 1_000_000 === 0) log(`  food_nutrient.csv: ${scanned.toLocaleString('en-US')} rows scanned`);
    const fdcId = intOrNull(field(row, 'fdcid'));
    if (fdcId === null || !wantedFoods.has(fdcId)) continue;
    const nutrientId = intOrNull(field(row, 'nutrientid'));
    if (nutrientId === null) continue;
    if (!wantedNutrients.has(nutrientId)) {
      bumpUnmapped(stats, nutrientId, '', ''); // names are filled in from nutrient.csv by the loader
      continue;
    }
    const { value: amount, clamped } = sanitizeAmount(parseDecimal(row.amount), BY_DIFFERENCE_CARB_IDS.has(nutrientId));
    if (clamped) stats.clampedAmounts += 1;
    if (amount === null) {
      if ((row.amount ?? '').trim() !== '') stats.invalidAmounts += 1; // blank = just missing
      continue;
    }
    let perFood = grouped.get(fdcId);
    if (perFood === undefined) {
      perFood = new Map();
      grouped.set(fdcId, perFood);
    }
    if (!perFood.has(nutrientId)) perFood.set(nutrientId, amount);
  }
  return grouped;
}

/** food_portion.csv: `fdc_id -> portion candidates` for wanted foods. */
export async function collectFoodPortions(
  rows: AsyncIterable<Row>,
  wantedFoods: ReadonlySet<number>,
  measureUnits: ReadonlyMap<string, string>,
  stats: DatasetStats,
): Promise<Map<number, PortionCandidate[]>> {
  const grouped = new Map<number, PortionCandidate[]>();
  for await (const row of rows) {
    const fdcId = intOrNull(field(row, 'fdcid'));
    if (fdcId === null || !wantedFoods.has(fdcId)) continue;
    const candidate = buildFdcPortion({
      seq: intOrNull(field(row, 'seqnum')),
      amount: parseDecimal(row.amount),
      unitName: measureUnits.get(field(row, 'measureunitid')) ?? field(row, 'measureunit'),
      description: field(row, 'portiondescription'),
      modifier: field(row, 'modifier'),
      grams: parseDecimal(row.gramweight),
    });
    if (candidate === null) {
      stats.portionsDropped += 1;
      continue;
    }
    const list = grouped.get(fdcId) ?? [];
    list.push(candidate);
    grouped.set(fdcId, list);
  }
  return grouped;
}

// ------------------------------------------------------------------ loader

export interface LoadFdcOptions {
  dataset: FdcDatasetId;
  /** Only the first N foods of food.csv (for testing). */
  limit?: number;
  log?: Logger;
}

/** Loads one FDC dataset from an opened zip / directory source. */
export async function loadFdc(src: FileSource, opts: LoadFdcOptions): Promise<LoadResult> {
  const cfg = FDC_DATASETS[opts.dataset];
  const log: Logger = opts.log ?? (() => {});
  const stats = newStats(cfg.source);

  const absent = REQUIRED_CSV.filter((f) => !src.has(f));
  if (absent.length > 0) throw new Error(incompleteArchiveMessage(src, cfg.label, absent));
  const csv = (name: string) => counted(readCsvFile(src, name, { encoding: 'utf8' }), stats, name);
  const optionalCsv = (name: string): AsyncIterable<Row> | null => (src.has(name) ? csv(name) : null);

  const rules = buildFdcRules();
  const meta = await readNutrientMeta(csv('nutrient.csv'));
  stats.warnings.push(...catalogChecks(meta, rules));
  const unitOf = (id: number): string | undefined => meta.get(id)?.unit;

  // Categories
  const categoryRows = optionalCsv('food_category.csv');
  const categories = categoryRows ? await readFoodCategories(categoryRows) : { byId: new Map(), byCode: new Map() };
  let wweia = new Map<string, string>();
  let surveyCodes = new Map<number, string>();
  if (opts.dataset === 'fndds') {
    const w = optionalCsv('wweia_food_category.csv');
    if (w) wweia = await readWweiaCategories(w);
    const s = optionalCsv('survey_fndds_food.csv');
    if (s) surveyCodes = await readSurveyCategoryCodes(s);
  }

  // Foods
  const foods = await readFoods(csv('food.csv'), cfg.dataType, stats, opts.limit);
  log(`${cfg.label}: ${foods.size.toLocaleString('en-US')} food(s) of data_type "${cfg.dataType}"${opts.limit !== undefined ? ` (limit ${opts.limit})` : ''}`);
  if (foods.size === 0) {
    stats.warnings.push(`no foods with data_type "${cfg.dataType}" in food.csv`);
    return { foods: [], stats };
  }
  const wantedFoods: ReadonlySet<number> = new Set(foods.keys());

  // Portions
  const measureRows = optionalCsv('measure_unit.csv');
  const measureUnits = measureRows ? await readMeasureUnits(measureRows) : new Map<string, string>();
  const portionRows = optionalCsv('food_portion.csv');
  const portions = portionRows
    ? await collectFoodPortions(portionRows, wantedFoods, measureUnits, stats)
    : new Map<number, PortionCandidate[]>();
  if (!portionRows) stats.warnings.push('food_portion.csv not found: only "100 g" portions will be created');

  // Nutrients (the big one, streamed)
  const amounts = await collectFoodNutrients(csv('food_nutrient.csv'), wantedFoods, rules.ids, stats, log);
  for (const [id, info] of stats.unmapped) {
    const m = meta.get(id);
    if (m) {
      info.name = m.name;
      info.unit = m.unit;
    }
  }

  const resolveCategory = (id: number, raw: string): string | null => {
    if (opts.dataset === 'fndds') {
      const code = surveyCodes.get(id);
      const fromSurvey = code !== undefined ? wweia.get(code) : undefined;
      if (fromSurvey) return fromSurvey;
      return raw !== '' && !/^\d+$/.test(raw) ? raw : null; // food.csv sometimes holds the WWEIA text
    }
    if (raw === '') return null;
    return categories.byId.get(raw) ?? categories.byCode.get(raw) ?? (/^\d+$/.test(raw) ? null : raw);
  };

  const result = [];
  for (const [id, header] of foods) {
    const food = assembleFood(
      {
        source: cfg.source,
        sourceId: String(id),
        rawName: header.name,
        rawCategory: resolveCategory(id, header.categoryRaw),
        amounts: amounts.get(id) ?? new Map(),
        rules,
        unitOf,
        portions: portions.get(id) ?? [],
      },
      stats,
    );
    if (food) result.push(food);
  }
  log(`${cfg.label}: kept ${stats.kept.toLocaleString('en-US')} of ${foods.size.toLocaleString('en-US')}`);
  return { foods: result, stats };
}
