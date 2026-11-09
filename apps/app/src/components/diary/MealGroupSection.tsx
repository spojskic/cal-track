import { Pressable, StyleSheet, View } from 'react-native';

import { formatNumber } from '@/components/charts/format';
import { AppText } from '@/components/ui';
import { SavedMealControls } from '@/components/recipes/SavedMealControls';
import type { DiaryEntry } from '@/data/diary';
import { radius, spacing, useTheme } from '@/theme';

import { EntryRow } from './EntryRow';
import { IconButton } from './IconButton';

/** One meal group: header (name, kcal, + and ... buttons) and its entries. Collapsible. */
export function MealGroupSection({
  name,
  kcal,
  entries,
  mealGroupId,
  collapsed,
  onToggle,
  onAdd,
  onMenu,
  onEntryPress,
  onEntryLongPress,
}: {
  name: string;
  kcal: number;
  entries: DiaryEntry[];
  /** Optional: id of this meal group (for "Add saved meal"). Derived from the entries or the name when omitted. */
  mealGroupId?: string;
  collapsed: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  onMenu?: () => void;
  onEntryPress: (entry: DiaryEntry) => void;
  onEntryLongPress?: (entry: DiaryEntry) => void;
}) {
  const { colors } = useTheme();
  const count = entries.length;

  return (
    <View style={[styles.group, { borderColor: colors.border }]}>
      <View style={[styles.header, { backgroundColor: colors.surfaceAlt }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: !collapsed }}
          accessibilityLabel={`${name}, ${formatNumber(kcal)} kilocalories, ${count} ${count === 1 ? 'item' : 'items'}. ${
            collapsed ? 'Expand' : 'Collapse'
          }`}
          onPress={onToggle}
          style={styles.titleArea}>
          <AppText style={[styles.chevron, { color: colors.textMuted }]}>{collapsed ? '▸' : '▾'}</AppText>
          <AppText style={styles.title} numberOfLines={1}>
            {name}
          </AppText>
          <AppText muted style={styles.kcal}>
            {formatNumber(kcal)} kcal
          </AppText>
        </Pressable>
        <SavedMealControls name={name} groupId={mealGroupId} entries={entries} />
        {onAdd ? <IconButton glyph="+" label={`Add food to ${name}`} onPress={onAdd} size={34} /> : null}
        {onMenu ? <IconButton glyph="⋯" label={`${name} options`} onPress={onMenu} size={34} /> : null}
      </View>
      {!collapsed ? (
        <View style={styles.entries}>
          {count === 0 ? (
            <AppText variant="small" muted style={styles.empty}>
              Nothing logged yet
            </AppText>
          ) : (
            entries.map((entry, i) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                last={i === count - 1}
                onPress={() => onEntryPress(entry)}
                onLongPress={onEntryLongPress ? () => onEntryLongPress(entry) : undefined}
              />
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', paddingLeft: spacing.md, paddingRight: spacing.xs, minHeight: 46 },
  titleArea: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 46 },
  chevron: { width: 14, fontSize: 14 },
  title: { fontWeight: '700', flexShrink: 1 },
  kcal: { marginLeft: 'auto', fontSize: 14, paddingRight: spacing.xs },
  entries: { paddingHorizontal: spacing.sm },
  empty: { paddingVertical: spacing.md, paddingHorizontal: spacing.xs },
});
