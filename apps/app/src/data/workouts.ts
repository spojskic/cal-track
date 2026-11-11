// Reads and writes of the Workouts section (More > Workouts). A "workout" is any row of `exercise_entries`: logged by hand
// (source 'manual') or imported from a device (Garmin, Apple Health, Health Connect). What a device knows beyond name, time and
// calories lives in `exercise_entries.details` (jsonb, migration 20261110000105; shape in packages/garmin/src/workout-details.ts).
//
// The list never loads the whole `details` object: it asks for two keys of it (`avg_hr:details->avgHr`, `type_key:details->>typeKey`),
// so 50 rows stay small in the query cache. The detail screen loads the whole thing.
import { parseWorkoutDetails, type WorkoutDetails } from '@ration/garmin';
import { useInfiniteQuery, useQuery, type QueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { isUuid } from '@/lib/uuid';

import type { ExerciseEntry } from './activity';

export type WorkoutSource = ExerciseEntry['source'];
export type WorkoutSourceFilter = 'all' | 'garmin' | 'health' | 'manual';

/** One row of the list. */
export interface WorkoutRow {
  id: string;
  entry_date: string;
  name: string;
  activity_code: string | null;
  minutes: number | null;
  kcal: number;
  source: WorkoutSource;
  started_at: string | null;
  ended_at: string | null;
  counts_toward_energy: boolean;
  /** `details.avgHr` when a device reported it. */
  avg_hr: number | null;
  /** `details.typeKey` (Garmin's activity type). */
  type_key: string | null;
}

/** One workout with everything known about it. */
export interface WorkoutEntry {
  id: string;
  entry_date: string;
  name: string;
  activity_code: string | null;
  minutes: number | null;
  kcal: number;
  source: WorkoutSource;
  external_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  counts_toward_energy: boolean;
  /** Parsed and validated; null when nothing is stored (or the stored value is not a v1 object). */
  details: WorkoutDetails | null;
}

export const WORKOUT_PAGE_SIZE = 50;

export const workoutKeys = {
  all: ['workouts'] as const,
  list: (filter: WorkoutSourceFilter) => ['workouts', 'list', filter] as const,
  detail: (id: string) => ['workouts', 'detail', id] as const,
};

const LIST_COLUMNS =
  'id, entry_date, name, activity_code, minutes, kcal, source, started_at, ended_at, counts_toward_energy, avg_hr:details->avgHr, type_key:details->>typeKey';

const ENTRY_COLUMNS = 'id, entry_date, name, activity_code, minutes, kcal, source, external_id, started_at, ended_at, counts_toward_energy, details';

const numberOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function toRow(raw: Record<string, unknown>): WorkoutRow {
  return {
    id: String(raw.id),
    entry_date: String(raw.entry_date),
    name: String(raw.name ?? ''),
    activity_code: typeof raw.activity_code === 'string' ? raw.activity_code : null,
    minutes: raw.minutes != null ? Number(raw.minutes) : null,
    kcal: Number(raw.kcal ?? 0),
    source: raw.source as WorkoutSource,
    started_at: typeof raw.started_at === 'string' ? raw.started_at : null,
    ended_at: typeof raw.ended_at === 'string' ? raw.ended_at : null,
    counts_toward_energy: raw.counts_toward_energy !== false,
    avg_hr: numberOrNull(raw.avg_hr),
    type_key: typeof raw.type_key === 'string' && raw.type_key ? raw.type_key : null,
  };
}

function toEntry(raw: Record<string, unknown>): WorkoutEntry {
  return {
    id: String(raw.id),
    entry_date: String(raw.entry_date),
    name: String(raw.name ?? ''),
    activity_code: typeof raw.activity_code === 'string' ? raw.activity_code : null,
    minutes: raw.minutes != null ? Number(raw.minutes) : null,
    kcal: Number(raw.kcal ?? 0),
    source: raw.source as WorkoutSource,
    external_id: typeof raw.external_id === 'string' ? raw.external_id : null,
    started_at: typeof raw.started_at === 'string' ? raw.started_at : null,
    ended_at: typeof raw.ended_at === 'string' ? raw.ended_at : null,
    counts_toward_energy: raw.counts_toward_energy !== false,
    details: parseWorkoutDetails(raw.details),
  };
}

/** The `source` values a list filter lets through (null = all). */
function filterSources(filter: WorkoutSourceFilter): readonly WorkoutSource[] | null {
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

/** One page of the list, newest first (by day, then by start time; workouts without a start time last within their day). */
export async function fetchWorkoutsPage(offset: number, filter: WorkoutSourceFilter, pageSize = WORKOUT_PAGE_SIZE): Promise<WorkoutRow[]> {
  let q = supabase.from('exercise_entries').select(LIST_COLUMNS);
  const sources = filterSources(filter);
  if (sources) q = q.in('source', [...sources]);
  const { data, error } = await q
    .order('entry_date', { ascending: false })
    .order('started_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .range(offset, offset + pageSize - 1);
  if (error) throw error;
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(toRow);
}

/** Infinite list (50 at a time). `pages` are flattened by the screen. */
export function useWorkouts(filter: WorkoutSourceFilter) {
  return useInfiniteQuery({
    queryKey: workoutKeys.list(filter),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => fetchWorkoutsPage(pageParam, filter),
    getNextPageParam: (lastPage, allPages) => (lastPage.length < WORKOUT_PAGE_SIZE ? undefined : allPages.length * WORKOUT_PAGE_SIZE),
  });
}

/** One workout with its details. Null when the id is not a workout of the signed-in user (or not an id at all: no query is sent). */
export async function fetchWorkout(id: string): Promise<WorkoutEntry | null> {
  if (!isUuid(id)) return null;
  const { data, error } = await supabase.from('exercise_entries').select(ENTRY_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? toEntry(data as unknown as Record<string, unknown>) : null;
}

export function useWorkout(id: string | undefined) {
  return useQuery({
    queryKey: workoutKeys.detail(id ?? 'none'),
    enabled: isUuid(id),
    queryFn: () => fetchWorkout(id as string),
  });
}

/** Saves the details read from a device into the workout row (owner-only through RLS). Only this column changes. */
export async function saveWorkoutDetails(id: string, details: WorkoutDetails): Promise<void> {
  const { error } = await supabase.from('exercise_entries').update({ details }).eq('id', id);
  if (error) throw error;
}

/** After new details were saved: the open screens refetch. */
export function refreshWorkouts(qc: QueryClient, id?: string): Promise<unknown> {
  return Promise.all([
    id ? qc.invalidateQueries({ queryKey: workoutKeys.detail(id) }) : Promise.resolve(),
    qc.invalidateQueries({ queryKey: ['workouts', 'list'] }),
  ]);
}

/**
 * The most recent workouts up to and including the given day, for "how did the previous ones of this type go". The caller filters by
 * kind and time (components/workouts/kinds.ts selectComparable). Only list columns: nothing big.
 */
export async function fetchWorkoutsUpTo(entryDate: string, limit = 120): Promise<WorkoutRow[]> {
  const { data, error } = await supabase
    .from('exercise_entries')
    .select(LIST_COLUMNS)
    .lte('entry_date', entryDate)
    .order('entry_date', { ascending: false })
    .order('started_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(toRow);
}

/** What the "newest Garmin workouts without details" step looks at. */
export interface GarminWorkoutRef {
  id: string;
  name: string;
  external_id: string | null;
  entry_date: string;
  started_at: string | null;
  source: WorkoutSource;
  details: unknown;
}

export async function fetchNewestGarminWorkouts(limit = 12): Promise<GarminWorkoutRef[]> {
  const { data, error } = await supabase
    .from('exercise_entries')
    .select('id, name, external_id, entry_date, started_at, source, details')
    .eq('source', 'garmin')
    .order('entry_date', { ascending: false })
    .order('started_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as GarminWorkoutRef[];
}
