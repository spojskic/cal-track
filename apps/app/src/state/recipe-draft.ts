// Hands a list of foods from the diary ("Create Recipe from Group") to the new-recipe screen, which uses it as the
// starting point of the editor. In memory; /recipe/new reads it once and clears it when it closes.
import { create } from 'zustand';

import { toCopyItem } from '@/data/diary-copy';

export interface RecipeDraftIngredient {
  foodId: string;
  name: string;
  brand: string | null;
  /** Always > 0. */
  grams: number;
}

export interface RecipeDraft {
  name: string;
  ingredients: RecipeDraftIngredient[];
}

interface RecipeDraftState {
  draft: RecipeDraft | null;
  setDraft: (draft: RecipeDraft | null) => void;
}

export const useRecipeDraft = create<RecipeDraftState>((set) => ({
  draft: null,
  setDraft: (draft) => set({ draft }),
}));

/**
 * A recipe draft from diary entries: one ingredient per entry with its eaten grams (entries that could not be a valid
 * ingredient are left out). Null when nothing is left.
 */
export function buildRecipeDraft(
  name: string,
  entries: readonly { foodId: string; grams: number; food: { name: string; brand: string | null } }[],
): RecipeDraft | null {
  const ingredients: RecipeDraftIngredient[] = [];
  for (const entry of entries) {
    const item = toCopyItem(entry);
    if (item) ingredients.push({ foodId: item.foodId, name: entry.food.name, brand: entry.food.brand, grams: item.grams });
  }
  return ingredients.length > 0 ? { name, ingredients } : null;
}
