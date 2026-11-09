import { StyleSheet, View } from 'react-native';
import { NUTRIENT_BY_CODE, type NutrientCode, type NutrientMap } from '@cal/core';

import { CompletenessLabel } from '@/components/food/completeness';
import { formatAmount, formatKcal, trimNumber } from '@/components/food/format';
import { AppText, Card } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

import type { RecipeNutrition } from './nutrition';

/** Readable list of nutrient names: "Fiber, Sodium, Vitamin C and 3 more". */
export function nutrientNames(codes: readonly NutrientCode[], max = 6): string {
  const names = codes.map((c) => NUTRIENT_BY_CODE[c]?.shortName ?? NUTRIENT_BY_CODE[c]?.name ?? c);
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

function Column({ title, subtitle, map }: { title: string; subtitle?: string; map: NutrientMap }) {
  const { colors } = useTheme();
  const grams = (v: number | undefined) => (v === undefined ? '-' : `${formatAmount(v, 'g')} g`);
  return (
    <View
      accessible
      accessibilityLabel={`${title}${subtitle ? `, ${subtitle}` : ''}. ${map.ENERGY_KCAL === undefined ? 'Calories unknown' : `${formatKcal(map.ENERGY_KCAL)} kilocalories`}, protein ${grams(map.PROTEIN_G)}, carbs ${grams(map.CARBS_G)}, fat ${grams(map.FAT_G)}`}
      style={styles.column}>
      <AppText variant="label" muted>
        {title}
      </AppText>
      {subtitle ? (
        <AppText variant="small" muted>
          {subtitle}
        </AppText>
      ) : null}
      <View style={styles.kcalRow}>
        <AppText style={[styles.kcal, { color: colors.energy }]}>{formatKcal(map.ENERGY_KCAL)}</AppText>
        <AppText muted>kcal</AppText>
      </View>
      <AppText variant="small">
        <AppText variant="small" style={{ color: colors.protein, fontWeight: '700' }}>P </AppText>
        {grams(map.PROTEIN_G)}
      </AppText>
      <AppText variant="small">
        <AppText variant="small" style={{ color: colors.carbs, fontWeight: '700' }}>C </AppText>
        {grams(map.CARBS_G)}
      </AppText>
      <AppText variant="small">
        <AppText variant="small" style={{ color: colors.fat, fontWeight: '700' }}>F </AppText>
        {grams(map.FAT_G)}
      </AppText>
    </View>
  );
}

/**
 * Live nutrition of a recipe: per serving and per 100 g of the finished dish, weights, and a data completeness
 * hint. `nutrition` null = nothing to compute yet.
 */
export function RecipeTotalsCard({
  nutrition,
  hasCookedWeight,
  hint,
}: {
  nutrition: RecipeNutrition | null;
  hasCookedWeight: boolean;
  /** Extra warning, e.g. ingredients that are still loading or have no valid amount. */
  hint?: string | null;
}) {
  const { colors } = useTheme();
  return (
    <Card>
      <AppText variant="heading">Nutrition</AppText>
      {nutrition ? (
        <>
          <View style={styles.columns}>
            <Column title="Per serving" subtitle={`${trimNumber(nutrition.servingWeightG, 1)} g`} map={nutrition.perServing} />
            <Column title="Per 100 g" map={nutrition.per100g} />
          </View>
          <AppText variant="small" muted>
            Ingredients weigh {trimNumber(nutrition.rawWeightG, 1)} g
            {hasCookedWeight
              ? `; finished dish ${trimNumber(nutrition.finalWeightG, 1)} g.`
              : '. Without a cooked weight, per-100 g values use the ingredient weight.'}
          </AppText>
          <CompletenessLabel value={nutrition.completeness} />
          {nutrition.incompleteNutrients.length > 0 ? (
            <AppText variant="small" style={{ color: colors.warning }} accessibilityLiveRegion="polite">
              Incomplete data: {nutrientNames(nutrition.incompleteNutrients)} {nutrition.incompleteNutrients.length === 1 ? 'is' : 'are'} missing
              for some ingredients, so the totals can be too low. A dash means unknown, not zero.
            </AppText>
          ) : null}
        </>
      ) : (
        <AppText muted>Add ingredients with an amount to see calories and macros.</AppText>
      )}
      {hint ? (
        <AppText variant="small" style={{ color: colors.warning }}>
          {hint}
        </AppText>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  columns: { flexDirection: 'row', gap: spacing.lg },
  column: { flex: 1, gap: 2 },
  kcalRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.xs },
  kcal: { fontSize: 32, fontWeight: '800', lineHeight: 38 },
});
