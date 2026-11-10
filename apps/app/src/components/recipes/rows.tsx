import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { CompletenessDot } from '@/components/food/completeness';
import { formatKcal, trimNumber } from '@/components/food/format';
import { SourceLabel } from '@/components/food/source-badge';
import { SAVED_MEAL_LABEL, foodSourceLabel } from '@/components/food/source-label';
import { AppText } from '@/components/ui';
import type { RecipeSummary } from '@/data/recipes';
import type { SavedMeal } from '@/data/saved-meals';
import { spacing, useTheme } from '@/theme';

/** A flat list row (a hairline underneath, like the food rows next to it in the Foods tab). */
function RowShell({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { borderBottomColor: colors.border }, pressed && { opacity: 0.7 }]}>
      {children}
    </Pressable>
  );
}

const gramsText = (v: number | null) => (v === null ? '-' : `${trimNumber(v, v >= 10 ? 0 : 1)} g`);

/** A recipe in the Foods tab: calories per serving, servings, completeness. */
export function RecipeRow({ recipe, onPress }: { recipe: RecipeSummary; onPress: () => void }) {
  const perServing =
    recipe.kcalPerServing === null
      ? 'Calories unknown'
      : `${formatKcal(recipe.kcalPerServing)} kcal per serving`;
  const servings = `${trimNumber(recipe.servings, 2)} ${recipe.servings === 1 ? 'serving' : 'servings'}`;
  const macros =
    recipe.proteinPerServing !== null || recipe.carbsPerServing !== null || recipe.fatPerServing !== null
      ? `  |  P ${gramsText(recipe.proteinPerServing)}  |  C ${gramsText(recipe.carbsPerServing)}  |  F ${gramsText(recipe.fatPerServing)}`
      : '';
  return (
    <RowShell
      label={`${recipe.name}. ${perServing}. ${servings}. Open recipe`}
      onPress={onPress}>
      <View style={styles.main}>
        <AppText style={styles.name} numberOfLines={2}>
          {recipe.name}
        </AppText>
        <View style={styles.meta}>
          <CompletenessDot value={recipe.completeness} size={8} />
          <AppText variant="small" muted numberOfLines={1} style={styles.shrink}>
            {perServing}
            {` \u00B7 ${servings}`}
            {recipe.servingWeightG ? ` \u00B7 ${gramsText(recipe.servingWeightG)} each` : ''}
            {macros}
          </AppText>
        </View>
      </View>
      <SourceLabel info={foodSourceLabel('recipe', 'recipe')} />
    </RowShell>
  );
}

/** A saved meal in the Foods tab: number of foods and calories. */
export function SavedMealRow({ meal, onPress }: { meal: SavedMeal; onPress: () => void }) {
  const count = `${meal.items.length} ${meal.items.length === 1 ? 'food' : 'foods'}`;
  const preview = meal.items
    .slice(0, 3)
    .map((i) => i.food.name)
    .join(', ');
  return (
    <RowShell label={`${meal.name}. ${count}, ${formatKcal(meal.kcal)} kilocalories. Open saved meal`} onPress={onPress}>
      <View style={styles.main}>
        <AppText style={styles.name} numberOfLines={2}>
          {meal.name}
        </AppText>
        <AppText variant="small" muted numberOfLines={1}>
          {count} {'\u00B7'} {formatKcal(meal.kcal)} kcal
          {meal.proteinG + meal.carbsG + meal.fatG > 0
            ? `  |  P ${gramsText(meal.proteinG)}  |  C ${gramsText(meal.carbsG)}  |  F ${gramsText(meal.fatG)}`
            : ''}
        </AppText>
        {preview ? (
          <AppText variant="small" muted numberOfLines={1}>
            {preview}
            {meal.items.length > 3 ? ', ...' : ''}
          </AppText>
        ) : null}
      </View>
      <SourceLabel info={SAVED_MEAL_LABEL} />
    </RowShell>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.sm + spacing.xs,
    minHeight: 60,
  },
  main: { flex: 1, gap: 2 },
  name: { fontWeight: '700', fontSize: 16 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  shrink: { flexShrink: 1 },
});
