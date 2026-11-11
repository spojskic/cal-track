/**
 * Canadian Nutrient File (CNF) 2015 loader - source 'cnf', kind 'generic'.
 *
 * Layout (Health Canada "CNF 2015" CSV download, written from knowledge of the
 * published data dictionary - verify against a real download):
 *
 *   FOOD NAME.csv         FoodID, FoodCode, FoodGroupID, FoodSourceID, FoodDescription, FoodDescriptionF, ...
 *   NUTRIENT AMOUNT.csv   FoodID, NutrientID, NutrientValue, StandardError, NumberofObservations, ...
 *   NUTRIENT NAME.csv     NutrientID, NutrientCode, NutrientSymbol, NutrientUnit, NutrientName, ...
 *   CONVERSION FACTOR.csv FoodID, MeasureID, ConversionFactorValue, ...
 *   MEASURE NAME.csv      MeasureID, MeasureDescription, MeasureDescriptionF
 *   FOOD GROUP.csv        FoodGroupID, FoodGroupCode, FoodGroupName, FoodGroupNameF   (optional)
 *
 * Nutrient values are per 100 g of edible portion. NutrientCode is the Health
 * Canada code, which equals the legacy USDA `nutrient_nbr` for most nutrients
 * (208 energy kcal, 203 protein, 204 fat, 205 carbohydrate ...). The code table
 * below was built from FDC `nutrient.csv` `nutrient_nbr` values.
 *
 * ConversionFactorValue: the CNF data dictionary defines it as a multiplier for
 * the per-100 g values (grams = factor x 100). Some task notes describe it as
 * grams per measure; `factorMode: 'auto'` detects which one a file uses from
 * the median factor (multipliers ~0.05-3, grams ~5-300).
 *
 * Headers are matched case/space/BOM-insensitively; files may be UTF-8 (with or
 * without BOM) or ISO-8859-1 / windows-1252 (auto-detected, or `--encoding`).
 */
import type { NutrientCode } from '@ration/core';
import { assembleFood } from './build';
import { field, parseDecimal, readCsvFile, type Row } from './csv';
import { RuleSet, sanitizeAmount, type MappingRule } from './mapping';
import { portionFromLabel, type PortionCandidate } from './portions';
import type { FileSource } from './source';
import { newStats, type EnergySource, type LoadResult, type Logger } from './types';

/** Health Canada nutrient code -> catalog nutrient (order within a nutrient = priority). */
const CNF_CODES: ReadonlyArray<readonly [number, NutrientCode]> = [
  [208, 'ENERGY_KCAL'],
  [255, 'WATER_G'],
  [221, 'ALCOHOL_G'],
  [262, 'CAFFEINE_MG'],
  [263, 'THEOBROMINE_MG'],
  [207, 'ASH_G'],
  // carbs
  [205, 'CARBS_G'],
  [291, 'FIBER_G'],
  [295, 'SOLUBLE_FIBER_G'],
  [297, 'INSOLUBLE_FIBER_G'],
  [209, 'STARCH_G'],
  [269, 'SUGARS_G'],
  [539, 'ADDED_SUGARS_G'],
  [299, 'SUGAR_ALCOHOLS_G'],
  [210, 'SUCROSE_G'],
  [211, 'GLUCOSE_G'],
  [212, 'FRUCTOSE_G'],
  [213, 'LACTOSE_G'],
  [214, 'MALTOSE_G'],
  [287, 'GALACTOSE_G'],
  // lipids
  [204, 'FAT_G'],
  [606, 'SATURATED_FAT_G'],
  [645, 'MONOUNSATURATED_FAT_G'],
  [646, 'POLYUNSATURATED_FAT_G'],
  [605, 'TRANS_FAT_G'],
  [601, 'CHOLESTEROL_MG'],
  [851, 'ALA_G'],
  [629, 'EPA_G'],
  [631, 'DPA_G'],
  [621, 'DHA_G'],
  [675, 'LINOLEIC_G'],
  [620, 'ARACHIDONIC_G'],
  // protein + amino acids
  [203, 'PROTEIN_G'],
  [501, 'TRYPTOPHAN_G'],
  [502, 'THREONINE_G'],
  [503, 'ISOLEUCINE_G'],
  [504, 'LEUCINE_G'],
  [505, 'LYSINE_G'],
  [506, 'METHIONINE_G'],
  [507, 'CYSTINE_G'],
  [508, 'PHENYLALANINE_G'],
  [509, 'TYROSINE_G'],
  [510, 'VALINE_G'],
  [511, 'ARGININE_G'],
  [512, 'HISTIDINE_G'],
  [513, 'ALANINE_G'],
  [514, 'ASPARTIC_ACID_G'],
  [515, 'GLUTAMIC_ACID_G'],
  [516, 'GLYCINE_G'],
  [517, 'PROLINE_G'],
  [518, 'SERINE_G'],
  [521, 'HYDROXYPROLINE_G'],
  // vitamins
  [320, 'VITAMIN_A_UG'], // retinol activity equivalents (RAE)
  [319, 'RETINOL_UG'],
  [321, 'BETA_CAROTENE_UG'],
  [322, 'ALPHA_CAROTENE_UG'],
  [334, 'BETA_CRYPTOXANTHIN_UG'],
  [337, 'LYCOPENE_UG'],
  [338, 'LUTEIN_ZEAXANTHIN_UG'],
  [401, 'VITAMIN_C_MG'],
  [328, 'VITAMIN_D_UG'],
  [323, 'VITAMIN_E_MG'],
  [430, 'VITAMIN_K_UG'],
  [428, 'VITAMIN_K2_UG'],
  [404, 'B1_THIAMIN_MG'],
  [405, 'B2_RIBOFLAVIN_MG'],
  [406, 'B3_NIACIN_MG'],
  [410, 'B5_PANTOTHENIC_MG'],
  [415, 'B6_MG'],
  [416, 'B7_BIOTIN_UG'],
  [435, 'FOLATE_UG'], // dietary folate equivalents (DFE)
  [431, 'FOLIC_ACID_UG'],
  [418, 'B12_UG'],
  [421, 'CHOLINE_MG'],
  [454, 'BETAINE_MG'],
  // minerals
  [301, 'CALCIUM_MG'],
  [303, 'IRON_MG'],
  [304, 'MAGNESIUM_MG'],
  [305, 'PHOSPHORUS_MG'],
  [306, 'POTASSIUM_MG'],
  [307, 'SODIUM_MG'],
  [309, 'ZINC_MG'],
  [312, 'COPPER_MG'],
  [315, 'MANGANESE_MG'],
  [317, 'SELENIUM_UG'],
  [313, 'FLUORIDE_UG'],
  [314, 'IODINE_UG'],
  [310, 'CHROMIUM_UG'],
  [316, 'MOLYBDENUM_UG'],
];

/** Rules that need a fixed conversion (fallbacks, lower priority than the entries above). */
const CNF_CONVERTED: readonly MappingRule[] = [
  { id: 268, code: 'ENERGY_KCAL', factor: 1 / 4.184, expectUnit: 'kj' },
  { id: 324, code: 'VITAMIN_D_UG', factor: 1 / 40, expectUnit: 'iu' },
];

/** Builds the CNF rule set (ids = Health Canada nutrient codes). */
export function buildCnfRules(): RuleSet {
  const rules: MappingRule[] = CNF_CODES.map(([id, code]) => ({ id, code }));
  return new RuleSet([...rules, ...CNF_CONVERTED]);
}

const CNF_ENERGY_SOURCE: Record<number, EnergySource> = { 208: 'kcal', 268: 'kj' };

export type CnfFactorMode = 'auto' | 'multiplier' | 'grams';

/** Chooses how to read ConversionFactorValue from the median of all factors. */
export function detectFactorMode(factors: readonly number[]): 'multiplier' | 'grams' {
  const positive = factors.filter((f) => f > 0).sort((a, b) => a - b);
  if (positive.length === 0) return 'multiplier';
  const median = positive[Math.floor(positive.length / 2)] ?? 0;
  return median >= 10 ? 'grams' : 'multiplier';
}

export interface LoadCnfOptions {
  /** `auto` (default), `utf8` or `latin1`. */
  encoding?: string;
  factorMode?: CnfFactorMode;
  limit?: number;
  log?: Logger;
}

const intOrNull = (s: string): number | null => {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
};

/** Loads the CNF from a directory or zip of the CSV download. */
export async function loadCnf(src: FileSource, opts: LoadCnfOptions = {}): Promise<LoadResult> {
  const log: Logger = opts.log ?? (() => {});
  const stats = newStats('cnf');
  const encoding = opts.encoding ?? 'auto';

  for (const required of ['FOOD NAME.csv', 'NUTRIENT AMOUNT.csv', 'NUTRIENT NAME.csv']) {
    if (!src.has(required)) {
      throw new Error(
        `"${required}" not found in the CNF input (found: ${src.list().join(', ') || 'no CSV files'}). ` +
          'Download the "Canadian Nutrient File 2015" CSV files from Health Canada (see README).',
      );
    }
  }
  const csv = async function* (name: string): AsyncGenerator<Row> {
    let n = 0;
    try {
      for await (const row of readCsvFile(src, name, { encoding })) {
        n += 1;
        yield row;
      }
    } finally {
      stats.rowsRead[name] = n;
    }
  };

  const rules = buildCnfRules();

  // NUTRIENT NAME: internal id -> Health Canada code + unit
  const codeById = new Map<number, number>();
  const unitByCode = new Map<number, string>();
  for await (const row of csv('NUTRIENT NAME.csv')) {
    const id = intOrNull(field(row, 'nutrientid'));
    if (id === null) continue;
    const code = intOrNull(field(row, 'nutrientcode')) ?? id;
    if (!codeById.has(id)) codeById.set(id, code);
    const unit = field(row, 'nutrientunit', 'unit');
    if (unit !== '' && !unitByCode.has(code)) unitByCode.set(code, unit);
  }
  if (codeById.size === 0) throw new Error('NUTRIENT NAME.csv has no usable rows (check headers / --encoding)');

  // FOOD GROUP (optional)
  const groups = new Map<string, string>();
  if (src.has('FOOD GROUP.csv')) {
    for await (const row of csv('FOOD GROUP.csv')) {
      const id = field(row, 'foodgroupid');
      const name = field(row, 'foodgroupname', 'name');
      if (id !== '' && name !== '') groups.set(id, name);
    }
  }

  // FOOD NAME
  const foods = new Map<number, { name: string; group: string }>();
  for await (const row of csv('FOOD NAME.csv')) {
    const id = intOrNull(field(row, 'foodid'));
    if (id === null || foods.has(id)) continue;
    stats.foodsFound += 1;
    foods.set(id, {
      name: field(row, 'fooddescription', 'foodname', 'description'),
      group: field(row, 'foodgroupid'),
    });
    if (opts.limit !== undefined && foods.size >= opts.limit) break;
  }
  log(`CNF: ${foods.size.toLocaleString('en-US')} food(s)`);
  if (foods.size === 0) {
    stats.warnings.push('FOOD NAME.csv has no usable rows (check headers / --encoding)');
    return { foods: [], stats };
  }

  // NUTRIENT AMOUNT -> per food (keyed by Health Canada code)
  const amounts = new Map<number, Map<number, number>>();
  for await (const row of csv('NUTRIENT AMOUNT.csv')) {
    const foodId = intOrNull(field(row, 'foodid'));
    if (foodId === null || !foods.has(foodId)) continue;
    const nutrientId = intOrNull(field(row, 'nutrientid'));
    if (nutrientId === null) continue;
    const code = codeById.get(nutrientId);
    if (code === undefined || !rules.ids.has(code)) continue;
    const { value, clamped } = sanitizeAmount(parseDecimal(row.nutrientvalue), code === 205);
    if (clamped) stats.clampedAmounts += 1;
    if (value === null) {
      if ((row.nutrientvalue ?? '').trim() !== '') stats.invalidAmounts += 1;
      continue;
    }
    let perFood = amounts.get(foodId);
    if (perFood === undefined) {
      perFood = new Map();
      amounts.set(foodId, perFood);
    }
    if (!perFood.has(code)) perFood.set(code, value);
  }

  // Portions: MEASURE NAME + CONVERSION FACTOR
  const measures = new Map<string, string>();
  if (src.has('MEASURE NAME.csv')) {
    for await (const row of csv('MEASURE NAME.csv')) {
      const id = field(row, 'measureid');
      const description = field(row, 'measuredescription', 'measurename', 'description');
      if (id !== '' && description !== '') measures.set(id, description);
    }
  }
  const conversions = new Map<number, Array<{ measureId: string; factor: number }>>();
  const allFactors: number[] = [];
  if (src.has('CONVERSION FACTOR.csv') && measures.size > 0) {
    for await (const row of csv('CONVERSION FACTOR.csv')) {
      const foodId = intOrNull(field(row, 'foodid'));
      if (foodId === null || !foods.has(foodId)) continue;
      const factor = parseDecimal(row.conversionfactorvalue);
      const measureId = field(row, 'measureid');
      if (factor === null || !(factor > 0) || !measures.has(measureId)) continue;
      const list = conversions.get(foodId) ?? [];
      list.push({ measureId, factor });
      conversions.set(foodId, list);
      allFactors.push(factor);
    }
  } else {
    stats.warnings.push('CONVERSION FACTOR.csv / MEASURE NAME.csv missing: only "100 g" portions will be created');
  }
  const mode: 'multiplier' | 'grams' =
    opts.factorMode === 'multiplier' || opts.factorMode === 'grams' ? opts.factorMode : detectFactorMode(allFactors);
  if (allFactors.length > 0) log(`CNF: ConversionFactorValue read as ${mode === 'grams' ? 'grams per measure' : 'multiplier of 100 g'}`);

  const unitOf = (code: number): string | undefined => unitByCode.get(code);
  const result = [];
  for (const [id, header] of foods) {
    const portions: PortionCandidate[] = [];
    for (const c of conversions.get(id) ?? []) {
      const label = measures.get(c.measureId);
      if (label === undefined) continue;
      const candidate = portionFromLabel(label, mode === 'grams' ? c.factor : c.factor * 100);
      if (candidate === null) stats.portionsDropped += 1;
      else portions.push(candidate);
    }
    const food = assembleFood(
      {
        source: 'cnf',
        sourceId: String(id),
        rawName: header.name,
        rawCategory: groups.get(header.group) ?? null,
        amounts: amounts.get(id) ?? new Map(),
        rules,
        unitOf,
        energySourceOf: (code) => CNF_ENERGY_SOURCE[code],
        portions,
      },
      stats,
    );
    if (food) result.push(food);
  }
  log(`CNF: kept ${stats.kept.toLocaleString('en-US')} of ${foods.size.toLocaleString('en-US')}`);
  return { foods: result, stats };
}
