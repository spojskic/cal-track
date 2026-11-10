import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

import { formatDayLabel, relativeDayLabel } from './dates';
import { IconButton } from './IconButton';

/**
 * One compact row: `<  Sun, Nov 8  >` in the centre (a small "Today" / "Yesterday" under it) and [+] [...] at the
 * right. Tapping the date jumps to today.
 */
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
      <View style={styles.side} />
      <View style={styles.center}>
        <IconButton glyph={'\u2039'} label="Previous day" onPress={onPrev} size={36} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label}${relative ? `, ${relative}` : ''}. Go to today`}
          onPress={onToday}
          style={styles.date}>
          <AppText numberOfLines={1} style={styles.dateText}>
            {label}
          </AppText>
          {relative ? (
            <AppText numberOfLines={1} style={[styles.relative, { color: relative === 'Today' ? colors.primary : colors.textMuted }]}>
              {relative}
            </AppText>
          ) : null}
        </Pressable>
        <IconButton glyph={'\u203A'} label="Next day" onPress={onNext} size={36} />
      </View>
      <View style={[styles.side, styles.right]}>
        {onAdd ? <IconButton glyph="+" label="Add to diary" onPress={onAdd} size={36} /> : null}
        {onMenu ? <IconButton glyph={'\u22EF'} label="More diary actions" onPress={onMenu} size={36} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  // Both sides take the same share, so the date stays centred; the right side never gets narrower than its buttons.
  side: { flexGrow: 1, flexBasis: 0, minWidth: 0 },
  right: { minWidth: 76, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center' },
  center: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  date: { alignItems: 'center', paddingHorizontal: spacing.xs, minHeight: 36, justifyContent: 'center', flexShrink: 1 },
  dateText: { fontSize: 16, fontWeight: '700' },
  relative: { fontSize: 11, fontWeight: '600', lineHeight: 13 },
});
