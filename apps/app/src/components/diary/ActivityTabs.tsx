import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import type { UnitSystem } from '@cal/core';

import { AppText } from '@/components/ui';
import type { BiometricEntry, ExerciseEntry, NoteEntry } from '@/data/activity';
import { isSwipeDeletable, type ActivityKind, type ActivityRow } from '@/data/diary-activity-rules';
import { spacing, useTheme } from '@/theme';

import {
  activityRowLabel,
  biometricRowText,
  exerciseRowText,
  noteRowText,
  type ActivityRowText,
} from './activity-rows';
import { useMeasuredWidth } from './layout';
import { deleteAccessibilityActions, deleteLabel, isDeleteAction } from './swipe-delete';
import { SwipeToDelete } from './SwipeToDelete';
import { useActivityDelete } from './use-activity-delete';

export type DiaryTab = 'food' | 'exercise' | 'biometric' | 'note';

const TABS: { key: DiaryTab; label: string; compactLabel?: string }[] = [
  { key: 'food', label: 'Food' },
  { key: 'exercise', label: 'Exercise' },
  { key: 'biometric', label: 'Biometric', compactLabel: 'Body' },
  { key: 'note', label: 'Note' },
];

/** Below this tab strip width (px) the longest label ("BIOMETRIC 1") no longer fits its quarter of the strip. */
const COMPACT_STRIP_WIDTH = 420;

/**
 * FOOD / EXERCISE / BIOMETRIC / NOTE tab strip of the diary: plain labels with an underline under the selected one,
 * directly on the page background. On a narrow strip (phones) Biometric is shown as BODY so no label is truncated;
 * the accessible name keeps the full word and the count.
 */
export function DiaryTabs({
  value,
  onChange,
  counts,
}: {
  value: DiaryTab;
  onChange: (tab: DiaryTab) => void;
  counts?: Partial<Record<DiaryTab, number>>;
}) {
  const { colors } = useTheme();
  const windowWidth = useWindowDimensions().width;
  const [measured, onLayout] = useMeasuredWidth();
  // Until the strip is measured, assume it is about as wide as the window (minus the page padding).
  const compact = (measured > 0 ? measured : windowWidth - 32) < COMPACT_STRIP_WIDTH;
  return (
    <View
      onLayout={onLayout}
      style={[styles.tabs, { borderBottomColor: colors.border }]}
      accessibilityRole="tablist">
      {TABS.map((tab) => {
        const selected = tab.key === value;
        const count = counts?.[tab.key];
        const shown = compact && tab.compactLabel ? tab.compactLabel : tab.label;
        const name = compact && tab.compactLabel ? `${tab.compactLabel} (${tab.label.toLowerCase()})` : tab.label;
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={`${name}${count ? `, ${count}` : ''}`}
            onPress={() => onChange(tab.key)}
            style={[styles.tab, selected && { borderBottomColor: colors.primary }]}>
            <View style={styles.tabContent}>
              <AppText
                numberOfLines={1}
                style={{
                  fontSize: 12,
                  fontWeight: '800',
                  letterSpacing: compact ? 0.3 : 0.6,
                  color: selected ? colors.primary : colors.textMuted,
                }}>
                {shown.toUpperCase()}
              </AppText>
              {count ? (
                // A small badge, so "BODY 2" is not read as a name: the 2 is how many entries this day has in the tab.
                <View style={[styles.badge, { backgroundColor: selected ? colors.primary : colors.surfaceAlt }]}>
                  <AppText style={[styles.badgeText, { color: selected ? colors.onPrimary : colors.textMuted }]}>{count}</AppText>
                </View>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** "+ Add exercise" row at the end of a list. */
export function AddRow({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.add, { backgroundColor: pressed ? colors.surfaceAlt : 'transparent' }]}>
      <AppText style={{ color: colors.primary, fontWeight: '700' }}>+ {label}</AppText>
    </Pressable>
  );
}

/** A flat full-width row: title (bold) with a muted line under it, value (and unit) on the right. Swipe left deletes. */
function ListRow({ text, onDelete }: { text: ActivityRowText; onDelete?: (() => void) | undefined }) {
  const { colors } = useTheme();
  const row = (
    <View
      accessible
      accessibilityLabel={activityRowLabel(text)}
      accessibilityActions={onDelete ? deleteAccessibilityActions(text.deleteName) : undefined}
      onAccessibilityAction={
        onDelete
          ? (event) => {
              if (isDeleteAction(event.nativeEvent.actionName)) onDelete();
            }
          : undefined
      }
      style={[styles.row, { borderBottomColor: colors.border, backgroundColor: colors.background }]}>
      <View style={styles.rowText}>
        <AppText numberOfLines={2} style={styles.title}>
          {text.title}
        </AppText>
        {text.detail ? (
          <AppText variant="small" muted numberOfLines={1}>
            {text.detail}
          </AppText>
        ) : null}
      </View>
      {text.value ? (
        <View style={styles.valueCell}>
          <AppText numberOfLines={1} style={styles.value}>
            {text.value}
          </AppText>
          {text.unit ? (
            <AppText muted numberOfLines={1} style={styles.unit}>
              {text.unit}
            </AppText>
          ) : null}
        </View>
      ) : null}
    </View>
  );
  return onDelete ? (
    <SwipeToDelete label={deleteLabel(text.deleteName)} onDelete={onDelete}>
      {row}
    </SwipeToDelete>
  ) : (
    row
  );
}

function Empty({ text }: { text: string }) {
  return (
    <AppText muted style={styles.empty}>
      {text}
    </AppText>
  );
}

/** Rows of one kind with their delete handler (manual rows only; device rows come back with the next sync). */
function ActivityRows<T extends ActivityRow>({
  kind,
  items,
  textOf,
}: {
  kind: ActivityKind;
  items: readonly T[];
  textOf: (row: T) => ActivityRowText;
}) {
  const deleteActivity = useActivityDelete();
  return (
    <View>
      {items.map((row) => {
        const text = textOf(row);
        return (
          <ListRow
            key={row.id}
            text={text}
            onDelete={isSwipeDeletable(kind, row) ? () => void deleteActivity(kind, row, text.deleteName) : undefined}
          />
        );
      })}
    </View>
  );
}

/** All exercise of the day; burned energy shown as negative kcal. */
export function ExerciseList({ entries }: { entries: readonly ExerciseEntry[] }) {
  if (entries.length === 0) return <Empty text="No exercise logged for this day." />;
  return <ActivityRows kind="exercise" items={entries} textOf={exerciseRowText} />;
}

export function BiometricList({ entries, unitSystem }: { entries: readonly BiometricEntry[]; unitSystem: UnitSystem }) {
  if (entries.length === 0) return <Empty text="No biometrics logged for this day." />;
  return <ActivityRows kind="biometric" items={entries} textOf={(row) => biometricRowText(row, unitSystem)} />;
}

export function NotesList({ entries }: { entries: readonly NoteEntry[] }) {
  if (entries.length === 0) return <Empty text="No notes for this day." />;
  return <ActivityRows kind="note" items={entries} textOf={noteRowText} />;
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  tabContent: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  badge: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 11, fontWeight: '800', lineHeight: 14 },
  tab: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
    paddingHorizontal: 2,
  },
  add: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowText: { flex: 1, gap: 1 },
  title: { fontSize: 15, fontWeight: '700' },
  valueCell: { alignItems: 'flex-end', flexShrink: 0 },
  value: { fontSize: 15, fontWeight: '600' },
  unit: { fontSize: 11, lineHeight: 14 },
  empty: { paddingVertical: spacing.lg, paddingHorizontal: spacing.lg, textAlign: 'center' },
});
