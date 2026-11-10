// Delete + undo of the non-food rows of a diary day (exercise, biometrics, notes), for the swipe-to-delete rows.
// Entries are deleted by id (optimistically removed from the day's cache) and, for Undo, inserted again with their
// original values and id. Food entries have their own path in diary-actions.ts / diary-copy.ts.
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { requireUserId } from '@/lib/auth-user';
import { supabase } from '@/lib/supabase';

import type { BiometricEntry } from './activity';
import { buildActivityRestoreRow, type ActivityKind, type ActivityRow } from './diary-activity-rules';
import { dayKey, invalidateDay, keys, type DayPart } from './keys';

const TABLES: Record<ActivityKind, string> = {
  exercise: 'exercise_entries',
  biometric: 'biometrics',
  note: 'notes',
};

/** Which cached list of the day holds the rows of a kind. */
const PARTS: Record<ActivityKind, DayPart> = {
  exercise: 'exercise',
  biometric: 'biometrics',
  note: 'notes',
};

function refresh(qc: QueryClient, kind: ActivityKind, row: ActivityRow): Promise<unknown> {
  const tasks: Promise<unknown>[] = [invalidateDay(qc, row.entry_date)];
  if (kind === 'biometric') {
    // Same as logging one: the biometric caches, and for weight the targets that depend on it.
    tasks.push(qc.invalidateQueries({ queryKey: ['biometrics'] }));
    if ((row as BiometricEntry).type === 'weight') {
      tasks.push(qc.invalidateQueries({ queryKey: keys.latestWeight }));
      tasks.push(qc.invalidateQueries({ queryKey: keys.targets }));
      tasks.push(qc.invalidateQueries({ queryKey: keys.macroTargets }));
    }
  }
  return Promise.all(tasks);
}

interface DeleteContext {
  key: ReturnType<typeof dayKey>;
  previous: ActivityRow[] | undefined;
}

/** Deletes one exercise / biometric / note row; the row disappears from the list at once. */
export function useDeleteActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { kind: ActivityKind; row: ActivityRow }) => {
      const { error } = await supabase.from(TABLES[input.kind]).delete().eq('id', input.row.id);
      if (error) throw error;
    },
    onMutate: async (input): Promise<DeleteContext> => {
      const key = dayKey(input.row.entry_date, PARTS[input.kind]);
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<ActivityRow[]>(key);
      if (previous) qc.setQueryData<ActivityRow[]>(key, previous.filter((r) => r.id !== input.row.id));
      return { key, previous };
    },
    onError: (_e, _input, ctx) => {
      if (ctx?.previous) qc.setQueryData(ctx.key, ctx.previous);
    },
    onSettled: (_d, _e, input) => refresh(qc, input.kind, input.row),
  });
}

/** Undo of {@link useDeleteActivity}: inserts the row again with its original values. */
export function useRestoreActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { kind: ActivityKind; row: ActivityRow }) => {
      const userId = await requireUserId();
      const { error } = await supabase.from(TABLES[input.kind]).insert(buildActivityRestoreRow(input.kind, input.row, userId));
      if (error) throw error;
    },
    onSettled: (_d, _e, input) => refresh(qc, input.kind, input.row),
  });
}
