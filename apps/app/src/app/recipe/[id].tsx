import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { deriveNutrients, scaleNutrients } from '@ration/core';

import { useContentWidth } from '@/components/desktop/shell-context';
import { CompletenessLabel } from '@/components/food/completeness';
import { formatKcal, firstParam, trimNumber } from '@/components/food/format';
import { MacroSummary } from '@/components/food/macro-summary';
import { NutrientPanel } from '@/components/food/nutrient-panel';
import { SourceBadge } from '@/components/food/source-badge';
import { Segmented } from '@/components/forms';
import { lineKcal } from '@/components/recipes/FoodLines';
import { goBackOr, open, openFood, replaceWith } from '@/components/recipes/nav';
import { nutrientNames } from '@/components/recipes/RecipeTotalsCard';
import { AppText, Button, Card } from '@/components/ui';
import { errorMessage } from '@/data/foods';
import {
  recipeNutritionOf,
  useDeleteRecipe,
  useDuplicateRecipe,
  useRecipe,
  type RecipeDetail,
} from '@/data/recipes';
import { useTargets } from '@/data/targets';
import { useAuth } from '@/lib/auth';
import { MAX_CONTENT_WIDTH, spacing, useTheme } from '@/theme';

const WIDE_LAYOUT = 760;

type ViewKey = 'serving' | '100g' | 'recipe';

export default function RecipeScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ id: string; notice?: string; mealGroupId?: string }>();
  const id = firstParam(params.id);
  const query = useRecipe(id);

  if (query.isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: true, title: 'Recipe' }} />
        <ActivityIndicator color={colors.primary} accessibilityLabel="Loading recipe" />
      </View>
    );
  }

  if (query.error || !query.data) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background, padding: spacing.lg }]}>
        <Stack.Screen options={{ headerShown: true, title: 'Recipe' }} />
        <Card style={styles.messageCard}>
          <AppText variant="heading">{query.error ? 'Could not load this recipe' : 'Recipe not found'}</AppText>
          <AppText muted>
            {query.error ? errorMessage(query.error) : 'It may have been deleted, or it belongs to another account.'}
          </AppText>
          {query.error ? <Button label="Try again" onPress={() => query.refetch()} /> : null}
          <Button label="Back" variant="secondary" onPress={() => goBackOr('/foods')} />
        </Card>
      </View>
    );
  }

  return (
    <RecipeDetailView
      key={query.data.foodId}
      recipe={query.data}
      versionNotice={firstParam(params.notice) === 'version'}
      mealGroupId={firstParam(params.mealGroupId)}
    />
  );
}

function RecipeDetailView({
  recipe,
  versionNotice,
  mealGroupId,
}: {
  recipe: RecipeDetail;
  versionNotice: boolean;
  mealGroupId: string | undefined;
}) {
  const { colors, radius } = useTheme();
  const insets = useSafeAreaInsets();
  // The width of the area next to the sidebar (the window's, on a phone), so the two columns only start when they fit.
  const width = useContentWidth();
  const wide = width >= WIDE_LAYOUT;
  const userId = useAuth().session?.user.id;
  const targets = useTargets().data?.nutrients;

  const duplicate = useDuplicateRecipe();
  const remove = useDeleteRecipe();
  const [view, setView] = useState<ViewKey>('serving');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const canEdit = Boolean(userId) && recipe.ownerId === userId && !recipe.archived;
  const singleServing = Math.abs(recipe.servings - 1) < 1e-9;

  const viewGrams =
    view === 'serving' ? recipe.servingWeightG : view === '100g' ? 100 : recipe.effectiveWeightG;
  const amounts = scaleNutrients(recipe.nutrients, viewGrams);
  const derived = deriveNutrients(amounts, { carbBasis: recipe.carbBasis });
  const energyEstimated = amounts.ENERGY_KCAL === undefined && derived.ENERGY_KCAL !== undefined;
  const nutrition = recipeNutritionOf(recipe);
  const incomplete = nutrition?.incompleteNutrients ?? [];

  const viewOptions: { value: ViewKey; label: string }[] = [
    { value: 'serving', label: 'Per serving' },
    { value: '100g', label: 'Per 100 g' },
    ...(singleServing ? [] : [{ value: 'recipe' as const, label: 'Full recipe' }]),
  ];

  const perServingKcal = scaleNutrients(recipe.nutrients, recipe.servingWeightG).ENERGY_KCAL;

  const banners = (
    <>
      {recipe.archived ? (
        <Card>
          <AppText variant="heading">
            {recipe.supersededById ? 'This version was replaced' : 'This recipe was deleted'}
          </AppText>
          <AppText muted>
            {recipe.supersededById
              ? 'The recipe was edited after it was logged, so earlier entries keep these old values. New entries should use the current version.'
              : 'It is hidden from search and your lists. Entries you logged earlier are unchanged.'}
          </AppText>
          {recipe.supersededById ? (
            <Button
              label="Open current version"
              onPress={() => replaceWith('/recipe/[id]', { id: recipe.supersededById as string })}
            />
          ) : null}
        </Card>
      ) : null}
      {versionNotice ? (
        <Card>
          <AppText variant="heading">Saved as a new version</AppText>
          <AppText muted>
            This recipe was already logged, so your earlier diary entries keep their old nutrient values.
          </AppText>
        </Card>
      ) : null}
    </>
  );

  const header = (
    <Card>
      <AppText variant="heading" accessibilityRole="header">
        {recipe.name}
      </AppText>
      <View style={styles.metaRow}>
        <SourceBadge source="recipe" />
        <CompletenessLabel value={recipe.completeness} />
      </View>
      <View style={styles.stats}>
        <Stat label="Servings" value={trimNumber(recipe.servings, 2)} />
        <Stat label="Serving size" value={`${trimNumber(recipe.servingWeightG, 1)} g`} />
        <Stat
          label={recipe.finalWeightG ? 'Cooked weight' : 'Ingredient weight'}
          value={`${trimNumber(recipe.effectiveWeightG, 1)} g`}
        />
      </View>
      {recipe.finalWeightG && Math.abs(recipe.finalWeightG - recipe.rawWeightG) > 0.05 ? (
        <AppText variant="small" muted>
          Ingredients weigh {trimNumber(recipe.rawWeightG, 1)} g raw.
        </AppText>
      ) : null}
      {canEdit ? (
        <>
          <Button
            label="Edit recipe"
            variant="secondary"
            onPress={() => open('/recipe/edit/[id]', { id: recipe.foodId })}
          />
          <Button
            label="Duplicate recipe"
            variant="secondary"
            loading={duplicate.isPending}
            onPress={() =>
              duplicate.mutate(recipe.foodId, { onSuccess: (res) => replaceWith('/recipe/[id]', { id: res.foodId }) })
            }
          />
          {duplicate.error ? (
            <AppText variant="small" style={{ color: colors.danger }} accessibilityLiveRegion="polite">
              {errorMessage(duplicate.error)}
            </AppText>
          ) : null}
          {confirmDelete ? (
            <View style={[styles.confirm, { borderColor: colors.danger, borderRadius: radius.md }]}>
              <AppText style={{ fontWeight: '600' }}>Delete this recipe?</AppText>
              <AppText variant="small" muted>
                It disappears from search and your lists. Entries you already logged keep their values.
              </AppText>
              {remove.error ? (
                <AppText variant="small" style={{ color: colors.danger }}>
                  {errorMessage(remove.error)}
                </AppText>
              ) : null}
              <View style={styles.confirmButtons}>
                <View style={styles.flex}>
                  <Button label="Keep" variant="secondary" onPress={() => setConfirmDelete(false)} />
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Confirm delete recipe"
                  disabled={remove.isPending}
                  onPress={() => remove.mutate(recipe.foodId, { onSuccess: () => goBackOr('/foods') })}
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
              accessibilityLabel="Delete recipe"
              onPress={() => setConfirmDelete(true)}
              style={styles.deleteLink}>
              <AppText style={{ color: colors.danger, fontWeight: '700' }}>Delete recipe</AppText>
            </Pressable>
          )}
        </>
      ) : null}
    </Card>
  );

  const ingredients = (
    <Card>
      <AppText variant="heading" accessibilityRole="header">
        Ingredients
      </AppText>
      {recipe.ingredients.length === 0 ? (
        <AppText muted>This recipe has no ingredients.</AppText>
      ) : (
        recipe.ingredients.map((ing) => {
          const kcal = lineKcal(ing.food ?? undefined, ing.grams);
          const label = ing.food?.name ?? 'Unavailable food';
          return (
            <Pressable
              key={ing.id}
              accessibilityRole="button"
              accessibilityLabel={`${label}, ${trimNumber(ing.grams, 1)} grams${kcal === undefined ? '' : `, ${formatKcal(kcal)} kilocalories`}. Open food`}
              disabled={!ing.food}
              onPress={() => openFood(ing.foodId, ing.food?.kind)}
              style={({ pressed }) => [styles.ingredient, { borderColor: colors.border }, pressed && { opacity: 0.7 }]}>
              <View style={styles.flex}>
                <AppText style={{ fontWeight: '600' }} numberOfLines={2}>
                  {label}
                </AppText>
                {ing.food?.brand ? (
                  <AppText variant="small" muted numberOfLines={1}>
                    {ing.food.brand}
                  </AppText>
                ) : null}
              </View>
              <View style={styles.ingredientAmount}>
                <AppText style={{ fontWeight: '700' }}>{trimNumber(ing.grams, 1)} g</AppText>
                <AppText variant="small" muted>
                  {kcal === undefined ? '-' : `${formatKcal(kcal)} kcal`}
                </AppText>
              </View>
            </Pressable>
          );
        })
      )}
    </Card>
  );

  const notes = recipe.notes ? (
    <Card>
      <AppText variant="heading" accessibilityRole="header">
        Notes
      </AppText>
      <AppText>{recipe.notes}</AppText>
    </Card>
  ) : null;

  const nutritionBlock = (
    <>
      {viewOptions.length > 1 ? (
        <Segmented<ViewKey> options={viewOptions} value={view} onChange={setView} />
      ) : null}
      <AppText variant="small" muted>
        Values for {trimNumber(viewGrams, 1)} g
        {view === 'serving' ? ' (1 serving)' : view === 'recipe' ? ' (whole recipe)' : ''}.
      </AppText>
      <MacroSummary
        kcal={derived.ENERGY_KCAL}
        protein={derived.PROTEIN_G}
        carbs={derived.CARBS_G}
        fat={derived.FAT_G}
        estimated={energyEstimated}
      />
      {incomplete.length > 0 ? (
        <AppText variant="small" style={{ color: colors.warning }}>
          Incomplete data: {nutrientNames(incomplete)} {incomplete.length === 1 ? 'is' : 'are'} missing for some
          ingredients, so these amounts can be too low.
        </AppText>
      ) : null}
      <NutrientPanel amounts={amounts} carbBasis={recipe.carbBasis} {...(targets ? { targets } : {})} />
    </>
  );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: true, title: recipe.name }} />
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={[styles.content, wide && styles.contentWide]}>
          <View style={wide ? styles.colLeft : styles.col}>
            {banners}
            {header}
            {ingredients}
            {notes}
          </View>
          <View style={wide ? styles.colRight : styles.col}>{nutritionBlock}</View>
        </View>
      </ScrollView>
      {!recipe.archived ? (
        <View
          style={[
            styles.footer,
            { backgroundColor: colors.surface, borderTopColor: colors.border, paddingBottom: Math.max(insets.bottom, spacing.md) },
          ]}>
          <View style={styles.footerInner}>
            <Button
              label={`Add 1 serving to diary${perServingKcal === undefined ? '' : ` \u00B7 ${formatKcal(perServingKcal)} kcal`}`}
              onPress={() => open('/food/[id]', { id: recipe.foodId, ...(mealGroupId ? { mealGroupId } : {}) })}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View accessible accessibilityLabel={`${label}: ${value}`} style={styles.stat}>
      <AppText variant="small" muted>
        {label}
      </AppText>
      <AppText style={{ fontWeight: '700' }}>{value}</AppText>
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
  colLeft: { width: 340, gap: spacing.lg },
  colRight: { flex: 1, gap: spacing.lg },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.md },
  stats: { flexDirection: 'row', gap: spacing.lg, flexWrap: 'wrap' },
  stat: { gap: 2 },
  flex: { flex: 1 },
  ingredient: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 52,
  },
  ingredientAmount: { alignItems: 'flex-end' },
  confirm: { borderWidth: 1, padding: spacing.md, gap: spacing.md },
  confirmButtons: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  deleteConfirm: { flex: 1, minHeight: 46, alignItems: 'center', justifyContent: 'center' },
  deleteLink: { alignItems: 'center', justifyContent: 'center', minHeight: 44 },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing.md, paddingHorizontal: spacing.lg },
  footerInner: { width: '100%', maxWidth: MAX_CONTENT_WIDTH, alignSelf: 'center', gap: spacing.sm },
});
