import { Stack, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { deriveNutrients, scaleNutrients, sumNutrients } from '@cal/core';

import { useContentWidth } from '@/components/desktop/shell-context';
import { DayStepper } from '@/components/food/day-stepper';
import { hapticSuccess } from '@/components/food/feedback';
import { formatDayLabel } from '@/components/food/format';
import { MacroSummary } from '@/components/food/macro-summary';
import { MealGroupChips, useMealGroupChoice } from '@/components/food/meal-group-chips';
import { Toast } from '@/components/food/toast';
import { TextField } from '@/components/forms';
import { AppText, Button, Card } from '@/components/ui';
import { errorMessage } from '@/data/foods';
import { useUnitSystem } from '@/data/profile';
import { useFoodsByIds, type IngredientFood } from '@/data/recipes';
import {
  useCreateSavedMeal,
  useDeleteSavedMeal,
  useLogSavedMeal,
  useUpdateSavedMeal,
  type SavedMeal,
} from '@/data/saved-meals';
import { useSelectedDate } from '@/state/selected-date';
import { MAX_CONTENT_WIDTH, spacing, useTheme } from '@/theme';

import {
  FoodLineList,
  lineFromGrams,
  lineFromPick,
  lineGrams,
  lineOptions,
  MAX_LINE_GRAMS,
  useFoodLines,
  useFoodPickRequest,
} from './FoodLines';
import { goBackOr, replaceWith } from './nav';

const WIDE_LAYOUT = 760;

function leaveAfterAdd() {
  if (router.canDismiss()) router.dismissAll();
  else if (router.canGoBack()) router.back();
  else router.replace('/');
}

/**
 * Create (no `initial`) or edit a saved meal: name, foods with amounts, totals. In edit mode it also logs the
 * meal into the diary (meal group + day) and deletes it.
 */
export function SavedMealEditor({ initial, mealGroupParam }: { initial?: SavedMeal; mealGroupParam?: string }) {
  const { colors, radius } = useTheme();
  const insets = useSafeAreaInsets();
  // The width of the area next to the sidebar (the window's, on a phone), so the two columns only start when they fit.
  const width = useContentWidth();
  const wide = width >= WIDE_LAYOUT;
  const imperial = useUnitSystem() === 'imperial';
  const date = useSelectedDate((s) => s.date);

  const create = useCreateSavedMeal();
  const update = useUpdateSavedMeal();
  const remove = useDeleteSavedMeal();
  const log = useLogSavedMeal(initial?.id);
  const meal = useMealGroupChoice(mealGroupParam);

  const [name, setName] = useState(initial?.name ?? '');
  const [attempted, setAttempted] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [added, setAdded] = useState<{ count: number } | null>(null);

  const lineState = useFoodLines(() =>
    (initial?.items ?? []).map((i) => lineFromGrams(i.foodId, i.food.name, i.food.brand, i.grams, 3)),
  );
  const { lines } = lineState;
  const lookup = useFoodsByIds(lines.map((l) => l.foodId));
  const addFood = useFoodPickRequest((food) => lineState.add(lineFromPick(food)));

  useEffect(() => {
    if (!added) return;
    const t = setTimeout(leaveAfterAdd, 800);
    return () => clearTimeout(t);
  }, [added]);

  const resolved = lines.map((line) => {
    const food: IngredientFood | undefined = lookup.foods.get(line.foodId);
    const grams = lineGrams(line, lineOptions(food, imperial));
    return { line, food, grams: grams !== null && grams <= MAX_LINE_GRAMS ? grams : null };
  });
  const invalid = resolved.filter((r) => r.grams === null).length;
  const pending = resolved.filter((r) => !r.food).length;

  const totals = sumNutrients(
    resolved
      .filter((r) => r.food && r.grams !== null)
      .map((r) =>
        deriveNutrients(scaleNutrients((r.food as IngredientFood).nutrients, r.grams as number), {
          carbBasis: (r.food as IngredientFood).carbBasis,
        }),
      ),
  );

  const nameError = name.trim() === '' ? 'Give the meal a name' : null;
  const itemsError =
    lines.length === 0
      ? 'Add at least one food'
      : invalid > 0
        ? `${invalid} ${invalid === 1 ? 'food needs' : 'foods need'} a valid amount`
        : pending > 0
          ? lookup.isFetching
            ? 'Loading foods...'
            : 'A food could not be loaded. Remove it and add it again.'
          : null;
  const blockingError = nameError ?? itemsError;

  const items = resolved.map((r) => ({ foodId: r.line.foodId, grams: r.grams ?? 0 }));
  const dirty = initial
    ? name.trim() !== initial.name ||
      items.length !== initial.items.length ||
      items.some((it, i) => {
        const original = initial.items[i];
        return !original || original.foodId !== it.foodId || Math.abs(original.grams - it.grams) > 0.0005;
      })
    : true;

  const saving = create.isPending || update.isPending;
  const saveError = create.error ?? update.error;

  function save() {
    setAttempted(true);
    if (blockingError) return;
    if (initial) {
      update.mutate(
        { id: initial.id, name: name.trim(), items },
        {
          onSuccess: () => {
            hapticSuccess();
            setSavedAt(Date.now());
          },
        },
      );
    } else {
      create.mutate(
        { name: name.trim(), items },
        { onSuccess: (res) => replaceWith('/saved-meal/[id]', { id: res.id }) },
      );
    }
  }

  function addToDiary() {
    if (!initial || !meal.mealGroupId) return;
    log.mutate(
      { savedMealId: initial.id, date, mealGroupId: meal.mealGroupId },
      {
        onSuccess: (count) => {
          hapticSuccess();
          setAdded({ count });
        },
      },
    );
  }

  const totalsCard = (
    <MacroSummary kcal={totals.ENERGY_KCAL} protein={totals.PROTEIN_G} carbs={totals.CARBS_G} fat={totals.FAT_G} />
  );

  const form = (
    <Card>
      <TextField
        label="Name"
        value={name}
        onChangeText={setName}
        placeholder="e.g. Usual breakfast"
        accessibilityLabel="Saved meal name"
        autoCapitalize="sentences"
        error={attempted ? nameError : null}
      />
      <AppText variant="heading" accessibilityRole="header">Foods</AppText>
      <FoodLineList
        lines={lines}
        foods={lookup.foods}
        loading={lookup.isFetching}
        imperial={imperial}
        openKey={lineState.openKey}
        onOpenChange={lineState.setOpenKey}
        onChange={lineState.patch}
        onRemove={lineState.remove}
        onMove={lineState.move}
        emptyText="No foods yet. Add the foods that make up this meal."
      />
      {attempted && itemsError ? (
        <AppText variant="small" style={{ color: colors.danger }} accessibilityLiveRegion="polite">
          {itemsError}
        </AppText>
      ) : null}
      <Button label="Add food" variant="secondary" onPress={addFood} />
    </Card>
  );

  const logCard = initial ? (
    <Card>
      <AppText variant="heading" accessibilityRole="header">Add to diary</AppText>
      {dirty ? (
        <AppText variant="small" muted>Save your changes first. The saved version is what gets added.</AppText>
      ) : null}
      <AppText variant="label" muted>Meal</AppText>
      {meal.groups.length > 0 ? (
        <MealGroupChips groups={meal.groups} value={meal.mealGroupId} onChange={meal.setMealGroupId} />
      ) : (
        <AppText muted>{meal.isLoading ? 'Loading meals...' : 'No meal groups found.'}</AppText>
      )}
      <AppText variant="label" muted>Date</AppText>
      <DayStepper />
      {log.error ? (
        <AppText variant="small" style={{ color: colors.danger }} accessibilityLiveRegion="polite">
          {errorMessage(log.error)}
        </AppText>
      ) : null}
      <Button
        label={added ? 'Added' : `Add ${initial.items.length} ${initial.items.length === 1 ? 'food' : 'foods'} to ${meal.mealGroupName ?? 'diary'}`}
        onPress={addToDiary}
        loading={log.isPending}
        disabled={dirty || initial.items.length === 0 || !meal.mealGroupId || Boolean(added)}
      />
    </Card>
  ) : null;

  const deleteCard = initial ? (
    confirmDelete ? (
      <View style={[styles.confirm, { borderColor: colors.danger, borderRadius: radius.md }]}>
        <AppText style={{ fontWeight: '600' }}>Delete this saved meal?</AppText>
        <AppText variant="small" muted>Entries you already logged from it are not affected.</AppText>
        {remove.error ? (
          <AppText variant="small" style={{ color: colors.danger }}>{errorMessage(remove.error)}</AppText>
        ) : null}
        <View style={styles.confirmButtons}>
          <View style={styles.flex}>
            <Button label="Keep" variant="secondary" onPress={() => setConfirmDelete(false)} />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Confirm delete saved meal"
            disabled={remove.isPending}
            onPress={() => remove.mutate(initial.id, { onSuccess: () => goBackOr('/foods') })}
            style={[
              styles.deleteConfirm,
              { backgroundColor: colors.danger, borderRadius: radius.pill, opacity: remove.isPending ? 0.6 : 1 },
            ]}>
            {remove.isPending ? (
              <ActivityIndicator color={colors.onPrimary} />
            ) : (
              <AppText style={{ color: colors.onPrimary, fontWeight: '700', fontSize: 15 }}>Delete</AppText>
            )}
          </Pressable>
        </View>
      </View>
    ) : (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Delete saved meal"
        onPress={() => setConfirmDelete(true)}
        style={styles.deleteLink}>
        <AppText style={{ color: colors.danger, fontWeight: '700' }}>Delete saved meal</AppText>
      </Pressable>
    )
  ) : null;

  const savedJustNow = initial && !dirty && savedAt > 0;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: true, title: initial ? 'Saved meal' : 'New saved meal' }} />
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <View style={[styles.content, wide && styles.contentWide]}>
          <View style={wide ? styles.colMain : styles.col}>
            {form}
            {deleteCard}
          </View>
          <View style={wide ? styles.colSide : styles.col}>
            {totalsCard}
            {logCard}
          </View>
        </View>
      </ScrollView>
      <View
        style={[
          styles.footer,
          { backgroundColor: colors.surface, borderTopColor: colors.border, paddingBottom: Math.max(insets.bottom, spacing.md) },
        ]}>
        <View style={styles.footerInner}>
          {saveError ? (
            <AppText variant="small" style={{ color: colors.danger }} accessibilityLiveRegion="polite">
              {errorMessage(saveError)}
            </AppText>
          ) : attempted && blockingError ? (
            <AppText variant="small" style={{ color: colors.danger }} accessibilityLiveRegion="polite">
              {blockingError}
            </AppText>
          ) : null}
          <Button
            label={initial ? (savedJustNow ? 'Saved' : 'Save changes') : 'Save meal'}
            onPress={save}
            loading={saving}
            disabled={saving || (initial ? !dirty : false)}
          />
        </View>
      </View>
      {added ? (
        <Toast
          message={`Added ${added.count} ${added.count === 1 ? 'food' : 'foods'} to ${meal.mealGroupName ?? 'diary'} \u00B7 ${formatDayLabel(date)}`}
        />
      ) : null}
    </View>
  );
}

/** Loading / error shells for the saved meal screens. */
export function SavedMealMessage({
  title,
  message,
  loading,
  onRetry,
}: {
  title?: string;
  message?: string;
  loading?: boolean;
  onRetry?: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.center, { backgroundColor: colors.background, padding: spacing.lg }]}>
      <Stack.Screen options={{ headerShown: true, title: 'Saved meal' }} />
      {loading ? (
        <ActivityIndicator color={colors.primary} accessibilityLabel="Loading saved meal" />
      ) : (
        <Card style={styles.messageCard}>
          <AppText variant="heading">{title}</AppText>
          {message ? <AppText muted>{message}</AppText> : null}
          {onRetry ? <Button label="Try again" onPress={onRetry} /> : null}
          <Button label="Back" variant="secondary" onPress={() => goBackOr('/foods')} />
        </Card>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  messageCard: { width: '100%', maxWidth: 480 },
  scroll: { flexGrow: 1 },
  content: { width: '100%', maxWidth: MAX_CONTENT_WIDTH, alignSelf: 'center', padding: spacing.lg, gap: spacing.lg },
  contentWide: { flexDirection: 'row', alignItems: 'flex-start' },
  col: { gap: spacing.lg },
  colMain: { flex: 3, gap: spacing.lg },
  colSide: { flex: 2, gap: spacing.lg },
  flex: { flex: 1 },
  confirm: { borderWidth: 1, padding: spacing.md, gap: spacing.md },
  confirmButtons: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  deleteConfirm: { flex: 1, minHeight: 46, alignItems: 'center', justifyContent: 'center' },
  deleteLink: { alignItems: 'center', justifyContent: 'center', minHeight: 44 },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing.md, paddingHorizontal: spacing.lg },
  footerInner: { width: '100%', maxWidth: MAX_CONTENT_WIDTH, alignSelf: 'center', gap: spacing.sm },
});
