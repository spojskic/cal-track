// The results of a food search, drawn the same way on the Add food screen (app/search.tsx) and in place on the Foods tab: rows (name, brand,
// kcal per 100 g, quick-add "+"), the loading / error / nothing-found line, and under them the "Cannot find it?" online card and the
// "Create custom food" button. What they show is decided by useFoodSearchResults (use-food-search-results.ts) and food-search.ts; what a
// tap does by useFoodRowActions (use-food-row-actions.ts).
import { router } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { AppText, Button, Card } from '@/components/ui';
import { errorMessage, type FoodSummary } from '@/data/foods';
import { spacing, useTheme } from '@/theme';

import { noFoodsFoundText } from './food-search';
import { FoodRow } from './food-row';
import type { FoodRowActions } from './use-food-row-actions';
import type { FoodSearchResultsModel } from './use-food-search-results';

/** One food of a list: opens it when tapped (pick mode: hands it over), with the quick-add "+" on its right. */
export function FoodSearchRow({ food, actions, favorite }: { food: FoodSummary; actions: FoodRowActions; favorite?: boolean }) {
  return (
    <FoodRow
      food={food}
      favorite={favorite}
      onPress={() => actions.press(food)}
      onQuickAdd={() => actions.quickAdd(food)}
      quickAddState={actions.stateOf(food.id)}
    />
  );
}

/** What a list without rows says: it is loading, it failed, or there is nothing to show. */
export function FoodListStatus({ loading, error, emptyText }: { loading: boolean; error: unknown; emptyText: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.empty}>
      {loading ? (
        <ActivityIndicator color={colors.primary} accessibilityLabel="Loading" />
      ) : error ? (
        <AppText style={{ color: colors.danger }}>{errorMessage(error)}</AppText>
      ) : (
        <AppText muted style={styles.emptyText}>
          {emptyText}
        </AppText>
      )}
    </View>
  );
}

/**
 * Under a list: the "Cannot find it?" card that searches online (only while a search has an answer), and "Create custom food", which
 * starts the form with the typed name.
 */
export function FoodSearchFooter({
  search,
  actions,
  mealGroupId,
}: {
  search: FoodSearchResultsModel;
  actions: FoodRowActions;
  /** Passed on to the new food's form, so it can add the food to this meal. */
  mealGroupId?: string | undefined;
}) {
  const { colors } = useTheme();
  const { online } = search;
  return (
    <View style={styles.footer}>
      {online.visible ? (
        <Card>
          <AppText variant="heading">Cannot find it?</AppText>
          <AppText muted>Look for branded and packaged products in Open Food Facts.</AppText>
          <Button label="Search online (branded products)" variant="secondary" loading={online.pending} onPress={online.search} />
          {online.outcome === 'error' ? (
            <AppText style={{ color: colors.danger }} accessibilityLiveRegion="polite">
              {online.errorMessage}
            </AppText>
          ) : null}
          {online.outcome === 'empty' ? <AppText muted>No online products found for this search.</AppText> : null}
          {online.outcome === 'results' ? (
            <View>
              <AppText variant="label" muted style={styles.onlineTitle}>
                Online results
              </AppText>
              {online.results.map((r) => (
                <View key={r.gtin14} style={actions.online.openingId === r.gtin14 ? { opacity: 0.6 } : undefined}>
                  <FoodRow food={r} onPress={() => actions.online.open(r)} />
                </View>
              ))}
              {actions.online.error ? <AppText style={{ color: colors.danger }}>{actions.online.error}</AppText> : null}
            </View>
          ) : null}
        </Card>
      ) : null}
      <Button
        label="Create custom food"
        variant="secondary"
        onPress={() =>
          router.push({
            pathname: '/food/new',
            params: {
              ...(search.query ? { name: search.query } : {}),
              ...(mealGroupId ? { mealGroupId } : {}),
            },
          })
        }
      />
    </View>
  );
}

/**
 * The whole answer to a search as one block (the Foods tab shows it in place of the library list): an optional line on top, the rows or
 * the loading / error / nothing-found line, then the footer. The Add food screen keeps its own list (its tabs and meal chips share it)
 * and uses the same three parts.
 */
export function FoodSearchResults({
  search,
  actions,
  favoriteIds,
  mealGroupId,
  caption,
}: {
  search: FoodSearchResultsModel;
  actions: FoodRowActions;
  favoriteIds?: ReadonlySet<string>;
  mealGroupId?: string | undefined;
  /** A muted line above the rows. */
  caption?: string | undefined;
}) {
  return (
    <View>
      {caption ? (
        <AppText variant="small" muted style={styles.caption}>
          {caption}
        </AppText>
      ) : null}
      {search.foods.map((food) => (
        <FoodSearchRow key={food.id} food={food} actions={actions} favorite={favoriteIds?.has(food.id) ?? false} />
      ))}
      {search.foods.length === 0 ? (
        <FoodListStatus loading={search.status === 'loading'} error={search.status === 'error' ? search.error : null} emptyText={noFoodsFoundText(search.query)} />
      ) : null}
      <FoodSearchFooter search={search} actions={actions} mealGroupId={mealGroupId} />
    </View>
  );
}

const styles = StyleSheet.create({
  caption: { paddingBottom: spacing.xs },
  onlineTitle: { paddingBottom: spacing.xs },
  footer: { gap: spacing.lg, marginTop: spacing.lg },
  empty: { alignItems: 'center', paddingVertical: spacing.xl },
  emptyText: { textAlign: 'center' },
});
