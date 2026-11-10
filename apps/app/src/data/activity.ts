// Read hooks for the non-food parts of a diary day. Write flows (forms/mutations) live in activity-write.ts.
import { useQuery } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

import { dayKey } from './keys';

export interface ExerciseEntry {
  id: string;
  entry_date: string;
  activity_code: string | null;
  name: string;
  minutes: number | null;
  kcal: number;
  source: 'manual' | 'apple_health' | 'health_connect' | 'garmin';
  external_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  counts_toward_energy: boolean;
}

export interface BiometricEntry {
  id: string;
  entry_date: string;
  type: string;
  value: number;
  unit: string;
  source: string;
  recorded_at: string | null;
  meta: Record<string, unknown> | null;
}

export interface NoteEntry {
  id: string;
  entry_date: string;
  body: string;
  created_at: string;
}

export interface DailyEnergyRow {
  local_date: string;
  source: string;
  active_kcal: number | null;
  resting_kcal: number | null;
  steps: number | null;
  /** When the row was last written; a day last written before it ended may still be partial (see isDeviceDayComplete). */
  updated_at?: string | null;
}

function dayQuery<T>(date: string, part: Parameters<typeof dayKey>[1], table: string, dateColumn = 'entry_date', columns = '*') {
  return {
    queryKey: dayKey(date, part),
    queryFn: async (): Promise<T[]> => {
      const { data, error } = await supabase.from(table).select(columns).eq(dateColumn, date);
      if (error) throw error;
      return (data ?? []) as T[];
    },
  };
}

/** The columns of {@link ExerciseEntry}: not `details` (jsonb of a device workout, loaded by the Workouts screens when needed). */
const EXERCISE_COLUMNS =
  'id, entry_date, activity_code, name, minutes, kcal, source, external_id, started_at, ended_at, counts_toward_energy';

export const useExerciseEntries = (date: string) =>
  useQuery(dayQuery<ExerciseEntry>(date, 'exercise', 'exercise_entries', 'entry_date', EXERCISE_COLUMNS));

export const useBiometrics = (date: string) =>
  useQuery(dayQuery<BiometricEntry>(date, 'biometrics', 'biometrics'));

export const useNotes = (date: string) => useQuery(dayQuery<NoteEntry>(date, 'notes', 'notes'));

/** Device-imported daily energy rows (Apple Health / Health Connect / Garmin) for the date. */
export const useDailyEnergy = (date: string) =>
  useQuery(dayQuery<DailyEnergyRow>(date, 'energy', 'daily_energy', 'local_date'));

/** Total water logged for the date, in ml. */
export function useWaterMl(date: string) {
  return useQuery({
    queryKey: dayKey(date, 'water'),
    queryFn: async (): Promise<number> => {
      const { data, error } = await supabase.from('water_entries').select('ml').eq('entry_date', date);
      if (error) throw error;
      return (data ?? []).reduce((sum, r) => sum + Number((r as { ml: number }).ml), 0);
    },
  });
}

/**
 * Most recent biometric row of `type` (e.g. 'weight', 'bp_systolic'), or null when none exists.
 * With `onOrBefore` (YYYY-MM-DD) only rows dated on/before that day are considered, so logging
 * on a past diary date shows the value that was current back then.
 */
export function useRecentBiometric(type: string, onOrBefore?: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['biometrics', 'recent', type, onOrBefore ?? 'any'] as const,
    queryFn: async (): Promise<BiometricEntry | null> => {
      let q = supabase.from('biometrics').select('*').eq('type', type);
      if (onOrBefore) q = q.lte('entry_date', onOrBefore);
      const { data, error } = await q
        .order('entry_date', { ascending: false })
        .order('recorded_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as BiometricEntry | null) ?? null;
    },
  });
}
