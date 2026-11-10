import { errorMessage } from '@/data/foods';
import { useCopyDiaryEntries, type DiaryEntry } from '@/data/diary';
import { useDeleteDiaryEntries, usePasteDiaryEntries, useRestoreDiaryEntries } from '@/data/diary-actions';
import {
  itemWord,
  makeClipboard,
  pasteLabel,
  resolveTargetGroup,
  toCopyItem,
  type ClipboardKind,
  type CopyOutcome,
  type DiarySnapshotRow,
} from '@/data/diary-copy';
import { useMealGroups, type MealGroup } from '@/data/meal-groups';
import { useDiaryClipboard } from '@/state/diary-clipboard';
import { showDiaryToast } from '@/state/diary-toast';
import { addDays, todayISO } from '@/state/selected-date';

import { formatDayLabel, relativeDayLabel } from './dates';
import { haptic } from './haptics';

export interface GroupRef {
  id: string;
  name: string;
}

const EMPTY_GROUPS: MealGroup[] = [];

const dayLabel = (iso: string): string => relativeDayLabel(iso) ?? formatDayLabel(iso);

/**
 * The copy / paste / delete actions of the diary menus for the viewed `date`. Every action that writes announces
 * itself with a toast ("Copied 4 items to Breakfast" + Undo); Undo removes the inserted rows again (or re-inserts the
 * deleted ones with their original values). Errors are shown in the toast instead of being thrown.
 */
export function useCopyActions(date: string) {
  const copy = useCopyDiaryEntries();
  const paste = usePasteDiaryEntries();
  const remove = useDeleteDiaryEntries();
  const restore = useRestoreDiaryEntries();
  const groups = useMealGroups().data ?? EMPTY_GROUPS;
  const clipboard = useDiaryClipboard((s) => s.clip);
  const setClipboard = useDiaryClipboard((s) => s.setClip);

  const fail = (error: unknown) => {
    haptic('error');
    showDiaryToast({ message: errorMessage(error), tone: 'error' });
  };

  const run = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      fail(error);
    }
  };

  /** "Breakfast", or "Breakfast on Today" when the copies land on another day than the viewed one. */
  const where = (targetDate: string, place: string) => (targetDate === date ? place : `${place} on ${dayLabel(targetDate)}`);

  const undoInsert = (outcome: CopyOutcome) =>
    run(async () => {
      await remove.mutateAsync({ ids: outcome.ids, date: outcome.toDate });
      haptic('selection');
      showDiaryToast({ message: 'Undone', durationMs: 2500 });
    });

  const undoDelete = (rows: DiarySnapshotRow[]) =>
    run(async () => {
      const ids = await restore.mutateAsync({ rows });
      haptic('success');
      showDiaryToast({ message: `Restored ${ids.length} ${itemWord(ids.length)}`, durationMs: 2500 });
    });

  const announceInsert = (verb: 'Copied' | 'Pasted', outcome: CopyOutcome, place: string) => {
    if (outcome.count === 0) {
      haptic('warning');
      showDiaryToast({ message: 'Nothing to copy.', tone: 'error' });
      return;
    }
    haptic('success');
    const skipped = outcome.skipped > 0 ? ` (${outcome.skipped} skipped)` : '';
    showDiaryToast({
      message: `${verb} ${outcome.count} ${itemWord(outcome.count)} to ${place}${skipped}`,
      action: { label: 'Undo', onPress: () => void undoInsert(outcome) },
    });
  };

  return {
    clipboard,

    /** Toast with Undo for a copy made elsewhere (the "Copy a day from..." sheet). */
    announceCopy: (outcome: CopyOutcome, place: string) => announceInsert('Copied', outcome, place),

    /** Copy Yesterday's Group: the same meal group of the day before the viewed date, into this date. */
    copyYesterdayGroup: (group: GroupRef) =>
      run(async () => {
        const outcome = await copy.mutateAsync({ fromDate: addDays(date, -1), toDate: date, fromMealGroupId: group.id });
        announceInsert('Copied', outcome, group.name);
      }),

    /** Copy to Today (past dates): the viewed date's group into today's same group. */
    copyGroupToToday: (group: GroupRef) =>
      run(async () => {
        const today = todayISO();
        const outcome = await copy.mutateAsync({ fromDate: date, toDate: today, fromMealGroupId: group.id });
        announceInsert('Copied', outcome, where(today, group.name));
      }),

    /** Copy yesterday's entire diary: every group of the day before, into the viewed date. */
    copyYesterdayDiary: () =>
      run(async () => {
        const outcome = await copy.mutateAsync({ fromDate: addDays(date, -1), toDate: date });
        announceInsert('Copied', outcome, dayLabel(date));
      }),

    /** Copy to Today for one entry (past dates): into the entry's meal group of today. */
    copyEntryToToday: (entry: DiaryEntry) =>
      run(async () => {
        const item = toCopyItem(entry);
        if (!item) throw new Error('This entry cannot be copied.');
        const today = todayISO();
        const target = resolveTargetGroup(entry.mealGroupId, groups);
        const place = groups.find((g) => g.id === target)?.name ?? 'the diary';
        const outcome = await paste.mutateAsync({ items: [item], toDate: today, toMealGroupId: target });
        announceInsert('Copied', outcome, where(today, place));
      }),

    /** Copy Group / Copy Entry: puts the entries on the in-app clipboard (nothing is written to the database). */
    copyToClipboard: (args: { kind: ClipboardKind; label: string; sourceGroupId: string | null; entries: readonly DiaryEntry[] }) => {
      const next = makeClipboard({ ...args, sourceDate: date });
      if (!next) {
        fail(new Error('Nothing to copy.'));
        return;
      }
      setClipboard(next);
      haptic('success');
      const n = next.items.length;
      showDiaryToast({
        message: `${next.label} copied to clipboard (${n} ${itemWord(n)}). Choose ${pasteLabel(next)} in any meal.`,
      });
    },

    /** Paste Group / Paste Entry: the clipboard into the viewed date, in `groupId` (checked against the user's groups). */
    pasteClipboard: (groupId: string | null, fallbackName: string) =>
      run(async () => {
        const clip = useDiaryClipboard.getState().clip;
        if (!clip) throw new Error('The clipboard is empty.');
        const target = resolveTargetGroup(groupId, groups);
        const place = groups.find((g) => g.id === target)?.name ?? fallbackName;
        const outcome = await paste.mutateAsync({ items: clip.items, toDate: date, toMealGroupId: target });
        announceInsert('Pasted', outcome, place);
      }),

    /** Delete group entries (after the confirm dialog). Undo puts the same rows back. */
    deleteEntries: (entries: readonly DiaryEntry[], name: string) =>
      run(async () => {
        const rows = await remove.mutateAsync({ ids: entries.map((e) => e.id), date });
        if (rows.length === 0) {
          showDiaryToast({ message: 'Nothing to delete.', tone: 'error' });
          return;
        }
        haptic('warning');
        showDiaryToast({
          message: `Deleted ${rows.length} ${itemWord(rows.length)} from ${name}`,
          action: { label: 'Undo', onPress: () => void undoDelete(rows) },
        });
      }),
  };
}

export type CopyActions = ReturnType<typeof useCopyActions>;
