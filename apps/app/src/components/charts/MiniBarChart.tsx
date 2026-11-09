import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui';
import { radius, spacing, useTheme } from '@/theme';

export interface MiniBar {
  key: string;
  value: number;
  /** Short caption under the bar, e.g. a weekday initial. */
  label: string;
  /** Not logged: drawn as an empty stub. */
  empty?: boolean;
}

/** Small column chart (one bar per day) with an optional target line. */
export function MiniBarChart({
  bars,
  target,
  height = 72,
  color,
  accessibilityLabel,
}: {
  bars: MiniBar[];
  target?: number;
  height?: number;
  color?: string;
  accessibilityLabel?: string;
}) {
  const { colors } = useTheme();
  const barColor = color ?? colors.energy;
  const max = Math.max(1, target ?? 0, ...bars.map((b) => b.value));
  const targetBottom = target !== undefined ? (target / max) * height : undefined;

  return (
    <View accessible accessibilityRole="image" accessibilityLabel={accessibilityLabel ?? 'Daily bar chart'} style={styles.wrap}>
      <View style={{ height }}>
        <View style={styles.cols}>
          {bars.map((b) => (
            <View key={b.key} style={styles.col}>
              <View
                style={{
                  height: b.empty ? 3 : Math.max(3, (b.value / max) * height),
                  backgroundColor: b.empty ? colors.track : barColor,
                  borderRadius: radius.sm / 2,
                }}
              />
            </View>
          ))}
        </View>
        {targetBottom !== undefined ? (
          <View style={[styles.targetLine, { bottom: targetBottom, borderColor: colors.textMuted }]} />
        ) : null}
      </View>
      <View style={styles.labels}>
        {bars.map((b) => (
          <AppText key={b.key} variant="small" muted style={styles.barLabel} numberOfLines={1}>
            {b.label}
          </AppText>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  cols: { flex: 1, flexDirection: 'row', alignItems: 'flex-end', gap: spacing.xs },
  col: { flex: 1, justifyContent: 'flex-end' },
  targetLine: { position: 'absolute', left: 0, right: 0, borderTopWidth: 1, borderStyle: 'dashed' },
  labels: { flexDirection: 'row', gap: spacing.xs },
  barLabel: { flex: 1, textAlign: 'center', fontSize: 11 },
});
