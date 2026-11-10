// What kind of workout a row is (running, strength, ...), decided from the best information there is. Pure: no React, no database
// (unit tested in tools/ui-smoke). Used for the icon of a list row, the type filter and "your previous workouts of this type".
export type WorkoutKind =
  | 'running'
  | 'walking'
  | 'hiking'
  | 'cycling'
  | 'swimming'
  | 'rowing'
  | 'strength'
  | 'yoga'
  | 'cardio'
  | 'other';

export const KIND_LABELS: Readonly<Record<WorkoutKind, string>> = {
  running: 'Running',
  walking: 'Walking',
  hiking: 'Hiking',
  cycling: 'Cycling',
  swimming: 'Swimming',
  rowing: 'Rowing',
  strength: 'Strength',
  yoga: 'Yoga & mobility',
  cardio: 'Cardio',
  other: 'Other',
};

/** First match wins. The text is lower case with underscores turned into spaces ("treadmill_running" -> "treadmill running"). */
const RULES: readonly (readonly [WorkoutKind, RegExp])[] = [
  ['running', /\brun|\bjog|treadmill/],
  ['hiking', /\bhik/],
  ['walking', /\bwalk/],
  ['cycling', /\bcycl|\bbik(e|ing)\b|\bride\b|spinning/],
  ['swimming', /\bswim|\bpool\b|water polo/],
  ['rowing', /\browing\b|\browe?r\b|\browing machine/],
  ['yoga', /\byoga|pilates|stretch|mobility|breath/],
  ['strength', /strength|weight|\bgym\b|hiit|crossfit|resistance|lifting|circuit|calisthen|functional|bodybuilding/],
  ['cardio', /cardio|elliptical|stair|aerobic|\bdance|jump rope|jump_rope|fitness equipment/],
];

function match(text: string | null | undefined): WorkoutKind | null {
  if (!text) return null;
  const t = text.toLowerCase().replace(/_/g, ' ');
  for (const [kind, re] of RULES) if (re.test(t)) return kind;
  return null;
}

export interface KindInput {
  name: string;
  activity_code?: string | null;
  /** Garmin's activity type key (`details.typeKey`), when known. */
  type_key?: string | null;
}

/** The part of a workout row that kind and time ordering need. */
export interface WorkoutLike extends KindInput {
  id: string;
  entry_date: string;
  started_at: string | null;
}

/** The kind of a workout: Garmin's type key first, then the MET activity code of a manual entry, then the name. */
export function workoutKind(input: KindInput): WorkoutKind {
  return match(input.type_key) ?? match(input.activity_code) ?? match(input.name) ?? 'other';
}

/** `row` kinds, most frequent first, with their counts (the type filter shows these). */
export function availableKinds(rows: readonly KindInput[]): { kind: WorkoutKind; count: number }[] {
  const counts = new Map<WorkoutKind, number>();
  for (const row of rows) {
    const kind = workoutKind(row);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || KIND_LABELS[a.kind].localeCompare(KIND_LABELS[b.kind]));
}

export function filterByKind<T extends KindInput>(rows: readonly T[], kind: WorkoutKind | 'all'): T[] {
  return kind === 'all' ? [...rows] : rows.filter((r) => workoutKind(r) === kind);
}

/** Epoch ms used to order workouts in time: the start, or noon of the entry date when the start is unknown. NaN when neither parses. */
export function workoutTimeMs(row: { started_at: string | null; entry_date: string }): number {
  if (row.started_at) {
    const ms = Date.parse(row.started_at);
    if (Number.isFinite(ms)) return ms;
  }
  return Date.parse(`${row.entry_date}T12:00:00Z`);
}

/**
 * The last `limit` workouts of the same kind that happened BEFORE `current`, newest first (for "how did the previous ones go").
 * `candidates` may contain `current` itself and workouts of any kind; they are filtered here.
 */
export function selectComparable<T extends WorkoutLike>(current: WorkoutLike, candidates: readonly T[], limit = 3): T[] {
  const kind = workoutKind(current);
  const at = workoutTimeMs(current);
  return candidates
    .filter((c) => c.id !== current.id && workoutKind(c) === kind && workoutTimeMs(c) < at)
    .sort((a, b) => workoutTimeMs(b) - workoutTimeMs(a))
    .slice(0, limit);
}
