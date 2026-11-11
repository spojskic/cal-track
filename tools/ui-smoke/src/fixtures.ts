/**
 * Realistic seed data for the mock backend: one signed-in user ("Demo", a 34 year old man in Sarajevo losing
 * 0.5 kg/week), ~30 foods with believable per-100 g values, four weeks of body measurements and eight days of
 * diary. Every date is derived from FIXED_NOW (the browser's frozen "now"), so the dashboard averages, the
 * streak and "today" are deterministic.
 *
 * Variants:
 *  - default        fully onboarded metric user
 *  - imperial       same data, profile.unit_system = 'imperial'
 *  - not-onboarded  signup state only: profile row (onboarded=false) + the four default meal groups
 *  - empty-diary    onboarded, nothing logged (empty states)
 *  - fresh-account  onboarded with body data, but no diary and no library (no favourites, recipes, saved meals,
 *                   custom foods, coach chats): the empty states of the Foods tab
 */
import {
  COMPUTED_NUTRIENT_CODES,
  MET_ACTIVITIES,
  NUTRIENTS,
  completeness,
  computeRecipe,
  isNutrientCode,
  macroModeToColumns,
  type NutrientCode,
  type NutrientMap,
} from '../../../packages/core/src';

import { FIXED_NOW, FIXED_UTC_OFFSET, TIMEZONE, TODAY } from './constants';
import type { MockSeed, Row } from './mock-backend';
import { stableUuid, type MockUser } from './session';

export { FIXED_NOW, TODAY } from './constants';

export type FixtureVariant = 'default' | 'imperial' | 'not-onboarded' | 'empty-diary' | 'fresh-account';
export const FIXTURE_VARIANTS: readonly FixtureVariant[] = ['default', 'imperial', 'not-onboarded', 'empty-diary', 'fresh-account'];

// ----------------------------------------------------------------------------- dates

/** Pure calendar arithmetic on YYYY-MM-DD strings (no time zone involved). */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** `2026-11-10` + `07:30` => `2026-11-10T07:30:00+01:00` (the fixture time zone, CET). */
export function localIso(date: string, hhmm: string): string {
  return `${date}T${hhmm}:00${FIXED_UTC_OFFSET}`;
}

const dayOffset = (n: number): string => addDays(TODAY, n);

// ----------------------------------------------------------------------------- ids

export const USER: MockUser = {
  id: stableUuid('user:demo'),
  email: 'demo@ration.test',
  password: 'ration-demo-1',
  createdAt: '2026-10-01T08:00:00+00:00',
};

export const FOOD_KEYS = [
  'chickenRaw',
  'chickenCooked',
  'egg',
  'oats',
  'banana',
  'apple',
  'riceCooked',
  'milk',
  'greekYogurt',
  'oliveOil',
  'salmon',
  'broccoli',
  'spinach',
  'potato',
  'breadWholemeal',
  'almonds',
  'feta',
  'tomato',
  'lentils',
  'groundBeef',
  'butter',
  'peanutButter',
  'honey',
  'coffee',
  'nutella',
  'cevapi',
  'vrhnje',
  'recipeChickenRice',
  'burekAi',
  'pasta',
  'orange',
] as const;
export type FoodKey = (typeof FOOD_KEYS)[number];

export const MEAL_KEYS = ['breakfast', 'lunch', 'dinner', 'snacks'] as const;
export type MealKey = (typeof MEAL_KEYS)[number];

const mapIds = <K extends string>(prefix: string, keys: readonly K[]): Record<K, string> =>
  Object.fromEntries(keys.map((k) => [k, stableUuid(`${prefix}:${k}`)])) as Record<K, string>;

/** Deterministic ids of the fixture entities: use them in scenario paths and assertions. */
export const IDS = {
  user: USER.id,
  food: mapIds('food', FOOD_KEYS),
  mealGroup: mapIds('meal-group', MEAL_KEYS),
  savedMeal: mapIds('saved-meal', ['breakfast', 'lunch'] as const),
  /** Coach threads (default variant): '1' protein question, '2' dinner ideas, '3' untitled. */
  thread: mapIds('thread', ['1', '2', '3'] as const),
  /**
   * Workouts (exercise_entries, default variant): 'run' manual treadmill run today, 'strength' Apple Health strength training
   * today, 'walk' manual walk yesterday, 'garminStrength' Garmin strength session two days ago WITH full details (heart rate,
   * zones, training effect, sets), 'garminRun' Garmin run five days ago with only the list summary, 'garminOld' Garmin ride
   * twelve days ago without any details.
   */
  workout: mapIds('exercise', ['run', 'strength', 'walk', 'garminStrength', 'garminRun', 'garminOld'] as const),
  /** A food id that does not exist (for "not found" scenarios). */
  missing: stableUuid('missing'),
} as const;

/** Barcodes: Nutella 400 g exists in the catalogue, the Coca-Cola can does not. */
export const BARCODES = { nutella: '3017620422003', unknown: '5449000000996' } as const;

// ----------------------------------------------------------------------------- foods

type Source =
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
type Kind = 'generic' | 'branded' | 'custom' | 'recipe' | 'ai_estimate';

interface PortionSpec {
  /** Display label, e.g. "1 cup, chopped". */
  label: string;
  /** `grams` is the mass of `amount` units (food_portions convention). */
  amount: number | null;
  unit: string | null;
  grams: number;
}

interface FoodSpec {
  key: FoodKey;
  name: string;
  brand?: string;
  source: Source;
  kind: Kind;
  owned?: boolean;
  sourceId?: string;
  gtin14?: string;
  category?: string;
  nutrients: NutrientMap;
  carbBasis?: 'includes_fiber' | 'excludes_fiber';
  density?: number;
  popularity?: number;
  portions?: PortionSpec[];
  createdAt?: string;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Amino acid profile as fraction of protein mass (g per g protein). */
const AMINO_ANIMAL: NutrientMap = {
  TRYPTOPHAN_G: 0.0125,
  THREONINE_G: 0.0425,
  ISOLEUCINE_G: 0.049,
  LEUCINE_G: 0.082,
  LYSINE_G: 0.09,
  METHIONINE_G: 0.0275,
  CYSTINE_G: 0.0115,
  PHENYLALANINE_G: 0.042,
  TYROSINE_G: 0.036,
  VALINE_G: 0.051,
  ARGININE_G: 0.062,
  HISTIDINE_G: 0.03,
  ALANINE_G: 0.059,
  ASPARTIC_ACID_G: 0.093,
  GLUTAMIC_ACID_G: 0.15,
  GLYCINE_G: 0.047,
  PROLINE_G: 0.042,
  SERINE_G: 0.04,
};
const AMINO_PLANT: NutrientMap = {
  TRYPTOPHAN_G: 0.011,
  THREONINE_G: 0.035,
  ISOLEUCINE_G: 0.04,
  LEUCINE_G: 0.07,
  LYSINE_G: 0.052,
  METHIONINE_G: 0.012,
  CYSTINE_G: 0.012,
  PHENYLALANINE_G: 0.047,
  TYROSINE_G: 0.03,
  VALINE_G: 0.047,
  ARGININE_G: 0.085,
  HISTIDINE_G: 0.027,
  ALANINE_G: 0.043,
  ASPARTIC_ACID_G: 0.105,
  GLUTAMIC_ACID_G: 0.18,
  GLYCINE_G: 0.04,
  PROLINE_G: 0.05,
  SERINE_G: 0.05,
};

function amino(proteinG: number, profile: NutrientMap): NutrientMap {
  const out: NutrientMap = {};
  for (const [code, fraction] of Object.entries(profile) as [NutrientCode, number][]) out[code] = r3(proteinG * fraction);
  return out;
}

const FOODS: FoodSpec[] = [
  {
    key: 'chickenRaw',
    name: 'Chicken breast, skinless, boneless, raw',
    source: 'fdc_foundation',
    kind: 'generic',
    sourceId: '171077',
    category: 'Poultry Products',
    popularity: 9000,
    nutrients: {
      ENERGY_KCAL: 120, WATER_G: 74.9, PROTEIN_G: 22.5, FAT_G: 2.62, CARBS_G: 0, FIBER_G: 0, SUGARS_G: 0, ASH_G: 1.1,
      SATURATED_FAT_G: 0.563, MONOUNSATURATED_FAT_G: 0.77, POLYUNSATURATED_FAT_G: 0.58, CHOLESTEROL_MG: 73,
      LINOLEIC_G: 0.5, ALA_G: 0.03, ARACHIDONIC_G: 0.07,
      VITAMIN_A_UG: 6, RETINOL_UG: 6, VITAMIN_C_MG: 0, VITAMIN_D_UG: 0.1, VITAMIN_E_MG: 0.22, VITAMIN_K_UG: 0.3,
      B1_THIAMIN_MG: 0.07, B2_RIBOFLAVIN_MG: 0.11, B3_NIACIN_MG: 10.4, B5_PANTOTHENIC_MG: 0.96, B6_MG: 0.6,
      FOLATE_UG: 4, B12_UG: 0.3, CHOLINE_MG: 85,
      CALCIUM_MG: 5, IRON_MG: 0.37, MAGNESIUM_MG: 28, PHOSPHORUS_MG: 213, POTASSIUM_MG: 334, SODIUM_MG: 45,
      ZINC_MG: 0.68, COPPER_MG: 0.04, MANGANESE_MG: 0.01, SELENIUM_UG: 21.4,
      ...amino(22.5, AMINO_ANIMAL),
    },
    portions: [
      { label: '1 breast, boneless (174 g)', amount: 1, unit: 'breast, boneless (174 g)', grams: 174 },
      { label: '100 g', amount: 100, unit: 'g', grams: 100 },
    ],
  },
  {
    key: 'chickenCooked',
    name: 'Chicken breast, roasted, skinless',
    source: 'fdc_sr_legacy',
    kind: 'generic',
    sourceId: '171477',
    category: 'Poultry Products',
    popularity: 7000,
    nutrients: {
      ENERGY_KCAL: 165, WATER_G: 65.3, PROTEIN_G: 31, FAT_G: 3.57, CARBS_G: 0, FIBER_G: 0,
      SATURATED_FAT_G: 1.01, MONOUNSATURATED_FAT_G: 1.24, POLYUNSATURATED_FAT_G: 0.77, CHOLESTEROL_MG: 85,
      B3_NIACIN_MG: 13.7, B6_MG: 0.6, B12_UG: 0.34, B2_RIBOFLAVIN_MG: 0.12, B1_THIAMIN_MG: 0.07, FOLATE_UG: 4,
      CALCIUM_MG: 15, IRON_MG: 1.04, MAGNESIUM_MG: 29, PHOSPHORUS_MG: 228, POTASSIUM_MG: 256, SODIUM_MG: 74,
      ZINC_MG: 1, SELENIUM_UG: 27.6, CHOLINE_MG: 85,
    },
    portions: [
      { label: '1 cup, chopped or diced', amount: 1, unit: 'cup, chopped or diced', grams: 140 },
      { label: '3 oz', amount: 3, unit: 'oz', grams: 85 },
    ],
  },
  {
    key: 'egg',
    name: 'Egg, whole, raw',
    source: 'fdc_foundation',
    kind: 'generic',
    sourceId: '748967',
    category: 'Dairy and Egg Products',
    popularity: 8500,
    nutrients: {
      ENERGY_KCAL: 143, WATER_G: 76.2, PROTEIN_G: 12.6, FAT_G: 9.51, CARBS_G: 0.72, FIBER_G: 0, SUGARS_G: 0.37, ASH_G: 0.9,
      SATURATED_FAT_G: 3.13, MONOUNSATURATED_FAT_G: 3.66, POLYUNSATURATED_FAT_G: 1.91, CHOLESTEROL_MG: 372,
      LINOLEIC_G: 1.35, ALA_G: 0.04, DHA_G: 0.03, ARACHIDONIC_G: 0.1,
      VITAMIN_A_UG: 160, RETINOL_UG: 160, LUTEIN_ZEAXANTHIN_UG: 503, VITAMIN_D_UG: 2, VITAMIN_E_MG: 1.05, VITAMIN_K_UG: 0.3,
      B1_THIAMIN_MG: 0.04, B2_RIBOFLAVIN_MG: 0.46, B3_NIACIN_MG: 0.07, B5_PANTOTHENIC_MG: 1.53, B6_MG: 0.17,
      FOLATE_UG: 47, B12_UG: 0.89, CHOLINE_MG: 294,
      CALCIUM_MG: 56, IRON_MG: 1.75, MAGNESIUM_MG: 12, PHOSPHORUS_MG: 198, POTASSIUM_MG: 138, SODIUM_MG: 142,
      ZINC_MG: 1.29, COPPER_MG: 0.07, MANGANESE_MG: 0.04, SELENIUM_UG: 30.7,
      ...amino(12.6, AMINO_ANIMAL),
    },
    portions: [
      { label: '1 large', amount: 1, unit: 'large', grams: 50 },
      { label: '1 medium', amount: 1, unit: 'medium', grams: 44 },
    ],
  },
  {
    key: 'oats',
    name: 'Oats, rolled, dry',
    source: 'fdc_sr_legacy',
    kind: 'generic',
    sourceId: '173904',
    category: 'Cereal Grains and Pasta',
    popularity: 6000,
    nutrients: {
      ENERGY_KCAL: 379, WATER_G: 8.2, PROTEIN_G: 13.15, FAT_G: 6.52, CARBS_G: 67.7, FIBER_G: 10.1, SUGARS_G: 0.99, STARCH_G: 57.9, ASH_G: 1.4,
      SATURATED_FAT_G: 1.11, MONOUNSATURATED_FAT_G: 2.18, POLYUNSATURATED_FAT_G: 2.54, CHOLESTEROL_MG: 0, LINOLEIC_G: 2.4, ALA_G: 0.11,
      VITAMIN_E_MG: 0.42, VITAMIN_K_UG: 2, B1_THIAMIN_MG: 0.46, B2_RIBOFLAVIN_MG: 0.15, B3_NIACIN_MG: 1.13, B5_PANTOTHENIC_MG: 1.12,
      B6_MG: 0.12, FOLATE_UG: 32, CHOLINE_MG: 40,
      CALCIUM_MG: 52, IRON_MG: 4.25, MAGNESIUM_MG: 138, PHOSPHORUS_MG: 410, POTASSIUM_MG: 362, SODIUM_MG: 6,
      ZINC_MG: 3.64, COPPER_MG: 0.627, MANGANESE_MG: 4.9, SELENIUM_UG: 28.9,
      ...amino(13.15, AMINO_PLANT),
    },
    portions: [
      { label: '1/2 cup', amount: 0.5, unit: 'cup', grams: 40 },
      { label: '1 cup', amount: 1, unit: 'cup', grams: 81 },
    ],
  },
  {
    key: 'banana',
    name: 'Banana, raw',
    source: 'fdc_sr_legacy',
    kind: 'generic',
    sourceId: '173944',
    category: 'Fruits and Fruit Juices',
    popularity: 9500,
    nutrients: {
      ENERGY_KCAL: 89, WATER_G: 74.9, PROTEIN_G: 1.09, FAT_G: 0.33, CARBS_G: 22.84, FIBER_G: 2.6, SUGARS_G: 12.23, STARCH_G: 5.38, ASH_G: 0.82,
      GLUCOSE_G: 4.98, FRUCTOSE_G: 4.85, SUCROSE_G: 2.39, MALTOSE_G: 0.15,
      SATURATED_FAT_G: 0.112, MONOUNSATURATED_FAT_G: 0.032, POLYUNSATURATED_FAT_G: 0.073, CHOLESTEROL_MG: 0,
      VITAMIN_A_UG: 3, BETA_CAROTENE_UG: 26, LUTEIN_ZEAXANTHIN_UG: 22, VITAMIN_C_MG: 8.7, VITAMIN_E_MG: 0.1, VITAMIN_K_UG: 0.5,
      B1_THIAMIN_MG: 0.031, B2_RIBOFLAVIN_MG: 0.073, B3_NIACIN_MG: 0.665, B5_PANTOTHENIC_MG: 0.334, B6_MG: 0.367, FOLATE_UG: 20, CHOLINE_MG: 9.8,
      CALCIUM_MG: 5, IRON_MG: 0.26, MAGNESIUM_MG: 27, PHOSPHORUS_MG: 22, POTASSIUM_MG: 358, SODIUM_MG: 1,
      ZINC_MG: 0.15, COPPER_MG: 0.078, MANGANESE_MG: 0.27, SELENIUM_UG: 1,
      ...amino(1.09, AMINO_PLANT),
    },
    portions: [
      { label: '1 medium (7" to 7-7/8" long)', amount: 1, unit: 'medium (7" to 7-7/8" long)', grams: 118 },
      { label: '1 cup, sliced', amount: 1, unit: 'cup, sliced', grams: 150 },
    ],
  },
  {
    key: 'apple',
    name: 'Apple, raw, with skin',
    source: 'fdc_sr_legacy',
    kind: 'generic',
    sourceId: '171688',
    category: 'Fruits and Fruit Juices',
    popularity: 9000,
    nutrients: {
      ENERGY_KCAL: 52, WATER_G: 85.6, PROTEIN_G: 0.26, FAT_G: 0.17, CARBS_G: 13.81, FIBER_G: 2.4, SUGARS_G: 10.39,
      VITAMIN_C_MG: 4.6, VITAMIN_E_MG: 0.18, VITAMIN_K_UG: 2.2, B6_MG: 0.041, FOLATE_UG: 3, BETA_CAROTENE_UG: 27, VITAMIN_A_UG: 3,
      CALCIUM_MG: 6, IRON_MG: 0.12, MAGNESIUM_MG: 5, PHOSPHORUS_MG: 11, POTASSIUM_MG: 107, SODIUM_MG: 1, ZINC_MG: 0.04,
    },
    portions: [{ label: '1 medium (3" dia)', amount: 1, unit: 'medium (3" dia)', grams: 182 }],
  },
  {
    key: 'riceCooked',
    name: 'Rice, white, long-grain, cooked',
    source: 'fdc_sr_legacy',
    kind: 'generic',
    sourceId: '168878',
    category: 'Cereal Grains and Pasta',
    popularity: 8000,
    nutrients: {
      ENERGY_KCAL: 130, WATER_G: 68.4, PROTEIN_G: 2.69, FAT_G: 0.28, CARBS_G: 28.17, FIBER_G: 0.4, SUGARS_G: 0.05,
      SATURATED_FAT_G: 0.077, MONOUNSATURATED_FAT_G: 0.088, POLYUNSATURATED_FAT_G: 0.074,
      B1_THIAMIN_MG: 0.163, B2_RIBOFLAVIN_MG: 0.013, B3_NIACIN_MG: 1.476, B5_PANTOTHENIC_MG: 0.4, B6_MG: 0.093, FOLATE_UG: 58, CHOLINE_MG: 2.1,
      CALCIUM_MG: 10, IRON_MG: 1.2, MAGNESIUM_MG: 12, PHOSPHORUS_MG: 43, POTASSIUM_MG: 35, SODIUM_MG: 1,
      ZINC_MG: 0.49, COPPER_MG: 0.069, MANGANESE_MG: 0.472, SELENIUM_UG: 7.5,
    },
    portions: [{ label: '1 cup', amount: 1, unit: 'cup', grams: 158 }],
  },
  {
    key: 'milk',
    name: 'Milk, whole, 3.25% fat',
    source: 'fdc_sr_legacy',
    kind: 'generic',
    sourceId: '171265',
    category: 'Dairy and Egg Products',
    density: 1.03,
    popularity: 8800,
    nutrients: {
      ENERGY_KCAL: 61, WATER_G: 88.1, PROTEIN_G: 3.15, FAT_G: 3.25, CARBS_G: 4.8, FIBER_G: 0, SUGARS_G: 5.05, LACTOSE_G: 4.88, GALACTOSE_G: 0.07, ASH_G: 0.65,
      SATURATED_FAT_G: 1.865, MONOUNSATURATED_FAT_G: 0.812, POLYUNSATURATED_FAT_G: 0.195, CHOLESTEROL_MG: 10, LINOLEIC_G: 0.12, ALA_G: 0.075,
      VITAMIN_A_UG: 46, RETINOL_UG: 46, VITAMIN_D_UG: 1.3, VITAMIN_E_MG: 0.05, VITAMIN_K_UG: 0.3, VITAMIN_C_MG: 0,
      B1_THIAMIN_MG: 0.046, B2_RIBOFLAVIN_MG: 0.169, B3_NIACIN_MG: 0.09, B5_PANTOTHENIC_MG: 0.37, B6_MG: 0.036, FOLATE_UG: 5, B12_UG: 0.45, CHOLINE_MG: 14.3,
      CALCIUM_MG: 113, IRON_MG: 0.03, MAGNESIUM_MG: 10, PHOSPHORUS_MG: 84, POTASSIUM_MG: 132, SODIUM_MG: 43,
      ZINC_MG: 0.37, COPPER_MG: 0.001, MANGANESE_MG: 0.003, SELENIUM_UG: 3.7, IODINE_UG: 14,
      ...amino(3.15, AMINO_ANIMAL),
    },
    portions: [
      { label: '1 cup', amount: 1, unit: 'cup', grams: 244 },
      { label: '1 fl oz', amount: 1, unit: 'fl oz', grams: 30.5 },
    ],
  },
  {
    key: 'greekYogurt',
    name: 'Yogurt, Greek, plain, low fat',
    source: 'fdc_sr_legacy',
    kind: 'generic',
    sourceId: '170903',
    category: 'Dairy and Egg Products',
    popularity: 5000,
    nutrients: {
      ENERGY_KCAL: 73, WATER_G: 81.6, PROTEIN_G: 9.95, FAT_G: 1.92, CARBS_G: 3.94, SUGARS_G: 3.2, FIBER_G: 0,
      SATURATED_FAT_G: 1.2, MONOUNSATURATED_FAT_G: 0.5, POLYUNSATURATED_FAT_G: 0.06, CHOLESTEROL_MG: 8,
      CALCIUM_MG: 100, IRON_MG: 0.04, MAGNESIUM_MG: 11, PHOSPHORUS_MG: 135, POTASSIUM_MG: 141, SODIUM_MG: 34, ZINC_MG: 0.52,
      B12_UG: 0.5, B2_RIBOFLAVIN_MG: 0.28, VITAMIN_A_UG: 8,
    },
    portions: [{ label: '1 container (170 g)', amount: 1, unit: 'container (170 g)', grams: 170 }],
  },
  {
    key: 'oliveOil',
    name: 'Oil, olive, extra virgin',
    source: 'fdc_sr_legacy',
    kind: 'generic',
    sourceId: '171413',
    category: 'Fats and Oils',
    density: 0.91,
    popularity: 7500,
    nutrients: {
      ENERGY_KCAL: 884, WATER_G: 0, PROTEIN_G: 0, FAT_G: 100, CARBS_G: 0, FIBER_G: 0, SUGARS_G: 0,
      SATURATED_FAT_G: 13.8, MONOUNSATURATED_FAT_G: 73, POLYUNSATURATED_FAT_G: 10.5, CHOLESTEROL_MG: 0, LINOLEIC_G: 9.76, ALA_G: 0.76,
      VITAMIN_E_MG: 14.35, VITAMIN_K_UG: 60.2, IRON_MG: 0.56, SODIUM_MG: 2,
    },
    portions: [{ label: '1 tbsp', amount: 1, unit: 'tbsp', grams: 13.5 }],
  },
  {
    key: 'salmon',
    name: 'Salmon, Atlantic, farmed, raw',
    source: 'fdc_foundation',
    kind: 'generic',
    sourceId: '175167',
    category: 'Finfish and Shellfish Products',
    popularity: 6500,
    nutrients: {
      ENERGY_KCAL: 208, WATER_G: 68.5, PROTEIN_G: 20.4, FAT_G: 13.4, CARBS_G: 0, FIBER_G: 0, SUGARS_G: 0, ASH_G: 1.3,
      SATURATED_FAT_G: 3.05, MONOUNSATURATED_FAT_G: 3.77, POLYUNSATURATED_FAT_G: 4.4, CHOLESTEROL_MG: 55,
      EPA_G: 0.69, DPA_G: 0.2, DHA_G: 1.29, ALA_G: 0.27, LINOLEIC_G: 0.9, ARACHIDONIC_G: 0.1,
      VITAMIN_A_UG: 12, RETINOL_UG: 12, VITAMIN_D_UG: 11, VITAMIN_E_MG: 3.55, VITAMIN_K_UG: 0.1,
      B1_THIAMIN_MG: 0.23, B2_RIBOFLAVIN_MG: 0.38, B3_NIACIN_MG: 8.05, B5_PANTOTHENIC_MG: 1.66, B6_MG: 0.82, FOLATE_UG: 26, B12_UG: 3.18, CHOLINE_MG: 90.5,
      CALCIUM_MG: 9, IRON_MG: 0.34, MAGNESIUM_MG: 27, PHOSPHORUS_MG: 240, POTASSIUM_MG: 363, SODIUM_MG: 59,
      ZINC_MG: 0.64, COPPER_MG: 0.05, MANGANESE_MG: 0.02, SELENIUM_UG: 36.5,
      ...amino(20.4, AMINO_ANIMAL),
    },
    portions: [
      { label: '1 fillet (178 g)', amount: 1, unit: 'fillet (178 g)', grams: 178 },
      { label: '3 oz', amount: 3, unit: 'oz', grams: 85 },
    ],
  },
  {
    key: 'broccoli',
    name: 'Broccoli, raw',
    source: 'fdc_sr_legacy',
    kind: 'generic',
    sourceId: '170379',
    category: 'Vegetables and Vegetable Products',
    popularity: 6000,
    nutrients: {
      ENERGY_KCAL: 34, WATER_G: 89.3, PROTEIN_G: 2.82, FAT_G: 0.37, CARBS_G: 6.64, FIBER_G: 2.6, SUGARS_G: 1.7, STARCH_G: 0.1, ASH_G: 0.87,
      SATURATED_FAT_G: 0.039, MONOUNSATURATED_FAT_G: 0.011, POLYUNSATURATED_FAT_G: 0.038, CHOLESTEROL_MG: 0, ALA_G: 0.02, LINOLEIC_G: 0.03,
      VITAMIN_A_UG: 31, BETA_CAROTENE_UG: 361, LUTEIN_ZEAXANTHIN_UG: 1403, VITAMIN_C_MG: 89.2, VITAMIN_E_MG: 0.78, VITAMIN_K_UG: 101.6,
      B1_THIAMIN_MG: 0.071, B2_RIBOFLAVIN_MG: 0.117, B3_NIACIN_MG: 0.639, B5_PANTOTHENIC_MG: 0.573, B6_MG: 0.175, FOLATE_UG: 63, CHOLINE_MG: 18.7,
      CALCIUM_MG: 47, IRON_MG: 0.73, MAGNESIUM_MG: 21, PHOSPHORUS_MG: 66, POTASSIUM_MG: 316, SODIUM_MG: 33,
      ZINC_MG: 0.41, COPPER_MG: 0.049, MANGANESE_MG: 0.21, SELENIUM_UG: 2.5,
      ...amino(2.82, AMINO_PLANT),
    },
    portions: [{ label: '1 cup, chopped', amount: 1, unit: 'cup, chopped', grams: 91 }],
  },
  {
    key: 'spinach',
    name: 'Spinach, raw',
    source: 'fdc_sr_legacy',
    kind: 'generic',
    sourceId: '168462',
    category: 'Vegetables and Vegetable Products',
    popularity: 5500,
    nutrients: {
      ENERGY_KCAL: 23, WATER_G: 91.4, PROTEIN_G: 2.86, FAT_G: 0.39, CARBS_G: 3.63, FIBER_G: 2.2, SUGARS_G: 0.42, ASH_G: 1.72,
      SATURATED_FAT_G: 0.063, MONOUNSATURATED_FAT_G: 0.01, POLYUNSATURATED_FAT_G: 0.165, CHOLESTEROL_MG: 0, ALA_G: 0.138, LINOLEIC_G: 0.027,
      VITAMIN_A_UG: 469, BETA_CAROTENE_UG: 5626, LUTEIN_ZEAXANTHIN_UG: 12198, VITAMIN_C_MG: 28.1, VITAMIN_E_MG: 2.03, VITAMIN_K_UG: 482.9,
      B1_THIAMIN_MG: 0.078, B2_RIBOFLAVIN_MG: 0.189, B3_NIACIN_MG: 0.724, B5_PANTOTHENIC_MG: 0.065, B6_MG: 0.195, FOLATE_UG: 194, CHOLINE_MG: 19.3, BETAINE_MG: 102.8,
      CALCIUM_MG: 99, IRON_MG: 2.71, MAGNESIUM_MG: 79, PHOSPHORUS_MG: 49, POTASSIUM_MG: 558, SODIUM_MG: 79,
      ZINC_MG: 0.53, COPPER_MG: 0.13, MANGANESE_MG: 0.897, SELENIUM_UG: 1,
      ...amino(2.86, AMINO_PLANT),
    },
    portions: [{ label: '1 cup', amount: 1, unit: 'cup', grams: 30 }],
  },
  {
    key: 'potato',
    name: 'Potato, flesh and skin, raw',
    source: 'fdc_sr_legacy',
    kind: 'generic',
    sourceId: '170026',
    category: 'Vegetables and Vegetable Products',
    popularity: 7200,
    nutrients: {
      ENERGY_KCAL: 77, WATER_G: 79.3, PROTEIN_G: 2.05, FAT_G: 0.09, CARBS_G: 17.49, FIBER_G: 2.1, SUGARS_G: 0.82, STARCH_G: 15.4,
      VITAMIN_C_MG: 19.7, VITAMIN_K_UG: 2, B6_MG: 0.298, B3_NIACIN_MG: 1.061, FOLATE_UG: 16, B1_THIAMIN_MG: 0.081,
      CALCIUM_MG: 12, IRON_MG: 0.81, MAGNESIUM_MG: 23, PHOSPHORUS_MG: 57, POTASSIUM_MG: 421, SODIUM_MG: 6, ZINC_MG: 0.3, COPPER_MG: 0.11, MANGANESE_MG: 0.15, SELENIUM_UG: 0.3,
    },
    portions: [{ label: '1 medium (2-1/4" to 3-1/4" dia)', amount: 1, unit: 'medium (2-1/4" to 3-1/4" dia)', grams: 173 }],
  },
  {
    key: 'breadWholemeal',
    name: 'Bread, wholemeal, sliced',
    source: 'cofid',
    kind: 'generic',
    sourceId: '11-102',
    category: 'Bread and Rolls',
    carbBasis: 'excludes_fiber', // UK style: CARBS_G is available carbohydrate, fiber is listed separately
    popularity: 4000,
    nutrients: {
      ENERGY_KCAL: 219, WATER_G: 42.5, PROTEIN_G: 9.1, FAT_G: 2.8, CARBS_G: 41.6, FIBER_G: 5, SUGARS_G: 2.5, STARCH_G: 39.1,
      SATURATED_FAT_G: 0.6, MONOUNSATURATED_FAT_G: 0.5, POLYUNSATURATED_FAT_G: 1.1,
      SODIUM_MG: 430, CALCIUM_MG: 106, IRON_MG: 2.4, MAGNESIUM_MG: 80, PHOSPHORUS_MG: 200, POTASSIUM_MG: 230, ZINC_MG: 1.8,
      B1_THIAMIN_MG: 0.25, B3_NIACIN_MG: 4.4, B6_MG: 0.17, FOLATE_UG: 40,
    },
    portions: [{ label: '1 slice', amount: 1, unit: 'slice', grams: 38 }],
  },
  {
    key: 'almonds',
    name: 'Almonds, raw',
    source: 'fdc_sr_legacy',
    kind: 'generic',
    sourceId: '170567',
    category: 'Nut and Seed Products',
    popularity: 6800,
    nutrients: {
      ENERGY_KCAL: 579, WATER_G: 4.41, PROTEIN_G: 21.15, FAT_G: 49.93, CARBS_G: 21.55, FIBER_G: 12.5, SUGARS_G: 4.35, STARCH_G: 0.74, ASH_G: 2.97,
      SATURATED_FAT_G: 3.8, MONOUNSATURATED_FAT_G: 31.55, POLYUNSATURATED_FAT_G: 12.33, CHOLESTEROL_MG: 0, LINOLEIC_G: 12.32, ALA_G: 0.006,
      VITAMIN_E_MG: 25.63, VITAMIN_K_UG: 0, B1_THIAMIN_MG: 0.205, B2_RIBOFLAVIN_MG: 1.014, B3_NIACIN_MG: 3.618, B5_PANTOTHENIC_MG: 0.471, B6_MG: 0.143, FOLATE_UG: 44, CHOLINE_MG: 52.1,
      CALCIUM_MG: 269, IRON_MG: 3.71, MAGNESIUM_MG: 270, PHOSPHORUS_MG: 481, POTASSIUM_MG: 733, SODIUM_MG: 1,
      ZINC_MG: 3.12, COPPER_MG: 1.031, MANGANESE_MG: 2.179, SELENIUM_UG: 4.1,
      ...amino(21.15, AMINO_PLANT),
    },
    portions: [
      { label: '1 oz (23 whole kernels)', amount: 1, unit: 'oz (23 whole kernels)', grams: 28.35 },
      { label: '1 cup, whole', amount: 1, unit: 'cup, whole', grams: 143 },
    ],
  },
  {
    key: 'feta',
    name: 'Cheese, feta',
    source: 'fdc_sr_legacy',
    kind: 'generic',
    sourceId: '173420',
    category: 'Dairy and Egg Products',
    popularity: 3000,
    nutrients: {
      ENERGY_KCAL: 264, WATER_G: 55.2, PROTEIN_G: 14.21, FAT_G: 21.28, CARBS_G: 4.09, SUGARS_G: 4.09, FIBER_G: 0,
      SATURATED_FAT_G: 14.95, MONOUNSATURATED_FAT_G: 4.62, POLYUNSATURATED_FAT_G: 0.59, CHOLESTEROL_MG: 89,
      VITAMIN_A_UG: 125, B2_RIBOFLAVIN_MG: 0.84, B12_UG: 1.69, B3_NIACIN_MG: 0.99, B6_MG: 0.42, FOLATE_UG: 32,
      CALCIUM_MG: 493, IRON_MG: 0.65, MAGNESIUM_MG: 19, PHOSPHORUS_MG: 337, POTASSIUM_MG: 62, SODIUM_MG: 917, ZINC_MG: 2.88, SELENIUM_UG: 15,
    },
    portions: [{ label: '1 oz', amount: 1, unit: 'oz', grams: 28.35 }],
  },
  {
    key: 'tomato',
    name: 'Tomato, red, ripe, raw',
    source: 'fdc_sr_legacy',
    kind: 'generic',
    sourceId: '170457',
    category: 'Vegetables and Vegetable Products',
    popularity: 6200,
    nutrients: {
      ENERGY_KCAL: 18, WATER_G: 94.5, PROTEIN_G: 0.88, FAT_G: 0.2, CARBS_G: 3.89, FIBER_G: 1.2, SUGARS_G: 2.63,
      VITAMIN_A_UG: 42, BETA_CAROTENE_UG: 449, LYCOPENE_UG: 2573, LUTEIN_ZEAXANTHIN_UG: 123, VITAMIN_C_MG: 13.7, VITAMIN_E_MG: 0.54, VITAMIN_K_UG: 7.9,
      B1_THIAMIN_MG: 0.037, B2_RIBOFLAVIN_MG: 0.019, B3_NIACIN_MG: 0.594, B5_PANTOTHENIC_MG: 0.089, B6_MG: 0.08, FOLATE_UG: 15, CHOLINE_MG: 6.7,
      CALCIUM_MG: 10, IRON_MG: 0.27, MAGNESIUM_MG: 11, PHOSPHORUS_MG: 24, POTASSIUM_MG: 237, SODIUM_MG: 5, ZINC_MG: 0.17, COPPER_MG: 0.059, MANGANESE_MG: 0.114,
    },
    portions: [{ label: '1 medium whole (2-3/5" dia)', amount: 1, unit: 'medium whole (2-3/5" dia)', grams: 123 }],
  },
  {
    key: 'lentils',
    name: 'Lentils, boiled',
    source: 'fdc_sr_legacy',
    kind: 'generic',
    sourceId: '172421',
    category: 'Legumes and Legume Products',
    popularity: 4200,
    nutrients: {
      ENERGY_KCAL: 116, WATER_G: 69.6, PROTEIN_G: 9.02, FAT_G: 0.38, CARBS_G: 20.13, FIBER_G: 7.9, SUGARS_G: 1.8, STARCH_G: 8.7, ASH_G: 0.9,
      SATURATED_FAT_G: 0.053, MONOUNSATURATED_FAT_G: 0.064, POLYUNSATURATED_FAT_G: 0.175, CHOLESTEROL_MG: 0, ALA_G: 0.1, LINOLEIC_G: 0.17,
      VITAMIN_C_MG: 1.5, VITAMIN_E_MG: 0.11, VITAMIN_K_UG: 1.7, B1_THIAMIN_MG: 0.169, B2_RIBOFLAVIN_MG: 0.073, B3_NIACIN_MG: 1.06, B5_PANTOTHENIC_MG: 0.638, B6_MG: 0.178,
      FOLATE_UG: 181, CHOLINE_MG: 32.7, VITAMIN_A_UG: 0,
      CALCIUM_MG: 19, IRON_MG: 3.33, MAGNESIUM_MG: 36, PHOSPHORUS_MG: 180, POTASSIUM_MG: 369, SODIUM_MG: 2,
      ZINC_MG: 1.27, COPPER_MG: 0.251, MANGANESE_MG: 0.494, SELENIUM_UG: 2.8,
      ...amino(9.02, AMINO_PLANT),
    },
    portions: [{ label: '1 cup', amount: 1, unit: 'cup', grams: 198 }],
  },
  {
    key: 'groundBeef',
    name: 'Beef, ground, 85% lean, raw',
    source: 'fdc_sr_legacy',
    kind: 'generic',
    sourceId: '174036',
    category: 'Beef Products',
    popularity: 4800,
    nutrients: {
      ENERGY_KCAL: 215, WATER_G: 64.5, PROTEIN_G: 18.6, FAT_G: 15, CARBS_G: 0, FIBER_G: 0,
      SATURATED_FAT_G: 5.9, MONOUNSATURATED_FAT_G: 6.7, POLYUNSATURATED_FAT_G: 0.5, CHOLESTEROL_MG: 68,
      B12_UG: 2.1, B3_NIACIN_MG: 4.9, B6_MG: 0.33, B2_RIBOFLAVIN_MG: 0.18, B1_THIAMIN_MG: 0.05, FOLATE_UG: 9,
      CALCIUM_MG: 13, IRON_MG: 2.1, MAGNESIUM_MG: 18, PHOSPHORUS_MG: 165, POTASSIUM_MG: 285, SODIUM_MG: 66, ZINC_MG: 4.5, SELENIUM_UG: 16.9,
    },
    portions: [{ label: '1 patty (113 g)', amount: 1, unit: 'patty (113 g)', grams: 113 }],
  },
  {
    key: 'butter',
    name: 'Butter, salted',
    source: 'fdc_sr_legacy',
    kind: 'generic',
    sourceId: '173430',
    category: 'Dairy and Egg Products',
    popularity: 5200,
    nutrients: {
      ENERGY_KCAL: 717, WATER_G: 15.9, PROTEIN_G: 0.85, FAT_G: 81.1, CARBS_G: 0.06, FIBER_G: 0, SUGARS_G: 0.06,
      SATURATED_FAT_G: 51.4, MONOUNSATURATED_FAT_G: 21, POLYUNSATURATED_FAT_G: 3, CHOLESTEROL_MG: 215,
      VITAMIN_A_UG: 684, RETINOL_UG: 671, VITAMIN_E_MG: 2.32, VITAMIN_K_UG: 7, CALCIUM_MG: 24, SODIUM_MG: 643, POTASSIUM_MG: 24, PHOSPHORUS_MG: 24,
    },
    portions: [{ label: '1 tbsp', amount: 1, unit: 'tbsp', grams: 14.2 }],
  },
  {
    key: 'peanutButter',
    name: 'Peanut butter, smooth',
    source: 'fdc_sr_legacy',
    kind: 'generic',
    sourceId: '172470',
    category: 'Legumes and Legume Products',
    popularity: 4400,
    nutrients: {
      ENERGY_KCAL: 598, WATER_G: 1.1, PROTEIN_G: 22.5, FAT_G: 51.1, CARBS_G: 22.3, FIBER_G: 5, SUGARS_G: 9.2,
      SATURATED_FAT_G: 10.3, MONOUNSATURATED_FAT_G: 23.7, POLYUNSATURATED_FAT_G: 14.2, CHOLESTEROL_MG: 0,
      VITAMIN_E_MG: 9.1, B3_NIACIN_MG: 13.1, B6_MG: 0.55, FOLATE_UG: 62,
      CALCIUM_MG: 49, IRON_MG: 1.74, MAGNESIUM_MG: 168, PHOSPHORUS_MG: 335, POTASSIUM_MG: 563, SODIUM_MG: 459, ZINC_MG: 2.51,
    },
    portions: [{ label: '2 tbsp', amount: 2, unit: 'tbsp', grams: 32 }],
  },
  {
    key: 'honey',
    name: 'Honey',
    source: 'fdc_sr_legacy',
    kind: 'generic',
    sourceId: '169640',
    category: 'Sweets',
    density: 1.42,
    popularity: 3500,
    nutrients: {
      ENERGY_KCAL: 304, WATER_G: 17.1, PROTEIN_G: 0.3, FAT_G: 0, CARBS_G: 82.4, FIBER_G: 0.2, SUGARS_G: 82.12,
      FRUCTOSE_G: 38.19, GLUCOSE_G: 31.28, SUCROSE_G: 0.89, MALTOSE_G: 7.31,
      CALCIUM_MG: 6, IRON_MG: 0.42, POTASSIUM_MG: 52, SODIUM_MG: 4, VITAMIN_C_MG: 0.5,
    },
    portions: [{ label: '1 tbsp', amount: 1, unit: 'tbsp', grams: 21 }],
  },
  {
    key: 'coffee',
    name: 'Coffee, brewed',
    source: 'fdc_sr_legacy',
    kind: 'generic',
    sourceId: '171890',
    category: 'Beverages',
    density: 1,
    popularity: 9100,
    nutrients: {
      ENERGY_KCAL: 1, WATER_G: 99.4, PROTEIN_G: 0.12, FAT_G: 0.02, CARBS_G: 0, CAFFEINE_MG: 40,
      B2_RIBOFLAVIN_MG: 0.076, B3_NIACIN_MG: 0.191, B5_PANTOTHENIC_MG: 0.254, POTASSIUM_MG: 49, MAGNESIUM_MG: 3, SODIUM_MG: 2,
    },
    portions: [{ label: '1 cup (8 fl oz)', amount: 1, unit: 'cup (8 fl oz)', grams: 237 }],
  },
  {
    key: 'nutella',
    name: 'Nutella hazelnut spread',
    brand: 'Ferrero',
    source: 'off',
    kind: 'branded',
    sourceId: BARCODES.nutella,
    gtin14: `0${BARCODES.nutella}`,
    category: 'Sweet spreads',
    popularity: 1200,
    // Label-only nutrients: exactly what the nutrition facts table of the jar lists.
    nutrients: {
      ENERGY_KCAL: 539, FAT_G: 30.9, SATURATED_FAT_G: 10.6, CARBS_G: 57.5, SUGARS_G: 56.3, PROTEIN_G: 6.3, SODIUM_MG: 43,
    },
    portions: [{ label: '1 tbsp (15 g)', amount: 1, unit: 'tbsp (15 g)', grams: 15 }],
  },
  {
    key: 'cevapi',
    name: 'Ćevapi',
    source: 'custom',
    kind: 'custom',
    owned: true,
    createdAt: '2026-10-12T16:20:00+00:00',
    nutrients: {
      ENERGY_KCAL: 258, PROTEIN_G: 17.5, FAT_G: 20.5, CARBS_G: 1, SUGARS_G: 0.4, FIBER_G: 0.2, SATURATED_FAT_G: 8.5, CHOLESTEROL_MG: 70,
      SODIUM_MG: 540, IRON_MG: 2, ZINC_MG: 3.6, B12_UG: 1.8, POTASSIUM_MG: 270,
    },
    portions: [
      { label: '1 ćevap', amount: 1, unit: 'ćevap', grams: 20 },
      { label: '1 porcija (10 komada)', amount: 1, unit: 'porcija (10 komada)', grams: 200 },
    ],
  },
  {
    key: 'vrhnje',
    name: 'Vrhnje za kuhanje',
    brand: 'Meggle',
    source: 'custom',
    kind: 'custom',
    owned: true,
    createdAt: '2026-10-14T18:05:00+00:00',
    density: 1,
    nutrients: {
      ENERGY_KCAL: 163, PROTEIN_G: 2.5, FAT_G: 15, SATURATED_FAT_G: 9.9, CARBS_G: 3.2, SUGARS_G: 3.2, FIBER_G: 0, CALCIUM_MG: 84, SODIUM_MG: 35,
    },
    portions: [
      { label: '1 žlica', amount: 1, unit: 'žlica', grams: 15 },
      { label: '1 dl', amount: 1, unit: 'dl', grams: 100 },
    ],
  },
  {
    key: 'recipeChickenRice',
    name: 'Piletina s rižom',
    source: 'recipe',
    kind: 'recipe',
    owned: true,
    createdAt: '2026-10-20T11:30:00+00:00',
    nutrients: {}, // computed from the ingredients below
  },
  {
    key: 'burekAi',
    name: 'Burek sa sirom',
    source: 'ai_estimate',
    kind: 'ai_estimate',
    owned: true,
    createdAt: '2026-11-02T19:45:00+00:00',
    nutrients: {
      ENERGY_KCAL: 290, PROTEIN_G: 9.5, FAT_G: 15, CARBS_G: 30, FIBER_G: 1.5, SATURATED_FAT_G: 5, SODIUM_MG: 480, SUGARS_G: 1.5,
    },
    portions: [{ label: '1 komad (200 g)', amount: 1, unit: 'komad (200 g)', grams: 200 }],
  },
  {
    key: 'pasta',
    name: 'Pasta, cooked, enriched',
    source: 'fdc_sr_legacy',
    kind: 'generic',
    sourceId: '168928',
    category: 'Cereal Grains and Pasta',
    popularity: 7800,
    nutrients: {
      ENERGY_KCAL: 158, WATER_G: 62, PROTEIN_G: 5.8, FAT_G: 0.93, CARBS_G: 30.9, FIBER_G: 1.8, SUGARS_G: 0.56,
      SATURATED_FAT_G: 0.18, B1_THIAMIN_MG: 0.2, B2_RIBOFLAVIN_MG: 0.1, B3_NIACIN_MG: 1.7, FOLATE_UG: 61,
      CALCIUM_MG: 7, IRON_MG: 1.28, MAGNESIUM_MG: 18, PHOSPHORUS_MG: 58, POTASSIUM_MG: 44, SODIUM_MG: 1, ZINC_MG: 0.5, SELENIUM_UG: 26.4,
    },
    portions: [{ label: '1 cup', amount: 1, unit: 'cup', grams: 140 }],
  },
  {
    key: 'orange',
    name: 'Orange, raw',
    source: 'fdc_sr_legacy',
    kind: 'generic',
    sourceId: '169097',
    category: 'Fruits and Fruit Juices',
    popularity: 6600,
    nutrients: {
      ENERGY_KCAL: 47, WATER_G: 86.75, PROTEIN_G: 0.94, FAT_G: 0.12, CARBS_G: 11.75, FIBER_G: 2.4, SUGARS_G: 9.35,
      VITAMIN_C_MG: 53.2, FOLATE_UG: 30, VITAMIN_A_UG: 11, B1_THIAMIN_MG: 0.087, B6_MG: 0.06,
      CALCIUM_MG: 40, IRON_MG: 0.1, MAGNESIUM_MG: 10, PHOSPHORUS_MG: 14, POTASSIUM_MG: 181, SODIUM_MG: 0,
    },
    portions: [{ label: '1 fruit (2-5/8" dia)', amount: 1, unit: 'fruit (2-5/8" dia)', grams: 131 }],
  },
];

const FOOD_SPEC_BY_KEY = new Map(FOODS.map((f) => [f.key, f] as const));

// Recipe: chicken and rice. Computed with the same core function the app uses.
const RECIPE_INGREDIENTS: { food: FoodKey; grams: number }[] = [
  { food: 'chickenRaw', grams: 300 },
  { food: 'riceCooked', grams: 400 },
  { food: 'broccoli', grams: 150 },
  { food: 'oliveOil', grams: 15 },
  { food: 'tomato', grams: 100 },
];
const RECIPE_SERVINGS = 2;
const RECIPE_FINAL_WEIGHT_G = 900;

function cleanRecipeNutrients(per100g: NutrientMap): NutrientMap {
  const computed = new Set<string>(COMPUTED_NUTRIENT_CODES);
  const out: NutrientMap = {};
  for (const [code, value] of Object.entries(per100g)) {
    if (!isNutrientCode(code) || computed.has(code) || typeof value !== 'number' || !(value >= 0)) continue;
    out[code] = Math.round(value * 1e5) / 1e5;
  }
  return out;
}

const recipeResult = computeRecipe({
  ingredients: RECIPE_INGREDIENTS.map((i) => ({
    per100g: (FOOD_SPEC_BY_KEY.get(i.food) as FoodSpec).nutrients,
    grams: i.grams,
  })),
  servings: RECIPE_SERVINGS,
  finalWeightG: RECIPE_FINAL_WEIGHT_G,
});
(FOOD_SPEC_BY_KEY.get('recipeChickenRice') as FoodSpec).nutrients = cleanRecipeNutrients(recipeResult.per100g);
(FOOD_SPEC_BY_KEY.get('recipeChickenRice') as FoodSpec).portions = [
  { label: '1 serving', amount: 1, unit: 'serving', grams: recipeResult.servingWeightG },
  { label: 'Full recipe', amount: 1, unit: 'recipe', grams: RECIPE_FINAL_WEIGHT_G },
  { label: '100 g', amount: 100, unit: 'g', grams: 100 },
];

/** Per-100 g nutrient map of a fixture food. */
export function foodNutrients(key: FoodKey): NutrientMap {
  return (FOOD_SPEC_BY_KEY.get(key) as FoodSpec).nutrients;
}

/** Display name of a fixture food. */
export function foodName(key: FoodKey): string {
  return (FOOD_SPEC_BY_KEY.get(key) as FoodSpec).name;
}

function foodRows(): { foods: Row[]; portions: Row[] } {
  const foods: Row[] = [];
  const portions: Row[] = [];
  for (const f of FOODS) {
    const id = IDS.food[f.key];
    foods.push({
      id,
      source: f.source,
      source_id: f.sourceId ?? null,
      kind: f.kind,
      owner_id: f.owned ? USER.id : null,
      name: f.name,
      brand: f.brand ?? null,
      gtin14: f.gtin14 ?? null,
      category: f.category ?? null,
      nutrients: f.nutrients,
      completeness: r3(completeness(f.nutrients)),
      carb_basis: f.carbBasis ?? 'includes_fiber',
      density_g_per_ml: f.density ?? null,
      popularity: f.popularity ?? 0,
      version: 1,
      supersedes: null,
      archived: false,
      created_at: f.createdAt ?? '2026-01-05T00:00:00+00:00',
      updated_at: f.createdAt ?? '2026-01-05T00:00:00+00:00',
    });
    (f.portions ?? []).forEach((p, i) => {
      portions.push({
        id: stableUuid(`portion:${f.key}:${i}`),
        food_id: id,
        label: p.label,
        amount: p.amount,
        unit: p.unit,
        grams: r3(p.grams),
        sort_order: i,
      });
    });
  }
  return { foods, portions };
}

// ----------------------------------------------------------------------------- diary

interface EntrySpec {
  meal: MealKey;
  food: FoodKey;
  grams: number;
  /** Display amount in a portion unit. */
  amount?: number;
  portion?: string;
  source?: 'manual' | 'barcode' | 'ai_photo' | 'ai_text' | 'recipe' | 'copy' | 'quick_add';
  aiConfidence?: number;
  note?: string;
}

const TODAY_ENTRIES: EntrySpec[] = [
  { meal: 'breakfast', food: 'oats', grams: 60 },
  { meal: 'breakfast', food: 'banana', grams: 118, amount: 1, portion: 'medium (7" to 7-7/8" long)' },
  { meal: 'breakfast', food: 'milk', grams: 244, amount: 1, portion: 'cup' },
  { meal: 'breakfast', food: 'coffee', grams: 237, amount: 1, portion: 'cup (8 fl oz)' },
  { meal: 'lunch', food: 'chickenCooked', grams: 150 },
  { meal: 'lunch', food: 'riceCooked', grams: 200 },
  { meal: 'lunch', food: 'broccoli', grams: 91, amount: 1, portion: 'cup, chopped' },
  { meal: 'lunch', food: 'oliveOil', grams: 13.5, amount: 1, portion: 'tbsp' },
  { meal: 'dinner', food: 'cevapi', grams: 200, amount: 1, portion: 'porcija (10 komada)' },
  { meal: 'dinner', food: 'breadWholemeal', grams: 76, amount: 2, portion: 'slice' },
  { meal: 'dinner', food: 'tomato', grams: 123, amount: 1, portion: 'medium whole (2-3/5" dia)' },
  { meal: 'dinner', food: 'vrhnje', grams: 30, amount: 2, portion: 'žlica' },
  { meal: 'snacks', food: 'apple', grams: 182, amount: 1, portion: 'medium (3" dia)' },
  { meal: 'snacks', food: 'almonds', grams: 20 },
  { meal: 'snacks', food: 'nutella', grams: 15, amount: 1, portion: 'tbsp (15 g)', source: 'barcode' },
];

const YESTERDAY_ENTRIES: EntrySpec[] = [
  { meal: 'breakfast', food: 'egg', grams: 100, amount: 2, portion: 'large' },
  { meal: 'breakfast', food: 'breadWholemeal', grams: 76, amount: 2, portion: 'slice' },
  { meal: 'breakfast', food: 'coffee', grams: 237, amount: 1, portion: 'cup (8 fl oz)' },
  { meal: 'lunch', food: 'recipeChickenRice', grams: 450, amount: 1, portion: 'serving', source: 'recipe' },
  { meal: 'dinner', food: 'salmon', grams: 178, amount: 1, portion: 'fillet (178 g)' },
  { meal: 'dinner', food: 'potato', grams: 173, amount: 1, portion: 'medium (2-1/4" to 3-1/4" dia)' },
  { meal: 'dinner', food: 'spinach', grams: 60 },
  { meal: 'dinner', food: 'oliveOil', grams: 10 },
  { meal: 'snacks', food: 'greekYogurt', grams: 170, amount: 1, portion: 'container (170 g)' },
  { meal: 'snacks', food: 'honey', grams: 21, amount: 1, portion: 'tbsp' },
  { meal: 'snacks', food: 'orange', grams: 131, amount: 1, portion: 'fruit (2-5/8" dia)' },
  { meal: 'snacks', food: 'burekAi', grams: 100, source: 'ai_text', aiConfidence: 0.6, note: 'AI estimate from the description' },
];

/** Rotation for the days before yesterday. */
const TEMPLATES: EntrySpec[][] = [
  [
    { meal: 'breakfast', food: 'oats', grams: 70 },
    { meal: 'breakfast', food: 'milk', grams: 244 },
    { meal: 'breakfast', food: 'banana', grams: 118 },
    { meal: 'lunch', food: 'pasta', grams: 250 },
    { meal: 'lunch', food: 'groundBeef', grams: 113 },
    { meal: 'lunch', food: 'tomato', grams: 123 },
    { meal: 'dinner', food: 'chickenCooked', grams: 160 },
    { meal: 'dinner', food: 'riceCooked', grams: 180 },
    { meal: 'dinner', food: 'broccoli', grams: 120 },
    { meal: 'snacks', food: 'almonds', grams: 28 },
    { meal: 'snacks', food: 'apple', grams: 182 },
  ],
  [
    { meal: 'breakfast', food: 'egg', grams: 150 },
    { meal: 'breakfast', food: 'breadWholemeal', grams: 76 },
    { meal: 'breakfast', food: 'butter', grams: 10 },
    { meal: 'lunch', food: 'lentils', grams: 300 },
    { meal: 'lunch', food: 'feta', grams: 40 },
    { meal: 'lunch', food: 'spinach', grams: 60 },
    { meal: 'dinner', food: 'salmon', grams: 150 },
    { meal: 'dinner', food: 'potato', grams: 200 },
    { meal: 'dinner', food: 'oliveOil', grams: 10 },
    { meal: 'snacks', food: 'greekYogurt', grams: 170 },
    { meal: 'snacks', food: 'honey', grams: 21 },
  ],
  [
    { meal: 'breakfast', food: 'oats', grams: 60 },
    { meal: 'breakfast', food: 'peanutButter', grams: 32 },
    { meal: 'breakfast', food: 'banana', grams: 118 },
    { meal: 'lunch', food: 'cevapi', grams: 200 },
    { meal: 'lunch', food: 'breadWholemeal', grams: 114 },
    { meal: 'lunch', food: 'tomato', grams: 123 },
    { meal: 'dinner', food: 'recipeChickenRice', grams: 450 },
    { meal: 'snacks', food: 'orange', grams: 131 },
    { meal: 'snacks', food: 'almonds', grams: 20 },
    { meal: 'snacks', food: 'coffee', grams: 237 },
  ],
];
const TEMPLATE_FACTORS = [1, 0.9, 1.1, 0.95, 1.05, 1];

const MEAL_TIMES: Record<MealKey, string[]> = {
  breakfast: ['07:30', '07:35', '07:40', '07:45'],
  lunch: ['12:30', '12:35', '12:40', '12:45'],
  dinner: ['19:00', '19:05', '19:10', '19:15'],
  snacks: ['15:30', '15:35', '15:40', '21:00'],
};
/** Today's entries are all "already logged" (before noon). */
const TODAY_TIMES: Record<MealKey, string> = { breakfast: '07:30', lunch: '09:30', dinner: '10:30', snacks: '11:30' };

function diaryRows(): Row[] {
  const rows: Row[] = [];
  const add = (date: string, specs: EntrySpec[], factor: number, todayTimes: boolean) => {
    const perMeal: Record<MealKey, number> = { breakfast: 0, lunch: 0, dinner: 0, snacks: 0 };
    specs.forEach((s, i) => {
      const n = perMeal[s.meal]++;
      const time = todayTimes
        ? `${TODAY_TIMES[s.meal].slice(0, 3)}${String(Number(TODAY_TIMES[s.meal].slice(3)) + n).padStart(2, '0')}`
        : (MEAL_TIMES[s.meal][Math.min(n, 3)] as string);
      rows.push({
        id: stableUuid(`entry:${date}:${i}`),
        user_id: USER.id,
        entry_date: date,
        meal_group_id: IDS.mealGroup[s.meal],
        food_id: IDS.food[s.food],
        grams: r3(s.grams * factor),
        amount: s.amount === undefined ? null : r3(s.amount * (s.portion ? 1 : factor)),
        portion_label: s.portion ?? null,
        source: s.source ?? 'manual',
        ai_confidence: s.aiConfidence ?? null,
        note: s.note ?? null,
        logged_at: localIso(date, time),
      });
    });
  };
  add(dayOffset(0), TODAY_ENTRIES, 1, true);
  add(dayOffset(-1), YESTERDAY_ENTRIES, 1, false);
  for (let back = 2; back <= 7; back += 1) {
    add(dayOffset(-back), TEMPLATES[(back - 2) % TEMPLATES.length] as EntrySpec[], TEMPLATE_FACTORS[back - 2] ?? 1, false);
  }
  return rows;
}

/** food_usage as the diary trigger would have produced it. */
function usageRows(entries: Row[]): Row[] {
  const byFood = new Map<string, { count: number; last: string }>();
  for (const e of entries) {
    const id = String(e.food_id);
    const cur = byFood.get(id) ?? { count: 0, last: '' };
    cur.count += 1;
    if (String(e.logged_at) > cur.last) cur.last = String(e.logged_at);
    byFood.set(id, cur);
  }
  return [...byFood.entries()].map(([food_id, u]) => ({ user_id: USER.id, food_id, use_count: u.count, last_used_at: u.last }));
}

// ----------------------------------------------------------------------------- body & goals

function weightRows(): Row[] {
  const rows: Row[] = [];
  for (let back = 29; back >= 0; back -= 1) {
    if (back !== 0 && back % 4 === 3) continue; // a missed weigh-in every now and then
    const progress = (29 - back) / 29;
    const noise = (((back * 37) % 11) - 5) * 0.04;
    const date = dayOffset(-back);
    rows.push({
      id: stableUuid(`bio:weight:${date}`),
      user_id: USER.id,
      entry_date: date,
      type: 'weight',
      value: Math.round((82 - 2 * progress + noise) * 10) / 10,
      unit: 'kg',
      source: 'manual',
      external_id: null,
      recorded_at: localIso(date, '07:15'),
      meta: {},
    });
  }
  // The last reading is exactly 80.0 kg so the dashboard shows the full -2 kg.
  (rows[rows.length - 1] as Row).value = 80;
  [28, 21, 14, 7, 0].forEach((back, i) => {
    const date = dayOffset(-back);
    rows.push({
      id: stableUuid(`bio:body_fat:${date}`),
      user_id: USER.id,
      entry_date: date,
      type: 'body_fat',
      value: [19.8, 19.6, 19.4, 19.2, 18.9][i],
      unit: 'percent',
      source: 'manual',
      external_id: null,
      recorded_at: localIso(date, '07:20'),
      meta: {},
    });
  });
  rows.push(
    {
      id: stableUuid('bio:bp_systolic:today'),
      user_id: USER.id,
      entry_date: TODAY,
      type: 'bp_systolic',
      value: 118,
      unit: 'mmHg',
      source: 'manual',
      external_id: null,
      recorded_at: localIso(TODAY, '08:00'),
      meta: {},
    },
    {
      id: stableUuid('bio:bp_diastolic:today'),
      user_id: USER.id,
      entry_date: TODAY,
      type: 'bp_diastolic',
      value: 76,
      unit: 'mmHg',
      source: 'manual',
      external_id: null,
      recorded_at: localIso(TODAY, '08:00'),
      meta: {},
    },
    {
      id: stableUuid('bio:heart_rate:today'),
      user_id: USER.id,
      entry_date: TODAY,
      type: 'heart_rate_resting',
      value: 58,
      unit: 'bpm',
      source: 'apple_health',
      external_id: `HK-RHR-${TODAY}`,
      recorded_at: localIso(TODAY, '06:50'),
      meta: {},
    },
  );
  return rows;
}

// ----------------------------------------------------------------------------- assembly

function profileRow(variant: FixtureVariant): Row {
  const base: Row = {
    user_id: USER.id,
    display_name: 'Demo',
    sex: 'male',
    birthdate: '1992-03-15',
    height_cm: 182,
    unit_system: 'metric',
    timezone: TIMEZONE,
    activity_level: 'light',
    bmr_formula: 'mifflin',
    bmr_override: null,
    tef_enabled: true,
    energy_mode: 'static',
    energy_summary_mode: 'target',
    energy_mode_auto_switched_at: null,
    net_carbs: true,
    pregnant: false,
    lactating: false,
    coach_auto_delete: true,
    onboarded: true,
    created_at: USER.createdAt,
    updated_at: USER.createdAt,
  };
  if (variant === 'imperial') return { ...base, unit_system: 'imperial' };
  if (variant === 'not-onboarded') {
    // What the signup trigger creates: display name from the e-mail, everything else empty/default.
    return {
      ...base,
      display_name: 'demo',
      sex: null,
      birthdate: null,
      height_cm: null,
      timezone: 'UTC',
      activity_level: null,
      onboarded: false,
    };
  }
  return base;
}

/** What the Garmin link saved for the strength session (packages/garmin workout-details.ts, v1, read from Garmin's per-activity endpoints). */
export const GARMIN_STRENGTH_DETAILS = {
  v: 1,
  source: 'garmin',
  level: 'full',
  fetchedAt: localIso(dayOffset(-2), '18:40'),
  typeKey: 'strength_training',
  avgHr: 118,
  maxHr: 162,
  minHr: 78,
  hrZones: [
    { zone: 1, seconds: 420, lowBpm: 95 },
    { zone: 2, seconds: 1260, lowBpm: 114 },
    { zone: 3, seconds: 900, lowBpm: 133 },
    { zone: 4, seconds: 360, lowBpm: 152 },
    { zone: 5, seconds: 60, lowBpm: 171 },
  ],
  trainingEffect: { aerobic: 2.3, anaerobic: 0.6 },
  calories: 245,
  activeCalories: 190,
  sets: [
    ...[0, 1, 2, 3].map(() => ({ exercise: 'Bench press', guess: true, reps: 8, weightKg: 60, durationSec: 30, restSec: 90 })),
    ...[0, 1, 2, 3].map(() => ({ exercise: 'Bench press', guess: true, reps: 6, weightKg: 70, durationSec: 28, restSec: 120 })),
    ...[0, 1, 2].map(() => ({ exercise: 'Squat', guess: true, reps: 10, durationSec: 40, restSec: 100 })),
  ],
};

/** The list summary of the activity list (level 'summary'): heart rate and zones, no sets. */
export const GARMIN_RUN_SUMMARY = {
  v: 1,
  source: 'garmin',
  level: 'summary',
  fetchedAt: localIso(dayOffset(-5), '07:10'),
  typeKey: 'running',
  avgHr: 150,
  maxHr: 175,
  hrZones: [
    { zone: 1, seconds: 120 },
    { zone: 2, seconds: 600 },
    { zone: 3, seconds: 800 },
    { zone: 4, seconds: 250 },
    { zone: 5, seconds: 30 },
  ],
  distanceM: 5012.4,
  elevationGainM: 38,
  avgSpeedMps: 2.778,
  avgPaceSecPerKm: 360,
  trainingEffect: { aerobic: 3.1, anaerobic: 1.2 },
  calories: 412,
};

export interface FixtureSet {
  variant: FixtureVariant;
  seed: MockSeed;
  user: MockUser;
  today: string;
  ids: typeof IDS;
}

/** Builds a complete, internally consistent seed. Cheap (a few ms): call once per scenario. */
export function buildFixtures(variant: FixtureVariant = 'default'): FixtureSet {
  const notOnboarded = variant === 'not-onboarded';
  const noLibrary = notOnboarded || variant === 'fresh-account';
  const emptyDiary = variant === 'empty-diary' || noLibrary;
  const { foods, portions } = foodRows();

  const mealGroups: Row[] = MEAL_KEYS.map((key, i) => ({
    id: IDS.mealGroup[key],
    user_id: USER.id,
    name: key.charAt(0).toUpperCase() + key.slice(1),
    sort_order: i * 10,
    hidden: false,
  }));

  const entries = emptyDiary ? [] : diaryRows();
  const recipeFoodId = IDS.food.recipeChickenRice;

  const tables: Record<string, Row[]> = {
    nutrients: NUTRIENTS.map((n) => ({
      code: n.code,
      name: n.name,
      short_name: n.shortName ?? null,
      unit: n.unit,
      nutrient_group: n.group,
      fdc_id: n.fdcId,
      fdc_alt_ids: n.fdcAltIds ? [...n.fdcAltIds] : [],
      off_key: n.offKey ?? null,
      sort_order: n.order,
      computed: n.computed ?? false,
      limit_nutrient: n.limitNutrient ?? false,
      highlight: n.highlight ?? false,
    })),
    exercise_activities: MET_ACTIVITIES.map((a) => ({ code: a.code, name: a.name, met: a.met, category: a.category })),
    app_settings: [{ key: 'coach_retention_days', value: 90, updated_at: '2026-01-05T00:00:00+00:00' }],
    foods,
    food_portions: portions,
    profiles: [profileRow(variant)],
    meal_groups: mealGroups,
    weight_goals: [],
    macro_targets: [],
    nutrient_targets: [],
    recipes: [],
    recipe_ingredients: [],
    saved_meals: [],
    saved_meal_items: [],
    favorites: [],
    food_usage: usageRows(entries),
    diary_entries: entries,
    exercise_entries: [],
    biometrics: [],
    daily_energy: [],
    notes: [],
    water_entries: [],
    coach_threads: [],
    coach_messages: [],
    fasts: [],
    integrations: [],
    dri_values: [],
  };

  // A brand-new account has no custom foods, recipes or AI estimates (all of them are foods owned by the user).
  if (noLibrary) {
    const ownedIds = new Set(foods.filter((f) => f.owner_id !== null).map((f) => String(f.id)));
    tables.foods = foods.filter((f) => f.owner_id === null);
    tables.food_portions = portions.filter((p) => !ownedIds.has(String(p.food_id)));
  } else {
    tables.recipes = [
      {
        food_id: recipeFoodId,
        user_id: USER.id,
        servings: RECIPE_SERVINGS,
        final_weight_g: RECIPE_FINAL_WEIGHT_G,
        notes: 'Piletina i riža u jednoj tavi. Posoliti po ukusu, dodati malo bosiljka.',
      },
    ];
    tables.recipe_ingredients = RECIPE_INGREDIENTS.map((ing, i) => ({
      id: stableUuid(`recipe-ingredient:${i}`),
      recipe_food_id: recipeFoodId,
      ingredient_food_id: IDS.food[ing.food],
      grams: ing.grams,
      sort_order: i,
    }));
  }

  if (!notOnboarded) {
    tables.weight_goals = [
      {
        id: stableUuid('goal:active'),
        user_id: USER.id,
        start_weight_kg: 82,
        target_weight_kg: 77,
        rate_kg_per_week: -0.5,
        start_date: dayOffset(-29),
        active: true,
      },
    ];
    tables.macro_targets = [
      {
        id: stableUuid('macro:ratios'),
        user_id: USER.id,
        ...macroModeToColumns({ mode: 'ratios', proteinPct: 30, carbsPct: 40, fatPct: 30 }),
        weekday: null,
        effective_from: dayOffset(-29),
      },
    ];
    tables.nutrient_targets = [
      { user_id: USER.id, nutrient_code: 'FIBER_G', min_value: 35, max_value: null },
      { user_id: USER.id, nutrient_code: 'SODIUM_MG', min_value: null, max_value: 2000 },
    ];
    tables.biometrics = weightRows();
  }

  if (!noLibrary) {
    tables.favorites = (['chickenRaw', 'banana', 'oats', 'cevapi', 'almonds'] as const).map((k, i) => ({
      user_id: USER.id,
      food_id: IDS.food[k],
      created_at: localIso(dayOffset(-20 + i), '10:00'),
    }));
    tables.saved_meals = [
      { id: IDS.savedMeal.breakfast, user_id: USER.id, name: 'Moj doručak' },
      { id: IDS.savedMeal.lunch, user_id: USER.id, name: 'Ručak: piletina i riža' },
    ];
    tables.saved_meal_items = [
      { id: stableUuid('smi:b:0'), saved_meal_id: IDS.savedMeal.breakfast, food_id: IDS.food.oats, grams: 60, sort_order: 0 },
      { id: stableUuid('smi:b:1'), saved_meal_id: IDS.savedMeal.breakfast, food_id: IDS.food.banana, grams: 118, sort_order: 1 },
      { id: stableUuid('smi:b:2'), saved_meal_id: IDS.savedMeal.breakfast, food_id: IDS.food.milk, grams: 244, sort_order: 2 },
      { id: stableUuid('smi:l:0'), saved_meal_id: IDS.savedMeal.lunch, food_id: IDS.food.chickenCooked, grams: 150, sort_order: 0 },
      { id: stableUuid('smi:l:1'), saved_meal_id: IDS.savedMeal.lunch, food_id: IDS.food.riceCooked, grams: 200, sort_order: 1 },
      { id: stableUuid('smi:l:2'), saved_meal_id: IDS.savedMeal.lunch, food_id: IDS.food.broccoli, grams: 91, sort_order: 2 },
    ];
    tables.coach_threads = [
      { id: stableUuid('thread:1'), user_id: USER.id, title: 'Koliko proteina mi treba?', created_at: localIso(dayOffset(-6), '20:10'), updated_at: localIso(dayOffset(-6), '20:12') },
      { id: stableUuid('thread:2'), user_id: USER.id, title: 'Ideje za večeru', created_at: localIso(dayOffset(-3), '17:40'), updated_at: localIso(dayOffset(-3), '17:42') },
      { id: stableUuid('thread:3'), user_id: USER.id, title: null, created_at: localIso(dayOffset(-1), '09:05'), updated_at: localIso(dayOffset(-1), '09:06') },
    ];
    const msg = (thread: number, n: number, role: 'user' | 'assistant', content: string, day: number, hhmm: string): Row => ({
      id: stableUuid(`msg:${thread}:${n}`),
      thread_id: stableUuid(`thread:${thread}`),
      user_id: USER.id,
      role,
      content,
      created_at: localIso(dayOffset(day), hhmm),
    });
    tables.coach_messages = [
      msg(1, 0, 'user', 'Koliko proteina mi treba dnevno ako gubim težinu?', -6, '20:10'),
      msg(1, 1, 'assistant', 'Za tvoju težinu od 80 kg dobar cilj je oko 130 do 160 g proteina dnevno, raspoređeno kroz sve obroke.', -6, '20:12'),
      msg(2, 0, 'user', 'Šta da jedem za večeru, imam piletinu i brokulu?', -3, '17:40'),
      msg(2, 1, 'assistant', 'Probaj piletinu s brokulom i malo riže: oko 40 g proteina i manje od 600 kcal.', -3, '17:42'),
      msg(3, 0, 'user', 'Je li ćevapi za ručak u redu?', -1, '09:05'),
      msg(3, 1, 'assistant', 'Da, uz salatu i manju porciju hljeba stane u tvoj dnevni budžet.', -1, '09:06'),
    ];
  }

  if (!emptyDiary) {
    tables.exercise_entries = [
      {
        id: stableUuid('exercise:run'),
        user_id: USER.id,
        entry_date: TODAY,
        activity_code: 'RUN_TREADMILL',
        name: 'Running, treadmill, general',
        minutes: 30,
        kcal: 320,
        source: 'manual',
        external_id: null,
        started_at: localIso(TODAY, '07:00'),
        ended_at: localIso(TODAY, '07:30'),
        counts_toward_energy: true,
      },
      {
        id: stableUuid('exercise:strength'),
        user_id: USER.id,
        entry_date: TODAY,
        activity_code: null,
        name: 'Traditional Strength Training',
        minutes: 45,
        kcal: 210,
        source: 'apple_health',
        external_id: `HK-WORKOUT-${TODAY}-0900`,
        started_at: localIso(TODAY, '09:00'),
        ended_at: localIso(TODAY, '09:45'),
        counts_toward_energy: true,
      },
      {
        id: stableUuid('exercise:walk'),
        user_id: USER.id,
        entry_date: dayOffset(-1),
        activity_code: 'WALK_BRISK',
        name: 'Walking, brisk (3.5 mph / 5.6 km/h)',
        minutes: 40,
        kcal: 160,
        source: 'manual',
        external_id: null,
        started_at: localIso(dayOffset(-1), '18:00'),
        ended_at: localIso(dayOffset(-1), '18:40'),
        counts_toward_energy: true,
      },
      // ---- device workouts for the Workouts section (More > Workouts); they do not count toward the energy budget
      {
        id: IDS.workout.garminStrength,
        user_id: USER.id,
        entry_date: dayOffset(-2),
        activity_code: null,
        name: 'Strength training',
        minutes: 50,
        kcal: 245,
        source: 'garmin',
        external_id: 'garmin:activity:12345678901',
        started_at: localIso(dayOffset(-2), '17:30'),
        ended_at: localIso(dayOffset(-2), '18:20'),
        counts_toward_energy: false,
        details: GARMIN_STRENGTH_DETAILS,
      },
      {
        id: IDS.workout.garminRun,
        user_id: USER.id,
        entry_date: dayOffset(-5),
        activity_code: null,
        name: 'Morning run',
        minutes: 31,
        kcal: 412,
        source: 'garmin',
        external_id: 'garmin:activity:12345678902',
        started_at: localIso(dayOffset(-5), '06:30'),
        ended_at: localIso(dayOffset(-5), '07:01'),
        counts_toward_energy: false,
        details: GARMIN_RUN_SUMMARY,
      },
      {
        id: IDS.workout.garminOld,
        user_id: USER.id,
        entry_date: dayOffset(-12),
        activity_code: null,
        name: 'Evening ride',
        minutes: 75,
        kcal: 520,
        source: 'garmin',
        external_id: 'garmin:activity:12345678903',
        started_at: localIso(dayOffset(-12), '18:00'),
        ended_at: localIso(dayOffset(-12), '19:15'),
        counts_toward_energy: false,
      },
    ];
    tables.daily_energy = [
      { user_id: USER.id, local_date: TODAY, source: 'apple_health', active_kcal: 430, resting_kcal: 1020, steps: 6234, updated_at: localIso(TODAY, '11:55') },
    ];
    tables.water_entries = [
      ...[250, 330, 500].map((ml, i) => ({
        id: stableUuid(`water:today:${i}`),
        user_id: USER.id,
        entry_date: TODAY,
        ml,
        logged_at: localIso(TODAY, ['08:00', '09:30', '11:00'][i] as string),
      })),
      ...[500, 750].map((ml, i) => ({
        id: stableUuid(`water:yesterday:${i}`),
        user_id: USER.id,
        entry_date: dayOffset(-1),
        ml,
        logged_at: localIso(dayOffset(-1), ['10:00', '16:00'][i] as string),
      })),
    ];
    tables.notes = [
      {
        id: stableUuid('note:today'),
        user_id: USER.id,
        entry_date: TODAY,
        body: 'Trening je išao odlično, nakon trčanja malo gladan pa sam dodao orahe.',
        created_at: localIso(TODAY, '10:10'),
      },
      {
        id: stableUuid('note:yesterday'),
        user_id: USER.id,
        entry_date: dayOffset(-1),
        body: 'Slabije spavao, više kafe nego inače.',
        created_at: localIso(dayOffset(-1), '21:30'),
      },
    ];
  }

  return { variant, seed: { users: [USER], tables }, user: USER, today: TODAY, ids: IDS };
}

/** The FIXED_NOW string, re-exported with the fixture time zone for scenario code. */
export const FIXTURE_CLOCK = { now: FIXED_NOW, timezone: TIMEZONE, today: TODAY } as const;
