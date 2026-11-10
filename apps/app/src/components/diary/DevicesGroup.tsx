import { StyleSheet, View } from 'react-native';

import { formatNumber } from '@/components/charts/format';
import { AppText } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

import { sourceName } from './activity-rows';
import type { DeviceRow } from './device-rows';

// The rows themselves (and the rule that each thing is listed once, from the best-ranked source) are in device-rows.ts.
export { buildDeviceRows, type DeviceRow } from './device-rows';

/** Device group above the meals: a flat section, burned energy as negative kcal like Cronometer. */
export function DevicesGroup({ rows, sources }: { rows: DeviceRow[]; sources: string[] }) {
  const { colors } = useTheme();
  if (rows.length === 0) return null;
  const title = sources.length > 0 ? `${sources.map(sourceName).join(' and ')} activity` : 'Devices';

  return (
    <View>
      <View style={[styles.header, { backgroundColor: colors.surfaceAlt }]}>
        <AppText style={styles.title}>{title}</AppText>
      </View>
      {rows.map((row) => (
        <View
          key={row.key}
          accessible
          accessibilityLabel={`${row.name}${row.detail ? `, ${row.detail}` : ''}${
            row.burnedKcal !== undefined ? `, burned ${formatNumber(row.burnedKcal)} kilocalories` : ''
          }`}
          style={[styles.row, { borderBottomColor: colors.border, backgroundColor: colors.background }]}>
          <View style={styles.text}>
            <AppText numberOfLines={1} style={styles.name}>
              {row.name}
            </AppText>
            {row.detail ? (
              <AppText variant="small" muted numberOfLines={1}>
                {row.detail}
              </AppText>
            ) : null}
          </View>
          {row.burnedKcal !== undefined ? (
            <View style={styles.kcalCell}>
              <AppText numberOfLines={1} style={styles.kcal}>
                {formatNumber(-row.burnedKcal)}
              </AppText>
              <AppText muted numberOfLines={1} style={styles.kcalUnit}>
                kcal
              </AppText>
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: spacing.lg, minHeight: 40, justifyContent: 'center' },
  title: { fontWeight: '700' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  text: { flex: 1, gap: 1 },
  name: { fontSize: 15, fontWeight: '700' },
  kcalCell: { alignItems: 'flex-end', minWidth: 44, flexShrink: 0 },
  kcal: { fontSize: 15, fontWeight: '600' },
  kcalUnit: { fontSize: 11, lineHeight: 14 },
});
