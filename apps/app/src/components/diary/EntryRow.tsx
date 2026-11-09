import { Pressable, StyleSheet, View } from 'react-native';

import { formatNumber } from '@/components/charts/format';
import { AppText } from '@/components/ui';
import type { DiaryEntry } from '@/data/diary';
import { spacing, useTheme } from '@/theme';

/** "2 x slice" for portion entries, otherwise "150 g". */
export function entryAmountLabel(entry: Pick<DiaryEntry, 'grams' | 'amount' | 'portionLabel'>): string {
  const label = entry.portionLabel?.trim();
  if (entry.amount && label && label.toLowerCase() !== 'g') {
    return `${formatNumber(entry.amount, 2, true)} x ${label}`;
  }
  return `${formatNumber(entry.grams, entry.grams < 10 ? 1 : 0, true)} g`;
}

/** One logged food: name (+ brand) | amount | kcal. */
export function EntryRow({
  entry,
  onPress,
  onLongPress,
  last = false,
}: {
  entry: DiaryEntry;
  onPress: () => void;
  onLongPress?: () => void;
  last?: boolean;
}) {
  const { colors } = useTheme();
  const amount = entryAmountLabel(entry);
  const kcal = entry.kcal === undefined ? '-' : formatNumber(entry.kcal);
  const brand = entry.food.brand?.trim();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${entry.food.name}${brand ? `, ${brand}` : ''}, ${amount}, ${
        entry.kcal === undefined ? 'energy unknown' : `${kcal} kilocalories`
      }. Double tap to edit.`}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: colors.border, backgroundColor: pressed ? colors.surfaceAlt : 'transparent' },
        last && styles.last,
      ]}>
      <View style={styles.nameCell}>
        <AppText numberOfLines={2} style={styles.name}>
          {entry.food.name}
        </AppText>
        {brand ? (
          <AppText variant="small" muted numberOfLines={1}>
            {brand}
          </AppText>
        ) : null}
      </View>
      <AppText variant="small" muted numberOfLines={1} style={styles.amount}>
        {amount}
      </AppText>
      <AppText numberOfLines={1} style={styles.kcal}>
        {kcal}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 48,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  last: { borderBottomWidth: 0 },
  nameCell: { flex: 1, gap: 1 },
  name: { fontSize: 15, fontWeight: '500' },
  amount: { minWidth: 64, textAlign: 'right', flexShrink: 0 },
  kcal: { minWidth: 44, textAlign: 'right', fontWeight: '700', flexShrink: 0 },
});
