/**
 * USDA FoodData Central JSON loader (Foundation Foods, SR Legacy, FNDDS Survey).
 *
 * JSON archives are the primary format: the whole FNDDS download is ~4 MB zipped
 * (64 MB of JSON) versus ~200 MB for the CSV tables, and the Foundation CSV
 * archive of the Oct 2026 release is incomplete.
 *
 * Shape (all three datasets): `{ "<Key>": [ food, food, ... ] }` with
 * Key = FoundationFoods | SurveyFoods | SRLegacyFoods, and per food
 *   { fdcId, description, dataType, foodCategory: {description},
 *     wweiaFoodCategory: {wweiaFoodCategoryDescription} (Survey),
 *     foodNutrients: [{ nutrient: {id, number, name, rank, unitName}, amount, ... }],
 *     foodPortions:  [{ amount, value, measureUnit: {name}, modifier, portionDescription,
 *                       gramWeight, sequenceNumber }], ... }
 *
 * The file is NOT parsed as one value: {@link splitJsonArray} cuts the top-level
 * array into one JSON text per food while streaming, so memory is bounded by the
 * largest single food (~100 KB), whatever the file size.
 *
 * Duplicate nutrient entries (same `nutrient.id` twice for a food; none occur in
 * the Oct 2026 Foundation file): `nutrient.rank` is a property of the nutrient,
 * not of the entry, so it cannot rank duplicates. The FIRST entry with a usable
 * amount wins (the same rule as the CSV loader); entries without `amount` are
 * skipped. Different ids for one catalog nutrient (Atwater energy, kJ, vitamin D
 * IU, ...) follow the priority chain in mapping.ts.
 */
import { assembleFood } from './build';
import { decodeBytes, parseDecimal } from './csv';
import { FDC_DATASETS, catalogChecks, type FdcDatasetId, type NutrientMeta } from './fdc';
import { BY_DIFFERENCE_CARB_IDS, buildFdcRules, sanitizeAmount } from './mapping';
import { buildFdcPortion, type PortionCandidate } from './portions';
import type { FileSource } from './source';
import { bumpUnmapped, newStats, type ImportFood, type LoadResult, type Logger } from './types';

/** Top-level array key -> dataset. */
export const JSON_KEY_TO_DATASET: Readonly<Record<string, FdcDatasetId>> = {
  FoundationFoods: 'foundation',
  SurveyFoods: 'fndds',
  SRLegacyFoods: 'sr_legacy',
};

/** Known FDC JSON keys that this importer deliberately does not handle. */
const OUT_OF_SCOPE_KEYS: ReadonlySet<string> = new Set(['BrandedFoods']);

/** `food.dataType` values of the JSON files. */
const DATA_TYPE_TO_DATASET: Readonly<Record<string, FdcDatasetId>> = {
  foundation: 'foundation',
  'sr legacy': 'sr_legacy',
  'survey (fndds)': 'fndds',
};

// ------------------------------------------------------------------ splitter

export interface JsonArrayItem {
  /** Key of the array in the top-level object ('' for a top-level array). */
  key: string;
  /** Raw JSON text of one array element (an object). */
  json: string;
}

/**
 * Streams the elements of the first accepted array out of JSON text without
 * parsing the whole document: tracks string/escape state and bracket depth and
 * yields each object element of the array as its own JSON text.
 *
 * `acceptKey` decides which top-level `"key": [` arrays are iterated (a
 * top-level array is always accepted); other arrays are skipped. Iteration ends
 * after the first accepted array.
 */
export async function* splitJsonArray(
  text: AsyncIterable<string>,
  acceptKey: (key: string) => boolean = () => true,
): AsyncGenerator<JsonArrayItem> {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let keyBuf = '';
  let lastKey = '';
  let inArray = false;
  let arrayKey = '';
  let arrayDepth = 0; // depth INSIDE the accepted array (elements start here)
  let collecting = false;
  let pieces: string[] = [];

  for await (const chunk of text) {
    let start = 0; // start of the unflushed slice of the element being collected
    for (let i = 0; i < chunk.length; i += 1) {
      const c = chunk.charCodeAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (c === 0x5c) escaped = true; // backslash
        else if (c === 0x22) {
          inString = false;
          if (!inArray && depth === 1) lastKey = keyBuf;
        } else if (!inArray && depth === 1) keyBuf += chunk[i];
        continue;
      }
      if (c === 0x22) {
        inString = true;
        if (!inArray && depth === 1) keyBuf = '';
        continue;
      }
      if (c === 0x7b /* { */ || c === 0x5b /* [ */) {
        if (!inArray && c === 0x5b && (depth === 0 || depth === 1) && acceptKey(depth === 0 ? '' : lastKey)) {
          inArray = true;
          arrayKey = depth === 0 ? '' : lastKey;
          depth += 1;
          arrayDepth = depth;
          continue;
        }
        if (inArray && !collecting && depth === arrayDepth && c === 0x7b) {
          collecting = true;
          start = i;
          pieces = [];
        }
        depth += 1;
        continue;
      }
      if (c === 0x7d /* } */ || c === 0x5d /* ] */) {
        depth -= 1;
        if (collecting && depth === arrayDepth) {
          pieces.push(chunk.slice(start, i + 1));
          collecting = false;
          const json = pieces.join('');
          pieces = [];
          yield { key: arrayKey, json };
        } else if (inArray && !collecting && c === 0x5d && depth === arrayDepth - 1) {
          return; // end of the accepted array
        }
      }
    }
    if (collecting) {
      pieces.push(chunk.slice(start));
      start = 0;
    }
  }
}

// -------------------------------------------------------------------- loader

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function numberOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return parseDecimal(v);
  return null;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** `foodCategory` is `{description}` in the files; tolerate a plain string. */
function categoryOf(food: Json, dataset: FdcDatasetId): string {
  if (dataset === 'fndds') {
    const wweia = food.wweiaFoodCategory;
    if (isObject(wweia)) {
      const d = text(wweia.wweiaFoodCategoryDescription) || text(wweia.description);
      if (d !== '') return d;
    }
  }
  const c = food.foodCategory;
  if (isObject(c)) return text(c.description);
  return text(c) || text(food.foodCategoryDescription);
}

/** foodPortions -> candidates (`amount ?? value` units weigh `gramWeight`); counts unusable rows. */
function portionsOf(food: Json): { candidates: PortionCandidate[]; dropped: number } {
  const candidates: PortionCandidate[] = [];
  let dropped = 0;
  const list = Array.isArray(food.foodPortions) ? food.foodPortions : [];
  for (const raw of list) {
    if (!isObject(raw)) continue;
    const unit = isObject(raw.measureUnit) ? raw.measureUnit : {};
    const candidate = buildFdcPortion({
      seq: numberOrNull(raw.sequenceNumber),
      amount: numberOrNull(raw.amount) ?? numberOrNull(raw.value),
      unitName: text(unit.name),
      description: text(raw.portionDescription),
      modifier: text(raw.modifier),
      grams: numberOrNull(raw.gramWeight),
    });
    if (candidate) candidates.push(candidate);
    else dropped += 1;
  }
  return { candidates, dropped };
}

export interface LoadFdcJsonOptions {
  /** Expected dataset; inferred from the top-level key / dataType when omitted. */
  dataset?: FdcDatasetId;
  /** Which JSON file to read (default: the first one). */
  file?: string;
  /** Only the first N foods (for testing). */
  limit?: number;
  log?: Logger;
}

export interface LoadFdcJsonResult extends LoadResult {
  dataset: FdcDatasetId;
}

/** Loads one FDC dataset from the single .json file of a zip / directory / path. */
export async function loadFdcJson(src: FileSource, opts: LoadFdcJsonOptions = {}): Promise<LoadFdcJsonResult> {
  const log: Logger = opts.log ?? (() => {});
  const files = src.jsonNames();
  const file = opts.file ?? files[0];
  if (file === undefined) throw new Error('No .json file found in the input');

  const rules = buildFdcRules();
  const accept = (key: string): boolean => key === '' || key in JSON_KEY_TO_DATASET || OUT_OF_SCOPE_KEYS.has(key);
  const bytes = await src.open(file);

  let dataset: FdcDatasetId | undefined = opts.dataset;
  let stats = newStats(opts.dataset ? FDC_DATASETS[opts.dataset].source : 'fdc_sr_legacy');
  const foods: ImportFood[] = [];
  const meta = new Map<number, NutrientMeta>();
  let found = 0;
  let sawArray = false;

  try {
    for await (const item of splitJsonArray(decodeBytes(bytes, 'utf-8'), accept)) {
      if (!sawArray) {
        sawArray = true;
        if (OUT_OF_SCOPE_KEYS.has(item.key)) {
          throw new Error(`${file}: "${item.key}" (branded foods) is out of scope - generic foods only`);
        }
        const fromKey = item.key === '' ? undefined : JSON_KEY_TO_DATASET[item.key];
        if (fromKey !== undefined && opts.dataset !== undefined && fromKey !== opts.dataset) {
          throw new Error(
            `${file} contains "${item.key}" (dataset ${fromKey}) but --dataset ${opts.dataset} was given`,
          );
        }
        dataset = fromKey ?? opts.dataset;
        if (dataset !== undefined) stats = newStats(FDC_DATASETS[dataset].source);
      }

      let food: unknown;
      try {
        food = JSON.parse(item.json);
      } catch (err) {
        throw new Error(`${file}: invalid JSON in food #${found + 1}: ${(err as Error).message}`);
      }
      if (!isObject(food)) continue;

      if (dataset === undefined) {
        // top-level array without a key: infer from the food's own dataType
        dataset = DATA_TYPE_TO_DATASET[text(food.dataType).toLowerCase()];
        if (dataset === undefined) {
          throw new Error(`${file}: cannot tell which dataset this is - pass --dataset`);
        }
        stats = newStats(FDC_DATASETS[dataset].source);
      }
      found += 1;
      stats.foodsFound += 1;

      const fdcId = numberOrNull(food.fdcId);
      const amounts = new Map<number, number>();
      const units = new Map<number, string>();
      const entries = Array.isArray(food.foodNutrients) ? food.foodNutrients : [];
      for (const raw of entries) {
        if (!isObject(raw)) continue;
        const n = isObject(raw.nutrient) ? raw.nutrient : {};
        const id = numberOrNull(n.id) ?? numberOrNull(raw.nutrientId);
        if (id === null) continue;
        const unitName = text(n.unitName) || text(raw.unitName);
        if (!meta.has(id)) meta.set(id, { name: text(n.name) || text(raw.nutrientName), unit: unitName, nbr: text(n.number) });
        if (!rules.ids.has(id)) {
          bumpUnmapped(stats, id, text(n.name) || text(raw.nutrientName), unitName);
          continue;
        }
        const rawAmount = raw.amount ?? raw.value;
        const { value: amount, clamped } = sanitizeAmount(numberOrNull(rawAmount), BY_DIFFERENCE_CARB_IDS.has(id));
        if (clamped) stats.clampedAmounts += 1;
        if (amount === null) {
          if (rawAmount !== undefined && rawAmount !== null) stats.invalidAmounts += 1; // negative / not a number
          continue; // no amount: nothing to import
        }
        if (!amounts.has(id)) {
          amounts.set(id, amount);
          units.set(id, unitName);
        }
      }

      const { candidates, dropped: droppedPortions } = portionsOf(food);
      stats.portionsDropped += droppedPortions;

      const imported =
        fdcId === null
          ? null
          : assembleFood(
              {
                source: FDC_DATASETS[dataset].source,
                sourceId: String(fdcId),
                rawName: text(food.description),
                rawCategory: categoryOf(food, dataset) || null,
                amounts,
                rules,
                unitOf: (id) => units.get(id),
                portions: candidates,
              },
              stats,
            );
      if (fdcId === null) stats.dropped.no_name += 1; // a food without fdcId has no usable identity
      if (imported) foods.push(imported);
      if (found % 1000 === 0) log(`  ${found.toLocaleString('en-US')} foods parsed`);
      if (opts.limit !== undefined && found >= opts.limit) break;
    }
  } finally {
    bytes.destroy();
  }

  if (!sawArray) {
    throw new Error(
      `${file}: no FoundationFoods / SurveyFoods / SRLegacyFoods array found - is this an FDC JSON download?`,
    );
  }
  const resolved = dataset as FdcDatasetId;
  stats.rowsRead[file] = found;
  stats.warnings.push(...catalogChecks(meta, rules, { reportAbsent: false }));
  const label = FDC_DATASETS[resolved].label;
  log(`${label} (JSON): kept ${stats.kept.toLocaleString('en-US')} of ${found.toLocaleString('en-US')}`);
  return { foods, stats, dataset: resolved, label };
}
