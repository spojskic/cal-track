import { Stack } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { parseNumber } from '@cal/core';

import { useContentWidth } from '@/components/desktop/shell-context';
import { formatKcal } from '@/components/food/format';
import { NumberField, TextField } from '@/components/forms';
import { AppText, Button, Card } from '@/components/ui';
import { useUnitSystem } from '@/data/profile';
import { useFoodsByIds, type IngredientFood, type RecipeDetail } from '@/data/recipes';
import type { RecipeDraft } from '@/state/recipe-draft';
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
import { computeRecipeNutrition } from './nutrition';
import { RecipeTotalsCard } from './RecipeTotalsCard';

const WIDE_LAYOUT = 760;
const MAX_SERVINGS = 1000;

export interface RecipeEditorValues {
  name: string;
  servings: number;
  finalWeightG: number | null;
  notes: string;
  ingredients: { foodId: string; grams: number }[];
}

/**
 * Form shared by /recipe/new and /recipe/edit/[id]: name, servings, cooked weight, notes, ingredient list with
 * per-ingredient amounts and a live nutrition preview. `onSubmit` receives validated values.
 */
export function RecipeEditor({
  title,
  initial,
  prefill,
  topSlot,
  banner,
  submitLabel,
  submitting,
  submitError,
  onSubmit,
}: {
  title: string;
  /** Existing recipe (edit mode). */
  initial?: RecipeDetail;
  /** Starting point of a NEW recipe (name + ingredients), e.g. the foods of a diary meal group. Ignored with `initial`. */
  prefill?: RecipeDraft | null;
  /** Rendered above the form (the AI recipe button goes here on the new-recipe screen). */
  topSlot?: ReactNode;
  banner?: ReactNode;
  submitLabel: string;
  submitting: boolean;
  submitError: string | null;
  onSubmit: (values: RecipeEditorValues) => void;
}) {
  const { colors, radius } = useTheme();
  const insets = useSafeAreaInsets();
  // The width of the area next to the sidebar (the window's, on a phone), so the two columns only start when they fit.
  const width = useContentWidth();
  const wide = width >= WIDE_LAYOUT;
  const imperial = useUnitSystem() === 'imperial';

  const [name, setName] = useState(initial?.name ?? prefill?.name ?? '');
  const [servingsText, setServingsText] = useState(initial ? String(initial.servings) : '1');
  const [finalWeightText, setFinalWeightText] = useState(
    initial?.finalWeightG ? String(Number(initial.finalWeightG.toFixed(3))) : '',
  );
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [attempted, setAttempted] = useState(false);
  const [pickNotice, setPickNotice] = useState<string | null>(null);

  const lineState = useFoodLines(() =>
    initial
      ? initial.ingredients.map((i) =>
          lineFromGrams(i.foodId, i.food?.name ?? 'Unknown food', i.food?.brand ?? null, i.grams, 3),
        )
      : (prefill?.ingredients ?? []).map((i) => lineFromGrams(i.foodId, i.name, i.brand, i.grams, 3)),
  );
  const { lines } = lineState;
  const lookup = useFoodsByIds(lines.map((l) => l.foodId));

  const addIngredient = useFoodPickRequest((food) => {
    if (initial && food.id === initial.foodId) {
      setPickNotice('A recipe cannot contain itself.');
      return;
    }
    setPickNotice(null);
    lineState.add(lineFromPick(food));
  });

  const servings = parseNumber(servingsText);
  const servingsError =
    servings === null || servings <= 0
      ? 'Enter a number greater than 0'
      : servings > MAX_SERVINGS
        ? 'That is too many servings'
        : null;
  const finalWeight = finalWeightText.trim() === '' ? null : parseNumber(finalWeightText);
  const finalWeightError =
    finalWeightText.trim() !== '' && (finalWeight === null || finalWeight <= 0)
      ? 'Enter a number greater than 0, or leave it empty'
      : null;
  const nameError = name.trim() === '' ? 'Give the recipe a name' : null;

  // Resolve every line to grams with its food's units.
  const resolved = lines.map((line) => {
    const food: IngredientFood | undefined = lookup.foods.get(line.foodId);
    const grams = lineGrams(line, lineOptions(food, imperial));
    const valid = grams !== null && grams <= MAX_LINE_GRAMS ? grams : null;
    return { line, food, grams: valid };
  });
  const pending = resolved.filter((r) => !r.food).length;
  const invalid = resolved.filter((r) => r.grams === null).length;

  const nutrition = computeRecipeNutrition(
    resolved
      .filter((r) => r.food && r.grams !== null)
      .map((r) => ({
        nutrients: (r.food as IngredientFood).nutrients,
        carbBasis: (r.food as IngredientFood).carbBasis,
        grams: r.grams as number,
      })),
    servingsError ? 0 : (servings as number),
    finalWeightError ? null : finalWeight,
  );

  const ingredientsError =
    lines.length === 0
      ? 'Add at least one ingredient'
      : invalid > 0
        ? `${invalid} ${invalid === 1 ? 'ingredient needs' : 'ingredients need'} a valid amount`
        : pending > 0
          ? lookup.isFetching
            ? 'Loading ingredients...'
            : lookup.isError
              ? 'Some ingredients could not be loaded. Check your connection.'
              : 'An ingredient could not be found. Remove it and add it again.'
          : null;

  const blockingError = nameError ?? servingsError ?? finalWeightError ?? ingredientsError;
  const hint = servingsError
    ? 'Enter the number of servings to see nutrition.'
    : pending > 0 && lookup.isFetching
      ? 'Loading ingredient data...'
      : pending > 0 || invalid > 0
        ? 'Ingredients without data or a valid amount are left out of these numbers.'
        : null;

  function submit() {
    setAttempted(true);
    if (blockingError || servings === null) return;
    onSubmit({
      name: name.trim(),
      servings,
      finalWeightG: finalWeight,
      notes: notes.trim(),
      ingredients: resolved.map((r) => ({ foodId: r.line.foodId, grams: r.grams as number })),
    });
  }

  const perServingKcal = nutrition?.perServing.ENERGY_KCAL;

  const basics = (
    <Card>
      <TextField
        label="Name"
        value={name}
        onChangeText={setName}
        placeholder="e.g. Chicken and rice"
        accessibilityLabel="Recipe name"
        autoCapitalize="sentences"
        returnKeyType="next"
        error={attempted ? nameError : null}
      />
      <NumberField
        label="Servings"
        value={servingsText}
        onChange={setServingsText}
        accessibilityLabel="Number of servings"
        hint="How many portions the finished recipe makes."
        error={servingsError && (attempted || servingsText.trim() !== '') ? servingsError : null}
        selectTextOnFocus
      />
      <NumberField
        label="Final cooked weight"
        unit="g"
        value={finalWeightText}
        onChange={setFinalWeightText}
        accessibilityLabel="Final cooked weight in grams, optional"
        placeholder="Optional"
        hint="Optional. Weigh the finished dish: cooking loses water, so per-100 g values are more accurate. Left empty, the ingredient weight is used."
        error={finalWeightError}
      />
      <View style={styles.notesField}>
        <AppText variant="label" muted>Notes and instructions</AppText>
        <TextInput
          value={notes}
          onChangeText={setNotes}
          multiline
          placeholder="Optional"
          placeholderTextColor={colors.textMuted}
          accessibilityLabel="Notes and instructions"
          textAlignVertical="top"
          style={[
            styles.notes,
            { color: colors.text, borderColor: colors.border, backgroundColor: colors.surfaceAlt, borderRadius: radius.md },
          ]}
        />
      </View>
    </Card>
  );

  const ingredientsCard = (
    <Card>
      <AppText variant="heading" accessibilityRole="header">Ingredients</AppText>
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
        emptyText="No ingredients yet. Add the foods this recipe is made of."
      />
      {pickNotice ? (
        <AppText variant="small" style={{ color: colors.danger }} accessibilityLiveRegion="polite">
          {pickNotice}
        </AppText>
      ) : null}
      {attempted && ingredientsError ? (
        <AppText variant="small" style={{ color: colors.danger }} accessibilityLiveRegion="polite">
          {ingredientsError}
        </AppText>
      ) : null}
      <Button label="Add ingredient" variant="secondary" onPress={addIngredient} />
    </Card>
  );

  const totals = <RecipeTotalsCard nutrition={nutrition} hasCookedWeight={finalWeight !== null && !finalWeightError} hint={hint} />;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: true, title }} />
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <View style={styles.content}>
          {topSlot}
          {banner}
          <View style={[styles.columns, wide && styles.columnsWide]}>
            <View style={wide ? styles.colMain : styles.col}>
              {basics}
              {ingredientsCard}
            </View>
            <View style={wide ? styles.colSide : styles.col}>{totals}</View>
          </View>
        </View>
      </ScrollView>
      <View
        style={[
          styles.footer,
          { backgroundColor: colors.surface, borderTopColor: colors.border, paddingBottom: Math.max(insets.bottom, spacing.md) },
        ]}>
        <View style={styles.footerInner}>
          {submitError ? (
            <AppText variant="small" style={{ color: colors.danger }} accessibilityLiveRegion="polite">
              {submitError}
            </AppText>
          ) : attempted && blockingError ? (
            <AppText variant="small" style={{ color: colors.danger }} accessibilityLiveRegion="polite">
              {blockingError}
            </AppText>
          ) : null}
          <Button
            label={perServingKcal === undefined ? submitLabel : `${submitLabel} \u00B7 ${formatKcal(perServingKcal)} kcal per serving`}
            onPress={submit}
            loading={submitting}
            disabled={submitting}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { flexGrow: 1 },
  content: { width: '100%', maxWidth: MAX_CONTENT_WIDTH, alignSelf: 'center', padding: spacing.lg, gap: spacing.lg },
  columns: { gap: spacing.lg },
  columnsWide: { flexDirection: 'row', alignItems: 'flex-start' },
  col: { gap: spacing.lg },
  colMain: { flex: 3, gap: spacing.lg },
  colSide: { flex: 2, gap: spacing.lg },
  notesField: { gap: spacing.xs },
  notes: {
    minHeight: 96,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
    fontSize: 16,
  },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing.md, paddingHorizontal: spacing.lg },
  footerInner: { width: '100%', maxWidth: MAX_CONTENT_WIDTH, alignSelf: 'center', gap: spacing.sm },
});
