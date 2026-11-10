// Write hooks for exercise, biometrics, notes and water. Read hooks live in activity.ts.
// All inserts carry user_id (RLS is owner-only) and refresh the affected diary day afterwards.
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { requireUserId } from '@/lib/auth-user';
import { supabase } from '@/lib/supabase';

import { dayKey, invalidateDay, keys } from './keys';

const toIso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : typeof d === 'string' ? d : d.toISOString();

// ------------------------------------------------------------------ exercise

export interface NewExercise {
  /** Local YYYY-MM-DD the workout belongs to. */
  entryDate: string;
  name: string;
  /** MET activity code (core MET_ACTIVITIES); null for custom exercises. */
  activityCode?: string | null;
  minutes?: number | null;
  /** Calories burned (already net of resting energy when estimated from METs). */
  kcal: number;
  startedAt?: Date | string | null;
  endedAt?: Date | string | null;
  /** Defaults to true. */
  countsTowardEnergy?: boolean;
}

/** Inserts a manual exercise entry. */
export function useAddExercise() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (e: NewExercise) => {
      const userId = await requireUserId();
      const row = {
        user_id: userId,
        entry_date: e.entryDate,
        activity_code: e.activityCode ?? null,
        name: e.name.trim(),
        minutes: e.minutes ?? null,
        kcal: Math.max(0, e.kcal),
        source: 'manual',
        started_at: toIso(e.startedAt),
        ended_at: toIso(e.endedAt),
        counts_toward_energy: e.countsTowardEnergy ?? true,
      };
      const first = await supabase.from('exercise_entries').insert(row).select('id').single();
      if (!first.error) return first.data as { id: string };
      // 23503 = FK violation: the exercise_activities seed has not been loaded. Keep the entry, drop the code.
      if (first.error.code === '23503' && row.activity_code) {
        const retry = await supabase
          .from('exercise_entries')
          .insert({ ...row, activity_code: null })
          .select('id')
          .single();
        if (retry.error) throw retry.error;
        return retry.data as { id: string };
      }
      throw first.error;
    },
    onSuccess: (_d, e) => invalidateDay(qc, e.entryDate),
  });
}

export function useDeleteExercise() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; entryDate: string }) => {
      const { error } = await supabase.from('exercise_entries').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: (_d, v) => invalidateDay(qc, v.entryDate),
  });
}

// ----------------------------------------------------------------- biometrics

export interface NewBiometric {
  /** Local YYYY-MM-DD. */
  entryDate: string;
  /** Slugified type: 'weight', 'body_fat', 'bp_systolic', 'my_custom_thing', ... */
  type: string;
  /** Stored metric value (weight kg, waist cm, glucose mmol/L, ...). */
  value: number;
  unit?: string | null;
  recordedAt?: Date | string | null;
  meta?: Record<string, unknown>;
}

function refreshBiometrics(qc: QueryClient, rows: { entryDate: string; type: string }[]) {
  const dates = [...new Set(rows.map((r) => r.entryDate))];
  const tasks: Promise<unknown>[] = dates.map((d) => invalidateDay(qc, d));
  // ['biometrics', ...] covers useRecentBiometric and the shared latest-weight key.
  tasks.push(qc.invalidateQueries({ queryKey: ['biometrics'] }));
  if (rows.some((r) => r.type === 'weight')) {
    tasks.push(qc.invalidateQueries({ queryKey: keys.latestWeight }));
    // Calorie/macro targets depend on the current weight.
    tasks.push(qc.invalidateQueries({ queryKey: keys.targets }));
    tasks.push(qc.invalidateQueries({ queryKey: keys.macroTargets }));
  }
  return Promise.all(tasks);
}

async function insertBiometrics(rows: NewBiometric[]): Promise<{ id: string }[]> {
  if (rows.length === 0) return [];
  const userId = await requireUserId();
  const { data, error } = await supabase
    .from('biometrics')
    .insert(
      rows.map((r) => ({
        user_id: userId,
        entry_date: r.entryDate,
        type: r.type,
        value: r.value,
        unit: r.unit ?? null,
        source: 'manual',
        recorded_at: toIso(r.recordedAt) ?? new Date().toISOString(),
        meta: r.meta ?? {},
      })),
    )
    .select('id');
  if (error) throw error;
  return (data ?? []) as { id: string }[];
}

/** Inserts one or more biometric rows in a single request (e.g. blood pressure = two rows). */
export function useAddBiometrics() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: insertBiometrics,
    onSuccess: (_d, rows) => refreshBiometrics(qc, rows),
  });
}

/** Single-row convenience wrapper. */
export function useAddBiometric() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (r: NewBiometric) => {
      const [row] = await insertBiometrics([r]);
      if (!row) throw new Error('Biometric was not saved');
      return row;
    },
    onSuccess: (_d, r) => refreshBiometrics(qc, [r]),
  });
}

export function useDeleteBiometric() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; entryDate: string; type: string }) => {
      const { error } = await supabase.from('biometrics').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: (_d, v) => refreshBiometrics(qc, [v]),
  });
}

// ---------------------------------------------------------------------- notes

export function useAddNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ entryDate, body }: { entryDate: string; body: string }) => {
      const text = body.trim();
      if (!text) throw new Error('Note is empty');
      const userId = await requireUserId();
      const { data, error } = await supabase
        .from('notes')
        .insert({ user_id: userId, entry_date: entryDate, body: text })
        .select('id')
        .single();
      if (error) throw error;
      return data as { id: string };
    },
    onSuccess: (_d, v) => invalidateDay(qc, v.entryDate),
  });
}

export function useDeleteNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string; entryDate: string }) => {
      const { error } = await supabase.from('notes').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: (_d, v) => invalidateDay(qc, v.entryDate),
  });
}

// ---------------------------------------------------------------------- water

const WATER_MUTATION_KEY = ['water-write'] as const;

/**
 * Adds a water entry (ml). Updates the cached day total optimistically so rapid taps feel instant;
 * the day is refetched once the last in-flight water mutation settles.
 */
export function useAddWater() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: WATER_MUTATION_KEY,
    mutationFn: async ({ entryDate, ml }: { entryDate: string; ml: number }) => {
      if (!(ml > 0)) throw new Error('Enter an amount above zero');
      const userId = await requireUserId();
      const { data, error } = await supabase
        .from('water_entries')
        .insert({ user_id: userId, entry_date: entryDate, ml })
        .select('id')
        .single();
      if (error) throw error;
      return data as { id: string };
    },
    onMutate: async ({ entryDate, ml }) => {
      const key = dayKey(entryDate, 'water');
      await qc.cancelQueries({ queryKey: key });
      qc.setQueryData<number>(key, (old) => (old === undefined ? old : old + ml));
    },
    onError: (_e, { entryDate, ml }) => {
      qc.setQueryData<number>(dayKey(entryDate, 'water'), (old) =>
        old === undefined ? old : Math.max(0, old - ml),
      );
    },
    onSettled: async (_d, _e, { entryDate }) => {
      if (qc.isMutating({ mutationKey: WATER_MUTATION_KEY }) <= 1) await invalidateDay(qc, entryDate);
    },
  });
}

/** Deletes one water entry by id. */
export function useDeleteWater() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: WATER_MUTATION_KEY,
    mutationFn: async ({ id }: { id: string; entryDate: string }) => {
      const { error } = await supabase.from('water_entries').delete().eq('id', id);
      if (error) throw error;
    },
    onSettled: (_d, _e, v) => invalidateDay(qc, v.entryDate),
  });
}

/**
 * Removes the most recently logged water entry of the date. Resolves to the removed amount in ml,
 * or null when the day has no water entries.
 */
export function useUndoLastWater() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: WATER_MUTATION_KEY,
    mutationFn: async ({ entryDate }: { entryDate: string }): Promise<number | null> => {
      const { data, error } = await supabase
        .from('water_entries')
        .select('id, ml')
        .eq('entry_date', entryDate)
        .order('logged_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const row = data as { id: string; ml: number };
      const del = await supabase.from('water_entries').delete().eq('id', row.id);
      if (del.error) throw del.error;
      return Number(row.ml);
    },
    onSettled: (_d, _e, v) => invalidateDay(qc, v.entryDate),
  });
}
