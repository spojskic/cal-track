import type { SwipeToDeleteProps } from './SwipeToDelete';

/**
 * Web: no swipe (a mouse drag would fight with clicking and text selection). The row renders as is; the entry sheet
 * has the Delete button there, and `accessibilityActions` of the row still offer "delete" to assistive technology.
 */
export function SwipeToDelete({ children }: SwipeToDeleteProps) {
  return <>{children}</>;
}
