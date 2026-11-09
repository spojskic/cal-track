// Tolerant mappers: raw Garmin JSON -> normalized shapes + diagnostics.
//
// Response shapes of the Personal API are LARGELY UNVERIFIED (no key was available when this was written). The mappers
// therefore try several candidate field names per value (see FIELD_CANDIDATES), accept numbers or numeric strings,
// unwrap `{data: [...]}` / bare arrays / single objects / null, and NEVER throw on unexpected input. Anything missing,
// ignored or converted is reported in `diagnostics`; per-field hit statistics are reported in `coverage`.

import { leadingYmd, toDayNumber, utcDateOf } from './dates';
import type {
  GarminBiometric,
  GarminBiometricType,
  GarminDailyEnergy,
  GarminDiagnostic,
  GarminDiagnosticReason,
  GarminFieldCoverage,
  GarminMap,
  GarminMapResult,
  GarminMeta,
  GarminWorkout,
} from './normalized';
import { GARMIN_BIOMETRIC_UNITS } from './normalized';

type Obj = Record<string, unknown>;

export function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})`;
  return typeof v;
}

// ---------------------------------------------------------------------------------------------------------------------
// Field-name assumptions. EVERYTHING in here is a guess to be confirmed against real data (see tools/garmin-probe).
// ---------------------------------------------------------------------------------------------------------------------

export const FIELD_CANDIDATES = {
  userSettings: {
    displayName: ['displayName', 'userName', 'fullName', 'userData.displayName', 'profile.displayName'],
    timeZone: ['timeZone', 'timezone', 'userData.timeZone', 'userData.timezone'],
    measurementSystem: ['measurementSystem', 'userData.measurementSystem'],
  },
  dailySummaries: {
    date: ['calendarDate', 'date', 'summaryDate'],
    dateFallback: ['wellnessStartTimeLocal', 'startTimeLocal'],
    activeKcal: ['activeKilocalories', 'activeKcal', 'activeCalories'],
    restingKcal: ['bmrKilocalories', 'restingKilocalories', 'restingKcal', 'bmrKcal', 'bmrCalories'],
    totalKcal: ['totalKilocalories', 'totalKcal', 'totalCalories'],
    steps: ['totalSteps', 'steps'],
    restingHr: ['restingHeartRate', 'restingHeartRateInBeatsPerMinute', 'restingHR'],
    minHr: ['minHeartRate', 'minHR'],
    maxHr: ['maxHeartRate', 'maxHR'],
    stress: ['averageStressLevel', 'avgStressLevel', 'overallStressLevel'],
    bodyBatteryHigh: ['bodyBatteryHighestValue', 'bodyBatteryHighestLevel', 'highestBodyBattery'],
    bodyBatteryLow: ['bodyBatteryLowestValue', 'bodyBatteryLowestLevel', 'lowestBodyBattery'],
    bodyBatteryLatest: ['bodyBatteryMostRecentValue', 'bodyBatteryMostRecentLevel'],
    bodyBatteryCharged: ['bodyBatteryChargedValue', 'bodyBatteryCharged'],
    bodyBatteryDrained: ['bodyBatteryDrainedValue', 'bodyBatteryDrained'],
    respiration: ['avgWakingRespirationValue', 'averageRespirationValue', 'avgRespirationValue', 'respirationRate'],
    spo2: ['averageSpo2', 'averageSpO2Value', 'avgSpo2', 'spo2Average'],
    spo2Low: ['lowestSpo2', 'lowestSpO2Value'],
  },
  sleep: {
    date: ['calendarDate', 'date', 'sleepDate'],
    totalSec: ['sleepTimeSeconds', 'totalSleepSeconds', 'sleepSeconds'],
    deepSec: ['deepSleepSeconds'],
    lightSec: ['lightSleepSeconds'],
    remSec: ['remSleepSeconds'],
    awakeSec: ['awakeSleepSeconds'],
    startGmt: ['sleepStartTimestampGMT', 'sleepStartTimeGMT'],
    endGmt: ['sleepEndTimestampGMT', 'sleepEndTimeGMT'],
    score: [
      'sleepScores.overall.value',
      'sleepScores.overall.score',
      'sleepScores.overallScore',
      'sleepScore',
      'overallSleepScore',
    ],
    spo2: ['averageSpO2Value', 'averageSpo2Value', 'avgSpO2'],
    spo2Low: ['lowestSpO2Value', 'lowestSpo2Value'],
    respiration: ['averageRespirationValue', 'avgRespirationValue'],
  },
  hrv: {
    date: ['calendarDate', 'date'],
    lastNight: ['lastNightAvg', 'lastNight', 'avgOvernightHrv', 'overnightAvg'],
    weeklyAvg: ['weeklyAvg', 'weeklyAverage'],
    peak: ['lastNight5MinHigh', 'peak5MinHigh'],
    status: ['status', 'hrvStatus'],
    baselineLow: ['baseline.balancedLow'],
    baselineHigh: ['baseline.balancedUpper'],
  },
  weight: {
    date: ['calendarDate', 'summaryDate'],
    weight: ['weight', 'weightInGrams', 'weightGrams', 'bodyWeight'],
    bodyFat: ['bodyFat', 'bodyFatPercentage', 'bodyFatPercent'],
    bmi: ['bmi'],
    muscleMass: ['muscleMass'],
    boneMass: ['boneMass'],
    bodyWater: ['bodyWater', 'bodyWaterPercentage'],
    recordedAt: ['timestampGMT', 'timestampGmt'],
    sourceType: ['sourceType'],
  },
  bodyBattery: {
    date: ['date', 'calendarDate'],
    dateFallback: ['startTimestampLocal'],
    charged: ['charged'],
    drained: ['drained'],
    values: ['bodyBatteryValuesArray', 'bodyBatteryValues'],
    descriptors: ['bodyBatteryValueDescriptorDTOList', 'bodyBatteryValueDescriptors'],
  },
  heartRateDay: {
    date: ['calendarDate', 'date'],
    restingHr: ['restingHeartRate'],
    minHr: ['minHeartRate'],
    maxHr: ['maxHeartRate'],
    sevenDayAvg: ['lastSevenDaysAvgRestingHeartRate'],
  },
  spo2Day: {
    date: ['calendarDate', 'date'],
    average: ['averageSpO2', 'averageSpo2', 'avgSpO2'],
    lowest: ['lowestSpO2', 'lowestSpo2'],
    latest: ['latestSpO2', 'latestSpo2'],
    sleepAvg: ['avgSleepSpO2', 'avgSleepSpo2'],
  },
  steps: {
    date: ['calendarDate', 'date'],
    steps: ['totalSteps', 'steps'],
  },
  stress: {
    date: ['calendarDate', 'date'],
    value: [
      'values.overallStressLevel',
      'overallStressLevel',
      'values.avgStressLevel',
      'values.averageStressLevel',
      'avgStressLevel',
      'averageStressLevel',
    ],
  },
  activities: {
    id: ['activityId', 'id'],
    name: ['activityName', 'name'],
    startGmt: ['startTimeGMT', 'startTimeGmt'],
    startLocal: ['startTimeLocal'],
    typeKey: ['activityType.typeKey', 'activityTypeDTO.typeKey', 'typeKey', 'activityType'],
    distance: ['distance'],
    duration: ['duration'],
    elapsed: ['elapsedDuration'],
    moving: ['movingDuration'],
    calories: ['calories', 'totalCalories', 'activeKilocalories', 'caloriesBurned'],
  },
} as const;

// ---------------------------------------------------------------------------------------------------------------------
// Low-level pickers
// ---------------------------------------------------------------------------------------------------------------------

interface Resolved {
  value: unknown;
  /** The key (or dotted path) as it actually appears in the JSON. */
  key: string;
}

function ownKey(o: Obj, key: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(o, key)) return key;
  const lower = key.toLowerCase();
  for (const k of Object.keys(o)) if (k.toLowerCase() === lower) return k;
  return undefined;
}

/** Resolves a name or dotted path (case-insensitive fallback per segment). Null/undefined/'' count as absent. */
function resolve(obj: unknown, path: string): Resolved | undefined {
  if (!isObject(obj)) return undefined;
  const direct = ownKey(obj, path);
  if (direct !== undefined) {
    const v = obj[direct];
    return v === null || v === undefined || v === '' ? undefined : { value: v, key: direct };
  }
  if (!path.includes('.')) return undefined;
  let cur: unknown = obj;
  const actual: string[] = [];
  for (const seg of path.split('.')) {
    if (!isObject(cur)) return undefined;
    const k = ownKey(cur, seg);
    if (k === undefined) return undefined;
    actual.push(k);
    cur = cur[k];
  }
  return cur === null || cur === undefined || cur === '' ? undefined : { value: cur, key: actual.join('.') };
}

/** A finite number from a number or a numeric string. Booleans, NaN, Infinity and '' give undefined. */
export function toFiniteNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    let s = v.trim();
    if (s === '') return undefined;
    if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function toNonEmptyString(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? undefined : t;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/** First candidate name (or dotted path) whose value is a usable number; undefined when none. */
export function pickNumber(obj: unknown, names: readonly string[]): number | undefined {
  for (const name of names) {
    const r = resolve(obj, name);
    if (r) {
      const n = toFiniteNumber(r.value);
      if (n !== undefined) return n;
    }
  }
  return undefined;
}

/** First candidate name (or dotted path) whose value is a non-empty string (numbers are stringified). */
export function pickString(obj: unknown, names: readonly string[]): string | undefined {
  for (const name of names) {
    const r = resolve(obj, name);
    if (r) {
      const s = toNonEmptyString(r.value);
      if (s !== undefined) return s;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Timestamps and units
// ---------------------------------------------------------------------------------------------------------------------

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * Parses a Garmin timestamp to epoch milliseconds.
 *  - strings like '2026-11-09 06:30:00', '2026-11-09T06:30:00.0Z', '...+01:00' (an explicit offset is honoured);
 *  - numbers / numeric strings: epoch milliseconds, or epoch seconds when below 1e11.
 * A string WITHOUT an offset is read as UTC for `kind: 'gmt'` (the `...GMT` fields). For `kind: 'local'` (the `...Local`
 * fields) the result is the local wall-clock time encoded as if it were UTC (a "floating" time): use it to read the local
 * date/time of day, not as a real instant. Returns undefined for anything unparseable.
 */
export function parseGarminTimestamp(value: unknown, kind: 'gmt' | 'local' = 'gmt'): number | undefined {
  void kind; // same arithmetic for both; the distinction documents how the result must be interpreted
  const asNumber = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d{9,}\s*$/.test(value) ? Number(value) : undefined;
  if (asNumber !== undefined) {
    if (!Number.isFinite(asNumber) || asNumber <= 0) return undefined;
    if (asNumber >= 1e11) return Math.round(asNumber);
    if (asNumber >= 1e9) return Math.round(asNumber * 1000);
    return undefined;
  }
  if (typeof value !== 'string') return undefined;
  const m = TS_RE.exec(value.trim());
  if (!m) return undefined;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const hh = m[4] === undefined ? 0 : Number(m[4]);
  const mi = m[5] === undefined ? 0 : Number(m[5]);
  const ss = m[6] === undefined ? 0 : Number(m[6]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 59) return undefined;
  // Reject impossible days such as 2026-02-31 via a round trip.
  const dayNo = toDayNumber({ y, m: mo, d });
  if (utcDateOf(dayNo * 86_400_000) !== `${m[1]}-${m[2]}-${m[3]}`) return undefined;
  const frac = m[7] === undefined ? 0 : Math.round(Number(`0.${m[7]}`) * 1000);
  let ms = dayNo * 86_400_000 + hh * 3_600_000 + mi * 60_000 + ss * 1000 + frac;
  const off = m[8];
  if (off && off.toUpperCase() !== 'Z') {
    const sign = off.startsWith('-') ? -1 : 1;
    const digits = off.slice(1).replace(':', '');
    const oh = Number(digits.slice(0, 2));
    const om = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
    ms -= sign * (oh * 3_600_000 + om * 60_000);
  }
  return ms;
}

/** Garmin reports body weight in grams (e.g. 72500); a value above 1000 is treated as grams, otherwise as kg. */
export function weightToKg(v: number): number {
  const kg = v > 1000 ? v / 1000 : v;
  return Math.round(kg * 1000) / 1000;
}

/** True when `weightToKg` will divide by 1000. */
export function weightIsGrams(v: number): boolean {
  return v > 1000;
}

export function secondsToMinutes(sec: number): number {
  return Math.round(sec / 60);
}

/** Hours with 2 decimals. */
export function secondsToHours(sec: number): number {
  return Math.round((sec / 3600) * 100) / 100;
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------------------------------------------------
// Field tracker: picks values, counts hits/misses, builds diagnostics + coverage
// ---------------------------------------------------------------------------------------------------------------------

interface FieldStat {
  total: number;
  found: number;
  missing: number;
  wrong: number;
  implausible: number;
  optional: boolean;
  tried: readonly string[];
  matchedBy: Map<string, number>;
  sample: Partial<Record<'missing' | 'wrong' | 'implausible', string>>;
  implausibleDetail?: string;
  wrongDetail?: string;
}

export interface PickOptions {
  /** The date of the item, used as the example in diagnostics. */
  date?: string;
  /** Do not report `missing` for this field (it is normally absent for some items). Coverage still counts it. */
  optional?: boolean;
  min?: number;
  max?: number;
  /** When true, `min` itself is also rejected (value must be > min). */
  minExclusive?: boolean;
  /** Round the picked number to this many decimals. */
  decimals?: number;
}

export class FieldTracker {
  private readonly stats = new Map<string, FieldStat>();
  private readonly notes = new Map<string, GarminDiagnostic>();
  /** Items examined by `item()` (for `of`). */
  items = 0;

  constructor(readonly endpoint: string) {}

  /** Call once per examined item. */
  item(): void {
    this.items += 1;
  }

  private stat(field: string, tried: readonly string[], optional: boolean): FieldStat {
    let s = this.stats.get(field);
    if (!s) {
      s = { total: 0, found: 0, missing: 0, wrong: 0, implausible: 0, optional, tried, matchedBy: new Map(), sample: {} };
      this.stats.set(field, s);
    } else if (!optional) {
      s.optional = false;
    }
    return s;
  }

  private track<T>(
    obj: unknown,
    field: string,
    names: readonly string[],
    convert: (raw: unknown) => T | undefined,
    check: (value: T) => string | undefined,
    opts: PickOptions,
  ): T | undefined {
    const s = this.stat(field, names, opts.optional === true);
    s.total += 1;
    let sawWrong: string | undefined;
    for (const name of names) {
      const r = resolve(obj, name);
      if (!r) continue;
      const value = convert(r.value);
      if (value === undefined) {
        sawWrong ??= `${r.key}=${describeType(r.value)}`;
        continue;
      }
      const problem = check(value);
      if (problem) {
        s.implausible += 1;
        s.implausibleDetail ??= `${r.key}: ${problem}`;
        if (opts.date) s.sample.implausible ??= opts.date;
        return undefined;
      }
      s.found += 1;
      s.matchedBy.set(r.key, (s.matchedBy.get(r.key) ?? 0) + 1);
      return value;
    }
    if (sawWrong !== undefined) {
      s.wrong += 1;
      s.wrongDetail ??= sawWrong;
      if (opts.date) s.sample.wrong ??= opts.date;
    } else {
      s.missing += 1;
      if (opts.date) s.sample.missing ??= opts.date;
    }
    return undefined;
  }

  number(obj: unknown, field: string, names: readonly string[], opts: PickOptions = {}): number | undefined {
    return this.track(
      obj,
      field,
      names,
      toFiniteNumber,
      (n) => {
        if (opts.min !== undefined && (opts.minExclusive ? n <= opts.min : n < opts.min)) return `${n} below ${opts.min}`;
        if (opts.max !== undefined && n > opts.max) return `${n} above ${opts.max}`;
        return undefined;
      },
      opts,
    ) as number | undefined;
  }

  /** Like `number`, then rounds to `opts.decimals` (default: not rounded). */
  rounded(obj: unknown, field: string, names: readonly string[], opts: PickOptions = {}): number | undefined {
    const n = this.number(obj, field, names, opts);
    return n === undefined || opts.decimals === undefined ? n : round(n, opts.decimals);
  }

  string(obj: unknown, field: string, names: readonly string[], opts: PickOptions = {}): string | undefined {
    return this.track(obj, field, names, toNonEmptyString, () => undefined, opts);
  }

  /** A calendar date: 'YYYY-MM-DD' or any string that starts with one. */
  date(obj: unknown, field: string, names: readonly string[], opts: PickOptions = {}): string | undefined {
    return this.track(obj, field, names, (v) => leadingYmd(v) ?? undefined, () => undefined, opts);
  }

  /** Epoch milliseconds from a timestamp string/number. */
  timestamp(
    obj: unknown,
    field: string,
    names: readonly string[],
    kind: 'gmt' | 'local',
    opts: PickOptions = {},
  ): number | undefined {
    return this.track(obj, field, names, (v) => parseGarminTimestamp(v, kind), () => undefined, opts);
  }

  /** Records a free-form observation (counted per endpoint/field/reason). */
  note(field: string, reason: GarminDiagnosticReason, detail?: string, sampleDate?: string): void {
    const key = `${field}|${reason}`;
    const existing = this.notes.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    this.notes.set(key, {
      endpoint: this.endpoint,
      field,
      reason,
      count: 1,
      ...(detail !== undefined ? { detail } : {}),
      ...(sampleDate !== undefined ? { sampleDate } : {}),
    });
  }

  diagnostics(): GarminDiagnostic[] {
    const out: GarminDiagnostic[] = [];
    for (const [field, s] of this.stats) {
      const base = { endpoint: this.endpoint, field, of: s.total };
      if (s.missing > 0 && !s.optional) {
        out.push({
          ...base,
          reason: 'missing',
          count: s.missing,
          detail: `none of: ${s.tried.join(', ')}`,
          ...(s.sample.missing ? { sampleDate: s.sample.missing } : {}),
        });
      }
      if (s.wrong > 0) {
        out.push({
          ...base,
          reason: 'wrong_type',
          count: s.wrong,
          ...(s.wrongDetail ? { detail: s.wrongDetail } : {}),
          ...(s.sample.wrong ? { sampleDate: s.sample.wrong } : {}),
        });
      }
      if (s.implausible > 0) {
        out.push({
          ...base,
          reason: 'implausible',
          count: s.implausible,
          ...(s.implausibleDetail ? { detail: s.implausibleDetail } : {}),
          ...(s.sample.implausible ? { sampleDate: s.sample.implausible } : {}),
        });
      }
    }
    for (const n of this.notes.values()) out.push({ ...n, ...(n.field !== '$' && !n.of && this.items ? { of: this.items } : {}) });
    return out.sort((a, b) => a.field.localeCompare(b.field) || a.reason.localeCompare(b.reason));
  }

  coverage(): GarminFieldCoverage[] {
    return [...this.stats.entries()].map(([field, s]) => ({
      endpoint: this.endpoint,
      field,
      total: s.total,
      found: s.found,
      matchedBy: Object.fromEntries(s.matchedBy),
    }));
  }
}

/** Sums diagnostics that share (endpoint, field, reason). The first detail/sampleDate wins. */
export function mergeDiagnostics(...lists: ReadonlyArray<readonly GarminDiagnostic[]>): GarminDiagnostic[] {
  const map = new Map<string, GarminDiagnostic>();
  for (const list of lists) {
    for (const d of list) {
      const key = `${d.endpoint}|${d.field}|${d.reason}`;
      const cur = map.get(key);
      if (!cur) {
        map.set(key, { ...d });
      } else {
        cur.count += d.count;
        if (d.of !== undefined) cur.of = (cur.of ?? 0) + d.of;
        cur.detail ??= d.detail;
        cur.sampleDate ??= d.sampleDate;
      }
    }
  }
  return [...map.values()];
}

/** Sums coverage that shares (endpoint, field). */
export function mergeCoverage(...lists: ReadonlyArray<readonly GarminFieldCoverage[]>): GarminFieldCoverage[] {
  const map = new Map<string, GarminFieldCoverage>();
  for (const list of lists) {
    for (const c of list) {
      const key = `${c.endpoint}|${c.field}`;
      const cur = map.get(key);
      if (!cur) {
        map.set(key, { ...c, matchedBy: { ...c.matchedBy } });
      } else {
        cur.total += c.total;
        cur.found += c.found;
        for (const [k, n] of Object.entries(c.matchedBy)) cur.matchedBy[k] = (cur.matchedBy[k] ?? 0) + n;
      }
    }
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------------------------------------------------

function findArray(obj: Obj, keys: readonly string[], depth: number): unknown[] | null | undefined {
  for (const k of keys) {
    const key = ownKey(obj, k);
    if (key === undefined) continue;
    const v = obj[key];
    if (Array.isArray(v)) return v;
    if (v === null) return null;
    if (depth > 0 && isObject(v)) {
      const nested = findArray(v, keys, depth - 1);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

interface ContainerSpec {
  /** Property names that may hold the array. */
  keys: readonly string[];
  /** If the top-level object has one of these properties, it is itself a single item. */
  itemHints: readonly string[];
  /** Properties that wrap one item's real fields (their contents are merged into the item). */
  wrappers?: readonly string[];
}

function extractItems(raw: unknown, t: FieldTracker, spec: ContainerSpec): Obj[] {
  let list: unknown[];
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (isObject(raw)) {
    const found = findArray(raw, spec.keys, 1);
    if (found === null) return [];
    if (found) {
      list = found;
    } else if (spec.itemHints.some((h) => ownKey(raw, h) !== undefined)) {
      list = [raw];
    } else if (Object.keys(raw).length === 0) {
      return [];
    } else {
      t.note('$', 'unexpected_shape', `expected an array or an object with one of [${spec.keys.join(', ')}], got an object with keys: ${Object.keys(raw).slice(0, 8).join(', ')}`);
      return [];
    }
  } else {
    t.note('$', 'unexpected_shape', `expected an array or object, got ${describeType(raw)}`);
    return [];
  }
  const out: Obj[] = [];
  for (const el of list) {
    if (!isObject(el)) {
      t.note('$item', 'unexpected_shape', `array item is ${describeType(el)}, expected an object`);
      continue;
    }
    out.push(spec.wrappers ? flatten(el, spec.wrappers) : el);
  }
  return out;
}

function flatten(item: Obj, wrappers: readonly string[]): Obj {
  let out = item;
  for (const w of wrappers) {
    const k = ownKey(item, w);
    const inner = k === undefined ? undefined : item[k];
    if (isObject(inner)) out = { ...inner, ...out };
  }
  return out;
}

function meta(entries: Record<string, string | number | boolean | undefined>): GarminMeta | undefined {
  const out: GarminMeta = {};
  for (const [k, v] of Object.entries(entries)) if (v !== undefined) out[k] = v;
  return Object.keys(out).length ? out : undefined;
}

function bio(
  type: GarminBiometricType,
  date: string,
  value: number,
  extra: { meta?: GarminMeta | undefined; recordedAtMs?: number | undefined; idSuffix?: string } = {},
): GarminBiometric {
  return {
    date,
    type,
    value,
    unit: GARMIN_BIOMETRIC_UNITS[type],
    externalId: `garmin:${type}:${date}${extra.idSuffix ? `:${extra.idSuffix}` : ''}`,
    ...(extra.recordedAtMs !== undefined ? { recordedAtMs: extra.recordedAtMs } : {}),
    ...(extra.meta ? { meta: extra.meta } : {}),
  };
}

/** Keeps the last item per key (later responses win). */
function dedupe<T>(items: T[], keyOf: (t: T) => string): T[] {
  const map = new Map<string, T>();
  for (const it of items) map.set(keyOf(it), it);
  return [...map.values()];
}

function finish<T>(t: FieldTracker, items: T[]): GarminMapResult<T> {
  return { items, diagnostics: t.diagnostics(), coverage: t.coverage() };
}

// ---------------------------------------------------------------------------------------------------------------------
// Endpoint mappers
// ---------------------------------------------------------------------------------------------------------------------

export interface GarminUserSettings {
  displayName?: string;
  timeZone?: string;
  measurementSystem?: string;
}

/** /userprofile-service/userprofile/settings. Never throws. */
export function mapUserSettings(raw: unknown): GarminUserSettings {
  const c = FIELD_CANDIDATES.userSettings;
  const displayName = pickString(raw, c.displayName);
  const timeZone = pickString(raw, c.timeZone);
  const measurementSystem = pickString(raw, c.measurementSystem);
  return {
    ...(displayName ? { displayName } : {}),
    ...(timeZone ? { timeZone } : {}),
    ...(measurementSystem ? { measurementSystem } : {}),
  };
}

export type DailySummariesInclude = Partial<
  Record<'energy' | 'restingHr' | 'spo2' | 'respiration' | 'bodyBattery' | 'stress', boolean>
>;

export interface DailySummariesMapped extends GarminMap {
  energy: GarminDailyEnergy[];
  biometrics: GarminBiometric[];
  /** Every date for which the response had an item (even when it carried no usable value). */
  dates: string[];
}

/**
 * /usersummary-service/v2/dailysummaries -> `{data: [...]}` (or a bare array). Energy, steps, resting HR, stress,
 * body battery, respiration and SpO2 come from this ONE ranged call (field names UNVERIFIED, see FIELD_CANDIDATES).
 */
export function mapDailySummaries(raw: unknown, opts: { include?: DailySummariesInclude } = {}): DailySummariesMapped {
  const inc = { energy: true, restingHr: true, spo2: true, respiration: true, bodyBattery: true, stress: true, ...opts.include };
  const t = new FieldTracker('dailySummaries');
  const c = FIELD_CANDIDATES.dailySummaries;
  const energy: GarminDailyEnergy[] = [];
  const biometrics: GarminBiometric[] = [];
  const dates: string[] = [];

  const items = extractItems(raw, t, {
    keys: ['data', 'dailySummaries', 'summaries', 'items'],
    itemHints: ['calendarDate'],
    wrappers: ['summary', 'dailySummary', 'userSummary'],
  });
  for (const it of items) {
    t.item();
    const date = t.date(it, 'date', c.date) ?? t.date(it, 'dateFallback', c.dateFallback, { optional: true });
    if (!date) {
      t.note('date', 'skipped', 'item without a usable calendar date');
      continue;
    }
    dates.push(date);
    const o = { date };

    if (inc.energy) {
      const kcal = { ...o, min: 0, minExclusive: true, max: 20000, decimals: 1 };
      let activeKcal = t.rounded(it, 'activeKcal', c.activeKcal, kcal);
      let restingKcal = t.rounded(it, 'restingKcal', c.restingKcal, kcal);
      let totalKcal = t.rounded(it, 'totalKcal', c.totalKcal, kcal);
      const steps = t.rounded(it, 'steps', c.steps, { ...o, min: 0, max: 200000, decimals: 0 });
      if (totalKcal === undefined && activeKcal !== undefined && restingKcal !== undefined) {
        totalKcal = round(activeKcal + restingKcal, 1);
        t.note('totalKcal', 'fallback_used', 'total = active + resting', date);
      }
      if (restingKcal === undefined && totalKcal !== undefined && activeKcal !== undefined && totalKcal > activeKcal) {
        restingKcal = round(totalKcal - activeKcal, 1);
        t.note('restingKcal', 'fallback_used', 'resting = total - active', date);
      }
      if (activeKcal === undefined && totalKcal !== undefined && restingKcal !== undefined && totalKcal > restingKcal) {
        activeKcal = round(totalKcal - restingKcal, 1);
        t.note('activeKcal', 'fallback_used', 'active = total - resting', date);
      }
      if (activeKcal !== undefined || restingKcal !== undefined || totalKcal !== undefined || steps !== undefined) {
        energy.push({
          date,
          ...(activeKcal !== undefined ? { activeKcal } : {}),
          ...(restingKcal !== undefined ? { restingKcal } : {}),
          ...(totalKcal !== undefined ? { totalKcal } : {}),
          ...(steps !== undefined ? { steps } : {}),
        });
      }
    }

    if (inc.restingHr) {
      const v = t.rounded(it, 'restingHeartRate', c.restingHr, { ...o, min: 25, max: 220, decimals: 0 });
      if (v !== undefined) {
        const min = t.number(it, 'minHeartRate', c.minHr, { ...o, optional: true, min: 20, max: 250 });
        const max = t.number(it, 'maxHeartRate', c.maxHr, { ...o, optional: true, min: 20, max: 260 });
        biometrics.push(bio('resting_heart_rate', date, v, { meta: meta({ min, max }) }));
      }
    }
    if (inc.stress) {
      const v = t.rounded(it, 'stress', c.stress, { ...o, min: 0, max: 100, decimals: 0 });
      if (v !== undefined) biometrics.push(bio('stress', date, v));
    }
    if (inc.respiration) {
      const v = t.rounded(it, 'respiration', c.respiration, { ...o, min: 3, max: 60, decimals: 1 });
      if (v !== undefined) biometrics.push(bio('respiration_rate', date, v));
    }
    if (inc.spo2) {
      const v = t.rounded(it, 'spo2', c.spo2, { ...o, min: 50, max: 100, decimals: 1 });
      if (v !== undefined) {
        const low = t.number(it, 'spo2Low', c.spo2Low, { ...o, optional: true, min: 30, max: 100 });
        biometrics.push(bio('spo2', date, v, { meta: meta({ low }) }));
      }
    }
    if (inc.bodyBattery) {
      const pct = { ...o, min: 0, max: 100, decimals: 0 };
      let high = t.rounded(it, 'bodyBatteryHigh', c.bodyBatteryHigh, pct);
      const low = t.rounded(it, 'bodyBatteryLow', c.bodyBatteryLow, { ...pct, optional: true });
      const latest = t.rounded(it, 'bodyBatteryLatest', c.bodyBatteryLatest, { ...pct, optional: true });
      const charged = t.rounded(it, 'bodyBatteryCharged', c.bodyBatteryCharged, { ...o, optional: true, min: 0, max: 200, decimals: 0 });
      const drained = t.rounded(it, 'bodyBatteryDrained', c.bodyBatteryDrained, { ...o, optional: true, min: 0, max: 200, decimals: 0 });
      if (high === undefined && latest !== undefined) {
        high = latest;
        t.note('bodyBatteryHigh', 'fallback_used', 'highest missing; used the most recent value', date);
      }
      if (high !== undefined) biometrics.push(bio('body_battery', date, high, { meta: meta({ high, low, charged, drained, latest }) }));
    }
  }

  return {
    energy: dedupe(energy, (e) => e.date),
    biometrics: dedupe(biometrics, (b) => b.externalId),
    dates: [...new Set(dates)],
    diagnostics: t.diagnostics(),
    coverage: t.coverage(),
  };
}

export interface SleepExtra {
  date: string;
  /** Average SpO2 during the night, percent. */
  spo2?: number;
  spo2Low?: number;
  /** Average respiration during the night, breaths/min. */
  respiration?: number;
}

export interface SleepMapped extends GarminMapResult<GarminBiometric> {
  /** Night-time SpO2 / respiration, usable as a fallback when the daily summaries lack them. */
  extras: SleepExtra[];
}

/** /sleep-service/sleep/dailySleepSummariesByDate (or dailySleep): one `sleep` biometric (hours) per night. */
export function mapSleep(raw: unknown): SleepMapped {
  const t = new FieldTracker('sleep');
  const c = FIELD_CANDIDATES.sleep;
  const out: GarminBiometric[] = [];
  const extras: SleepExtra[] = [];

  const items = extractItems(raw, t, {
    keys: ['data', 'dailySleepSummaries', 'sleepSummaries', 'dailySleepDTOList', 'items'],
    itemHints: ['calendarDate', 'dailySleepDTO', 'sleepTimeSeconds'],
    wrappers: ['dailySleepDTO'],
  });
  for (const it of items) {
    t.item();
    const date = t.date(it, 'date', c.date);
    if (!date) {
      t.note('date', 'skipped', 'night without a usable calendar date');
      continue;
    }
    const o = { date };
    const sec = { ...o, min: 0 };
    let totalSec = t.number(it, 'sleepTimeSeconds', c.totalSec, { ...sec, min: 0, minExclusive: true, max: 86400 });
    const deep = t.number(it, 'deepSleepSeconds', c.deepSec, { ...sec, optional: true, max: 86400 });
    const light = t.number(it, 'lightSleepSeconds', c.lightSec, { ...sec, optional: true, max: 86400 });
    const rem = t.number(it, 'remSleepSeconds', c.remSec, { ...sec, optional: true, max: 86400 });
    const awake = t.number(it, 'awakeSleepSeconds', c.awakeSec, { ...sec, optional: true, max: 86400 });
    if (totalSec === undefined && pickNumber(it, c.totalSec) === undefined && (deep !== undefined || light !== undefined || rem !== undefined)) {
      const sum = (deep ?? 0) + (light ?? 0) + (rem ?? 0);
      if (sum > 0) {
        totalSec = sum;
        t.note('sleepTimeSeconds', 'fallback_used', 'total = deep + light + rem', date);
      }
    }

    const spo2 = t.number(it, 'spo2', c.spo2, { ...o, optional: true, min: 50, max: 100 });
    const spo2Low = t.number(it, 'spo2Low', c.spo2Low, { ...o, optional: true, min: 30, max: 100 });
    const respiration = t.number(it, 'respiration', c.respiration, { ...o, optional: true, min: 3, max: 60 });
    if (spo2 !== undefined || spo2Low !== undefined || respiration !== undefined) {
      extras.push({
        date,
        ...(spo2 !== undefined ? { spo2: round(spo2, 1) } : {}),
        ...(spo2Low !== undefined ? { spo2Low: round(spo2Low, 1) } : {}),
        ...(respiration !== undefined ? { respiration: round(respiration, 1) } : {}),
      });
    }

    if (totalSec === undefined) {
      t.note('sleepTimeSeconds', 'skipped', 'night without a sleep duration', date);
      continue;
    }
    const startMs = t.timestamp(it, 'sleepStartMs', c.startGmt, 'gmt', { ...o, optional: true });
    const endMs = t.timestamp(it, 'sleepEndMs', c.endGmt, 'gmt', { ...o, optional: true });
    const score = t.number(it, 'sleepScore', c.score, { ...o, optional: true, min: 0, max: 100 });
    const hours = secondsToHours(totalSec);
    if (hours < 0.1 || hours > 24) {
      t.note('sleepTimeSeconds', 'implausible', `${hours} h`, date);
      continue;
    }
    out.push(
      bio('sleep', date, hours, {
        recordedAtMs: endMs,
        meta: meta({
          deepMin: deep !== undefined ? secondsToMinutes(deep) : undefined,
          lightMin: light !== undefined ? secondsToMinutes(light) : undefined,
          remMin: rem !== undefined ? secondsToMinutes(rem) : undefined,
          awakeMin: awake !== undefined ? secondsToMinutes(awake) : undefined,
          score: score !== undefined ? Math.round(score) : undefined,
          startMs,
          endMs,
        }),
      }),
    );
  }
  return { ...finish(t, dedupe(out, (b) => b.externalId)), extras: dedupe(extras, (e) => e.date) };
}

/** /hrv-service/hrv/daily/{from}/{to} (or /hrv/{date}): `hrv` biometric = last night's average, ms. */
export function mapHrv(raw: unknown): GarminMapResult<GarminBiometric> {
  const t = new FieldTracker('hrv');
  const c = FIELD_CANDIDATES.hrv;
  const out: GarminBiometric[] = [];
  const items = extractItems(raw, t, {
    keys: ['hrvSummaries', 'data', 'summaries', 'items'],
    itemHints: ['hrvSummary'],
    wrappers: ['hrvSummary'],
  });
  for (const it of items) {
    t.item();
    const date = t.date(it, 'date', c.date);
    if (!date) {
      t.note('date', 'skipped', 'item without a usable calendar date');
      continue;
    }
    const o = { date };
    const value = t.rounded(it, 'lastNightAvg', c.lastNight, { ...o, min: 0, minExclusive: true, max: 500, decimals: 0 });
    if (value === undefined) continue;
    const weeklyAvg = t.rounded(it, 'weeklyAvg', c.weeklyAvg, { ...o, optional: true, min: 0, max: 500, decimals: 0 });
    const peak = t.rounded(it, 'lastNight5MinHigh', c.peak, { ...o, optional: true, min: 0, max: 800, decimals: 0 });
    const status = t.string(it, 'status', c.status, { ...o, optional: true });
    const baselineLow = t.rounded(it, 'baselineLow', c.baselineLow, { ...o, optional: true, min: 0, max: 500, decimals: 0 });
    const baselineHigh = t.rounded(it, 'baselineHigh', c.baselineHigh, { ...o, optional: true, min: 0, max: 500, decimals: 0 });
    out.push(bio('hrv', date, value, { meta: meta({ status, weeklyAvg, peak, baselineLow, baselineHigh }) }));
  }
  return finish(t, dedupe(out, (b) => b.externalId));
}

export type WeightInclude = Partial<Record<'weight' | 'bodyFat', boolean>>;

interface WeightEntry {
  obj: Obj;
  parentDate?: string;
}

function collectWeightEntries(raw: unknown, t: FieldTracker): WeightEntry[] {
  const entries: WeightEntry[] = [];
  const fromSummary = (s: Obj): void => {
    const parentDate = leadingYmd(s.summaryDate ?? s.calendarDate ?? s.date) ?? undefined;
    const all = s.allWeightMetrics;
    if (Array.isArray(all) && all.length) {
      for (const e of all) if (isObject(e)) entries.push({ obj: e, ...(parentDate ? { parentDate } : {}) });
      return;
    }
    if (isObject(s.latestWeight)) {
      entries.push({ obj: s.latestWeight, ...(parentDate ? { parentDate } : {}) });
      return;
    }
    if (pickNumber(s, FIELD_CANDIDATES.weight.weight) !== undefined) entries.push({ obj: s, ...(parentDate ? { parentDate } : {}) });
  };
  let list: unknown[] | undefined;
  if (Array.isArray(raw)) {
    list = raw;
  } else if (isObject(raw)) {
    const found = findArray(raw, ['dateWeightList', 'dailyWeightSummaries', 'data', 'weights', 'allWeightMetrics', 'items'], 1);
    if (found === null) return [];
    if (found) list = found;
    else if (pickNumber(raw, FIELD_CANDIDATES.weight.weight) !== undefined) list = [raw];
    else if (Object.keys(raw).length === 0) return [];
    else {
      t.note('$', 'unexpected_shape', `expected an array or an object with dateWeightList / dailyWeightSummaries, got keys: ${Object.keys(raw).slice(0, 8).join(', ')}`);
      return [];
    }
  } else if (raw === null || raw === undefined) {
    return [];
  } else {
    t.note('$', 'unexpected_shape', `expected an array or object, got ${describeType(raw)}`);
    return [];
  }
  for (const el of list) {
    if (!isObject(el)) {
      t.note('$item', 'unexpected_shape', `array item is ${describeType(el)}, expected an object`);
      continue;
    }
    fromSummary(el);
  }
  return entries;
}

/**
 * /weight-service/weight/all/{from}/{to} (flat DateWeightDTO[]) or /weight/range/... (`dailyWeightSummaries`).
 * Emits every weigh-in (several per day are possible). Grams -> kg heuristic: a value above 1000 is grams.
 */
export function mapWeight(raw: unknown, opts: { include?: WeightInclude } = {}): GarminMapResult<GarminBiometric> {
  const inc = { weight: true, bodyFat: true, ...opts.include };
  const t = new FieldTracker('weight');
  const c = FIELD_CANDIDATES.weight;
  const out: GarminBiometric[] = [];
  const perDay = new Map<string, number>();

  for (const { obj, parentDate } of collectWeightEntries(raw, t)) {
    t.item();
    let date = t.date(obj, 'date', c.date, { optional: true }) ?? parentDate;
    if (!date) {
      // DateWeightDTO.date is epoch milliseconds; the UTC day can be off by one near midnight.
      const ms = parseGarminTimestamp(pickNumber(obj, ['date']), 'gmt');
      if (ms !== undefined) {
        date = utcDateOf(ms);
        t.note('date', 'fallback_used', 'calendarDate missing; derived the date from epoch ms (UTC)', date);
      } else {
        const s = leadingYmd(pickString(obj, ['date']));
        if (s) date = s;
      }
    }
    if (!date) {
      t.note('date', 'skipped', 'weigh-in without a usable date');
      continue;
    }
    const o = { date };
    const recordedAtMs = t.timestamp(obj, 'recordedAtMs', c.recordedAt, 'gmt', { ...o, optional: true });
    let suffix: string;
    if (recordedAtMs !== undefined) {
      suffix = String(recordedAtMs);
    } else {
      const n = perDay.get(date) ?? 0;
      perDay.set(date, n + 1);
      suffix = n === 0 ? '' : String(n);
    }

    if (inc.weight) {
      const rawW = t.number(obj, 'weight', c.weight, { ...o, min: 0, minExclusive: true });
      if (rawW !== undefined) {
        const kg = weightToKg(rawW);
        if (kg < 20 || kg > 400) {
          t.note('weight', 'implausible', `${kg} kg (raw ${rawW})`, date);
        } else {
          if (weightIsGrams(rawW)) t.note('weight', 'converted', 'grams -> kg (value > 1000)', date);
          const bmi = t.rounded(obj, 'bmi', c.bmi, { ...o, optional: true, min: 5, max: 100, decimals: 1 });
          const muscle = t.number(obj, 'muscleMass', c.muscleMass, { ...o, optional: true, min: 0, minExclusive: true });
          const bone = t.number(obj, 'boneMass', c.boneMass, { ...o, optional: true, min: 0, minExclusive: true });
          const water = t.rounded(obj, 'bodyWater', c.bodyWater, { ...o, optional: true, min: 0, max: 100, decimals: 1 });
          const source = t.string(obj, 'sourceType', c.sourceType, { ...o, optional: true });
          out.push(
            bio('weight', date, kg, {
              idSuffix: suffix,
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
    }
    if (inc.bodyFat) {
      let fat = t.number(obj, 'bodyFat', c.bodyFat, { ...o, optional: true, min: 0, minExclusive: true, max: 100 });
      if (fat !== undefined && fat <= 1) {
        fat = fat * 100;
        t.note('bodyFat', 'converted', 'fraction -> percent (value <= 1)', date);
      }
      if (fat !== undefined) {
        const v = round(fat, 1);
        if (v < 1 || v > 80) t.note('bodyFat', 'implausible', `${v} %`, date);
        else out.push(bio('body_fat', date, v, { idSuffix: suffix, recordedAtMs }));
      }
    }
  }
  return finish(t, dedupe(out, (b) => b.externalId));
}

function bodyBatteryLevelIndex(descriptors: unknown): number | undefined {
  if (!Array.isArray(descriptors)) return undefined;
  for (let i = 0; i < descriptors.length; i++) {
    const d = descriptors[i];
    if (!isObject(d)) continue;
    const key = pickString(d, ['bodyBatteryValueDescriptorKey', 'key', 'name']);
    if (key && /level/i.test(key)) {
      const idx = pickNumber(d, ['bodyBatteryValueDescriptorIndex', 'index']) ?? i;
      if (Number.isInteger(idx) && idx >= 0) return idx;
    }
  }
  return undefined;
}

/**
 * /wellness-service/wellness/bodyBattery/reports/daily: one `body_battery` per day. The index of the level inside
 * `bodyBatteryValuesArray` entries comes from the descriptor list (key 'bodyBatteryLevel'); without a usable descriptor
 * it falls back to index 1 for [timestamp, level] pairs and index 2 for longer entries. value = the day's highest level.
 */
export function mapBodyBattery(raw: unknown): GarminMapResult<GarminBiometric> {
  const t = new FieldTracker('bodyBattery');
  const c = FIELD_CANDIDATES.bodyBattery;
  const out: GarminBiometric[] = [];
  const items = extractItems(raw, t, {
    keys: ['data', 'reports', 'bodyBatteryReports', 'items'],
    itemHints: ['bodyBatteryValuesArray'],
  });
  for (const it of items) {
    t.item();
    let date = t.date(it, 'date', c.date, { optional: true });
    if (!date) {
      const localRaw = pickString(it, c.dateFallback);
      const ms = localRaw !== undefined ? parseGarminTimestamp(localRaw, 'local') : undefined;
      if (ms !== undefined) {
        date = utcDateOf(ms);
        t.note('date', 'fallback_used', 'date derived from startTimestampLocal', date);
      }
    }
    if (!date) {
      t.note('date', 'skipped', 'report without a usable date');
      continue;
    }
    const o = { date };
    const valuesRes = FIELD_CANDIDATES.bodyBattery.values.map((n) => resolve(it, n)).find((r) => r !== undefined);
    const descRes = c.descriptors.map((n) => resolve(it, n)).find((r) => r !== undefined);
    const values = valuesRes && Array.isArray(valuesRes.value) ? valuesRes.value : undefined;
    if (!values) {
      t.note('bodyBatteryValuesArray', valuesRes ? 'wrong_type' : 'missing', valuesRes ? `expected an array, got ${describeType(valuesRes.value)}` : `none of: ${c.values.join(', ')}`, date);
      continue;
    }
    const idx = bodyBatteryLevelIndex(descRes?.value);
    let usedFallback = false;
    const levels: number[] = [];
    for (const entry of values) {
      if (!Array.isArray(entry)) continue;
      let i = idx;
      if (i === undefined) {
        i = entry.length === 2 ? 1 : entry.length >= 3 ? 2 : undefined;
        usedFallback = true;
      }
      if (i === undefined) continue;
      const n = toFiniteNumber(entry[i]);
      if (n !== undefined && n >= 0 && n <= 100) levels.push(n);
    }
    if (usedFallback) {
      t.note('bodyBatteryValueDescriptors', 'fallback_used', 'no descriptor for bodyBatteryLevel; guessed the index from the entry length', date);
    }
    if (!levels.length) {
      t.note('bodyBatteryLevel', 'missing', 'no usable body battery levels in the values array', date);
      continue;
    }
    const high = Math.max(...levels);
    const low = Math.min(...levels);
    const charged = t.rounded(it, 'charged', c.charged, { ...o, optional: true, min: 0, max: 300, decimals: 0 });
    const drained = t.rounded(it, 'drained', c.drained, { ...o, optional: true, min: 0, max: 300, decimals: 0 });
    out.push(
      bio('body_battery', date, Math.round(high), {
        meta: meta({ high: Math.round(high), low: Math.round(low), charged, drained, latest: Math.round(levels[levels.length - 1] as number) }),
      }),
    );
  }
  return finish(t, dedupe(out, (b) => b.externalId));
}

/** /wellness-service/wellness/dailyHeartRate?date=: a single day object. `fallbackDate` is the requested date. */
export function mapHeartRateDay(raw: unknown, fallbackDate?: string): GarminMapResult<GarminBiometric> {
  const t = new FieldTracker('heartRateDay');
  const c = FIELD_CANDIDATES.heartRateDay;
  const out: GarminBiometric[] = [];
  const items = extractItems(raw, t, { keys: ['data'], itemHints: ['restingHeartRate', 'calendarDate', 'heartRateValues'] });
  for (const it of items) {
    t.item();
    const date = t.date(it, 'date', c.date, { optional: true }) ?? fallbackDate;
    if (!date) {
      t.note('date', 'skipped', 'no date in the response and none supplied');
      continue;
    }
    const v = t.rounded(it, 'restingHeartRate', c.restingHr, { date, min: 25, max: 220, decimals: 0 });
    if (v === undefined) continue;
    const min = t.number(it, 'minHeartRate', c.minHr, { date, optional: true, min: 20, max: 250 });
    const max = t.number(it, 'maxHeartRate', c.maxHr, { date, optional: true, min: 20, max: 260 });
    const seven = t.number(it, 'lastSevenDaysAvgRestingHeartRate', c.sevenDayAvg, { date, optional: true, min: 20, max: 220 });
    out.push(bio('resting_heart_rate', date, v, { meta: meta({ min, max, sevenDayAvg: seven }) }));
  }
  return finish(t, dedupe(out, (b) => b.externalId));
}

/** /wellness-service/wellness/daily/spo2acclimation/{date}: a single day object. */
export function mapSpo2Day(raw: unknown, fallbackDate?: string): GarminMapResult<GarminBiometric> {
  const t = new FieldTracker('spo2Day');
  const c = FIELD_CANDIDATES.spo2Day;
  const out: GarminBiometric[] = [];
  const items = extractItems(raw, t, { keys: ['data'], itemHints: ['calendarDate', 'averageSpO2', 'lowestSpO2'] });
  for (const it of items) {
    t.item();
    const date = t.date(it, 'date', c.date, { optional: true }) ?? fallbackDate;
    if (!date) {
      t.note('date', 'skipped', 'no date in the response and none supplied');
      continue;
    }
    const v = t.rounded(it, 'averageSpO2', c.average, { date, min: 50, max: 100, decimals: 1 });
    if (v === undefined) continue;
    const low = t.number(it, 'lowestSpO2', c.lowest, { date, optional: true, min: 30, max: 100 });
    const latest = t.number(it, 'latestSpO2', c.latest, { date, optional: true, min: 30, max: 100 });
    const sleepAvg = t.number(it, 'avgSleepSpO2', c.sleepAvg, { date, optional: true, min: 30, max: 100 });
    out.push(bio('spo2', date, v, { meta: meta({ low, latest, sleepAvg }) }));
  }
  return finish(t, dedupe(out, (b) => b.externalId));
}

/** /usersummary-service/stats/steps/daily/{from}/{to}: steps-only energy rows. */
export function mapStepsDaily(raw: unknown): GarminMapResult<GarminDailyEnergy> {
  const t = new FieldTracker('steps');
  const c = FIELD_CANDIDATES.steps;
  const out: GarminDailyEnergy[] = [];
  const items = extractItems(raw, t, { keys: ['data', 'values', 'items'], itemHints: ['totalSteps'] });
  for (const it of items) {
    t.item();
    const date = t.date(it, 'date', c.date);
    if (!date) {
      t.note('date', 'skipped', 'item without a usable calendar date');
      continue;
    }
    const steps = t.rounded(it, 'steps', c.steps, { date, min: 0, max: 200000, decimals: 0 });
    if (steps !== undefined) out.push({ date, steps });
  }
  return finish(t, dedupe(out, (e) => e.date));
}

/** /usersummary-service/stats/stress/daily/{from}/{to}: `stress` biometrics (average level 0-100). */
export function mapStressDaily(raw: unknown): GarminMapResult<GarminBiometric> {
  const t = new FieldTracker('stress');
  const c = FIELD_CANDIDATES.stress;
  const out: GarminBiometric[] = [];
  const items = extractItems(raw, t, { keys: ['data', 'values', 'items'], itemHints: ['calendarDate'] });
  for (const it of items) {
    t.item();
    const date = t.date(it, 'date', c.date);
    if (!date) {
      t.note('date', 'skipped', 'item without a usable calendar date');
      continue;
    }
    const v = t.rounded(it, 'stress', c.value, { date, min: 0, max: 100, decimals: 0 });
    if (v !== undefined) out.push(bio('stress', date, v));
  }
  return finish(t, dedupe(out, (b) => b.externalId));
}

function humanize(typeKey: string): string {
  const s = typeKey.replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Workout';
}

/**
 * /activitylist-service/activities/search/activities: workouts. `startTimeGMT` ('2026-11-09 06:30:00') is read as UTC.
 * If it is missing, `startTimeLocal` is used with `opts.localOffsetMs` (local minus UTC) or, failing that, as UTC.
 */
export function mapActivities(raw: unknown, opts: { localOffsetMs?: number } = {}): GarminMapResult<GarminWorkout> {
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
    let startMs = t.timestamp(it, 'startMs', c.startGmt, 'gmt', { optional: true });
    if (startMs === undefined) {
      const local = t.timestamp(it, 'startMsLocal', c.startLocal, 'local');
      if (local !== undefined) {
        startMs = local - (opts.localOffsetMs ?? 0);
        t.note(
          'startMs',
          'fallback_used',
          opts.localOffsetMs === undefined ? 'startTimeGMT missing; used startTimeLocal as UTC (offset unknown)' : 'startTimeGMT missing; used startTimeLocal minus the supplied offset',
        );
      }
    }
    if (startMs === undefined) {
      t.note('startMs', 'skipped', `activity ${id} without a usable start time`);
      continue;
    }
    const pos = { min: 0, minExclusive: true, max: 7 * 86400 };
    const duration = t.number(it, 'durationSec', c.duration, { optional: true, ...pos });
    const elapsed = t.number(it, 'elapsedDuration', c.elapsed, { optional: true, ...pos });
    const moving = t.number(it, 'movingDuration', c.moving, { optional: true, ...pos });
    const durationSec = duration ?? elapsed ?? moving;
    if (durationSec === undefined) {
      t.note('durationSec', 'skipped', `activity ${id} without a duration`);
      continue;
    }
    const typeKey = t.string(it, 'typeKey', c.typeKey, { optional: true }) ?? 'unknown';
    const name = t.string(it, 'name', c.name, { optional: true }) ?? humanize(typeKey);
    const kcal = t.rounded(it, 'kcal', c.calories, { optional: true, min: 0, minExclusive: true, max: 20000, decimals: 0 });
    const distanceM = t.rounded(it, 'distanceM', c.distance, { optional: true, min: 0, minExclusive: true, max: 5_000_000, decimals: 1 });
    out.push({
      externalId: `garmin:activity:${id}`,
      name,
      typeKey,
      startMs,
      endMs: Math.round(startMs + (elapsed ?? durationSec) * 1000),
      durationSec: Math.round(durationSec),
      ...(kcal !== undefined ? { kcal } : {}),
      ...(distanceM !== undefined ? { distanceM } : {}),
    });
  }
  return finish(t, dedupe(out, (w) => w.externalId));
}
