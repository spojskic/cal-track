// The "details" of one workout: what Garmin knows about a session beyond its name, duration and calories (heart rate, time in
// heart-rate zones, distance, pace, training effect, strength sets, laps). Stored as `exercise_entries.details` (jsonb, nullable;
// migration 20261110000105) and read by the Workouts screens and by the coach.
//
// THE SHAPE IS VERSIONED. `v: 1` is the only version; a reader that meets another version (or garbage) ignores the column
// (`parseWorkoutDetails` returns null) instead of guessing. Everything except `v`, `source` and `fetchedAt` is optional: a value
// Garmin did not report is ABSENT (never 0, never null).
//
//   {
//     "v": 1,
//     "source": "garmin",
//     "level": "summary" | "full",     // summary: from the activity LIST during a sync (no extra request); full: from the
//                                      // per-activity endpoints. Absent = full.
//     "fetchedAt": "2026-11-10T09:12:44.000Z",
//     "typeKey": "strength_training",  // Garmin's activity type key
//     "avgHr": 128, "maxHr": 171, "minHr": 72,                       // bpm
//     "hrZones": [{ "zone": 1, "seconds": 300, "lowBpm": 95 }, ...], // time in each zone (1 = easiest)
//     "distanceM": 5012.4, "elevationGainM": 38, "avgSpeedMps": 2.78, "avgPaceSecPerKm": 360,
//     "trainingEffect": { "aerobic": 3.1, "anaerobic": 1.2 },
//     "calories": 412, "activeCalories": 318,
//     "sets": [{ "exercise": "Bench press", "guess": true, "reps": 8, "weightKg": 60, "durationSec": 31, "restSec": 90 }, ...],
//     "laps": [{ "index": 1, "distanceM": 1000, "durationSec": 360, "avgHr": 150, "paceSecPerKm": 360 }, ...]   // at most 20
//   }
//
// `sets[].exercise` is Garmin's own GUESS from wrist motion (reference: strength.rs); `guess: true` says so. `weightKg` exists only
// when the load was typed into Garmin Connect by hand. Both are usually absent, which is normal.
//
// Pure: no I/O, no clock. Imported by the app (screens, coach context) and by the mappers of this package.

import { isObject, toFiniteNumber } from './pick';

export const WORKOUT_DETAILS_VERSION = 1;
/** Laps kept in the stored details. */
export const MAX_LAPS = 20;
/** Work sets kept in the stored details (a very long session still fits in a few kilobytes). */
export const MAX_SETS = 120;
export const MAX_ZONES = 7;

export interface WorkoutHrZone {
  /** 1 (easiest) to 5 (some watches report up to 7). */
  zone: number;
  seconds: number;
  /** Lower boundary of the zone in bpm, when Garmin sent it. */
  lowBpm?: number;
}

export interface WorkoutSet {
  /** Human name ("Bench press"), absent for a set the watch could not identify. */
  exercise?: string;
  /** True when `exercise` is the watch's guess (it always is for Garmin). */
  guess?: boolean;
  reps?: number;
  weightKg?: number;
  durationSec?: number;
  /** Rest after this set. */
  restSec?: number;
}

export interface WorkoutLap {
  index: number;
  distanceM?: number;
  durationSec?: number;
  avgHr?: number;
  maxHr?: number;
  paceSecPerKm?: number;
  elevationGainM?: number;
}

export interface WorkoutDetailsV1 {
  v: 1;
  source: 'garmin';
  level?: 'summary' | 'full';
  /** ISO timestamp of the read. */
  fetchedAt: string;
  typeKey?: string;
  avgHr?: number;
  maxHr?: number;
  minHr?: number;
  hrZones?: WorkoutHrZone[];
  distanceM?: number;
  elevationGainM?: number;
  avgSpeedMps?: number;
  avgPaceSecPerKm?: number;
  trainingEffect?: { aerobic?: number; anaerobic?: number };
  calories?: number;
  activeCalories?: number;
  sets?: WorkoutSet[];
  laps?: WorkoutLap[];
}

export type WorkoutDetails = WorkoutDetailsV1;

/** `fetchedAt` of a read whose time was missing or unreadable: old enough that it is always re-read. */
export const UNKNOWN_FETCHED_AT = '1970-01-01T00:00:00.000Z';

// ---------------------------------------------------------------------------------------------------------------------
// tolerant primitives (also used by the mappers)
// ---------------------------------------------------------------------------------------------------------------------

/** A finite number inside [min, max] (min exclusive when `above`), or undefined. Numeric strings are accepted. */
export function boundedNumber(value: unknown, min: number, max: number, options: { above?: boolean; decimals?: number } = {}): number | undefined {
  const n = toFiniteNumber(value);
  if (n === undefined) return undefined;
  if (options.above ? n <= min : n < min) return undefined;
  if (n > max) return undefined;
  if (options.decimals === undefined) return n;
  const f = 10 ** options.decimals;
  return Math.round(n * f) / f;
}

export const hrValue = (v: unknown): number | undefined => boundedNumber(v, 25, 250, { decimals: 0 });
export const lowHrValue = (v: unknown): number | undefined => boundedNumber(v, 20, 250, { decimals: 0 });
export const distanceValue = (v: unknown): number | undefined => boundedNumber(v, 0, 5_000_000, { above: true, decimals: 1 });
export const elevationValue = (v: unknown): number | undefined => boundedNumber(v, 0, 20_000, { above: true, decimals: 0 });
export const speedValue = (v: unknown): number | undefined => boundedNumber(v, 0, 100, { above: true, decimals: 3 });
export const kcalValue = (v: unknown): number | undefined => boundedNumber(v, 0, 20_000, { above: true, decimals: 0 });
export const effectValue = (v: unknown): number | undefined => boundedNumber(v, 0, 5, { decimals: 1 });
export const secondsValue = (v: unknown, max = 7 * 86_400): number | undefined => boundedNumber(v, 0, max, { decimals: 0 });

/** Pace in seconds per kilometre from a distance and a time; undefined when either is missing or the distance is below 10 m. */
export function paceFromDistance(distanceM: number | undefined, durationSec: number | undefined): number | undefined {
  if (distanceM === undefined || durationSec === undefined || distanceM < 10 || durationSec <= 0) return undefined;
  return paceValue((durationSec / distanceM) * 1000);
}

/** Pace in seconds per kilometre from a speed in m/s. */
export function paceFromSpeed(mps: number | undefined): number | undefined {
  if (mps === undefined || mps <= 0) return undefined;
  return paceValue(1000 / mps);
}

/** A pace slower than 1 hour per km or faster than 1:00 per km is not a pace anybody ran (it is a pause or a unit error). */
function paceValue(secPerKm: number): number | undefined {
  return secPerKm >= 60 && secPerKm <= 3600 ? Math.round(secPerKm) : undefined;
}

/** 'garmin:activity:12345' -> '12345' (the id the Connect endpoints take). Null for anything else. */
export function garminActivityIdOf(externalId: string | null | undefined): string | null {
  if (typeof externalId !== 'string') return null;
  const m = /^garmin:activity:(\d{1,19})$/.exec(externalId.trim());
  return m ? (m[1] as string) : null;
}

/** 'BENCH_PRESS' -> 'Bench press'. */
export function humanizeExerciseName(category: string): string {
  const s = category.replace(/_/g, ' ').trim().toLowerCase();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/** Running, walking, hiking: the sports a pace (min/km) means something for. Others show a speed. */
export function isPacedKey(typeKey: string | undefined): boolean {
  return /run|walk|hik/.test((typeKey ?? '').toLowerCase());
}

/**
 * Whether Garmin records sets for this kind of session (strength, HIIT, ...): decides if the exerciseSets call is worth a request.
 * The type key decides; the name is only used when Garmin gave no key. (Table: reference sport.rs, the "Gym" family.)
 */
export function isStrengthLike(typeKey: string | undefined, name?: string): boolean {
  const key = (typeKey ?? '').toLowerCase();
  if (key) return /strength|hiit|crossfit|jump_rope|cardio_training|functional|circuit|weight/.test(key);
  return /strength|weight|gym|hiit|crossfit|circuit/i.test(name ?? '');
}

// ---------------------------------------------------------------------------------------------------------------------
// parse (what comes out of the database column)
// ---------------------------------------------------------------------------------------------------------------------

function parseIso(value: unknown): string {
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  }
  return UNKNOWN_FETCHED_AT;
}

function parseZones(value: unknown): WorkoutHrZone[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const byZone = new Map<number, WorkoutHrZone>();
  for (const item of value) {
    if (!isObject(item)) continue;
    const zone = boundedNumber(item.zone, 1, MAX_ZONES, { decimals: 0 });
    const seconds = secondsValue(item.seconds, 86_400);
    if (zone === undefined || seconds === undefined) continue;
    const lowBpm = lowHrValue(item.lowBpm);
    byZone.set(zone, { zone, seconds, ...(lowBpm !== undefined ? { lowBpm } : {}) });
  }
  const zones = [...byZone.values()].sort((a, b) => a.zone - b.zone);
  return zones.length > 0 && zones.some((z) => z.seconds > 0) ? zones : undefined;
}

function parseSets(value: unknown): WorkoutSet[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sets: WorkoutSet[] = [];
  for (const item of value) {
    if (sets.length >= MAX_SETS) break;
    if (!isObject(item)) continue;
    const exercise = typeof item.exercise === 'string' && item.exercise.trim() ? item.exercise.trim().slice(0, 60) : undefined;
    const reps = boundedNumber(item.reps, 0, 2000, { decimals: 0 });
    const weightKg = boundedNumber(item.weightKg, 0, 1000, { above: true, decimals: 2 });
    const durationSec = secondsValue(item.durationSec, 7200);
    const restSec = secondsValue(item.restSec, 7200);
    if (exercise === undefined && reps === undefined && durationSec === undefined) continue;
    sets.push({
      ...(exercise !== undefined ? { exercise } : {}),
      ...(exercise !== undefined && item.guess === true ? { guess: true } : {}),
      ...(reps !== undefined ? { reps } : {}),
      ...(weightKg !== undefined ? { weightKg } : {}),
      ...(durationSec !== undefined ? { durationSec } : {}),
      ...(restSec !== undefined ? { restSec } : {}),
    });
  }
  return sets.length > 0 ? sets : undefined;
}

function parseLaps(value: unknown): WorkoutLap[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const laps: WorkoutLap[] = [];
  for (const item of value) {
    if (laps.length >= MAX_LAPS) break;
    if (!isObject(item)) continue;
    const durationSec = secondsValue(item.durationSec);
    const distanceM = distanceValue(item.distanceM);
    if (durationSec === undefined && distanceM === undefined) continue;
    const avgHr = hrValue(item.avgHr);
    const maxHr = hrValue(item.maxHr);
    const paceSecPerKm = boundedNumber(item.paceSecPerKm, 60, 3600, { decimals: 0 });
    const elevationGainM = elevationValue(item.elevationGainM);
    laps.push({
      index: boundedNumber(item.index, 1, 10_000, { decimals: 0 }) ?? laps.length + 1,
      ...(distanceM !== undefined ? { distanceM } : {}),
      ...(durationSec !== undefined ? { durationSec } : {}),
      ...(avgHr !== undefined ? { avgHr } : {}),
      ...(maxHr !== undefined ? { maxHr } : {}),
      ...(paceSecPerKm !== undefined ? { paceSecPerKm } : {}),
      ...(elevationGainM !== undefined ? { elevationGainM } : {}),
    });
  }
  return laps.length > 0 ? laps : undefined;
}

/**
 * Reads the `details` column tolerantly. Returns the canonical object (unknown keys dropped, out-of-range values dropped, arrays
 * capped) or null when there is nothing usable: not an object, another version, another source. Never throws.
 */
export function parseWorkoutDetails(raw: unknown): WorkoutDetails | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!isObject(value)) return null;
  if (toFiniteNumber(value.v) !== WORKOUT_DETAILS_VERSION) return null;
  if (value.source !== 'garmin') return null;

  const avgHr = hrValue(value.avgHr);
  let maxHr = hrValue(value.maxHr);
  if (maxHr !== undefined && avgHr !== undefined && maxHr < avgHr) maxHr = undefined;
  let minHr = lowHrValue(value.minHr);
  if (minHr !== undefined && avgHr !== undefined && minHr > avgHr) minHr = undefined;
  const hrZones = parseZones(value.hrZones);
  const distanceM = distanceValue(value.distanceM);
  const elevationGainM = elevationValue(value.elevationGainM);
  const avgSpeedMps = speedValue(value.avgSpeedMps);
  const avgPaceSecPerKm = boundedNumber(value.avgPaceSecPerKm, 60, 3600, { decimals: 0 });
  const te = isObject(value.trainingEffect) ? value.trainingEffect : null;
  const aerobic = te ? effectValue(te.aerobic) : undefined;
  const anaerobic = te ? effectValue(te.anaerobic) : undefined;
  const calories = kcalValue(value.calories);
  const activeCalories = kcalValue(value.activeCalories);
  const sets = parseSets(value.sets);
  const laps = parseLaps(value.laps);
  const typeKey = typeof value.typeKey === 'string' && /^[a-z0-9_]{1,60}$/i.test(value.typeKey.trim()) ? value.typeKey.trim().toLowerCase() : undefined;

  return {
    v: 1,
    source: 'garmin',
    ...(value.level === 'summary' ? { level: 'summary' as const } : { level: 'full' as const }),
    fetchedAt: parseIso(value.fetchedAt),
    ...(typeKey !== undefined ? { typeKey } : {}),
    ...(avgHr !== undefined ? { avgHr } : {}),
    ...(maxHr !== undefined ? { maxHr } : {}),
    ...(minHr !== undefined ? { minHr } : {}),
    ...(hrZones ? { hrZones } : {}),
    ...(distanceM !== undefined ? { distanceM } : {}),
    ...(elevationGainM !== undefined ? { elevationGainM } : {}),
    ...(avgSpeedMps !== undefined ? { avgSpeedMps } : {}),
    ...(avgPaceSecPerKm !== undefined ? { avgPaceSecPerKm } : {}),
    ...(aerobic !== undefined || anaerobic !== undefined
      ? { trainingEffect: { ...(aerobic !== undefined ? { aerobic } : {}), ...(anaerobic !== undefined ? { anaerobic } : {}) } }
      : {}),
    ...(calories !== undefined ? { calories } : {}),
    ...(activeCalories !== undefined ? { activeCalories } : {}),
    ...(sets ? { sets } : {}),
    ...(laps ? { laps } : {}),
  };
}

/** True when the details carry at least one value beyond the envelope. */
export function hasWorkoutData(details: WorkoutDetails | null | undefined): boolean {
  if (!details) return false;
  const { v: _v, source: _s, level: _l, fetchedAt: _f, typeKey: _t, ...rest } = details;
  return Object.values(rest).some((x) => x !== undefined);
}

/** The JSON to store: the canonical form (round-tripped through the parser), so nothing unvalidated reaches the database. */
export function toStoredDetails(details: WorkoutDetails): WorkoutDetails | null {
  return parseWorkoutDetails(JSON.parse(JSON.stringify(details)) as unknown);
}

// ---------------------------------------------------------------------------------------------------------------------
// when to read (again)
// ---------------------------------------------------------------------------------------------------------------------

export const DETAILS_MAX_AGE_MS = 24 * 3_600_000;
/** After this many days a workout no longer changes on Garmin's side, so stored details are not read again just for being old. */
export const DETAILS_STABLE_AFTER_DAYS = 7;

export interface DetailsCandidate {
  source: string;
  external_id: string | null;
  details: unknown;
  /** ISO start of the workout, or null. */
  started_at: string | null;
  /** YYYY-MM-DD of the workout. */
  entry_date: string;
}

/**
 * Whether the per-activity endpoints should be read for this row now.
 *  - not a Garmin workout with a usable activity id: never
 *  - nothing stored, an unreadable value, or only the list summary: yes
 *  - full details are used as they are, unless they are older than a day AND the workout is still recent (< 7 days): Garmin
 *    refines a session for a while (training effect, a weight typed into Connect), after that it is stable
 */
export function needsGarminDetails(row: DetailsCandidate, nowMs: number): boolean {
  if (row.source !== 'garmin' || garminActivityIdOf(row.external_id) === null) return false;
  const details = parseWorkoutDetails(row.details);
  if (!details || details.level === 'summary') return true;
  const fetchedMs = Date.parse(details.fetchedAt);
  if (!Number.isFinite(fetchedMs) || fetchedMs <= 0) return true;
  if (nowMs - fetchedMs < DETAILS_MAX_AGE_MS) return false;
  const startedMs = row.started_at ? Date.parse(row.started_at) : Date.parse(`${row.entry_date}T12:00:00Z`);
  if (!Number.isFinite(startedMs)) return false;
  return nowMs - startedMs < DETAILS_STABLE_AFTER_DAYS * 86_400_000;
}
