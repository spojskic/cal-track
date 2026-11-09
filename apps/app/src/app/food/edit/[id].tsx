import { Stack, router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { displayGtin, firstParam } from '@/components/food/format';
import { FoodForm } from '@/components/food/food-form';
import { AppText, Button, Card } from '@/components/ui';
import { errorMessage, useFood, useUpdateFood } from '@/data/foods';
import { useAuth } from '@/lib/auth';
import { spacing, useTheme } from '@/theme';

function goBack() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

/** Edit one of the user's own custom foods. Nutrient changes to an already-logged food create a new version. */
export default function EditFoodScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ id: string }>();
  const id = firstParam(params.id);
  const query = useFood(id);
  const update = useUpdateFood();
  const userId = useAuth().session?.user.id;

  const detail = query.data;
  const editable =
    detail !== undefined &&
    detail !== null &&
    Boolean(userId) &&
    detail.food.ownerId === userId &&
    detail.food.kind === 'custom' &&
    !detail.food.archived;

  if (query.isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: true, title: 'Edit food' }} />
        <ActivityIndicator color={colors.primary} accessibilityLabel="Loading food" />
      </View>
    );
  }

  if (query.error || !detail || !editable || !id) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background, padding: spacing.lg }]}>
        <Stack.Screen options={{ headerShown: true, title: 'Edit food' }} />
        <Card style={styles.messageCard}>
          <AppText variant="heading">This food cannot be edited</AppText>
          <AppText muted>
            {query.error
              ? errorMessage(query.error)
              : 'Only custom foods you created, in their current version, can be edited.'}
          </AppText>
          <Button label="Back" variant="secondary" onPress={goBack} />
        </Card>
      </View>
    );
  }

  const { food, portions } = detail;
  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: true, title: 'Edit food' }} />
      <FoodForm
        key={food.id}
        initial={{
          name: food.name,
          brand: food.brand,
          ...(food.gtin14 ? { gtin: displayGtin(food.gtin14) } : {}),
          nutrients: food.nutrients,
          carbBasis: food.carbBasis,
          densityGPerMl: food.densityGPerMl,
          servings: portions.map((p) => ({ name: p.unitLabel, grams: p.gramsPerUnit })),
        }}
        header={
          <AppText variant="small" muted>
            Entries you already logged keep their old nutrient values. Changing nutrients creates a new version of this food.
          </AppText>
        }
        submitLabel="Save changes"
        submitting={update.isPending}
        submitError={update.error ? errorMessage(update.error) : null}
        onCancel={goBack}
        onSubmit={(input) =>
          update.mutate(
            { id, input },
            {
              onSuccess: (res) => {
                if (res.superseded) {
                  router.replace({ pathname: '/food/[id]', params: { id: res.id } });
                } else {
                  goBack();
                }
              },
            },
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  messageCard: { width: '100%', maxWidth: 480 },
});
