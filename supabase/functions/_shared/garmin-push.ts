/**
 * Garmin PUSH payload -> rows for the existing health tables (pure TypeScript: no Deno globals, no imports).
 *
 * Garmin POSTs, per user and per watch sync, a JSON document whose top-level keys are data kinds and whose values are
 * arrays of items:
 *
 *   { "dailies": [ { "userId": "...", "summaryId": "...", "calendarDate": "2026-11-10", ... } ],
 *     "sleeps": [ ... ], "deregistrations": [ { "userId": "..." } ] }
 *
 * UNVERIFIED: the exact kind names, item field names and shapes are NOT publicly documented for the Starter tier (the specs
 * sit behind Garmin's developer portal). Everything below is an educated guess that mirrors (a) the flat names of Garmin's
 * older Health API push format (activeKilocalories, bmrKilocalories, steps, restingHeartRateInBeatsPerMinute,
 * averageStressLevel, durationInSeconds, startTimeInSeconds, ...) and (b) the nested v2 shape that the Personal API
 * returned on a real account (calories.burnedActive, movement.steps.value, heartRate.restingValue, stress.avgLevel,
 * bodyBattery.maxValue, ...), see packages/garmin FIELD_CANDIDATES. Both are accepted; unknown kinds are stored raw
 * (trimmed) in private.garmin_push_events so the real format can be inspected after approval. Mirrored in
 * docs/garmin-integration.md ("TO CONFIRM AGAINST GARMIN'S DOCS AFTER APPROVAL").
 *
 * The row shapes and the biometric types/units/external ids match what packages/garmin and apps/app/src/health produce, so
 * rows de-duplicate against the existing sync (daily_energy primary key (user_id, local_date, source), partial unique
 * indexes (user_id, source, external_id)), with source = 'garmin' added by public.apply_garmin_health().
 */

type Obj = Record<string, unknown>;

export interface EnergyRow {
  local_date: string;
  active_kcal: number | null;
  resting_kcal: number | null;
  steps: number | null;
}

export interface ExerciseRow {
  entry_date: string;
  name: string;
  minutes: number;
  kcal: number;
  external_id: string;
  started_at: string;
  ended_at: string;
}

export type GarminBiometricType =
  | 'weight'
  | 'body_fat'
  | 'resting_heart_rate'
  | 'hrv'
  | 'spo2'
  | 'respiration_rate'
  | 'sleep'
  | 'body_battery'
  | 'stress';

export type BiometricMeta = Record<string, string | number | boolean>;

export interface BiometricRow {
  entry_date: string;
  type: GarminBiometricType;
  value: number;
  unit: string;
  external_id: string;
  /** ISO timestamp; also the "version" that stops an older push from overwriting a newer one. */
  recorded_at: string | null;
  meta: BiometricMeta;
}

export interface MappedHealth {
  energy: EnergyRow[];
  exercises: ExerciseRow[];
  biometrics: BiometricRow[];
  /** Why something was skipped (no secrets, no values); shown in logs and stored on the push event. */
  notes: string[];
}

/** Units exactly as packages/garmin GARMIN_BIOMETRIC_UNITS. */
export const BIOMETRIC_UNITS: Record<GarminBiometricType, string> = {
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

export const emptyMapped = (): MappedHealth => ({
  energy: [],
  exercises: [],
  biometrics: [],
  notes: [],
});

export function hasRows(m: MappedHealth): boolean {
  return m.energy.length > 0 || m.exercises.length > 0 || m.biometrics.length > 0;
}

export function mergeMapped(list: readonly MappedHealth[]): MappedHealth {
  const out = emptyMapped();
  for (const m of list) {
    out.energy.push(...m.energy);
    out.exercises.push(...m.exercises);
    out.biometrics.push(...m.biometrics);
    out.notes.push(...m.notes);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------------------------------------------------

/** Kinds this module turns into rows. Everything else is stored raw and ignored. */
export const MAPPED_KINDS = [
  'dailies',
  'sleeps',
  'activities',
  'stressDetails',
  'bodyComps',
  'hrv',
] as const;
export type MappedKind = (typeof MAPPED_KINDS)[number];

/** Lower-case alias -> canonical kind. UNVERIFIED: the new program may use other names than the old Health API. */
const KIND_ALIASES: Record<string, string> = {
  dailies: 'dailies',
  daily: 'dailies',
  dailysummaries: 'dailies',
  dailysummary: 'dailies',
  sleeps: 'sleeps',
  sleep: 'sleeps',
  sleepsummaries: 'sleeps',
  activities: 'activities',
  activitysummaries: 'activities',
  stressdetails: 'stressDetails',
  stress: 'stressDetails',
  bodycomps: 'bodyComps',
  bodycompositions: 'bodyComps',
  weights: 'bodyComps',
  weight: 'bodyComps',
  hrv: 'hrv',
  hrvsummaries: 'hrv',
  deregistrations: 'deregistrations',
  deregistration: 'deregistrations',
};

export function canonicalKind(key: string): string {
  return KIND_ALIASES[key.toLowerCase()] ?? key;
}

export function isMappedKind(kind: string): kind is MappedKind {
  return (MAPPED_KINDS as readonly string[]).includes(kind);
}

export interface PushItem {
  /** Canonical kind (or the raw top-level key for kinds this module does not know). */
  kind: string;
  /** Garmin's user id (`userId`). null when the item has none. */
  garminUserId: string | null;
  /** `userAccessToken` when present (old Health API pushes carried it). UNVERIFIED for OAuth2. */
  accessToken: string | null;
  summaryId: string | null;
  raw: Obj;
}

export interface Deregistration {
  garminUserId: string | null;
  accessToken: string | null;
}

export interface ExtractedPush {
  items: PushItem[];
  deregistrations: Deregistration[];
  /** Entries that were not objects, and top-level keys whose value was not an array. */
  skipped: number;
}

export const isObject = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const stringOrNull = (v: unknown): string | null => {
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
};

const USER_ID_KEYS = ['userId', 'garminUserId', 'userid', 'user_id'];

function firstString(o: Obj, keys: readonly string[]): string | null {
  for (const k of keys) {
    const s = stringOrNull(o[k]);
    if (s !== null) return s;
  }
  return null;
}

/** Splits a push body into items (one per array entry) and deregistration notices. Never throws. */
export function extractPushItems(body: unknown): ExtractedPush {
  const out: ExtractedPush = { items: [], deregistrations: [], skipped: 0 };
  if (!isObject(body)) {
    out.skipped += 1;
    return out;
  }
  for (const [key, value] of Object.entries(body)) {
    const kind = canonicalKind(key);
    const list = Array.isArray(value) ? value : null;
    if (!list) {
      out.skipped += 1;
      continue;
    }
    for (const entry of list) {
      if (!isObject(entry)) {
        out.skipped += 1;
        continue;
      }
      const garminUserId = firstString(entry, USER_ID_KEYS);
      const accessToken = stringOrNull(entry.userAccessToken);
      if (kind === 'deregistrations') {
        out.deregistrations.push({ garminUserId, accessToken });
      } else {
        out.items.push({
          kind,
          garminUserId,
          accessToken,
          summaryId: stringOrNull(entry.summaryId),
          raw: entry,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tolerant pickers (same idea as packages/garmin: several candidate names, dotted paths, numeric strings)
// ---------------------------------------------------------------------------------------------------------------------

function resolve(obj: unknown, path: string): unknown {
  if (!isObject(obj)) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
  if (!path.includes('.')) return undefined;
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (!isObject(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

export function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

interface Range {
  min?: number;
  max?: number;
  /** value must be > min (not >=) */
  exclusive?: boolean;
}

function inRange(n: number, r: Range): boolean {
  if (r.min !== undefined && (r.exclusive ? n <= r.min : n < r.min)) return false;
  if (r.max !== undefined && n > r.max) return false;
  return true;
}

/** First candidate with a usable, in-range number; an out-of-range value is skipped like a missing one. */
function num(obj: unknown, names: readonly string[], range: Range = {}): number | undefined {
  for (const name of names) {
    const n = toNumber(resolve(obj, name));
    if (n !== undefined && inRange(n, range)) return n;
  }
  return undefined;
}

function str(obj: unknown, names: readonly string[]): string | undefined {
  for (const name of names) {
    const v = resolve(obj, name);
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

const round = (n: number, digits = 0): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

// ---------------------------------------------------------------------------------------------------------------------
// Dates and times
// ---------------------------------------------------------------------------------------------------------------------

/** 'YYYY-MM-DD' (or a string starting with it) when it is a real calendar day. */
export function toYmd(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  if (!m) return undefined;
  const ymd = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === ymd ? ymd : undefined;
}

/** Epoch seconds from a number/numeric string; milliseconds (>= 1e11) are tolerated and converted. */
export function toEpochSec(v: unknown): number | undefined {
  const n = toNumber(v);
  if (n === undefined || n <= 0) return undefined;
  return n >= 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}

/** Local calendar day of an instant: epoch seconds plus the user's UTC offset in seconds (Garmin's *OffsetInSeconds). */
export function localDateOf(epochSec: number, offsetSec = 0): string {
  return new Date((epochSec + offsetSec) * 1000).toISOString().slice(0, 10);
}

const isoOfSec = (sec: number): string => new Date(sec * 1000).toISOString();

interface Window {
  startSec?: number;
  offsetSec: number;
  durationSec?: number;
  endSec?: number;
}

function windowOf(item: Obj): Window {
  const startSec = toEpochSec(resolve(item, 'startTimeInSeconds'));
  const offsetSec =
    num(item, [
      'startTimeOffsetInSeconds',
      'measurementTimeOffsetInSeconds',
      'timeOffsetInSeconds',
    ]) ?? 0;
  const durationSec = num(item, ['durationInSeconds', 'duration'], { min: 0 });
  const endSec =
    startSec !== undefined && durationSec !== undefined
      ? startSec + Math.floor(durationSec)
      : startSec;
  return { startSec, offsetSec, durationSec, endSec };
}

/** calendarDate if present, else the local day of the item's start. */
function itemDate(item: Obj, w: Window): string | undefined {
  const cd = toYmd(
    resolve(item, 'calendarDate') ?? resolve(item, 'summaryDate') ?? resolve(item, 'date'),
  );
  if (cd) return cd;
  return w.startSec !== undefined ? localDateOf(w.startSec, w.offsetSec) : undefined;
}

const recordedAt = (w: Window): string | null =>
  w.endSec !== undefined ? isoOfSec(w.endSec) : null;

function bio(
  type: GarminBiometricType,
  date: string,
  value: number,
  at: string | null,
  meta: BiometricMeta = {},
  idSuffix?: string,
): BiometricRow {
  return {
    entry_date: date,
    type,
    value,
    unit: BIOMETRIC_UNITS[type],
    external_id: `garmin:${type}:${date}${idSuffix ? `:${idSuffix}` : ''}`,
    recorded_at: at,
    meta,
  };
}

function cleanMeta(entries: Record<string, string | number | boolean | undefined>): BiometricMeta {
  const out: BiometricMeta = {};
  for (const [k, v] of Object.entries(entries)) if (v !== undefined) out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// dailies  ->  daily_energy (+ resting HR, stress, body battery)
// ---------------------------------------------------------------------------------------------------------------------

const F = {
  activeKcal: ['activeKilocalories', 'calories.burnedActive', 'activeKcal', 'activeCalories'],
  restingKcal: [
    'bmrKilocalories',
    'calories.burnedResting',
    'restingKilocalories',
    'restingKcal',
    'bmrKcal',
  ],
  totalKcal: ['totalKilocalories', 'calories.burnedTotal', 'totalKcal', 'totalCalories'],
  steps: ['steps', 'movement.steps.value', 'totalSteps'],
  restingHr: ['restingHeartRateInBeatsPerMinute', 'heartRate.restingValue', 'restingHeartRate'],
  stress: ['averageStressLevel', 'stress.avgLevel', 'avgStressLevel', 'overallStressLevel'],
  bbHigh: ['bodyBattery.maxValue', 'bodyBatteryHighestValue', 'bodyBatteryHighestLevel'],
  bbLow: ['bodyBattery.minValue', 'bodyBatteryLowestValue', 'bodyBatteryLowestLevel'],
  bbLatest: ['bodyBattery.latestValue', 'bodyBatteryMostRecentValue', 'bodyBatteryMostRecentLevel'],
  bbCharged: ['bodyBattery.chargedValue', 'bodyBatteryChargedValue'],
  bbDrained: ['bodyBattery.drainedValue', 'bodyBatteryDrainedValue'],
} as const;

const KCAL: Range = { min: 0, max: 20000, exclusive: true };

/**
 * A dailies push is CUMULATIVE for its calendar day and arrives many times a day. The energy row therefore carries the
 * values as they are (never a delta): apply_garmin_health() upserts them with GREATEST() so repeated or out-of-order
 * pushes can neither add up nor roll back. A value that is 0 or absent stays null ("unknown", never a fake 0).
 */
export function mapDailies(item: Obj): MappedHealth {
  const out = emptyMapped();
  const w = windowOf(item);
  const date = itemDate(item, w);
  if (!date) {
    out.notes.push('dailies: no calendarDate / start time');
    return out;
  }
  const at = recordedAt(w);

  let active = num(item, F.activeKcal, KCAL);
  let resting = num(item, F.restingKcal, KCAL);
  const total = num(item, F.totalKcal, KCAL);
  const steps = num(item, F.steps, { min: 0, max: 200000, exclusive: true });
  if (resting === undefined && total !== undefined && active !== undefined && total > active)
    resting = total - active;
  if (active === undefined && total !== undefined && resting !== undefined && total > resting)
    active = total - resting;
  if (active !== undefined || resting !== undefined || steps !== undefined) {
    out.energy.push({
      local_date: date,
      active_kcal: active !== undefined ? round(active) : null,
      resting_kcal: resting !== undefined ? round(resting) : null,
      steps: steps !== undefined ? Math.round(steps) : null,
    });
  }

  const restingHr = num(item, F.restingHr, { min: 25, max: 220 });
  if (restingHr !== undefined)
    out.biometrics.push(bio('resting_heart_rate', date, round(restingHr), at));

  // Garmin reports -1 / -2 when the stress level could not be measured: the range check drops those.
  const stress = num(item, F.stress, { min: 1, max: 100 });
  if (stress !== undefined) out.biometrics.push(bio('stress', date, round(stress), at));

  // Nested v2 shape only: the flat Health API dailies have no daily high/low (only charged/drained).
  const high = num(item, F.bbHigh, { min: 0, max: 100, exclusive: true });
  if (high !== undefined) {
    const low = num(item, F.bbLow, { min: 0, max: 100 });
    const latest = num(item, F.bbLatest, { min: 0, max: 100 });
    const charged = num(item, F.bbCharged, { min: 0, max: 300 });
    const drained = num(item, F.bbDrained, { min: 0, max: 300 });
    out.biometrics.push(
      bio(
        'body_battery',
        date,
        Math.round(high),
        at,
        cleanMeta({
          high: Math.round(high),
          low: low !== undefined ? Math.round(low) : undefined,
          latest: latest !== undefined ? Math.round(latest) : undefined,
          charged: charged !== undefined ? Math.round(charged) : undefined,
          drained: drained !== undefined ? Math.round(drained) : undefined,
        }),
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// sleeps  ->  biometrics 'sleep' (hours), night SpO2 / respiration averages
// ---------------------------------------------------------------------------------------------------------------------

const S = {
  total: ['sleepTimeSeconds', 'totalSleepSeconds', 'sleepSeconds'],
  deep: ['deepSleepDurationInSeconds', 'deepSleepSeconds'],
  light: ['lightSleepDurationInSeconds', 'lightSleepSeconds'],
  rem: ['remSleepInSeconds', 'remSleepDurationInSeconds', 'remSleepSeconds'],
  awake: ['awakeDurationInSeconds', 'awakeSleepSeconds'],
  unmeasurable: ['unmeasurableSleepDurationInSeconds', 'unmeasurableSleepInSeconds'],
  score: [
    'overallSleepScore.value',
    'sleepScores.overall.value',
    'sleepScores.overall.score',
    'sleepScore',
    'overallSleepScore',
  ],
  spo2: ['averageSpO2Value', 'averageSpo2Value', 'avgSpO2'],
  respiration: ['averageRespirationValue', 'avgRespirationValue'],
} as const;

/** Average of the numeric values of an `{ "<offsetSec>": value }` map (Garmin's timeOffset* samples). */
function averageOfMap(
  map: unknown,
  range: Range,
): { avg: number; min: number; count: number } | undefined {
  if (!isObject(map)) return undefined;
  let sum = 0;
  let count = 0;
  let min = Infinity;
  for (const v of Object.values(map)) {
    const n = toNumber(v);
    if (n === undefined || !inRange(n, range)) continue;
    sum += n;
    count += 1;
    if (n < min) min = n;
  }
  return count > 0 ? { avg: sum / count, min, count } : undefined;
}

export function mapSleeps(item: Obj): MappedHealth {
  const out = emptyMapped();
  const w = windowOf(item);
  // Garmin's calendarDate of a sleep is the day it ENDED, which is also the app's convention ("night ending on D").
  const date = itemDate(item, w);
  if (!date) {
    out.notes.push('sleeps: no calendarDate / start time');
    return out;
  }
  const sec: Range = { min: 0, max: 86400 };
  const deep = num(item, S.deep, sec);
  const light = num(item, S.light, sec);
  const rem = num(item, S.rem, sec);
  const awake = num(item, S.awake, sec);
  const unmeasurable = num(item, S.unmeasurable, sec);

  let asleepSec = num(item, S.total, { min: 0, max: 86400, exclusive: true });
  let approx = false;
  if (asleepSec === undefined && (deep !== undefined || light !== undefined || rem !== undefined)) {
    const sum = (deep ?? 0) + (light ?? 0) + (rem ?? 0);
    if (sum > 0) asleepSec = sum;
  }
  if (asleepSec === undefined && w.durationSec !== undefined && w.durationSec > 0) {
    // Only the length of the whole sleep period is known: remove awake / unmeasurable time when reported.
    asleepSec = Math.max(0, w.durationSec - (awake ?? 0) - (unmeasurable ?? 0));
    approx = true;
  }
  const at = recordedAt(w);
  const endMs = w.endSec !== undefined ? w.endSec * 1000 : undefined;

  if (asleepSec !== undefined) {
    const hours = round(asleepSec / 3600, 2);
    if (hours >= 0.1 && hours <= 24) {
      const score = num(item, S.score, { min: 0, max: 100 });
      out.biometrics.push(
        bio(
          'sleep',
          date,
          hours,
          at,
          cleanMeta({
            deepMin: deep !== undefined ? Math.round(deep / 60) : undefined,
            lightMin: light !== undefined ? Math.round(light / 60) : undefined,
            remMin: rem !== undefined ? Math.round(rem / 60) : undefined,
            awakeMin: awake !== undefined ? Math.round(awake / 60) : undefined,
            score: score !== undefined ? Math.round(score) : undefined,
            startMs: w.startSec !== undefined ? w.startSec * 1000 : undefined,
            endMs,
            approx: approx ? true : undefined,
          }),
        ),
      );
    } else {
      out.notes.push('sleeps: implausible duration');
    }
  } else {
    out.notes.push('sleeps: no sleep duration');
  }

  // Night-time SpO2 / respiration (flat: sample maps; nested: averages). Same ids as the pull mapper's daily values.
  const spo2Map = averageOfMap(resolve(item, 'timeOffsetSleepSpo2'), { min: 50, max: 100 });
  const spo2 = spo2Map ? spo2Map.avg : num(item, S.spo2, { min: 50, max: 100 });
  if (spo2 !== undefined) {
    out.biometrics.push(
      bio(
        'spo2',
        date,
        round(spo2, 1),
        at,
        cleanMeta({ source: 'sleep', low: spo2Map ? round(spo2Map.min, 1) : undefined }),
      ),
    );
  }
  const respMap = averageOfMap(resolve(item, 'timeOffsetSleepRespiration'), { min: 3, max: 60 });
  const resp = respMap ? respMap.avg : num(item, S.respiration, { min: 3, max: 60 });
  if (resp !== undefined) {
    out.biometrics.push(
      bio('respiration_rate', date, round(resp, 1), at, cleanMeta({ source: 'sleep' })),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// activities  ->  exercise_entries (informational: counts_toward_energy = false is set by the RPC)
// ---------------------------------------------------------------------------------------------------------------------

const KEY_NAMES: Record<string, string> = {
  HIGH_INTENSITY_INTERVAL_TRAINING: 'HIIT',
  STRENGTH_TRAINING: 'Strength training',
  BIKING: 'Cycling',
  BIKING_STATIONARY: 'Cycling (stationary)',
  RUNNING_TREADMILL: 'Running (treadmill)',
  LAP_SWIMMING: 'Swimming (pool)',
  OPEN_WATER_SWIMMING: 'Swimming (open water)',
  INDOOR_CARDIO: 'Indoor cardio',
  OTHER: 'Workout',
};

/** 'ROCK_CLIMBING' / 'rock_climbing' / 'rockClimbing' -> 'Rock climbing'. */
export function humanizeActivityType(key: string | undefined): string {
  if (!key) return 'Workout';
  const mapped = KEY_NAMES[key.toUpperCase()];
  if (mapped) return mapped;
  const words = key.includes('_')
    ? key.toLowerCase().split('_')
    : key
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(' ');
  const text = words.filter(Boolean).join(' ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Workout';
}

export function mapActivity(item: Obj): MappedHealth {
  const out = emptyMapped();
  const w = windowOf(item);
  if (w.startSec === undefined) {
    out.notes.push('activities: no start time');
    return out;
  }
  const idPart = stringOrNull(item.activityId) ?? stringOrNull(item.summaryId);
  if (!idPart) {
    out.notes.push('activities: no activityId / summaryId');
    return out;
  }
  if (w.durationSec === undefined || w.durationSec <= 0 || w.durationSec > 7 * 86400) {
    out.notes.push('activities: no usable duration');
    return out;
  }
  // `manual` activities are user-entered in Garmin Connect; they are still the user's own data, so they are kept.
  const kcal = num(
    item,
    ['activeKilocalories', 'calories', 'totalKilocalories', 'caloriesBurned'],
    { min: 0, max: 20000, exclusive: true },
  );
  const typeKey = str(item, ['activityType', 'activityType.typeKey', 'typeKey']);
  const name = str(item, ['activityName', 'name']) ?? humanizeActivityType(typeKey);
  out.exercises.push({
    entry_date: localDateOf(w.startSec, w.offsetSec),
    name: name.slice(0, 120),
    minutes: round(w.durationSec / 60, 1),
    kcal: kcal !== undefined ? round(kcal) : 0,
    // Same id scheme as packages/garmin's pull mapper, so a later pull/backfill de-duplicates against pushes.
    external_id: `garmin:activity:${idPart}`,
    started_at: isoOfSec(w.startSec),
    ended_at: isoOfSec(w.startSec + Math.floor(w.durationSec)),
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// stressDetails  ->  body battery (day high / low / latest from the time-offset samples)
// ---------------------------------------------------------------------------------------------------------------------

export function mapStressDetails(item: Obj): MappedHealth {
  const out = emptyMapped();
  const w = windowOf(item);
  const date = itemDate(item, w);
  if (!date) {
    out.notes.push('stressDetails: no calendarDate / start time');
    return out;
  }
  const map = resolve(item, 'timeOffsetBodyBatteryValues');
  if (!isObject(map)) {
    out.notes.push('stressDetails: no body battery samples');
    return out;
  }
  const samples: Array<{ offset: number; level: number }> = [];
  for (const [k, v] of Object.entries(map)) {
    const level = toNumber(v);
    const offset = toNumber(k);
    if (level === undefined || offset === undefined || level < 0 || level > 100) continue;
    samples.push({ offset, level });
  }
  if (samples.length === 0) {
    out.notes.push('stressDetails: body battery samples unusable');
    return out;
  }
  samples.sort((a, b) => a.offset - b.offset);
  const levels = samples.map((s) => s.level);
  const high = Math.max(...levels);
  const low = Math.min(...levels);
  const latest = samples[samples.length - 1]!.level;
  if (high <= 0) return out;
  out.biometrics.push(
    bio('body_battery', date, Math.round(high), recordedAt(w), {
      high: Math.round(high),
      low: Math.round(low),
      latest: Math.round(latest),
      samples: samples.length,
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// bodyComps  ->  weight (kg) + body fat (percent)
// ---------------------------------------------------------------------------------------------------------------------

export function mapBodyComps(item: Obj): MappedHealth {
  const out = emptyMapped();
  const measuredSec = toEpochSec(
    resolve(item, 'measurementTimeInSeconds') ?? resolve(item, 'startTimeInSeconds'),
  );
  const offsetSec = num(item, ['measurementTimeOffsetInSeconds', 'startTimeOffsetInSeconds']) ?? 0;
  const date =
    toYmd(resolve(item, 'calendarDate')) ??
    (measuredSec !== undefined ? localDateOf(measuredSec, offsetSec) : undefined);
  if (!date) {
    out.notes.push('bodyComps: no date');
    return out;
  }
  const at = measuredSec !== undefined ? isoOfSec(measuredSec) : null;
  const suffix = measuredSec !== undefined ? String(measuredSec * 1000) : undefined;

  const grams = num(item, ['weightInGrams', 'weightGrams', 'weight'], { min: 0, exclusive: true });
  if (grams !== undefined) {
    // weightInGrams is grams; a plain `weight` below 1000 can only be kg (same heuristic as the pull mapper).
    const kg = grams > 1000 ? grams / 1000 : grams;
    if (kg >= 20 && kg <= 400) {
      const bmi = num(item, ['bodyMassIndex', 'bmi'], { min: 5, max: 100 });
      const muscle = num(item, ['muscleMassInGrams'], { min: 0, exclusive: true });
      const bone = num(item, ['boneMassInGrams'], { min: 0, exclusive: true });
      const water = num(item, ['bodyWaterInPercent', 'bodyWater'], { min: 0, max: 100 });
      out.biometrics.push(
        bio(
          'weight',
          date,
          round(kg, 3),
          at,
          cleanMeta({
            bmi: bmi !== undefined ? round(bmi, 1) : undefined,
            muscleMassKg: muscle !== undefined ? round(muscle / 1000, 2) : undefined,
            boneMassKg: bone !== undefined ? round(bone / 1000, 2) : undefined,
            bodyWaterPct: water !== undefined ? round(water, 1) : undefined,
          }),
          suffix,
        ),
      );
    } else {
      out.notes.push('bodyComps: implausible weight');
    }
  }
  let fat = num(item, ['bodyFatInPercent', 'bodyFat', 'bodyFatPercentage'], {
    min: 0,
    max: 100,
    exclusive: true,
  });
  if (fat !== undefined && fat <= 1) fat *= 100; // a fraction
  if (fat !== undefined && fat >= 1 && fat <= 80) {
    out.biometrics.push(bio('body_fat', date, round(fat, 1), at, {}, suffix));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// hrv  ->  biometrics 'hrv' (last night's average, ms)
// ---------------------------------------------------------------------------------------------------------------------

export function mapHrv(item: Obj): MappedHealth {
  const out = emptyMapped();
  const w = windowOf(item);
  const date = itemDate(item, w);
  if (!date) {
    out.notes.push('hrv: no calendarDate / start time');
    return out;
  }
  const value = num(
    item,
    ['lastNightAvg', 'lastNight', 'avgOvernightHrv', 'hrvSummary.lastNightAvg'],
    { min: 0, max: 500, exclusive: true },
  );
  if (value === undefined) {
    out.notes.push('hrv: no lastNightAvg');
    return out;
  }
  const peak = num(item, ['lastNight5MinHigh', 'hrvSummary.lastNight5MinHigh'], {
    min: 0,
    max: 800,
  });
  const weekly = num(item, ['weeklyAvg', 'hrvSummary.weeklyAvg'], { min: 0, max: 500 });
  const status = str(item, ['status', 'hrvStatus', 'hrvSummary.status']);
  out.biometrics.push(
    bio(
      'hrv',
      date,
      round(value),
      recordedAt(w),
      cleanMeta({
        peak: peak !== undefined ? round(peak) : undefined,
        weeklyAvg: weekly !== undefined ? round(weekly) : undefined,
        status,
      }),
    ),
  );
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------------------------------------------------

/** Maps one push item of a canonical kind. Never throws; unknown kinds give no rows. */
export function mapPushItem(kind: string, item: Obj): MappedHealth {
  try {
    switch (kind) {
      case 'dailies':
        return mapDailies(item);
      case 'sleeps':
        return mapSleeps(item);
      case 'activities':
        return mapActivity(item);
      case 'stressDetails':
        return mapStressDetails(item);
      case 'bodyComps':
        return mapBodyComps(item);
      case 'hrv':
        return mapHrv(item);
      default:
        return emptyMapped();
    }
  } catch {
    const m = emptyMapped();
    m.notes.push(`${kind}: mapping failed`);
    return m;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Buffering helpers
// ---------------------------------------------------------------------------------------------------------------------

export interface TrimOptions {
  /** Objects / arrays with more entries than this keep only a few samples (default 24). */
  maxEntries?: number;
  maxDepth?: number;
  maxString?: number;
  /** Serialised size above which only the key list survives (default 60 000 characters). */
  maxChars?: number;
}

/**
 * Shrinks a raw push item before it is buffered in private.garmin_push_events: Garmin's sample maps (heart rate every
 * 15 s, stress / body battery curves, ...) can be 100 KB per push and a day is pushed dozens of times, which would eat the
 * free 500 MB. The structure (keys, a few sample values, the original entry count) stays visible for debugging the format.
 */
export function trimPayload(value: unknown, opts: TrimOptions = {}): unknown {
  const maxEntries = opts.maxEntries ?? 24;
  const maxDepth = opts.maxDepth ?? 6;
  const maxString = opts.maxString ?? 300;
  const maxChars = opts.maxChars ?? 60_000;

  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return v.length > maxString ? `${v.slice(0, maxString)}…` : v;
    if (v === null || typeof v !== 'object') return v;
    if (depth >= maxDepth) return { _trimmed: Array.isArray(v) ? 'array' : 'object' };
    if (Array.isArray(v)) {
      if (v.length <= maxEntries) return v.map((x) => walk(x, depth + 1));
      return {
        _trimmed: 'array',
        length: v.length,
        sample: v.slice(0, 3).map((x) => walk(x, depth + 1)),
      };
    }
    const entries = Object.entries(v as Obj);
    if (entries.length <= maxEntries) {
      return Object.fromEntries(entries.map(([k, x]) => [k, walk(x, depth + 1)]));
    }
    return {
      _trimmed: 'object',
      entries: entries.length,
      sample: Object.fromEntries(entries.slice(0, 3).map(([k, x]) => [k, walk(x, depth + 1)])),
    };
  };

  const trimmed = walk(value, 0);
  const json = JSON.stringify(trimmed) ?? '';
  if (json.length <= maxChars) return trimmed;
  return {
    _trimmed: 'payload',
    chars: json.length,
    keys: isObject(value) ? Object.keys(value).slice(0, 60) : [],
  };
}
