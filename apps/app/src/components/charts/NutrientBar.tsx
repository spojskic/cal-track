import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

import { formatAmount, formatPercent } from './format';
import { nutrientFraction, nutrientStatus } from './nutrient-status';

export { nutrientFraction, nutrientStatus, type NutrientStatus } from './nutrient-status';

export interface NutrientBarProps {
  name: string;
  /** undefined = unknown (no food has data). */
  amount: number | undefined;
  unit: string;
  min?: number;
  max?: number;
  /** Total understates the truth (some foods lack data for this nutrient). */
  incomplete?: boolean;
  /** Indent as a sub-nutrient. */
  indent?: boolean;
}

/** One table row: name | amount unit | bar | %. Pure presentational. */
export function NutrientBar({ name, amount, unit, min, max, incomplete, indent }: NutrientBarProps) {
  const { colors, shape } = useTheme();
  const status = nutrientStatus(amount, min, max);
  const fraction = nutrientFraction(amount, min, max);
  const fill = fraction === undefined ? 0 : Math.min(1, fraction);
  const barColor =
    status === 'ok' ? colors.success : status === 'over' ? colors.danger : colors.textMuted;
  const pctColor = status === 'over' ? colors.danger : status === 'ok' ? colors.success : colors.textMuted;
  const amountText = `${formatAmount(amount, unit)}${incomplete && amount !== undefined ? '*' : ''}`;
  const pctText = formatPercent(fraction);
  const statusText =
    status === 'over' ? 'over the limit' : status === 'ok' ? 'on target' : status === 'under' ? 'below target' : '';

  return (
    <View
      accessible
      accessibilityLabel={`${name}: ${amountText}${fraction !== undefined ? `, ${pctText} of target` : ''}${statusText ? `, ${statusText}` : ''}`}
      style={[styles.row, indent && styles.indent]}>
      <AppText variant="small" numberOfLines={2} style={styles.name}>
        {name}
      </AppText>
      <AppText variant="small" muted numberOfLines={1} style={styles.amount}>
        {amountText}
      </AppText>
      <View style={styles.barCell}>
        {fraction !== undefined ? (
          <View style={[styles.track, { backgroundColor: colors.track, borderRadius: shape.bar(TRACK_HEIGHT) }]}>
            <View
              style={{
                width: `${fill * 100}%`,
                height: '100%',
                backgroundColor: barColor,
                opacity: status === 'under' ? 0.55 : 1,
              }}
            />
          </View>
        ) : null}
      </View>
      <AppText variant="small" numberOfLines={1} style={[styles.pct, { color: pctColor }]}>
        {fraction === undefined ? '' : pctText}
      </AppText>
    </View>
  );
}

const TRACK_HEIGHT = 6;

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 30, paddingVertical: 2 },
  indent: { paddingLeft: spacing.md },
  name: { flex: 1 },
  amount: { width: 82, textAlign: 'right' },
  barCell: { width: 64, justifyContent: 'center' },
  track: { height: TRACK_HEIGHT, overflow: 'hidden' },
  pct: { width: 46, textAlign: 'right', fontWeight: '600' },
});
