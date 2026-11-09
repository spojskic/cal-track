import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { displayGtin, firstParam } from '@/components/food/format';
import { FoodForm } from '@/components/food/food-form';
import { MAX_CONTENT_WIDTH, spacing, useTheme } from '@/theme';
import { AppText, Button, Card } from '@/components/ui';
import { errorMessage, normalizeGtin, useCreateFood } from '@/data/foods';

/** Custom food creation. Optional params: `gtin` (prefill barcode), `name`, `mealGroupId`. */
export default function NewFoodScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ gtin?: string; name?: string; mealGroupId?: string }>();
  const create = useCreateFood();
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null);

  const mealGroupId = firstParam(params.mealGroupId);
  const gtinParam = firstParam(params.gtin);
  const gtin14 = normalizeGtin(gtinParam);

  function done() {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  if (saved) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: true, title: 'Food saved', headerBackVisible: false }} />
        <View style={styles.content}>
          <Card>
            <AppText variant="heading" accessibilityLiveRegion="polite">Saved</AppText>
            <AppText muted>
              {'\u201C'}{saved.name}{'\u201D'} is now in My foods. You can log it right away.
            </AppText>
            <Button
              label="Add to diary"
              onPress={() =>
                router.replace({
                  pathname: '/food/[id]',
                  params: { id: saved.id, ...(mealGroupId ? { mealGroupId } : {}) },
                })
              }
            />
            <Button label="Done" variant="secondary" onPress={done} />
          </Card>
        </View>
      </View>
    );
  }

  const nameParam = firstParam(params.name);
  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: true, title: 'New food' }} />
      <FoodForm
        initial={{
          ...(nameParam ? { name: nameParam } : {}),
          ...(gtin14 ? { gtin: displayGtin(gtin14) } : {}),
        }}
        submitLabel="Save food"
        submitting={create.isPending}
        submitError={create.error ? errorMessage(create.error) : null}
        onCancel={done}
        onSubmit={(input) =>
          create.mutate(input, { onSuccess: (res) => setSaved({ id: res.id, name: input.name }) })
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: {
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
    padding: spacing.lg,
    gap: spacing.lg,
  },
});
