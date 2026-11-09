/**
 * Canonical nutrient catalog.
 *
 * Single source of truth used by the DB seed (scripts/generate-seed-sql.ts),
 * the food-data importer and the UI. Every amount in the app is stored per
 * nutrient in the unit given here (energy in kcal, macros in g, most vitamins
 * and minerals in mg or ug).
 *
 * NOTE: the `fdcId` / `fdcAltIds` values are the USDA FoodData Central
 * `nutrient.id` numbers (as found in `nutrient.csv` / `food_nutrient.nutrient_id`)
 * taken from research notes. VERIFY AGAINST FDC `nutrient.csv` - the importer
 * validates them at import time and will report any mismatch in name or unit.
 *
 * Alternate ids listed in `fdcAltIds` are in the SAME unit as the canonical
 * nutrient. Ids that need a unit conversion are NOT alternates; see
 * {@link FDC_CONVERTED_IDS}.
 *
 * Open Food Facts (`offKey`): the key of `nutriments` without the `_100g`
 * suffix. OFF reports every nutrient (except `energy-kcal`) in grams per
 * 100 g, so the importer must convert to the catalog unit (g -> mg x1000,
 * g -> ug x1e6).
 */

/** Unit a nutrient amount is stored in. */
export type NutrientUnit = 'kcal' | 'g' | 'mg' | 'ug' | 'iu' | 'ml';

/** All valid nutrient units. */
export const NUTRIENT_UNITS: readonly NutrientUnit[] = ['kcal', 'g', 'mg', 'ug', 'iu', 'ml'];

/** Display / storage group for a nutrient. */
export type NutrientGroup = 'general' | 'carbs' | 'lipids' | 'protein' | 'vitamins' | 'minerals';

export interface NutrientDef {
  /** UPPER_SNAKE unique code, suffix mirrors the unit (e.g. VITAMIN_C_MG). */
  code: string;
  name: string;
  shortName?: string;
  unit: NutrientUnit;
  group: NutrientGroup;
  /** Canonical USDA FDC nutrient id, or null when FDC has no equivalent. */
  fdcId: number | null;
  /** Additional FDC nutrient ids with the same unit that map to this nutrient. */
  fdcAltIds?: readonly number[];
  /** Open Food Facts nutriments key (without `_100g`). */
  offKey?: string;
  /** Global display order (1-based, ascending, follows group order). */
  order: number;
  /** Derived from other nutrients (never stored from a source). */
  computed?: boolean;
  /** Nutrient to keep BELOW a limit (sodium, sat. fat, ...). */
  limitNutrient?: boolean;
  /** Shown as a highlighted nutrient on the dashboard. */
  highlight?: boolean;
}

interface Extra {
  shortName?: string;
  fdcAltIds?: readonly number[];
  offKey?: string;
  computed?: boolean;
  limitNutrient?: boolean;
  highlight?: boolean;
}

/** Internal builder that preserves the literal type of `code`. */
function d<C extends string>(
  code: C,
  name: string,
  unit: NutrientUnit,
  group: NutrientGroup,
  fdcId: number | null,
  extra: Extra = {},
) {
  return { code, name, unit, group, fdcId, ...extra };
}

// The array order IS the display order (it is turned into `order` below).
const DEFS = [
  // ---------------------------------------------------------------- general
  d('ENERGY_KCAL', 'Energy', 'kcal', 'general', 1008, {
    fdcAltIds: [2047, 2048], // Atwater General / Specific factors (kcal). kJ (1062) is converted by the importer.
    offKey: 'energy-kcal',
  }),
  d('WATER_G', 'Water', 'g', 'general', 1051),
  d('ALCOHOL_G', 'Alcohol', 'g', 'general', 1018, { offKey: 'alcohol', limitNutrient: true }),
  d('CAFFEINE_MG', 'Caffeine', 'mg', 'general', 1057, { offKey: 'caffeine', limitNutrient: true }),
  d('THEOBROMINE_MG', 'Theobromine', 'mg', 'general', 1058),
  d('ASH_G', 'Ash', 'g', 'general', 1007),

  // ------------------------------------------------------------------ carbs
  d('CARBS_G', 'Carbohydrates', 'g', 'carbs', 1005, { shortName: 'Carbs', offKey: 'carbohydrates' }),
  d('FIBER_G', 'Fiber', 'g', 'carbs', 1079, { offKey: 'fiber', highlight: true }),
  d('SOLUBLE_FIBER_G', 'Soluble Fiber', 'g', 'carbs', 1082, { offKey: 'soluble-fiber' }),
  d('INSOLUBLE_FIBER_G', 'Insoluble Fiber', 'g', 'carbs', 1084, { offKey: 'insoluble-fiber' }),
  d('STARCH_G', 'Starch', 'g', 'carbs', 1009, { offKey: 'starch' }),
  d('SUGARS_G', 'Sugars', 'g', 'carbs', 2000, { fdcAltIds: [1063], offKey: 'sugars' }),
  d('ADDED_SUGARS_G', 'Added Sugars', 'g', 'carbs', 1235, {
    offKey: 'added-sugars',
    limitNutrient: true,
  }),
  d('SUGAR_ALCOHOLS_G', 'Sugar Alcohols', 'g', 'carbs', null, { offKey: 'polyols' }), // custom, no FDC id
  d('NET_CARBS_G', 'Net Carbs', 'g', 'carbs', null, { computed: true }),
  d('SUCROSE_G', 'Sucrose', 'g', 'carbs', 1010, { offKey: 'sucrose' }),
  d('GLUCOSE_G', 'Glucose', 'g', 'carbs', 1011, { offKey: 'glucose' }),
  d('FRUCTOSE_G', 'Fructose', 'g', 'carbs', 1012, { offKey: 'fructose' }),
  d('LACTOSE_G', 'Lactose', 'g', 'carbs', 1013, { offKey: 'lactose' }),
  d('MALTOSE_G', 'Maltose', 'g', 'carbs', 1014, { offKey: 'maltose' }),
  d('GALACTOSE_G', 'Galactose', 'g', 'carbs', 1075),

  // ----------------------------------------------------------------- lipids
  d('FAT_G', 'Fat', 'g', 'lipids', 1004, { offKey: 'fat' }),
  d('SATURATED_FAT_G', 'Saturated Fat', 'g', 'lipids', 1258, {
    shortName: 'Saturated',
    offKey: 'saturated-fat',
    limitNutrient: true,
  }),
  d('MONOUNSATURATED_FAT_G', 'Monounsaturated Fat', 'g', 'lipids', 1292, {
    shortName: 'Monounsat.',
    offKey: 'monounsaturated-fat',
  }),
  d('POLYUNSATURATED_FAT_G', 'Polyunsaturated Fat', 'g', 'lipids', 1293, {
    shortName: 'Polyunsat.',
    offKey: 'polyunsaturated-fat',
  }),
  d('TRANS_FAT_G', 'Trans Fat', 'g', 'lipids', 1257, { offKey: 'trans-fat', limitNutrient: true }),
  d('CHOLESTEROL_MG', 'Cholesterol', 'mg', 'lipids', 1253, {
    offKey: 'cholesterol',
    limitNutrient: true,
  }),
  d('ALA_G', 'Alpha-Linolenic Acid (18:3 n-3)', 'g', 'lipids', 1404, {
    shortName: 'ALA',
    offKey: 'alpha-linolenic-acid',
  }),
  d('EPA_G', 'Eicosapentaenoic Acid (20:5 n-3)', 'g', 'lipids', 1278, {
    shortName: 'EPA',
    offKey: 'eicosapentaenoic-acid',
  }),
  d('DPA_G', 'Docosapentaenoic Acid (22:5 n-3)', 'g', 'lipids', 1280, { shortName: 'DPA' }),
  d('DHA_G', 'Docosahexaenoic Acid (22:6 n-3)', 'g', 'lipids', 1272, {
    shortName: 'DHA',
    offKey: 'docosahexaenoic-acid',
  }),
  d('LINOLEIC_G', 'Linoleic Acid (18:2 n-6)', 'g', 'lipids', 1316, {
    shortName: 'LA',
    offKey: 'linoleic-acid',
  }),
  d('ARACHIDONIC_G', 'Arachidonic Acid (20:4 n-6)', 'g', 'lipids', 1271, {
    shortName: 'ARA',
    offKey: 'arachidonic-acid',
  }),
  d('OMEGA3_G', 'Omega-3', 'g', 'lipids', null, { computed: true, offKey: 'omega-3-fat' }), // ALA+EPA+DPA+DHA
  d('OMEGA6_G', 'Omega-6', 'g', 'lipids', null, { computed: true, offKey: 'omega-6-fat' }), // LA+ARA

  // ---------------------------------------------------------------- protein
  d('PROTEIN_G', 'Protein', 'g', 'protein', 1003, { offKey: 'proteins' }),
  d('TRYPTOPHAN_G', 'Tryptophan', 'g', 'protein', 1210),
  d('THREONINE_G', 'Threonine', 'g', 'protein', 1211),
  d('ISOLEUCINE_G', 'Isoleucine', 'g', 'protein', 1212),
  d('LEUCINE_G', 'Leucine', 'g', 'protein', 1213),
  d('LYSINE_G', 'Lysine', 'g', 'protein', 1214),
  d('METHIONINE_G', 'Methionine', 'g', 'protein', 1215),
  d('CYSTINE_G', 'Cystine', 'g', 'protein', 1216),
  d('PHENYLALANINE_G', 'Phenylalanine', 'g', 'protein', 1217),
  d('TYROSINE_G', 'Tyrosine', 'g', 'protein', 1218),
  d('VALINE_G', 'Valine', 'g', 'protein', 1219),
  d('ARGININE_G', 'Arginine', 'g', 'protein', 1220),
  d('HISTIDINE_G', 'Histidine', 'g', 'protein', 1221),
  d('ALANINE_G', 'Alanine', 'g', 'protein', 1222),
  d('ASPARTIC_ACID_G', 'Aspartic Acid', 'g', 'protein', 1223),
  d('GLUTAMIC_ACID_G', 'Glutamic Acid', 'g', 'protein', 1224),
  d('GLYCINE_G', 'Glycine', 'g', 'protein', 1225),
  d('PROLINE_G', 'Proline', 'g', 'protein', 1226),
  d('SERINE_G', 'Serine', 'g', 'protein', 1227),
  d('HYDROXYPROLINE_G', 'Hydroxyproline', 'g', 'protein', 1228),

  // --------------------------------------------------------------- vitamins
  d('VITAMIN_A_UG', 'Vitamin A (RAE)', 'ug', 'vitamins', 1106, {
    shortName: 'Vitamin A',
    offKey: 'vitamin-a',
    highlight: true,
  }),
  d('RETINOL_UG', 'Retinol', 'ug', 'vitamins', 1105),
  d('BETA_CAROTENE_UG', 'Beta-Carotene', 'ug', 'vitamins', 1107),
  d('ALPHA_CAROTENE_UG', 'Alpha-Carotene', 'ug', 'vitamins', 1108),
  d('BETA_CRYPTOXANTHIN_UG', 'Beta-Cryptoxanthin', 'ug', 'vitamins', 1120),
  d('LYCOPENE_UG', 'Lycopene', 'ug', 'vitamins', 1122),
  d('LUTEIN_ZEAXANTHIN_UG', 'Lutein + Zeaxanthin', 'ug', 'vitamins', 1123),
  d('VITAMIN_C_MG', 'Vitamin C', 'mg', 'vitamins', 1162, { offKey: 'vitamin-c', highlight: true }),
  // D2 + D3 in ug. FDC also reports IU (1110): importer converts 40 IU = 1 ug.
  d('VITAMIN_D_UG', 'Vitamin D', 'ug', 'vitamins', 1114, { offKey: 'vitamin-d' }),
  d('VITAMIN_E_MG', 'Vitamin E (alpha-tocopherol)', 'mg', 'vitamins', 1109, {
    shortName: 'Vitamin E',
    offKey: 'vitamin-e',
  }),
  d('VITAMIN_K_UG', 'Vitamin K (phylloquinone)', 'ug', 'vitamins', 1185, {
    shortName: 'Vitamin K',
    offKey: 'vitamin-k',
  }),
  d('VITAMIN_K2_UG', 'Vitamin K2 (menaquinone-4)', 'ug', 'vitamins', 1183),
  d('B1_THIAMIN_MG', 'B1 (Thiamine)', 'mg', 'vitamins', 1165, {
    shortName: 'B1',
    offKey: 'vitamin-b1',
  }),
  d('B2_RIBOFLAVIN_MG', 'B2 (Riboflavin)', 'mg', 'vitamins', 1166, {
    shortName: 'B2',
    offKey: 'vitamin-b2',
  }),
  d('B3_NIACIN_MG', 'B3 (Niacin)', 'mg', 'vitamins', 1167, { shortName: 'B3', offKey: 'vitamin-pp' }),
  d('B5_PANTOTHENIC_MG', 'B5 (Pantothenic Acid)', 'mg', 'vitamins', 1170, {
    shortName: 'B5',
    offKey: 'pantothenic-acid',
  }),
  d('B6_MG', 'B6 (Pyridoxine)', 'mg', 'vitamins', 1175, { shortName: 'B6', offKey: 'vitamin-b6' }),
  d('B7_BIOTIN_UG', 'B7 (Biotin)', 'ug', 'vitamins', null, { shortName: 'Biotin', offKey: 'biotin' }), // not in FDC
  d('FOLATE_UG', 'Folate (DFE)', 'ug', 'vitamins', 1190, {
    shortName: 'Folate',
    offKey: 'vitamin-b9',
    highlight: true,
  }),
  d('FOLIC_ACID_UG', 'Folic Acid', 'ug', 'vitamins', 1186),
  d('B12_UG', 'B12 (Cobalamin)', 'ug', 'vitamins', 1178, {
    shortName: 'B12',
    offKey: 'vitamin-b12',
    highlight: true,
  }),
  d('CHOLINE_MG', 'Choline', 'mg', 'vitamins', 1180, { offKey: 'choline' }),
  d('BETAINE_MG', 'Betaine', 'mg', 'vitamins', 1198),

  // --------------------------------------------------------------- minerals
  d('CALCIUM_MG', 'Calcium', 'mg', 'minerals', 1087, { offKey: 'calcium', highlight: true }),
  d('IRON_MG', 'Iron', 'mg', 'minerals', 1089, { offKey: 'iron', highlight: true }),
  d('MAGNESIUM_MG', 'Magnesium', 'mg', 'minerals', 1090, { offKey: 'magnesium' }),
  d('PHOSPHORUS_MG', 'Phosphorus', 'mg', 'minerals', 1091, { offKey: 'phosphorus' }),
  d('POTASSIUM_MG', 'Potassium', 'mg', 'minerals', 1092, { offKey: 'potassium', highlight: true }),
  d('SODIUM_MG', 'Sodium', 'mg', 'minerals', 1093, { offKey: 'sodium', limitNutrient: true }),
  d('ZINC_MG', 'Zinc', 'mg', 'minerals', 1095, { offKey: 'zinc' }),
  d('COPPER_MG', 'Copper', 'mg', 'minerals', 1098, { offKey: 'copper' }),
  d('MANGANESE_MG', 'Manganese', 'mg', 'minerals', 1101, { offKey: 'manganese' }),
  d('SELENIUM_UG', 'Selenium', 'ug', 'minerals', 1103, { offKey: 'selenium' }),
  d('FLUORIDE_UG', 'Fluoride', 'ug', 'minerals', 1099, { offKey: 'fluoride' }),
  d('IODINE_UG', 'Iodine', 'ug', 'minerals', 1100, { offKey: 'iodine' }),
  d('CHROMIUM_UG', 'Chromium', 'ug', 'minerals', null, { offKey: 'chromium' }), // not in FDC
  d('MOLYBDENUM_UG', 'Molybdenum', 'ug', 'minerals', null, { offKey: 'molybdenum' }), // not in FDC
] as const;

/** Union of all nutrient codes in the catalog. */
export type NutrientCode = (typeof DEFS)[number]['code'];

/** A catalog entry whose `code` is narrowed to {@link NutrientCode}. */
export type NutrientEntry = NutrientDef & { code: NutrientCode };

/** The full catalog in display order. */
export const NUTRIENTS: readonly NutrientEntry[] = DEFS.map((def, i) => ({
  ...def,
  order: i + 1,
}));

/** All nutrient codes in display order. */
export const NUTRIENT_CODES: readonly NutrientCode[] = NUTRIENTS.map((n) => n.code);

/** Catalog lookup by code. */
export const NUTRIENT_BY_CODE: Readonly<Record<NutrientCode, NutrientEntry>> = Object.fromEntries(
  NUTRIENTS.map((n) => [n.code, n]),
) as Record<NutrientCode, NutrientEntry>;

/**
 * Catalog lookup by USDA FDC nutrient id. Includes `fdcAltIds` (e.g. 2047 and
 * 2048 resolve to ENERGY_KCAL). Ids needing unit conversion are not included;
 * see {@link FDC_CONVERTED_IDS}.
 */
export const NUTRIENT_BY_FDC_ID: ReadonlyMap<number, NutrientEntry> = new Map(
  NUTRIENTS.flatMap((n) =>
    [n.fdcId, ...(n.fdcAltIds ?? [])]
      .filter((id): id is number => id !== null)
      .map((id) => [id, n] as const),
  ),
);

/**
 * FDC nutrient ids that describe a catalog nutrient in a DIFFERENT unit.
 * The importer multiplies the FDC amount by `factor` to get the catalog unit.
 */
export const FDC_CONVERTED_IDS: ReadonlyMap<number, { code: NutrientCode; factor: number }> =
  new Map([
    [1062, { code: 'ENERGY_KCAL', factor: 1 / 4.184 }], // kJ -> kcal
    [1110, { code: 'VITAMIN_D_UG', factor: 1 / 40 }], // IU -> ug (40 IU = 1 ug)
  ]);

/** Ordered nutrient groups with display labels. */
export const NUTRIENT_GROUPS: readonly { code: NutrientGroup; label: string; order: number }[] = [
  { code: 'general', label: 'General', order: 1 },
  { code: 'carbs', label: 'Carbohydrates', order: 2 },
  { code: 'lipids', label: 'Lipids', order: 3 },
  { code: 'protein', label: 'Protein', order: 4 },
  { code: 'vitamins', label: 'Vitamins', order: 5 },
  { code: 'minerals', label: 'Minerals', order: 6 },
];

/** Catalog entries of one group, in display order. */
export function nutrientsInGroup(group: NutrientGroup): NutrientEntry[] {
  return NUTRIENTS.filter((n) => n.group === group);
}

/** Type guard: is the string a known nutrient code? */
export function isNutrientCode(value: string): value is NutrientCode {
  return Object.prototype.hasOwnProperty.call(NUTRIENT_BY_CODE, value);
}

/** Codes of nutrients that are derived from others (never imported). */
export const COMPUTED_NUTRIENT_CODES: readonly NutrientCode[] = NUTRIENTS.filter(
  (n) => n.computed,
).map((n) => n.code);

/** Codes of nutrients to keep below a limit. */
export const LIMIT_NUTRIENT_CODES: readonly NutrientCode[] = NUTRIENTS.filter(
  (n) => n.limitNutrient,
).map((n) => n.code);

/** Codes of nutrients highlighted on the dashboard. */
export const HIGHLIGHT_NUTRIENT_CODES: readonly NutrientCode[] = NUTRIENTS.filter(
  (n) => n.highlight,
).map((n) => n.code);
