// Tolerant mappers for ONE activity: the per-activity endpoints (and the activity list's own summary fields) -> pieces of
// {@link WorkoutDetails}. Same rules as mappers.ts: they never throw, a missing value stays absent (never 0), candidates are tried
// in order, and what could not be found is reported (key NAMES and counts only, never a value) through the FieldTracker.
//
// FIELD NAMES. VERIFIED = read from the reference project (garmin-companion, crates/garmin-core/src/{client,strength,analysis,
// sport}.rs, where the structs were written against real replies); GUESS = the usual Garmin Connect spelling, tried after the
// verified name. No real reply of the per-activity endpoints was available when this was written.
//
//   LIST (activitylist-service)   VERIFIED (client.rs ActivitySummary): activityId, activityType.typeKey, distance (m), duration
//                                 (s), averageHR, maxHR (note the capitals), averageSpeed (m/s), calories, aerobicTrainingEffect,
//                                 anaerobicTrainingEffect, elevationGain (m), hrTimeInZone_1..5 (seconds per zone)
//   GET /activity-service/activity/{id}
//                                 VERIFIED: a `summaryDTO` block exists (client.rs doc comment). GUESS: the names inside it. The
//                                 ones that are also list fields (averageHR, maxHR, ...) are expected to be spelled the same.
//                                 GUESS: activityTypeDTO.typeKey, summaryDTO.minHR, summaryDTO.trainingEffect, bmrCalories.
//   GET .../hrTimeInZones         VERIFIED (client.rs HrZoneBucket): [{ zoneNumber, secsInZone, zoneLowBoundary }]
//   GET .../exerciseSets          VERIFIED (strength.rs): { exerciseSets: [{ messageIndex, setType: 'ACTIVE'|'REST', duration (s),
//                                 repetitionCount, weight (GRAMS, usually null), exercises: [{ category, probability 0-100 }] }] }
//   GET .../splits                VERIFIED (analysis.rs extract_laps): { lapDTOs: [{ lapIndex, distance, duration, averageHR, maxHR,
//                                 elevationGain }] }

import {
  FieldTracker,
  extractItems,
  isObject,
  pickNumber,
  pickString,
  round,
  type Obj,
} from './pick';
import type { GarminMap } from './normalized';
import {
  MAX_LAPS,
  MAX_SETS,
  boundedNumber,
  distanceValue,
  effectValue,
  elevationValue,
  hrValue,
  humanizeExerciseName,
  isPacedKey,
  kcalValue,
  paceFromDistance,
  paceFromSpeed,
  secondsValue,
  speedValue,
  type WorkoutDetails,
  type WorkoutHrZone,
  type WorkoutLap,
  type WorkoutSet,
} from './workout-details';

export const DETAIL_FIELD_CANDIDATES = {
  /** GET /activity-service/activity/{id} */
  summary: {
    typeKey: ['activityTypeDTO.typeKey', 'activityType.typeKey', 'typeKey'],
    avgHr: ['summaryDTO.averageHR', 'averageHR', 'summaryDTO.averageHeartRate'],
    maxHr: ['summaryDTO.maxHR', 'maxHR', 'summaryDTO.maxHeartRate'],
    minHr: ['summaryDTO.minHR', 'minHR', 'summaryDTO.minHeartRate'],
    distance: ['summaryDTO.distance', 'distance'],
    duration: ['summaryDTO.duration', 'duration'],
    elevationGain: ['summaryDTO.elevationGain', 'elevationGain'],
    avgSpeed: ['summaryDTO.averageSpeed', 'averageSpeed', 'summaryDTO.averageMovingSpeed'],
    calories: ['summaryDTO.calories', 'calories'],
    bmrCalories: ['summaryDTO.bmrCalories', 'bmrCalories'],
    aerobicTe: ['summaryDTO.trainingEffect', 'summaryDTO.aerobicTrainingEffect', 'aerobicTrainingEffect'],
    anaerobicTe: ['summaryDTO.anaerobicTrainingEffect', 'anaerobicTrainingEffect'],
  },
  /** GET /activity-service/activity/{id}/hrTimeInZones */
  zones: {
    zone: ['zoneNumber', 'zone'],
    seconds: ['secsInZone', 'secondsInZone', 'timeInZone'],
    low: ['zoneLowBoundary', 'lowBoundary'],
  },
  /** GET /activity-service/activity/{id}/exerciseSets */
  sets: {
    type: ['setType'],
    duration: ['duration'],
    reps: ['repetitionCount', 'reps'],
    weight: ['weight'],
    index: ['messageIndex'],
  },
  /** GET /activity-service/activity/{id}/splits */
  laps: {
    index: ['lapIndex'],
    distance: ['distance'],
    duration: ['duration'],
    avgHr: ['averageHR'],
    maxHr: ['maxHR'],
    elevation: ['elevationGain'],
  },
} as const;

const LIST_ZONE_KEYS = ['hrTimeInZone_1', 'hrTimeInZone_2', 'hrTimeInZone_3', 'hrTimeInZone_4', 'hrTimeInZone_5'] as const;

// ---------------------------------------------------------------------------------------------------------------------
// the activity LIST (no extra request): a "summary" level read from the fields the sync already downloads
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Details from one item of the activity list: heart rate, time in zones, training effect, speed, climb, calories. Costs no
 * request (the list is read by every sync anyway). Undefined when the item carries nothing beyond its type.
 */
export function detailsFromListItem(it: Obj, nowMs: number): WorkoutDetails | undefined {
  const typeKey = pickString(it, ['activityType.typeKey', 'activityTypeDTO.typeKey', 'typeKey'])?.toLowerCase();
  const avgHr = hrValue(pickNumber(it, ['averageHR']));
  let maxHr = hrValue(pickNumber(it, ['maxHR']));
  if (maxHr !== undefined && avgHr !== undefined && maxHr < avgHr) maxHr = undefined;

  const zones: WorkoutHrZone[] = [];
  LIST_ZONE_KEYS.forEach((key, i) => {
    const seconds = secondsValue(pickNumber(it, [key]), 86_400);
    if (seconds !== undefined) zones.push({ zone: i + 1, seconds });
  });
  const hrZones = zones.some((z) => z.seconds > 0) ? zones : undefined;

  const aerobic = effectValue(pickNumber(it, ['aerobicTrainingEffect']));
  const anaerobic = effectValue(pickNumber(it, ['anaerobicTrainingEffect']));
  const distanceM = distanceValue(pickNumber(it, ['distance']));
  const elevationGainM = elevationValue(pickNumber(it, ['elevationGain']));
  const avgSpeedMps = speedValue(pickNumber(it, ['averageSpeed']));
  const calories = kcalValue(pickNumber(it, ['calories']));
  const avgPaceSecPerKm = isPacedKey(typeKey) ? paceFromSpeed(avgSpeedMps) : undefined;

  const out: WorkoutDetails = {
    v: 1,
    source: 'garmin',
    level: 'summary',
    fetchedAt: new Date(nowMs).toISOString(),
    ...(typeKey ? { typeKey } : {}),
    ...(avgHr !== undefined ? { avgHr } : {}),
    ...(maxHr !== undefined ? { maxHr } : {}),
    ...(hrZones ? { hrZones } : {}),
    ...(distanceM !== undefined ? { distanceM } : {}),
    ...(elevationGainM !== undefined ? { elevationGainM } : {}),
    ...(avgSpeedMps !== undefined ? { avgSpeedMps } : {}),
    ...(avgPaceSecPerKm !== undefined ? { avgPaceSecPerKm } : {}),
    ...(aerobic !== undefined || anaerobic !== undefined
      ? { trainingEffect: { ...(aerobic !== undefined ? { aerobic } : {}), ...(anaerobic !== undefined ? { anaerobic } : {}) } }
      : {}),
    ...(calories !== undefined ? { calories } : {}),
  };
  const { v: _v, source: _s, level: _l, fetchedAt: _f, typeKey: _t, ...rest } = out;
  return Object.values(rest).some((x) => x !== undefined) ? out : undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// GET /activity-service/activity/{id}
// ---------------------------------------------------------------------------------------------------------------------

export type DetailPart = Partial<Omit<WorkoutDetails, 'v' | 'source' | 'level' | 'fetchedAt'>>;

export interface MappedActivity extends GarminMap {
  part: DetailPart;
}

function singleObject(raw: unknown, t: FieldTracker): Obj | null {
  if (isObject(raw)) return raw;
  if (Array.isArray(raw) && raw.length > 0 && isObject(raw[0])) return raw[0];
  if (raw !== null && raw !== undefined) t.note('$', 'unexpected_shape', `expected an object, got ${Array.isArray(raw) ? 'an array' : typeof raw}`);
  return null;
}

/** The summary block of one activity: type, heart rate, distance, speed, climb, calories, training effect. */
export function mapActivitySummary(raw: unknown): MappedActivity {
  const t = new FieldTracker('activity');
  const c = DETAIL_FIELD_CANDIDATES.summary;
  const obj = singleObject(raw, t);
  const part: DetailPart = {};
  if (obj) {
    t.item();
    const o = { optional: true };
    const typeKey = t.string(obj, 'typeKey', c.typeKey, o)?.toLowerCase();
    const avgHr = t.rounded(obj, 'avgHr', c.avgHr, { ...o, min: 25, max: 250, decimals: 0 });
    let maxHr = t.rounded(obj, 'maxHr', c.maxHr, { ...o, min: 25, max: 250, decimals: 0 });
    if (maxHr !== undefined && avgHr !== undefined && maxHr < avgHr) maxHr = undefined;
    const minHr = t.rounded(obj, 'minHr', c.minHr, { ...o, min: 20, max: 250, decimals: 0 });
    const distanceM = t.rounded(obj, 'distanceM', c.distance, { ...o, min: 0, minExclusive: true, max: 5_000_000 });
    const durationSec = t.rounded(obj, 'durationSec', c.duration, { ...o, min: 0, minExclusive: true, max: 7 * 86_400 });
    const elevationGainM = t.rounded(obj, 'elevationGainM', c.elevationGain, { ...o, min: 0, minExclusive: true, max: 20_000 });
    const avgSpeedMps = t.rounded(obj, 'avgSpeedMps', c.avgSpeed, { ...o, min: 0, minExclusive: true, max: 100 });
    const calories = t.rounded(obj, 'calories', c.calories, { ...o, min: 0, minExclusive: true, max: 20_000, decimals: 0 });
    const bmr = t.rounded(obj, 'bmrCalories', c.bmrCalories, { ...o, min: 0, minExclusive: true, max: 20_000, decimals: 0 });
    const aerobic = t.rounded(obj, 'aerobicTrainingEffect', c.aerobicTe, { ...o, min: 0, max: 5, decimals: 1 });
    const anaerobic = t.rounded(obj, 'anaerobicTrainingEffect', c.anaerobicTe, { ...o, min: 0, max: 5, decimals: 1 });

    // Active energy: the activity's total minus the resting burn Garmin credits to the same minutes (GUESS: bmrCalories).
    const activeCalories = calories !== undefined && bmr !== undefined && calories > bmr ? Math.round(calories - bmr) : undefined;
    if (activeCalories !== undefined) t.note('activeCalories', 'fallback_used', 'activeCalories = calories - bmrCalories');
    const distance = distanceM !== undefined ? round(distanceM, 1) : undefined;
    const speed = avgSpeedMps !== undefined ? round(avgSpeedMps, 3) : undefined;
    const pace = isPacedKey(typeKey) ? (paceFromSpeed(speed) ?? paceFromDistance(distance, durationSec)) : undefined;

    if (typeKey) part.typeKey = typeKey;
    if (avgHr !== undefined) part.avgHr = avgHr;
    if (maxHr !== undefined) part.maxHr = maxHr;
    if (minHr !== undefined && (avgHr === undefined || minHr <= avgHr)) part.minHr = minHr;
    if (distance !== undefined) part.distanceM = distance;
    if (elevationGainM !== undefined) part.elevationGainM = Math.round(elevationGainM);
    if (speed !== undefined) part.avgSpeedMps = speed;
    if (pace !== undefined) part.avgPaceSecPerKm = pace;
    if (aerobic !== undefined || anaerobic !== undefined) {
      part.trainingEffect = { ...(aerobic !== undefined ? { aerobic } : {}), ...(anaerobic !== undefined ? { anaerobic } : {}) };
    }
    if (calories !== undefined) part.calories = calories;
    if (activeCalories !== undefined) part.activeCalories = activeCalories;
  }
  return { part, diagnostics: t.diagnostics(), coverage: t.coverage() };
}

// ---------------------------------------------------------------------------------------------------------------------
// GET /activity-service/activity/{id}/hrTimeInZones
// ---------------------------------------------------------------------------------------------------------------------

export interface MappedZones extends GarminMap {
  zones: WorkoutHrZone[];
}

export function mapHrZones(raw: unknown): MappedZones {
  const t = new FieldTracker('activityZones');
  const c = DETAIL_FIELD_CANDIDATES.zones;
  const byZone = new Map<number, WorkoutHrZone>();
  const items = extractItems(raw, t, { keys: ['hrTimeInZones', 'zones', 'data', 'items'], itemHints: ['zoneNumber'] });
  for (const it of items) {
    t.item();
    const zone = t.rounded(it, 'zoneNumber', c.zone, { min: 1, max: 7, decimals: 0 });
    const seconds = t.rounded(it, 'secsInZone', c.seconds, { min: 0, max: 86_400, decimals: 0 });
    if (zone === undefined || seconds === undefined) continue;
    const low = t.rounded(it, 'zoneLowBoundary', c.low, { optional: true, min: 20, max: 250, decimals: 0 });
    byZone.set(zone, { zone, seconds, ...(low !== undefined ? { lowBpm: low } : {}) });
  }
  const zones = [...byZone.values()].sort((a, b) => a.zone - b.zone);
  return { zones: zones.some((z) => z.seconds > 0) ? zones : [], diagnostics: t.diagnostics(), coverage: t.coverage() };
}

// ---------------------------------------------------------------------------------------------------------------------
// GET /activity-service/activity/{id}/exerciseSets
// ---------------------------------------------------------------------------------------------------------------------

/** How sure the watch has to be (0-100) before its guess of the exercise is used (reference: strength.rs GUESS_FLOOR_PCT). */
export const GUESS_FLOOR_PCT = 50;
/** How far the best guess has to be clear of the runner-up; a tie is no guess (reference: GUESS_MARGIN_PCT). */
export const GUESS_MARGIN_PCT = 0.01;

/** The watch's best guess of the exercise of one set, or undefined (UNKNOWN, below the floor, or a tie). */
export function bestExerciseGuess(exercises: unknown): string | undefined {
  if (!Array.isArray(exercises)) return undefined;
  const candidates: { category: string; probability: number }[] = [];
  for (const e of exercises) {
    if (!isObject(e)) continue;
    const category = typeof e.category === 'string' ? e.category : undefined;
    const probability = boundedNumber(e.probability, 0, 100);
    if (!category || category.toUpperCase() === 'UNKNOWN' || probability === undefined || probability < GUESS_FLOOR_PCT) continue;
    candidates.push({ category, probability });
  }
  candidates.sort((a, b) => b.probability - a.probability);
  const [top, next] = candidates;
  if (!top) return undefined;
  if (next && top.probability - next.probability <= GUESS_MARGIN_PCT) return undefined;
  return humanizeExerciseName(top.category) || undefined;
}

export interface MappedSets extends GarminMap {
  sets: WorkoutSet[];
}

/**
 * Work sets in session order, each with the rest that followed it. Reliable: reps, duration, order. Not reliable: the exercise
 * (the watch guesses from wrist motion; unlabelled sets are normal) and the weight (grams, usually null).
 */
export function mapExerciseSets(raw: unknown): MappedSets {
  const t = new FieldTracker('activitySets');
  const c = DETAIL_FIELD_CANDIDATES.sets;
  const entries = extractItems(raw, t, { keys: ['exerciseSets', 'sets', 'data', 'items'], itemHints: ['setType', 'repetitionCount'] });

  // Garmin's own numbering is trusted only when it is unique (reference: strength.rs parse_sets); otherwise the array order is.
  const numbered = entries.map((e, i) => ({ e, index: pickNumber(e, c.index) ?? i }));
  const unique = new Set(numbered.map((n) => n.index)).size === numbered.length;
  const ordered = unique ? [...numbered].sort((a, b) => a.index - b.index) : numbered;

  const sets: WorkoutSet[] = [];
  let lastWork: WorkoutSet | undefined;
  for (const { e } of ordered) {
    t.item();
    const type = (t.string(e, 'setType', c.type, { optional: true }) ?? 'ACTIVE').toUpperCase();
    const durationSec = t.rounded(e, 'durationSec', c.duration, { optional: true, min: 0, max: 7200, decimals: 0 });
    if (type === 'REST') {
      if (lastWork && durationSec !== undefined && lastWork.restSec === undefined) lastWork.restSec = durationSec;
      continue;
    }
    if (sets.length >= MAX_SETS) continue;
    const reps = t.rounded(e, 'repetitionCount', c.reps, { optional: true, min: 0, max: 2000, decimals: 0 });
    const grams = t.rounded(e, 'weight', c.weight, { optional: true, min: 0, minExclusive: true, max: 1_000_000 });
    const exercise = bestExerciseGuess(e.exercises);
    const weightKg = grams !== undefined ? round(grams / 1000, 2) : undefined;
    // A set with neither reps nor a duration nor a name is noise (a set the watch started and dropped).
    if (reps === undefined && durationSec === undefined && exercise === undefined) continue;
    const set: WorkoutSet = {
      ...(exercise ? { exercise, guess: true } : {}),
      ...(reps !== undefined ? { reps } : {}),
      ...(weightKg !== undefined ? { weightKg } : {}),
      ...(durationSec !== undefined ? { durationSec } : {}),
    };
    sets.push(set);
    lastWork = set;
  }
  return { sets, diagnostics: t.diagnostics(), coverage: t.coverage() };
}

// ---------------------------------------------------------------------------------------------------------------------
// GET /activity-service/activity/{id}/splits
// ---------------------------------------------------------------------------------------------------------------------

export interface MappedLaps extends GarminMap {
  laps: WorkoutLap[];
}

export function mapSplits(raw: unknown): MappedLaps {
  const t = new FieldTracker('activitySplits');
  const c = DETAIL_FIELD_CANDIDATES.laps;
  const items = extractItems(raw, t, { keys: ['lapDTOs', 'laps', 'splits', 'data'], itemHints: ['lapIndex'] });
  const laps: WorkoutLap[] = [];
  for (const [i, it] of items.entries()) {
    t.item();
    const durationSec = t.rounded(it, 'durationSec', c.duration, { min: 0, minExclusive: true, max: 7 * 86_400, decimals: 0 });
    if (durationSec === undefined) continue; // reference: laps without a duration are dropped
    if (laps.length >= MAX_LAPS) continue;
    const o = { optional: true };
    const distanceM = t.rounded(it, 'distanceM', c.distance, { ...o, min: 0, minExclusive: true, max: 5_000_000, decimals: 1 });
    const avgHr = t.rounded(it, 'avgHr', c.avgHr, { ...o, min: 25, max: 250, decimals: 0 });
    const maxHr = t.rounded(it, 'maxHr', c.maxHr, { ...o, min: 25, max: 250, decimals: 0 });
    const elevationGainM = t.rounded(it, 'elevationGainM', c.elevation, { ...o, min: 0, minExclusive: true, max: 20_000, decimals: 0 });
    const index = t.rounded(it, 'lapIndex', c.index, { ...o, min: 1, max: 10_000, decimals: 0 }) ?? i + 1;
    const pace = paceFromDistance(distanceM, durationSec);
    laps.push({
      index,
      ...(distanceM !== undefined ? { distanceM } : {}),
      durationSec,
      ...(avgHr !== undefined ? { avgHr } : {}),
      ...(maxHr !== undefined && (avgHr === undefined || maxHr >= avgHr) ? { maxHr } : {}),
      ...(pace !== undefined ? { paceSecPerKm: pace } : {}),
      ...(elevationGainM !== undefined ? { elevationGainM } : {}),
    });
  }
  return { laps, diagnostics: t.diagnostics(), coverage: t.coverage() };
}
