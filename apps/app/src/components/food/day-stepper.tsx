import { Pressable, StyleSheet, View } from 'react-native';

import { Glyph } from '@/components/Glyph';
import { useSelectedDate } from '@/state/selected-date';
import { radius, spacing, useTheme } from '@/theme';

import { AppText } from '../ui';
import { formatDayLabel } from './format';

/** "< Today >" control bound to the shared diary date (useSelectedDate). */
export function DayStepper() {
  const { colors } = useTheme();
  const date = useSelectedDate((s) => s.date);
  const shift = useSelectedDate((s) => s.shift);
  const goToday = useSelectedDate((s) => s.goToday);
  const label = formatDayLabel(date);
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Previous day"
        onPress={() => shift(-1)}
        style={[styles.arrow, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
        <Glyph name="chevron-left" size={22} color={colors.text} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Diary date ${label}. Press to jump to today`}
        onPress={goToday}
        style={styles.center}>
        <AppText variant="body" style={{ fontWeight: '700' }}>{label}</AppText>
        <AppText variant="small" muted>{date}</AppText>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Next day"
        onPress={() => shift(1)}
        style={[styles.arrow, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
        <Glyph name="chevron-right" size={22} color={colors.text} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  center: { flex: 1, alignItems: 'center', paddingVertical: spacing.xs },
  arrow: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
