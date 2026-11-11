// Hands the result of "Scan nutrition label" (the food form's values, read from a photo) to the new-food screen.
// In memory only: /food/new shows it and clears it when it closes. Nothing is saved until the user presses Save food.
import type { LabelFoodDraft } from '@ration/core';
import { create } from 'zustand';

import type { FoodFormInitial } from '@/components/food/food-form';

export interface StoredLabelDraft {
  /** Changes with every scan, so a screen that is already open can tell a new draft from the one it shows. */
  id: number;
  draft: LabelFoodDraft;
}

interface LabelDraftState {
  current: StoredLabelDraft | null;
}

export const useLabelDraft = create<LabelDraftState>(() => ({ current: null }));

let sequence = 0;

/** Stores a draft (replacing any earlier one) and returns it with its id. */
export function setLabelDraft(draft: LabelFoodDraft): StoredLabelDraft {
  sequence += 1;
  // A copy: nobody can change a draft that the form is about to show.
  const stored: StoredLabelDraft = { id: sequence, draft: JSON.parse(JSON.stringify(draft)) as LabelFoodDraft };
  useLabelDraft.setState({ current: stored });
  return stored;
}

/** Forgets the draft. Safe to call when there is none. */
export function clearLabelDraft(): void {
  if (useLabelDraft.getState().current !== null) useLabelDraft.setState({ current: null });
}

/** Fields other than nutrients that get a "check this" marker. The name only when the label gave one: a typed name is the user's own. */
function markedFields(draft: LabelFoodDraft): LabelFoodDraft['unclearFields'] {
  return draft.unclearFields.filter((f) => f !== 'name' || draft.name !== null);
}

/** How many values of the form carry a "check this" marker. */
export function markedValueCount(draft: LabelFoodDraft): number {
  return draft.unclear.length + markedFields(draft).length;
}

/**
 * The values for the food form. `fallback` fills what the label did not say: a name typed before (or passed in the
 * URL) and the barcode the user came with. The label's own name and brand win when it had them.
 */
export function formInitialFromDraft(
  draft: LabelFoodDraft,
  fallback: { name?: string; gtin?: string } = {},
): FoodFormInitial {
  const name = draft.name ?? fallback.name;
  return {
    ...(name ? { name } : {}),
    ...(draft.brand ? { brand: draft.brand } : {}),
    ...(fallback.gtin ? { gtin: fallback.gtin } : {}),
    basis: draft.basis,
    nutrients: draft.nutrients,
    carbBasis: draft.carbBasis,
    densityGPerMl: draft.densityGPerMl,
    servings: draft.servings,
    unclear: draft.unclear,
    unclearFields: markedFields(draft),
    expandFilled: true,
  };
}
