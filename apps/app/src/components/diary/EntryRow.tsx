import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui';
import type { DiaryEntry } from '@/data/diary';
import { spacing, useTheme } from '@/theme';

import { entryRowText } from './entry-summary';
import { deleteAccessibilityActions, deleteLabel, isDeleteAction } from './swipe-delete';
import { SwipeToDelete } from './SwipeToDelete';

/**
 * One logged food as a full-width flat row: name (bold) with the serving in muted text below, kcal on the right.
 * With `onDelete` the row can be swiped to the left to delete it (phones; the web build has no swipe) and offers a
 * "delete" action to screen readers.
 */
export function EntryRow({
  entry,
  onPress,
  onLongPress,
  onDelete,
}: {
  entry: DiaryEntry;
  onPress: () => void;
  onLongPress?: () => void;
  onDelete?: () => void;
}) {
  const { colors } = useTheme();
  const text = entryRowText(entry);

  const row = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={text.label}
      accessibilityActions={onDelete ? deleteAccessibilityActions(text.name) : undefined}
      onAccessibilityAction={
        onDelete
          ? (event) => {
              if (isDeleteAction(event.nativeEvent.actionName)) onDelete();
            }
          : undefined
      }
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: colors.border, backgroundColor: pressed ? colors.surfaceAlt : colors.background },
      ]}>
      <View style={styles.nameCell}>
        <AppText numberOfLines={2} style={styles.name}>
          {text.name}
        </AppText>
        <AppText variant="small" muted numberOfLines={1}>
          {text.serving}
        </AppText>
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

  return onDelete ? (
    <SwipeToDelete label={deleteLabel(text.name)} onDelete={onDelete}>
      {row}
    </SwipeToDelete>
  ) : (
    row
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  nameCell: { flex: 1, gap: 1 },
  name: { fontSize: 15, fontWeight: '700' },
  kcalCell: { alignItems: 'flex-end', minWidth: 44, flexShrink: 0 },
  kcal: { fontSize: 15, fontWeight: '600' },
  kcalUnit: { fontSize: 11, lineHeight: 14 },
});
