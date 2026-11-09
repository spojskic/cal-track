// Day energy: consumed vs expenditure vs target. Built from the resolved targets, the profile's energy mode,
// logged exercise, device energy rows and the thermic effect of food, using the core expenditure model.
import { useMemo } from 'react';
import {
  computeExpenditure,
  dedupeExercises,
  type DeviceWorkout,
  type EnergyBreakdown,
  type EnergyMode,
} from '@cal/core';

import { useDailyEnergy, useExerciseEntries, type DailyEnergyRow, type ExerciseEntry } from './activity';
import { useDayNutrients, type DayNutrients } from './diary';
import { useProfile } from './profile';
import { useTargets, type ResolvedTargets } from './targets';

export interface DayEnergy {
  date: string;
  isLoading: boolean;
  mode: EnergyMode;
  /** Energy eaten that day. */
  consumedKcal: number;
  /** Plan target (maintenance + goal delta, floor applied). Excludes exercise and TEF. Undefined until targets resolve. */
  targetKcal: number | undefined;
  /** Expenditure split per component; undefined until targets resolve. */
  breakdown: EnergyBreakdown | undefined;
  /** `breakdown.total` (BMR + activity + exercise + TEF). */
  expenditureKcal: number | undefined;
  /**
   * Energy burned ABOVE the planned maintenance (BMR + baseline activity), excluding TEF: counted exercise and,
   * in device modes, device activity above baseline. This is what widens the day's budget.
   */
  exerciseBurnedKcal: number;
  /** targetKcal + exerciseBurnedKcal. */
  budgetKcal: number | undefined;
  /** consumed - exerciseBurned (what Cronometer shows as "net"). */
  netKcal: number;
  /** budget - consumed; negative = over. Undefined without targets. */
  remainingKcal: number | undefined;
  /** All exercise rows of the day (manual and device). */
  exercise: ExerciseEntry[];
  /** Device energy row used for the calculation (preferred source), if any. */
  deviceEnergy: DailyEnergyRow | undefined;
  /** Every device energy row of the day. */
  deviceEnergyRows: DailyEnergyRow[];
}

const SOURCE_PRIORITY = ['garmin', 'apple_health', 'health_connect', 'manual'];

/** One device row per day (rows from several sources would double count): first by source priority with active kcal. */
export function pickDeviceEnergy(rows: readonly DailyEnergyRow[]): DailyEnergyRow | undefined {
  const rank = (r: DailyEnergyRow) => {
    const i = SOURCE_PRIORITY.indexOf(r.source);
    return i === -1 ? SOURCE_PRIORITY.length : i;
  };
  return [...rows].filter((r) => r.active_kcal !== null).sort((a, b) => rank(a) - rank(b))[0];
}

const EMPTY_EXERCISE: ExerciseEntry[] = [];
const EMPTY_ENERGY_ROWS: DailyEnergyRow[] = [];

interface Inputs {
  mode: EnergyMode;
  tefEnabled: boolean;
  consumedKcal: number;
  targets: ResolvedTargets | undefined;
  exercise: readonly ExerciseEntry[];
  deviceRows: readonly DailyEnergyRow[];
}

const toMs = (iso: string | null): number | undefined => {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
};

/** Pure core of {@link useDayEnergy}. */
export function computeDayEnergy(input: Inputs) {
  const { mode, tefEnabled, consumedKcal, targets, exercise, deviceRows } = input;
  const device = pickDeviceEnergy(deviceRows);
  const hasDeviceActive = device !== undefined;
  const counted = exercise.filter((e) => e.counts_toward_energy);

  // Device modes already measured device activity (workouts included): only manual entries that do not overlap a
  // device workout may be added on top. Without device data (or in static mode) every counted entry is used.
  let exerciseForEnergy: readonly ExerciseEntry[] = counted;
  if (mode !== 'static' && hasDeviceActive) {
    // Device workouts are stored with counts_toward_energy = false (their kcal is already inside the
    // device's daily active energy), so they must come from ALL entries, not only the counted ones.
    const workouts: DeviceWorkout[] = exercise
      .filter((e) => e.source !== 'manual')
      .flatMap((e) => {
        const startMs = toMs(e.started_at);
        const endMs = toMs(e.ended_at);
        return startMs !== undefined && endMs !== undefined ? [{ startMs, endMs }] : [];
      });
    const manual = counted
      .filter((e) => e.source === 'manual')
      .map((e) => ({ entry: e, startMs: toMs(e.started_at), endMs: toMs(e.ended_at) }));
    exerciseForEnergy = dedupeExercises(manual, workouts).map((m) => m.entry);
  }
  const manualExerciseKcal = exerciseForEnergy.reduce((s, e) => s + (Number(e.kcal) || 0), 0);

  if (!targets) {
    return {
      breakdown: undefined,
      targetKcal: undefined,
      exerciseBurnedKcal: manualExerciseKcal,
    };
  }

  const breakdown = computeExpenditure({
    mode,
    bmr: targets.bmr,
    baselineActivityKcal: targets.baselineActivityKcal,
    manualExerciseKcal,
    deviceActiveKcal: device?.active_kcal ?? null,
    deviceRestingKcal: device?.resting_kcal ?? null,
    intakeKcal: consumedKcal,
    tefEnabled,
  });
  const extra = breakdown.total - breakdown.tef - targets.energy.maintenance;
  return {
    breakdown,
    targetKcal: targets.energy.target,
    exerciseBurnedKcal: Math.max(0, extra),
  };
}

/** Energy balance of one diary day, honouring profile.energy_mode and TEF. Safe before targets resolve. */
export function useDayEnergy(date: string): DayEnergy {
  return useDayEnergyFrom(date, useDayNutrients(date));
}

/** Same as {@link useDayEnergy} but reuses day totals the caller already computed with `useDayNutrients`. */
export function useDayEnergyFrom(date: string, day: DayNutrients): DayEnergy {
  const targetsQ = useTargets();
  const profileQ = useProfile();
  const exerciseQ = useExerciseEntries(date);
  const deviceQ = useDailyEnergy(date);

  const targets = targetsQ.data;
  const mode: EnergyMode = profileQ.data?.energy_mode ?? targets?.profile.energy_mode ?? 'static';
  const tefEnabled = profileQ.data?.tef_enabled ?? targets?.profile.tef_enabled ?? true;
  const exercise = exerciseQ.data ?? EMPTY_EXERCISE;
  const deviceRows = deviceQ.data ?? EMPTY_ENERGY_ROWS;
  const consumedKcal = day.kcal;

  const computed = useMemo(
    () => computeDayEnergy({ mode, tefEnabled, consumedKcal, targets, exercise, deviceRows }),
    [mode, tefEnabled, consumedKcal, targets, exercise, deviceRows],
  );

  const budgetKcal = computed.targetKcal === undefined ? undefined : computed.targetKcal + computed.exerciseBurnedKcal;
  return {
    date,
    isLoading: targetsQ.isLoading || profileQ.isLoading,
    mode,
    consumedKcal,
    targetKcal: computed.targetKcal,
    breakdown: computed.breakdown,
    expenditureKcal: computed.breakdown?.total,
    exerciseBurnedKcal: computed.exerciseBurnedKcal,
    budgetKcal,
    netKcal: consumedKcal - computed.exerciseBurnedKcal,
    remainingKcal: budgetKcal === undefined ? undefined : budgetKcal - consumedKcal,
    exercise,
    deviceEnergy: pickDeviceEnergy(deviceRows),
    deviceEnergyRows: deviceRows as DailyEnergyRow[],
  };
}
