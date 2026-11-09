// Shared types of the device health sync. Pure: imports nothing from react-native / expo.

/** User-local calendar day, YYYY-MM-DD (the key the diary uses). */
export type LocalDate = string;

/** Inclusive range of local dates. */
export interface DateRange {
  from: LocalDate;
  to: LocalDate;
}

/** `integrations.provider` / `*.source` values written by this feature. */
export type HealthProviderId = 'apple_health' | 'health_connect';

/** The user-facing import categories (one checkbox each). */
export const HEALTH_DATA_TYPES = [
  'activity',
  'weight',
  'body_fat',
  'resting_heart_rate',
  'hrv',
  'spo2',
  'respiration_rate',
  'sleep',
  'blood_pressure',
] as const;

export type HealthDataType = (typeof HEALTH_DATA_TYPES)[number];

/** Everything except `activity` (energy + steps + workouts) ends up in `public.biometrics`. */
export type BiometricDataType = Exclude<HealthDataType, 'activity'>;

/** `biometrics.type` values written by the sync (blood pressure becomes two rows). */
export type BiometricRowType =
  | 'weight'
  | 'body_fat'
  | 'resting_heart_rate'
  | 'hrv'
  | 'spo2'
  | 'respiration_rate'
  | 'sleep'
  | 'bp_systolic'
  | 'bp_diastolic';

export type MetaValue = string | number | boolean;

/** One local day of device energy. Values are null when the device has no data for that quantity. */
export interface DailyEnergyPoint {
  date: LocalDate;
  /** Active energy burned, kcal (de-duplicated across sources by the platform). */
  activeKcal: number | null;
  /** Resting / basal energy, kcal. */
  restingKcal: number | null;
  steps: number | null;
}

/** A workout recorded by a device. Informational: its energy is already inside the daily active energy. */
export interface WorkoutPoint {
  /** The workout's UUID / record id (HealthKit uuid, Health Connect metadata.id). */
  externalId: string;
  /** Local date of the start. */
  date: LocalDate;
  startedAt: string; // ISO
  endedAt: string; // ISO
  /** Human readable activity type, e.g. 'Running'. */
  name: string;
  minutes: number;
  kcal: number;
}

/** A biometric sample or per-day aggregate. */
export interface BiometricPoint {
  type: BiometricRowType;
  /** Local date the value belongs to (for sleep: the date of the wake-up). */
  date: LocalDate;
  value: number;
  unit: string;
  /** Unique within (user, source): the sample uuid, or `${type}:${date}` for daily aggregates. */
  externalId: string;
  recordedAt: string; // ISO
  meta?: Record<string, MetaValue>;
}

export type UnavailableReason =
  | 'unsupported_platform' // web
  | 'unsupported_device' // e.g. iPad without HealthKit
  | 'native_module_missing' // Expo Go / build without the module
  | 'not_installed' // Health Connect missing
  | 'update_required' // Health Connect provider needs an update
  | 'unknown';

export interface ProviderAvailability {
  available: boolean;
  reason?: UnavailableReason;
  /** Short explanation for the user. */
  message?: string;
}

export interface PermissionResult {
  /** True when at least one requested type can be read. */
  granted: boolean;
  /** Types that can be read (HealthKit cannot report read denial, so this is optimistic there). */
  grantedTypes: HealthDataType[];
  /** Types known to be missing permission. */
  missingTypes: HealthDataType[];
  /** Background reads allowed (Health Connect READ_HEALTH_DATA_IN_BACKGROUND). */
  backgroundAccess?: boolean;
  /** Extended history requested without error (Health Connect cannot confirm it). */
  extendedHistoryRequested?: boolean;
  note?: string;
}

export interface RequestPermissionOptions {
  /** Ask for access to history beyond the platform default window (Health Connect: 30 days). */
  wantHistory?: boolean;
}

/**
 * A platform data source. Implementations live in provider.ios.ts / provider.android.ts / provider.web.ts and must load
 * their native module lazily so the app still starts in Expo Go and on the web.
 */
export interface HealthProvider {
  readonly id: HealthProviderId;
  readonly label: string;
  /** Days of history readable without the special permission, relative to the first permission grant. */
  readonly historyLimitDays?: number;
  getAvailability(): Promise<ProviderAvailability>;
  isAvailable(): Promise<boolean>;
  /** Which of `types` may be read, WITHOUT showing a prompt. */
  checkPermissions(types: readonly HealthDataType[]): Promise<PermissionResult>;
  /** Shows the platform permission UI for `types`. Must be called from the foreground. */
  requestPermissions(
    types: readonly HealthDataType[],
    options?: RequestPermissionOptions,
  ): Promise<PermissionResult>;
  /** Per-local-day energy and steps, inclusive range. De-duplicated by the platform, never summed from raw samples. */
  readDailyEnergy(range: DateRange): Promise<DailyEnergyPoint[]>;
  readWorkouts(range: DateRange): Promise<WorkoutPoint[]>;
  readBiometrics(type: BiometricDataType, range: DateRange): Promise<BiometricPoint[]>;
  /** Opens the system screen where the user manages this app's access, when there is one. */
  openSystemSettings?(): void;
}

// ---- rows written to Supabase -------------------------------------------------------------------------------------

export interface DailyEnergyRowInput {
  user_id: string;
  local_date: LocalDate;
  source: HealthProviderId;
  active_kcal: number | null;
  resting_kcal: number | null;
  steps: number | null;
}

export interface ExerciseRowInput {
  user_id: string;
  entry_date: LocalDate;
  activity_code: null;
  name: string;
  minutes: number;
  kcal: number;
  source: HealthProviderId;
  external_id: string;
  started_at: string;
  ended_at: string;
  /** Always false for device workouts: they are already inside the daily active energy. */
  counts_toward_energy: false;
}

export interface BiometricRowInput {
  user_id: string;
  entry_date: LocalDate;
  type: BiometricRowType;
  value: number;
  unit: string;
  source: HealthProviderId;
  external_id: string;
  recorded_at: string;
  meta: Record<string, MetaValue>;
}

/** Persistence used by the sync; implemented on top of Supabase in runner.ts and by fakes in tests. */
export interface SyncWriter {
  upsertDailyEnergy(rows: DailyEnergyRowInput[]): Promise<void>;
  upsertExercises(rows: ExerciseRowInput[]): Promise<void>;
  upsertBiometrics(rows: BiometricRowInput[]): Promise<void>;
}

// ---- sync progress / result ---------------------------------------------------------------------------------------

export interface SyncProgress {
  chunkIndex: number; // 1-based
  chunkCount: number;
  range: DateRange;
  type: HealthDataType;
  message: string;
}

export interface SyncIssue {
  scope: HealthDataType | 'general';
  range?: DateRange;
  message: string;
}

export interface SyncCounts {
  energyDays: number;
  workouts: number;
  /** Rows written per biometric row type. */
  biometrics: Partial<Record<BiometricRowType, number>>;
}

export interface SyncResult {
  /** No issues at all. */
  ok: boolean;
  range: DateRange;
  counts: SyncCounts;
  issues: SyncIssue[];
  /** Human summary, e.g. '12 days of energy, 5 workouts, 3 weights'. */
  summary: string;
  /** read+write steps attempted and how many of them worked. */
  steps: { total: number; succeeded: number };
}
