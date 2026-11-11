// Per-user health sync settings, stored in `integrations.settings` (jsonb). Pure.
//
// Raw shape (unknown keys are preserved on write):
//   { activity: true, weight: true, body_fat: true, resting_heart_rate: false, hrv: false, spo2: false,
//     respiration_rate: false, sleep: false, blood_pressure: false,
//     connected_at: ISO, extended_history: boolean, last_summary: string }
import { addDays } from './dates';
import {
  HEALTH_DATA_TYPES,
  type HealthDataType,
  type HealthProviderId,
  type LocalDate,
} from './types';

export type HealthToggles = Record<HealthDataType, boolean>;

export const DEFAULT_TOGGLES: HealthToggles = {
  activity: true,
  weight: true,
  body_fat: true,
  resting_heart_rate: false,
  hrv: false,
  spo2: false,
  respiration_rate: false,
  sleep: false,
  blood_pressure: false,
};

export interface HealthIntegrationSettings {
  toggles: HealthToggles;
  /** When the user first connected (Health Connect: start of its 30-day history window). */
  connectedAt: string | null;
  /** The extended history permission was requested without error (Health Connect cannot confirm the grant). */
  extendedHistory: boolean;
  /** Summary of the last finished sync. */
  lastSummary: string | null;
}

export const DEFAULT_BACKFILL_DAYS = 14;

export const defaultBackfillDate = (today: LocalDate): LocalDate => addDays(today, -DEFAULT_BACKFILL_DAYS);

export const PROVIDER_LABELS: Record<HealthProviderId, string> = {
  apple_health: 'Apple Health',
  health_connect: 'Health Connect',
  garmin: 'Garmin',
};

export const DATA_TYPE_INFO: Record<HealthDataType, { label: string; description: string }> = {
  activity: {
    label: 'Import Activity',
    description: 'Calories burned (active and resting), steps and workouts. Used by the Device energy modes.',
  },
  weight: { label: 'Weight', description: 'Body weight measurements.' },
  body_fat: { label: 'Body Fat %', description: 'Body fat percentage measurements.' },
  resting_heart_rate: { label: 'Heart Rate (resting)', description: 'Resting heart rate, daily average.' },
  hrv: {
    label: 'Heart Rate Variability',
    description: 'Daily average. Apple Health reports SDNN, Health Connect reports RMSSD; the method is stored too.',
  },
  spo2: { label: 'Oxygen Saturation', description: 'Blood oxygen (SpO2), daily average.' },
  respiration_rate: { label: 'Respiration Rate', description: 'Breaths per minute, daily average.' },
  sleep: { label: 'Sleep', description: 'Hours asleep for the night ending that day, with sleep stages when available.' },
  blood_pressure: { label: 'Blood Pressure', description: 'Systolic and diastolic readings.' },
};

export const GARMIN_NOTE =
  'Garmin Connect can also sync into Apple Health / Health Connect, and Ration picks that up. The Garmin card below reads Garmin directly instead; if both are on, the Garmin numbers are used for the day.';

export const WEB_NOTE = 'Health sync runs in the iOS/Android app; your data appears here after syncing.';

export const ENERGY_MODE_NOTE =
  'The Device-adjusted and Device-total energy modes use this data. Choose the mode in Settings > Profile & targets > Energy mode.';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseSettings(raw: unknown): HealthIntegrationSettings {
  const obj = isRecord(raw) ? raw : {};
  const toggles = { ...DEFAULT_TOGGLES };
  for (const type of HEALTH_DATA_TYPES) {
    const value = obj[type];
    if (typeof value === 'boolean') toggles[type] = value;
  }
  return {
    toggles,
    connectedAt: typeof obj.connected_at === 'string' ? obj.connected_at : null,
    extendedHistory: obj.extended_history === true,
    lastSummary: typeof obj.last_summary === 'string' ? obj.last_summary : null,
  };
}

/** Merges `settings` over the raw jsonb so keys this code does not know are kept. */
export function serializeSettings(
  settings: HealthIntegrationSettings,
  base: unknown = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = isRecord(base) ? { ...base } : {};
  for (const type of HEALTH_DATA_TYPES) out[type] = settings.toggles[type];
  if (settings.connectedAt) out.connected_at = settings.connectedAt;
  else delete out.connected_at;
  out.extended_history = settings.extendedHistory;
  if (settings.lastSummary) out.last_summary = settings.lastSummary;
  else delete out.last_summary;
  return out;
}

export const enabledTypes = (toggles: HealthToggles): HealthDataType[] =>
  HEALTH_DATA_TYPES.filter((type) => toggles[type]);

/** Types enabled in `next` but not in `prev` (they need a new permission prompt). */
export const newlyEnabled = (prev: HealthToggles, next: HealthToggles): HealthDataType[] =>
  HEALTH_DATA_TYPES.filter((type) => next[type] && !prev[type]);
