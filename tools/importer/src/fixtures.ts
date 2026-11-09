/** Small FDC / CNF fixtures shared by the tests (no network, no big files). */
import { readFileSync, readdirSync } from 'node:fs';

// ------------------------------------------------- real FDC excerpts (trimmed)

const REAL = new URL('./fixtures/real/', import.meta.url);

/** File name inside the real Foundation JSON zip. */
export const REAL_FOUNDATION_JSON_NAME = 'FoodData_Central_foundation_food_json_2026-10-29.json';

/**
 * Three REAL Foundation foods cut from the Oct 2026 JSON download (inputFoods removed):
 * Hummus, commercial (321358: kcal+kJ, folate only as "Folate, total" 1177, tablespoon + RACC portions),
 * Oil, olive, extra virgin (748608: fat only as "Total fat (NLEA)" 1085, energy from macros,
 * "100 milliliter" portion) and Chicken, breast, meat and skin, raw (2727569: carbohydrate by
 * difference = -0.428, Atwater energy).
 */
export function realFoundationJson(): string {
  return readFileSync(new URL('foundation-excerpt.json', REAL), 'utf8');
}

/**
 * Three REAL SR Legacy foods in the CSV layout of the 2018-04 release (complete nutrient.csv,
 * measure_unit.csv, food_category.csv; food / food_nutrient / food_portion rows of
 * Butter salted 173410, Egg whole raw fresh 171287, Apples raw with skin 171688).
 */
export function realSrLegacyFiles(): Record<string, string> {
  const dir = new URL('sr-legacy/', REAL);
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith('.csv'))
      .map((f) => [f, readFileSync(new URL(f, dir), 'utf8')]),
  );
}

// --------------------------------------------------- tiny hand-made fixtures

const q = (rows: string[][]): string => rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n') + '\n';

export const NUTRIENT_CSV = q([
  ['id', 'name', 'unit_name', 'nutrient_nbr', 'rank'],
  ['1003', 'Protein', 'G', '203', '600.0'],
  ['1004', 'Total lipid (fat)', 'G', '204', '800.0'],
  ['1005', 'Carbohydrate, by difference', 'G', '205', '1110.0'],
  ['1008', 'Energy', 'KCAL', '208', '300.0'],
  ['1062', 'Energy', 'kJ', '268', '400.0'],
  ['2047', 'Energy (Atwater General Factors)', 'KCAL', '957', '280.0'],
  ['2048', 'Energy (Atwater Specific Factors)', 'KCAL', '958', '290.0'],
  ['1079', 'Fiber, total dietary', 'G', '291', '1200.0'],
  ['1087', 'Calcium, Ca', 'MG', '301', '5300.0'],
  ['1089', 'Iron, Fe', 'MG', '303', '5400.0'],
  ['1093', 'Sodium, Na', 'MG', '307', '5800.0'],
  ['1051', 'Water', 'G', '255', '100.0'],
  ['1110', 'Vitamin D (D2 + D3), International Units', 'IU', '324', '8650.0'],
  ['1114', 'Vitamin D (D2 + D3)', 'UG', '328', '8700.0'],
  ['2000', 'Total Sugars', 'G', '269', '1510.0'],
]);

const FOOD_NUTRIENT_HEADER = [
  'id', 'fdc_id', 'nutrient_id', 'amount', 'data_points', 'derivation_id', 'min', 'max', 'median', 'loq', 'footnote', 'min_year_acquired',
];
const fn = (id: string, fdc: string, nutrient: string, amount: string): string[] => [
  id, fdc, nutrient, amount, '', '', '', '', '', '', '', '',
];

/** Rows are deliberately NOT sorted by fdc_id. */
export const FOOD_NUTRIENT_CSV = q([
  FOOD_NUTRIENT_HEADER,
  fn('1', '1002', '1004', '81.11'),
  fn('2', '1001', '1008', '52'),
  fn('3', '1001', '1003', '0.26'),
  fn('4', '1001', '1004', '0.17'),
  fn('5', '1001', '1005', '13.81'),
  fn('6', '1001', '1079', '2.4'),
  fn('7', '1001', '1093', '1'),
  fn('8', '1001', '2000', '10.39'),
  fn('9', '1006', '1008', '999'), // branded food: not part of the dataset
  fn('10', '1002', '1008', '717'),
  fn('11', '1002', '1003', '0.85'),
  fn('12', '1002', '1005', '0.06'),
  fn('13', '1002', '1093', '643'),
  fn('14', '1002', '1114', '0.0'), // explicit zero is kept
  fn('15', '1004', '1062', '544'), // kJ only -> 130 kcal
  fn('16', '1004', '1003', '2.69'),
  fn('17', '1004', '1005', '28.17'),
  fn('18', '1004', '1004', '0.28'),
  fn('19', '1005', '1008', '900'),
  fn('20', '1005', '1004', '95'),
  fn('21', '1005', '1003', '30'),
  fn('22', '1005', '1005', '40'),
  fn('23', '1007', '1110', '200'), // IU only -> 5 ug
  fn('24', '1007', '1008', '130'),
  fn('25', '1007', '1003', '25'),
  fn('26', '1007', '1004', '3'),
  fn('27', '1008', '2047', '210'),
  fn('28', '1008', '2048', '200'), // Atwater specific beats general
  fn('29', '1008', '1003', '5'),
  fn('30', '1001', '1087', '-5'), // negative: dropped
  fn('31', '1001', '1089', 'abc'), // non-numeric: dropped
  fn('32', '1003', '1051', '50'), // water only: no energy
  fn('33', '1009', '1008', '61'),
  fn('34', '1009', '1003', '3.2'),
  fn('35', '1009', '1004', '3.3'),
  fn('36', '1009', '1005', '4.8'),
  fn('37', '1009', '1110', '40'),
  fn('38', '1009', '1114', '2.0'), // D (ug) wins over IU
  fn('39', '1010', '1003', '10'),
  fn('40', '1010', '1004', '5'),
  fn('41', '1010', '1005', '20'), // energy from macros: 4*10 + 4*20 + 9*5 = 165
  fn('42', '1001', '1008', '99999'), // duplicate (food, nutrient): first wins
]);

export const FOOD_CSV = q([
  ['fdc_id', 'data_type', 'description', 'food_category_id', 'publication_date'],
  ['1001', 'sr_legacy_food', '  Apples,  raw, with skin ', '9', '2019-04-01'],
  ['1002', 'sr_legacy_food', 'Butter, salted', '1', '2019-04-01'],
  ['1003', 'sr_legacy_food', 'Water only', '1', '2019-04-01'],
  ['1004', 'sr_legacy_food', 'Rice, white, cooked', '20', '2019-04-01'],
  ['1005', 'sr_legacy_food', 'Impossible macros', '4', '2019-04-01'],
  ['1006', 'branded_food', 'Branded thing', '26', '2019-04-01'],
  ['1007', 'sr_legacy_food', 'Tuna, canned', '15', '2019-04-01'],
  ['1008', 'sr_legacy_food', 'Atwater only food', '11', '2019-04-01'],
  ['1009', 'sr_legacy_food', 'Milk, whole', '1', '2019-04-01'],
  ['1010', 'sr_legacy_food', 'Macros only', '11', '2019-04-01'],
]);

export const FOOD_CATEGORY_CSV = q([
  ['id', 'code', 'description'],
  ['1', '0100', 'Dairy and Egg Products'],
  ['4', '0400', 'Fats and Oils'],
  ['9', '0900', 'Fruits and Fruit Juices'],
  ['11', '1100', 'Vegetables and Vegetable Products'],
  ['15', '1500', 'Finfish and Shellfish Products'],
  ['20', '2000', 'Cereal Grains and Pasta'],
]);

export const MEASURE_UNIT_CSV = q([
  ['id', 'name'],
  ['1000', 'cup'],
  ['1001', 'tablespoon'],
  ['9999', 'undetermined'],
]);

export const FOOD_PORTION_CSV = q([
  ['id', 'fdc_id', 'seq_num', 'amount', 'measure_unit_id', 'portion_description', 'modifier', 'gram_weight', 'data_points', 'footnote', 'min_year_acquired'],
  ['1', '1001', '2', '1', '9999', '', 'medium (3" dia)', '182', '', '', ''],
  ['2', '1001', '1', '1', '1000', '', 'chopped', '125', '', '', ''],
  ['3', '1001', '3', '1', '1000', '', 'sliced', '0', '', '', ''], // grams 0: dropped
  ['4', '1002', '1', '1', '1001', '', '', '14.2', '', '', ''],
  ['5', '1002', '2', '1', '9999', '', '10205', '10', '', '', ''], // numeric modifier, no label: dropped
  ['6', '1006', '1', '1', '1000', '', '', '100', '', '', ''], // not our food
]);

/** SR-Legacy-like dataset (also used as "foundation" with another data_type in tests). */
export const SR_FIXTURE: Record<string, string> = {
  'nutrient.csv': NUTRIENT_CSV,
  'food.csv': FOOD_CSV,
  'food_nutrient.csv': FOOD_NUTRIENT_CSV,
  'food_category.csv': FOOD_CATEGORY_CSV,
  'measure_unit.csv': MEASURE_UNIT_CSV,
  'food_portion.csv': FOOD_PORTION_CSV,
  'sr_legacy_food.csv': q([['fdc_id', 'NDB_number'], ['1001', '09003']]),
};

/** FNDDS-like dataset: categories come from the WWEIA tables. */
export const FNDDS_FIXTURE: Record<string, string> = {
  'nutrient.csv': NUTRIENT_CSV,
  'food.csv': q([
    ['fdc_id', 'data_type', 'description', 'food_category_id', 'publication_date'],
    ['2001', 'survey_fndds_food', 'Milk, whole', '', '2024-10-31'],
    ['2002', 'survey_fndds_food', 'Apple, raw', '', '2024-10-31'],
    ['2003', 'survey_fndds_food', 'Coffee, brewed', 'Coffee', '2024-10-31'], // category text in food.csv
    ['2004', 'sr_legacy_food', 'Not FNDDS', '1', '2024-10-31'],
  ]),
  'food_nutrient.csv': q([
    FOOD_NUTRIENT_HEADER,
    fn('1', '2001', '1008', '61'),
    fn('2', '2001', '1003', '3.28'),
    fn('3', '2001', '1004', '3.2'),
    fn('4', '2001', '1005', '4.67'),
    fn('5', '2002', '1008', '52'),
    fn('6', '2002', '1003', '0.26'),
    fn('7', '2002', '1005', '13.8'),
    fn('8', '2003', '1008', '1'),
    fn('9', '2003', '1003', '0.1'),
    fn('10', '2003', '1005', '0'),
  ]),
  'survey_fndds_food.csv': q([
    ['fdc_id', 'food_code', 'wweia_category_code', 'start_date', 'end_date'],
    ['2001', '11111000', '1004', '2021-01-01', '2023-01-01'],
    ['2002', '63101000', '7002', '2021-01-01', '2023-01-01'],
  ]),
  'wweia_food_category.csv': q([
    ['wweia_food_category_code', 'wweia_food_category_description'],
    ['1004', 'Milk, whole'],
    ['7002', 'Apples'],
  ]),
  'food_portion.csv': q([
    ['id', 'fdc_id', 'seq_num', 'amount', 'measure_unit_id', 'portion_description', 'modifier', 'gram_weight', 'data_points', 'footnote', 'min_year_acquired'],
    ['1', '2001', '1', '1', '9999', '1 cup', '8036', '244', '', '', ''],
    ['2', '2001', '2', '1', '9999', 'Quantity not specified', '9999', '244', '', '', ''],
    ['3', '2001', '3', '1', '9999', '1 fl oz', '8036', '30.5', '', '', ''],
    ['4', '2002', '1', '1', '9999', '1 medium', '10205', '182', '', '', ''],
  ]),
  'measure_unit.csv': MEASURE_UNIT_CSV,
};

// -------------------------------------------------------------------- CNF

export const CNF_FOOD_NAME = [
  'FoodID,FoodCode,FoodGroupID,FoodSourceID,FoodDescription,FoodDescriptionF,FoodDateOfEntry,FoodDateOfPublication,CountryCode,ScientificName',
  '2,100,1,1,"Milk, 3.25% M.F.","Lait 3,25 % M.G.",2000-01-01,2001-01-01,,',
  '3,200,1,1,"Café crème, 15% fat","Café crème",2000-01-01,2001-01-01,,',
  '4,300,1,1,"No energy food","Aliment",2000-01-01,2001-01-01,,',
].join('\r\n') + '\r\n';

export const CNF_NUTRIENT_NAME = [
  'NutrientID,NutrientCode,NutrientSymbol,NutrientName,NutrientNameF,Tagname,NutrientUnit,NutrientDecimals',
  '203,203,PROT,PROTEIN,PROTEINES,PROCNT,g,2',
  '204,204,FAT,FAT (TOTAL LIPIDS),LIPIDES,FAT,g,2',
  '205,205,CARB,"CARBOHYDRATE, TOTAL (BY DIFFERENCE)",GLUCIDES,CHOCDF,g,2',
  '208,208,KCAL,ENERGY (KILOCALORIES),ENERGIE,ENERC_KCAL,kCal,0',
  '268,268,KJ,ENERGY (KILOJOULES),ENERGIE,ENERC_KJ,kJ,0',
  '9301,301,CA,CALCIUM,CALCIUM,CA,mg,0',
  '320,320,RAE,RETINOL ACTIVITY EQUIVALENTS,RETINOL,RAE,µg,0',
  '401,401,VITC,VITAMIN C,VITAMINE C,VITC,mg,1',
].join('\r\n') + '\r\n';

export const CNF_NUTRIENT_AMOUNT = [
  'FoodID,NutrientID,NutrientValue,StandardError,NumberofObservations,NutrientSourceID,NutrientDateOfEntry',
  '2,208,61,,,,',
  '2,203,3.2,,,,',
  '2,204,3.3,,,,',
  '2,205,4.8,,,,',
  '2,9301,113,,,,',
  '2,320,46,,,,',
  '2,401,-1,,,,', // negative: dropped
  '3,268,837,,,,', // kJ only -> 200 kcal
  '3,203,2,,,,',
  '3,204,19,,,,',
  '3,205,3,,,,',
  '4,203,1,,,,', // only one macro, no energy -> dropped
].join('\r\n') + '\r\n';

export const CNF_MEASURE_NAME = [
  'MeasureID,MeasureDescription,MeasureDescriptionF',
  '341,250 mL,250 mL',
  '342,125 mL,125 mL',
  '343,100 g,100 g',
  '344,No serving size specified,Aucune',
  '345,1 cup (250 mL),1 tasse',
].join('\r\n') + '\r\n';

/** ConversionFactorValue as a multiplier of 100 g (CNF data dictionary). */
export const CNF_CONVERSION_MULTIPLIER = [
  'FoodID,MeasureID,ConversionFactorValue,ConvFactorDateOfEntry',
  '2,341,2.58,2001-01-01',
  '2,342,1.29,2001-01-01',
  '2,343,1.00,2001-01-01',
  '2,344,1.00,2001-01-01',
  '3,345,2.4,2001-01-01',
].join('\r\n') + '\r\n';

/** Same data as grams per measure. */
export const CNF_CONVERSION_GRAMS = [
  'FoodID,MeasureID,ConversionFactorValue,ConvFactorDateOfEntry',
  '2,341,258,2001-01-01',
  '2,342,129,2001-01-01',
  '2,343,100,2001-01-01',
  '2,344,100,2001-01-01',
  '3,345,240,2001-01-01',
].join('\r\n') + '\r\n';

export const CNF_FOOD_GROUP = [
  'FoodGroupID,FoodGroupCode,FoodGroupName,FoodGroupNameF',
  '1,0100,Dairy and Egg Products,Produits laitiers',
].join('\r\n') + '\r\n';

/** CNF files as latin1 bytes (the real download is ISO-8859-1). */
export function cnfFilesLatin1(conversion = CNF_CONVERSION_MULTIPLIER): Record<string, Buffer> {
  return {
    'FOOD NAME.csv': Buffer.from(CNF_FOOD_NAME, 'latin1'),
    'NUTRIENT NAME.csv': Buffer.from(CNF_NUTRIENT_NAME, 'latin1'),
    'NUTRIENT AMOUNT.csv': Buffer.from(CNF_NUTRIENT_AMOUNT, 'latin1'),
    'MEASURE NAME.csv': Buffer.from(CNF_MEASURE_NAME, 'latin1'),
    'CONVERSION FACTOR.csv': Buffer.from(conversion, 'latin1'),
    'FOOD GROUP.csv': Buffer.from(CNF_FOOD_GROUP, 'latin1'),
  };
}

/** CNF files as UTF-8 with a BOM. */
export function cnfFilesUtf8Bom(conversion = CNF_CONVERSION_MULTIPLIER): Record<string, Buffer> {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const withBom = (s: string): Buffer => Buffer.concat([bom, Buffer.from(s, 'utf8')]);
  return {
    'FOOD NAME.csv': withBom(CNF_FOOD_NAME),
    'NUTRIENT NAME.csv': withBom(CNF_NUTRIENT_NAME),
    'NUTRIENT AMOUNT.csv': withBom(CNF_NUTRIENT_AMOUNT),
    'MEASURE NAME.csv': withBom(CNF_MEASURE_NAME),
    'CONVERSION FACTOR.csv': withBom(conversion),
    'FOOD GROUP.csv': withBom(CNF_FOOD_GROUP),
  };
}
