// The app-facing shapes produced by the mappers. Units follow the app's convention: weight kg, body_fat percent,
// hrv ms, sleep hr. Dates are the user's local calendar day, `YYYY-MM-DD`.
//
// These are structurally the same as the rows the app writes for health data (apps/app/src/health/types.ts:
// DailyEnergyPoint, WorkoutPoint, BiometricPoint); the app converts them one to one.

export type GarminMetaValue = string | number | boolean;
export type GarminMeta = Record<string, GarminMetaValue>;

/**
 * One local day of device energy. Fields Garmin did not report are ABSENT (never 0).
 *
 * The day's totals are CUMULATIVE (a Garmin shows 801 resting kcal at midday), so a later pull for the same date
 * REPLACES an earlier one. They are never added together.
 */
export interface GarminDailyEnergy {
  date: string;
  activeKcal?: number;
  restingKcal?: number;
  totalKcal?: number;
  steps?: number;
}

export interface GarminWorkout {
  /** `garmin:activity:<activityId>` (stable across syncs). */
  externalId: string;
  name: string;
  /** Garmin activity type key, e.g. 'running', 'strength_training'. */
  typeKey: string;
  /** Local calendar day of the start (what the diary files the workout under). */
  date: string;
  /** Wall-clock start as Garmin printed it, `YYYY-MM-DD HH:MM:SS` (no time zone). */
  startLocal: string;
  /** Real start instant (epoch ms) when Garmin sent a GMT start, otherwise absent. */
  startMs?: number;
  durationSec: number;
  kcal?: number;
  distanceM?: number;
}

export const GARMIN_BIOMETRIC_TYPES = [
  'weight',
  'body_fat',
  'resting_heart_rate',
  'hrv',
  'spo2',
  'respiration_rate',
  'sleep',
  'sleep_score',
  'body_battery',
  'stress',
] as const;

export type GarminBiometricType = (typeof GARMIN_BIOMETRIC_TYPES)[number];

/** Stored unit per biometric type. */
export const GARMIN_BIOMETRIC_UNITS: Record<GarminBiometricType, string> = {
  weight: 'kg',
  body_fat: 'percent',
  resting_heart_rate: 'bpm',
  hrv: 'ms',
  spo2: 'percent',
  respiration_rate: 'brpm',
  sleep: 'hr',
  sleep_score: 'score',
  body_battery: 'percent',
  stress: 'score',
};

export interface GarminBiometric {
  /** Local calendar day the value belongs to (for sleep: the day of waking up). */
  date: string;
  type: GarminBiometricType;
  value: number;
  unit: string;
  /** Unique per (type, day) for daily aggregates, per weigh-in for weight / body fat. Safe for upserts. */
  externalId: string;
  recordedAtMs?: number;
  meta?: GarminMeta;
}

/** What went wrong (or was worth noting) while mapping a response. Aggregated: `count` items were affected. */
export type GarminDiagnosticReason =
  | 'missing' // no candidate field name was present
  | 'wrong_type' // a candidate was present but not usable as the expected type
  | 'unexpected_shape' // the response/item was not the expected container
  | 'implausible' // value outside the believable range, dropped
  | 'converted' // a unit heuristic was applied (e.g. grams -> kg)
  | 'fallback_used' // a secondary field/endpoint supplied the value
  | 'skipped'; // item dropped (e.g. no date)

export interface GarminDiagnostic {
  /** Endpoint id, e.g. 'userSummary'. */
  endpoint: string;
  /** Canonical field name (as in the normalized output), or '$' for the whole response. */
  field: string;
  reason: GarminDiagnosticReason;
  /** How many items were affected. */
  count: number;
  /** Out of how many items examined (omitted when not applicable). */
  of?: number;
  /** Key NAMES and static text only. May carry numbers for 'implausible' / 'skipped': the report never prints those. */
  detail?: string;
  /** One example date, to make the report concrete. */
  sampleDate?: string;
}

/** Per-field hit statistics: which actual JSON key satisfied each canonical field. */
export interface GarminFieldCoverage {
  endpoint: string;
  field: string;
  /** Items examined. */
  total: number;
  /** Items where a usable value was found. */
  found: number;
  /** Actual JSON key (or dotted path) -> number of items it satisfied. */
  matchedBy: Record<string, number>;
  /** Every JSON key / dotted path that was tried, in order. */
  tried: string[];
}

/** Diagnostics + coverage produced by every mapper. */
export interface GarminMap {
  diagnostics: GarminDiagnostic[];
  coverage: GarminFieldCoverage[];
}

export interface GarminMapResult<T> extends GarminMap {
  items: T[];
}
