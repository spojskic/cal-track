import { KCAL_PER_G } from './diary';
import { NUTRIENTS, NUTRIENT_BY_CODE, type NutrientCode } from './nutrients';
import type { CarbBasis, NutrientMap } from './types';

/*
 * Nutrition label vocabulary and the mapping from "what a label says" to a new-food draft.
 *
 * Used by the AI "scan nutrition label" feature, but nothing here knows about AI or the network:
 *   - LABEL_NUTRIENTS is the FIXED list of keys a label reading may contain. Every key maps one-to-one to a
 *     catalog nutrient code, except the two that labels print instead of a catalog nutrient: energy in kJ and salt.
 *   - convertLabelAmount() converts a printed amount into the unit the key is stored in.
 *   - labelToFoodDraft() turns a reading into the values for the food form: kJ -> kcal, salt -> sodium, units,
 *     serving size, carbohydrate basis, and the list of values the user must double check.
 *
 * Nothing is estimated except the conversions listed above; whatever a conversion had to assume is reported in
 * `notes`, in plain words, so the screen can show it next to the form.
 */

// ------------------------------------------------------------------------------------------------ constants

/** 1 kcal = 4.184 kJ. */
export const KJ_PER_KCAL = 4.184;
/** Salt (sodium chloride) contains 40 % sodium by weight: salt = sodium x 2.5. */
export const SALT_PER_SODIUM = 2.5;
/** 40 IU of vitamin D = 1 ug (the same factor the food importer uses). */
export const IU_PER_UG_VITAMIN_D = 40;

/** Assumed density of a liquid whose label is given per ml and that has no stated density. */
export const ASSUMED_DENSITY_G_PER_ML = 1;

// ------------------------------------------------------------------------------------------------ vocabulary

/** What the printed amounts are about, as printed on the label. */
export const LABEL_BASES = ['per_100g', 'per_100ml', 'per_serving'] as const;
export type LabelBasis = (typeof LABEL_BASES)[number];

/** Units a label prints. `mcg` is micrograms (ug). */
export const LABEL_UNITS = ['kcal', 'kj', 'g', 'mg', 'mcg', 'iu'] as const;
export type LabelUnit = (typeof LABEL_UNITS)[number];

/** Unit a label key is stored in (never `iu`). */
export type LabelStorageUnit = Exclude<LabelUnit, 'iu'>;

export interface LabelNutrientInfo {
  key: LabelNutrientKey;
  /** Catalog code the key is stored under; null for energy in kJ and salt (they are converted). */
  code: NutrientCode | null;
  /** Unit of the amount after conversion (the catalog unit, with ug written as mcg). */
  unit: LabelStorageUnit;
  /** Name for messages. */
  name: string;
  /** How the label usually calls it (part of the model prompt). */
  hint: string;
}

type RawEntry = readonly [code: NutrientCode | null, name: string, hint: string, unit?: LabelStorageUnit];

// The order is the order of the label. Add a key here and the schema, the prompt and the mapping follow.
const RAW = {
  energy_kcal: ['ENERGY_KCAL', 'Energy', 'Energy in kilocalories (kcal), "Calories"'],
  energy_kj: [null, 'Energy (kJ)', 'Energy in kilojoules (kJ)', 'kj'],
  fat: ['FAT_G', 'Fat', '"Fat", "Total fat"'],
  saturated_fat: ['SATURATED_FAT_G', 'Saturated fat', '"of which saturates", "Saturated fat"'],
  trans_fat: ['TRANS_FAT_G', 'Trans fat', '"Trans fat"'],
  monounsaturated_fat: ['MONOUNSATURATED_FAT_G', 'Monounsaturated fat', '"of which mono-unsaturates"'],
  polyunsaturated_fat: ['POLYUNSATURATED_FAT_G', 'Polyunsaturated fat', '"of which polyunsaturates"'],
  cholesterol: ['CHOLESTEROL_MG', 'Cholesterol', '"Cholesterol"'],
  sodium: ['SODIUM_MG', 'Sodium', '"Sodium" (not salt)'],
  salt: [null, 'Salt', '"Salt" (the EU/UK line; not sodium)', 'g'],
  carbohydrate: ['CARBS_G', 'Carbohydrate', '"Carbohydrate", "Total carbohydrate" (the total line, not the sugars line)'],
  fibre: ['FIBER_G', 'Fibre', '"Fibre", "Fiber", "Dietary fiber"'],
  sugars: ['SUGARS_G', 'Sugars', '"of which sugars", "Total sugars"'],
  added_sugars: ['ADDED_SUGARS_G', 'Added sugars', '"Includes added sugars"'],
  polyols: ['SUGAR_ALCOHOLS_G', 'Sugar alcohols', '"polyols", "Sugar alcohol"'],
  starch: ['STARCH_G', 'Starch', '"of which starch"'],
  protein: ['PROTEIN_G', 'Protein', '"Protein"'],
  vitamin_a: ['VITAMIN_A_UG', 'Vitamin A', '"Vitamin A" (mcg RAE or ug RE)'],
  vitamin_c: ['VITAMIN_C_MG', 'Vitamin C', '"Vitamin C"'],
  vitamin_d: ['VITAMIN_D_UG', 'Vitamin D', '"Vitamin D"'],
  vitamin_e: ['VITAMIN_E_MG', 'Vitamin E', '"Vitamin E"'],
  vitamin_k: ['VITAMIN_K_UG', 'Vitamin K', '"Vitamin K"'],
  thiamin: ['B1_THIAMIN_MG', 'Thiamin (B1)', '"Thiamin", "Thiamine", "Vitamin B1"'],
  riboflavin: ['B2_RIBOFLAVIN_MG', 'Riboflavin (B2)', '"Riboflavin", "Vitamin B2"'],
  niacin: ['B3_NIACIN_MG', 'Niacin (B3)', '"Niacin", "Vitamin B3"'],
  pantothenic_acid: ['B5_PANTOTHENIC_MG', 'Pantothenic acid (B5)', '"Pantothenic acid", "Vitamin B5"'],
  vitamin_b6: ['B6_MG', 'Vitamin B6', '"Vitamin B6"'],
  biotin: ['B7_BIOTIN_UG', 'Biotin (B7)', '"Biotin"'],
  folate: ['FOLATE_UG', 'Folate', '"Folate", "Folic acid", "Folacin"'],
  vitamin_b12: ['B12_UG', 'Vitamin B12', '"Vitamin B12"'],
  choline: ['CHOLINE_MG', 'Choline', '"Choline"'],
  calcium: ['CALCIUM_MG', 'Calcium', '"Calcium"'],
  iron: ['IRON_MG', 'Iron', '"Iron"'],
  magnesium: ['MAGNESIUM_MG', 'Magnesium', '"Magnesium"'],
  phosphorus: ['PHOSPHORUS_MG', 'Phosphorus', '"Phosphorus"'],
  potassium: ['POTASSIUM_MG', 'Potassium', '"Potassium"'],
  zinc: ['ZINC_MG', 'Zinc', '"Zinc"'],
  copper: ['COPPER_MG', 'Copper', '"Copper"'],
  manganese: ['MANGANESE_MG', 'Manganese', '"Manganese"'],
  selenium: ['SELENIUM_UG', 'Selenium', '"Selenium"'],
  iodine: ['IODINE_UG', 'Iodine', '"Iodine"'],
  chromium: ['CHROMIUM_UG', 'Chromium', '"Chromium"'],
  molybdenum: ['MOLYBDENUM_UG', 'Molybdenum', '"Molybdenum"'],
  caffeine: ['CAFFEINE_MG', 'Caffeine', '"Caffeine"'],
} as const satisfies Record<string, RawEntry>;

/** The fixed list of keys a label reading may contain. */
export type LabelNutrientKey = keyof typeof RAW;

export const LABEL_NUTRIENT_KEYS = Object.keys(RAW) as [LabelNutrientKey, ...LabelNutrientKey[]];

function storageUnit(code: NutrientCode): LabelStorageUnit {
  const unit = NUTRIENT_BY_CODE[code].unit;
  if (unit === 'ug') return 'mcg';
  if (unit === 'kcal' || unit === 'g' || unit === 'mg') return unit;
  throw new Error(`Label nutrient ${code} has unit ${unit}, which a label cannot print`);
}

export const LABEL_NUTRIENTS: Readonly<Record<LabelNutrientKey, LabelNutrientInfo>> = Object.fromEntries(
  (Object.entries(RAW) as [LabelNutrientKey, RawEntry][]).map(([key, [code, name, hint, unit]]) => [
    key,
    { key, code, name, hint, unit: code ? storageUnit(code) : (unit as LabelStorageUnit) } satisfies LabelNutrientInfo,
  ]),
) as Record<LabelNutrientKey, LabelNutrientInfo>;

/** True for a key of the fixed list. */
export function isLabelNutrientKey(value: string): value is LabelNutrientKey {
  return Object.prototype.hasOwnProperty.call(RAW, value);
}

/** Catalog codes that have a label key (the nutrients a scan can fill in), in catalog order. */
export const LABEL_NUTRIENT_CODES: readonly NutrientCode[] = NUTRIENTS.filter((n) =>
  Object.values(LABEL_NUTRIENTS).some((info) => info.code === n.code),
).map((n) => n.code);

// ------------------------------------------------------------------------------------------------ reading

/** Fields of a reading (other than nutrients) the model can mark as unclear. */
export const LABEL_FIELDS = ['productName', 'brand', 'basis', 'servingSize', 'servingsPerContainer'] as const;
export type LabelField = (typeof LABEL_FIELDS)[number];

export interface LabelNutrientReading {
  key: LabelNutrientKey;
  /** As printed, in `unit`. */
  amount: number;
  unit: LabelUnit;
  /** The reader could not read this value with confidence. */
  unclear: boolean;
}

/** What the label says (validated and cleaned up; see `@cal/ai` runLabelPipeline). */
export interface LabelReading {
  productName: string | null;
  brand: string | null;
  basis: LabelBasis;
  /** One serving as printed. `amount`/`unit` are the metric part ("55 g"), `text` the household part ("2/3 cup"). */
  serving: { amount: number | null; unit: 'g' | 'ml' | null; text: string | null };
  servingsPerContainer: number | null;
  /** True: the carbohydrate figure includes fibre (US style). False: fibre is listed separately (EU style). */
  carbohydrateIncludesFibre: boolean | null;
  nutrients: LabelNutrientReading[];
  unclearFields: LabelField[];
  /** The reader's own remarks (a second column, "as prepared", a cropped panel, ...). */
  notes: string | null;
  /** Remarks of the app's own checks while cleaning up the reading (a value that was dropped, ...). */
  warnings: string[];
}

// ------------------------------------------------------------------------------------------------ amounts

const MASS_IN_G = { g: 1, mg: 1e-3, mcg: 1e-6 } as const;

function isMass(unit: LabelUnit): unit is keyof typeof MASS_IN_G {
  return unit === 'g' || unit === 'mg' || unit === 'mcg';
}

/** Removes floating point noise (0.07 g x 1000 = 70.00000000000001) without rounding real digits. */
function clean(value: number): number {
  return Number(value.toPrecision(10));
}

function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/**
 * Converts an amount printed in `unit` into the unit `key` is stored in (see LABEL_NUTRIENTS[key].unit), or null when
 * that cannot be done reliably: a negative or non-finite amount, a unit of a different kind (grams for energy), or IU
 * of anything but vitamin D (the IU of vitamin A and E depend on the form of the vitamin, so they are never guessed).
 */
export function convertLabelAmount(key: LabelNutrientKey, amount: number, unit: LabelUnit): number | null {
  if (!Number.isFinite(amount) || amount < 0) return null;
  const target = LABEL_NUTRIENTS[key].unit;
  if (unit === target) return amount;
  if (target === 'kcal' && unit === 'kj') return clean(amount / KJ_PER_KCAL);
  if (target === 'kj' && unit === 'kcal') return clean(amount * KJ_PER_KCAL);
  if (unit === 'iu') return key === 'vitamin_d' ? clean(amount / IU_PER_UG_VITAMIN_D) : null;
  if (isMass(unit) && isMass(target)) return clean((amount * MASS_IN_G[unit]) / MASS_IN_G[target]);
  return null;
}

/** Largest amount (in the printed unit) that can appear on a label of this basis. Above it the value is a misread. */
export function maxLabelAmount(unit: LabelUnit, basis: LabelBasis): number {
  const per100 = basis !== 'per_serving';
  switch (unit) {
    case 'kcal':
      return per100 ? 1000 : 5000;
    case 'kj':
      return per100 ? 4200 : 21000;
    case 'g':
      return per100 ? 100 : 1000;
    case 'mg':
      return 100_000;
    case 'mcg':
    case 'iu':
      return 1_000_000;
  }
}

/** True for a finite amount of 0 or more that is not above {@link maxLabelAmount}. */
export function isPlausibleLabelAmount(amount: number, unit: LabelUnit, basis: LabelBasis): boolean {
  return Number.isFinite(amount) && amount >= 0 && amount <= maxLabelAmount(unit, basis);
}

// ------------------------------------------------------------------------------------------------ draft

/** Form fields (other than nutrients) that can carry a "check this" marker. */
export type LabelFormField = 'name' | 'brand' | 'serving' | 'basis' | 'carbBasis';

/** The new-food form, filled in from a label. The shape matches the form's `initial` values. */
export interface LabelFoodDraft {
  name: string | null;
  brand: string | null;
  /** What `nutrients` are per: 100 g of the food, or 1 serving (the first entry of `servings`). */
  basis: 'per100g' | 'perServing';
  /** Catalog units. Per `basis`. */
  nutrients: NutrientMap;
  carbBasis: CarbBasis;
  /** Set (to 1) only when the label is in ml. */
  densityGPerMl: number | null;
  /** The printed serving; `grams` is null when it could not be read (the form then asks for it). */
  servings: { name: string; grams: number | null }[];
  /** Nutrients the reader was unsure about, or that failed a consistency check. Catalog order. */
  unclear: NutrientCode[];
  unclearFields: LabelFormField[];
  /** Plain-language remarks to show next to the form: the reader's, then what the app converted or assumed. */
  notes: string[];
}

export interface LabelDraftOptions {
  /** Carbohydrate basis to use when the label does not say. The app's default is `includes_fiber`. */
  defaultCarbBasis?: CarbBasis;
}

/** Name of one serving for the form: "1 cup (240 ml)" -> "cup"; "2 biscuits (30 g)" -> "2 biscuits". */
export function servingNameFromText(text: string | null | undefined): string {
  let t = (text ?? '').replace(/\s+/g, ' ').trim();
  // The metric part in brackets is the serving's grams, which the form has in its own field.
  t = t.replace(/\(\s*[^)]*\d\s*(?:g|gr|gram|grams|ml|mL|l|oz|fl\.?\s?oz)\b[^)]*\)/gi, '').trim();
  t = t.replace(/^1\s+(?=\D)/, '').trim();
  t = t.replace(/[,;:/-]+$/, '').trim();
  if (t === '' || /^[\d\s.,/]+(?:g|ml|gr|gram|grams)?$/i.test(t)) return 'serving';
  return t.slice(0, 40).trim();
}

interface Canon {
  value: number;
  unclear: boolean;
}

function fmt(value: number): string {
  return String(roundTo(value, 1));
}

/**
 * Turns a label reading into the values of the new-food form.
 *
 * - Amounts are converted into catalog units (mg <-> g <-> ug; vitamin D from IU).
 * - Energy printed only in kJ becomes kcal (/ 4.184); salt becomes sodium (salt / 2.5, in mg) when the label has no
 *   sodium line. A value that was printed is never replaced by a calculated one.
 * - `basis` keeps what the label printed: a per-serving label stays per serving (with the serving's grams), so the
 *   form shows the same numbers as the package and does the per-100 g maths itself. Per 100 ml is treated as per
 *   100 g with a density of 1 g/ml, and said so.
 * - The carbohydrate basis comes from the label layout and an energy check; if neither decides, the default is used
 *   and `carbBasis` is marked as unclear.
 * - Values that disagree with each other (energy vs kJ, energy vs protein/carbs/fat, sugars above carbs, ...) are
 *   marked unclear next to the ones the reader itself was unsure about.
 */
export function labelToFoodDraft(reading: LabelReading, options: LabelDraftOptions = {}): LabelFoodDraft {
  const notes: string[] = [];
  const unclear = new Set<NutrientCode>();
  const unclearFields = new Set<LabelFormField>();
  const mark = (...codes: NutrientCode[]) => codes.forEach((c) => unclear.add(c));

  // ---- 1. printed amounts in the unit each key is stored in
  const canon = new Map<LabelNutrientKey, Canon>();
  for (const printed of reading.nutrients) {
    const info = LABEL_NUTRIENTS[printed.key] as LabelNutrientInfo | undefined;
    if (!info || canon.has(printed.key)) continue;
    const value = convertLabelAmount(printed.key, printed.amount, printed.unit);
    if (value === null) {
      notes.push(
        printed.unit === 'iu'
          ? `${info.name} is printed in IU, which cannot be converted to the unit Ration stores without knowing the form of the vitamin. It was left out.`
          : `${info.name} has an unexpected unit (${printed.unit}) and was left out.`,
      );
      continue;
    }
    canon.set(printed.key, { value, unclear: printed.unclear });
  }

  const nutrients: NutrientMap = {};
  for (const [key, v] of canon) {
    const code = LABEL_NUTRIENTS[key].code;
    if (code === null) continue;
    nutrients[code] = roundTo(v.value, 4);
    if (v.unclear) mark(code);
  }

  // ---- 2. kJ -> kcal and salt -> sodium, only where the label did not print the catalog nutrient
  const kj = canon.get('energy_kj');
  if (kj) {
    if (nutrients.ENERGY_KCAL === undefined) {
      // Whole kcal: that is all a label prints, and a kJ figure has no more precision than that.
      nutrients.ENERGY_KCAL = Math.round(kj.value / KJ_PER_KCAL);
      if (kj.unclear) mark('ENERGY_KCAL');
      notes.push('Energy is printed in kJ only. It was converted to kcal (kJ divided by 4.184).');
    } else {
      const fromKj = kj.value / KJ_PER_KCAL;
      if (Math.abs(fromKj - nutrients.ENERGY_KCAL) > Math.max(5, 0.08 * nutrients.ENERGY_KCAL)) {
        mark('ENERGY_KCAL');
        notes.push(
          `The kJ (${fmt(kj.value)}) and kcal (${fmt(nutrients.ENERGY_KCAL)}) on the label do not match. Check the energy.`,
        );
      }
    }
  }
  const salt = canon.get('salt');
  if (salt) {
    const sodiumFromSalt = (salt.value / SALT_PER_SODIUM) * 1000;
    if (nutrients.SODIUM_MG === undefined) {
      nutrients.SODIUM_MG = roundTo(sodiumFromSalt, 1);
      if (salt.unclear) mark('SODIUM_MG');
      notes.push('The label lists salt, not sodium. Sodium was calculated from it (salt divided by 2.5).');
    } else if (Math.abs(sodiumFromSalt - nutrients.SODIUM_MG) > Math.max(40, 0.25 * nutrients.SODIUM_MG)) {
      mark('SODIUM_MG');
      notes.push('The salt and sodium on the label do not match. Check the sodium.');
    }
  }

  // ---- 3. serving size, basis, density
  const servings: LabelFoodDraft['servings'] = [];
  const basis: LabelFoodDraft['basis'] = reading.basis === 'per_serving' ? 'perServing' : 'per100g';
  const servingAmount =
    reading.serving.amount !== null && Number.isFinite(reading.serving.amount) && reading.serving.amount > 0
      ? reading.serving.amount
      : null;
  const servingUnit = servingAmount === null ? null : reading.serving.unit;
  const printedServingGrams = servingUnit ? roundTo(servingAmount as number, 2) : null;
  const servingName = servingNameFromText(reading.serving.text);
  const hasServingText = (reading.serving.text ?? '').trim() !== '';

  let density: number | null = null;
  if (reading.basis === 'per_100ml') {
    density = ASSUMED_DENSITY_G_PER_ML;
    notes.push(
      'The values are per 100 ml. Ration keeps nutrition per 100 g, so 1 g per ml was assumed (density 1). Change the density if you know it.',
    );
  } else if (servingUnit === 'ml') {
    density = ASSUMED_DENSITY_G_PER_ML;
    notes.push(
      'The serving is given in ml. 1 g per ml was assumed to get its grams (density 1). Change the grams or the density if you know them.',
    );
  }

  if (printedServingGrams !== null) {
    servings.push({ name: servingName, grams: printedServingGrams });
  } else if (basis === 'perServing') {
    servings.push({ name: hasServingText ? servingName : 'serving', grams: null });
    unclearFields.add('serving');
    notes.push(
      'The serving size could not be read. The values are per serving, so enter the serving size in grams under Serving size; Ration needs it to work out the values per 100 g.',
    );
  }
  if (reading.unclearFields.includes('servingSize')) unclearFields.add('serving');
  if (reading.unclearFields.includes('basis')) unclearFields.add('basis');
  if (reading.unclearFields.includes('productName')) unclearFields.add('name');
  if (reading.unclearFields.includes('brand')) unclearFields.add('brand');

  // ---- 4. carbohydrate basis
  const carb = detectCarbBasis(nutrients, reading.carbohydrateIncludesFibre, options.defaultCarbBasis ?? 'includes_fiber');
  if (!carb.certain) {
    unclearFields.add('carbBasis');
    notes.push(
      `Could not tell whether the label's carbohydrate includes fibre. "Total carbs include fiber" was left ${
        carb.basis === 'includes_fiber' ? 'on' : 'off'
      }; check it against the label (US labels include fibre, EU labels do not).`,
    );
  }

  // ---- 5. values that disagree with each other
  consistencyChecks({ nutrients, carbBasis: carb.basis, basis: reading.basis, servingGrams: printedServingGrams, mark, notes });

  const name = (reading.productName ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const brand = (reading.brand ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const allNotes = [reading.notes ?? '', ...reading.warnings, ...notes]
    .map((n) => n.replace(/\s+/g, ' ').trim())
    .filter((n, i, all) => n !== '' && all.indexOf(n) === i);

  return {
    name: name === '' ? null : name,
    brand: brand === '' ? null : brand,
    basis,
    nutrients,
    carbBasis: carb.basis,
    densityGPerMl: density,
    servings,
    unclear: NUTRIENTS.map((n) => n.code).filter((c) => unclear.has(c)),
    unclearFields: (['name', 'brand', 'serving', 'basis', 'carbBasis'] as const).filter((f) => unclearFields.has(f)),
    notes: allNotes.slice(0, 8),
  };
}

// ------------------------------------------------------------------------------------------------ carb basis

interface CarbDecision {
  basis: CarbBasis;
  /** False when nothing decided it and the default was used although fibre is printed (so it matters). */
  certain: boolean;
}

/**
 * Does the label's carbohydrate include fibre? Three signals, strongest first:
 *  1. the energy of the label (4 kcal/g protein and carbs, 9 fat, 2 fibre) when it fits one reading far better than
 *     the other, by more than the rounding of a label can explain;
 *  2. what the reader saw in the layout (US panels indent fibre under carbohydrate, EU tables list it apart);
 *  3. the energy again, when it leans clearly to one reading;
 *  and otherwise the app's default, flagged. Without a fibre line it makes no difference, so nothing is flagged.
 */
function detectCarbBasis(n: NutrientMap, layoutHint: boolean | null, fallback: CarbBasis): CarbDecision {
  const fromHint: CarbBasis | null =
    layoutHint === null ? null : layoutHint ? 'includes_fiber' : 'excludes_fiber';
  const fibre = n.FIBER_G;
  if (fibre === undefined || fibre <= 0) return { basis: fromHint ?? fallback, certain: true };

  const energy = carbBasisFromEnergy(n, fibre);
  if (energy && energy.strong) return { basis: energy.basis, certain: true };
  if (fromHint) return { basis: fromHint, certain: true };
  if (energy) return { basis: energy.basis, certain: true };
  return { basis: fallback, certain: false };
}

/**
 * Compares the printed energy with what the macros add up to under each reading. `strong` means the difference
 * between the two readings is at least 3 kcal per gram of fibre (2 is the least that counts as leaning).
 */
function carbBasisFromEnergy(n: NutrientMap, fibre: number): { basis: CarbBasis; strong: boolean } | null {
  const { ENERGY_KCAL: kcal, PROTEIN_G: protein, FAT_G: fat, CARBS_G: carbs, SUGAR_ALCOHOLS_G: polyols } = n;
  if (kcal === undefined || protein === undefined || fat === undefined || carbs === undefined) return null;
  if ((polyols ?? 0) > 0.5 || fibre < 2) return null;
  const common = KCAL_PER_G.protein * protein + KCAL_PER_G.fat * fat + 2 * fibre;
  const errIncluded = Math.abs(kcal - (common + KCAL_PER_G.carbs * Math.max(0, carbs - fibre)));
  const errExcluded = Math.abs(kcal - (common + KCAL_PER_G.carbs * carbs));
  const gap = Math.abs(errIncluded - errExcluded);
  if (gap < 2 * fibre || Math.min(errIncluded, errExcluded) > Math.max(12, 0.12 * kcal)) return null;
  return { basis: errIncluded < errExcluded ? 'includes_fiber' : 'excludes_fiber', strong: gap >= 3 * fibre };
}

// ------------------------------------------------------------------------------------------------ consistency

function consistencyChecks(args: {
  nutrients: NutrientMap;
  carbBasis: CarbBasis;
  basis: LabelBasis;
  servingGrams: number | null;
  mark: (...codes: NutrientCode[]) => void;
  notes: string[];
}): void {
  const { nutrients: n, carbBasis, basis, servingGrams, mark, notes } = args;
  const over = (part: number, whole: number) => part > whole * 1.05 + 0.5;

  // A part cannot be larger than the whole.
  if (n.SUGARS_G !== undefined && n.CARBS_G !== undefined && over(n.SUGARS_G, n.CARBS_G)) {
    mark('SUGARS_G', 'CARBS_G');
    notes.push('Sugars are higher than carbohydrate. Check both.');
  }
  if (n.SATURATED_FAT_G !== undefined && n.FAT_G !== undefined && over(n.SATURATED_FAT_G, n.FAT_G)) {
    mark('SATURATED_FAT_G', 'FAT_G');
    notes.push('Saturated fat is higher than total fat. Check both.');
  }
  if (n.ADDED_SUGARS_G !== undefined && n.SUGARS_G !== undefined && over(n.ADDED_SUGARS_G, n.SUGARS_G)) {
    mark('ADDED_SUGARS_G', 'SUGARS_G');
    notes.push('Added sugars are higher than total sugars. Check both.');
  }
  if (carbBasis === 'includes_fiber' && n.FIBER_G !== undefined && n.CARBS_G !== undefined && over(n.FIBER_G, n.CARBS_G)) {
    mark('FIBER_G', 'CARBS_G');
    notes.push('Fibre is higher than carbohydrate, although the carbohydrate includes fibre. Check both.');
  }

  // The three macros cannot weigh more than the food.
  if (n.PROTEIN_G !== undefined && n.CARBS_G !== undefined && n.FAT_G !== undefined) {
    const limit = basis === 'per_serving' ? servingGrams : 100;
    const sum = n.PROTEIN_G + n.CARBS_G + n.FAT_G;
    if (limit !== null && sum > limit * 1.05 + 1) {
      mark('PROTEIN_G', 'CARBS_G', 'FAT_G');
      notes.push('Protein, carbohydrate and fat add up to more than the amount of food. Check them.');
    }
  }

  // Energy against the macros. Alcohol and sugar alcohols add energy the three macros do not explain, so energy far
  // ABOVE the macros is only flagged when it is far above.
  const { ENERGY_KCAL: kcal, PROTEIN_G: p, CARBS_G: c, FAT_G: f } = n;
  if (kcal !== undefined && p !== undefined && c !== undefined && f !== undefined && (n.SUGAR_ALCOHOLS_G ?? 0) <= 1) {
    const fibre = n.FIBER_G ?? 0;
    const netCarbs = carbBasis === 'includes_fiber' ? Math.max(0, c - fibre) : c;
    const expected = KCAL_PER_G.protein * p + KCAL_PER_G.fat * f + KCAL_PER_G.carbs * netCarbs + 2 * fibre;
    const tooLow = kcal < expected - Math.max(30, 0.25 * expected);
    const tooHigh = kcal > expected + Math.max(90, 0.35 * kcal);
    if (tooLow || tooHigh) {
      mark('ENERGY_KCAL', 'PROTEIN_G', 'CARBS_G', 'FAT_G');
      notes.push(
        `The energy (${fmt(kcal)} kcal) does not match protein, carbohydrate and fat (about ${fmt(expected)} kcal). One of them may be misread.`,
      );
    }
  }
}
