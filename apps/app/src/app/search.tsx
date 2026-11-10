import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';

import { AddTypeMenu } from '@/components/AddTypeMenu';
import { IconButton } from '@/components/diary/IconButton';
import { hapticSelection } from '@/components/food/feedback';
import { FoodListStatus, FoodSearchFooter, FoodSearchRow } from '@/components/food/FoodSearchResults';
import { filterFoods, noFoodsFoundText } from '@/components/food/food-search';
import { firstParam, formatDayLabel } from '@/components/food/format';
import { MealGroupChips, useMealGroupChoice } from '@/components/food/meal-group-chips';
import { ScanButton, SearchField } from '@/components/food/search-field';
import { Toast } from '@/components/food/toast';
import { useFoodRowActions } from '@/components/food/use-food-row-actions';
import { useFoodSearchResults } from '@/components/food/use-food-search-results';
import { Segmented } from '@/components/forms';
import { AppText } from '@/components/ui';
import { useFavorites, useMyFoods, useRecentFoods, type FoodSummary } from '@/data/foods';
import { useSelectedDate } from '@/state/selected-date';
import { MAX_CONTENT_WIDTH, spacing, useTheme } from '@/theme';

type TabKey = 'all' | 'recent' | 'favorites' | 'mine';

const TABS: { value: TabKey; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'recent', label: 'Recent' },
  { value: 'favorites', label: 'Favorites' },
  { value: 'mine', label: 'My foods' },
];

/**
 * Add food: the screen for putting a food into the diary (meal chips, the day, the "..." menu of other ways to add, pick mode for recipe
 * ingredients). The search itself is shared with the Foods tab (useFoodSearchResults, FoodSearchResults.tsx).
 */
export default function SearchScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ mealGroupId?: string; q?: string; mode?: string }>();
  // /search?mode=pick: choose a food for another screen (recipe ingredient, saved meal) instead of logging it.
  const pickMode = firstParam(params.mode) === 'pick';
  const [query, setQuery] = useState(firstParam(params.q) ?? '');
  const [tab, setTab] = useState<TabKey>('all');

  const date = useSelectedDate((s) => s.date);
  const meal = useMealGroupChoice(firstParam(params.mealGroupId));

  // The server search belongs to the "All" tab; the other tabs filter their own list by the text.
  const search = useFoodSearchResults(query, { enabled: tab === 'all' });
  const recent = useRecentFoods({ enabled: tab === 'all' || tab === 'recent' });
  const favorites = useFavorites();
  const mine = useMyFoods({ enabled: tab === 'mine' });
  const actions = useFoodRowActions({ mealGroupId: meal.mealGroupId, mealGroupName: meal.mealGroupName, pickMode });

  // The "..." menu in the header: switch to another way of adding (barcode, exercise, note, AI helpers ...).
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  const favoriteIds = new Set((favorites.data ?? []).map((f) => f.id));

  // Rows for the current tab.
  let rows: FoodSummary[] = [];
  let loading = false;
  let loadError: unknown = null;
  let sectionTitle: string | null = null;
  if (tab === 'all') {
    if (search.searching) {
      rows = search.foods;
      loading = search.status === 'loading';
      loadError = search.status === 'error' ? search.error : null;
    } else {
      rows = recent.data ?? [];
      loading = recent.isLoading;
      loadError = recent.error;
      sectionTitle = 'Recently used';
    }
  } else if (tab === 'recent') {
    rows = filterFoods(recent.data ?? [], search.query);
    loading = recent.isLoading;
    loadError = recent.error;
  } else if (tab === 'favorites') {
    rows = filterFoods(favorites.data ?? [], search.query);
    loading = favorites.isLoading;
    loadError = favorites.error;
  } else {
    rows = filterFoods(mine.data ?? [], search.query);
    loading = mine.isLoading;
    loadError = mine.error;
  }

  /** Opens the barcode scanner with the same context as this screen (meal, pick mode); it can come back here. */
  function openScanner() {
    hapticSelection();
    router.push({
      pathname: '/scan',
      params: {
        from: 'search',
        ...(meal.mealGroupId ? { mealGroupId: meal.mealGroupId } : {}),
        ...(pickMode ? { mode: 'pick' } : {}),
      },
    });
  }

  const emptyText =
    tab === 'all'
      ? search.searching
        ? noFoodsFoundText(search.query)
        : 'Foods you log will show up here. Start typing to search.'
      : tab === 'recent'
        ? 'No recent foods match.'
        : tab === 'favorites'
          ? 'No favorites yet. Open a food and tap the star.'
          : 'You have not created any foods yet.';

  const footer = <FoodSearchFooter search={search} actions={actions} mealGroupId={meal.mealGroupId} />;

  const header = (
    <View style={styles.listHeader}>
      <View style={styles.destination}>
        {pickMode ? (
          <AppText variant="small" muted>
            Choose a food to add. You can set the amount next.
          </AppText>
        ) : (
          <>
            <AppText variant="small" muted>
              Adding to {meal.mealGroupName ?? 'your diary'} {'\u00B7'} {formatDayLabel(date)}
            </AppText>
            {meal.groups.length > 0 ? (
              <MealGroupChips compact groups={meal.groups} value={meal.mealGroupId} onChange={meal.setMealGroupId} />
            ) : null}
          </>
        )}
      </View>
      {sectionTitle && rows.length > 0 ? <AppText variant="label" muted>{sectionTitle}</AppText> : null}
    </View>
  );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: pickMode ? 'Add ingredient' : 'Add food',
          // Not when picking an ingredient for a recipe: there the other kinds of entry make no sense.
          headerRight: pickMode ? undefined : () => <IconButton glyph={'\u22EF'} label="More ways to add" onPress={() => setAddMenuOpen(true)} size={40} />,
        }}
      />
      {pickMode ? null : <AddTypeMenu visible={addMenuOpen} onClose={() => setAddMenuOpen(false)} mealGroupId={meal.mealGroupId} />}
      <View style={styles.inner}>
        <View style={[styles.sticky, { backgroundColor: colors.background }]}>
          <View style={styles.searchRow}>
            <SearchField value={query} onChangeText={setQuery} busy={search.fetching} autoFocus />
            <ScanButton onPress={openScanner} />
          </View>
          <Segmented<TabKey> compact options={TABS} value={tab} onChange={setTab} />
        </View>

        <FlatList
          data={rows}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={header}
          ListFooterComponent={footer}
          ListEmptyComponent={<FoodListStatus loading={loading} error={loadError} emptyText={emptyText} />}
          renderItem={({ item }) => <FoodSearchRow food={item} actions={actions} favorite={favoriteIds.has(item.id)} />}
        />
      </View>
      {actions.toast ? <Toast message={actions.toast.message} tone={actions.toast.tone} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  inner: { flex: 1, width: '100%', maxWidth: MAX_CONTENT_WIDTH, alignSelf: 'center' },
  sticky: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xs, gap: spacing.sm },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  listContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl * 2, flexGrow: 1 },
  listHeader: { gap: spacing.xs, paddingTop: spacing.xs, paddingBottom: spacing.xs },
  destination: { gap: spacing.xs },
});
