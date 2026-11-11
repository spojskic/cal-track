// Totals of a meal group for the "Show Nutrition Summary" sheet. Same math as the day totals: every entry already has
// its nutrients scaled to the eaten grams and derived (DiaryEntry.nutrients); they are summed with the core helper,
// where a nutrient no entry has data for stays unknown (never turned into 0) and a partially known one is flagged.
import {
  NUTRIENT_BY_CODE,
  sumNutrientsDetailed,
  type NutrientCode,
  type NutrientMap,
} from '@ration/core';

export interface SummaryRow {
  code: NutrientCode;
  name: string;
  unit: string;
  amount: number;
  /** Known for some entries but not all: the amount is a lower bound. */
  incomplete: boolean;
}

export interface SummarySection {
  key: string;
  label: string;
  rows: SummaryRow[];
}

export interface HeadlineStat {
  key: 'energy' | 'protein' | 'carbs' | 'fat';
  label: string;
  unit: string;
  /** undefined = no entry has data for it. */
  amount: number | undefined;
  incomplete: boolean;
}

export interface GroupSummary {
  count: number;
  headline: HeadlineStat[];
  sections: SummarySection[];
  totals: NutrientMap;
  incompleteNutrients: NutrientCode[];
}

/** The main nutrients below the headline macros; only the ones with data are listed. */
const SECTIONS: readonly { key: string; label: string; codes: readonly NutrientCode[] }[] = [
  {
    key: 'carbs',
    label: 'Carbohydrates',
    codes: ['CARBS_G', 'NET_CARBS_G', 'FIBER_G', 'SUGARS_G', 'ADDED_SUGARS_G'],
  },
  {
    key: 'lipids',
    label: 'Lipids',
    codes: [
      'SATURATED_FAT_G',
      'MONOUNSATURATED_FAT_G',
      'POLYUNSATURATED_FAT_G',
      'TRANS_FAT_G',
      'CHOLESTEROL_MG',
      'OMEGA3_G',
      'OMEGA6_G',
    ],
  },
  { key: 'general', label: 'General', codes: ['WATER_G', 'ALCOHOL_G', 'CAFFEINE_MG'] },
  {
    key: 'vitamins',
    label: 'Vitamins',
    codes: [
      'VITAMIN_A_UG',
      'VITAMIN_C_MG',
      'VITAMIN_D_UG',
      'VITAMIN_E_MG',
      'VITAMIN_K_UG',
      'B1_THIAMIN_MG',
      'B2_RIBOFLAVIN_MG',
      'B3_NIACIN_MG',
      'B6_MG',
      'FOLATE_UG',
      'B12_UG',
    ],
  },
  {
    key: 'minerals',
    label: 'Minerals',
    codes: ['CALCIUM_MG', 'IRON_MG', 'MAGNESIUM_MG', 'POTASSIUM_MG', 'SODIUM_MG', 'ZINC_MG'],
  },
];

/**
 * Summary of a list of diary entries (anything with scaled `nutrients`). `netCarbs` picks which carbohydrate figure the
 * headline shows; the Carbohydrates section lists both.
 */
export function buildGroupSummary(entries: readonly { nutrients: NutrientMap }[], netCarbs: boolean): GroupSummary {
  const { totals, incompleteNutrients } = sumNutrientsDetailed(entries.map((e) => e.nutrients));
  const incomplete = new Set<NutrientCode>(incompleteNutrients);
  const carbsCode: NutrientCode = netCarbs ? 'NET_CARBS_G' : 'CARBS_G';

  const stat = (key: HeadlineStat['key'], label: string, code: NutrientCode): HeadlineStat => ({
    key,
    label,
    unit: NUTRIENT_BY_CODE[code].unit,
    amount: totals[code],
    incomplete: incomplete.has(code),
  });

  const sections: SummarySection[] = [];
  for (const section of SECTIONS) {
    const rows: SummaryRow[] = [];
    for (const code of section.codes) {
      const amount = totals[code];
      if (amount === undefined) continue;
      const def = NUTRIENT_BY_CODE[code];
      rows.push({ code, name: def.shortName ?? def.name, unit: def.unit, amount, incomplete: incomplete.has(code) });
    }
    if (rows.length > 0) sections.push({ key: section.key, label: section.label, rows });
  }

  return {
    count: entries.length,
    headline: [
      stat('energy', 'Energy', 'ENERGY_KCAL'),
      stat('protein', 'Protein', 'PROTEIN_G'),
      stat('carbs', netCarbs ? 'Net Carbs' : 'Carbs', carbsCode),
      stat('fat', 'Fat', 'FAT_G'),
    ],
    sections,
    totals,
    incompleteNutrients,
  };
}
