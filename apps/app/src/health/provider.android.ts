// Health Connect provider. Android only.
//
// - The native module is loaded lazily so the app still starts in Expo Go / on a build without it.
// - Energy and steps use Health Connect's aggregateRecord per local day. Health Connect de-duplicates overlapping apps
//   (Garmin Connect, Samsung Health, Google Fit, ...) with the user's data-source priority, so raw records are never
//   summed here. An aggregate with no contributing app means "no data", not zero.
// - Active kcal = ActiveCaloriesBurned. Resting kcal = TotalCaloriesBurned - ActiveCaloriesBurned when both exist,
//   otherwise the BasalMetabolicRate aggregate.
// - Without the READ_HEALTH_DATA_HISTORY permission, Health Connect only returns data from 30 days before the app was
//   first granted access (see plan.ts for how the range is clamped).
//
// TODO(write-back): once nutrition is written to Health Connect, exclude records whose dataOrigin is this app's package
// (com.spojskic.caltrack, and the earlier com.caltrack.app) from every read below.
import { Linking } from 'react-native';

import { addDays, eachDay, localDateAt, rangeBounds, toLocalDate } from './dates';
import {
  aggregateOrNull,
  dailyAveragePoint,
  dailyAverages,
  deriveHealthConnectResting,
  humanizeWorkoutKey,
  keyOfValue,
  mapWithConcurrency,
  round,
  type TimedValue,
} from './mapping';
import { nightToBiometricPoint, summarizeNights, type SleepSegment, type SleepStage } from './sleep';
import { PROVIDER_LABELS } from './settings';
import type {
  BiometricDataType,
  BiometricPoint,
  DailyEnergyPoint,
  DateRange,
  HealthDataType,
  HealthProvider,
  PermissionResult,
  ProviderAvailability,
  RequestPermissionOptions,
  WorkoutPoint,
} from './types';

import type { RecordResult, RecordType } from 'react-native-health-connect';

type HC = typeof import('react-native-health-connect');

const OWN_PACKAGES: ReadonlySet<string> = new Set(['com.spojskic.caltrack', 'com.caltrack.app']);
const HISTORY_LIMIT_DAYS = 30;
const PAGE_SIZE = 500;
const DAY_CONCURRENCY = 3;

function loadHealthConnect(): HC {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('react-native-health-connect') as HC;
}

/** Record types per user-facing data type. `required` ones decide whether the type counts as granted. */
const RECORDS: Record<HealthDataType, { required: RecordType[]; optional: RecordType[] }> = {
  activity: {
    required: ['ActiveCaloriesBurned'],
    optional: ['TotalCaloriesBurned', 'BasalMetabolicRate', 'Steps', 'ExerciseSession'],
  },
  weight: { required: ['Weight'], optional: [] },
  body_fat: { required: ['BodyFat'], optional: [] },
  resting_heart_rate: { required: ['RestingHeartRate'], optional: [] },
  hrv: { required: ['HeartRateVariabilityRmssd'], optional: [] },
  spo2: { required: ['OxygenSaturation'], optional: [] },
  respiration_rate: { required: ['RespiratoryRate'], optional: [] },
  sleep: { required: ['SleepSession'], optional: [] },
  blood_pressure: { required: ['BloodPressure'], optional: [] },
};

let initialized = false;

async function ensureInitialized(hc: HC): Promise<void> {
  if (initialized) return;
  // Also needed in a headless background run: the client is created per React context.
  const ok = await hc.initialize();
  if (!ok) throw new Error('Health Connect could not be initialised.');
  initialized = true;
}

async function grantedRecordTypes(hc: HC): Promise<Set<string>> {
  await ensureInitialized(hc);
  const granted = await hc.getGrantedPermissions();
  return new Set(granted.filter((p) => p.accessType === 'read').map((p) => p.recordType));
}

function dayFilter(date: string) {
  const { start, endExclusive } = rangeBounds({ from: date, to: date });
  return { operator: 'between' as const, startTime: start.toISOString(), endTime: endExclusive.toISOString() };
}

function rangeFilter(range: DateRange) {
  const { start, endExclusive } = rangeBounds(range);
  return { operator: 'between' as const, startTime: start.toISOString(), endTime: endExclusive.toISOString() };
}

/** Reads every page of a record type for a time filter. */
async function readAll<T extends RecordType>(
  hc: HC,
  recordType: T,
  timeRangeFilter: ReturnType<typeof rangeFilter>,
): Promise<RecordResult<T>[]> {
  const out: RecordResult<T>[] = [];
  let pageToken: string | undefined;
  do {
    const page = await hc.readRecords(recordType, {
      timeRangeFilter,
      pageSize: PAGE_SIZE,
      ...(pageToken ? { pageToken } : {}),
    });
    out.push(...page.records);
    pageToken = page.pageToken || undefined;
  } while (pageToken);
  return out;
}

const idOf = (metadata: { id?: string } | undefined, fallback: string) => metadata?.id || fallback;
const originOf = (metadata: { dataOrigin?: string } | undefined) => metadata?.dataOrigin ?? 'unknown';

async function aggregateEnergyKcal(
  hc: HC,
  recordType: 'ActiveCaloriesBurned' | 'TotalCaloriesBurned' | 'BasalMetabolicRate',
  timeRangeFilter: ReturnType<typeof rangeFilter>,
  dataOriginFilter?: string[],
): Promise<number | null> {
  // Omit the key instead of passing undefined: the native side reads a missing key as "all apps".
  const origin = dataOriginFilter && dataOriginFilter.length > 0 ? { dataOriginFilter } : {};
  if (recordType === 'ActiveCaloriesBurned') {
    const r = await hc.aggregateRecord({ recordType, timeRangeFilter, ...origin });
    return aggregateOrNull(r.ACTIVE_CALORIES_TOTAL?.inKilocalories, r.dataOrigins);
  }
  if (recordType === 'TotalCaloriesBurned') {
    const r = await hc.aggregateRecord({ recordType, timeRangeFilter, ...origin });
    return aggregateOrNull(r.ENERGY_TOTAL?.inKilocalories, r.dataOrigins);
  }
  const r = await hc.aggregateRecord({ recordType, timeRangeFilter, ...origin });
  return aggregateOrNull(r.BASAL_CALORIES_TOTAL?.inKilocalories, r.dataOrigins);
}

function sleepStageOf(hc: HC, stage: number): SleepStage | null {
  const s = hc.SleepStageType;
  switch (stage) {
    case s.AWAKE:
    case s.OUT_OF_BED:
      return 'awake';
    case s.LIGHT:
      return 'core';
    case s.DEEP:
      return 'deep';
    case s.REM:
      return 'rem';
    case s.SLEEPING:
    case s.UNKNOWN:
      return 'asleep';
    default:
      return null;
  }
}

function timedAverages(
  records: readonly { time: string; value: number }[],
): ReturnType<typeof dailyAverages> {
  const points: TimedValue[] = [];
  for (const r of records) {
    const atMs = Date.parse(r.time);
    if (!Number.isFinite(atMs)) continue;
    points.push({ date: toLocalDate(new Date(atMs)), value: r.value, atMs });
  }
  return dailyAverages(points);
}

export const healthConnectProvider: HealthProvider = {
  id: 'health_connect',
  label: PROVIDER_LABELS.health_connect,
  historyLimitDays: HISTORY_LIMIT_DAYS,

  async getAvailability(): Promise<ProviderAvailability> {
    let hc: HC;
    try {
      hc = loadHealthConnect();
    } catch {
      return {
        available: false,
        reason: 'native_module_missing',
        message: 'Health Connect needs a development build of Cal Track (it does not work in Expo Go).',
      };
    }
    try {
      const status = await hc.getSdkStatus();
      if (status === hc.SdkAvailabilityStatus.SDK_AVAILABLE) return { available: true };
      if (status === hc.SdkAvailabilityStatus.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED) {
        return {
          available: false,
          reason: 'update_required',
          message: 'Health Connect needs an update. Open the Google Play Store, search for "Health Connect by Android" and update it.',
        };
      }
      return {
        available: false,
        reason: 'not_installed',
        message:
          'Health Connect is not installed. Install "Health Connect by Android" from the Google Play Store (it is built into Android 14 and later), then come back.',
      };
    } catch {
      return {
        available: false,
        reason: 'native_module_missing',
        message: 'Health Connect needs a development build of Cal Track (it does not work in Expo Go).',
      };
    }
  },

  async isAvailable() {
    return (await this.getAvailability()).available;
  },

  async checkPermissions(types): Promise<PermissionResult> {
    const hc = loadHealthConnect();
    const granted = await grantedRecordTypes(hc);
    const grantedTypes = types.filter((t) => RECORDS[t].required.every((r) => granted.has(r)));
    const missingTypes = types.filter((t) => !grantedTypes.includes(t));
    return {
      granted: grantedTypes.length > 0,
      grantedTypes: [...grantedTypes],
      missingTypes: [...missingTypes],
    };
  },

  async requestPermissions(types, options?: RequestPermissionOptions): Promise<PermissionResult> {
    const hc = loadHealthConnect();
    await ensureInitialized(hc);
    const records = [...new Set(types.flatMap((t) => [...RECORDS[t].required, ...RECORDS[t].optional]))];
    if (records.length === 0) return { granted: false, grantedTypes: [], missingTypes: [] };
    const base = records.map((recordType) => ({ accessType: 'read' as const, recordType }));

    // Background access lets the periodic sync read while the app is closed; history access lifts the 30-day window.
    // Both need Android 14 / a recent Health Connect, so fall back to the plain request if they are rejected.
    let extendedHistoryRequested = false;
    try {
      const extras = [
        { accessType: 'read' as const, recordType: 'BackgroundAccessPermission' as const },
        ...(options?.wantHistory
          ? [{ accessType: 'read' as const, recordType: 'ReadHealthDataHistory' as const }]
          : []),
      ];
      await hc.requestPermission([...base, ...extras]);
      extendedHistoryRequested = Boolean(options?.wantHistory);
    } catch {
      await hc.requestPermission(base);
    }

    const result = await this.checkPermissions(types);
    const all = await hc.getGrantedPermissions();
    return {
      ...result,
      backgroundAccess: all.some((p) => p.recordType === 'BackgroundAccessPermission'),
      extendedHistoryRequested,
    };
  },

  async readDailyEnergy(range): Promise<DailyEnergyPoint[]> {
    const hc = loadHealthConnect();
    const granted = await grantedRecordTypes(hc);
    if (!granted.has('ActiveCaloriesBurned')) throw new Error('Health Connect: active calories permission is missing.');

    const days = eachDay(range);
    const points = await mapWithConcurrency(days, DAY_CONCURRENCY, async (date): Promise<DailyEnergyPoint> => {
      const filter = dayFilter(date);
      const [active, total, basal, steps] = await Promise.all([
        aggregateEnergyKcal(hc, 'ActiveCaloriesBurned', filter),
        granted.has('TotalCaloriesBurned') ? aggregateEnergyKcal(hc, 'TotalCaloriesBurned', filter) : null,
        granted.has('BasalMetabolicRate') ? aggregateEnergyKcal(hc, 'BasalMetabolicRate', filter) : null,
        granted.has('Steps')
          ? hc.aggregateRecord({ recordType: 'Steps', timeRangeFilter: filter }).then((r) =>
              aggregateOrNull(r.COUNT_TOTAL, r.dataOrigins),
            )
          : null,
      ]);
      return {
        date,
        activeKcal: active,
        restingKcal: deriveHealthConnectResting({ active, total, basal }),
        steps,
      };
    });
    return points.filter((p) => p.activeKcal !== null || p.restingKcal !== null || p.steps !== null);
  },

  async readWorkouts(range): Promise<WorkoutPoint[]> {
    const hc = loadHealthConnect();
    const granted = await grantedRecordTypes(hc);
    if (!granted.has('ExerciseSession')) return [];
    const sessions = await readAll(hc, 'ExerciseSession', rangeFilter(range));
    const typeNames = hc.ExerciseType as Record<string, number>;

    return mapWithConcurrency(sessions, DAY_CONCURRENCY, async (session): Promise<WorkoutPoint> => {
      const startMs = Date.parse(session.startTime);
      const endMs = Date.parse(session.endTime);
      const filter = { operator: 'between' as const, startTime: session.startTime, endTime: session.endTime };
      const origin = session.metadata?.dataOrigin;
      // Prefer the energy written by the app that recorded the session; fall back to any app.
      let kcal: number | null = null;
      try {
        if (origin) kcal = await aggregateEnergyKcal(hc, 'ActiveCaloriesBurned', filter, [origin]);
        if (kcal === null) kcal = await aggregateEnergyKcal(hc, 'ActiveCaloriesBurned', filter);
        if (kcal === null && granted.has('TotalCaloriesBurned')) {
          kcal = await aggregateEnergyKcal(hc, 'TotalCaloriesBurned', filter, origin ? [origin] : undefined);
        }
      } catch {
        kcal = null;
      }
      const name = session.title?.trim() || humanizeWorkoutKey(keyOfValue(typeNames, session.exerciseType));
      return {
        externalId: idOf(session.metadata, `${session.startTime}:${session.exerciseType}`),
        date: toLocalDate(new Date(startMs)),
        startedAt: new Date(startMs).toISOString(),
        endedAt: new Date(endMs).toISOString(),
        name,
        minutes: round((endMs - startMs) / 60_000, 1),
        kcal: kcal ?? 0,
      };
    });
  },

  async readBiometrics(type: BiometricDataType, range): Promise<BiometricPoint[]> {
    const hc = loadHealthConnect();
    const granted = await grantedRecordTypes(hc);
    for (const required of RECORDS[type].required) {
      if (!granted.has(required)) throw new Error(`Health Connect: permission for ${required} is missing.`);
    }
    const filter = rangeFilter(range);

    switch (type) {
      case 'weight': {
        const records = await readAll(hc, 'Weight', filter);
        return records
          .filter((r) => !OWN_PACKAGES.has(originOf(r.metadata)))
          .map((r) => ({
            type: 'weight' as const,
            date: toLocalDate(new Date(r.time)),
            value: r.weight.inKilograms,
            unit: 'kg',
            externalId: idOf(r.metadata, `weight:${r.time}`),
            recordedAt: new Date(r.time).toISOString(),
            meta: { origin: originOf(r.metadata) },
          }));
      }
      case 'body_fat': {
        const records = await readAll(hc, 'BodyFat', filter);
        return records
          .filter((r) => !OWN_PACKAGES.has(originOf(r.metadata)))
          .map((r) => ({
            type: 'body_fat' as const,
            date: toLocalDate(new Date(r.time)),
            value: r.percentage, // already 0-100
            unit: 'percent',
            externalId: idOf(r.metadata, `body_fat:${r.time}`),
            recordedAt: new Date(r.time).toISOString(),
            meta: { origin: originOf(r.metadata) },
          }));
      }
      case 'blood_pressure': {
        const records = await readAll(hc, 'BloodPressure', filter);
        return records
          .filter((r) => !OWN_PACKAGES.has(originOf(r.metadata)))
          .flatMap((r): BiometricPoint[] => {
            const base = idOf(r.metadata, `bp:${r.time}`);
            const date = toLocalDate(new Date(r.time));
            const recordedAt = new Date(r.time).toISOString();
            const meta = { origin: originOf(r.metadata) };
            return [
              { type: 'bp_systolic', date, value: r.systolic.inMillimetersOfMercury, unit: 'mmHg', externalId: `${base}:sys`, recordedAt, meta },
              { type: 'bp_diastolic', date, value: r.diastolic.inMillimetersOfMercury, unit: 'mmHg', externalId: `${base}:dia`, recordedAt, meta },
            ];
          });
      }
      case 'resting_heart_rate': {
        const records = await readAll(hc, 'RestingHeartRate', filter);
        return timedAverages(records.map((r) => ({ time: r.time, value: r.beatsPerMinute }))).map((a) =>
          dailyAveragePoint('resting_heart_rate', 'bpm', a, {}, 0),
        );
      }
      case 'hrv': {
        const records = await readAll(hc, 'HeartRateVariabilityRmssd', filter);
        // Health Connect reports RMSSD (Apple Health reports SDNN): the method is stored so they are never mixed up.
        return timedAverages(records.map((r) => ({ time: r.time, value: r.heartRateVariabilityMillis }))).map((a) =>
          dailyAveragePoint('hrv', 'ms', a, { method: 'rmssd' }, 1),
        );
      }
      case 'spo2': {
        const records = await readAll(hc, 'OxygenSaturation', filter);
        return timedAverages(records.map((r) => ({ time: r.time, value: r.percentage }))).map((a) =>
          dailyAveragePoint('spo2', 'percent', a, {}, 1),
        );
      }
      case 'respiration_rate': {
        const records = await readAll(hc, 'RespiratoryRate', filter);
        return timedAverages(records.map((r) => ({ time: r.time, value: r.rate }))).map((a) =>
          dailyAveragePoint('respiration_rate', 'brpm', a, {}, 1),
        );
      }
      case 'sleep': {
        const sleepFilter = {
          operator: 'between' as const,
          startTime: localDateAt(addDays(range.from, -1), 18).toISOString(),
          endTime: localDateAt(range.to, 18).toISOString(),
        };
        const sessions = await readAll(hc, 'SleepSession', sleepFilter);
        const segments: SleepSegment[] = [];
        for (const session of sessions) {
          const source = originOf(session.metadata);
          if (OWN_PACKAGES.has(source)) continue;
          const stages = session.stages ?? [];
          if (stages.length === 0) {
            // No stage data: the whole session counts as asleep.
            segments.push({ startMs: Date.parse(session.startTime), endMs: Date.parse(session.endTime), stage: 'asleep', source });
            continue;
          }
          for (const stage of stages) {
            const mapped = sleepStageOf(hc, stage.stage);
            if (mapped) segments.push({ startMs: Date.parse(stage.startTime), endMs: Date.parse(stage.endTime), stage: mapped, source });
          }
        }
        return summarizeNights(segments, range).map(nightToBiometricPoint);
      }
    }
  },

  openSystemSettings() {
    try {
      loadHealthConnect().openHealthConnectSettings();
    } catch {
      Linking.openSettings().catch(() => {});
    }
  },
};

export const getHealthProvider = (): HealthProvider => healthConnectProvider;
