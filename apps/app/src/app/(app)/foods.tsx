import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { FoodRow } from '@/components/food/food-row';
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
import { MAX_CONTENT_WIDTH, radius, spacing, useTheme } from '@/theme';

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

export default function FoodsScreen() {
  const { colors } = useTheme();
  const [tab, setTab] = useState<TabKey>('favorites');
  const [refreshing, setRefreshing] = useState(false);

  const favorites = useFavorites({ enabled: tab === 'favorites' });
  const recent = useRecentFoods({ enabled: tab === 'recent' });
  const mine = useMyFoods({ enabled: tab === 'mine' });
  const recipes = useRecipes({ enabled: tab === 'recipes' });
  const meals = useSavedMeals({ enabled: tab === 'meals' });

  const active =
    tab === 'favorites' ? favorites : tab === 'recent' ? recent : tab === 'mine' ? mine : tab === 'recipes' ? recipes : meals;

  const onRefresh = () => {
    setRefreshing(true);
    active.refetch().finally(() => setRefreshing(false));
  };

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
      action: { label: 'Search foods', onPress: () => open('/search') },
    },
    recent: {
      text: 'Foods you log will show up here.',
      action: { label: 'Search foods', onPress: () => open('/search') },
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

      <Pressable
        accessibilityRole="search"
        accessibilityLabel="Search foods"
        onPress={() => open('/search')}
        style={({ pressed }) => [
          styles.searchBox,
          { backgroundColor: colors.surface, borderColor: colors.border },
          pressed && { opacity: 0.8 },
        ]}>
        <SymbolView
          name={{ ios: 'magnifyingglass', android: 'search', web: 'search' }}
          size={18}
          tintColor={colors.textMuted}
        />
        <AppText muted style={styles.searchText}>
          Search foods, e.g. banana or ćevapi
        </AppText>
      </Pressable>

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

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <FlatList
        data={items}
        keyExtractor={(item) => item.key}
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={Separator}
        ListHeaderComponent={header}
        ListEmptyComponent={emptyState}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
        renderItem={({ item }) => {
          if (item.type === 'recipe') {
            return <RecipeRow recipe={item.recipe} onPress={() => openRecipe(item.recipe.id)} />;
          }
          if (item.type === 'meal') {
            return <SavedMealRow meal={item.meal} onPress={() => openSavedMeal(item.meal.id)} />;
          }
          return <FoodRow food={item.food} onPress={() => openFood(item.food.id, item.food.kind)} />;
        }}
      />
    </View>
  );
}

function Separator() {
  return <View style={{ height: spacing.sm }} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  listContent: {
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
    padding: spacing.lg,
    paddingBottom: spacing.xxl * 2,
    flexGrow: 1,
  },
  header: { gap: spacing.md, paddingBottom: spacing.md },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    minHeight: 48,
  },
  searchText: { flex: 1, fontSize: 16 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  action: { flex: 1, minWidth: 140 },
  tabs: { gap: spacing.sm, paddingVertical: spacing.xs },
  chip: {
    minHeight: 38,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: { fontSize: 14, fontWeight: '600' },
  centered: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xl },
  emptyText: { textAlign: 'center', maxWidth: 420 },
});
