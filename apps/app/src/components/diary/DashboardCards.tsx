import { Pressable, StyleSheet, View } from 'react-native';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { formatWeight, type UnitSystem } from '@cal/core';

import { MiniBarChart, type MiniBar } from '@/components/charts/MiniBarChart';
import { Sparkline } from '@/components/charts/Sparkline';
import { formatNumber } from '@/components/charts/format';
import { Segmented } from '@/components/forms';
import { AppText, Button, Card } from '@/components/ui';
import { averageOfDays, type RecentDay } from '@/data/diary';
import type { WeightPoint } from '@/data/weight';
import { radius, spacing, useTheme } from '@/theme';

import { weekdayInitial } from './dates';
import { haptic } from './haptics';
import { go } from './nav';

// ------------------------------------------------------------------------------------------------ quick add

interface QuickItem {
  key: string;
  label: string;
  href: string;
  symbol: SymbolViewProps['name'];
}

const QUICK_ITEMS: QuickItem[] = [
  { key: 'food', label: 'Food', href: '/search', symbol: { ios: 'fork.knife', android: 'restaurant', web: 'restaurant' } },
  { key: 'exercise', label: 'Exercise', href: '/exercise/new', symbol: { ios: 'figure.run', android: 'directions_run', web: 'directions_run' } },
  { key: 'biometric', label: 'Biometric', href: '/biometric/new', symbol: { ios: 'waveform.path.ecg', android: 'monitor_heart', web: 'monitor_heart' } },
  { key: 'note', label: 'Note', href: '/note/new', symbol: { ios: 'note.text', android: 'sticky_note_2', web: 'sticky_note_2' } },
];

/** Food / Exercise / Biometric / Note shortcuts. */
export function QuickAddRow() {
  const { colors } = useTheme();
  return (
    <View style={styles.quickRow} accessibilityRole="toolbar" accessibilityLabel="Quick add">
      {QUICK_ITEMS.map((item) => (
        <Pressable
          key={item.key}
          accessibilityRole="button"
          accessibilityLabel={`Add ${item.label.toLowerCase()}`}
          onPress={() => {
            haptic('light');
            go(item.href);
          }}
          style={({ pressed }) => [
            styles.quick,
            { backgroundColor: pressed ? colors.surfaceAlt : colors.surface, borderColor: colors.border },
          ]}>
          <SymbolView name={item.symbol} size={24} tintColor={colors.primary} />
          <AppText variant="small" style={{ fontWeight: '700' }}>
            {item.label}
          </AppText>
        </Pressable>
      ))}
    </View>
  );
}

// ------------------------------------------------------------------------------------------------ averages

type Range = '7' | '14' | '30';

/** Average kcal and macro split over the last 7 / 14 / 30 days (logged days only). */
export function AverageCard({
  days,
  range,
  onRangeChange,
  targetKcal,
  loading,
}: {
  days: readonly RecentDay[];
  range: Range;
  onRangeChange: (range: Range) => void;
  targetKcal?: number;
  loading?: boolean;
}) {
  const { colors } = useTheme();
  const n = Number(range);
  const avg = averageOfDays(days, n);
  const window = days.slice(Math.max(0, days.length - n));
  const bars: MiniBar[] = window.map((d) => ({
    key: d.date,
    value: d.kcal,
    label: n <= 14 ? weekdayInitial(d.date) : '',
    empty: !d.logged,
  }));
  const macros = [
    { key: 'protein', label: 'Protein', g: avg.proteinG, pct: avg.proteinPct, color: colors.protein },
    { key: 'carbs', label: 'Carbs', g: avg.carbsG, pct: avg.carbsPct, color: colors.carbs },
    { key: 'fat', label: 'Fat', g: avg.fatG, pct: avg.fatPct, color: colors.fat },
  ];

  return (
    <Card>
      <AppText variant="label" muted>
        Consumed average
      </AppText>
      <Segmented<Range>
        options={[
          { value: '7', label: '7 days' },
          { value: '14', label: '14 days' },
          { value: '30', label: '30 days' },
        ]}
        value={range}
        onChange={onRangeChange}
      />
      {loading ? (
        <AppText muted>Loading...</AppText>
      ) : avg.loggedDays === 0 ? (
        <AppText muted>Log a few meals to see your averages.</AppText>
      ) : (
        <>
          <View style={styles.bigRow}>
            <AppText style={styles.big} accessibilityLabel={`Average ${formatNumber(avg.kcal)} kilocalories per day`}>
              {formatNumber(avg.kcal)}
            </AppText>
            <AppText muted>kcal / day</AppText>
          </View>
          <AppText variant="small" muted>
            Last {n} days, {avg.loggedDays} logged
          </AppText>
          <MiniBarChart bars={bars} target={targetKcal} color={colors.energy} accessibilityLabel={`Daily energy, last ${n} days`} />
          <View style={styles.macroList}>
            {macros.map((m) => (
              <View
                key={m.key}
                accessible
                accessibilityLabel={`${m.label} ${formatNumber(m.g, 1, true)} grams, ${Math.round(m.pct)} percent of calories`}
                style={styles.macroRow}>
                <View style={[styles.dot, { backgroundColor: m.color }]} />
                <AppText style={styles.macroName}>{m.label}</AppText>
                <AppText muted>{formatNumber(m.g, 1, true)} g</AppText>
                <AppText style={styles.macroPct}>{Math.round(m.pct)}%</AppText>
              </View>
            ))}
          </View>
        </>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------ streak

/** Consecutive logging days and the last week at a glance. */
export function StreakCard({ days, streak, loading }: { days: readonly RecentDay[]; streak: number; loading?: boolean }) {
  const { colors } = useTheme();
  const week = days.slice(-7);
  const today = days[days.length - 1];
  const message = loading
    ? ''
    : streak === 0
      ? 'Log something today to start a streak.'
      : today?.logged
        ? 'Logged today. Nice work.'
        : 'Log something today to keep it going.';

  return (
    <Card>
      <AppText variant="label" muted>
        Logging streak
      </AppText>
      <View style={styles.bigRow}>
        <AppText style={styles.big} accessibilityLabel={`${streak} day streak`}>
          {loading ? '-' : streak}
        </AppText>
        <AppText muted>{streak === 1 ? 'day' : 'days'}</AppText>
      </View>
      <AppText variant="small" muted>
        {message}
      </AppText>
      <View style={styles.weekRow}>
        {week.map((d) => (
          <View
            key={d.date}
            accessible
            accessibilityLabel={`${d.date}: ${d.logged ? 'logged' : 'nothing logged'}`}
            style={styles.weekCell}>
            <View style={[styles.weekDot, { backgroundColor: d.logged ? colors.success : colors.track }]} />
            <AppText variant="small" muted>
              {weekdayInitial(d.date)}
            </AppText>
          </View>
        ))}
      </View>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------ weight

/** Weight trend of the last 30 days. */
export function WeightCard({
  points,
  changeKg,
  unitSystem,
  loading,
}: {
  points: readonly WeightPoint[];
  changeKg: number | undefined;
  unitSystem: UnitSystem;
  loading?: boolean;
}) {
  const latest = points[points.length - 1];
  const sign = changeKg === undefined || Math.abs(changeKg) < 0.05 ? '' : changeKg > 0 ? '+' : '-';

  return (
    <Card>
      <AppText variant="label" muted>
        Weight trend
      </AppText>
      {loading ? (
        <AppText muted>Loading...</AppText>
      ) : !latest ? (
        <>
          <AppText muted>No weight logged in the last 30 days.</AppText>
          <Button label="Log weight" variant="secondary" onPress={() => go('/biometric/new', { type: 'weight' })} />
        </>
      ) : (
        <>
          <View style={styles.bigRow}>
            <AppText style={styles.big}>{formatWeight(latest.kg, unitSystem)}</AppText>
            {changeKg !== undefined ? (
              <AppText muted>
                {sign}
                {formatWeight(Math.abs(changeKg), unitSystem)} in 30 days
              </AppText>
            ) : null}
          </View>
          {points.length > 1 ? (
            <Sparkline
              values={points.map((p) => p.kg)}
              accessibilityLabel={`Weight trend, latest ${formatWeight(latest.kg, unitSystem)}`}
            />
          ) : (
            <AppText variant="small" muted>
              Log another weigh-in to see a trend.
            </AppText>
          )}
          <Button label="Log weight" variant="secondary" onPress={() => go('/biometric/new', { type: 'weight' })} />
        </>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------ coach

/** Placeholder entry to the AI coach. Render only when the AI gate is enabled. */
export function CoachCard() {
  return (
    <Card>
      <AppText variant="label" muted>
        Coach
      </AppText>
      <AppText variant="heading">Ask your coach</AppText>
      <AppText muted>Get feedback on today and ideas for your next meal.</AppText>
      <Button label="Open coach" onPress={() => go('/coach')} />
    </Card>
  );
}

const styles = StyleSheet.create({
  quickRow: { flexDirection: 'row', gap: spacing.sm },
  quick: {
    flex: 1,
    minHeight: 76,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs + 2,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.md,
  },
  bigRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, flexWrap: 'wrap' },
  big: { fontSize: 34, fontWeight: '800' },
  macroList: { gap: spacing.sm },
  macroRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dot: { width: 10, height: 10, borderRadius: 5 },
  macroName: { flex: 1, fontWeight: '600' },
  macroPct: { width: 44, textAlign: 'right', fontWeight: '700' },
  weekRow: { flexDirection: 'row', justifyContent: 'space-between' },
  weekCell: { alignItems: 'center', gap: spacing.xs },
  weekDot: { width: 22, height: 22, borderRadius: 11 },
});
