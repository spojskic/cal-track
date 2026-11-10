// Hooks for pasting, bulk deleting and undoing diary entries. The work is done by the plain functions in
// diary-copy.ts; these only add the React Query cache handling (optimistic removal, invalidation).
import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  deleteEntries,
  pasteItems,
  restoreEntries,
  type CopyItem,
  type CopyOutcome,
  type DiarySnapshotRow,
} from './diary-copy';
import { patchRows, rollback, settleDates } from './diary';

/** Pastes clipboard items into a date + meal group as new entries (source 'copy'). */
export function usePasteDiaryEntries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { items: readonly CopyItem[]; toDate: string; toMealGroupId: string | null }): Promise<CopyOutcome> =>
      pasteItems(input),
    onSettled: (_d, _e, input) => settleDates(qc, [input.toDate]),
  });
}

/**
 * Deletes entries by id (optimistically) and resolves to the deleted rows, which {@link useRestoreDiaryEntries} can put
 * back. Also the undo of a copy / paste (the inserted rows are simply deleted again).
 */
export function useDeleteDiaryEntries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { ids: readonly string[]; date: string }): Promise<DiarySnapshotRow[]> => deleteEntries(input.ids),
    onMutate: (input) => {
      const gone = new Set(input.ids);
      return patchRows(qc, input.date, (rows) => rows.filter((r) => !gone.has(r.id)));
    },
    onError: (_e, _i, ctx) => rollback(qc, ctx),
    onSettled: (_d, _e, input) => settleDates(qc, [input.date]),
  });
}

/** Undo of a delete: re-inserts the deleted rows with their original values. */
export function useRestoreDiaryEntries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { rows: readonly DiarySnapshotRow[] }): Promise<string[]> => restoreEntries(input.rows),
    onSettled: (_d, _e, input) => settleDates(qc, input.rows.map((r) => r.entry_date)),
  });
}
