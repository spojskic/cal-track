import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { CompletenessDot } from '@/components/food/completeness';
import { formatKcal, trimNumber } from '@/components/food/format';
import { SourceBadge } from '@/components/food/source-badge';
import { AppText } from '@/components/ui';
import type { RecipeSummary } from '@/data/recipes';
import type { SavedMeal } from '@/data/saved-meals';
import { radius, spacing, useTheme } from '@/theme';

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
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: colors.surface, borderColor: colors.border },
        pressed && { opacity: 0.7 },
      ]}>
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
  return (
    <RowShell
      label={`${recipe.name}. ${perServing}. ${servings}. Open recipe`}
      onPress={onPress}>
      <View style={styles.main}>
        <AppText style={styles.name} numberOfLines={2}>
          {recipe.name}
        </AppText>
        <View style={styles.meta}>
          <SourceBadge source="recipe" />
          <AppText variant="small" muted numberOfLines={1} style={styles.shrink}>
            {servings}
            {recipe.servingWeightG ? ` \u00B7 ${gramsText(recipe.servingWeightG)} each` : ''}
          </AppText>
        </View>
        <View style={styles.meta}>
          <CompletenessDot value={recipe.completeness} size={8} />
          <AppText variant="small" muted numberOfLines={1} style={styles.shrink}>
            {perServing}
            {recipe.proteinPerServing !== null || recipe.carbsPerServing !== null || recipe.fatPerServing !== null
              ? `  |  P ${gramsText(recipe.proteinPerServing)}  |  C ${gramsText(recipe.carbsPerServing)}  |  F ${gramsText(recipe.fatPerServing)}`
              : ''}
          </AppText>
        </View>
      </View>
      <AppText muted>{'\u203A'}</AppText>
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
      <AppText muted>{'\u203A'}</AppText>
    </RowShell>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 64,
  },
  main: { flex: 1, gap: 3, paddingVertical: spacing.xs },
  name: { fontWeight: '600', fontSize: 15 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  shrink: { flexShrink: 1 },
});
