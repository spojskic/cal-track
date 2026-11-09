import { Pressable, StyleSheet, View } from 'react-native';
import { formatWeight, type UnitSystem } from '@cal/core';

import { formatNumber } from '@/components/charts/format';
import { AppText } from '@/components/ui';
import type { BiometricEntry, ExerciseEntry, NoteEntry } from '@/data/activity';
import { radius, spacing, useTheme } from '@/theme';

import { sourceLabel } from './DevicesGroup';

export type DiaryTab = 'food' | 'exercise' | 'biometric' | 'note';

const TABS: { key: DiaryTab; label: string }[] = [
  { key: 'food', label: 'Food' },
  { key: 'exercise', label: 'Exercise' },
  { key: 'biometric', label: 'Biometric' },
  { key: 'note', label: 'Note' },
];

/** FOOD / EXERCISE / BIOMETRIC / NOTE tab strip of the diary card. */
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
  return (
    <View style={[styles.tabs, { borderBottomColor: colors.border }]} accessibilityRole="tablist">
      {TABS.map((tab) => {
        const selected = tab.key === value;
        const count = counts?.[tab.key];
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={`${tab.label}${count ? `, ${count}` : ''}`}
            onPress={() => onChange(tab.key)}
            style={[styles.tab, selected && { borderBottomColor: colors.primary }]}>
            <AppText
              numberOfLines={1}
              style={{
                fontSize: 12,
                fontWeight: '800',
                letterSpacing: 0.6,
                color: selected ? colors.primary : colors.textMuted,
              }}>
              {tab.label.toUpperCase()}
              {count ? ` ${count}` : ''}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

/** "+ Add exercise" style footer button. */
export function AddRow({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.add,
        { borderColor: colors.border, backgroundColor: pressed ? colors.surfaceAlt : 'transparent' },
      ]}>
      <AppText style={{ color: colors.primary, fontWeight: '700' }}>+ {label}</AppText>
    </Pressable>
  );
}

function ListRow({ title, detail, trailing, last }: { title: string; detail?: string; trailing?: string; last: boolean }) {
  const { colors } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${title}${detail ? `, ${detail}` : ''}${trailing ? `, ${trailing}` : ''}`}
      style={[styles.row, { borderBottomColor: colors.border }, last && styles.lastRow]}>
      <View style={styles.rowText}>
        <AppText numberOfLines={2} style={{ fontWeight: '500' }}>
          {title}
        </AppText>
        {detail ? (
          <AppText variant="small" muted numberOfLines={1}>
            {detail}
          </AppText>
        ) : null}
      </View>
      {trailing ? <AppText style={styles.trailing}>{trailing}</AppText> : null}
    </View>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <AppText muted style={styles.empty}>
      {text}
    </AppText>
  );
}

/** All exercise of the day; burned energy shown as negative kcal. */
export function ExerciseList({ entries }: { entries: readonly ExerciseEntry[] }) {
  if (entries.length === 0) return <Empty text="No exercise logged for this day." />;
  return (
    <View>
      {entries.map((e, i) => {
        const bits = [
          e.minutes ? `${formatNumber(e.minutes, 0, true)} min` : undefined,
          e.source !== 'manual' ? sourceLabel(e.source) : undefined,
          !e.counts_toward_energy ? 'not counted' : undefined,
        ].filter(Boolean);
        return (
          <ListRow
            key={e.id}
            title={e.name}
            detail={bits.join(' - ') || undefined}
            trailing={`${formatNumber(-Number(e.kcal))} kcal`}
            last={i === entries.length - 1}
          />
        );
      })}
    </View>
  );
}

const prettify = (type: string) => {
  const spaced = type.replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

function biometricValue(b: BiometricEntry, system: UnitSystem): string {
  const unit = (b.unit ?? '').toLowerCase();
  if (b.type === 'weight' && (unit === '' || unit === 'kg')) return formatWeight(Number(b.value), system);
  return `${formatNumber(Number(b.value), 1, true)}${b.unit ? ` ${b.unit}` : ''}`;
}

export function BiometricList({ entries, unitSystem }: { entries: readonly BiometricEntry[]; unitSystem: UnitSystem }) {
  if (entries.length === 0) return <Empty text="No biometrics logged for this day." />;
  return (
    <View>
      {entries.map((b, i) => (
        <ListRow
          key={b.id}
          title={prettify(b.type)}
          detail={b.source !== 'manual' ? sourceLabel(b.source) : undefined}
          trailing={biometricValue(b, unitSystem)}
          last={i === entries.length - 1}
        />
      ))}
    </View>
  );
}

export function NotesList({ entries }: { entries: readonly NoteEntry[] }) {
  if (entries.length === 0) return <Empty text="No notes for this day." />;
  return (
    <View>
      {entries.map((n, i) => (
        <ListRow key={n.id} title={n.body} last={i === entries.length - 1} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  tab: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 3,
    borderBottomColor: 'transparent',
    paddingHorizontal: 2,
  },
  add: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    borderRadius: radius.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 48,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  lastRow: { borderBottomWidth: 0 },
  rowText: { flex: 1, gap: 1 },
  trailing: { fontWeight: '700' },
  empty: { paddingVertical: spacing.lg, textAlign: 'center' },
});
