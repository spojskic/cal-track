import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type TextInputInstance,
} from 'react-native';

import { FoodRow } from '@/components/food/food-row';
import { FoodSearchResults } from '@/components/food/FoodSearchResults';
import { quickAddCaption } from '@/components/food/food-search';
import { FoodsDesktop } from '@/components/food/FoodsDesktop';
import { formatDayLabel } from '@/components/food/format';
import { useMealGroupChoice } from '@/components/food/meal-group-chips';
import { ScanButton, SearchField } from '@/components/food/search-field';
import { Toast } from '@/components/food/toast';
import { useFoodRowActions } from '@/components/food/use-food-row-actions';
import { useFoodSearchResults } from '@/components/food/use-food-search-results';
import { open, openFood, openRecipe, openSavedMeal } from '@/components/recipes/nav';
import { RecipeRow, SavedMealRow } from '@/components/recipes/rows';
import { AppText, Button } from '@/components/ui';
import {
  errorMessage,
  useFavorites,
  useMyFoods,
  useRecentFoods,
  type FoodSummary,
} from '@/data/foods';
import { useRecipes, type RecipeSummary } from '@/data/recipes';
import { useSavedMeals, type SavedMeal } from '@/data/saved-meals';
import { useSelectedDate } from '@/state/selected-date';
import { MAX_CONTENT_WIDTH, WIDE_BREAKPOINT, spacing, useTheme } from '@/theme';

type TabKey = 'favorites' | 'recent' | 'mine' | 'recipes' | 'meals';

const TABS: { value: TabKey; label: string }[] = [
  { value: 'favorites', label: 'Favorites' },
  { value: 'recent', label: 'Recent' },
  { value: 'mine', label: 'My foods' },
  { value: 'recipes', label: 'Recipes' },
  { value: 'meals', label: 'Saved meals' },
];

type ListItem =
  | { type: 'food'; key: string; food: FoodSummary }
  | { type: 'recipe'; key: string; recipe: RecipeSummary }
  | { type: 'meal'; key: string; meal: SavedMeal };

interface EmptyInfo {
  text: string;
  action: { label: string; onPress: () => void };
}

/**
 * The food library (Favorites, Recent, My foods, Recipes, Saved meals) with a search field on top. Typing in the field (two characters or
 * more) searches right here: the results take the place of the library list and the chips, and the "+" on a result adds one serving to the
 * diary. The Add food screen (/search) stays the screen for adding to the diary, reached from the "Add to diary" button and the "+" buttons.
 */
export default function FoodsScreen() {
  const { colors, radius } = useTheme();
  const wide = useWindowDimensions().width >= WIDE_BREAKPOINT;
  const [tab, setTab] = useState<TabKey>('favorites');
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const searchInput = useRef<TextInputInstance>(null);

  const date = useSelectedDate((s) => s.date);
  const meal = useMealGroupChoice(undefined);
  const search = useFoodSearchResults(query);
  const searching = search.searching;
  const actions = useFoodRowActions({
    mealGroupId: meal.mealGroupId,
    mealGroupName: meal.mealGroupName,
    // The same pages as the rows of the library: a recipe opens its recipe page.
    openDetail: openFood,
  });

  // The favourites also give the stars on the search results.
  const favorites = useFavorites({ enabled: tab === 'favorites' || searching });
  const recent = useRecentFoods({ enabled: tab === 'recent' });
  const mine = useMyFoods({ enabled: tab === 'mine' });
  const recipes = useRecipes({ enabled: tab === 'recipes' });
  const meals = useSavedMeals({ enabled: tab === 'meals' });

  const active =
    tab === 'favorites' ? favorites : tab === 'recent' ? recent : tab === 'mine' ? mine : tab === 'recipes' ? recipes : meals;
  const favoriteIds = new Set((favorites.data ?? []).map((f) => f.id));

  const onRefresh = () => {
    setRefreshing(true);
    (searching ? search.refetch() : active.refetch()).finally(() => setRefreshing(false));
  };

  const focusSearch = () => searchInput.current?.focus();

  let items: ListItem[] = [];
  if (tab === 'favorites') {
    items = (favorites.data ?? []).map((food) => ({ type: 'food', key: `f-${food.id}`, food }));
  } else if (tab === 'recent') {
    items = (recent.data ?? []).map((food) => ({ type: 'food', key: `r-${food.id}`, food }));
  } else if (tab === 'mine') {
    // Recipes have their own tab; "My foods" lists custom foods and AI estimates.
    items = (mine.data ?? [])
      .filter((food) => food.kind !== 'recipe')
      .map((food) => ({ type: 'food', key: `m-${food.id}`, food }));
  } else if (tab === 'recipes') {
    items = (recipes.data ?? []).map((recipe) => ({ type: 'recipe', key: `c-${recipe.id}`, recipe }));
  } else {
    items = (meals.data ?? []).map((meal) => ({ type: 'meal', key: `s-${meal.id}`, meal }));
  }

  const empty: Record<TabKey, EmptyInfo> = {
    favorites: {
      text: 'No favorites yet. Open a food and tap the star to keep it here.',
      action: { label: 'Search foods', onPress: focusSearch },
    },
    recent: {
      text: 'Foods you log will show up here.',
      action: { label: 'Search foods', onPress: focusSearch },
    },
    mine: {
      text: 'You have not created any foods yet.',
      action: { label: 'Create food', onPress: () => open('/food/new') },
    },
    recipes: {
      text: 'No recipes yet. A recipe turns a list of ingredients into one food with calories per serving.',
      action: { label: 'Create recipe', onPress: () => open('/recipe/new') },
    },
    meals: {
      text: 'No saved meals yet. Save a meal from the menu of a diary meal, or build one here.',
      action: { label: 'New saved meal', onPress: () => open('/saved-meal/new') },
    },
  };
  const emptyInfo = empty[tab];

  const header = (
    <View style={styles.header}>
      <AppText variant="title" accessibilityRole="header">
        Foods
      </AppText>

      <View style={styles.searchRow}>
        <SearchField value={query} onChangeText={setQuery} busy={search.fetching} inputRef={searchInput} />
        <ScanButton onPress={() => open('/scan')} />
      </View>

      {searching ? null : (
        <>
          <View style={styles.actions}>
            <View style={styles.action}>
              <Button label="Create food" variant="secondary" onPress={() => open('/food/new')} />
            </View>
            <View style={styles.action}>
              <Button label="Create recipe" variant="secondary" onPress={() => open('/recipe/new')} />
            </View>
          </View>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.tabs}
            accessibilityRole="tablist">
            {TABS.map((t) => {
              const selected = t.value === tab;
              return (
                <Pressable
                  key={t.value}
                  accessibilityRole="tab"
                  accessibilityState={{ selected }}
                  onPress={() => setTab(t.value)}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: selected ? colors.primary : colors.surfaceAlt,
                      borderColor: selected ? colors.primary : colors.border,
                      borderRadius: radius.pill,
                    },
                  ]}>
                  <Text style={[styles.chipText, { color: selected ? colors.onPrimary : colors.text }]}>{t.label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>

          {tab === 'meals' && items.length > 0 ? (
            <Button label="New saved meal" variant="secondary" onPress={() => open('/saved-meal/new')} />
          ) : null}
        </>
      )}
    </View>
  );

  const emptyState = active.isLoading ? (
    <View style={styles.centered}>
      <ActivityIndicator color={colors.primary} accessibilityLabel="Loading" />
    </View>
  ) : active.error ? (
    <View style={styles.centered}>
      <AppText style={{ color: colors.danger }}>{errorMessage(active.error)}</AppText>
      <Button label="Try again" variant="secondary" onPress={() => active.refetch()} />
    </View>
  ) : (
    <View style={styles.centered}>
      <AppText muted style={styles.emptyText}>
        {emptyInfo.text}
      </AppText>
      <Button label={emptyInfo.action.label} onPress={emptyInfo.action.onPress} />
    </View>
  );

  // While searching the list has no rows of its own: the results (rows, nothing found, the online card) are drawn in its place.
  const searchResults = (
    <FoodSearchResults
      search={search}
      actions={actions}
      favoriteIds={favoriteIds}
      caption={search.foods.length > 0 && meal.mealGroupName ? quickAddCaption(meal.mealGroupName, formatDayLabel(date)) : undefined}
    />
  );

  const renderItem = ({ item }: { item: ListItem }) => {
    if (item.type === 'recipe') {
      return <RecipeRow recipe={item.recipe} onPress={() => openRecipe(item.recipe.id)} />;
    }
    if (item.type === 'meal') {
      return <SavedMealRow meal={item.meal} onPress={() => openSavedMeal(item.meal.id)} />;
    }
    return <FoodRow food={item.food} onPress={() => openFood(item.food.id, item.food.kind)} />;
  };

  const data = searching ? NO_ITEMS : items;
  const listEmpty = searching ? searchResults : emptyState;
  const toast = actions.toast ? <Toast message={actions.toast.message} tone={actions.toast.tone} /> : null;

  // Wide windows (beside the sidebar): the same rows in a panel next to the create actions (FoodsDesktop). The list fills the panel
  // and scrolls on its own; the search field, the scan button and the chips are in the panel instead of the list header.
  if (wide) {
    const meta = searching
      ? search.status === 'results'
        ? `${search.foods.length} ${search.foods.length === 1 ? 'result' : 'results'}`
        : undefined
      : active.isLoading
        ? undefined
        : `${items.length} ${items.length === 1 ? 'item' : 'items'}`;
    return (
      <View style={styles.wideScreen}>
        <FoodsDesktop
          tabs={TABS}
          tab={tab}
          onTab={setTab}
          meta={meta}
          query={query}
          onQuery={setQuery}
          searching={searching}
          searchBusy={search.fetching}
          searchInputRef={searchInput}
          onScan={() => open('/scan')}
          onCreateFood={() => open('/food/new')}
          onCreateRecipe={() => open('/recipe/new')}
          onNewSavedMeal={() => open('/saved-meal/new')}
          list={
            <FlatList
              data={data}
              keyExtractor={(item) => item.key}
              style={styles.wideList}
              contentContainerStyle={styles.wideListContent}
              ListEmptyComponent={listEmpty}
              keyboardShouldPersistTaps="handled"
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
              renderItem={renderItem}
            />
          }
        />
        {toast}
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <FlatList
        data={data}
        keyExtractor={(item) => item.key}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={header}
        ListEmptyComponent={listEmpty}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
        renderItem={renderItem}
      />
      {toast}
    </View>
  );
}

const NO_ITEMS: ListItem[] = [];

const styles = StyleSheet.create({
  screen: { flex: 1 },
  wideScreen: { flex: 1 },
  listContent: {
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
    padding: spacing.lg,
    paddingBottom: spacing.xxl * 2,
    flexGrow: 1,
  },
  wideList: { flex: 1 },
  wideListContent: { paddingHorizontal: 14, flexGrow: 1 },
  header: { gap: spacing.md, paddingBottom: spacing.md },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  action: { flex: 1, minWidth: 140 },
  tabs: { gap: spacing.sm, paddingVertical: spacing.xs },
  chip: {
    minHeight: 38,
    paddingHorizontal: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: { fontSize: 14, fontWeight: '600' },
  centered: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xl },
  emptyText: { textAlign: 'center', maxWidth: 420 },
});
