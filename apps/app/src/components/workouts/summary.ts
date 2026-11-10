// The rows of the workout detail screen as plain data (no React), so what the screen says is unit tested in tools/ui-smoke.
// "Show only what exists": a value that is not known has no row.
import type { UnitSystem } from '@cal/core';
import { isPacedKey } from '@cal/garmin';

import type { WorkoutEntry, WorkoutRow } from '@/data/workouts';

import {
  formatDistance,
  formatClockDuration,
  formatElevation,
  formatHr,
  formatKcal,
  formatLongDate,
  formatMinutes,
  formatPace,
  formatSpeed,
  formatTimeRange,
  formatWhen,
  plausibleHr,
  sourceLabel,
  trainingEffectLabel,
} from './format';
import { workoutKind } from './kinds';

export interface SummaryRow {
  /** Stable key (tests, React keys). */
  key: string;
  label: string;
  value: string;
  hint?: string;
}

export interface SummarySection {
  key: 'summary' | 'heart' | 'effect';
  title: string;
  rows: SummaryRow[];
}

/** Whether a pace (min/km) or a speed (km/h) is the natural way to say how fast this workout was. */
function wantsPace(entry: Pick<WorkoutEntry, 'name' | 'activity_code' | 'details'>): boolean {
  if (entry.details?.typeKey) return isPacedKey(entry.details.typeKey);
  const kind = workoutKind({ name: entry.name, activity_code: entry.activity_code });
  return kind === 'running' || kind === 'walking' || kind === 'hiking';
}

/** The sections of facts shown under the workout's title. Sections without a row are left out. */
export function summarySections(entry: WorkoutEntry, system: UnitSystem): SummarySection[] {
  const d = entry.details;
  const summary: SummaryRow[] = [];

  summary.push({ key: 'date', label: 'Date', value: formatLongDate(entry.entry_date) });
  const range = formatTimeRange(entry.started_at, entry.ended_at);
  if (range) summary.push({ key: 'time', label: 'Time', value: range });
  if (entry.minutes !== null && entry.minutes > 0) summary.push({ key: 'duration', label: 'Duration', value: formatMinutes(entry.minutes) });

  const manual = entry.source === 'manual';
  const kcalHint = manual
    ? entry.counts_toward_energy
      ? 'Counts toward your energy budget'
      : 'Not counted in your energy budget'
    : d?.activeCalories !== undefined
      ? `${formatKcal(d.activeCalories)} active`
      : undefined;
  summary.push({ key: 'calories', label: 'Calories', value: formatKcal(entry.kcal), ...(kcalHint ? { hint: kcalHint } : {}) });
  summary.push({ key: 'source', label: 'Source', value: sourceLabel(entry.source) });

  if (d?.distanceM !== undefined) summary.push({ key: 'distance', label: 'Distance', value: formatDistance(d.distanceM, system) });
  if (wantsPace(entry) && d?.avgPaceSecPerKm !== undefined) {
    summary.push({ key: 'pace', label: 'Average pace', value: formatPace(d.avgPaceSecPerKm, system) });
  } else if (d?.avgSpeedMps !== undefined && d.distanceM !== undefined) {
    summary.push({ key: 'speed', label: 'Average speed', value: formatSpeed(d.avgSpeedMps, system) });
  }
  if (d?.elevationGainM !== undefined) summary.push({ key: 'elevation', label: 'Elevation gain', value: formatElevation(d.elevationGainM, system) });

  const heart: SummaryRow[] = [];
  const avg = plausibleHr(d?.avgHr);
  const max = plausibleHr(d?.maxHr);
  const min = plausibleHr(d?.minHr);
  if (avg !== null) heart.push({ key: 'avg-hr', label: 'Average heart rate', value: formatHr(avg) });
  if (max !== null) heart.push({ key: 'max-hr', label: 'Max heart rate', value: formatHr(max) });
  if (min !== null) heart.push({ key: 'min-hr', label: 'Lowest heart rate', value: formatHr(min) });

  const effect: SummaryRow[] = [];
  const te = d?.trainingEffect;
  if (te?.aerobic !== undefined) effect.push({ key: 'aerobic', label: 'Aerobic effect', value: String(te.aerobic), hint: trainingEffectLabel(te.aerobic) });
  if (te?.anaerobic !== undefined) effect.push({ key: 'anaerobic', label: 'Anaerobic effect', value: String(te.anaerobic), hint: trainingEffectLabel(te.anaerobic) });

  return [
    { key: 'summary' as const, title: 'Summary', rows: summary },
    { key: 'heart' as const, title: 'Heart rate', rows: heart },
    { key: 'effect' as const, title: 'Training effect', rows: effect },
  ].filter((s) => s.rows.length > 0);
}

/** One line for a lap: "1 km - 6:00 /km - 148 bpm". */
export function lapLine(lap: NonNullable<NonNullable<WorkoutEntry['details']>['laps']>[number], system: UnitSystem): string {
  const parts: string[] = [];
  if (lap.distanceM !== undefined) parts.push(formatDistance(lap.distanceM, system));
  if (lap.paceSecPerKm !== undefined) parts.push(formatPace(lap.paceSecPerKm, system));
  else if (lap.durationSec !== undefined) parts.push(formatClockDuration(lap.durationSec));
  const hr = plausibleHr(lap.avgHr);
  if (hr !== null) parts.push(formatHr(hr));
  return parts.join(' - ');
}

export interface WorkoutRowText {
  title: string;
  /** "Tue 10 Nov, 07:00 - 45 min" */
  line: string;
  /** "245" and "kcal" (two lines in the right column) */
  kcal: string;
  source: string;
  /** "avg 128 bpm" when a device reported it */
  hr: string | null;
  /** What a screen reader says for the whole row. */
  label: string;
}

/** The text of one row of the workout list. */
export function workoutRowText(row: WorkoutRow): WorkoutRowText {
  const bits = [formatWhen(row), row.minutes !== null && row.minutes > 0 ? formatMinutes(row.minutes) : null].filter((b): b is string => b !== null);
  const bpm = plausibleHr(row.avg_hr);
  const hr = bpm !== null ? `avg ${bpm} bpm` : null;
  const kcal = Math.round(row.kcal).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const source = sourceLabel(row.source);
  return {
    title: row.name,
    line: bits.join(' - '),
    kcal,
    source,
    hr,
    label: [row.name, ...bits, `${kcal} kilocalories`, source, hr].filter(Boolean).join(', '),
  };
}
