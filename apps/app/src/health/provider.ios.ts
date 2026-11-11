// Apple Health (HealthKit) provider. iOS only.
//
// - The native module is loaded lazily so the app still starts in Expo Go / on a build without it.
// - Energy and steps use statistics collection queries (one bucket per local day, cumulativeSum). HealthKit merges
//   overlapping sources (iPhone, Watch, Garmin Connect, ...) with the user's source priority, so nothing is summed from
//   raw samples here.
// - HealthKit hides whether READ access was granted. Reading a type that was never requested crashes the app, so every
//   read first checks that the authorization prompt has been shown for that type.
//
// TODO(write-back): when nutrition is written back to Apple Health, samples whose source is this app must be excluded
// from every read here (use currentAppSource().bundleIdentifier). Today nothing is written; OWN_BUNDLE_IDS is a guard.
import { Linking } from 'react-native';

import { addDays, eachDay, localDateAt, rangeBounds, toLocalDate } from './dates';
import { dailyAveragePoint, humanizeWorkoutKey, round, toPercent } from './mapping';
import { nightToBiometricPoint, summarizeNights, type SleepSegment, type SleepStage } from './sleep';
import { PROVIDER_LABELS } from './settings';
import type {
  BiometricDataType,
  BiometricPoint,
  BiometricRowType,
  DailyEnergyPoint,
  DateRange,
  HealthDataType,
  HealthProvider,
  LocalDate,
  MetaValue,
  PermissionResult,
  ProviderAvailability,
  WorkoutPoint,
} from './types';

import type { ObjectTypeIdentifier, QuantityTypeIdentifier } from '@kingstinct/react-native-healthkit';

type HK = typeof import('@kingstinct/react-native-healthkit');

const OWN_BUNDLE_IDS: ReadonlySet<string> = new Set([
  'com.spojskic.ration',
  'com.spojskic.caltrack', // the app's bundle id before the rename
  'com.caltrack.app',
]);

function loadHealthKit(): HK {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@kingstinct/react-native-healthkit') as HK;
}

const ID = {
  active: 'HKQuantityTypeIdentifierActiveEnergyBurned',
  basal: 'HKQuantityTypeIdentifierBasalEnergyBurned',
  steps: 'HKQuantityTypeIdentifierStepCount',
  weight: 'HKQuantityTypeIdentifierBodyMass',
  bodyFat: 'HKQuantityTypeIdentifierBodyFatPercentage',
  restingHr: 'HKQuantityTypeIdentifierRestingHeartRate',
  hrv: 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
  spo2: 'HKQuantityTypeIdentifierOxygenSaturation',
  respiration: 'HKQuantityTypeIdentifierRespiratoryRate',
  systolic: 'HKQuantityTypeIdentifierBloodPressureSystolic',
  diastolic: 'HKQuantityTypeIdentifierBloodPressureDiastolic',
  sleep: 'HKCategoryTypeIdentifierSleepAnalysis',
  workout: 'HKWorkoutTypeIdentifier',
} as const;

/** HealthKit read types per user-facing data type (only these are ever requested or queried). */
const READ_TYPES: Record<HealthDataType, readonly ObjectTypeIdentifier[]> = {
  activity: [ID.active, ID.basal, ID.steps, ID.workout],
  weight: [ID.weight],
  body_fat: [ID.bodyFat],
  resting_heart_rate: [ID.restingHr],
  hrv: [ID.hrv],
  spo2: [ID.spo2],
  respiration_rate: [ID.respiration],
  sleep: [ID.sleep],
  blood_pressure: [ID.systolic, ID.diastolic],
};

async function requestStatusUnnecessary(hk: HK, type: HealthDataType): Promise<boolean> {
  const status = await hk.getRequestStatusForAuthorization({ toRead: [...READ_TYPES[type]] });
  return status === hk.AuthorizationRequestStatus.unnecessary;
}

async function assertRequested(hk: HK, type: HealthDataType): Promise<void> {
  if (!(await requestStatusUnnecessary(hk, type))) {
    throw new Error('Apple Health access for this data type has not been requested yet. Enable it in Connected Apps & Devices.');
  }
}

interface DayStat {
  value: number;
  lastAtMs?: number;
}

/** One statistics bucket per local day. Returns only days that have data. */
async function dailyStatistics(
  hk: HK,
  identifier: QuantityTypeIdentifier,
  unit: string,
  statistic: 'cumulativeSum' | 'discreteAverage',
  range: DateRange,
): Promise<Map<LocalDate, DayStat>> {
  const { start, endExclusive } = rangeBounds(range);
  const stats = await hk.queryStatisticsCollectionForQuantity(
    identifier,
    statistic === 'discreteAverage' ? ['discreteAverage', 'mostRecent'] : ['cumulativeSum'],
    start, // anchor: local midnight, so every interval is one calendar day
    { day: 1 },
    { filter: { date: { startDate: start, endDate: endExclusive } }, unit },
  );
  const out = new Map<LocalDate, DayStat>();
  for (const bucket of stats) {
    const quantity = statistic === 'cumulativeSum' ? bucket.sumQuantity : bucket.averageQuantity;
    if (!quantity || !bucket.startDate || !Number.isFinite(quantity.quantity)) continue;
    const last = bucket.mostRecentQuantityDateInterval?.to;
    out.set(toLocalDate(bucket.startDate), {
      value: quantity.quantity,
      lastAtMs: last ? last.getTime() : undefined,
    });
  }
  return out;
}

async function quantitySamples(hk: HK, identifier: QuantityTypeIdentifier, unit: string, range: DateRange) {
  const { start, endExclusive } = rangeBounds(range);
  const samples = await hk.queryQuantitySamples(identifier, {
    filter: { date: { startDate: start, endDate: endExclusive } },
    limit: 0, // no limit
    ascending: true,
    unit,
  });
  return samples.filter((s) => !OWN_BUNDLE_IDS.has(s.sourceRevision.source.bundleIdentifier));
}

function sleepStageOf(hk: HK, value: number): SleepStage | null {
  const v = hk.CategoryValueSleepAnalysis;
  switch (value) {
    case v.inBed:
      return 'in_bed';
    case v.awake:
      return 'awake';
    case v.asleepCore:
      return 'core';
    case v.asleepDeep:
      return 'deep';
    case v.asleepREM:
      return 'rem';
    case v.asleepUnspecified:
      return 'asleep';
    default:
      return null;
  }
}

async function readDailyAveragePoints(
  hk: HK,
  identifier: QuantityTypeIdentifier,
  hkUnit: string,
  range: DateRange,
  build: (date: LocalDate, stat: DayStat) => BiometricPoint,
): Promise<BiometricPoint[]> {
  const stats = await dailyStatistics(hk, identifier, hkUnit, 'discreteAverage', range);
  return eachDay(range).flatMap((date) => {
    const stat = stats.get(date);
    return stat ? [build(date, stat)] : [];
  });
}

function averagePointFromStat(
  type: BiometricRowType,
  unit: string,
  date: LocalDate,
  value: number,
  stat: DayStat,
  meta?: Record<string, MetaValue>,
  digits?: number,
): BiometricPoint {
  // HealthKit already averaged the day; the number of samples is not reported.
  return dailyAveragePoint(type, unit, { date, value, lastAtMs: stat.lastAtMs ?? 0 }, meta, digits);
}

export const appleHealthProvider: HealthProvider = {
  id: 'apple_health',
  label: PROVIDER_LABELS.apple_health,

  async getAvailability(): Promise<ProviderAvailability> {
    let hk: HK;
    try {
      hk = loadHealthKit();
    } catch {
      return {
        available: false,
        reason: 'native_module_missing',
        message: 'Apple Health needs a development build of Ration (it does not work in Expo Go).',
      };
    }
    try {
      const ok = await hk.isHealthDataAvailableAsync();
      return ok
        ? { available: true }
        : { available: false, reason: 'unsupported_device', message: 'Apple Health is not available on this device.' };
    } catch {
      return {
        available: false,
        reason: 'native_module_missing',
        message: 'Apple Health needs a development build of Ration (it does not work in Expo Go).',
      };
    }
  },

  async isAvailable() {
    return (await this.getAvailability()).available;
  },

  async checkPermissions(types): Promise<PermissionResult> {
    const hk = loadHealthKit();
    const grantedTypes: HealthDataType[] = [];
    const missingTypes: HealthDataType[] = [];
    for (const type of types) {
      ((await requestStatusUnnecessary(hk, type)) ? grantedTypes : missingTypes).push(type);
    }
    return {
      granted: grantedTypes.length > 0,
      grantedTypes,
      missingTypes,
      note: 'Apple Health does not tell apps which categories were allowed; denied categories simply return no data.',
    };
  },

  async requestPermissions(types): Promise<PermissionResult> {
    const hk = loadHealthKit();
    const identifiers = [...new Set(types.flatMap((t) => READ_TYPES[t]))];
    if (identifiers.length === 0) return { granted: false, grantedTypes: [], missingTypes: [] };
    // Read-only: no toShare. (Write-back of nutrition would add it here.)
    const completed = await hk.requestAuthorization({ toRead: identifiers });
    return {
      granted: completed,
      grantedTypes: completed ? [...types] : [],
      missingTypes: completed ? [] : [...types],
      note: 'To change what Ration can read, open Health > Sharing > Apps > Ration.',
    };
  },

  async readDailyEnergy(range): Promise<DailyEnergyPoint[]> {
    const hk = loadHealthKit();
    await assertRequested(hk, 'activity');
    const [active, basal, steps] = await Promise.all([
      dailyStatistics(hk, ID.active, 'kcal', 'cumulativeSum', range),
      dailyStatistics(hk, ID.basal, 'kcal', 'cumulativeSum', range),
      dailyStatistics(hk, ID.steps, 'count', 'cumulativeSum', range),
    ]);
    return eachDay(range).flatMap((date) => {
      const a = active.get(date)?.value ?? null;
      const r = basal.get(date)?.value ?? null;
      const s = steps.get(date)?.value ?? null;
      return a === null && r === null && s === null ? [] : [{ date, activeKcal: a, restingKcal: r, steps: s }];
    });
  },

  async readWorkouts(range): Promise<WorkoutPoint[]> {
    const hk = loadHealthKit();
    await assertRequested(hk, 'activity');
    const { start, endExclusive } = rangeBounds(range);
    const workouts = await hk.queryWorkoutSamples({
      filter: { date: { startDate: start, endDate: endExclusive } },
      limit: 0,
      ascending: true,
    });
    const out: WorkoutPoint[] = [];
    for (const w of workouts) {
      // Copy plain data first; the proxy is released right after.
      const startedAt = w.startDate;
      const endedAt = w.endDate;
      const seconds = w.duration.unit === 's' ? w.duration.quantity : (endedAt.getTime() - startedAt.getTime()) / 1000;
      out.push({
        externalId: w.uuid,
        date: toLocalDate(startedAt),
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        name: humanizeWorkoutKey(hk.WorkoutActivityType[w.workoutActivityType]),
        minutes: round(seconds / 60, 1),
        kcal: w.totalEnergyBurned?.quantity ?? 0,
      });
      w.dispose();
    }
    return out;
  },

  async readBiometrics(type: BiometricDataType, range): Promise<BiometricPoint[]> {
    const hk = loadHealthKit();
    await assertRequested(hk, type);

    switch (type) {
      case 'weight': {
        const samples = await quantitySamples(hk, ID.weight, 'kg', range);
        return samples.map((s) => ({
          type: 'weight',
          date: toLocalDate(s.startDate),
          value: s.quantity,
          unit: 'kg',
          externalId: s.uuid,
          recordedAt: s.startDate.toISOString(),
          meta: { source_name: s.sourceRevision.source.name },
        }));
      }
      case 'body_fat': {
        const samples = await quantitySamples(hk, ID.bodyFat, '%', range);
        return samples.map((s) => ({
          type: 'body_fat',
          date: toLocalDate(s.startDate),
          value: toPercent(s.quantity),
          unit: 'percent',
          externalId: s.uuid,
          recordedAt: s.startDate.toISOString(),
          meta: { source_name: s.sourceRevision.source.name },
        }));
      }
      case 'blood_pressure': {
        const [sys, dia] = await Promise.all([
          quantitySamples(hk, ID.systolic, 'mmHg', range),
          quantitySamples(hk, ID.diastolic, 'mmHg', range),
        ]);
        const toPoint = (rowType: 'bp_systolic' | 'bp_diastolic') => (s: (typeof sys)[number]): BiometricPoint => ({
          type: rowType,
          date: toLocalDate(s.startDate),
          value: s.quantity,
          unit: 'mmHg',
          externalId: s.uuid,
          recordedAt: s.startDate.toISOString(),
          meta: { source_name: s.sourceRevision.source.name },
        });
        return [...sys.map(toPoint('bp_systolic')), ...dia.map(toPoint('bp_diastolic'))];
      }
      case 'resting_heart_rate':
        return readDailyAveragePoints(hk, ID.restingHr, 'count/min', range, (date, stat) =>
          averagePointFromStat('resting_heart_rate', 'bpm', date, stat.value, stat, undefined, 0),
        );
      case 'hrv':
        // Apple reports SDNN (Health Connect reports RMSSD): the method is stored so the two are never mixed up.
        return readDailyAveragePoints(hk, ID.hrv, 'ms', range, (date, stat) =>
          averagePointFromStat('hrv', 'ms', date, stat.value, stat, { method: 'sdnn' }, 1),
        );
      case 'spo2':
        return readDailyAveragePoints(hk, ID.spo2, '%', range, (date, stat) =>
          averagePointFromStat('spo2', 'percent', date, toPercent(stat.value), stat, undefined, 1),
        );
      case 'respiration_rate':
        return readDailyAveragePoints(hk, ID.respiration, 'count/min', range, (date, stat) =>
          averagePointFromStat('respiration_rate', 'brpm', date, stat.value, stat, undefined, 1),
        );
      case 'sleep': {
        // Nights end on a local date; query from 18:00 the evening before the first night to 18:00 on the last day.
        const startDate = localDateAt(addDays(range.from, -1), 18);
        const endDate = localDateAt(range.to, 18);
        const samples = await hk.queryCategorySamples(ID.sleep, {
          filter: { date: { startDate, endDate } },
          limit: 0,
          ascending: true,
        });
        const segments: SleepSegment[] = [];
        for (const s of samples) {
          const stage = sleepStageOf(hk, s.value);
          if (!stage || OWN_BUNDLE_IDS.has(s.sourceRevision.source.bundleIdentifier)) continue;
          segments.push({
            startMs: s.startDate.getTime(),
            endMs: s.endDate.getTime(),
            stage,
            source: s.sourceRevision.source.bundleIdentifier,
          });
        }
        return summarizeNights(segments, range).map(nightToBiometricPoint);
      }
    }
  },

  openSystemSettings() {
    // Opens the Health app; permissions live under Sharing > Apps > Ration.
    Linking.openURL('x-apple-health://').catch(() => {
      Linking.openSettings().catch(() => {});
    });
  },
};

export const getHealthProvider = (): HealthProvider => appleHealthProvider;
