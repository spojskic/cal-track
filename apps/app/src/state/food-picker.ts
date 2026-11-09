// Hands a food chosen on /search?mode=pick back to the screen that asked for it (recipe editor, saved meals).
import { router, type Href } from 'expo-router';
import { create } from 'zustand';

/** A food chosen in pick mode with the serving the search screen would have quick-added. */
export interface PickedFood {
  id: string;
  name: string;
  brand: string | null;
  /** Grams of the default serving (first portion, else 100 g). Always > 0. */
  grams: number;
  /** Display amount of that serving in `portionLabel` units ("2" for "2 tbsp"). */
  amount: number;
  portionLabel: string;
}

export type PickHandler = (food: PickedFood) => void;

interface FoodPickerState {
  handler: PickHandler | null;
  setHandler: (handler: PickHandler | null) => void;
}

export const useFoodPicker = create<FoodPickerState>((set) => ({
  handler: null,
  setHandler: (handler) => set({ handler }),
}));

/** Registers `handler` and opens the search screen in pick mode. */
export function startFoodPick(handler: PickHandler): void {
  useFoodPicker.getState().setHandler(handler);
  router.push({ pathname: '/search', params: { mode: 'pick' } } as unknown as Href);
}

/** Unregisters `handler` (only if it is still the active one). Call it when the requesting screen unmounts. */
export function clearFoodPick(handler: PickHandler): void {
  if (useFoodPicker.getState().handler === handler) useFoodPicker.getState().setHandler(null);
}

/** True when a screen is waiting for a picked food. */
export function hasFoodPickHandler(): boolean {
  return useFoodPicker.getState().handler !== null;
}

/**
 * Delivers a picked food to the registered handler and clears it (one pick per request).
 * Returns false when nobody is waiting.
 */
export function deliverPickedFood(food: PickedFood): boolean {
  const { handler, setHandler } = useFoodPicker.getState();
  if (!handler) return false;
  setHandler(null);
  handler(food);
  return true;
}
