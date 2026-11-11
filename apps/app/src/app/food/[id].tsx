import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { deriveNutrients, parseNumber, scaleNutrients } from '@ration/core';

import { useContentWidth } from '@/components/desktop/shell-context';
import { CompletenessLabel } from '@/components/food/completeness';
import { DayStepper } from '@/components/food/day-stepper';
import { hapticSuccess } from '@/components/food/feedback';
import { firstParam, formatDayLabel, formatKcal } from '@/components/food/format';
import { MacroSummary } from '@/components/food/macro-summary';
import { MealGroupChips, useMealGroupChoice } from '@/components/food/meal-group-chips';
import { NutrientPanel } from '@/components/food/nutrient-panel';
import { buildServingOptions, useServing } from '@/components/food/serving';
import { ServingPicker } from '@/components/food/serving-picker';
import { SourceBadge, sourceAttribution } from '@/components/food/source-badge';
import { Toast } from '@/components/food/toast';
import { AppText, Button, Card } from '@/components/ui';
import { useAddDiaryEntry } from '@/data/diary-write';
import {
  errorMessage,
  useFavorites,
  useFood,
  useToggleFavorite,
  type FoodDetail,
} from '@/data/foods';
import { useUnitSystem } from '@/data/profile';
import { useTargets } from '@/data/targets';
import { useAuth } from '@/lib/auth';
import { useSelectedDate } from '@/state/selected-date';
import { MAX_CONTENT_WIDTH, spacing, useTheme } from '@/theme';

const MAX_GRAMS = 50_000;
const WIDE_LAYOUT = 760;

/** Leaves the add-food flow: pops back to where it started (diary), or goes home on a deep link. */
function leaveAfterAdd() {
  if (router.canDismiss()) router.dismissAll();
  else if (router.canGoBack()) router.back();
  else router.replace('/');
}

export default function FoodScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{
    id: string;
    mealGroupId?: string;
    grams?: string;
    portion?: string;
    source?: string;
  }>();
  const id = firstParam(params.id);
  const query = useFood(id);

  if (query.isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: true, title: 'Food' }} />
        <ActivityIndicator color={colors.primary} accessibilityLabel="Loading food" />
      </View>
    );
  }

  if (query.error || !query.data) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background, padding: spacing.lg }]}>
        <Stack.Screen options={{ headerShown: true, title: 'Food' }} />
        <Card style={styles.messageCard}>
          <AppText variant="heading">{query.error ? 'Could not load this food' : 'Food not found'}</AppText>
          <AppText muted>
            {query.error
              ? errorMessage(query.error)
              : 'It may have been deleted, or it belongs to another account.'}
          </AppText>
          {query.error ? <Button label="Try again" onPress={() => query.refetch()} /> : null}
          <Button
            label="Back"
            variant="secondary"
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          />
        </Card>
      </View>
    );
  }

  return (
    <FoodDetailView
      key={query.data.food.id}
      detail={query.data}
      mealGroupParam={firstParam(params.mealGroupId)}
      gramsParam={firstParam(params.grams)}
      portionParam={firstParam(params.portion)}
      fromScan={params.source === 'barcode'}
    />
  );
}

function FoodDetailView({
  detail,
  mealGroupParam,
  gramsParam,
  portionParam,
  fromScan,
}: {
  detail: FoodDetail;
  mealGroupParam: string | undefined;
  gramsParam: string | undefined;
  portionParam: string | undefined;
  fromScan: boolean;
}) {
  const { colors, radius } = useTheme();
  const insets = useSafeAreaInsets();
  // The width of the area next to the sidebar (the window's, on a phone), so the two columns only start when they fit.
  const width = useContentWidth();
  const wide = width >= WIDE_LAYOUT;
  const { food, portions, completeness, supersededById } = detail;

  const unitSystem = useUnitSystem();
  const targets = useTargets().data?.nutrients;
  const userId = useAuth().session?.user.id;
  const date = useSelectedDate((s) => s.date);

  const options = buildServingOptions(portions, food.densityGPerMl, unitSystem === 'imperial');
  const initialGrams = parseNumber(gramsParam ?? '');
  const serving = useServing(options, {
    ...(initialGrams !== null && initialGrams > 0 ? { grams: initialGrams } : {}),
    ...(portionParam ? { portion: portionParam } : {}),
  });
  const meal = useMealGroupChoice(mealGroupParam);

  const favorites = useFavorites();
  const toggleFavorite = useToggleFavorite();
  const isFavorite = favorites.data?.some((f) => f.id === food.id) ?? false;

  const addEntry = useAddDiaryEntry();
  const [added, setAdded] = useState(false);

  useEffect(() => {
    if (!added) return;
    const t = setTimeout(leaveAfterAdd, 700);
    return () => clearTimeout(t);
  }, [added]);

  const grams = serving.grams;
  const amountError =
    serving.amountText.trim() !== '' && grams === null
      ? 'Enter a number greater than 0'
      : grams !== null && grams > MAX_GRAMS
        ? 'That amount is too large'
        : null;
  const validGrams = grams !== null && grams <= MAX_GRAMS ? grams : null;

  const amounts = validGrams === null ? {} : scaleNutrients(food.nutrients, validGrams);
  const derived = deriveNutrients(amounts, { carbBasis: food.carbBasis });
  const energyEstimated = amounts.ENERGY_KCAL === undefined && derived.ENERGY_KCAL !== undefined;

  const canEdit = Boolean(userId) && food.ownerId === userId && food.kind === 'custom' && !food.archived;
  const canAdd = validGrams !== null && Boolean(meal.mealGroupId) && !food.archived && !added && !addEntry.isPending;
  const attribution = sourceAttribution(food.source);

  function onAdd() {
    if (validGrams === null || !meal.mealGroupId || !serving.selected) return;
    addEntry.mutate(
      {
        foodId: food.id,
        grams: validGrams,
        mealGroupId: meal.mealGroupId,
        entryDate: date,
        source: fromScan ? 'barcode' : 'manual',
        ...(serving.amount !== null ? { amount: serving.amount } : {}),
        portionLabel: serving.selected.label,
      },
      {
        onSuccess: () => {
          hapticSuccess();
          setAdded(true);
        },
      },
    );
  }

  const header = (
    <Card>
      <View style={styles.titleRow}>
        <View style={{ flex: 1, gap: 2 }}>
          <AppText variant="heading" accessibilityRole="header">{food.name}</AppText>
          {food.brand ? <AppText muted>{food.brand}</AppText> : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          accessibilityState={{ selected: isFavorite, busy: toggleFavorite.isPending }}
          disabled={toggleFavorite.isPending}
          onPress={() => toggleFavorite.mutate({ foodId: food.id, favorite: !isFavorite })}
          style={[styles.fav, { backgroundColor: colors.surfaceAlt, borderColor: colors.border, borderRadius: radius.pill }]}>
          <Text style={{ fontSize: 22, color: isFavorite ? colors.primary : colors.textMuted }}>
            {isFavorite ? '\u2605' : '\u2606'}
          </Text>
        </Pressable>
      </View>
      <View style={styles.metaRow}>
        <SourceBadge source={food.source} />
        <CompletenessLabel value={completeness} />
      </View>
      {food.gtin14 ? (
        <AppText variant="small" muted>Barcode {food.gtin14}</AppText>
      ) : null}
      {canEdit ? (
        <Button
          label="Edit food"
          variant="secondary"
          onPress={() => router.push({ pathname: '/food/edit/[id]', params: { id: food.id } })}
        />
      ) : null}
    </Card>
  );

  const archivedBanner = food.archived ? (
    <Card>
      <AppText variant="heading">This version was replaced</AppText>
      <AppText muted>
        The food was edited after it was logged, so its earlier entries keep the old values. New entries should use the current version.
      </AppText>
      {supersededById ? (
        <Button
          label="Open current version"
          onPress={() => router.replace({ pathname: '/food/[id]', params: { id: supersededById } })}
        />
      ) : null}
    </Card>
  ) : null;

  const servingCard = (
    <Card>
      <AppText variant="heading">Serving</AppText>
      <ServingPicker
        amountText={serving.amountText}
        onAmountChange={serving.setAmountText}
        options={options}
        selectedKey={serving.selected?.key}
        onSelect={serving.select}
        grams={grams}
        kcal={derived.ENERGY_KCAL}
        onUseGrams={serving.reinterpret}
        error={amountError}
      />
      <View style={[styles.divider, { backgroundColor: colors.border }]} />
      <AppText variant="label" muted>Meal</AppText>
      {meal.groups.length > 0 ? (
        <MealGroupChips groups={meal.groups} value={meal.mealGroupId} onChange={meal.setMealGroupId} />
      ) : (
        <AppText muted>{meal.isLoading ? 'Loading meals...' : 'No meal groups found.'}</AppText>
      )}
      <AppText variant="label" muted>Date</AppText>
      <DayStepper />
    </Card>
  );

  const summary = (
    <>
      <MacroSummary
        kcal={derived.ENERGY_KCAL}
        protein={derived.PROTEIN_G}
        carbs={derived.CARBS_G}
        fat={derived.FAT_G}
        estimated={energyEstimated}
      />
      <NutrientPanel amounts={amounts} carbBasis={food.carbBasis} {...(targets ? { targets } : {})} />
      {attribution ? (
        <AppText variant="small" muted accessibilityRole="text">
          {attribution}
        </AppText>
      ) : null}
    </>
  );

  const kcalLabel = derived.ENERGY_KCAL === undefined ? '' : ` \u00B7 ${formatKcal(derived.ENERGY_KCAL)} kcal`;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: true, title: food.name }} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag">
        <View style={[styles.content, wide && styles.contentWide]}>
          <View style={wide ? styles.colLeft : styles.col}>
            {archivedBanner}
            {header}
            {servingCard}
          </View>
          <View style={wide ? styles.colRight : styles.col}>{summary}</View>
        </View>
      </ScrollView>
      <View
        style={[
          styles.footer,
          {
            backgroundColor: colors.surface,
            borderTopColor: colors.border,
            paddingBottom: Math.max(insets.bottom, spacing.md),
          },
        ]}>
        <View style={styles.footerInner}>
          {addEntry.error ? (
            <AppText variant="small" style={{ color: colors.danger }}>{errorMessage(addEntry.error)}</AppText>
          ) : !meal.mealGroupId && !meal.isLoading ? (
            <AppText variant="small" style={{ color: colors.danger }}>Pick a meal to add this food to.</AppText>
          ) : null}
          <Button
            label={added ? 'Added' : `Add to diary${kcalLabel}`}
            onPress={onAdd}
            disabled={!canAdd}
            loading={addEntry.isPending}
          />
        </View>
      </View>
      {added ? (
        <Toast message={`Added to ${meal.mealGroupName ?? 'diary'} \u00B7 ${formatDayLabel(date)}`} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  messageCard: { width: '100%', maxWidth: 480 },
  scroll: { flexGrow: 1 },
  content: {
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
    padding: spacing.lg,
    gap: spacing.lg,
  },
  contentWide: { flexDirection: 'row', alignItems: 'flex-start' },
  col: { gap: spacing.lg },
  colLeft: { width: 340, gap: spacing.lg },
  colRight: { flex: 1, gap: spacing.lg },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.md },
  fav: {
    width: 44,
    height: 44,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  divider: { height: StyleSheet.hairlineWidth },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing.md, paddingHorizontal: spacing.lg },
  footerInner: { width: '100%', maxWidth: MAX_CONTENT_WIDTH, alignSelf: 'center', gap: spacing.sm },
});
