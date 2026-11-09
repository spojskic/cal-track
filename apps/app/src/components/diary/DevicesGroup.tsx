import { StyleSheet, View } from 'react-native';

import { formatNumber } from '@/components/charts/format';
import { AppText } from '@/components/ui';
import type { BiometricEntry, DailyEnergyRow, ExerciseEntry } from '@/data/activity';
import { radius, spacing, useTheme } from '@/theme';

export interface DeviceRow {
  key: string;
  name: string;
  /** Secondary text ("45 min", "8,543 steps", "62 bpm"). */
  detail?: string;
  /** Burned energy (positive number); shown as a negative kcal value. */
  burnedKcal?: number;
}

const SOURCE_LABELS: Record<string, string> = {
  garmin: 'Garmin',
  apple_health: 'Apple Health',
  health_connect: 'Health Connect',
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? 'Misc';
}

const prettify = (type: string) => {
  const spaced = type.replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

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
      name: prettify(b.type),
      detail: `${formatNumber(b.value, 1, true)}${b.unit ? ` ${b.unit}` : ''}`,
    });
  }
  return { rows, sources: [...sources] };
}

/** Device group above the meals: burned energy as negative kcal like Cronometer. */
export function DevicesGroup({ rows, sources }: { rows: DeviceRow[]; sources: string[] }) {
  const { colors } = useTheme();
  if (rows.length === 0) return null;
  const title = sources.length > 0 ? `${sources.map(sourceLabel).join(' and ')} activity` : 'Devices';

  return (
    <View style={[styles.group, { borderColor: colors.border }]}>
      <View style={[styles.header, { backgroundColor: colors.surfaceAlt }]}>
        <AppText style={styles.title}>{title}</AppText>
      </View>
      <View style={styles.rows}>
        {rows.map((row, i) => (
          <View
            key={row.key}
            accessible
            accessibilityLabel={`${row.name}${row.detail ? `, ${row.detail}` : ''}${
              row.burnedKcal !== undefined ? `, burned ${formatNumber(row.burnedKcal)} kilocalories` : ''
            }`}
            style={[styles.row, { borderBottomColor: colors.border }, i === rows.length - 1 && styles.last]}>
            <AppText numberOfLines={1} style={styles.name}>
              {row.name}
            </AppText>
            {row.detail ? (
              <AppText variant="small" muted numberOfLines={1}>
                {row.detail}
              </AppText>
            ) : null}
            <AppText numberOfLines={1} style={styles.kcal}>
              {row.burnedKcal !== undefined ? formatNumber(-row.burnedKcal) : ''}
            </AppText>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, overflow: 'hidden' },
  header: { paddingHorizontal: spacing.md, minHeight: 40, justifyContent: 'center' },
  title: { fontWeight: '700' },
  rows: { paddingHorizontal: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  last: { borderBottomWidth: 0 },
  name: { flex: 1, fontSize: 15, fontWeight: '500' },
  kcal: { minWidth: 48, textAlign: 'right', fontWeight: '700' },
});
