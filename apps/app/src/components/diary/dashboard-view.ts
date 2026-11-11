// The numbers and texts of the desktop dashboard as plain data (no React, no React Native), so what the KPI strip, the bar lists and
// the weight panel say is unit tested in tools/ui-smoke. The components (DashboardPanels.tsx) only draw them.
import { energySummaryCaption, type EnergySummaryMode } from '@ration/core';

import { formatNumber } from '@/components/charts/format';
import type { BarRow, BarTone } from '@/components/desktop-layout';

import { macroProgress } from './macro-progress';
import type { MacroRow } from './targets-view';

/** The two colours a bar needs for "past the target": the limit colour (danger) and the goal colour (success). */
export interface OverColors {
  danger: string;
  success: string;
}

// ------------------------------------------------------------------------------------------------ bar lists

/** The macro rows (Energy, Protein, Carbs, Fat) of the targets as aligned bar list rows. Same accessible names as the phone's bars. */
export function macroBarRows(rows: readonly MacroRow[], colors: OverColors): BarRow[] {
  return rows.map((row) => {
    const p = macroProgress({
      value: row.value,
      target: row.target,
      netValue: row.netValue,
      unit: row.unit,
      decimals: row.decimals,
      overIsBad: row.overIsBad,
    });
    return {
      key: row.key,
      label: row.label,
      valueText: p.valueText,
      pctText: p.pctText,
      tone: p.tone,
      color: row.color,
      overColor: row.overIsBad ? colors.danger : colors.success,
      fill: p.mainFill,
      overFill: p.overFill,
      markAt: p.markAt,
      accessibilityLabel: `${row.label}: ${p.valueText}${p.pctText ? `, ${p.pctText}` : ''}`,
      now: p.now,
    };
  });
}

export interface AverageMacro {
  key: string;
  label: string;
  g: number;
  /** Share of the calories (0..100). */
  pct: number;
  color: string;
}

/** The protein / carbs / fat shares of the average day as bar list rows (the bar is the share of the calories). */
export function averageBarRows(macros: readonly AverageMacro[], colors: OverColors): BarRow[] {
  return macros.map((m) => {
    const pct = Math.max(0, Math.min(100, Number.isFinite(m.pct) ? m.pct : 0));
    return {
      key: m.key,
      label: m.label,
      valueText: `${formatNumber(m.g, 1, true)} g`,
      pctText: `${Math.round(m.pct)}%`,
      tone: 'muted' as const,
      color: m.color,
      overColor: colors.danger,
      fill: pct / 100,
      overFill: 0,
      markAt: undefined,
      accessibilityLabel: `${m.label} ${formatNumber(m.g, 1, true)} grams, ${Math.round(m.pct)} percent of calories`,
      now: Math.round(pct),
    };
  });
}

/** "6 items, 2,376 kcal": what the diary's entry panel says about the day next to its title. */
export function entriesMeta(count: number, kcal: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}, ${formatNumber(kcal)} kcal`;
}

// ------------------------------------------------------------------------------------------------ KPI cells

export interface KpiData {
  label: string;
  value: string;
  unit: string;
  /** "of 150 g - 82%"; undefined without a target. */
  delta: string | undefined;
  deltaTone: BarTone;
  /** Share of the target (1 = 100 %); undefined without a target or an amount. */
  fraction: number | undefined;
  color: string;
  overColor: string;
  /** What a screen reader says for the progress strip. */
  progressLabel: string;
}

/** A macro or energy row as a KPI cell: the amount big, "of <target> - <percent>" under it, a progress strip. */
export function macroKpi(row: MacroRow, colors: OverColors): KpiData {
  const p = macroProgress({
    value: row.value,
    target: row.target,
    netValue: row.netValue,
    unit: row.unit,
    decimals: row.decimals,
    overIsBad: row.overIsBad,
  });
  const hasTarget = typeof row.target === 'number' && row.target > 0;
  const delta = hasTarget ? `of ${formatNumber(row.target, 0, true)} ${row.unit}${p.pctText ? ` - ${p.pctText}` : ''}` : undefined;
  return {
    label: row.label,
    value: formatNumber(row.value, 0, true),
    unit: row.unit,
    delta,
    deltaTone: p.tone,
    fraction: p.pct,
    color: row.color,
    overColor: row.overIsBad ? colors.danger : colors.success,
    progressLabel: `${row.label}: ${p.valueText}${p.pctText ? `, ${p.pctText}` : ''}`,
  };
}

export interface RemainingKpi {
  /** Remaining / Over (Target view), Deficit / Surplus (Balance view). */
  label: string;
  value: string;
  unit: 'kcal';
  delta: string | undefined;
  deltaTone: BarTone;
  /** Consumed against the budget (Target) or against what was burned (Balance); undefined when that is not known. */
  fraction: number | undefined;
  negative: boolean;
}

/** The "Remaining" cell of the strip: the third circle of the energy summary, in the view the user picked. */
export function remainingKpi(input: {
  remaining: number | undefined;
  mode: EnergySummaryMode;
  consumed: number;
  /** Target plus exercise above the baseline. */
  budget: number | undefined;
  expenditure: number | undefined;
}): RemainingKpi {
  const { remaining, mode, consumed, budget, expenditure } = input;
  const known = remaining !== undefined && Number.isFinite(remaining);
  const negative = known && remaining < 0;
  const scale = mode === 'balance' ? expenditure : budget;
  const fraction = scale !== undefined && scale > 0 ? consumed / scale : undefined;
  const delta =
    mode === 'balance'
      ? expenditure === undefined
        ? undefined
        : `burned ${formatNumber(expenditure)} kcal`
      : budget === undefined
        ? undefined
        : `of ${formatNumber(budget)} kcal budget`;
  return {
    label: energySummaryCaption(mode, remaining),
    value: known ? formatNumber(Math.abs(remaining)) : '-',
    unit: 'kcal',
    delta,
    deltaTone: negative && mode === 'target' ? 'danger' : 'muted',
    fraction,
    negative,
  };
}

/** The line under the streak: what to do next. */
export function streakMessage(streak: number, loggedToday: boolean, loading = false): string {
  if (loading) return '';
  if (streak === 0) return 'Log something today to start a streak.';
  return loggedToday ? 'Logged today. Nice work.' : 'Log something today to keep it going.';
}

// ------------------------------------------------------------------------------------------------ weight

export interface WeightStats {
  count: number;
  latestKg: number | undefined;
  firstKg: number | undefined;
  /** latest - first (kg); undefined with fewer than two weigh-ins. */
  changeKg: number | undefined;
  lowestKg: number | undefined;
  highestKg: number | undefined;
  latestDate: string | undefined;
}

/** Latest, change, lowest and highest weight of a series (oldest first). */
export function weightStats(points: readonly { date: string; kg: number }[]): WeightStats {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) {
    return { count: 0, latestKg: undefined, firstKg: undefined, changeKg: undefined, lowestKg: undefined, highestKg: undefined, latestDate: undefined };
  }
  const kgs = points.map((p) => p.kg);
  return {
    count: points.length,
    latestKg: last.kg,
    firstKg: first.kg,
    changeKg: points.length > 1 ? last.kg - first.kg : undefined,
    lowestKg: Math.min(...kgs),
    highestKg: Math.max(...kgs),
    latestDate: last.date,
  };
}

/** "+" / "-" / "" for a change in kg: nothing below 50 g, where the change reads as zero. */
export function changeSign(changeKg: number | undefined): '+' | '-' | '' {
  if (changeKg === undefined || Math.abs(changeKg) < 0.05) return '';
  return changeKg > 0 ? '+' : '-';
}
