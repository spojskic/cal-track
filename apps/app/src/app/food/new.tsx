import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AiLabelButton, LabelDraftBanner } from '@/components/ai';
import { displayGtin, firstParam } from '@/components/food/format';
import { FoodForm } from '@/components/food/food-form';
import { MAX_CONTENT_WIDTH, spacing, useTheme } from '@/theme';
import { AppText, Button, Card } from '@/components/ui';
import { errorMessage, normalizeGtin, useCreateFood } from '@/data/foods';
import { clearLabelDraft, formInitialFromDraft, useLabelDraft } from '@/state/label-draft';

/**
 * Custom food creation. Optional params: `gtin` (prefill barcode), `name`, `mealGroupId`.
 * With the AI gate open the top of the form offers "Scan nutrition label"; the scan leaves its result in the label
 * draft store, which this screen shows (with a banner) and forgets when it closes. Nothing is saved before Save food.
 */
export default function NewFoodScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ gtin?: string; name?: string; mealGroupId?: string }>();
  const create = useCreateFood();
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null);
  const scan = useLabelDraft((s) => s.current);
  // Read from a label scan, shown until this screen closes.
  useEffect(() => () => clearLabelDraft(), []);

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
  const gtinDisplay = gtin14 ? displayGtin(gtin14) : undefined;
  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: true, title: 'New food' }} />
      <FoodForm
        // A new scan replaces the form with the freshly read values.
        key={scan ? `label-${scan.id}` : 'blank'}
        initial={
          scan
            ? formInitialFromDraft(scan.draft, { name: nameParam, gtin: gtinDisplay })
            : {
                ...(nameParam ? { name: nameParam } : {}),
                ...(gtinDisplay ? { gtin: gtinDisplay } : {}),
              }
        }
        header={
          scan ? (
            <LabelDraftBanner draft={scan.draft} gtin={gtin14 ?? undefined} mealGroupId={mealGroupId} />
          ) : (
            // Renders nothing unless the AI gate is open (valid key + image-capable model).
            <AiLabelButton fromForm gtin={gtin14 ?? undefined} mealGroupId={mealGroupId} />
          )
        }
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
