import { errorMessage } from '@/data/foods';
import { useDeleteActivity, useRestoreActivity } from '@/data/diary-activity';
import type { ActivityKind, ActivityRow } from '@/data/diary-activity-rules';
import { showDiaryToast } from '@/state/diary-toast';

import { haptic } from './haptics';

/**
 * Swipe-to-delete of an exercise / biometric / note row: the row is removed at once and the toast "Deleted X" offers
 * Undo, which inserts the row again with its original values. Errors are shown in the toast instead of being thrown.
 */
export function useActivityDelete() {
  const remove = useDeleteActivity();
  const restore = useRestoreActivity();

  const fail = (error: unknown) => {
    haptic('error');
    showDiaryToast({ message: errorMessage(error), tone: 'error' });
  };

  const undo = async (kind: ActivityKind, row: ActivityRow, name: string) => {
    try {
      await restore.mutateAsync({ kind, row });
      haptic('success');
      showDiaryToast({ message: `Restored ${name}`, durationMs: 2500 });
    } catch (error) {
      fail(error);
    }
  };

  return async (kind: ActivityKind, row: ActivityRow, name: string) => {
    try {
      await remove.mutateAsync({ kind, row });
      haptic('warning');
      showDiaryToast({ message: `Deleted ${name}`, action: { label: 'Undo', onPress: () => void undo(kind, row, name) } });
    } catch (error) {
      fail(error);
    }
  };
}
