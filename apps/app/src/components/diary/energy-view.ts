// View-model helpers for the energy summary: the rows of the expenditure breakdown and the props of <EnergySummary>.
// Pure (type-only imports of the components), so the rules can be tested without a renderer.
import {
  energySummaryCaption,
  type EnergyBreakdown,
  type EnergyMode,
  type EnergySummaryMode,
} from '@cal/core';

import type { EnergySummaryProps } from '@/components/charts/EnergySummary';
import { formatInt } from '@/components/settings/format';
import type { DayEnergy } from '@/data/energy';

export interface BreakdownRow {
  key: 'bmr' | 'adjustedBaseline' | 'trackerActivity' | 'exercise' | 'tef';
  label: string;
  hint?: string;
  kcal: number;
}

/** True when the value would be shown as "0". */
const shownAsZero = (kcal: number): boolean => Math.round(kcal) === 0;

/**
 * The parts of the day's expenditure, in Cronometer's order: BMR, Adjusted baseline activity (hidden once tracker
 * activity and exercise replaced all of it), Tracker activity (only with a device), Exercise, Thermic effect of food
 * (only when it adds something). They add up to `breakdown.total`.
 */
export function energyBreakdownRows(breakdown: EnergyBreakdown, opts: { hasDevice: boolean }): BreakdownRow[] {
  const rows: BreakdownRow[] = [
    {
      key: 'bmr',
      label: 'Basal metabolic rate (BMR)',
      hint: breakdown.mode === 'device_total' ? "From your device's resting energy" : undefined,
      kcal: breakdown.bmr,
    },
  ];
  if (!shownAsZero(breakdown.adjustedBaseline)) {
    rows.push({
      key: 'adjustedBaseline',
      label: 'Adjusted baseline activity',
      hint:
        Math.round(breakdown.adjustedBaseline) === Math.round(breakdown.baselineKcal)
          ? 'Everyday movement, from your activity level'
          : `Baseline ${formatInt(breakdown.baselineKcal)} minus what your watch and workouts already covered`,
      kcal: breakdown.adjustedBaseline,
    });
  }
  if (opts.hasDevice) {
    rows.push({
      key: 'trackerActivity',
      label: 'Tracker activity',
      hint: 'General activity from your watch, outside workouts',
      kcal: breakdown.trackerActivity,
    });
  }
  rows.push({ key: 'exercise', label: 'Exercise', kcal: breakdown.exercise });
  if (!shownAsZero(breakdown.tef)) {
    rows.push({ key: 'tef', label: 'Thermic effect of food', hint: 'Energy spent digesting what you ate', kcal: breakdown.tef });
  }
  return rows;
}

/** One sentence on how the day's expenditure is assembled in this energy mode. */
export function energyModeSummary(mode: EnergyMode): string {
  switch (mode) {
    case 'static':
      return 'Baseline activity only: your watch is ignored. Every hour of exercise you log takes one sixteenth of your baseline, because you were not doing everyday movement then.';
    case 'device_adjusted':
      return 'Your watch activity outside workouts replaces the baseline during the day and workouts are added. At the start of the day the baseline covers everything not yet recorded.';
    case 'device_total':
      return "Your device's active and resting calories only.";
  }
}

/** Props of <EnergySummary> from a day's energy, except the macro split. */
export function energySummaryProps(
  energy: Pick<
    DayEnergy,
    'consumedKcal' | 'expenditureKcal' | 'targetKcal' | 'exerciseBurnedKcal' | 'remainingKcal' | 'summaryMode' | 'breakdown' | 'deviceEnergy' | 'mode'
  >,
  onToggleSummaryMode?: () => void,
): EnergySummaryProps {
  return {
    consumed: energy.consumedKcal,
    expenditure: energy.expenditureKcal,
    target: energy.targetKcal,
    aboveBaseline: energy.exerciseBurnedKcal,
    remaining: energy.remainingKcal,
    summaryMode: energy.summaryMode,
    onToggleSummaryMode,
    breakdown: energy.breakdown,
    hasDevice: energy.mode !== 'static' && energy.deviceEnergy !== undefined,
  };
}

/** Caption and value of the third circle: Remaining / Over (Target) or Deficit / Surplus (Balance); the value is absolute. */
export function thirdCircle(mode: EnergySummaryMode, value: number | undefined): { caption: string; kcal: number | undefined; negative: boolean } {
  return {
    caption: energySummaryCaption(mode, value),
    kcal: value === undefined ? undefined : Math.abs(value),
    negative: value !== undefined && value < 0,
  };
}
