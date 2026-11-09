import { AiRecipeButton } from '@/components/ai';
import { RecipeEditor } from '@/components/recipes/RecipeEditor';
import { replaceWith } from '@/components/recipes/nav';
import { errorMessage } from '@/data/foods';
import { useCreateRecipe } from '@/data/recipes';

/** New recipe: name, servings, cooked weight, notes and ingredients with a live nutrition preview. */
export default function NewRecipeScreen() {
  const create = useCreateRecipe();

  return (
    <RecipeEditor
      title="New recipe"
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
