// Day energy: consumed vs expenditure vs target, the way Cronometer does it. Built from the resolved targets, the
// profile's energy mode, logged exercise, device energy rows and the thermic effect of food, using the core model:
//   Burned = BMR + adjusted baseline + tracker activity + exercise (+ TEF)
//   Target view : remaining = (target + energy burned above the baseline) - consumed
//   Balance view: remaining = Burned - consumed
import { useMemo } from 'react';
import {
  computeExpenditure,
  dedupeExercises,
  energyRemaining,
  isDeviceDayComplete,
  normalizeEnergySummaryMode,
  type DeviceWorkout,
  type EnergyBreakdown,
  type EnergyMode,
  type EnergyRemaining,
  type EnergySummaryMode,
} from '@ration/core';

import { addDays, todayISO } from '@/state/selected-date';

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
  /** `breakdown.total` (BMR + adjusted baseline + tracker activity + exercise + TEF). */
  expenditureKcal: number | undefined;
  /**
   * Energy burned ABOVE the baseline (`breakdown.aboveBaseline`: adjusted baseline + tracker activity + exercise -
   * baseline), TEF excluded. This is what widens the day's budget in the Target view.
   */
  exerciseBurnedKcal: number;
  /** targetKcal + exerciseBurnedKcal. */
  budgetKcal: number | undefined;
  /** consumed - exerciseBurned (what Cronometer shows as "net"). */
  netKcal: number;
  /** The view of the third circle (profile.energy_summary_mode). */
  summaryMode: EnergySummaryMode;
  /** Remaining for the current `summaryMode`; negative = over (Target) / surplus (Balance). Undefined without targets. */
  remainingKcal: number | undefined;
  /** Remaining for both views: target = budget - consumed, balance = expenditure (incl. TEF) - consumed. */
  remainingByMode: EnergyRemaining | undefined;
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
  /**
   * The chosen device row describes a FINISHED day. Device energy is a running total (a Garmin shows 801 resting kcal at
   * midday), so for today the resting part must not stand in for a whole day's BMR in device_total mode. Defaults to true.
   */
  deviceDayComplete?: boolean;
}

const toMs = (iso: string | null): number | undefined => {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
};

/** Minutes of an exercise row: its duration column, else the span between its start and end, else 0 (unknown). */
export function exerciseMinutesOf(e: Pick<ExerciseEntry, 'minutes' | 'started_at' | 'ended_at'>): number {
  const minutes = Number(e.minutes);
  if (Number.isFinite(minutes) && minutes > 0) return minutes;
  const startMs = toMs(e.started_at);
  const endMs = toMs(e.ended_at);
  return startMs !== undefined && endMs !== undefined && endMs > startMs ? (endMs - startMs) / 60_000 : 0;
}

const sumBy = <T>(items: readonly T[], value: (item: T) => number): number => items.reduce((s, item) => s + value(item), 0);

/** Pure core of {@link useDayEnergy}. */
export function computeDayEnergy(input: Inputs) {
  const { mode, tefEnabled, consumedKcal, targets, exercise, deviceRows, deviceDayComplete = true } = input;
  const device = pickDeviceEnergy(deviceRows);
  const counted = exercise.filter((e) => e.counts_toward_energy);

  // Without device data (or in static mode) every counted entry is used. Device modes with a device row: the device's
  // daily active energy already contains its workouts, so they are NOT added as exercise kcal; they are only told
  // apart from the general movement (tracker activity), and only manual entries that do not overlap a device workout
  // may be added on top.
  let exerciseForEnergy: readonly ExerciseEntry[] = counted;
  let deviceWorkoutKcal = 0;
  let deviceWorkoutMinutes = 0;
  if (mode !== 'static' && device !== undefined) {
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
    // Only the workouts of the source whose daily total is used are inside that total; the same session recorded by a
    // second source (Garmin and Apple Health) must not be counted twice.
    const own = exercise.filter((e) => e.source !== 'manual' && e.source === device.source);
    deviceWorkoutKcal = sumBy(own, (e) => Number(e.kcal) || 0);
    deviceWorkoutMinutes = sumBy(own, exerciseMinutesOf);
  }
  const manualExerciseKcal = sumBy(exerciseForEnergy, (e) => Number(e.kcal) || 0);
  const exerciseMinutes = deviceWorkoutMinutes + sumBy(exerciseForEnergy, exerciseMinutesOf);

  if (!targets) {
    return {
      breakdown: undefined,
      targetKcal: undefined,
      exerciseBurnedKcal: manualExerciseKcal,
      remaining: undefined as EnergyRemaining | undefined,
    };
  }

  const breakdown = computeExpenditure({
    mode,
    bmr: targets.bmr,
    baselineActivityKcal: targets.baselineActivityKcal,
    manualExerciseKcal,
    deviceActiveKcal: device?.active_kcal ?? null,
    deviceWorkoutKcal,
    deviceRestingKcal: device?.resting_kcal ?? null,
    exerciseMinutes,
    deviceDayComplete,
    intakeKcal: consumedKcal,
    tefEnabled,
  });
  return {
    breakdown,
    targetKcal: targets.energy.target,
    exerciseBurnedKcal: breakdown.aboveBaseline,
    remaining: energyRemaining({
      targetKcal: targets.energy.target,
      aboveBaselineKcal: breakdown.aboveBaseline,
      expenditureKcal: breakdown.total,
      consumedKcal,
    }),
  };
}

/** Epoch ms of the end of a local diary day (the next local midnight). */
function localDayEndMs(date: string): number {
  const [y, m, d] = addDays(date, 1).split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).getTime();
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
  const summaryMode = normalizeEnergySummaryMode(profileQ.data?.energy_summary_mode ?? targets?.profile.energy_summary_mode);
  const exercise = exerciseQ.data ?? EMPTY_EXERCISE;
  const deviceRows = deviceQ.data ?? EMPTY_ENERGY_ROWS;
  const consumedKcal = day.kcal;

  const device = pickDeviceEnergy(deviceRows);
  const deviceDayComplete = device
    ? isDeviceDayComplete({
        date,
        today: todayISO(),
        updatedAtMs: toMs(device.updated_at ?? null),
        dayEndMs: localDayEndMs(date),
      })
    : true;

  const computed = useMemo(
    () => computeDayEnergy({ mode, tefEnabled, consumedKcal, targets, exercise, deviceRows, deviceDayComplete }),
    [mode, tefEnabled, consumedKcal, targets, exercise, deviceRows, deviceDayComplete],
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
    summaryMode,
    remainingKcal: computed.remaining?.[summaryMode],
    remainingByMode: computed.remaining,
    exercise,
    deviceEnergy: device,
    deviceEnergyRows: deviceRows as DailyEnergyRow[],
  };
}
