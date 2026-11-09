// The app-facing shapes produced by the mappers. Units follow the app's convention: weight kg, body_fat percent,
// hrv ms, sleep hr. Dates are the user's local calendar day, `YYYY-MM-DD`.

export type GarminMetaValue = string | number | boolean;
export type GarminMeta = Record<string, GarminMetaValue>;

/** One local day of device energy. Fields Garmin did not report are ABSENT (never 0). */
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
  startMs: number;
  endMs: number;
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
  body_battery: 'percent',
  stress: 'score',
};

export interface GarminBiometric {
  /** Local calendar day the value belongs to (for sleep: the day of waking up). */
  date: string;
  type: GarminBiometricType;
  value: number;
  unit: string;
  /** Unique per (type, day) for daily aggregates, per measurement for weight/body fat. Safe for upserts. */
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
  /** Endpoint id (see endpoints.ts), e.g. 'dailySummaries'. */
  endpoint: string;
  /** Canonical field name (as in the normalized output), or '$' for the whole response. */
  field: string;
  reason: GarminDiagnosticReason;
  /** How many items were affected. */
  count: number;
  /** Out of how many items examined (omitted when not applicable). */
  of?: number;
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
}

/** Diagnostics + coverage produced by every mapper. */
export interface GarminMap {
  diagnostics: GarminDiagnostic[];
  coverage: GarminFieldCoverage[];
}

export interface GarminMapResult<T> extends GarminMap {
  items: T[];
}

/** A request failure collected during a sync (the sync continues unless the failure is an auth error). */
export interface GarminSyncError {
  endpoint: string;
  start?: string;
  end?: string;
  kind: string;
  status?: number;
  retryable: boolean;
  /** Friendly, redacted. */
  message: string;
}
