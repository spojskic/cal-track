import { useEffect, useState } from 'react';

import { AiRecipeButton } from '@/components/ai';
import { RecipeEditor } from '@/components/recipes/RecipeEditor';
import { replaceWith } from '@/components/recipes/nav';
import { errorMessage } from '@/data/foods';
import { useCreateRecipe } from '@/data/recipes';
import { useRecipeDraft } from '@/state/recipe-draft';

/** New recipe: name, servings, cooked weight, notes and ingredients with a live nutrition preview. */
export default function NewRecipeScreen() {
  const create = useCreateRecipe();
  // "Create Recipe from Group" on the diary leaves its foods here; read once, cleared when this screen closes.
  const [prefill] = useState(() => useRecipeDraft.getState().draft);
  useEffect(() => () => useRecipeDraft.getState().setDraft(null), []);

  return (
    <RecipeEditor
      title="New recipe"
      prefill={prefill}
      // Renders nothing unless the AI gate is open (valid key + image-capable model).
      topSlot={<AiRecipeButton />}
      submitLabel="Save recipe"
      submitting={create.isPending}
      submitError={create.error ? errorMessage(create.error) : null}
      onSubmit={(values) =>
        create.mutate(
          {
            name: values.name,
            servings: values.servings,
            finalWeightG: values.finalWeightG,
            notes: values.notes,
            ingredients: values.ingredients,
          },
          { onSuccess: (res) => replaceWith('/recipe/[id]', { id: res.foodId }) },
        )
      }
    />
  );
}
