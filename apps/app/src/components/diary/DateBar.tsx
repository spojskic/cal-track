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
      <View style={styles.right}>
        {onAdd ? <IconButton glyph="+" label="Add to diary" onPress={onAdd} size={36} /> : null}
        {onMenu ? <IconButton glyph={'\u22EF'} label="More diary actions" onPress={onMenu} size={36} /> : null}
      </View>
    </View>
  );
}

const SIDE = 76; // room reserved on BOTH sides: the two 36 px buttons on the right, nothing on the left

const styles = StyleSheet.create({
  // The date block is centred in the bar by the bar itself; the action buttons are laid over the right-hand margin.
  // (Two flexible side columns of unequal content did not stay equal on a phone and pushed the date off-centre.)
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minHeight: 44, paddingHorizontal: SIDE },
  right: { position: 'absolute', right: 0, top: 0, bottom: 0, flexDirection: 'row', alignItems: 'center' },
  center: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  date: { alignItems: 'center', paddingHorizontal: spacing.xs, minHeight: 36, justifyContent: 'center', flexShrink: 1 },
  dateText: { fontSize: 16, fontWeight: '700' },
  relative: { fontSize: 11, fontWeight: '600', lineHeight: 13 },
});
