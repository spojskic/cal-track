import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { create } from 'zustand';

import { formatNumber } from '@/components/charts/format';
import { AppText } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

import { sourceName } from './activity-rows';
import type { DeviceRow } from './device-rows';

// The rows themselves (and the rule that each thing is listed once, from the best-ranked source) are in device-rows.ts.
export { buildDeviceRows, type DeviceRow } from './device-rows';

/**
 * Open or closed, kept in memory for the session only: the group starts closed (a watch adds a dozen rows a day), stays as the
 * user left it while they move between days and screens, and is closed again the next time the app starts.
 */
export const useDevicesGroupOpen = create<{ open: boolean; toggle: () => void }>()((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
}));

/** Device group above the meals: a flat, collapsible section, burned energy as negative kcal like Cronometer. Closed by default. */
export function DevicesGroup({ rows, sources }: { rows: DeviceRow[]; sources: string[] }) {
  const { colors } = useTheme();
  const open = useDevicesGroupOpen((s) => s.open);
  const toggle = useDevicesGroupOpen((s) => s.toggle);
  if (rows.length === 0) return null;
  const title = sources.length > 0 ? `${sources.map(sourceName).join(' and ')} activity` : 'Devices';
  const burned = rows.reduce((sum, r) => sum + (r.burnedKcal ?? 0), 0);
  const items = `${rows.length} ${rows.length === 1 ? 'item' : 'items'}`;
  const summary = burned > 0 ? `${items}, ${formatNumber(-burned)} kcal` : items;

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${title}, ${summary}. ${open ? 'Collapse' : 'Expand'}`}
        onPress={toggle}
        style={({ pressed }) => [styles.header, { backgroundColor: colors.surfaceAlt, opacity: pressed ? 0.85 : 1 }]}>
        <View style={styles.chevron}>
          <SymbolView
            name={{ ios: open ? 'chevron.down' : 'chevron.right', android: open ? 'expand_more' : 'chevron_right' }}
            size={14}
            tintColor={colors.textMuted}
            fallback={<Text style={[styles.chevronGlyph, { color: colors.textMuted }]}>{open ? '\u25BE' : '\u25B8'}</Text>}
          />
        </View>
        <AppText style={styles.title} numberOfLines={1}>
          {title}
        </AppText>
        <AppText muted variant="small" numberOfLines={1} style={styles.summary}>
          {summary}
        </AppText>
      </Pressable>
      {open
        ? rows.map((row) => (
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
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, minHeight: 40 },
  chevron: { width: 16, alignItems: 'center', justifyContent: 'center' },
  chevronGlyph: { fontSize: 14 },
  title: { fontWeight: '700', flexShrink: 1 },
  summary: { flex: 1, textAlign: 'right' },
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
