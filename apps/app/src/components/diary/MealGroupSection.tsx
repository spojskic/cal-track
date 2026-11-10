import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { formatNumber } from '@/components/charts/format';
import { AppText } from '@/components/ui';
import type { DiaryEntry } from '@/data/diary';
import { spacing, useTheme } from '@/theme';

import { EntryRow } from './EntryRow';
import { IconButton } from './IconButton';

/**
 * One meal group as a flat section: a header bar (collapse chevron, name, kcal underneath, ONE "+" and ONE "...")
 * and its entries as full-width rows. Everything else (copy, paste, sort, saved meals, ...) is in the "..." menu.
 */
export function MealGroupSection({
  name,
  kcal,
  entries,
  collapsed,
  onToggle,
  onAdd,
  onMenu,
  onEntryPress,
  onEntryLongPress,
  onEntryDelete,
}: {
  name: string;
  kcal: number;
  entries: DiaryEntry[];
  collapsed: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  onMenu?: () => void;
  onEntryPress: (entry: DiaryEntry) => void;
  onEntryLongPress?: (entry: DiaryEntry) => void;
  /** Swipe left / screen reader action: delete the entry (the caller shows the Undo toast). */
  onEntryDelete?: (entry: DiaryEntry) => void;
}) {
  const { colors } = useTheme();
  const count = entries.length;

  return (
    <View>
      <View style={[styles.header, { backgroundColor: colors.surfaceAlt }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: !collapsed }}
          accessibilityLabel={`${name}, ${formatNumber(kcal)} kilocalories, ${count} ${count === 1 ? 'item' : 'items'}. ${
            collapsed ? 'Expand' : 'Collapse'
          }`}
          onPress={onToggle}
          style={styles.titleArea}>
          <View style={styles.chevron}>
            <SymbolView
              name={{ ios: collapsed ? 'chevron.right' : 'chevron.down', android: collapsed ? 'chevron_right' : 'expand_more' }}
              size={14}
              tintColor={colors.textMuted}
              fallback={<Text style={[styles.chevronGlyph, { color: colors.textMuted }]}>{collapsed ? '\u25B8' : '\u25BE'}</Text>}
            />
          </View>
          <View style={styles.titleText}>
            <AppText style={styles.title} numberOfLines={1}>
              {name}
            </AppText>
            <AppText muted style={styles.kcal} numberOfLines={1}>
              {formatNumber(kcal)} kcal
            </AppText>
          </View>
        </Pressable>
        {onAdd ? <IconButton glyph="+" label={`Add food to ${name}`} onPress={onAdd} size={36} /> : null}
        {onMenu ? <IconButton glyph={'\u22EF'} label={`${name} options`} onPress={onMenu} size={36} /> : null}
      </View>
      {!collapsed ? (
        count === 0 ? (
          <AppText variant="small" muted style={[styles.empty, { borderBottomColor: colors.border }]}>
            Nothing logged yet
          </AppText>
        ) : (
          entries.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              onPress={() => onEntryPress(entry)}
              onLongPress={onEntryLongPress ? () => onEntryLongPress(entry) : undefined}
              onDelete={onEntryDelete ? () => onEntryDelete(entry) : undefined}
            />
          ))
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingLeft: spacing.lg, paddingRight: spacing.sm, minHeight: 52 },
  titleArea: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 52 },
  chevron: { width: 16, alignItems: 'center', justifyContent: 'center' },
  chevronGlyph: { fontSize: 14 },
  titleText: { flex: 1, gap: 1 },
  title: { fontSize: 16, fontWeight: '700' },
  kcal: { fontSize: 12, lineHeight: 15 },
  empty: { paddingVertical: spacing.sm + 2, paddingHorizontal: spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth },
});
