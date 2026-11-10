import type { ActivityLevel, BmrFormula, EnergyMode, EnergySummaryMode, Sex } from './types';

/*
 * Energy balance model (the way Cronometer computes "Energy Expenditure")
 * ======================================================================
 *   total daily expenditure (Burned) =
 *       BMR                              (resting, from a formula or the device)
 *     + adjusted baseline activity       (everyday movement, a fraction of BMR; shrinks as the day is measured)
 *     + tracker activity                 (general activity from a device, outside workouts)
 *     + exercise                         (workouts, NET of resting energy)
 *     + thermic effect of food (TEF)     (optional, % of intake)
 *
 * Everything is kcal/day unless stated otherwise. Weights in kg, heights in cm.
 */

// ---------------------------------------------------------------- helpers

function assertPositive(name: string, v: number): void {
  if (!Number.isFinite(v) || v <= 0) throw new RangeError(`${name} must be a positive number`);
}

function assertNonNegative(name: string, v: number): void {
  if (!Number.isFinite(v) || v < 0) throw new RangeError(`${name} must be a non-negative number`);
}

// -------------------------------------------------------------------- BMR

/**
 * Mifflin-St Jeor resting energy expenditure (kcal/day):
 * `10*kg + 6.25*cm - 5*age + (male ? 5 : -161)`.
 *
 * @param kg   body weight in kg
 * @param cm   height in cm
 * @param age  age in whole years
 * @param sex  'male' | 'female'
 */
export function bmrMifflin(kg: number, cm: number, age: number, sex: Sex): number {
  assertPositive('kg', kg);
  assertPositive('cm', cm);
  assertNonNegative('age', age);
  return 10 * kg + 6.25 * cm - 5 * age + (sex === 'male' ? 5 : -161);
}

/**
 * Katch-McArdle resting energy expenditure (kcal/day): `370 + 21.6 * leanMassKg`.
 * Needs lean (fat-free) body mass; see {@link leanMass}.
 */
export function bmrKatchMcArdle(leanMassKg: number): number {
  assertPositive('leanMassKg', leanMassKg);
  return 370 + 21.6 * leanMassKg;
}

/**
 * Revised Harris-Benedict (Roza & Shizgal 1984) resting energy (kcal/day):
 * - male:   `88.362 + 13.397*kg + 4.799*cm - 5.677*age`
 * - female: `447.593 + 9.247*kg + 3.098*cm - 4.330*age`
 */
export function bmrHarrisBenedictRevised(kg: number, cm: number, age: number, sex: Sex): number {
  assertPositive('kg', kg);
  assertPositive('cm', cm);
  assertNonNegative('age', age);
  return sex === 'male'
    ? 88.362 + 13.397 * kg + 4.799 * cm - 5.677 * age
    : 447.593 + 9.247 * kg + 3.098 * cm - 4.33 * age;
}

/**
 * Cunningham resting energy expenditure (kcal/day): `500 + 22 * leanMassKg`.
 * Commonly used for athletes.
 */
export function bmrCunningham(leanMassKg: number): number {
  assertPositive('leanMassKg', leanMassKg);
  return 500 + 22 * leanMassKg;
}

/**
 * Lean (fat-free) mass in kg: `kg * (1 - bodyFatPct / 100)`.
 *
 * @param kg         total body weight in kg
 * @param bodyFatPct body fat percentage, 0 <= pct < 100
 */
export function leanMass(kg: number, bodyFatPct: number): number {
  assertPositive('kg', kg);
  if (!Number.isFinite(bodyFatPct) || bodyFatPct < 0 || bodyFatPct >= 100) {
    throw new RangeError('bodyFatPct must be in [0, 100)');
  }
  return kg * (1 - bodyFatPct / 100);
}

/** Inputs needed by {@link computeBmr}. */
export interface BmrProfile {
  sex: Sex;
  /** Age in whole years. */
  age: number;
  weightKg: number;
  heightCm: number;
  /** Body fat percentage (0-100). Required for katch_mcardle / cunningham. */
  bodyFatPct?: number | null;
  /** User-entered BMR (kcal/day). Used by the 'manual' formula. */
  manualBmr?: number | null;
}

/**
 * The formula {@link computeBmr} will actually use for a request. Falls back to
 * 'mifflin' when `katch_mcardle` / `cunningham` lack body fat or `manual` lacks
 * an override value.
 */
export function resolveBmrFormula(profile: BmrProfile, formula: BmrFormula): BmrFormula {
  const hasBodyFat = typeof profile.bodyFatPct === 'number' && Number.isFinite(profile.bodyFatPct);
  const hasManual =
    typeof profile.manualBmr === 'number' && Number.isFinite(profile.manualBmr) && profile.manualBmr > 0;
  if ((formula === 'katch_mcardle' || formula === 'cunningham') && !hasBodyFat) return 'mifflin';
  if (formula === 'manual' && !hasManual) return 'mifflin';
  return formula;
}

/**
 * Resting energy expenditure (kcal/day) with the chosen formula.
 *
 * - `mifflin`: {@link bmrMifflin}
 * - `harris_benedict`: {@link bmrHarrisBenedictRevised}
 * - `katch_mcardle` / `cunningham`: need `bodyFatPct`, otherwise Mifflin is used
 * - `manual`: returns `profile.manualBmr`; Mifflin if it is not set
 *
 * Use {@link resolveBmrFormula} to learn which formula was effectively used.
 */
export function computeBmr(profile: BmrProfile, formula: BmrFormula): number {
  const effective = resolveBmrFormula(profile, formula);
  switch (effective) {
    case 'manual':
      return profile.manualBmr as number;
    case 'katch_mcardle':
      return bmrKatchMcArdle(leanMass(profile.weightKg, profile.bodyFatPct as number));
    case 'cunningham':
      return bmrCunningham(leanMass(profile.weightKg, profile.bodyFatPct as number));
    case 'harris_benedict':
      return bmrHarrisBenedictRevised(profile.weightKg, profile.heightCm, profile.age, profile.sex);
    case 'mifflin':
      return bmrMifflin(profile.weightKg, profile.heightCm, profile.age, profile.sex);
  }
}

// ---------------------------------------------------------- baseline activity

/**
 * Baseline (non-exercise) activity as an additive fraction of BMR. These are
 * the classic activity multipliers minus 1.0 (1.2 / 1.375 / 1.55 / 1.725), i.e.
 * only the activity part, so BMR is not counted twice.
 */
export const ACTIVITY_FRACTIONS: Readonly<Record<ActivityLevel, number>> = {
  none: 0,
  sedentary: 0.2,
  light: 0.375,
  moderate: 0.55,
  very: 0.725,
};

/**
 * Baseline daily activity energy: `bmr * ACTIVITY_FRACTIONS[level]` (kcal/day).
 * Does NOT include logged exercise.
 */
export function baselineActivityKcal(bmr: number, level: ActivityLevel): number {
  return bmr * ACTIVITY_FRACTIONS[level];
}

// ----------------------------------------------------------------- exercise

/**
 * NET exercise energy using MET values:
 * `(met - 1) * kg * minutes / 60` (kcal).
 *
 * "Net" because one MET (resting) is already counted in BMR, so only the part
 * above rest is added. Negative values (met < 1) are clamped to 0.
 */
export function exerciseKcalNetMet(met: number, kg: number, minutes: number): number {
  assertPositive('kg', kg);
  assertNonNegative('minutes', minutes);
  return Math.max(0, met - 1) * kg * (minutes / 60);
}

/**
 * GROSS exercise energy using MET values: `met * kg * minutes / 60` (kcal).
 * Includes the resting energy burned during the activity; do not add it to a
 * total that already contains BMR for the same minutes.
 */
export function exerciseKcalGrossMet(met: number, kg: number, minutes: number): number {
  assertPositive('kg', kg);
  assertNonNegative('minutes', minutes);
  return Math.max(0, met) * kg * (minutes / 60);
}

/** Default thermic effect of food (share of intake energy). */
export const DEFAULT_TEF_PCT = 0.1;

/**
 * Thermic effect of food: `intakeKcal * pct` when enabled, else 0.
 *
 * @param pct fraction of intake (default 0.10)
 */
export function tefKcal(intakeKcal: number, enabled: boolean, pct: number = DEFAULT_TEF_PCT): number {
  if (!enabled) return 0;
  return Math.max(0, intakeKcal) * pct;
}

// ------------------------------------------------------ expenditure modes

/**
 * Waking hours over which the baseline activity is spread (Cronometer: 16). Every hour of exercise "uses up" one
 * sixteenth of the baseline: the baseline is what you do in the rest of the day, not during the workout.
 */
export const AWAKE_HOURS = 16;

/** Inputs for {@link computeExpenditure}. All energy values in kcal/day. */
export interface ExpenditureInput {
  mode: EnergyMode;
  /** Resting energy from our formula. */
  bmr: number;
  /** Baseline activity from our activity level ({@link baselineActivityKcal}). */
  baselineActivityKcal: number;
  /**
   * Sum of manual exercise kcal. When a device is in use the caller must have already removed entries overlapping
   * device workouts ({@link dedupeExercises}), otherwise the same workout would be counted twice.
   */
  manualExerciseKcal: number;
  /**
   * Active energy measured by a device (Apple Health / Health Connect / Garmin): the day-so-far running total. It
   * INCLUDES the device's workouts.
   */
  deviceActiveKcal?: number | null;
  /**
   * Sum of the kcal of the device-recorded workouts of the day (already inside `deviceActiveKcal`). Only read together
   * with `deviceActiveKcal`; it is what separates "tracker activity" (general movement) from "exercise".
   */
  deviceWorkoutKcal?: number | null;
  /** Resting/basal energy measured by a device. */
  deviceRestingKcal?: number | null;
  /**
   * Minutes of exercise of the day: device workouts plus manual entries, de-duplicated by the caller with
   * {@link dedupeExercises}. An entry without a duration counts as 0. Each hour removes `baseline / AWAKE_HOURS` from the
   * baseline.
   */
  exerciseMinutes?: number | null;
  /** Calories eaten that day (only used for TEF). */
  intakeKcal: number;
  tefEnabled: boolean;
  /** TEF share of intake (default 0.10). */
  tefPct?: number;
  /**
   * Is the device's row a FINISHED day (see {@link isDeviceDayComplete})? Default true. Devices report both active and
   * resting energy as day-so-far counters (a Garmin shows 801 resting kcal at midday), so for the day that is still
   * running, `deviceRestingKcal` is only the part already burned and must not stand in for a whole day's BMR.
   * Only `device_total` reads the resting figure; see {@link computeExpenditure}.
   */
  deviceDayComplete?: boolean;
}

/**
 * Daily expenditure split into components (Cronometer's "Energy Expenditure"). Invariant, in every mode:
 * `total = bmr + adjustedBaseline + trackerActivity + exercise + tef`.
 */
export interface EnergyBreakdown {
  mode: EnergyMode;
  /** Resting energy that was used (our formula; the device's own figure in `device_total`). */
  bmr: number;
  /** The baseline activity as configured (a fraction of BMR), before anything replaced part of it. */
  baselineKcal: number;
  /**
   * What is left of the baseline: `baseline - trackerActivity - baseline / AWAKE_HOURS * exerciseHours`, never below 0.
   * It also covers the time the watch was not worn. 0 once tracker activity and exercise replaced all of it.
   */
  adjustedBaseline: number;
  /** General activity imported from a device OUTSIDE its workouts. 0 without a device. */
  trackerActivity: number;
  /** Exercise counted: device workouts plus manual (de-duplicated) entries; manual only without a device. */
  exercise: number;
  tef: number;
  total: number;
  /**
   * Energy burned above the planned maintenance (`bmr + baseline`), TEF excluded and never negative:
   * `adjustedBaseline + trackerActivity + exercise - baseline` (plus the difference between the device's resting energy
   * and our BMR in `device_total`). It is what widens the day's budget in the Target view.
   */
  aboveBaseline: number;
  /** @deprecated Same as {@link adjustedBaseline}. */
  baselineActivity: number;
  /** @deprecated Same as {@link trackerActivity} (the device's general activity). */
  deviceAboveBaseline: number;
}

const isNum = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v);

const nonNeg = (v: number | null | undefined): number => (isNum(v) ? Math.max(0, v) : 0);

/**
 * The part of the baseline that is left after tracker activity and exercise TIME replaced some of it:
 * `max(0, baseline - trackerActivity - baseline / AWAKE_HOURS * exerciseMinutes / 60)`.
 *
 * Cronometer's example: baseline 279 kcal, one hour of exercise -> `279 - 279 / 16 = 261.5625`.
 * Not rounded: round only for display.
 */
export function adjustedBaselineKcal(baselineKcal: number, trackerActivityKcal: number, exerciseMinutes: number): number {
  const baseline = nonNeg(baselineKcal);
  const lostToExerciseTime = (baseline / AWAKE_HOURS) * (nonNeg(exerciseMinutes) / 60);
  return Math.max(0, baseline - nonNeg(trackerActivityKcal) - lostToExerciseTime);
}

/**
 * Assembles daily energy expenditure the way Cronometer does, for one of three modes.
 *
 * `total = bmr + adjustedBaseline + trackerActivity + exercise + tef`
 *
 * - `static` and `device_adjusted` share one model. The baseline activity is the budget for the part of the day the
 *   user is not exercising and is not measured: at 0 a.m. Burned is `bmr + baseline`, so meals can be planned before
 *   anything was recorded. Then
 *   - `trackerActivity = max(0, deviceActive - deviceWorkoutKcal)`: movement outside workouts. It REPLACES the baseline
 *     one-for-one, so a small amount does not change the total.
 *   - `exercise = deviceWorkoutKcal + manualExerciseKcal`
 *   - `adjustedBaseline = max(0, baseline - trackerActivity - baseline / AWAKE_HOURS * exerciseMinutes / 60)`
 *   - `aboveBaseline = max(0, adjustedBaseline + trackerActivity + exercise - baseline)`
 *
 *   `static` never reads device numbers (tracker 0, exercise = manual only). `device_adjusted` without a device active
 *   figure is the same as `static`: workouts are only counted when the day's active energy is known too (the caller
 *   stores device workouts as informational, "their energy is inside the daily active energy").
 *   Manual exercise logged during a device-recorded workout would be counted by both, so the caller must pass
 *   `manualExerciseKcal` and `exerciseMinutes` computed from {@link dedupeExercises} output.
 * - `device_total`: trust the device completely: `deviceActive + deviceResting (+ tef)`. Our BMR/baseline and manual
 *   exercise are NOT used (the device already measured them). If the device reports no resting energy, our BMR is used
 *   instead. If it reports no active energy, we fall back to `baseline + manualExercise`.
 *   While the device's day is not finished (`deviceDayComplete === false`) its resting energy is a day-so-far counter,
 *   i.e. a LOWER BOUND of the day's resting energy, so the resting part is `max(our BMR, device resting so far)`. The
 *   active energy is split into `exercise = min(deviceWorkoutKcal, active)` and `trackerActivity = active - exercise`
 *   for display only, the total is unchanged.
 *   `aboveBaseline` there is whatever the device measured beyond our `bmr + baseline` (never negative).
 *
 * `device_adjusted` reads only the device's ACTIVE energy, never its resting or total energy, so a partial day can only
 * under-count, never double count: while the watch has recorded little, the total stays at `bmr + baseline` minus the
 * baseline hours spent exercising, plus the exercise itself.
 *
 * TEF (when enabled) is `intakeKcal * tefPct` and is added in every mode. Nothing is rounded here.
 */
export function computeExpenditure(input: ExpenditureInput): EnergyBreakdown {
  const { mode, bmr, intakeKcal, tefEnabled } = input;
  const tef = tefKcal(intakeKcal, tefEnabled, input.tefPct ?? DEFAULT_TEF_PCT);
  const baseline = nonNeg(input.baselineActivityKcal);
  const manual = nonNeg(input.manualExerciseKcal);
  const minutes = nonNeg(input.exerciseMinutes);
  const workoutKcal = nonNeg(input.deviceWorkoutKcal);
  const active = isNum(input.deviceActiveKcal) ? Math.max(0, input.deviceActiveKcal) : undefined;

  let resting = bmr;
  let adjustedBaseline: number;
  let trackerActivity = 0;
  let exercise: number;
  switch (mode) {
    case 'static':
      exercise = manual;
      adjustedBaseline = adjustedBaselineKcal(baseline, 0, minutes);
      break;
    case 'device_adjusted':
      if (active === undefined) {
        exercise = manual;
        adjustedBaseline = adjustedBaselineKcal(baseline, 0, minutes);
      } else {
        trackerActivity = Math.max(0, active - workoutKcal);
        exercise = workoutKcal + manual;
        adjustedBaseline = adjustedBaselineKcal(baseline, trackerActivity, minutes);
      }
      break;
    case 'device_total': {
      const deviceResting = isNum(input.deviceRestingKcal) ? Math.max(0, input.deviceRestingKcal) : undefined;
      resting =
        deviceResting === undefined ? bmr : input.deviceDayComplete === false ? Math.max(bmr, deviceResting) : deviceResting;
      if (active === undefined) {
        adjustedBaseline = baseline;
        exercise = manual;
      } else {
        adjustedBaseline = 0;
        exercise = Math.min(workoutKcal, active);
        trackerActivity = active - exercise;
      }
      break;
    }
  }
  const total = resting + adjustedBaseline + trackerActivity + exercise + tef;
  const aboveBaseline = Math.max(0, resting + adjustedBaseline + trackerActivity + exercise - (bmr + baseline));
  return {
    mode,
    bmr: resting,
    baselineKcal: baseline,
    adjustedBaseline,
    trackerActivity,
    exercise,
    tef,
    total,
    aboveBaseline,
    baselineActivity: adjustedBaseline,
    deviceAboveBaseline: trackerActivity,
  };
}

// ------------------------------------------------------- summary (third circle)

/** Default of the third circle. */
export const DEFAULT_ENERGY_SUMMARY_MODE: EnergySummaryMode = 'target';

/** Anything stored as the summary mode (or missing in an old cached profile) as a valid mode. */
export function normalizeEnergySummaryMode(value: unknown): EnergySummaryMode {
  return value === 'balance' ? 'balance' : DEFAULT_ENERGY_SUMMARY_MODE;
}

/** The other view: Target <-> Balance. */
export function nextEnergySummaryMode(mode: EnergySummaryMode): EnergySummaryMode {
  return mode === 'balance' ? 'target' : 'balance';
}

/** Remaining energy for both display modes of the third circle; positive = still available / burned more than eaten. */
export interface EnergyRemaining {
  /** `(target + aboveBaseline) - consumed`: what is left of the day's budget; negative = over. */
  target: number;
  /** `expenditure - consumed` (expenditure incl. TEF), whatever the weight goal: positive = deficit, negative = surplus. */
  balance: number;
}

/**
 * Both values of the energy summary's third circle (Cronometer's "Target" and "Balance"):
 * - Target: `targetKcal + aboveBaselineKcal - consumedKcal`. The target is the goal-adjusted maintenance (or the custom
 *   target); it only grows when more than the baseline was burned.
 * - Balance: `expenditureKcal - consumedKcal`, a plain deficit / surplus view that ignores the weight goal.
 */
export function energyRemaining(input: {
  targetKcal: number;
  aboveBaselineKcal: number;
  expenditureKcal: number;
  consumedKcal: number;
}): EnergyRemaining {
  return {
    target: input.targetKcal + nonNeg(input.aboveBaselineKcal) - input.consumedKcal,
    balance: input.expenditureKcal - input.consumedKcal,
  };
}

/** Caption under the third circle: 'Remaining' / 'Over' (Target) or 'Deficit' / 'Surplus' (Balance). */
export function energySummaryCaption(mode: EnergySummaryMode, value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return mode === 'balance' ? 'Balance' : 'Remaining';
  if (mode === 'balance') return value < 0 ? 'Surplus' : 'Deficit';
  return value < 0 ? 'Over' : 'Remaining';
}

/**
 * Is the device's daily energy row for local `date` a finished day, i.e. safe to treat its resting energy as a whole day?
 *
 * Not while the day is still running (`date >= today`), and not when the row was last written BEFORE the day ended (the
 * watch has not synced since; `updatedAtMs < dayEndMs`), because Garmin / Apple Health / Health Connect all report these
 * figures as running totals. Without timestamps the row is judged by the date alone.
 *
 * @param date        local diary day of the row, `YYYY-MM-DD`
 * @param today       local today, `YYYY-MM-DD`
 * @param updatedAtMs when the row was last written (`daily_energy.updated_at`), epoch ms
 * @param dayEndMs    epoch ms of the end of `date` in the user's local time zone (the following local midnight)
 */
export function isDeviceDayComplete(input: {
  date: string;
  today: string;
  updatedAtMs?: number | null;
  dayEndMs?: number | null;
}): boolean {
  if (input.date >= input.today) return false;
  const { updatedAtMs, dayEndMs } = input;
  if (typeof updatedAtMs !== 'number' || !Number.isFinite(updatedAtMs)) return true;
  if (typeof dayEndMs !== 'number' || !Number.isFinite(dayEndMs)) return true;
  return updatedAtMs >= dayEndMs;
}

/** A time range in epoch milliseconds. `endMs` is exclusive. */
export interface TimeRangeMs {
  startMs: number;
  endMs: number;
}

/** A device-recorded workout. */
export type DeviceWorkout = TimeRangeMs;

function overlaps(startMs: number, endMs: number, w: TimeRangeMs): boolean {
  if (startMs === endMs) return startMs >= w.startMs && startMs < w.endMs; // instant inside workout
  return startMs < w.endMs && w.startMs < endMs;
}

/**
 * Removes manual exercise entries whose time range overlaps any device
 * workout (the device already measured that activity). Entries without any
 * time information are kept. An entry with only one of `startMs`/`endMs` is
 * treated as an instant. Touching ranges (one ends exactly when the other
 * starts) do not overlap.
 *
 * Generic over the entry type so callers keep their own fields.
 */
export function dedupeExercises<T extends { startMs?: number; endMs?: number }>(
  manual: readonly T[],
  deviceWorkouts: readonly DeviceWorkout[],
): T[] {
  return manual.filter((entry) => {
    const start = entry.startMs ?? entry.endMs;
    const end = entry.endMs ?? entry.startMs;
    if (start === undefined || end === undefined) return true;
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    return !deviceWorkouts.some((w) => overlaps(lo, hi, w));
  });
}

// -------------------------------------------------------------- weight goal

/** Approximate energy content of 1 kg of body weight change (kcal). */
export const KCAL_PER_KG_BODY_WEIGHT = 7700;

/**
 * Daily energy delta for a weight-change rate: `rateKgPerWeek * 7700 / 7`
 * (kcal/day, signed). Negative rate (loss) gives a negative delta (deficit).
 * Example: -0.5 kg/week -> -550 kcal/day.
 */
export function dailyDeltaFromRate(rateKgPerWeek: number): number {
  return (rateKgPerWeek * KCAL_PER_KG_BODY_WEIGHT) / 7;
}

/**
 * Maximum recommended weight-LOSS rate: 1% of body weight per week
 * (returned as a positive kg/week magnitude).
 */
export function maxSafeLossRateKgPerWeek(kg: number): number {
  assertPositive('kg', kg);
  return kg * 0.01;
}

/** Minimum calorie target by sex (kcal/day): 1500 male, 1200 female. */
export function energyFloor(sex: Sex): number {
  return sex === 'male' ? 1500 : 1200;
}

/** Inputs for {@link computeEnergyTarget}. */
export interface EnergyTargetInput {
  bmr: number;
  baselineActivityKcal: number;
  /** Signed goal rate in kg/week (negative = lose, positive = gain). */
  rateKgPerWeek: number;
  sex: Sex;
  /** Overrides the default sex-based floor. */
  floorKcal?: number;
}

/** Result of {@link computeEnergyTarget}. */
export interface EnergyTarget {
  /** Daily calorie target after applying the floor. */
  target: number;
  /** `bmr + baselineActivity` - maintenance WITHOUT exercise or TEF. */
  maintenance: number;
  /** Signed daily delta from the goal rate. */
  delta: number;
  floor: number;
  /** How many kcal the floor raised the target (0 if the floor did not apply). */
  flooredBy: number;
  /** True when the final target is below BMR. */
  belowBmr: boolean;
}

/**
 * Daily calorie target for a weight goal:
 * `target = max(maintenance + delta, floor)` where
 * `maintenance = bmr + baselineActivity` and `delta = rate * 7700 / 7`.
 *
 * The target deliberately excludes TEF (it would depend on intake, which
 * depends on the target) and exercise (that is shown as extra budget).
 */
export function computeEnergyTarget(input: EnergyTargetInput): EnergyTarget {
  const maintenance = input.bmr + input.baselineActivityKcal;
  const delta = dailyDeltaFromRate(input.rateKgPerWeek);
  const floor = input.floorKcal ?? energyFloor(input.sex);
  const raw = maintenance + delta;
  const target = Math.max(raw, floor);
  return {
    target,
    maintenance,
    delta,
    floor,
    flooredBy: target > raw ? target - raw : 0,
    belowBmr: target < input.bmr,
  };
}

// ------------------------------------------------------------------- dates

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

function parseIsoDate(label: string, iso: string): { y: number; m: number; d: number } {
  const match = ISO_DATE.exec(iso);
  if (!match) throw new RangeError(`${label} must start with YYYY-MM-DD`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) throw new RangeError(`${label} is not a valid date`);
  return { y, m, d };
}

/**
 * Completed years between a birthdate and a reference date (both `YYYY-MM-DD`,
 * any time part is ignored). Pure calendar arithmetic, no time zones.
 * A 29 February birthday counts as passed on 1 March in non-leap years.
 */
export function ageFromBirthdate(birthdateISO: string, onDateISO: string): number {
  const b = parseIsoDate('birthdateISO', birthdateISO);
  const o = parseIsoDate('onDateISO', onDateISO);
  let age = o.y - b.y;
  if (o.m < b.m || (o.m === b.m && o.d < b.d)) age -= 1;
  return Math.max(0, age);
}
