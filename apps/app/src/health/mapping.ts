// Small pure mapping helpers shared by the providers and the sync. Imports nothing from react-native / expo.
import { toLocalDate } from './dates';
import type { BiometricPoint, BiometricRowType, LocalDate, MetaValue, SyncCounts } from './types';

export const round = (value: number, digits = 0): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

export const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ---- workout names ------------------------------------------------------------------------------------------------

const WORKOUT_NAME_OVERRIDES: Record<string, string> = {
  highIntensityIntervalTraining: 'HIIT',
  HIGH_INTENSITY_INTERVAL_TRAINING: 'HIIT',
  traditionalStrengthTraining: 'Strength training',
  functionalStrengthTraining: 'Functional strength training',
  STRENGTH_TRAINING: 'Strength training',
  WEIGHTLIFTING: 'Weightlifting',
  mixedCardio: 'Mixed cardio',
  mixedMetabolicCardioTraining: 'Mixed cardio',
  other: 'Workout',
  OTHER_WORKOUT: 'Workout',
  BIKING: 'Cycling',
  BIKING_STATIONARY: 'Cycling (stationary)',
  cycling: 'Cycling',
  RUNNING_TREADMILL: 'Running (treadmill)',
  SWIMMING_POOL: 'Swimming (pool)',
  SWIMMING_OPEN_WATER: 'Swimming (open water)',
  swimming: 'Swimming',
  FOOTBALL_AMERICAN: 'American football',
  FOOTBALL_AUSTRALIAN: 'Australian football',
  SOCCER: 'Soccer',
  EXERCISE_CLASS: 'Exercise class',
  BOOT_CAMP: 'Boot camp',
  walking: 'Walking',
  WALKING: 'Walking',
};

/**
 * 'traditionalStrengthTraining' | 'ROCK_CLIMBING' -> 'Traditional strength training' | 'Rock climbing'.
 * Use with the enum KEY of HealthKit's WorkoutActivityType or the KEY of Health Connect's ExerciseType.
 */
export function humanizeWorkoutKey(key: string | undefined | null, fallback = 'Workout'): string {
  if (!key) return fallback;
  const override = WORKOUT_NAME_OVERRIDES[key];
  if (override) return override;
  const words = key.includes('_')
    ? key.toLowerCase().split('_')
    : key
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(' ');
  const text = words.filter(Boolean).join(' ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : fallback;
}

/** Reverse lookup of a `{ NAME: number }` constant object (Health Connect's ExerciseType). */
export function keyOfValue(constants: Record<string, number>, value: number): string | undefined {
  for (const [key, v] of Object.entries(constants)) if (v === value) return key;
  return undefined;
}

// ---- units --------------------------------------------------------------------------------------------------------

/**
 * HealthKit's percent unit is a fraction (0.18 = 18 %). Health Connect already reports 0-100. A reading of 1 % or less
 * is physically implausible for body fat and SpO2, so values <= 1 are treated as fractions. Result is 0-100.
 */
export function toPercent(value: number): number {
  return value <= 1 ? value * 100 : value;
}

// ---- Health Connect energy ----------------------------------------------------------------------------------------

/** An aggregate result with no contributing app means "no data", not zero. */
export function aggregateOrNull(total: number | undefined, dataOrigins: readonly string[] | undefined): number | null {
  if (!isFiniteNumber(total)) return null;
  if (total === 0 && (!dataOrigins || dataOrigins.length === 0)) return null;
  return total;
}

/**
 * Resting kcal for a Health Connect day. Preferred: total - active (both from the platform's de-duplicated aggregates).
 * Without a usable total (missing, or smaller than active, i.e. from different apps), fall back to the basal-metabolic
 * -rate aggregate. Never invents a number.
 */
export function deriveHealthConnectResting(input: {
  active: number | null;
  total: number | null;
  basal: number | null;
}): number | null {
  const { active, total, basal } = input;
  if (total !== null && active !== null && total >= active) return Math.max(0, total - active);
  return basal !== null ? Math.max(0, basal) : null;
}

// ---- aggregation --------------------------------------------------------------------------------------------------

export interface TimedValue {
  date: LocalDate;
  value: number;
  atMs: number;
}

export interface DailyAverage {
  date: LocalDate;
  value: number;
  count: number;
  /** Timestamp of the latest contributing sample. */
  lastAtMs: number;
}

/** Mean of the samples of every local day, oldest day first. */
export function dailyAverages(points: readonly TimedValue[]): DailyAverage[] {
  const byDay = new Map<LocalDate, { sum: number; count: number; last: number }>();
  for (const p of points) {
    if (!isFiniteNumber(p.value)) continue;
    const entry = byDay.get(p.date) ?? { sum: 0, count: 0, last: 0 };
    entry.sum += p.value;
    entry.count += 1;
    entry.last = Math.max(entry.last, p.atMs);
    byDay.set(p.date, entry);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, e]) => ({ date, value: e.sum / e.count, count: e.count, lastAtMs: e.last }));
}

/** Local noon of a day as ISO, used as recorded_at of a daily aggregate that has no better timestamp. */
export function noonIso(date: LocalDate): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12, 0, 0, 0).toISOString();
}

export function isoOfMs(ms: number): string {
  return new Date(ms).toISOString();
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order of results. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

// ---- summary ------------------------------------------------------------------------------------------------------

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** '12 days of energy, 5 workouts, 3 weights' */
export function summarizeCounts(counts: SyncCounts): string {
  const b = counts.biometrics;
  const parts: string[] = [];
  if (counts.energyDays) parts.push(`${plural(counts.energyDays, 'day', 'days')} of energy`);
  if (counts.workouts) parts.push(plural(counts.workouts, 'workout', 'workouts'));
  if (b.weight) parts.push(plural(b.weight, 'weight', 'weights'));
  if (b.body_fat) parts.push(plural(b.body_fat, 'body fat reading', 'body fat readings'));
  if (b.resting_heart_rate) parts.push(plural(b.resting_heart_rate, 'resting heart rate', 'resting heart rates'));
  if (b.hrv) parts.push(plural(b.hrv, 'HRV reading', 'HRV readings'));
  if (b.spo2) parts.push(plural(b.spo2, 'oxygen reading', 'oxygen readings'));
  if (b.respiration_rate) parts.push(plural(b.respiration_rate, 'respiration reading', 'respiration readings'));
  if (b.sleep) parts.push(plural(b.sleep, 'night of sleep', 'nights of sleep'));
  const bp = Math.max(b.bp_systolic ?? 0, b.bp_diastolic ?? 0);
  if (bp) parts.push(plural(bp, 'blood pressure reading', 'blood pressure readings'));
  return parts.length > 0 ? parts.join(', ') : 'No new data';
}

export const dateOfMs = (ms: number): LocalDate => toLocalDate(new Date(ms));

/** Biometric point for a per-day average (resting HR, HRV, SpO2, respiration): one row per type and day. */
export function dailyAveragePoint(
  type: BiometricRowType,
  unit: string,
  average: { date: LocalDate; value: number; lastAtMs: number; count?: number },
  meta: Record<string, MetaValue> = {},
  digits = 1,
): BiometricPoint {
  const base: Record<string, MetaValue> = { aggregate: 'daily_average' };
  if (average.count !== undefined) base.samples = average.count;
  return {
    type,
    date: average.date,
    value: round(average.value, digits),
    unit,
    externalId: `${type}:${average.date}`,
    recordedAt: average.lastAtMs > 0 ? isoOfMs(average.lastAtMs) : noonIso(average.date),
    meta: { ...base, ...meta },
  };
}
