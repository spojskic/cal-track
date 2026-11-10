import { router, type Href } from 'expo-router';

/** Leaves an AI flow after a successful save, the same way the food flow does (back to where the user came from). */
export function leaveAiFlow(): void {
  if (router.canDismiss()) router.dismissAll();
  else if (router.canGoBack()) router.back();
  else router.replace('/');
}

/** Param of /ai/label set by the new-food form: the form is still underneath, so the label screen returns to it. */
export const FROM_FOOD_FORM = 'food-form';

export interface LabelScanTarget {
  /** Barcode (GTIN-14) to carry into the new food. */
  gtin?: string;
  mealGroupId?: string;
  /** Opened from the new-food form (go back to it instead of opening a second one). */
  fromForm?: boolean;
}

/** Opens "Scan nutrition label". The AI gate is checked by the screen itself and by the buttons that lead here. */
export function openLabelScan(target: LabelScanTarget = {}): void {
  router.push({
    pathname: '/ai/label',
    params: {
      ...(target.gtin ? { gtin: target.gtin } : {}),
      ...(target.mealGroupId ? { mealGroupId: target.mealGroupId } : {}),
      ...(target.fromForm ? { from: FROM_FOOD_FORM } : {}),
    },
  } as unknown as Href);
}
