import { Stack, router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { hapticSelection } from '@/components/food/feedback';
import { ONLINE_LOOKUP_ENABLED } from '@/lib/features';
import { FoodRow, type QuickAddState } from '@/components/food/food-row';
import { firstParam, foldText, formatDayLabel, trimNumber } from '@/components/food/format';
import { MealGroupChips, useMealGroupChoice } from '@/components/food/meal-group-chips';
import { Toast } from '@/components/food/toast';
import { useDebouncedValue } from '@/components/food/use-debounced-value';
import { Segmented } from '@/components/forms';
import { AppText, Button, Card } from '@/components/ui';
import {
  errorMessage,
  lookupBarcode,
  useFavorites,
  useFoodSearch,
  useMyFoods,
  useOnlineSearch,
  useQuickAddFood,
  useRecentFoods,
  type FoodSummary,
  type OnlineSearchResult,
} from '@/data/foods';
import { fetchDefaultServing } from '@/data/recipes';
import { deliverPickedFood, hasFoodPickHandler } from '@/state/food-picker';
import { useSelectedDate } from '@/state/selected-date';
import { MAX_CONTENT_WIDTH, radius, spacing, useTheme } from '@/theme';

type TabKey = 'all' | 'recent' | 'favorites' | 'mine';

const TABS: { value: TabKey; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'recent', label: 'Recent' },
  { value: 'favorites', label: 'Favorites' },
  { value: 'mine', label: 'My foods' },
];

interface ToastState {
  message: string;
  tone: 'success' | 'error';
}

function matches(food: FoodSummary, folded: string): boolean {
  if (folded === '') return true;
  return foldText(`${food.name} ${food.brand ?? ''}`).includes(folded);
}

export default function SearchScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ mealGroupId?: string; q?: string; mode?: string }>();
  // /search?mode=pick: choose a food for another screen (recipe ingredient, saved meal) instead of logging it.
  const pickMode = firstParam(params.mode) === 'pick';
  const [query, setQuery] = useState(firstParam(params.q) ?? '');
  const [tab, setTab] = useState<TabKey>('all');
  const debounced = useDebouncedValue(query, 250);
  const trimmed = debounced.trim();

  const date = useSelectedDate((s) => s.date);
  const meal = useMealGroupChoice(firstParam(params.mealGroupId));

  const search = useFoodSearch(trimmed);
  const recent = useRecentFoods({ enabled: tab === 'all' || tab === 'recent' });
  const favorites = useFavorites();
  const mine = useMyFoods({ enabled: tab === 'mine' });
  const quickAdd = useQuickAddFood();
  const online = useOnlineSearch();

  const [addingId, setAddingId] = useState<string | null>(null);
  const [addedIds, setAddedIds] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [pickingId, setPickingId] = useState<string | null>(null);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  function showToast(message: string, tone: ToastState['tone']) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, tone });
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }

  const favoriteIds = new Set((favorites.data ?? []).map((f) => f.id));
  const folded = foldText(trimmed);
  const searching = tab === 'all' && trimmed.length >= 2;

  // Rows for the current tab.
  let rows: FoodSummary[] = [];
  let loading = false;
  let loadError: unknown = null;
  let sectionTitle: string | null = null;
  if (tab === 'all') {
    if (searching) {
      rows = search.data ?? [];
      loading = search.isLoading;
      loadError = search.error;
    } else {
      rows = recent.data ?? [];
      loading = recent.isLoading;
      loadError = recent.error;
      sectionTitle = 'Recently used';
    }
  } else if (tab === 'recent') {
    rows = (recent.data ?? []).filter((f) => matches(f, folded));
    loading = recent.isLoading;
    loadError = recent.error;
  } else if (tab === 'favorites') {
    rows = (favorites.data ?? []).filter((f) => matches(f, folded));
    loading = favorites.isLoading;
    loadError = favorites.error;
  } else {
    rows = (mine.data ?? []).filter((f) => matches(f, folded));
    loading = mine.isLoading;
    loadError = mine.error;
  }

  function openFood(id: string) {
    router.push({
      pathname: '/food/[id]',
      params: { id, ...(meal.mealGroupId ? { mealGroupId: meal.mealGroupId } : {}) },
    });
  }

  /** Pick mode: hand the food (with its default serving) to the waiting screen and go back. */
  async function pickFood(food: { id: string; name: string; brand: string | null }) {
    if (!hasFoodPickHandler()) {
      // Nothing is waiting for a food (e.g. a stale link): behave like the normal search.
      openFood(food.id);
      return;
    }
    hapticSelection();
    setPickingId(food.id);
    try {
      const serving = await fetchDefaultServing(food.id);
      deliverPickedFood({
        id: food.id,
        name: food.name,
        brand: food.brand,
        grams: serving.grams,
        amount: serving.amount,
        portionLabel: serving.label,
      });
      if (router.canGoBack()) router.back();
      else router.replace('/');
    } catch (e) {
      showToast(`Could not use this food: ${errorMessage(e)}`, 'error');
    } finally {
      setPickingId(null);
    }
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

  function onQuickAdd(food: FoodSummary) {
    if (pickMode) {
      void pickFood(food);
      return;
    }
    if (!meal.mealGroupId) {
      showToast('Pick a meal first. No meal group is available yet.', 'error');
      return;
    }
    hapticSelection();
    setAddingId(food.id);
    quickAdd.mutate(
      { foodId: food.id, mealGroupId: meal.mealGroupId, entryDate: date },
      {
        onSuccess: (serving) => {
          setAddedIds((prev) => new Set(prev).add(food.id));
          showToast(
            `Added ${trimNumber(serving.amount)} ${serving.label} of ${food.name} to ${meal.mealGroupName ?? 'diary'} \u00B7 ${formatDayLabel(date)}`,
            'success',
          );
        },
        onError: (e) => showToast(`Could not add: ${errorMessage(e)}`, 'error'),
        onSettled: () => setAddingId(null),
      },
    );
  }

  async function openOnlineResult(result: OnlineSearchResult) {
    setOpening(result.gtin14);
    setOpenError(null);
    const res = await lookupBarcode(result.gtin14);
    setOpening(null);
    if (res.status === 'found' && pickMode) {
      await pickFood({ id: res.foodId, name: result.name, brand: result.brand });
    } else if (res.status === 'found') {
      router.push({
        pathname: '/food/[id]',
        params: { id: res.foodId, ...(meal.mealGroupId ? { mealGroupId: meal.mealGroupId } : {}) },
      });
    } else if (res.status === 'rateLimited') {
      setOpenError('Too many lookups right now. Wait a moment and try again.');
    } else if (res.status === 'unavailable') {
      setOpenError(res.message);
    } else {
      setOpenError('Could not load that product. Try another result or create a custom food.');
    }
  }

  const onlineForThisQuery = online.variables?.query.trim() === trimmed && trimmed.length >= 2;
  const showOnline = ONLINE_LOOKUP_ENABLED && tab === 'all' && searching && !search.isLoading;

  const emptyText =
    tab === 'all'
      ? searching
        ? `No foods found for \u201C${trimmed}\u201D.`
        : 'Foods you log will show up here. Start typing to search.'
      : tab === 'recent'
        ? 'No recent foods match.'
        : tab === 'favorites'
          ? 'No favorites yet. Open a food and tap the star.'
          : 'You have not created any foods yet.';

  const footer = (
    <View style={styles.footer}>
      {showOnline ? (
        <Card>
          <AppText variant="heading">Cannot find it?</AppText>
          <AppText muted>Look for branded and packaged products in Open Food Facts.</AppText>
          <Button
            label="Search online (branded products)"
            variant="secondary"
            loading={online.isPending}
            onPress={() => online.mutate({ query: trimmed })}
          />
          {online.isError && onlineForThisQuery ? (
            <AppText style={{ color: colors.danger }} accessibilityLiveRegion="polite">
              {online.error.message}
            </AppText>
          ) : null}
          {online.isSuccess && onlineForThisQuery ? (
            online.data.length === 0 ? (
              <AppText muted>No online products found for this search.</AppText>
            ) : (
              <View>
                <AppText variant="label" muted style={styles.onlineTitle}>Online results</AppText>
                {online.data.map((r) => (
                  <View key={r.gtin14} style={opening === r.gtin14 ? { opacity: 0.6 } : undefined}>
                    <FoodRow food={r} onPress={() => openOnlineResult(r)} />
                  </View>
                ))}
                {openError ? <AppText style={{ color: colors.danger }}>{openError}</AppText> : null}
              </View>
            )
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
              ...(trimmed ? { name: trimmed } : {}),
              ...(meal.mealGroupId ? { mealGroupId: meal.mealGroupId } : {}),
            },
          })
        }
      />
    </View>
  );

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
      <Stack.Screen options={{ headerShown: true, title: pickMode ? 'Add ingredient' : 'Add food' }} />
      <View style={styles.inner}>
        <View style={[styles.sticky, { backgroundColor: colors.background }]}>
          <View style={styles.searchRow}>
            {/* The input must stay a DIRECT child of the bordered pill: the web focus colour (lib/web-styles.ts) goes to its parent. */}
            <View
              style={[
                styles.searchBox,
                { backgroundColor: colors.surface, borderColor: colors.border },
              ]}>
              <SymbolView
                name={{ ios: 'magnifyingglass', android: 'search', web: 'search' }}
                size={18}
                tintColor={colors.textMuted}
              />
              <TextInput
                autoFocus
                value={query}
                onChangeText={setQuery}
                placeholder="Search foods, e.g. banana or ćevapi"
                placeholderTextColor={colors.textMuted}
                accessibilityLabel="Search foods"
                returnKeyType="search"
                autoCapitalize="none"
                autoCorrect={false}
                style={[styles.input, { color: colors.text }]}
              />
              {search.isFetching && searching ? (
                <ActivityIndicator color={colors.textMuted} style={styles.spinner} accessibilityLabel="Searching" />
              ) : query.length > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Clear search"
                  onPress={() => setQuery('')}
                  hitSlop={8}
                  style={styles.clear}>
                  <SymbolView
                    name={{ ios: 'xmark.circle.fill', android: 'cancel', web: 'cancel' }}
                    size={18}
                    tintColor={colors.textMuted}
                  />
                </Pressable>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Scan barcode"
              onPress={openScanner}
              style={({ pressed }) => [
                styles.scanButton,
                { backgroundColor: colors.surface, borderColor: colors.border },
                pressed && { opacity: 0.7 },
              ]}>
              <SymbolView
                name={{ ios: 'barcode.viewfinder', android: 'qr_code_scanner', web: 'qr_code_scanner' }}
                size={24}
                tintColor={colors.text}
              />
            </Pressable>
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
          ListEmptyComponent={
            loading ? (
              <View style={styles.empty}>
                <ActivityIndicator color={colors.primary} accessibilityLabel="Loading" />
              </View>
            ) : loadError ? (
              <View style={styles.empty}>
                <AppText style={{ color: colors.danger }}>{errorMessage(loadError)}</AppText>
              </View>
            ) : (
              <View style={styles.empty}>
                <AppText muted style={styles.emptyText}>{emptyText}</AppText>
              </View>
            )
          }
          renderItem={({ item }) => {
            const state: QuickAddState =
              addingId === item.id || pickingId === item.id
                ? 'pending'
                : addedIds.has(item.id)
                  ? 'done'
                  : 'idle';
            return (
              <FoodRow
                food={item}
                favorite={favoriteIds.has(item.id)}
                onPress={() => (pickMode ? void pickFood(item) : openFood(item.id))}
                onQuickAdd={() => onQuickAdd(item)}
                quickAddState={state}
              />
            );
          }}
        />
      </View>
      {toast ? <Toast message={toast.message} tone={toast.tone} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  inner: { flex: 1, width: '100%', maxWidth: MAX_CONTENT_WIDTH, alignSelf: 'center' },
  sticky: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xs, gap: spacing.sm },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    minHeight: 46,
  },
  input: { flex: 1, fontSize: 16, minHeight: 44 },
  spinner: { marginLeft: spacing.xs },
  clear: { padding: spacing.xs },
  scanButton: {
    width: 46,
    height: 46,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl * 2, flexGrow: 1 },
  listHeader: { gap: spacing.xs, paddingTop: spacing.xs, paddingBottom: spacing.xs },
  destination: { gap: spacing.xs },
  onlineTitle: { paddingBottom: spacing.xs },
  footer: { gap: spacing.lg, marginTop: spacing.lg },
  empty: { alignItems: 'center', paddingVertical: spacing.xl },
  emptyText: { textAlign: 'center' },
});
