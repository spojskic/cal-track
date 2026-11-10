// Text and numbers of the Workouts screens as plain functions (no React), so they are unit tested in tools/ui-smoke and shared with
// the coach's workout context (ai/workout-context-text.ts). Locale independent and Hermes safe (no Intl).
import { formatWeight, kgToLb, type UnitSystem } from '@cal/core';
import type { WorkoutHrZone, WorkoutSet } from '@cal/garmin';

const KM_PER_MILE = 1.609344;
const M_PER_FOOT = 0.3048;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Rounds to `dp` decimals and drops trailing zeros ("5", "5.01"). */
export function trimNum(value: number, dp = 1): string {
  const r = Number(value.toFixed(dp));
  return String(Object.is(r, -0) ? 0 : r);
}

/** 3725 -> "1 h 02 min"; 2700 -> "45 min"; 40 -> "40 s". Seconds are rounded to the nearest minute from one minute on. */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds) || totalSeconds < 0) return '-';
  if (totalSeconds < 59.5) return `${Math.round(totalSeconds)} s`;
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  return `${h} h ${pad2(minutes % 60)} min`;
}

/** A rest between sets: "90 s" (whole seconds up to 3 minutes), "4 min" beyond. */
export function formatRest(seconds: number): string {
  return seconds < 180 ? `${Math.round(seconds)} s` : formatDuration(seconds);
}

/** A lap time: "6:00", "1:02:15". */
export function formatClockDuration(totalSeconds: number): string {
  const secs = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** Minutes (the exercise_entries column, may be fractional) as a duration. */
export function formatMinutes(minutes: number | null | undefined): string {
  return minutes === null || minutes === undefined ? '-' : formatDuration(minutes * 60);
}

/** Time in a heart-rate zone: "12 min", "<1 min", "0 min". */
export function formatZoneTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 min';
  if (seconds < 30) return '<1 min';
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

/** 5012.4 -> "5.01 km" (imperial "3.11 mi"); below 1 km "850 m" (imperial "0.35 mi"). */
export function formatDistance(meters: number, system: UnitSystem = 'metric'): string {
  if (system === 'imperial') return `${trimNum(meters / 1000 / KM_PER_MILE, 2)} mi`;
  return meters >= 1000 ? `${trimNum(meters / 1000, 2)} km` : `${Math.round(meters)} m`;
}

/** Pace from seconds per kilometre: "6:00 /km" (imperial "9:40 /mi"). */
export function formatPace(secPerKm: number, system: UnitSystem = 'metric'): string {
  const secs = Math.round(system === 'imperial' ? secPerKm * KM_PER_MILE : secPerKm);
  return `${Math.floor(secs / 60)}:${pad2(secs % 60)} /${system === 'imperial' ? 'mi' : 'km'}`;
}

/** Speed from metres per second: "10.0 km/h" (imperial "6.2 mph"). */
export function formatSpeed(mps: number, system: UnitSystem = 'metric'): string {
  return system === 'imperial' ? `${trimNum((mps * 3.6) / KM_PER_MILE, 1)} mph` : `${trimNum(mps * 3.6, 1)} km/h`;
}

/** Climb: "38 m" (imperial "125 ft"). */
export function formatElevation(meters: number, system: UnitSystem = 'metric'): string {
  return system === 'imperial' ? `${Math.round(meters / M_PER_FOOT)} ft` : `${Math.round(meters)} m`;
}

export const formatHr = (bpm: number): string => `${Math.round(bpm)} bpm`;

/** A heart rate worth showing as a hint (rows can carry a 0 or a nonsense value). */
export function plausibleHr(bpm: unknown): number | null {
  return typeof bpm === 'number' && Number.isFinite(bpm) && bpm >= 25 && bpm <= 250 ? Math.round(bpm) : null;
}

/** Garmin's wording for a training effect score (0-5): 3.1 -> "Improving". */
export function trainingEffectLabel(value: number): string {
  if (value < 1) return 'No effect';
  if (value < 2) return 'Minor';
  if (value < 3) return 'Maintaining';
  if (value < 4) return 'Improving';
  if (value < 5) return 'Highly improving';
  return 'Overreaching';
}

export function formatKcal(kcal: number): string {
  return `${Math.round(kcal).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')} kcal`;
}

// ---------------------------------------------------------------------------------------------------------------------
// source
// ---------------------------------------------------------------------------------------------------------------------

export function sourceLabel(source: string): string {
  switch (source) {
    case 'garmin':
      return 'Garmin';
    case 'apple_health':
      return 'Apple Health';
    case 'health_connect':
      return 'Health Connect';
    default:
      return 'Manual';
  }
}

export type SourceFilter = 'all' | 'garmin' | 'health' | 'manual';

/** The filter chips. "Health" is Apple Health on an iPhone and Health Connect on Android (both are the phone's health store). */
export function sourceFilters(platform: string): { key: SourceFilter; label: string }[] {
  return [
    { key: 'all', label: 'All' },
    { key: 'garmin', label: 'Garmin' },
    { key: 'health', label: platform === 'android' ? 'Health Connect' : 'Apple Health' },
    { key: 'manual', label: 'Manual' },
  ];
}

/** The `source` values a filter lets through. */
export function sourcesOfFilter(filter: SourceFilter): readonly string[] | null {
  switch (filter) {
    case 'garmin':
      return ['garmin'];
    case 'health':
      return ['apple_health', 'health_connect'];
    case 'manual':
      return ['manual'];
    default:
      return null;
  }
}

export function matchesSourceFilter(source: string, filter: SourceFilter): boolean {
  const allowed = sourcesOfFilter(filter);
  return allowed === null || allowed.includes(source);
}

// ---------------------------------------------------------------------------------------------------------------------
// dates and times
// ---------------------------------------------------------------------------------------------------------------------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

function ymd(date: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  return match ? { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) } : null;
}

/** "Tue 10 Nov" for 2026-11-10 (the weekday is computed from the calendar date, not from a time zone). */
export function formatDayLabel(date: string): string {
  const p = ymd(date);
  if (!p) return date;
  const weekday = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${p.d} ${MONTHS_SHORT[p.m - 1]}`;
}

/** "Tuesday, 10 November 2026". */
export function formatLongDate(date: string): string {
  const p = ymd(date);
  if (!p) return date;
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()];
  return `${weekday}, ${p.d} ${MONTHS_LONG[p.m - 1]} ${p.y}`;
}

/** The phone's local "07:05" of an instant, or null. */
export function formatClockTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "07:00-07:45", just "07:00" when the end is unknown, null without a start. */
export function formatTimeRange(startedAt: string | null | undefined, endedAt: string | null | undefined): string | null {
  const start = formatClockTime(startedAt);
  if (!start) return null;
  const end = formatClockTime(endedAt);
  return end && end !== start ? `${start}\u2013${end}` : start;
}

/** "Tue 10 Nov, 07:00" (the time only when the row has a start). */
export function formatWhen(row: { entry_date: string; started_at: string | null }): string {
  const time = formatClockTime(row.started_at);
  return time ? `${formatDayLabel(row.entry_date)}, ${time}` : formatDayLabel(row.entry_date);
}

// ---------------------------------------------------------------------------------------------------------------------
// heart-rate zones
// ---------------------------------------------------------------------------------------------------------------------

export const ZONE_NAMES: Readonly<Record<number, string>> = {
  1: 'Warm-up',
  2: 'Easy',
  3: 'Aerobic',
  4: 'Threshold',
  5: 'Maximum',
};

export interface ZoneBarSegment {
  zone: number;
  name: string;
  seconds: number;
  /** Share of the time in zones, 0..1. */
  fraction: number;
  /** "12 min" */
  time: string;
  /** "Z2 Easy" */
  label: string;
  lowBpm?: number;
}

/**
 * The stacked bar of the time in each heart-rate zone: one segment per zone, in zone order, fractions that add up to 1. Empty when
 * there is no time at all. Zones with no time stay in the list (the legend shows "0 min") so the five zones are always comparable.
 */
export function zoneBar(zones: readonly WorkoutHrZone[] | undefined): ZoneBarSegment[] {
  if (!zones || zones.length === 0) return [];
  const total = zones.reduce((sum, z) => sum + Math.max(0, z.seconds), 0);
  if (total <= 0) return [];
  return [...zones]
    .sort((a, b) => a.zone - b.zone)
    .map((z) => ({
      zone: z.zone,
      name: ZONE_NAMES[z.zone] ?? `Zone ${z.zone}`,
      seconds: z.seconds,
      fraction: Math.max(0, z.seconds) / total,
      time: formatZoneTime(z.seconds),
      label: `Z${z.zone} ${ZONE_NAMES[z.zone] ?? ''}`.trim(),
      ...(z.lowBpm !== undefined ? { lowBpm: z.lowBpm } : {}),
    }));
}

/** "Z1 5 min, Z2 15 min, ..." for a sentence (accessibility label, coach text). */
export function zoneSummary(zones: readonly WorkoutHrZone[] | undefined): string {
  return zoneBar(zones)
    .map((s) => `Z${s.zone} ${s.time}`)
    .join(', ');
}

// ---------------------------------------------------------------------------------------------------------------------
// strength sets
// ---------------------------------------------------------------------------------------------------------------------

export interface SetEntry {
  count: number;
  reps?: number;
  weightKg?: number;
}

export interface SetGroup {
  /** The exercise name as the watch guessed it; undefined for sets it could not identify. */
  exercise?: string;
  guess: boolean;
  sets: number;
  reps: number;
  entries: SetEntry[];
}

const sameNumber = (a: number | undefined, b: number | undefined): boolean => a === b;

/**
 * Sets summarised per exercise, in the order the exercises first appear: 4 sets of 8 reps at 60 kg and 4 of 6 at 70 kg are
 * two entries of one group. Sets without a name form one group at the end.
 */
export function summarizeSets(sets: readonly WorkoutSet[] | undefined): SetGroup[] {
  const groups = new Map<string, SetGroup>();
  for (const s of sets ?? []) {
    const key = s.exercise ?? '';
    let group = groups.get(key);
    if (!group) {
      group = { ...(s.exercise !== undefined ? { exercise: s.exercise } : {}), guess: s.guess === true, sets: 0, reps: 0, entries: [] };
      groups.set(key, group);
    }
    group.sets += 1;
    group.reps += s.reps ?? 0;
    const entry = group.entries.find((e) => sameNumber(e.reps, s.reps) && sameNumber(e.weightKg, s.weightKg));
    if (entry) entry.count += 1;
    else group.entries.push({ count: 1, ...(s.reps !== undefined ? { reps: s.reps } : {}), ...(s.weightKg !== undefined ? { weightKg: s.weightKg } : {}) });
  }
  const named = [...groups.values()].filter((g) => g.exercise !== undefined);
  const unnamed = [...groups.values()].filter((g) => g.exercise === undefined);
  return [...named, ...unnamed];
}

/** "4 x 8 @ 60 kg" (without a weight: "4 x 8"; without reps: "4 sets"). */
export function formatSetEntry(entry: SetEntry, system: UnitSystem = 'metric'): string {
  if (entry.reps === undefined) return `${entry.count} ${entry.count === 1 ? 'set' : 'sets'}`;
  const base = `${entry.count} x ${entry.reps}`;
  return entry.weightKg !== undefined ? `${base} @ ${formatWeight(entry.weightKg, system)}` : base;
}

/** "Bench press: 4 x 8 @ 60 kg, 4 x 6 @ 70 kg" - the line for the screen and for the coach. */
export function formatSetGroup(group: SetGroup, system: UnitSystem = 'metric'): string {
  const body = group.entries.map((e) => formatSetEntry(e, system)).join(', ');
  return `${group.exercise ?? 'Sets (exercise not identified by the watch)'}: ${body}`;
}

/** Totals for the headline of the sets block: "20 sets, 168 reps". */
export function setTotals(sets: readonly WorkoutSet[] | undefined): { sets: number; reps: number; medianRestSec: number | null } {
  const list = sets ?? [];
  const rests = list.map((s) => s.restSec).filter((r): r is number => r !== undefined).sort((a, b) => a - b);
  let median: number | null = null;
  if (rests.length > 0) {
    const mid = Math.floor(rests.length / 2);
    median = rests.length % 2 === 0 ? ((rests[mid - 1] as number) + (rests[mid] as number)) / 2 : (rests[mid] as number);
  }
  return { sets: list.length, reps: list.reduce((sum, s) => sum + (s.reps ?? 0), 0), medianRestSec: median === null ? null : Math.round(median) };
}

/** A weight in the user's unit without the unit name, for tight columns. */
export const weightNumber = (kg: number, system: UnitSystem): string => trimNum(system === 'metric' ? kg : kgToLb(kg), 1);
