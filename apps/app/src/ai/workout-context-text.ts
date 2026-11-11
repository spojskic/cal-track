// The text the coach gets about ONE workout (pure: no React, no database; unit tested in tools/ui-smoke). Built by
// ai/workout-context.ts from the workout row, its device details and the user's previous workouts of the same kind.
//
// Plain text, metric units, compact (about 2,500 characters at most). It carries only data of the workout itself: no account name or
// e-mail, no notes, no tokens. The title of a Garmin workout is NOT sent (Garmin names often start with a place, "Sarajevo Running"):
// Garmin's activity type stands in for it. A workout entered by hand or read from Apple Health / Health Connect keeps its name.
//
// The last line always says what is NOT known ("No heart-rate data recorded"), so the coach does not make up a heart rate.
import type { WorkoutDetails } from '@ration/garmin';
import { isPacedKey } from '@ration/garmin';

import {
  ZONE_NAMES,
  formatClockTime,
  formatDayLabel,
  formatDistance,
  formatClockDuration,
  formatRest,
  formatElevation,
  formatMinutes,
  formatPace,
  formatSetGroup,
  formatSpeed,
  formatTimeRange,
  plausibleHr,
  setTotals,
  sourceLabel,
  summarizeSets,
  trainingEffectLabel,
  zoneSummary,
} from '@/components/workouts/format';
import { KIND_LABELS, workoutKind, type WorkoutKind } from '@/components/workouts/kinds';

export const WORKOUT_CONTEXT_MAX_CHARS = 2500;

export interface ContextWorkout {
  name: string;
  activity_code: string | null;
  minutes: number | null;
  kcal: number;
  source: string;
  entry_date: string;
  started_at: string | null;
  ended_at: string | null;
  counts_toward_energy: boolean;
  details: WorkoutDetails | null;
}

export interface PreviousWorkout {
  entry_date: string;
  started_at: string | null;
  minutes: number | null;
  kcal: number;
  avg_hr: number | null;
}

const ENDURANCE: readonly WorkoutKind[] = ['running', 'walking', 'hiking', 'cycling', 'swimming', 'rowing'];

const clean = (text: string, max: number): string => text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function humanizeTypeKey(typeKey: string): string {
  const s = typeKey.replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/** "Strength training" for a Garmin workout (from its type), the entered / imported name otherwise. */
function titleOf(w: ContextWorkout, kind: WorkoutKind): string {
  if (w.source === 'garmin') {
    const fromKey = w.details?.typeKey ? humanizeTypeKey(w.details.typeKey) : '';
    return fromKey || KIND_LABELS[kind];
  }
  return clean(w.name, 60) || KIND_LABELS[kind];
}

function timeOfDay(iso: string | null): string {
  const clock = formatClockTime(iso);
  if (!clock) return '';
  const hour = Number(clock.slice(0, 2));
  const part = hour < 5 ? 'night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';
  return part;
}

interface Section {
  key: 'head' | 'heart' | 'effect' | 'distance' | 'sets' | 'laps' | 'previous' | 'missing';
  lines: string[];
}

/** What is not known about this workout, as short sentences (the coach must not guess these). */
function missingItems(w: ContextWorkout, kind: WorkoutKind): string[] {
  const d = w.details;
  const out: string[] = [];
  const hasHr = plausibleHr(d?.avgHr) !== null || plausibleHr(d?.maxHr) !== null;
  if (!hasHr) out.push('No heart-rate data recorded');
  if (!d?.hrZones || d.hrZones.length === 0) out.push(hasHr ? 'No heart-rate zone data' : 'No time-in-zone data');
  if (w.source === 'garmin' && d?.trainingEffect === undefined) out.push('No training effect');
  if (ENDURANCE.includes(kind) && d?.distanceM === undefined) out.push('No distance recorded');
  if (kind === 'strength' && w.source === 'garmin' && (!d?.sets || d.sets.length === 0)) out.push('No set-by-set data recorded');
  if (w.source === 'garmin' && d === null) out.push('Garmin details have not been read for this workout');
  return out;
}

function build(w: ContextWorkout, previous: readonly PreviousWorkout[], opts: { laps: boolean; previousDetail: boolean; maxSetGroups: number }): Section[] {
  const d = w.details;
  const kind = workoutKind({ name: w.name, activity_code: w.activity_code, type_key: d?.typeKey ?? null });
  const sections: Section[] = [];

  // ---- head
  const head: string[] = [];
  head.push(`Workout: ${titleOf(w, kind)} (${KIND_LABELS[kind].toLowerCase()})`);
  const range = formatTimeRange(w.started_at, w.ended_at);
  const part = timeOfDay(w.started_at);
  head.push(`Date: ${formatDayLabel(w.entry_date)} ${w.entry_date.slice(0, 4)}${range ? `, ${range} local time${part ? ` (${part})` : ''}` : ''}`);
  if (w.minutes !== null && w.minutes > 0) head.push(`Duration: ${formatMinutes(w.minutes)}`);
  const active = d?.activeCalories !== undefined ? ` (${Math.round(d.activeCalories)} active)` : '';
  head.push(`Calories: ${Math.round(w.kcal)} kcal${active}`);
  head.push(
    w.source === 'manual'
      ? `Source: entered by hand${w.counts_toward_energy ? '' : ' (not counted in the energy budget)'}`
      : `Source: ${sourceLabel(w.source)}`,
  );
  sections.push({ key: 'head', lines: head });

  // ---- heart rate
  const avg = plausibleHr(d?.avgHr);
  const max = plausibleHr(d?.maxHr);
  const min = plausibleHr(d?.minHr);
  const heart: string[] = [];
  const hrBits = [avg !== null ? `average ${avg} bpm` : null, max !== null ? `max ${max} bpm` : null, min !== null ? `lowest ${min} bpm` : null].filter(Boolean);
  if (hrBits.length > 0) heart.push(`Heart rate: ${hrBits.join(', ')}`);
  if (d?.hrZones && d.hrZones.length > 0) {
    const legend = Object.entries(ZONE_NAMES)
      .map(([n, name]) => `Z${n} ${name.toLowerCase()}`)
      .join(', ');
    heart.push(`Time in heart-rate zones: ${zoneSummary(d.hrZones)} (${legend})`);
  }
  if (heart.length > 0) sections.push({ key: 'heart', lines: heart });

  // ---- training effect
  const te = d?.trainingEffect;
  const effect = [
    te?.aerobic !== undefined ? `aerobic ${te.aerobic} (${trainingEffectLabel(te.aerobic)})` : null,
    te?.anaerobic !== undefined ? `anaerobic ${te.anaerobic} (${trainingEffectLabel(te.anaerobic)})` : null,
  ].filter(Boolean);
  if (effect.length > 0) sections.push({ key: 'effect', lines: [`Training effect (Garmin, 0-5): ${effect.join(', ')}`] });

  // ---- distance, pace, climb
  const distance: string[] = [];
  const paced = d?.typeKey ? isPacedKey(d.typeKey) : kind === 'running' || kind === 'walking' || kind === 'hiking';
  if (d?.distanceM !== undefined) distance.push(`Distance: ${formatDistance(d.distanceM)}`);
  if (paced && d?.avgPaceSecPerKm !== undefined) distance.push(`Average pace: ${formatPace(d.avgPaceSecPerKm)}`);
  else if (d?.avgSpeedMps !== undefined && d.distanceM !== undefined) distance.push(`Average speed: ${formatSpeed(d.avgSpeedMps)}`);
  if (d?.elevationGainM !== undefined) distance.push(`Elevation gain: ${formatElevation(d.elevationGainM)}`);
  if (distance.length > 0) sections.push({ key: 'distance', lines: [distance.join('; ')] });

  // ---- strength sets
  if (d?.sets && d.sets.length > 0) {
    const totals = setTotals(d.sets);
    const bits = [`${totals.sets} sets`, totals.reps > 0 ? `${totals.reps} reps` : null, totals.medianRestSec !== null ? `median rest ${formatRest(totals.medianRestSec)}` : null].filter(Boolean);
    const groups = summarizeSets(d.sets);
    const shown = groups.slice(0, opts.maxSetGroups);
    const lines = [`Sets: ${bits.join(', ')}`, ...shown.map((g) => `  ${formatSetGroup(g)}`)];
    if (groups.length > shown.length) lines.push(`  ...and ${groups.length - shown.length} more exercises`);
    if (groups.some((g) => g.guess)) lines.push("  (Exercise names are the watch's guess; a weight is only present when the user typed it in.)");
    sections.push({ key: 'sets', lines });
  }

  // ---- laps
  if (opts.laps && d?.laps && d.laps.length >= 2) {
    const shown = d.laps.slice(0, 10).map((lap) => {
      const bits = [
        lap.distanceM !== undefined ? formatDistance(lap.distanceM) : null,
        lap.paceSecPerKm !== undefined ? formatPace(lap.paceSecPerKm) : lap.durationSec !== undefined ? formatClockDuration(lap.durationSec) : null,
        plausibleHr(lap.avgHr) !== null ? `${plausibleHr(lap.avgHr)} bpm` : null,
      ].filter(Boolean);
      return `${lap.index}) ${bits.join(' ')}`;
    });
    const more = d.laps.length > 10 ? `; ...and ${d.laps.length - 10} more` : '';
    sections.push({ key: 'laps', lines: [`Laps: ${shown.join('; ')}${more}`] });
  }

  // ---- previous workouts of the same kind
  if (previous.length > 0) {
    const rows = previous.slice(0, 3).map((p) => {
      const bits = [
        p.minutes !== null && p.minutes > 0 ? formatMinutes(p.minutes) : null,
        plausibleHr(p.avg_hr) !== null ? `avg ${plausibleHr(p.avg_hr)} bpm` : null,
        `${Math.round(p.kcal)} kcal`,
      ].filter(Boolean);
      return `${formatDayLabel(p.entry_date)}: ${bits.join(', ')}`;
    });
    sections.push({
      key: 'previous',
      lines: opts.previousDetail
        ? [`Previous ${rows.length} workouts of this type (newest first, for comparison):`, ...rows.map((r) => `  ${r}`)]
        : [`Previous workouts of this type (newest first): ${rows.join(' | ')}`],
    });
  } else {
    sections.push({ key: 'previous', lines: ['No earlier workouts of this type in the diary to compare with.'] });
  }

  // ---- what is not known
  const missing = missingItems(w, kind);
  sections.push({ key: 'missing', lines: [missing.length > 0 ? `Not available: ${missing.join('. ')}.` : 'Not available: nothing important is missing.'] });
  return sections;
}

const join = (sections: readonly Section[]): string => sections.flatMap((s) => s.lines).join('\n');

/**
 * The coach's description of one workout. Stays within `maxChars` by dropping the least useful parts first: the laps, then the detail
 * of the previous workouts, then exercises beyond the first six. The "Not available" line is always kept.
 */
export function buildWorkoutContext(input: { workout: ContextWorkout; previous: readonly PreviousWorkout[]; maxChars?: number }): string {
  const max = input.maxChars ?? WORKOUT_CONTEXT_MAX_CHARS;
  const attempts = [
    { laps: true, previousDetail: true, maxSetGroups: 12 },
    { laps: false, previousDetail: true, maxSetGroups: 12 },
    { laps: false, previousDetail: false, maxSetGroups: 12 },
    { laps: false, previousDetail: false, maxSetGroups: 6 },
    { laps: false, previousDetail: false, maxSetGroups: 3 },
  ];
  let text = '';
  for (const opts of attempts) {
    text = join(build(input.workout, input.previous, opts));
    if (text.length <= max) return text;
  }
  // Last resort: cut the middle, never the closing line.
  const lines = text.split('\n');
  const last = lines[lines.length - 1] ?? '';
  const keep = text.slice(0, Math.max(0, max - last.length - 5)).replace(/\n[^\n]*$/, '');
  return `${keep}\n...\n${last}`.slice(0, max);
}
