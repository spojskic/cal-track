import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui';
import { spacing, useTheme, type ThemeColors } from '@/theme';

import { zoneBar, zoneSummary } from './format';
import type { WorkoutHrZone } from '@cal/garmin';

/** Easy to hard: blue, green, yellow, orange, red (the theme's own hues); zones 6 and 7 (some watches) reuse red / violet. */
function zoneColor(zone: number, colors: ThemeColors): string {
  switch (zone) {
    case 1:
      return colors.carbs;
    case 2:
      return colors.protein;
    case 3:
      return colors.warning;
    case 4:
      return colors.energy;
    case 5:
    case 6:
      return colors.danger;
    case 7:
      return colors.fat;
    default:
      return colors.accent;
  }
}

/** Time in each heart-rate zone: one horizontal stacked bar and a legend with the minutes per zone. Nothing for no data. */
export function ZoneBar({ zones }: { zones: readonly WorkoutHrZone[] | undefined }) {
  const { colors, shape } = useTheme();
  const segments = zoneBar(zones);
  if (segments.length === 0) return null;
  return (
    <View style={styles.wrap}>
      <View accessible accessibilityRole="image" accessibilityLabel={`Time in heart-rate zones: ${zoneSummary(zones)}`} style={[styles.bar, { borderRadius: shape.bar(BAR_HEIGHT) }]}>
        {segments
          .filter((s) => s.fraction > 0)
          .map((s) => (
            <View key={s.zone} style={{ flexGrow: s.fraction, flexBasis: 0, backgroundColor: zoneColor(s.zone, colors) }} />
          ))}
      </View>
      <View style={styles.legend}>
        {segments.map((s) => (
          <View key={s.zone} style={styles.legendRow} accessible accessibilityLabel={`${s.label}, ${s.time}${s.lowBpm ? `, from ${s.lowBpm} bpm` : ''}`}>
            <View style={[styles.dot, { backgroundColor: zoneColor(s.zone, colors) }]} />
            <AppText style={styles.zoneName}>{s.label}</AppText>
            {s.lowBpm ? (
              <AppText variant="small" muted>
                {s.lowBpm}+ bpm
              </AppText>
            ) : null}
            <View style={styles.spacer} />
            <AppText style={styles.zoneTime}>{s.time}</AppText>
          </View>
        ))}
      </View>
    </View>
  );
}

const BAR_HEIGHT = 16;

const styles = StyleSheet.create({
  wrap: { gap: spacing.md },
  bar: { flexDirection: 'row', height: BAR_HEIGHT, overflow: 'hidden', gap: 1 },
  legend: { gap: spacing.xs },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 26 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  zoneName: { fontSize: 14, fontWeight: '600' },
  spacer: { flex: 1 },
  zoneTime: { fontSize: 14, fontWeight: '600' },
});
