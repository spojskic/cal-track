import { Pressable, StyleSheet, View } from 'react-native';

import { formatNumber } from '@/components/charts/format';
import { AppText } from '@/components/ui';
import { radius, spacing, useTheme } from '@/theme';

/** Default daily water goal when no water target is configured. */
export const DEFAULT_WATER_TARGET_ML = 2600;
/** Amount suggested by the quick-add button. */
export const QUICK_WATER_ML = 250;

/** Water progress (ml / target) as a flat row with a quick "+250 mL" button. */
export function WaterRow({
  ml,
  target,
  onAdd,
}: {
  ml: number | undefined;
  target: number;
  onAdd: () => void;
}) {
  const { colors } = useTheme();
  const value = ml ?? 0;
  const fraction = target > 0 ? value / target : 0;
  const reached = fraction >= 1;

  return (
    <View style={[styles.row, { borderBottomColor: colors.border, backgroundColor: colors.background }]}>
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={`Water ${formatNumber(value)} of ${formatNumber(target)} millilitres`}
        accessibilityValue={{ min: 0, max: 100, now: Math.min(100, Math.round(fraction * 100)) }}
        style={styles.info}>
        <View style={styles.line}>
          <AppText style={{ fontWeight: '700' }}>Water</AppText>
          <AppText variant="small" muted>
            {ml === undefined ? '-' : formatNumber(value)} / {formatNumber(target)} mL
          </AppText>
        </View>
        <View style={[styles.track, { backgroundColor: colors.track }]}>
          <View
            style={{
              width: `${Math.min(1, fraction) * 100}%`,
              height: '100%',
              backgroundColor: reached ? colors.success : colors.carbs,
            }}
          />
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Add ${QUICK_WATER_ML} millilitres of water`}
        onPress={onAdd}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: pressed ? colors.track : colors.surfaceAlt, borderColor: colors.border },
        ]}>
        <AppText style={{ fontSize: 13, fontWeight: '700', color: colors.primary }}>+ {QUICK_WATER_ML} mL</AppText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  info: { flex: 1, gap: spacing.xs + 2 },
  line: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  track: { height: 8, borderRadius: radius.pill, overflow: 'hidden' },
  button: {
    minHeight: 36,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
