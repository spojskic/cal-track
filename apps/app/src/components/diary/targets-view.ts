// View-model helpers: turn day totals + resolved targets into the rows/rings the diary and dashboard draw.
import {
  HIGHLIGHT_NUTRIENT_CODES,
  NUTRIENT_BY_CODE,
  tryComputeMacroTargets,
  type NutrientCode,
  type NutrientMap,
  type Target,
} from '@ration/core';

import { nutrientFraction, nutrientStatus } from '@/components/charts/nutrient-status';
import type { HighlightRingItem } from '@/components/charts/HighlightRings';
import type { MacroKcal } from '@/components/charts/MacroSplitBar';
import type { ResolvedTargets } from '@/data/targets';
import type { ThemeColors } from '@/theme';

/** Amount of a nutrient in the day totals: unknown (undefined) only when entries exist but none has data. */
export function amountOf(totals: NutrientMap, code: NutrientCode, hasEntries: boolean): number | undefined {
  return totals[code] ?? (hasEntries ? undefined : 0);
}

export interface MacroRow {
  key: 'energy' | 'protein' | 'carbs' | 'fat';
  label: string;
  unit: string;
  value: number | undefined;
  target: number | undefined;
  color: string;
  overIsBad: boolean;
  decimals: number;
}

/**
 * Macro targets for ONE day: the resolved macros re-derived from the day's energy budget (the plan target plus
 * what burning above the baseline adds) when the mode can be recomputed, so a day with a workout gets proportionally
 * bigger carb/fat targets while protein-per-kg stays anchored to the body weight. A `fixed` mode recomputes to the
 * same typed grams, and when the mode cannot be recomputed (or produces nothing) the static macros stand.
 */
function dayMacros(targets: ResolvedTargets, budgetExtraKcal: number) {
  // The budget is also the Energy row's target (same expression below); Number.isFinite keeps both rows on the
  // static plan when the extra is not a finite number, instead of NaN on one row and a fallback on the other.
  const extra = Number.isFinite(budgetExtraKcal) ? Math.max(0, budgetExtraKcal) : 0;
  const budget = targets.energy.target + extra;
  const attempt =
    budget > 0
      ? tryComputeMacroTargets(targets.macroMode, budget, {
          weightKg: targets.weightKg,
          bodyFatPct: targets.bodyFatPct,
        })
      : { macros: null };
  return attempt.macros ?? targets.macros;
}

/**
 * Energy / protein / (net) carbs / fat rows for the macro bars. The energy row compares what was eaten with the day's budget: the
 * energy target plus what burning above the baseline adds to it (`budgetExtraKcal`), the same budget the energy summary's third
 * circle uses. It used to compare the eaten energy minus the burned energy with the plain target, which showed an empty bar and
 * 0% for a day with a hard workout and a normal breakfast. The macro rows compare with the macros of the SAME day budget
 * (see {@link dayMacros}), so a workout grows the carb/fat targets with the budget instead of leaving them at the plan numbers.
 */
export function buildMacroRows(args: {
  colors: ThemeColors;
  totals: NutrientMap;
  hasEntries: boolean;
  targets: ResolvedTargets | undefined;
  netCarbs: boolean;
  /** What burning above the baseline adds to the energy target today (`DayEnergy.exerciseBurnedKcal`). */
  budgetExtraKcal: number;
}): MacroRow[] {
  const { colors, totals, hasEntries, targets, netCarbs, budgetExtraKcal } = args;
  const energy = amountOf(totals, 'ENERGY_KCAL', hasEntries);
  // The same clamped extra dayMacros uses, so the energy row and the macro rows always speak of one budget.
  const extra = Number.isFinite(budgetExtraKcal) ? Math.max(0, budgetExtraKcal) : 0;
  const macros = targets ? dayMacros(targets, budgetExtraKcal) : undefined;
  const carbsCode: NutrientCode = netCarbs ? 'NET_CARBS_G' : 'CARBS_G';
  return [
    {
      key: 'energy',
      label: 'Energy',
      unit: 'kcal',
      value: energy,
      target: targets ? targets.energy.target + extra : undefined,
      color: colors.energy,
      overIsBad: true,
      decimals: 0,
    },
    {
      key: 'protein',
      label: 'Protein',
      unit: 'g',
      value: amountOf(totals, 'PROTEIN_G', hasEntries),
      target: macros?.protein.grams,
      color: colors.protein,
      overIsBad: false,
      decimals: 1,
    },
    {
      key: 'carbs',
      label: netCarbs ? 'Net Carbs' : 'Carbs',
      unit: 'g',
      value: amountOf(totals, carbsCode, hasEntries),
      target: macros?.carbs.grams,
      color: colors.carbs,
      overIsBad: true,
      decimals: 1,
    },
    {
      key: 'fat',
      label: 'Fat',
      unit: 'g',
      value: amountOf(totals, 'FAT_G', hasEntries),
      target: macros?.fat.grams,
      color: colors.fat,
      overIsBad: true,
      decimals: 1,
    },
  ];
}

/** Calorie split of the consumed macros (4/4/9 kcal per gram; net carbs are not used so fiber stays out of the split). */
export function consumedSplit(totals: NutrientMap): MacroKcal | undefined {
  const protein = (totals.PROTEIN_G ?? 0) * 4;
  const carbs = (totals.CARBS_G ?? 0) * 4;
  const fat = (totals.FAT_G ?? 0) * 9;
  return protein + carbs + fat > 0 ? { protein, carbs, fat } : undefined;
}

export function targetSplit(targets: ResolvedTargets | undefined): MacroKcal | undefined {
  if (!targets) return undefined;
  const { protein, carbs, fat } = targets.macros;
  return { protein: protein.kcal, carbs: carbs.kcal, fat: fat.kcal };
}

/**
 * Target used for a nutrient's bar. Macros/energy come from the resolved macro + energy targets; the rest from the
 * DRI/override map. `Target.max` is always a limit on total intake; upper limits that apply only to supplements /
 * synthetic / preformed forms live in `Target.scopedUl` and are never a bound here (total intake cannot be split by
 * form), the same rule as the nutrition score.
 */
export function effectiveTarget(
  code: NutrientCode,
  targets: ResolvedTargets | undefined,
  netCarbs: boolean,
): Target | undefined {
  if (!targets) return undefined;
  switch (code) {
    case 'ENERGY_KCAL':
      return { min: targets.energy.target, max: targets.energy.target, kind: 'ESTIMATE' };
    case 'PROTEIN_G':
      return { min: targets.macros.protein.grams, kind: 'CUSTOM' };
    case 'FAT_G':
      return { min: targets.macros.fat.grams, max: targets.macros.fat.grams, kind: 'CUSTOM' };
    case 'CARBS_G':
      if (!netCarbs) return { min: targets.macros.carbs.grams, max: targets.macros.carbs.grams, kind: 'CUSTOM' };
      break;
    case 'NET_CARBS_G':
      if (netCarbs) return { min: targets.macros.carbs.grams, max: targets.macros.carbs.grams, kind: 'CUSTOM' };
      break;
    default:
      break;
  }
  return targets.nutrients[code];
}

/** Rings for the highlighted nutrients that have a minimum target. */
export function buildHighlights(args: {
  colors: ThemeColors;
  totals: NutrientMap;
  hasEntries: boolean;
  targets: ResolvedTargets | undefined;
  netCarbs: boolean;
}): HighlightRingItem[] {
  const { colors, totals, hasEntries, targets, netCarbs } = args;
  const items: HighlightRingItem[] = [];
  for (const code of HIGHLIGHT_NUTRIENT_CODES) {
    const target = effectiveTarget(code, targets, netCarbs);
    if (!target?.min) continue;
    const amount = amountOf(totals, code, hasEntries);
    const fraction = nutrientFraction(amount, target.min, target.max);
    const status = nutrientStatus(amount, target.min, target.max);
    const def = NUTRIENT_BY_CODE[code];
    items.push({
      key: code,
      label: def.shortName ?? def.name,
      fraction: fraction ?? 0,
      text: fraction === undefined ? '-' : `${Math.round(fraction * 100)}%`,
      color: status === 'over' ? colors.danger : status === 'ok' ? colors.success : colors.carbs,
      overColor: colors.danger,
    });
  }
  return items;
}
