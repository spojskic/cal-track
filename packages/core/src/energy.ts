import type { ActivityLevel, BmrFormula, EnergyMode, Sex } from './types';

/*
 * Energy balance model
 * ====================
 *   total daily expenditure (TDEE) =
 *       BMR                              (resting, from a formula or the device)
 *     + baseline activity                (everyday movement, a fraction of BMR)
 *     + exercise                         (logged workouts, NET of resting energy)
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

/** Inputs for {@link computeExpenditure}. All energy values in kcal/day. */
export interface ExpenditureInput {
  mode: EnergyMode;
  /** Resting energy from our formula. */
  bmr: number;
  /** Baseline activity from our activity level ({@link baselineActivityKcal}). */
  baselineActivityKcal: number;
  /**
   * Sum of manual exercise net kcal. For `device_adjusted` the caller must have
   * already removed entries overlapping device workouts ({@link dedupeExercises}).
   */
  manualExerciseKcal: number;
  /** Active energy measured by a device (Apple Health / Health Connect). */
  deviceActiveKcal?: number | null;
  /** Resting/basal energy measured by a device. */
  deviceRestingKcal?: number | null;
  /** Calories eaten that day (only used for TEF). */
  intakeKcal: number;
  tefEnabled: boolean;
  /** TEF share of intake (default 0.10). */
  tefPct?: number;
}

/**
 * Daily expenditure split into components. Invariant:
 * `total = bmr + baselineActivity + exercise + deviceAboveBaseline + tef`.
 */
export interface EnergyBreakdown {
  mode: EnergyMode;
  bmr: number;
  baselineActivity: number;
  /** Manual (logged) exercise energy that was counted. */
  exercise: number;
  /**
   * `device_adjusted`: device active energy ABOVE our baseline estimate.
   * `device_total`: the full device active energy.
   * 0 otherwise.
   */
  deviceAboveBaseline: number;
  tef: number;
  total: number;
}

const isNum = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/**
 * Assembles daily energy expenditure for one of three modes.
 *
 * Double-counting rules (the reason the modes differ):
 *
 * - `static`: `bmr + baseline + manualExercise (+ tef)`. Nothing from a device
 *   is used.
 * - `device_adjusted`: the device's ACTIVE energy already contains everyday
 *   movement AND workouts, so adding it to our baseline would count movement
 *   twice. We keep our BMR + baseline as the floor and add only the part of the
 *   device's active energy that exceeds the baseline:
 *   `bmr + baseline + max(0, deviceActive - baseline) + manualExercise (+ tef)`.
 *   Manual exercise logged during a device-recorded workout would be counted
 *   by both, so the caller must pass `manualExerciseKcal` computed from
 *   {@link dedupeExercises} output. Without device data it equals `static`.
 * - `device_total`: trust the device completely:
 *   `deviceActive + deviceResting (+ tef)`. Our BMR/baseline and manual exercise
 *   are NOT used (the device already measured them). If the device reports no
 *   resting energy, our BMR is used instead. If it reports no active energy,
 *   we fall back to `baseline + manualExercise`.
 *
 * TEF (when enabled) is `intakeKcal * tefPct` and is added in every mode.
 */
export function computeExpenditure(input: ExpenditureInput): EnergyBreakdown {
  const { mode, bmr, intakeKcal, tefEnabled } = input;
  const tef = tefKcal(intakeKcal, tefEnabled, input.tefPct ?? DEFAULT_TEF_PCT);
  const baseline = input.baselineActivityKcal;
  const manual = Math.max(0, input.manualExerciseKcal);
  const active = isNum(input.deviceActiveKcal) ? Math.max(0, input.deviceActiveKcal) : undefined;

  let parts: Omit<EnergyBreakdown, 'mode' | 'tef' | 'total'>;
  switch (mode) {
    case 'static':
      parts = { bmr, baselineActivity: baseline, exercise: manual, deviceAboveBaseline: 0 };
      break;
    case 'device_adjusted':
      parts = {
        bmr,
        baselineActivity: baseline,
        exercise: manual,
        deviceAboveBaseline: active === undefined ? 0 : Math.max(0, active - baseline),
      };
      break;
    case 'device_total': {
      const resting = isNum(input.deviceRestingKcal) ? Math.max(0, input.deviceRestingKcal) : bmr;
      parts =
        active === undefined
          ? { bmr: resting, baselineActivity: baseline, exercise: manual, deviceAboveBaseline: 0 }
          : { bmr: resting, baselineActivity: 0, exercise: 0, deviceAboveBaseline: active };
      break;
    }
  }
  const total = parts.bmr + parts.baselineActivity + parts.exercise + parts.deviceAboveBaseline + tef;
  return { mode, ...parts, tef, total };
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
