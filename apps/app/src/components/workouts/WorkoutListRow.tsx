import { Pressable, StyleSheet, View } from 'react-native';

import { Badge } from '@/components/settings/rows';
import { AppText } from '@/components/ui';
import type { WorkoutRow } from '@/data/workouts';
import { spacing, useTheme } from '@/theme';

import { workoutKind } from './kinds';
import { workoutRowText } from './summary';
import { WorkoutIcon } from './WorkoutIcon';

/**
 * One workout of the list as a flat full-width row (same look as the diary's entry rows): icon, name, date + time + duration,
 * source badge and the average heart rate when a device reported it, calories on the right.
 */
export function WorkoutListRow({ row, onPress }: { row: WorkoutRow; onPress: () => void }) {
  const { colors } = useTheme();
  const text = workoutRowText(row);
  const kind = workoutKind({ name: row.name, activity_code: row.activity_code, type_key: row.type_key });

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={text.label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: colors.border, backgroundColor: pressed ? colors.surfaceAlt : colors.background },
      ]}>
      <WorkoutIcon kind={kind} />
      <View style={styles.main}>
        <AppText numberOfLines={2} style={styles.name}>
          {text.title}
        </AppText>
        {text.line ? (
          <AppText variant="small" muted numberOfLines={1}>
            {text.line}
          </AppText>
        ) : null}
        <View style={styles.meta}>
          <Badge label={text.source} />
          {text.hr ? (
            <AppText variant="small" muted numberOfLines={1}>
              {text.hr}
            </AppText>
          ) : null}
        </View>
      </View>
      <View style={styles.kcalCell}>
        <AppText numberOfLines={1} style={styles.kcal}>
          {text.kcal}
        </AppText>
        <AppText muted numberOfLines={1} style={styles.kcalUnit}>
          kcal
        </AppText>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 72,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  main: { flex: 1, gap: 2 },
  name: { fontSize: 15, fontWeight: '700' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 2 },
  kcalCell: { alignItems: 'flex-end', minWidth: 44, flexShrink: 0 },
  kcal: { fontSize: 15, fontWeight: '600' },
  kcalUnit: { fontSize: 11, lineHeight: 14 },
});
