import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { completeness as coreCompleteness } from '../../../packages/core/src/diary';
import { NUTRIENTS } from '../../../packages/core/src/nutrients';
import {
  OUTPUT_PATH,
  renderNutrientMap,
} from '../../../packages/core/scripts/generate-edge-nutrient-map.ts';
import {
  convertFdcAmount,
  extractFdcNutrients,
  mapFdcBranded,
  parseFdcDate,
  selectFdcMatches,
} from '../../../supabase/functions/_shared/fdc-branded.ts';
import {
  buildFoodRow,
  cleanNutrients,
  computeCompleteness,
  roundSig,
  titleCaseIfAllCaps,
  type MapResult,
  type MappedProduct,
} from '../../../supabase/functions/_shared/food-row.ts';
import {
  carbBasisFromCountries,
  mapOffProduct,
  offProductFromResponse,
} from '../../../supabase/functions/_shared/off-product.ts';
import {
  CATALOG_UNITS,
  COMPUTED_CODES,
  FDC_NUTRIENT_MAP,
  NON_COMPUTED_CODES,
  OFF_NUTRIENT_MAP,
} from '../../../supabase/functions/_shared/nutrient-map.generated.ts';

function product(result: MapResult): MappedProduct {
  if (!result.ok) throw new Error(`expected a product, got rejection: ${result.reason}`);
  return result.product;
}

// ---------------------------------------------------------------------------
// generated nutrient map
// ---------------------------------------------------------------------------
describe('nutrient-map.generated.ts', () => {
  it('is up to date with packages/core/src/nutrients.ts (run the generator if this fails)', () => {
    expect(readFileSync(OUTPUT_PATH, 'utf8')).toBe(renderNutrientMap());
  });

  it('covers the catalog', () => {
    expect(Object.keys(CATALOG_UNITS)).toEqual(NUTRIENTS.map((n) => n.code));
    expect([...NON_COMPUTED_CODES, ...COMPUTED_CODES].sort()).toEqual(
      NUTRIENTS.map((n) => n.code).sort(),
    );
    expect(COMPUTED_CODES).toEqual(['NET_CARBS_G', 'OMEGA3_G', 'OMEGA6_G']);
  });

  it('maps FDC ids, including alternates and unit-converted ids', () => {
    expect(FDC_NUTRIENT_MAP[1008]).toMatchObject({
      code: 'ENERGY_KCAL',
      fdcUnit: 'KCAL',
      factor: 1,
      rank: 0,
    });
    expect(FDC_NUTRIENT_MAP[2048]).toMatchObject({ code: 'ENERGY_KCAL', rank: 1 });
    expect(FDC_NUTRIENT_MAP[2047]).toMatchObject({ code: 'ENERGY_KCAL', rank: 2 });
    expect(FDC_NUTRIENT_MAP[1062]).toMatchObject({ code: 'ENERGY_KCAL', fdcUnit: 'KJ' });
    expect(FDC_NUTRIENT_MAP[1062]!.factor).toBeCloseTo(1 / 4.184, 9);
    expect(FDC_NUTRIENT_MAP[1110]).toMatchObject({
      code: 'VITAMIN_D_UG',
      fdcUnit: 'IU',
      factor: 0.025,
    });
    expect(FDC_NUTRIENT_MAP[1093]).toMatchObject({ code: 'SODIUM_MG', unit: 'mg', fdcUnit: 'MG' });
    expect(FDC_NUTRIENT_MAP[2000]).toMatchObject({ code: 'SUGARS_G' });
  });

  it('maps OFF keys with grams -> catalog unit factors and skips computed nutrients', () => {
    expect(OFF_NUTRIENT_MAP['energy-kcal']).toMatchObject({ code: 'ENERGY_KCAL', factor: 1 });
    expect(OFF_NUTRIENT_MAP.proteins).toMatchObject({ code: 'PROTEIN_G', factor: 1 });
    expect(OFF_NUTRIENT_MAP.calcium).toMatchObject({ code: 'CALCIUM_MG', factor: 1000 });
    expect(OFF_NUTRIENT_MAP['vitamin-d']).toMatchObject({
      code: 'VITAMIN_D_UG',
      factor: 1_000_000,
    });
    expect(OFF_NUTRIENT_MAP.alcohol!.factor).toBeCloseTo(0.789, 6);
    expect(OFF_NUTRIENT_MAP['omega-3-fat']).toBeUndefined();
    expect(Object.values(OFF_NUTRIENT_MAP).some((e) => COMPUTED_CODES.includes(e.code))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// FDC branded
// ---------------------------------------------------------------------------
const fdcNutella = {
  fdcId: 2663212,
  description: 'NUTELLA HAZELNUT SPREAD',
  dataType: 'Branded',
  gtinUpc: '009800895007',
  publishedDate: '2022-01-05',
  modifiedDate: '2021-11-20',
  brandOwner: 'Ferrero U.S.A., Incorporated',
  brandName: 'NUTELLA',
  foodCategory: 'Chocolate',
  servingSize: 37,
  servingSizeUnit: 'g',
  householdServingFullText: '2 tbsp',
  foodNutrients: [
    { nutrientId: 1003, nutrientName: 'Protein', nutrientNumber: '203', unitName: 'G', value: 6.3 },
    {
      nutrientId: 1004,
      nutrientName: 'Total lipid (fat)',
      nutrientNumber: '204',
      unitName: 'G',
      value: 30.9,
    },
    {
      nutrientId: 1005,
      nutrientName: 'Carbohydrate, by difference',
      nutrientNumber: '205',
      unitName: 'G',
      value: 57.5,
    },
    {
      nutrientId: 1008,
      nutrientName: 'Energy',
      nutrientNumber: '208',
      unitName: 'KCAL',
      value: 539,
    },
    {
      nutrientId: 2000,
      nutrientName: 'Sugars, total including NLEA',
      nutrientNumber: '269',
      unitName: 'G',
      value: 56.3,
    },
    {
      nutrientId: 1079,
      nutrientName: 'Fiber, total dietary',
      nutrientNumber: '291',
      unitName: 'G',
      value: 3.4,
    },
    {
      nutrientId: 1093,
      nutrientName: 'Sodium, Na',
      nutrientNumber: '307',
      unitName: 'MG',
      value: 41,
    },
    {
      nutrientId: 1258,
      nutrientName: 'Fatty acids, total saturated',
      nutrientNumber: '606',
      unitName: 'G',
      value: 10.5,
    },
    {
      nutrientId: 9999,
      nutrientName: 'Something unknown',
      nutrientNumber: '999',
      unitName: 'G',
      value: 1,
    },
  ],
};

describe('mapFdcBranded', () => {
  it('maps a search item', () => {
    const p = product(mapFdcBranded(fdcNutella));
    expect(p).toMatchObject({
      source: 'fdc_branded',
      sourceId: '2663212',
      gtin14: '00009800895007',
      name: 'Nutella Hazelnut Spread', // ALL CAPS -> title case
      brand: 'Nutella', // brandName wins over brandOwner
      category: 'Chocolate',
      carbBasis: 'includes_fiber',
      serving: { grams: 37, unit: 'g', label: '2 tbsp (37 g)' },
    });
    expect(p.nutrients).toEqual({
      PROTEIN_G: 6.3,
      FAT_G: 30.9,
      CARBS_G: 57.5,
      ENERGY_KCAL: 539,
      SUGARS_G: 56.3,
      FIBER_G: 3.4,
      SODIUM_MG: 41,
      SATURATED_FAT_G: 10.5,
    });
  });

  it('falls back to kJ (id 1062 / 4.184) when no kcal value exists', () => {
    const p = product(
      mapFdcBranded({
        fdcId: 1,
        description: 'Kj only',
        foodNutrients: [
          { nutrientId: 1062, unitName: 'kJ', value: 1000 },
          { nutrientId: 1003, unitName: 'G', value: 5 },
        ],
      }),
    );
    expect(p.nutrients.ENERGY_KCAL).toBeCloseTo(239, 0);
    expect(p.nutrients.ENERGY_KCAL).toBe(239);
  });

  it('prefers 1008 > 2048 > 2047 > 1062 for energy', () => {
    const energy = (ids: Array<[number, string, number]>) =>
      product(
        mapFdcBranded({
          fdcId: 1,
          description: 'x',
          foodNutrients: ids.map(([nutrientId, unitName, value]) => ({
            nutrientId,
            unitName,
            value,
          })),
        }),
      ).nutrients.ENERGY_KCAL;
    const all: Array<[number, string, number]> = [
      [1062, 'kJ', 2092],
      [2047, 'KCAL', 400],
      [2048, 'KCAL', 450],
      [1008, 'KCAL', 500],
    ];
    expect(energy(all)).toBe(500);
    expect(energy(all.filter(([id]) => id !== 1008))).toBe(450);
    expect(energy(all.filter(([id]) => id !== 1008 && id !== 2048))).toBe(400);
    expect(energy(all.filter(([id]) => id === 1062))).toBe(500); // 2092 kJ / 4.184
  });

  it('does not touch mixed-case names and uses brandOwner when brandName is missing', () => {
    const p = product(
      mapFdcBranded({
        fdcId: 7,
        description: 'Whole Milk Greek Yogurt',
        brandOwner: 'FAGE USA DAIRY INDUSTRY, INC.',
        foodNutrients: [{ nutrientId: 1003, unitName: 'G', value: 9 }],
      }),
    );
    expect(p.name).toBe('Whole Milk Greek Yogurt');
    expect(p.brand).toBe('Fage Usa Dairy Industry, Inc.');
    expect(p.gtin14).toBeNull();
    expect(p.serving).toBeNull();
  });

  it('handles ml servings (MLT) and the CSV unit names', () => {
    const p = product(
      mapFdcBranded({
        fdcId: 8,
        description: 'COLA',
        servingSize: 355,
        servingSizeUnit: 'MLT',
        foodNutrients: [{ nutrientId: 1008, unitName: 'KCAL', value: 42 }],
      }),
    );
    expect(p.serving).toEqual({ grams: 355, unit: 'ml', label: '1 serving (355 ml)' });
    const g = product(
      mapFdcBranded({
        fdcId: 9,
        description: 'x',
        servingSize: 30.5,
        servingSizeUnit: 'GRM',
        foodNutrients: [{ nutrientId: 1008, unitName: 'KCAL', value: 42 }],
      }),
    );
    expect(g.serving).toMatchObject({ grams: 30.5, unit: 'g' });
  });

  it('ignores unknown serving units and non-positive sizes', () => {
    for (const [servingSize, servingSizeUnit] of [
      [1, 'oz'],
      [0, 'g'],
      [-3, 'g'],
      ['x', 'g'],
    ] as const) {
      const p = product(
        mapFdcBranded({
          fdcId: 8,
          description: 'x',
          servingSize,
          servingSizeUnit,
          foodNutrients: [{ nutrientId: 1008, unitName: 'KCAL', value: 42 }],
        }),
      );
      expect(p.serving, `${servingSize} ${servingSizeUnit}`).toBeNull();
    }
  });

  it('reads the food-detail shape ({ nutrient: { id, unitName }, amount })', () => {
    const p = product(
      mapFdcBranded({
        fdcId: 10,
        description: 'Detail',
        brandedFoodCategory: 'Snacks',
        foodNutrients: [
          { nutrient: { id: 1003, name: 'Protein', unitName: 'g' }, amount: 12 },
          { nutrient: { id: 1008, name: 'Energy', unitName: 'kcal' }, amount: 300 },
        ],
      }),
    );
    expect(p.nutrients).toEqual({ PROTEIN_G: 12, ENERGY_KCAL: 300 });
    expect(p.category).toBe('Snacks');
  });

  it('converts mismatching mass units and IU vitamin D', () => {
    const n = extractFdcNutrients([
      { nutrientId: 1093, unitName: 'G', value: 0.041 }, // sodium reported in g -> 41 mg
      { nutrientId: 1087, unitName: 'MG', value: 120 },
      { nutrientId: 1110, unitName: 'IU', value: 400 }, // 400 IU = 10 ug
      { nutrientId: 1185, unitName: 'MG', value: 0.08 }, // vitamin K in mg -> 80 ug
      { nutrientId: 1003, unitName: 'SP_GR', value: 1 }, // unusable unit -> skipped
    ]);
    expect(n.SODIUM_MG).toBeCloseTo(41, 6);
    expect(n.CALCIUM_MG).toBe(120);
    expect(n.VITAMIN_D_UG).toBeCloseTo(10, 6);
    expect(n.VITAMIN_K_UG).toBeCloseTo(80, 6);
    expect(n.PROTEIN_G).toBeUndefined();
  });

  it('prefers the real vitamin D (ug) over the IU value', () => {
    const n = extractFdcNutrients([
      { nutrientId: 1110, unitName: 'IU', value: 400 },
      { nutrientId: 1114, unitName: 'UG', value: 2.5 },
    ]);
    expect(n.VITAMIN_D_UG).toBe(2.5);
  });

  it('convertFdcAmount handles kJ labelled on a kcal id and the reverse', () => {
    const kcal = FDC_NUTRIENT_MAP[1008]!;
    expect(convertFdcAmount(418.4, 'KJ', kcal)).toBeCloseTo(100, 6);
    expect(convertFdcAmount(100, 'KCAL', kcal)).toBe(100);
    expect(convertFdcAmount(100, '', kcal)).toBe(100);
    expect(convertFdcAmount(100, 'LB', kcal)).toBeUndefined();
  });

  it('skips non-numeric / negative amounts', () => {
    const n = extractFdcNutrients([
      { nutrientId: 1003, unitName: 'G', value: 'n/a' },
      { nutrientId: 1004, unitName: 'G', value: '7.5' }, // numeric strings are accepted
      { nutrientId: 1005, unitName: 'G' },
    ]);
    expect(n).toEqual({ FAT_G: 7.5 });
  });

  it('rejects products it cannot use', () => {
    expect(mapFdcBranded(null)).toEqual({ ok: false, reason: 'not_an_object' });
    expect(mapFdcBranded({ description: 'x', foodNutrients: [] })).toEqual({
      ok: false,
      reason: 'no_fdc_id',
    });
    expect(mapFdcBranded({ fdcId: 1, foodNutrients: [{ nutrientId: 1003, value: 1 }] })).toEqual({
      ok: false,
      reason: 'no_name',
    });
    expect(mapFdcBranded({ fdcId: 1, description: 'x', foodNutrients: [] })).toEqual({
      ok: false,
      reason: 'no_nutrition_data',
    });
    expect(mapFdcBranded({ fdcId: 1, description: 'x' })).toEqual({
      ok: false,
      reason: 'no_nutrition_data',
    });
  });
});

describe('selectFdcMatches', () => {
  const item = (fdcId: number, gtinUpc: unknown, extra: Record<string, unknown> = {}) => ({
    fdcId,
    dataType: 'Branded',
    gtinUpc,
    description: `item ${fdcId}`,
    ...extra,
  });

  it('keeps only items whose gtinUpc normalises to the requested GTIN-14', () => {
    const json = {
      foods: [
        item(1, '036000291452'),
        item(2, '0036000291452'), // EAN-13 spelling of the same code
        item(3, '036000291469'), // a different product the fuzzy search returned
        item(4, null),
        item(5, '036000291452', { dataType: 'Foundation' }),
      ],
    };
    expect(selectFdcMatches(json, '00036000291452').map((f) => f.fdcId)).toEqual([2, 1]);
  });

  it('sorts newest modifiedDate/publishedDate first, then highest fdcId', () => {
    const json = {
      foods: [
        item(1, '036000291452', { modifiedDate: '2020-01-01' }),
        item(2, '036000291452', { publishedDate: '2022-06-30' }),
        item(3, '036000291452', { modifiedDate: '2021-03-02', publishedDate: '2019-01-01' }),
        item(4, '036000291452', { modifiedDate: '2020-01-01' }),
      ],
    };
    expect(selectFdcMatches(json, '00036000291452').map((f) => f.fdcId)).toEqual([2, 3, 4, 1]);
  });

  it('copes with missing / malformed responses', () => {
    expect(selectFdcMatches(null, '00036000291452')).toEqual([]);
    expect(selectFdcMatches({}, '00036000291452')).toEqual([]);
    expect(selectFdcMatches({ foods: 'x' }, '00036000291452')).toEqual([]);
    expect(
      selectFdcMatches({ foods: [null, 3, item(1, '036000291452')] }, '00036000291452'),
    ).toHaveLength(1);
  });

  it('parseFdcDate understands ISO, US and garbage', () => {
    expect(parseFdcDate('2021-03-02')).toBe(Date.UTC(2021, 2, 2));
    expect(parseFdcDate('3/2/2021')).toBe(Date.UTC(2021, 2, 2));
    expect(parseFdcDate('2021-03-02T10:00:00Z')).toBe(Date.UTC(2021, 2, 2, 10));
    expect(parseFdcDate('nope')).toBe(0);
    expect(parseFdcDate(undefined)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Open Food Facts
// ---------------------------------------------------------------------------
const offNutella = {
  code: '3017620422003',
  product_name: 'Nutella',
  brands: 'Ferrero,Nutella',
  nutrition_data_per: '100g',
  serving_size: '15 g',
  serving_quantity: 15,
  serving_quantity_unit: 'g',
  countries_tags: ['en:france', 'en:germany'],
  categories_tags_en: ['Spreads', 'Sweet spreads', 'Chocolate spreads'],
  nutriments: {
    'energy-kcal_100g': 539,
    energy_100g: 2255,
    proteins_100g: 6.3,
    carbohydrates_100g: 57.5,
    fat_100g: 30.9,
    'saturated-fat_100g': 10.6,
    sugars_100g: 56.3,
    fiber_100g: 0,
    salt_100g: 0.107,
    sodium_100g: 0.0428,
  },
};

describe('mapOffProduct', () => {
  it('maps a typical product', () => {
    const p = product(mapOffProduct(offNutella));
    expect(p).toMatchObject({
      source: 'off',
      sourceId: '3017620422003',
      gtin14: '03017620422003',
      name: 'Nutella',
      brand: 'Ferrero', // first of the comma separated brands
      category: 'Chocolate spreads', // most specific tag
      carbBasis: 'excludes_fiber',
      serving: { grams: 15, unit: 'g', label: '1 serving (15 g)' },
    });
    expect(p.nutrients).toEqual({
      ENERGY_KCAL: 539,
      PROTEIN_G: 6.3,
      CARBS_G: 57.5,
      FAT_G: 30.9,
      SATURATED_FAT_G: 10.6,
      SUGARS_G: 56.3,
      FIBER_G: 0,
      SODIUM_MG: 42.8, // sodium_100g (g) * 1000, preferred over salt
    });
  });

  it('prefers energy-kcal over kJ, then energy-kj, then energy (kJ) / 4.184', () => {
    const energy = (nutriments: Record<string, unknown>) =>
      product(mapOffProduct({ code: '1', nutriments: { proteins_100g: 1, ...nutriments } }))
        .nutrients.ENERGY_KCAL;
    expect(energy({ 'energy-kcal_100g': 540, energy_100g: 2000 })).toBe(540);
    expect(energy({ 'energy-kj_100g': 1000, energy_100g: 2000 })).toBe(239);
    expect(energy({ energy_100g: 1000 })).toBe(239);
    expect(energy({ 'energy-kcal_100g': 0 })).toBe(0);
    expect(energy({})).toBeUndefined();
  });

  it('derives sodium from salt (salt / 2.5, in mg) only when sodium is absent', () => {
    const sodium = (n: Record<string, unknown>) =>
      product(mapOffProduct({ code: '1', nutriments: { proteins_100g: 1, ...n } })).nutrients
        .SODIUM_MG;
    expect(sodium({ salt_100g: 1.25 })).toBe(500);
    expect(sodium({ salt_100g: 2, sodium_100g: 0.3 })).toBe(300);
    expect(sodium({})).toBeUndefined();
  });

  it('converts grams to the catalog unit (mg x1000, ug x1e6)', () => {
    const n = product(
      mapOffProduct({
        code: '1',
        nutriments: {
          proteins_100g: 3,
          calcium_100g: 0.12,
          iron_100g: 0.0021,
          'vitamin-c_100g': 0.0053,
          'vitamin-d_100g': 0.0000025,
          'vitamin-b12_100g': 0.0000024,
          'vitamin-pp_100g': 0.016,
          caffeine_100g: 0.032,
          selenium_100g: 0.000055,
          iodine_100g: 0.00015,
        },
      }),
    ).nutrients;
    expect(n.CALCIUM_MG).toBe(120);
    expect(n.IRON_MG).toBe(2.1);
    expect(n.VITAMIN_C_MG).toBe(5.3);
    expect(n.VITAMIN_D_UG).toBe(2.5);
    expect(n.B12_UG).toBe(2.4);
    expect(n.B3_NIACIN_MG).toBe(16);
    expect(n.CAFFEINE_MG).toBe(32);
    expect(n.SELENIUM_UG).toBe(55);
    expect(n.IODINE_UG).toBe(150);
  });

  it('converts alcohol % vol with the ethanol density', () => {
    const n = product(
      mapOffProduct({ code: '1', nutriments: { alcohol_100g: 5, carbohydrates_100g: 3 } }),
    ).nutrients;
    expect(n.ALCOHOL_G).toBe(3.945);
  });

  it('rescales per-serving labels to per 100 g using serving_quantity', () => {
    const p = product(
      mapOffProduct({
        code: '2',
        product_name: 'Cereal bar',
        nutrition_data_per: 'serving',
        serving_quantity: '30', // string, as OFF sometimes returns
        nutriments: {
          'energy-kcal_serving': 120,
          proteins_serving: 3,
          sodium_serving: 0.15,
          calcium_serving: 0.06,
          // _100g keys are ignored in serving mode
          proteins_100g: 99,
        },
      }),
    );
    expect(p.nutrients).toEqual({
      ENERGY_KCAL: 400,
      PROTEIN_G: 10,
      SODIUM_MG: 500,
      CALCIUM_MG: 200,
    });
    expect(p.serving).toMatchObject({ grams: 30, unit: 'g' });
  });

  it('skips per-serving products without a positive serving_quantity', () => {
    for (const serving_quantity of [undefined, 0, -5, 'abc', null]) {
      const r = mapOffProduct({
        code: '2',
        nutrition_data_per: 'serving',
        serving_quantity,
        nutriments: { 'energy-kcal_serving': 120, 'energy-kcal_100g': 400 },
      });
      expect(r, String(serving_quantity)).toEqual({
        ok: false,
        reason: 'per_serving_without_quantity',
      });
    }
  });

  it('rejects products with neither energy nor macros', () => {
    expect(mapOffProduct({ code: '3', product_name: 'x', nutriments: {} })).toEqual({
      ok: false,
      reason: 'no_nutrition_data',
    });
    expect(mapOffProduct({ code: '3', product_name: 'x' })).toEqual({
      ok: false,
      reason: 'no_nutrition_data',
    });
    // only micronutrients -> still rejected
    expect(
      mapOffProduct({
        code: '3',
        product_name: 'x',
        nutriments: { calcium_100g: 0.1, 'vitamin-c_100g': 0.01 },
      }),
    ).toEqual({ ok: false, reason: 'no_nutrition_data' });
    // implausible macros are cleaned away first
    expect(mapOffProduct({ code: '3', nutriments: { fat_100g: 5000, proteins_100g: -2 } })).toEqual(
      {
        ok: false,
        reason: 'no_nutrition_data',
      },
    );
    expect(mapOffProduct(null)).toEqual({ ok: false, reason: 'not_an_object' });
    expect(mapOffProduct({ nutriments: { fat_100g: 1 } })).toEqual({
      ok: false,
      reason: 'no_code',
    });
  });

  it('accepts a single macro or a zero-energy product', () => {
    expect(mapOffProduct({ code: '4', nutriments: { fat_100g: 12 } }).ok).toBe(true);
    expect(mapOffProduct({ code: '4', nutriments: { 'energy-kcal_100g': 0 } }).ok).toBe(true);
  });

  it('drops non-numeric and negative values but keeps numeric strings', () => {
    const n = product(
      mapOffProduct({
        code: '5',
        nutriments: {
          fat_100g: -1,
          proteins_100g: 'abc',
          carbohydrates_100g: '12,5',
          'energy-kcal_100g': '',
        },
      }),
    ).nutrients;
    expect(n).toEqual({ CARBS_G: 12.5 });
  });

  it('carb_basis heuristic: US/Canada labels include fiber, everything else excludes it', () => {
    expect(carbBasisFromCountries(['en:united-states'])).toBe('includes_fiber');
    expect(carbBasisFromCountries(['en:france', 'en:canada'])).toBe('includes_fiber');
    expect(carbBasisFromCountries(['en:france', 'en:germany'])).toBe('excludes_fiber');
    expect(carbBasisFromCountries([])).toBe('excludes_fiber');
    expect(carbBasisFromCountries(undefined)).toBe('excludes_fiber');
    expect(carbBasisFromCountries('en:united-states')).toBe('excludes_fiber'); // not an array
    const us = product(
      mapOffProduct({
        code: '6',
        countries_tags: ['en:united-states'],
        nutriments: { fat_100g: 1 },
      }),
    );
    expect(us.carbBasis).toBe('includes_fiber');
  });

  it('builds the serving portion from serving_quantity (+ unit, + label)', () => {
    const serving = (extra: Record<string, unknown>) =>
      product(mapOffProduct({ code: '7', nutriments: { fat_100g: 1 }, ...extra })).serving;
    expect(serving({ serving_quantity: '30', serving_size: '30g' })).toEqual({
      grams: 30,
      unit: 'g',
      label: '1 serving (30g)',
    });
    expect(
      serving({ serving_quantity: 250, serving_quantity_unit: 'ml', serving_size: '250 ml' }),
    ).toMatchObject({
      grams: 250,
      unit: 'ml',
    });
    // unit inferred from the free text when serving_quantity_unit is absent
    expect(serving({ serving_quantity: 330, serving_size: '330 ml' })).toMatchObject({
      unit: 'ml',
    });
    expect(serving({ serving_quantity: 15, serving_size: '1 tbsp (15 g)' })).toMatchObject({
      label: '1 tbsp (15 g)',
    });
    expect(serving({ serving_quantity: 40 })).toMatchObject({ label: '1 serving (40 g)' });
    expect(serving({ serving_quantity: 0 })).toBeNull();
    expect(serving({})).toBeNull();
  });

  it('falls back for missing names / categories', () => {
    const noName = product(
      mapOffProduct({ code: '8', brands: 'Acme, Inc', nutriments: { fat_100g: 1 } }),
    );
    expect(noName.name).toBe('Acme');
    const nothing = product(mapOffProduct({ code: '9', nutriments: { fat_100g: 1 } }));
    expect(nothing).toMatchObject({ name: 'Product 9', brand: null, category: null });
    const fromTags = product(
      mapOffProduct({
        code: '9',
        nutriments: { fat_100g: 1 },
        categories_tags: ['fr:pates', 'en:sweet-spreads'],
      }),
    );
    expect(fromTags.category).toBe('Sweet spreads');
  });

  it('uses the fallback code when the product has none', () => {
    const p = product(
      mapOffProduct({ nutriments: { fat_100g: 1 } }, { fallbackCode: '3017620422003' }),
    );
    expect(p.sourceId).toBe('3017620422003');
  });

  it('offProductFromResponse unwraps /product/<code>.json', () => {
    expect(offProductFromResponse({ code: '1', status: 1, product: { code: '1' } })).toEqual({
      code: '1',
      product: { code: '1' },
    });
    expect(
      offProductFromResponse({ code: '1', status: 0, status_verbose: 'product not found' }),
    ).toBeNull();
    expect(offProductFromResponse({ status: 1 })).toBeNull();
    expect(offProductFromResponse('x')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Row builder
// ---------------------------------------------------------------------------
const base: MappedProduct = {
  source: 'off',
  sourceId: '123',
  gtin14: '00000000000123',
  name: '  Test   food ',
  brand: ' Acme ',
  category: null,
  nutrients: { ENERGY_KCAL: 100, PROTEIN_G: 5 },
  carbBasis: 'excludes_fiber',
  serving: null,
};

describe('roundSig / cleanNutrients', () => {
  it('rounds to 4 significant digits', () => {
    expect(roundSig(12.34567)).toBe(12.35);
    expect(roundSig(0.00123456)).toBe(0.001235);
    expect(roundSig(1234.56)).toBe(1235);
    expect(roundSig(98765)).toBe(98770);
    expect(roundSig(0)).toBe(0);
    expect(roundSig(539)).toBe(539);
  });

  it('drops NaN, negative, infinite, non-numeric, unknown and computed entries', () => {
    expect(
      cleanNutrients({
        PROTEIN_G: Number.NaN,
        FAT_G: -1,
        CARBS_G: Number.POSITIVE_INFINITY,
        FIBER_G: '3' as unknown as number,
        SUGARS_G: null as unknown as number,
        SODIUM_MG: 120.456,
        NOT_A_CODE: 5,
        NET_CARBS_G: 5, // computed
        OMEGA3_G: 1, // computed
        WATER_G: 0, // zero is a valid amount
      }),
    ).toEqual({ SODIUM_MG: 120.5, WATER_G: 0 });
  });

  it('drops physically implausible amounts', () => {
    expect(
      cleanNutrients({
        FAT_G: 100.5, // > 100 g per 100 g
        PROTEIN_G: 100,
        ENERGY_KCAL: 1500,
        CALCIUM_MG: 150_000, // 150 g
        SODIUM_MG: 39_000, // pure salt is ~39 g sodium
        SELENIUM_UG: 2e8, // 200 g
      }),
    ).toEqual({ PROTEIN_G: 100, SODIUM_MG: 39000 });
    expect(cleanNutrients({ ENERGY_KCAL: 900 })).toEqual({ ENERGY_KCAL: 900 });
  });
});

describe('titleCaseIfAllCaps', () => {
  it('title-cases shouting text only', () => {
    expect(titleCaseIfAllCaps('CHOCOLATE CHIP COOKIES, 12 OZ')).toBe(
      'Chocolate Chip Cookies, 12 Oz',
    );
    expect(titleCaseIfAllCaps("NATURE'S OWN BREAD")).toBe("Nature's Own Bread");
    expect(titleCaseIfAllCaps('ALMOND-MILK (UNSWEETENED)')).toBe('Almond-Milk (Unsweetened)');
    expect(titleCaseIfAllCaps('Already Fine')).toBe('Already Fine');
    expect(titleCaseIfAllCaps('iPhone case')).toBe('iPhone case');
    expect(titleCaseIfAllCaps('12345')).toBe('12345');
  });
});

describe('computeCompleteness', () => {
  const total = NUTRIENTS.filter((n) => !n.computed).length;

  it('counts present non-computed nutrients over the catalog total', () => {
    expect(computeCompleteness({})).toBe(0);
    expect(computeCompleteness({ ENERGY_KCAL: 1, PROTEIN_G: 2 })).toBe(
      Number((2 / total).toFixed(4)),
    );
    // computed codes never count
    expect(computeCompleteness({ ENERGY_KCAL: 1, NET_CARBS_G: 1, OMEGA3_G: 1 })).toBe(
      Number((1 / total).toFixed(4)),
    );
    const everything = Object.fromEntries(NON_COMPUTED_CODES.map((c) => [c, 1]));
    expect(computeCompleteness(everything)).toBe(1);
  });

  it('agrees with @cal/core completeness()', () => {
    const sample = {
      ENERGY_KCAL: 539,
      PROTEIN_G: 6.3,
      FAT_G: 30.9,
      CARBS_G: 57.5,
      SODIUM_MG: 41,
      NET_CARBS_G: 54,
    };
    expect(computeCompleteness(sample)).toBeCloseTo(coreCompleteness(sample), 4);
  });
});

describe('buildFoodRow', () => {
  it('builds the exact foods row shape', () => {
    const built = buildFoodRow(base)!;
    expect(built.food).toEqual({
      source: 'off',
      source_id: '123',
      kind: 'branded',
      owner_id: null,
      name: 'Test food',
      brand: 'Acme',
      gtin14: '00000000000123',
      category: null,
      nutrients: { ENERGY_KCAL: 100, PROTEIN_G: 5 },
      completeness: computeCompleteness({ ENERGY_KCAL: 100, PROTEIN_G: 5 }),
      carb_basis: 'excludes_fiber',
      density_g_per_ml: null,
      popularity: 0,
    });
  });

  it('always has the 100 g portion and adds a serving portion when known', () => {
    expect(buildFoodRow(base)!.portions).toEqual([
      { label: '100 g', amount: 100, unit: 'g', grams: 100, sort_order: 0 },
    ]);
    const withServing = buildFoodRow({
      ...base,
      serving: { grams: 37.456, unit: 'g', label: '2 tbsp (37 g)' },
    })!;
    expect(withServing.portions).toEqual([
      { label: '100 g', amount: 100, unit: 'g', grams: 100, sort_order: 0 },
      { label: '2 tbsp (37 g)', amount: 1, unit: 'serving', grams: 37.46, sort_order: 1 },
    ]);
    expect(withServing.food.density_g_per_ml).toBeNull();
  });

  it('treats ml servings as 1 g/ml and sets the density', () => {
    const built = buildFoodRow({
      ...base,
      serving: { grams: 330, unit: 'ml', label: '1 can (330 ml)' },
    })!;
    expect(built.food.density_g_per_ml).toBe(1);
    expect(built.portions[1]).toMatchObject({ grams: 330, unit: 'serving' });
  });

  it('ignores impossible servings', () => {
    for (const grams of [0, -5, Number.NaN, 5001, Number.POSITIVE_INFINITY]) {
      const built = buildFoodRow({ ...base, serving: { grams, unit: 'g', label: 'x' } })!;
      expect(built.portions, String(grams)).toHaveLength(1);
    }
  });

  it('returns null when nothing usable is left', () => {
    expect(buildFoodRow({ ...base, name: '   ' })).toBeNull();
    expect(buildFoodRow({ ...base, nutrients: { PROTEIN_G: Number.NaN, FAT_G: -1 } })).toBeNull();
    expect(buildFoodRow({ ...base, nutrients: {} })).toBeNull();
  });

  it('trims and caps text, nulls empty brand', () => {
    const built = buildFoodRow({
      ...base,
      name: 'x'.repeat(500),
      brand: '  ',
      category: ' Snacks ',
    })!;
    expect(built.food.name).toHaveLength(200);
    expect(built.food.brand).toBeNull();
    expect(built.food.category).toBe('Snacks');
  });

  it('rounds nutrients to 4 significant digits', () => {
    const built = buildFoodRow({
      ...base,
      nutrients: { ENERGY_KCAL: 539.123456, SODIUM_MG: 0.0123456 },
    })!;
    expect(built.food.nutrients).toEqual({ ENERGY_KCAL: 539.1, SODIUM_MG: 0.01235 });
  });

  it('end to end: OFF fixture -> row with plausible completeness', () => {
    const built = buildFoodRow(product(mapOffProduct(offNutella)))!;
    expect(built.food).toMatchObject({
      source: 'off',
      source_id: '3017620422003',
      gtin14: '03017620422003',
    });
    expect(built.food.completeness).toBeGreaterThan(0);
    expect(built.food.completeness).toBeLessThan(0.2);
    expect(built.portions.map((p) => p.label)).toEqual(['100 g', '1 serving (15 g)']);
  });
});
