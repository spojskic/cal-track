// Pure rules of the swipe-to-delete rows (no React): the full-swipe line and the screen reader "delete" action.
// Kept apart from SwipeToDelete.tsx so the harness can unit test them without react-native.
import type { AccessibilityActionInfo } from 'react-native';

/** Letting go after pulling a row further than this share of its width deletes it without a second tap. */
export const FULL_SWIPE_FRACTION = 0.6;

/** True when a row pulled `distance` px to the left (positive number) is past the full-swipe line. Runs on the UI thread. */
export function isFullSwipe(distance: number, rowWidth: number): boolean {
  'worklet';
  return rowWidth > 0 && distance > rowWidth * FULL_SWIPE_FRACTION;
}

/** Name of the custom accessibility action that deletes a row (screen readers cannot swipe). */
export const DELETE_ACTION_NAME = 'delete';

/** "Delete Oats, rolled, dry": the name of the red button and of the screen reader action. */
export function deleteLabel(name: string): string {
  return `Delete ${name}`;
}

/** `accessibilityActions` of a deletable row. */
export function deleteAccessibilityActions(name: string): AccessibilityActionInfo[] {
  return [{ name: DELETE_ACTION_NAME, label: deleteLabel(name) }];
}

export function isDeleteAction(actionName: string): boolean {
  return actionName === DELETE_ACTION_NAME;
}
