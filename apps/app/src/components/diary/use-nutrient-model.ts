// What the nutrient targets show, computed once for every layout: the phone's stack of cards (NutrientTargetsPanel) and the desktop
// panels (NutrientPanels) read the same score, highlighted rings and grouped rows.
import { useMemo } from 'react';
import {
  NUTRIENTS,
  NUTRIENT_GROUPS,
  nutritionScore,
  type NutrientCode,
  type NutrientGroup,
  type NutrientMap,
} from '@ration/core';

import type { HighlightRingItem } from '@/components/charts/HighlightRings';
import type { ResolvedTargets } from '@/data/targets';
import { useTheme } from '@/theme';

import { scoreDetailText } from './score-details';
import { amountOf, buildHighlights, effectiveTarget } from './targets-view';

const SUB_NUTRIENTS = new Set<NutrientCode>([
  'SOLUBLE_FIBER_G',
  'INSOLUBLE_FIBER_G',
  'ADDED_SUGARS_G',
  'SATURATED_FAT_G',
  'MONOUNSATURATED_FAT_G',
  'POLYUNSATURATED_FAT_G',
  'TRANS_FAT_G',
]);

export interface NutrientRowData {
  code: NutrientCode;
  name: string;
  unit: string;
  amount: number | undefined;
  min?: number;
  max?: number;
  incomplete: boolean;
  indent: boolean;
}

export interface NutrientGroupData {
  code: NutrientGroup;
  label: string;
  rows: NutrientRowData[];
}

export interface NutrientModel {
  /** The targets are known (they are not while the user has not set them up). */
  hasTargets: boolean;
  /** Undefined without targets or entries. */
  score: ReturnType<typeof nutritionScore> | undefined;
  scoreColor: string;
  coverageText: string;
  /** Why the score is what it is (targets reached, nutrients over a limit); undefined without a score. */
  scoreDetailText: string | undefined;
  highlights: HighlightRingItem[];
  groups: NutrientGroupData[];
}

/**
 * Nutrition score, highlighted nutrient rings and the grouped nutrient rows (General, Carbohydrates, Lipids, Protein, Vitamins,
 * Minerals). A row is listed when it has a target or at least one logged food has data for it.
 */
export function useNutrientModel(args: {
  totals: NutrientMap;
  hasEntries: boolean;
  incompleteNutrients: readonly NutrientCode[];
  targets: ResolvedTargets | undefined;
  netCarbs: boolean;
}): NutrientModel {
  const { totals, hasEntries, incompleteNutrients, targets, netCarbs } = args;
  const { colors } = useTheme();

  const score = useMemo(
    () => (targets && hasEntries ? nutritionScore(totals, targets.nutrients) : undefined),
    [totals, targets, hasEntries],
  );
  const highlights = useMemo(
    () => buildHighlights({ colors, totals, hasEntries, targets, netCarbs }),
    [colors, totals, hasEntries, targets, netCarbs],
  );
  const groups = useMemo<NutrientGroupData[]>(() => {
    const incomplete = new Set(incompleteNutrients);
    return NUTRIENT_GROUPS.map((group) => {
      const rows: NutrientRowData[] = [];
      for (const def of NUTRIENTS) {
        if (def.group !== group.code) continue;
        const target = effectiveTarget(def.code, targets, netCarbs);
        const hasTarget = Boolean(target?.min || target?.max);
        const known = totals[def.code] !== undefined;
        if (!hasTarget && !known) continue;
        rows.push({
          code: def.code,
          name: def.shortName ?? def.name,
          unit: def.unit,
          amount: amountOf(totals, def.code, hasEntries),
          min: target?.min,
          max: target?.max,
          incomplete: incomplete.has(def.code),
          indent: SUB_NUTRIENTS.has(def.code) || (def.group === 'protein' && def.code !== 'PROTEIN_G'),
        });
      }
      return { ...group, rows };
    }).filter((g) => g.rows.length > 0);
  }, [totals, hasEntries, targets, netCarbs, incompleteNutrients]);

  const scoreColor =
    score === undefined ? colors.track : score.score >= 80 ? colors.success : score.score >= 50 ? colors.warning : colors.danger;
  const coverageText = !targets
    ? 'Set up your targets to see a score.'
    : !hasEntries
      ? 'Log food to see your score.'
      : `${Math.round((score?.coverage ?? 0) * 100)}% of targeted nutrients have data in your foods.`;

  const detailText = score ? scoreDetailText(score) : undefined;

  return { hasTargets: targets !== undefined, score, scoreColor, coverageText, scoreDetailText: detailText, highlights, groups };
}
