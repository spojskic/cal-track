import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

import { formatDayLabel, relativeDayLabel } from './dates';
import { IconButton } from './IconButton';

/** Diary date bar: < Sun, Nov 8 >  [+] [...]. Tapping the date jumps to today. */
export function DateBar({
  date,
  onPrev,
  onNext,
  onToday,
  onAdd,
  onMenu,
}: {
  date: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onAdd?: () => void;
  onMenu?: () => void;
}) {
  const { colors } = useTheme();
  const label = formatDayLabel(date);
  const relative = relativeDayLabel(date);

  return (
    <View style={styles.bar}>
      <IconButton glyph="‹" label="Previous day" onPress={onPrev} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}${relative ? `, ${relative}` : ''}. Go to today`}
        onPress={onToday}
        style={styles.date}>
        <AppText variant="heading" numberOfLines={1}>
          {label}
        </AppText>
        <AppText variant="small" style={{ color: relative === 'Today' ? colors.primary : colors.textMuted }}>
          {relative ?? 'Tap for today'}
        </AppText>
      </Pressable>
      <IconButton glyph="›" label="Next day" onPress={onNext} />
      {onAdd ? <IconButton glyph="+" label="Add to diary" onPress={onAdd} filled size={36} /> : null}
      {onMenu ? <IconButton glyph="⋯" label="More diary actions" onPress={onMenu} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  date: { flex: 1, alignItems: 'center', paddingVertical: spacing.xs },
});
