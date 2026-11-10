import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Glyph } from '@/components/Glyph';
import type { FoodKind, FoodSource } from '@/data/foods';
import { spacing, useTheme } from '@/theme';

import { AppText } from '../ui';
import { CompletenessDot } from './completeness';
import { formatKcal, macroLine } from './format';
import { SourceLabel } from './source-badge';
import { foodSourceLabel } from './source-label';

/** What a row needs to render; FoodSummary and online search results both fit. */
export interface FoodRowData {
  name: string;
  brand: string | null;
  source: FoodSource;
  /** Own foods and recipes are told apart from database foods by this (optional: online results have none). */
  kind?: FoodKind;
  kcal100g: number | null;
  protein100g: number | null;
  carbs100g: number | null;
  fat100g: number | null;
  completeness: number | null;
}

export type QuickAddState = 'idle' | 'pending' | 'done';

/**
 * A flat list row (no card, a hairline underneath): bold name, muted detail line (brand and kcal per 100 g), the source
 * label right-aligned and coloured by what it is (own food, recipe, database), an optional favourite star and an
 * optional quick-add "+" button. Put rows in a padded container: the hairline spans the container.
 */
export function FoodRow({
  food,
  onPress,
  onQuickAdd,
  quickAddState = 'idle',
  favorite,
}: {
  food: FoodRowData;
  onPress: () => void;
  onQuickAdd?: () => void;
  quickAddState?: QuickAddState;
  favorite?: boolean;
}) {
  const { colors } = useTheme();
  const summary = macroLine(food);
  const source = foodSourceLabel(food.source, food.kind);
  return (
    <View style={[styles.row, { borderBottomColor: colors.border }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${food.name}${food.brand ? `, ${food.brand}` : ''}. ${summary.replace(/\|/g, ',')} per 100 grams. Source: ${source.full}. Open details`}
        onPress={onPress}
        style={({ pressed }) => [styles.main, pressed && { opacity: 0.7 }]}>
        <View style={styles.text}>
          <View style={styles.titleRow}>
            <AppText variant="body" style={styles.name} numberOfLines={2}>
              {food.name}
            </AppText>
            {favorite ? (
              <Text accessibilityLabel="Favorite" style={{ color: colors.primary, fontSize: 14 }}>
                {'\u2605'}
              </Text>
            ) : null}
          </View>
          <View style={styles.detailRow}>
            <CompletenessDot value={food.completeness} size={8} />
            <AppText variant="small" muted numberOfLines={1} style={styles.detail}>
              {food.brand ? `${food.brand} \u00B7 ` : ''}
              {formatKcal(food.kcal100g)} kcal per 100 g
            </AppText>
          </View>
        </View>
        <SourceLabel info={source} />
      </Pressable>
      {onQuickAdd ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            quickAddState === 'done' ? `${food.name} added to diary` : `Quick add one serving of ${food.name} to diary`
          }
          disabled={quickAddState === 'pending'}
          onPress={onQuickAdd}
          hitSlop={4}
          style={({ pressed }) => [
            styles.add,
            {
              backgroundColor: quickAddState === 'done' ? colors.success : colors.primary,
              opacity: pressed ? 0.8 : 1,
            },
          ]}>
          {quickAddState === 'pending' ? (
            <ActivityIndicator color={colors.onPrimary} size="small" />
          ) : (
            <Glyph name={quickAddState === 'done' ? 'check' : 'plus'} size={20} color={colors.onPrimary} />
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.sm,
    minHeight: 60,
  },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs },
  text: { flex: 1, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { flexShrink: 1, fontWeight: '700', fontSize: 16 },
  detailRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  detail: { flexShrink: 1 },
  add: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
