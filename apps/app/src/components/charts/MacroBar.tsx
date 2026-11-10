import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

import { formatNumber } from './format';

export interface MacroBarProps {
  label: string;
  /** Consumed amount; undefined = unknown (shown as "-"). */
  value: number | undefined;
  target?: number;
  unit: string;
  /** Bar color while at or below the target. */
  color: string;
  /** Energy after exercise ("net"). When set it drives the bar and percentage; `value` is shown in front of it. */
  netValue?: number;
  decimals?: number;
  /** true (default): going past 100% is bad (danger color). false: reaching 100% is good (success), e.g. protein. */
  overIsBad?: boolean;
  accessibilityLabel?: string;
}

/**
 * Horizontal progress bar for a macro/energy target. Past 100% the bar is rescaled so the target position is
 * marked by a notch and the overflow is drawn in danger (or success) color. Pure presentational.
 */
export function MacroBar({
  label,
  value,
  target,
  unit,
  color,
  netValue,
  decimals = 0,
  overIsBad = true,
  accessibilityLabel,
}: MacroBarProps) {
  const { colors, shape } = useTheme();
  const driver = netValue ?? value;
  const hasTarget = typeof target === 'number' && target > 0;
  const pct = hasTarget && driver !== undefined ? Math.max(0, driver) / (target as number) : undefined;
  const over = pct !== undefined && pct > 1;
  const reached = pct !== undefined && pct >= 1;
  const scale = Math.min(2, Math.max(1, pct ?? 1));
  const mainFill = pct === undefined ? 0 : Math.min(pct, 1) / scale;
  const overFill = over ? (Math.min(pct as number, 2) - 1) / scale : 0;
  const overColor = overIsBad ? colors.danger : colors.success;
  const pctColor = reached ? overColor : colors.textMuted;

  const amount = formatNumber(value, decimals, true);
  const net = netValue !== undefined ? ` (${formatNumber(netValue, decimals, true)} net)` : '';
  const valueText = hasTarget
    ? `${amount}${net} / ${formatNumber(target, decimals, true)} ${unit}`
    : `${amount}${net} ${unit}`;
  const pctText = pct === undefined ? '' : `${Math.round(pct * 100)}%`;

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel ?? `${label}: ${valueText}${pctText ? `, ${pctText}` : ''}`}
      accessibilityValue={pct === undefined ? undefined : { min: 0, max: 100, now: Math.min(100, Math.round(pct * 100)) }}
      style={styles.wrap}>
      <View style={styles.row}>
        <AppText variant="small" style={styles.label} numberOfLines={1}>
          {label}
        </AppText>
        <AppText variant="small" muted numberOfLines={1} style={styles.value}>
          {valueText}
        </AppText>
        <AppText variant="small" numberOfLines={1} style={[styles.pct, { color: pctColor }]}>
          {pctText}
        </AppText>
      </View>
      <View style={[styles.track, { backgroundColor: colors.track, borderRadius: shape.bar(TRACK_HEIGHT) }]}>
        <View style={[styles.segment, { left: 0, width: `${mainFill * 100}%`, backgroundColor: color }]} />
        {over ? (
          <>
            <View
              style={[styles.segment, { left: `${100 / scale}%`, width: `${overFill * 100}%`, backgroundColor: overColor }]}
            />
            <View style={[styles.notch, { left: `${100 / scale}%`, backgroundColor: colors.surface }]} />
          </>
        ) : null}
      </View>
    </View>
  );
}

const TRACK_HEIGHT = 8;

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs + 2 },
  row: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  label: { fontWeight: '700', flexShrink: 0 },
  value: { flex: 1, textAlign: 'right' },
  pct: { fontWeight: '700', minWidth: 40, textAlign: 'right' },
  track: { height: TRACK_HEIGHT, overflow: 'hidden' },
  segment: { position: 'absolute', top: 0, bottom: 0 },
  notch: { position: 'absolute', top: 0, bottom: 0, width: 2, marginLeft: -1 },
});
