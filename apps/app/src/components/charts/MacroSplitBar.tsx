import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui';
import { radius, spacing, useTheme } from '@/theme';

import { formatNumber } from './format';

/** Energy (kcal) coming from each macro. */
export interface MacroKcal {
  protein: number;
  carbs: number;
  fat: number;
}

/** Stacked calorie-split bar (protein / carbs / fat) with a percentage legend. */
export function MacroSplitBar({ split, caption }: { split: MacroKcal | undefined; caption?: string }) {
  const { colors } = useTheme();
  const total = split ? split.protein + split.carbs + split.fat : 0;
  const parts = [
    { key: 'protein', label: 'Protein', kcal: split?.protein ?? 0, color: colors.protein },
    { key: 'carbs', label: 'Carbs', kcal: split?.carbs ?? 0, color: colors.carbs },
    { key: 'fat', label: 'Fat', kcal: split?.fat ?? 0, color: colors.fat },
  ];
  const pct = (kcal: number) => (total > 0 ? Math.round((kcal / total) * 100) : 0);
  const summary = parts.map((p) => `${p.label} ${pct(p.kcal)}%`).join(', ');

  return (
    <View accessible accessibilityLabel={`${caption ? `${caption}: ` : ''}${total > 0 ? summary : 'no data'}`} style={styles.wrap}>
      <View style={[styles.track, { backgroundColor: colors.track }]}>
        {total > 0
          ? parts.map((p) => (
              <View key={p.key} style={{ flex: p.kcal / total, backgroundColor: p.color }} />
            ))
          : null}
      </View>
      <View style={styles.legend}>
        {parts.map((p) => (
          <View key={p.key} style={styles.legendItem}>
            <View style={[styles.dot, { backgroundColor: p.color }]} />
            <AppText variant="small" muted>
              {p.label} {total > 0 ? `${pct(p.kcal)}%` : '-'}
            </AppText>
          </View>
        ))}
        {total > 0 ? (
          <AppText variant="small" muted style={styles.total}>
            {formatNumber(total)} kcal
          </AppText>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  track: { flexDirection: 'row', height: 10, borderRadius: radius.pill, overflow: 'hidden' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.md },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  total: { marginLeft: 'auto' },
});
