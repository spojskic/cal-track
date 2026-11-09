import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { FoodSource } from '@/data/foods';
import { radius, spacing, useTheme } from '@/theme';

import { AppText } from '../ui';
import { CompletenessDot } from './completeness';
import { macroLine } from './format';
import { SourceBadge } from './source-badge';

/** What a row needs to render; FoodSummary and online search results both fit. */
export interface FoodRowData {
  name: string;
  brand: string | null;
  source: FoodSource;
  kcal100g: number | null;
  protein100g: number | null;
  carbs100g: number | null;
  fat100g: number | null;
  completeness: number | null;
}

export type QuickAddState = 'idle' | 'pending' | 'done';

/**
 * A search/list row: name, brand, source badge, kcal + P/C/F per 100 g, completeness dot and an
 * optional quick-add "+" button.
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
  return (
    <View style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${food.name}${food.brand ? `, ${food.brand}` : ''}. ${summary.replace(/\|/g, ',')} per 100 grams. Open details`}
        onPress={onPress}
        style={({ pressed }) => [styles.main, pressed && { opacity: 0.7 }]}>
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
        <View style={styles.metaRow}>
          <SourceBadge source={food.source} />
          {food.brand ? (
            <AppText variant="small" muted numberOfLines={1} style={styles.brand}>
              {food.brand}
            </AppText>
          ) : null}
        </View>
        <View style={styles.metaRow}>
          <CompletenessDot value={food.completeness} size={8} />
          <AppText variant="small" muted numberOfLines={1} style={styles.brand}>
            {summary} per 100 g
          </AppText>
        </View>
      </Pressable>
      {onQuickAdd ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            quickAddState === 'done' ? `${food.name} added to diary` : `Quick add one serving of ${food.name} to diary`
          }
          disabled={quickAddState === 'pending'}
          onPress={onQuickAdd}
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
            <Text style={[styles.addText, { color: colors.onPrimary }]}>
              {quickAddState === 'done' ? '\u2713' : '+'}
            </Text>
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
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 64,
  },
  main: { flex: 1, gap: 3, paddingVertical: spacing.xs },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { flexShrink: 1, fontWeight: '600', fontSize: 15 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  brand: { flexShrink: 1 },
  add: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addText: { fontSize: 24, lineHeight: 28, fontWeight: '600' },
});
