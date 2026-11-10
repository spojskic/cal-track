// Tolerant mappers: raw Garmin Connect JSON (the mobile-app interface) -> normalized shapes + diagnostics.
//
// FIELD NAMES. Where a name is marked VERIFIED it was read from the Rust structs / parsing of the reference project
// (garmin-companion: crates/garmin-core/src/{client,sync,sleep,intraday}.rs). Everything else is a GUESS (mostly the
// nested names the Personal API used, plus the usual Garmin spellings) and is listed after the verified name, so the
// first candidate wins. The mappers never throw on unexpected input: every candidate is tried, numeric strings are
// accepted, missing fields stay absent (never 0), and whatever could not be found is reported in `diagnostics` /
// `coverage` (key NAMES and counts only, never a value).

import { detailsFromListItem } from './activity-mappers';
import { leadingYmd, utcDateOf } from './dates';
import {
  FieldTracker,
  dedupe,
  extractItems,
  isObject,
  parseGarminTimestamp,
  pickNumber,
  pickString,
  round,
  secondsToHours,
  secondsToMinutes,
  weightIsGrams,
  weightToKg,
  type Obj,
} from './pick';
import type {
  GarminBiometric,
  GarminBiometricType,
  GarminDailyEnergy,
  GarminMap,
  GarminMapResult,
  GarminMeta,
  GarminWorkout,
} from './normalized';
import { GARMIN_BIOMETRIC_UNITS } from './normalized';

export const FIELD_CANDIDATES = {
  /** GET /userprofile-service/socialProfile */
  profile: {
    // VERIFIED: Profile.display_name (client.rs)
    displayName: ['displayName'],
  },
  /** GET /usersummary-service/usersummary/daily/{displayName}?calendarDate= */
  userSummary: {
    // VERIFIED (sync.rs sync_daily): activeKilocalories, bmrKilocalories, totalKilocalories, totalSteps, restingHeartRate,
    // averageStressLevel, bodyBatteryHighestValue, bodyBatteryLowestValue. The dotted names are GUESSES (Personal API v2).
    activeKcal: ['activeKilocalories', 'calories.burnedActive', 'activeKcal'],
    restingKcal: ['bmrKilocalories', 'calories.burnedResting', 'restingKilocalories'],
    totalKcal: ['totalKilocalories', 'calories.burnedTotal'],
    steps: ['totalSteps', 'movement.steps.value', 'steps'],
    restingHr: ['restingHeartRate', 'heartRate.restingValue'],
    stress: ['averageStressLevel', 'stress.avgLevel', 'avgStressLevel'],
    bodyBatteryHigh: ['bodyBatteryHighestValue', 'bodyBattery.maxValue'],
    bodyBatteryLow: ['bodyBatteryLowestValue', 'bodyBattery.minValue'],
  },
  /** GET /wellness-service/wellness/dailySleepData/{displayName}?date= */
  sleep: {
    // VERIFIED (sleep.rs SleepNight::from_payload): everything under dailySleepDTO, plus the top-level avgOvernightHrv.
    // The un-nested names are GUESSES (a flatter shape).
    totalSec: ['dailySleepDTO.sleepTimeSeconds', 'sleepTimeSeconds'],
    deepSec: ['dailySleepDTO.deepSleepSeconds', 'deepSleepSeconds'],
    lightSec: ['dailySleepDTO.lightSleepSeconds', 'lightSleepSeconds'],
    remSec: ['dailySleepDTO.remSleepSeconds', 'remSleepSeconds'],
    awakeSec: ['dailySleepDTO.awakeSleepSeconds', 'awakeSleepSeconds'],
    score: ['dailySleepDTO.sleepScores.overall.value', 'sleepScores.overall.value'],
    scoreQualifier: ['dailySleepDTO.sleepScores.overall.qualifierKey', 'sleepScores.overall.qualifierKey'],
    startGmt: ['dailySleepDTO.sleepStartTimestampGMT', 'sleepStartTimestampGMT'],
    endGmt: ['dailySleepDTO.sleepEndTimestampGMT', 'sleepEndTimestampGMT'],
    spo2: ['dailySleepDTO.averageSpO2Value', 'averageSpO2Value'],
    spo2Low: ['dailySleepDTO.lowestSpO2Value', 'lowestSpO2Value'],
    respiration: ['dailySleepDTO.averageRespirationValue', 'averageRespirationValue'],
    avgOvernightHrv: ['avgOvernightHrv'],
  },
  /** GET /hrv-service/hrv/{date} */
  hrv: {
    // VERIFIED (sync.rs): hrvSummary.lastNightAvg / weeklyAvg / status / baseline.{lowUpper,balancedLow,balancedUpper}.
    lastNight: ['hrvSummary.lastNightAvg', 'lastNightAvg'],
    weeklyAvg: ['hrvSummary.weeklyAvg', 'weeklyAvg'],
    status: ['hrvSummary.status', 'status'],
    baselineLow: ['hrvSummary.baseline.balancedLow', 'baseline.balancedLow'],
    baselineHigh: ['hrvSummary.baseline.balancedUpper', 'baseline.balancedUpper'],
  },
  /** GET /weight-service/weight/dateRange?startDate=&endDate= */
  weight: {
    // VERIFIED (client.rs WeightSample): dateWeightList[] with samplePk, calendarDate, weight (GRAMS), bmi, bodyFat,
    // bodyWater, boneMass, muscleMass, sourceType. timestampGMT is a GUESS (the Personal API had it).
    id: ['samplePk'],
    date: ['calendarDate', 'summaryDate'],
    weight: ['weight', 'weightInGrams'],
    bodyFat: ['bodyFat', 'bodyFatPercentage'],
    bmi: ['bmi'],
    muscleMass: ['muscleMass'],
    boneMass: ['boneMass'],
    bodyWater: ['bodyWater', 'bodyWaterPercentage'],
    recordedAt: ['timestampGMT', 'timestampGmt'],
    sourceType: ['sourceType'],
  },
  /** GET /activitylist-service/activities/search/activities?start=&limit= */
  activities: {
    // VERIFIED (client.rs ActivitySummary): activityId, activityName, startTimeLocal ('YYYY-MM-DD HH:MM:SS'), distance (m),
    // duration (s), movingDuration, calories, activityType.typeKey. startTimeGMT and elapsedDuration are GUESSES.
    id: ['activityId', 'id'],
    name: ['activityName', 'name'],
    startLocal: ['startTimeLocal'],
    startGmt: ['startTimeGMT', 'startTimeGmt'],
    typeKey: ['activityType.typeKey', 'activityTypeDTO.typeKey', 'typeKey'],
    distance: ['distance'],
    duration: ['duration'],
    elapsed: ['elapsedDuration'],
    moving: ['movingDuration'],
    calories: ['calories', 'totalCalories'],
  },
} as const;

function meta(entries: Record<string, string | number | boolean | undefined>): GarminMeta | undefined {
  const out: GarminMeta = {};
  for (const [k, v] of Object.entries(entries)) if (v !== undefined) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

function bio(
  type: GarminBiometricType,
  date: string,
  value: number,
  extra: { meta?: GarminMeta | undefined; recordedAtMs?: number | undefined; id?: string } = {},
): GarminBiometric {
  return {
    date,
    type,
    value,
    unit: GARMIN_BIOMETRIC_UNITS[type],
    externalId: `garmin:${type}:${extra.id ?? date}`,
    ...(extra.recordedAtMs !== undefined ? { recordedAtMs: extra.recordedAtMs } : {}),
    ...(extra.meta ? { meta: extra.meta } : {}),
  };
}

function finish<T>(t: FieldTracker, items: T[]): GarminMapResult<T> {
  return { items, diagnostics: t.diagnostics(), coverage: t.coverage() };
}

/** The single object of a one-day reply (the three per-day endpoints answer with one object). */
function singleObject(raw: unknown, t: FieldTracker): Obj | null {
  if (isObject(raw)) return raw;
  // An array with one object is accepted too (training readiness does that; the others might).
  if (Array.isArray(raw) && raw.length > 0 && isObject(raw[0])) return raw[0];
  if (raw !== null && raw !== undefined) {
    t.note('$', 'unexpected_shape', `expected an object, got ${Array.isArray(raw) ? 'an array' : typeof raw}`);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// profile
// ---------------------------------------------------------------------------------------------------------------------

export interface MappedProfile extends GarminMap {
  displayName?: string;
}

export function mapProfile(raw: unknown): MappedProfile {
  const t = new FieldTracker('profile');
  const obj = singleObject(raw, t);
  let displayName: string | undefined;
  if (obj) {
    t.item();
    displayName = t.string(obj, 'displayName', FIELD_CANDIDATES.profile.displayName);
  }
  return { ...(displayName ? { displayName } : {}), diagnostics: t.diagnostics(), coverage: t.coverage() };
}

// ---------------------------------------------------------------------------------------------------------------------
// usersummary/daily  ->  energy + resting HR + stress + body battery
// ---------------------------------------------------------------------------------------------------------------------

export interface MappedUserSummary extends GarminMap {
  /** Absent when the day carried no energy figure at all. */
  energy?: GarminDailyEnergy;
  biometrics: GarminBiometric[];
}

/**
 * One day of the daily rollup. The totals are CUMULATIVE for the day (a Garmin shows 801 resting kcal at midday): the
 * result is the latest value, to be upserted over an earlier one, never added to it. A value that is 0 or absent stays
 * absent ("unknown", never a fake 0). Garmin answers 200 with every field null for days before the watch was worn.
 */
export function mapUserSummary(raw: unknown, date: string): MappedUserSummary {
  const t = new FieldTracker('userSummary');
  const c = FIELD_CANDIDATES.userSummary;
  const biometrics: GarminBiometric[] = [];
  const obj = singleObject(raw, t);
  let energy: GarminDailyEnergy | undefined;

  if (obj) {
    t.item();
    const o = { date, optional: true };
    const kcal = { ...o, min: 0, minExclusive: true, max: 20000, decimals: 0 };
    let active = t.rounded(obj, 'activeKcal', c.activeKcal, kcal);
    let resting = t.rounded(obj, 'restingKcal', c.restingKcal, kcal);
    let total = t.rounded(obj, 'totalKcal', c.totalKcal, kcal);
    const steps = t.rounded(obj, 'steps', c.steps, { ...o, min: 0, minExclusive: true, max: 200000, decimals: 0 });
    if (total === undefined && active !== undefined && resting !== undefined) {
      total = round(active + resting, 0);
      t.note('totalKcal', 'fallback_used', 'total = active + resting', date);
    }
    if (resting === undefined && total !== undefined && active !== undefined && total > active) {
      resting = round(total - active, 0);
      t.note('restingKcal', 'fallback_used', 'resting = total - active', date);
    }
    if (active === undefined && total !== undefined && resting !== undefined && total > resting) {
      active = round(total - resting, 0);
      t.note('activeKcal', 'fallback_used', 'active = total - resting', date);
    }
    if (active !== undefined || resting !== undefined || total !== undefined || steps !== undefined) {
      energy = {
        date,
        ...(active !== undefined ? { activeKcal: active } : {}),
        ...(resting !== undefined ? { restingKcal: resting } : {}),
        ...(total !== undefined ? { totalKcal: total } : {}),
        ...(steps !== undefined ? { steps } : {}),
      };
    }

    const restingHr = t.rounded(obj, 'restingHeartRate', c.restingHr, { ...o, min: 25, max: 220, decimals: 0 });
    if (restingHr !== undefined) biometrics.push(bio('resting_heart_rate', date, restingHr));

    // Garmin reports -1 / -2 when the stress level could not be measured: the range check drops those.
    const stress = t.rounded(obj, 'stress', c.stress, { ...o, min: 1, max: 100, decimals: 0 });
    if (stress !== undefined) biometrics.push(bio('stress', date, stress));

    const pct = { ...o, min: 0, minExclusive: true, max: 100, decimals: 0 };
    const high = t.rounded(obj, 'bodyBatteryHigh', c.bodyBatteryHigh, pct);
    const low = t.rounded(obj, 'bodyBatteryLow', c.bodyBatteryLow, { ...pct, minExclusive: false });
    if (high !== undefined) biometrics.push(bio('body_battery', date, high, { meta: meta({ high, low }) }));
  }

  return { ...(energy ? { energy } : {}), biometrics, diagnostics: t.diagnostics(), coverage: t.coverage() };
}

// ---------------------------------------------------------------------------------------------------------------------
// dailySleepData  ->  sleep (hours) + sleep score + night SpO2 / respiration
// ---------------------------------------------------------------------------------------------------------------------

export interface MappedSleep extends GarminMap {
  biometrics: GarminBiometric[];
  /** Overnight HRV average of the sleep reply: a fallback when the HRV endpoint has nothing for the night. */
  avgOvernightHrv?: number;
}

/** A night, keyed by the day the athlete woke up (which is also how the app files it). */
export function mapSleepDay(raw: unknown, date: string): MappedSleep {
  const t = new FieldTracker('sleep');
  const c = FIELD_CANDIDATES.sleep;
  const biometrics: GarminBiometric[] = [];
  const obj = singleObject(raw, t);
  let avgOvernightHrv: number | undefined;

  if (obj) {
    t.item();
    const o = { date, optional: true };
    const sec = { ...o, min: 0, max: 86400 };
    let totalSec = t.number(obj, 'sleepTimeSeconds', c.totalSec, { ...sec, minExclusive: true });
    const deep = t.number(obj, 'deepSleepSeconds', c.deepSec, sec);
    const light = t.number(obj, 'lightSleepSeconds', c.lightSec, sec);
    const rem = t.number(obj, 'remSleepSeconds', c.remSec, sec);
    const awake = t.number(obj, 'awakeSleepSeconds', c.awakeSec, sec);
    if (totalSec === undefined && (deep !== undefined || light !== undefined || rem !== undefined)) {
      const sum = (deep ?? 0) + (light ?? 0) + (rem ?? 0);
      if (sum > 0) {
        totalSec = sum;
        t.note('sleepTimeSeconds', 'fallback_used', 'total = deep + light + rem', date);
      }
    }
    const startMs = t.timestamp(obj, 'sleepStartMs', c.startGmt, 'gmt', o);
    const endMs = t.timestamp(obj, 'sleepEndMs', c.endGmt, 'gmt', o);
    const score = t.rounded(obj, 'sleepScore', c.score, { ...o, min: 0, minExclusive: true, max: 100, decimals: 0 });
    const quality = t.string(obj, 'sleepScoreQualifier', c.scoreQualifier, o);

    if (totalSec !== undefined) {
      const hours = secondsToHours(totalSec);
      if (hours < 0.1 || hours > 24) {
        t.note('sleepTimeSeconds', 'implausible', 'the night is shorter than 6 minutes or longer than 24 hours', date);
      } else {
        const staged = deep !== undefined || light !== undefined || rem !== undefined;
        biometrics.push(
          bio('sleep', date, hours, {
            recordedAtMs: endMs,
            // Same keys as the Apple Health / Health Connect nights (minutes), plus Garmin's score and the sleep window.
            meta: meta({
              source: 'garmin',
              deep: deep !== undefined ? secondsToMinutes(deep) : undefined,
              core: light !== undefined ? secondsToMinutes(light) : undefined,
              rem: rem !== undefined ? secondsToMinutes(rem) : undefined,
              awake: awake !== undefined ? secondsToMinutes(awake) : undefined,
              staged,
              score,
              quality,
              startMs,
              endMs,
            }),
          }),
        );
      }
    }
    if (score !== undefined) biometrics.push(bio('sleep_score', date, score, { recordedAtMs: endMs, meta: meta({ quality }) }));

    const spo2 = t.rounded(obj, 'spo2', c.spo2, { ...o, min: 50, max: 100, decimals: 1 });
    const spo2Low = t.rounded(obj, 'spo2Low', c.spo2Low, { ...o, min: 30, max: 100, decimals: 1 });
    if (spo2 !== undefined) biometrics.push(bio('spo2', date, spo2, { recordedAtMs: endMs, meta: meta({ source: 'sleep', low: spo2Low }) }));
    const respiration = t.rounded(obj, 'respiration', c.respiration, { ...o, min: 3, max: 60, decimals: 1 });
    if (respiration !== undefined) biometrics.push(bio('respiration_rate', date, respiration, { recordedAtMs: endMs, meta: meta({ source: 'sleep' }) }));

    avgOvernightHrv = t.rounded(obj, 'avgOvernightHrv', c.avgOvernightHrv, { ...o, min: 0, minExclusive: true, max: 500, decimals: 0 });
  }

  return {
    biometrics,
    ...(avgOvernightHrv !== undefined ? { avgOvernightHrv } : {}),
    diagnostics: t.diagnostics(),
    coverage: t.coverage(),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// hrv
// ---------------------------------------------------------------------------------------------------------------------

export interface MappedHrv extends GarminMap {
  biometrics: GarminBiometric[];
}

/** Overnight HRV (average of the night, ms). An empty reply never gets here: it means "the watch was not worn". */
export function mapHrvDay(raw: unknown, date: string): MappedHrv {
  const t = new FieldTracker('hrv');
  const c = FIELD_CANDIDATES.hrv;
  const biometrics: GarminBiometric[] = [];
  const obj = singleObject(raw, t);
  if (obj) {
    t.item();
    const o = { date, optional: true };
    const value = t.rounded(obj, 'lastNightAvg', c.lastNight, { ...o, min: 0, minExclusive: true, max: 500, decimals: 0 });
    if (value !== undefined) {
      const weeklyAvg = t.rounded(obj, 'weeklyAvg', c.weeklyAvg, { ...o, min: 0, max: 500, decimals: 0 });
      const status = t.string(obj, 'status', c.status, o);
      const baselineLow = t.rounded(obj, 'baselineLow', c.baselineLow, { ...o, min: 0, max: 500, decimals: 0 });
      const baselineHigh = t.rounded(obj, 'baselineHigh', c.baselineHigh, { ...o, min: 0, max: 500, decimals: 0 });
      // Garmin's overnight HRV is RMSSD-based (Apple Health reports SDNN). ASSUMPTION: the method is stored so the two
      // are never mixed up.
      biometrics.push(bio('hrv', date, value, { meta: meta({ method: 'rmssd', status, weeklyAvg, baselineLow, baselineHigh }) }));
    }
  }
  return { biometrics, diagnostics: t.diagnostics(), coverage: t.coverage() };
}

/** Builds the HRV biometric from the sleep reply's overnight average (used when the HRV endpoint had nothing). */
export function hrvFromSleep(date: string, avgOvernightHrv: number): GarminBiometric {
  return bio('hrv', date, avgOvernightHrv, { meta: meta({ method: 'rmssd', from: 'sleep' }) });
}

// ---------------------------------------------------------------------------------------------------------------------
// weight/dateRange  ->  weight (kg) + body fat (%)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Every weigh-in of the window. Garmin sends the weight in GRAMS (a value above 1000 is converted to kg). One entry per
 * weigh-in: the id is Garmin's samplePk, so a corrected weigh-in updates the stored row instead of adding a second one.
 */
export function mapWeightRange(raw: unknown): GarminMapResult<GarminBiometric> {
  const t = new FieldTracker('weight');
  const c = FIELD_CANDIDATES.weight;
  const out: GarminBiometric[] = [];
  const perDay = new Map<string, number>();

  const items = extractItems(raw, t, {
    keys: ['dateWeightList', 'dailyWeightSummaries', 'data', 'weights', 'allWeightMetrics', 'items'],
    itemHints: ['samplePk', 'weight', 'calendarDate'],
  });
  for (const it of items) {
    t.item();
    let date = t.date(it, 'date', c.date, { optional: true });
    if (!date) {
      // DateWeightDTO.date is epoch milliseconds; the UTC day can be off by one near midnight.
      const ms = parseGarminTimestamp(pickNumber(it, ['date']), 'gmt');
      if (ms !== undefined) {
        date = utcDateOf(ms);
        t.note('date', 'fallback_used', 'calendarDate missing; derived the date from epoch ms (UTC)', date);
      } else {
        date = leadingYmd(pickString(it, ['date'])) ?? undefined;
      }
    }
    if (!date) {
      t.note('date', 'skipped', 'weigh-in without a usable date');
      continue;
    }
    const o = { date, optional: true };
    const recordedAtMs = t.timestamp(it, 'recordedAtMs', c.recordedAt, 'gmt', o);
    const samplePk = t.string(it, 'samplePk', c.id, o);
    let id: string;
    if (samplePk) {
      id = samplePk;
    } else if (recordedAtMs !== undefined) {
      id = `${date}:${recordedAtMs}`;
    } else {
      const n = perDay.get(date) ?? 0;
      perDay.set(date, n + 1);
      id = n === 0 ? date : `${date}:${n}`;
    }

    const rawW = t.number(it, 'weight', c.weight, { ...o, min: 0, minExclusive: true });
    if (rawW !== undefined) {
      const kg = weightToKg(rawW);
      if (kg < 20 || kg > 400) {
        t.note('weight', 'implausible', 'weight outside 20-400 kg', date);
      } else {
        if (weightIsGrams(rawW)) t.note('weight', 'converted', 'grams -> kg (value > 1000)', date);
        const bmi = t.rounded(it, 'bmi', c.bmi, { ...o, min: 5, max: 100, decimals: 1 });
        const muscle = t.number(it, 'muscleMass', c.muscleMass, { ...o, min: 0, minExclusive: true });
        const bone = t.number(it, 'boneMass', c.boneMass, { ...o, min: 0, minExclusive: true });
        const water = t.rounded(it, 'bodyWater', c.bodyWater, { ...o, min: 0, max: 100, decimals: 1 });
        const source = t.string(it, 'sourceType', c.sourceType, o);
        out.push(
          bio('weight', date, kg, {
            id,
            recordedAtMs,
            meta: meta({
              bmi,
              muscleMassKg: muscle !== undefined ? weightToKg(muscle) : undefined,
              boneMassKg: bone !== undefined ? weightToKg(bone) : undefined,
              bodyWaterPct: water,
              source,
            }),
          }),
        );
      }
    }
    let fat = t.number(it, 'bodyFat', c.bodyFat, { ...o, min: 0, minExclusive: true, max: 100 });
    if (fat !== undefined && fat <= 1) {
      fat = fat * 100;
      t.note('bodyFat', 'converted', 'fraction -> percent (value <= 1)', date);
    }
    if (fat !== undefined) {
      const v = round(fat, 1);
      if (v < 1 || v > 80) t.note('bodyFat', 'implausible', 'body fat outside 1-80 %', date);
      else out.push(bio('body_fat', date, v, { id, recordedAtMs }));
    }
  }
  return finish(t, dedupe(out, (b) => b.externalId));
}

// ---------------------------------------------------------------------------------------------------------------------
// activities
// ---------------------------------------------------------------------------------------------------------------------

/** 'strength_training' -> 'Strength training'. */
export function humanizeTypeKey(typeKey: string): string {
  const s = typeKey.replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Workout';
}

const LOCAL_TS = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/;

/**
 * The activity list. `startTimeLocal` ('YYYY-MM-DD HH:MM:SS', wall clock) decides the day; `startTimeGMT` (a GUESS: not in
 * the reference's structs) gives the real instant when it exists. Calories are the activity's own total (they are also
 * inside the day's active energy, so the app files a workout as informational).
 */
export function mapActivities(raw: unknown, options: { nowMs?: number } = {}): GarminMapResult<GarminWorkout> {
  const t = new FieldTracker('activities');
  const c = FIELD_CANDIDATES.activities;
  const out: GarminWorkout[] = [];
  const items = extractItems(raw, t, { keys: ['activityList', 'activities', 'data', 'items'], itemHints: ['activityId'] });
  for (const it of items) {
    t.item();
    const id = t.string(it, 'activityId', c.id);
    if (!id) {
      t.note('activityId', 'skipped', 'activity without an id');
      continue;
    }
    const startGmtMs = t.timestamp(it, 'startMs', c.startGmt, 'gmt', { optional: true });
    const localRaw = t.string(it, 'startTimeLocal', c.startLocal);
    let startLocal: string | undefined;
    const m = localRaw ? LOCAL_TS.exec(localRaw) : null;
    if (m) {
      startLocal = `${m[1]} ${m[2]}`;
    } else if (startGmtMs !== undefined) {
      // No usable local start: the UTC wall clock is the best available (the day can be off near midnight).
      startLocal = new Date(startGmtMs).toISOString().replace('T', ' ').slice(0, 19);
      t.note('startTimeLocal', 'fallback_used', 'startTimeLocal missing; used startTimeGMT as the wall clock');
    }
    const date = startLocal ? leadingYmd(startLocal) : null;
    if (!startLocal || !date) {
      t.note('startTimeLocal', 'skipped', 'activity without a usable start time');
      continue;
    }
    const pos = { min: 0, minExclusive: true, max: 7 * 86400, optional: true };
    const duration = t.number(it, 'durationSec', c.duration, pos);
    const elapsed = t.number(it, 'elapsedDuration', c.elapsed, pos);
    const moving = t.number(it, 'movingDuration', c.moving, pos);
    const durationSec = duration ?? elapsed ?? moving;
    if (durationSec === undefined) {
      t.note('durationSec', 'skipped', 'activity without a duration');
      continue;
    }
    const typeKey = t.string(it, 'typeKey', c.typeKey, { optional: true }) ?? 'unknown';
    const name = t.string(it, 'name', c.name, { optional: true }) ?? humanizeTypeKey(typeKey === 'unknown' ? '' : typeKey);
    const kcal = t.rounded(it, 'kcal', c.calories, { optional: true, min: 0, minExclusive: true, max: 20000, decimals: 0 });
    const distanceM = t.rounded(it, 'distanceM', c.distance, { optional: true, min: 0, minExclusive: true, max: 5_000_000, decimals: 1 });
    // Heart rate, time in zones and training effect come with the list itself: a "summary" level read at no extra request.
    const details = options.nowMs !== undefined ? detailsFromListItem(it, options.nowMs) : undefined;
    out.push({
      externalId: `garmin:activity:${id}`,
      name,
      typeKey,
      date,
      startLocal,
      ...(startGmtMs !== undefined ? { startMs: startGmtMs } : {}),
      durationSec: Math.round(durationSec),
      ...(kcal !== undefined ? { kcal } : {}),
      ...(distanceM !== undefined ? { distanceM } : {}),
      ...(details ? { details } : {}),
    });
  }
  return finish(t, dedupe(out, (w) => w.externalId));
}
