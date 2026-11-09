import { Stack, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { firstParam } from '@/components/food/format';
import { goBackOr, replaceWith } from '@/components/recipes/nav';
import { RecipeEditor } from '@/components/recipes/RecipeEditor';
import { AppText, Button, Card } from '@/components/ui';
import { errorMessage } from '@/data/foods';
import { useRecipe, useUpdateRecipe } from '@/data/recipes';
import { useAuth } from '@/lib/auth';
import { spacing, useTheme } from '@/theme';

/**
 * Edit one of the user's recipes. A recipe that was already logged (or is an ingredient of another recipe)
 * keeps its old nutrient values for those entries: saving creates a new version instead.
 */
export default function EditRecipeScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ id: string }>();
  const id = firstParam(params.id);
  const query = useRecipe(id);
  const update = useUpdateRecipe();
  const userId = useAuth().session?.user.id;

  const recipe = query.data;
  const editable = Boolean(recipe) && Boolean(userId) && recipe?.ownerId === userId && !recipe?.archived;

  if (query.isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: true, title: 'Edit recipe' }} />
        <ActivityIndicator color={colors.primary} accessibilityLabel="Loading recipe" />
      </View>
    );
  }

  if (query.error || !recipe || !editable || !id) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background, padding: spacing.lg }]}>
        <Stack.Screen options={{ headerShown: true, title: 'Edit recipe' }} />
        <Card style={styles.messageCard}>
          <AppText variant="heading">This recipe cannot be edited</AppText>
          <AppText muted>
            {query.error
              ? errorMessage(query.error)
              : 'Only your own recipes, in their current version, can be edited.'}
          </AppText>
          <Button label="Back" variant="secondary" onPress={() => goBackOr('/foods')} />
        </Card>
      </View>
    );
  }

  return (
    <RecipeEditor
      key={recipe.foodId}
      title="Edit recipe"
      initial={recipe}
      banner={
        <AppText variant="small" muted>
          Entries you already logged keep their old nutrient values. If this recipe was logged, saving creates a new version of it.
        </AppText>
      }
      submitLabel="Save changes"
      submitting={update.isPending}
      submitError={update.error ? errorMessage(update.error) : null}
      onSubmit={(values) =>
        update.mutate(
          {
            foodId: recipe.foodId,
            name: values.name,
            servings: values.servings,
            finalWeightG: values.finalWeightG,
            notes: values.notes,
            ingredients: values.ingredients,
          },
          {
            onSuccess: (res) =>
              replaceWith('/recipe/[id]', { id: res.foodId, ...(res.superseded ? { notice: 'version' } : {}) }),
          },
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  messageCard: { width: '100%', maxWidth: 480 },
});
