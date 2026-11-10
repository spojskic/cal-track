import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { errorMessage, lookupBarcode, useQuickAddFood, type FoodSummary, type OnlineSearchResult } from '@/data/foods';
import { fetchDefaultServing } from '@/data/recipes';
import { deliverPickedFood, hasFoodPickHandler } from '@/state/food-picker';
import { useSelectedDate } from '@/state/selected-date';

import { hapticSelection } from './feedback';
import { NO_MEAL_MESSAGE, onlineImportStep, quickAddMessage } from './food-search';
import type { QuickAddState } from './food-row';
import { formatDayLabel } from './format';

export interface ToastState {
  message: string;
  tone: 'success' | 'error';
}

/** The part of a food a row action needs. */
type RowFood = Pick<FoodSummary, 'id' | 'name' | 'brand'> & { kind?: FoodSummary['kind'] };

export interface FoodRowActionsOptions {
  /** The meal a quick add (the "+" on a row) goes to, with its name for the message. */
  mealGroupId: string | undefined;
  mealGroupName: string | undefined;
  /** /search?mode=pick: a row hands its food to the screen that is waiting for one (a recipe ingredient, a saved meal) instead of opening or adding it. */
  pickMode?: boolean;
  /** Opens the page of a food. Default: /food/[id], carrying the meal. */
  openDetail?: (id: string, kind?: string) => void;
}

export interface FoodRowActions {
  /** A short message to show (render it with `Toast`), or null. */
  toast: ToastState | null;
  /** The "+" of this food: idle, pending (adding / picking) or done (added). */
  stateOf: (id: string) => QuickAddState;
  /** The row was tapped: opens the food (pick mode: hands it over). */
  press: (food: RowFood) => void;
  /** The "+" of the row: adds one serving to the meal for the selected day (pick mode: hands the food over). */
  quickAdd: (food: FoodSummary) => void;
  online: {
    /** The gtin14 of the online result that is being imported. */
    openingId: string | null;
    error: string | null;
    /** An online result was tapped: finds or imports its food, then opens it (pick mode: hands it over). */
    open: (result: OnlineSearchResult) => Promise<void>;
  };
}

/**
 * What the rows of a food list do: open the food, add one serving of it to the diary with the "+" (with the same "added" feedback
 * everywhere), hand it to a waiting screen in pick mode, or import an online result first. Shared by the Add food screen and the Foods tab.
 */
export function useFoodRowActions(options: FoodRowActionsOptions): FoodRowActions {
  const { mealGroupId, mealGroupName, pickMode = false } = options;
  const date = useSelectedDate((s) => s.date);
  const quickAddFood = useQuickAddFood();

  const [addingId, setAddingId] = useState<string | null>(null);
  const [addedIds, setAddedIds] = useState<ReadonlySet<string>>(new Set());
  const [pickingId, setPickingId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const showToast = useCallback((message: string, tone: ToastState['tone']) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, tone });
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  function openDetail(id: string, kind?: string) {
    if (options.openDetail) {
      options.openDetail(id, kind);
      return;
    }
    router.push({ pathname: '/food/[id]', params: { id, ...(mealGroupId ? { mealGroupId } : {}) } });
  }

  /** Pick mode: hand the food (with its default serving) to the waiting screen and go back. */
  async function pickFood(food: RowFood) {
    if (!hasFoodPickHandler()) {
      // Nothing is waiting for a food (e.g. a stale link): behave like the normal search.
      openDetail(food.id, food.kind);
      return;
    }
    hapticSelection();
    setPickingId(food.id);
    try {
      const serving = await fetchDefaultServing(food.id);
      deliverPickedFood({
        id: food.id,
        name: food.name,
        brand: food.brand,
        grams: serving.grams,
        amount: serving.amount,
        portionLabel: serving.label,
      });
      if (router.canGoBack()) router.back();
      else router.replace('/');
    } catch (e) {
      showToast(`Could not use this food: ${errorMessage(e)}`, 'error');
    } finally {
      setPickingId(null);
    }
  }

  function press(food: RowFood) {
    if (pickMode) void pickFood(food);
    else openDetail(food.id, food.kind);
  }

  function quickAdd(food: FoodSummary) {
    if (pickMode) {
      void pickFood(food);
      return;
    }
    if (!mealGroupId) {
      showToast(NO_MEAL_MESSAGE, 'error');
      return;
    }
    hapticSelection();
    setAddingId(food.id);
    quickAddFood.mutate(
      { foodId: food.id, mealGroupId, entryDate: date },
      {
        onSuccess: (serving) => {
          setAddedIds((prev) => new Set(prev).add(food.id));
          showToast(
            quickAddMessage({ amount: serving.amount, label: serving.label, name: food.name, mealName: mealGroupName, day: formatDayLabel(date) }),
            'success',
          );
        },
        onError: (e) => showToast(`Could not add: ${errorMessage(e)}`, 'error'),
        onSettled: () => setAddingId(null),
      },
    );
  }

  async function openOnlineResult(result: OnlineSearchResult) {
    setOpening(result.gtin14);
    setOpenError(null);
    const step = onlineImportStep(await lookupBarcode(result.gtin14));
    setOpening(null);
    if (step.kind === 'error') {
      setOpenError(step.message);
    } else if (pickMode) {
      await pickFood({ id: step.foodId, name: result.name, brand: result.brand });
    } else {
      openDetail(step.foodId);
    }
  }

  return {
    toast,
    stateOf: (id) => (addingId === id || pickingId === id ? 'pending' : addedIds.has(id) ? 'done' : 'idle'),
    press,
    quickAdd,
    online: { openingId: opening, error: openError, open: openOnlineResult },
  };
}
