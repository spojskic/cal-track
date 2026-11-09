import { useLocalSearchParams } from 'expo-router';

import { firstParam } from '@/components/food/format';
import { SavedMealEditor, SavedMealMessage } from '@/components/recipes/SavedMealEditor';
import { errorMessage } from '@/data/foods';
import { useSavedMeal } from '@/data/saved-meals';

/** A saved meal: edit its foods and amounts, add it to a diary meal group, or delete it. */
export default function SavedMealScreen() {
  const params = useLocalSearchParams<{ id: string; mealGroupId?: string }>();
  const id = firstParam(params.id);
  const query = useSavedMeal(id);

  if (query.isLoading) return <SavedMealMessage loading />;
  if (query.error) {
    return (
      <SavedMealMessage
        title="Could not load this meal"
        message={errorMessage(query.error)}
        onRetry={() => query.refetch()}
      />
    );
  }
  if (!query.data) {
    return (
      <SavedMealMessage
        title="Saved meal not found"
        message="It may have been deleted, or it belongs to another account."
      />
    );
  }
  const mealGroupParam = firstParam(params.mealGroupId);
  return (
    <SavedMealEditor
      key={query.data.id}
      initial={query.data}
      {...(mealGroupParam ? { mealGroupParam } : {})}
    />
  );
}
