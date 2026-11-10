import { StyleSheet, View } from 'react-native';

import { formatNumber } from '@/components/charts/format';
import { AppText } from '@/components/ui';
import type { BiometricEntry, DailyEnergyRow, ExerciseEntry } from '@/data/activity';
import { spacing, useTheme } from '@/theme';

import { prettifyType, sourceName } from './activity-rows';

export interface DeviceRow {
  key: string;
  name: string;
  /** Secondary text ("45 min", "8,543 steps", "62 bpm"). */
  detail?: string;
  /** Burned energy (positive number); shown as a negative kcal value. */
  burnedKcal?: number;
}

/** Device-sourced exercise, daily activity and biometrics shown in the "Garmin and Misc" style group. */
export function buildDeviceRows(
  exercise: readonly ExerciseEntry[],
  energyRows: readonly DailyEnergyRow[],
  biometrics: readonly BiometricEntry[],
): { rows: DeviceRow[]; sources: string[] } {
  const rows: DeviceRow[] = [];
  const sources = new Set<string>();

  for (const e of energyRows) {
    if (e.source === 'manual') continue;
    sources.add(e.source);
    if (e.active_kcal !== null && e.active_kcal > 0) {
      rows.push({
        key: `energy-${e.source}`,
        name: 'Daily Activity',
        detail: e.steps ? `${formatNumber(e.steps)} steps` : undefined,
        burnedKcal: e.active_kcal,
      });
    }
  }
  for (const e of exercise) {
    if (e.source === 'manual') continue;
    sources.add(e.source);
    rows.push({
      key: `exercise-${e.id}`,
      name: e.name,
      detail: e.minutes ? `${formatNumber(e.minutes, 0, true)} min` : undefined,
      burnedKcal: e.kcal,
    });
  }
  for (const b of biometrics) {
    if (b.source === 'manual') continue;
    sources.add(b.source);
    rows.push({
      key: `bio-${b.id}`,
      name: prettifyType(b.type),
      detail: `${formatNumber(b.value, 1, true)}${b.unit ? ` ${b.unit}` : ''}`,
    });
  }
  return { rows, sources: [...sources] };
}

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
