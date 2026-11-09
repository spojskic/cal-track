import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui';
import { radius, spacing, useTheme } from '@/theme';

import { formatNumber } from './format';
import { MacroSplitBar, type MacroKcal } from './MacroSplitBar';
import { ProgressRing } from './ProgressRing';

export interface EnergySummaryProps {
  /** Energy eaten (kcal). */
  consumed: number;
  /** Total daily expenditure (kcal); undefined until targets resolve. */
  expenditure?: number;
  /** Plan target without exercise (kcal). */
  target?: number;
  /** Exercise/device energy above maintenance that widens today's budget (kcal). */
  exerciseBurned?: number;
  /** budget - consumed (kcal), negative = over. Derived from target + exerciseBurned when omitted. */
  remaining?: number;
  /** Calorie split by macro for the Target / Consumed toggle. */
  split?: { target?: MacroKcal; consumed?: MacroKcal };
  compact?: boolean;
  animated?: boolean;
}

type SplitView = 'target' | 'consumed';

/** Three donuts (Consumed / Expenditure / Remaining-or-Over) and an optional target-vs-consumed macro split. */
export function EnergySummary({
  consumed,
  expenditure,
  target,
  exerciseBurned = 0,
  remaining,
  split,
  compact = false,
  animated = true,
}: EnergySummaryProps) {
  const { colors } = useTheme();
  const [view, setView] = useState<SplitView>('consumed');
  const size = compact ? 76 : 100;

  const budget = target === undefined ? undefined : target + exerciseBurned;
  const left = remaining ?? (budget === undefined ? undefined : budget - consumed);
  const isOver = left !== undefined && left < 0;

  const consumedFraction = budget && budget > 0 ? consumed / budget : 0;
  const leftFraction = budget && budget > 0 && left !== undefined ? Math.abs(left) / budget : 0;

  const rings = [
    {
      key: 'consumed',
      caption: 'Consumed',
      label: formatNumber(consumed),
      fraction: consumedFraction,
      color: colors.energy,
      overColor: colors.danger,
    },
    {
      key: 'expenditure',
      caption: 'Expenditure',
      label: formatNumber(expenditure),
      fraction: expenditure === undefined ? 0 : 1,
      color: colors.accent,
      overColor: undefined,
    },
    {
      key: 'left',
      caption: left === undefined ? 'Remaining' : isOver ? 'Over' : 'Remaining',
      label: left === undefined ? '-' : formatNumber(Math.abs(left)),
      fraction: isOver ? 1 : leftFraction,
      color: isOver ? colors.danger : colors.success,
      overColor: undefined,
    },
  ];

  const activeSplit = view === 'target' ? split?.target : split?.consumed;

  return (
    <View style={styles.wrap}>
      <View style={styles.rings}>
        {rings.map((ring) => (
          <View
            key={ring.key}
            accessible
            accessibilityLabel={`${ring.caption} ${ring.label === '-' ? 'unknown' : `${ring.label} kilocalories`}`}
            style={styles.ringCell}>
            <ProgressRing
              value={ring.fraction}
              size={size}
              color={ring.color}
              overColor={ring.overColor}
              label={ring.label}
              sublabel="kcal"
              animated={animated}
            />
            <AppText variant="small" muted style={styles.caption}>
              {ring.caption}
            </AppText>
          </View>
        ))}
      </View>

      {target !== undefined ? (
        <AppText variant="small" muted style={styles.center}>
          Target {formatNumber(target)} kcal
          {exerciseBurned > 0 ? ` + ${formatNumber(exerciseBurned)} exercise = ${formatNumber(budget)} kcal` : ''}
        </AppText>
      ) : null}

      {!compact && split ? (
        <View style={styles.splitSection}>
          <View style={styles.splitHeader}>
            <AppText variant="label" muted>
              Macro split
            </AppText>
            <View style={[styles.toggle, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
              {(['target', 'consumed'] as const).map((opt) => {
                const selected = opt === view;
                return (
                  <Pressable
                    key={opt}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`Show ${opt} macro split`}
                    onPress={() => setView(opt)}
                    style={[styles.toggleOption, selected && { backgroundColor: colors.primary }]}>
                    <AppText
                      style={{ fontSize: 11, fontWeight: '700', letterSpacing: 0.5, color: selected ? colors.onPrimary : colors.text }}>
                      {opt.toUpperCase()}
                    </AppText>
                  </Pressable>
                );
              })}
            </View>
          </View>
          <MacroSplitBar split={activeSplit} caption={view === 'target' ? 'Target macro split' : 'Consumed macro split'} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.md },
  rings: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'flex-start', gap: spacing.sm },
  ringCell: { alignItems: 'center', gap: spacing.xs + 2, flexShrink: 1 },
  caption: { textAlign: 'center' },
  center: { textAlign: 'center' },
  splitSection: { gap: spacing.sm },
  splitHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  toggle: { flexDirection: 'row', borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, padding: 2, gap: 2 },
  toggleOption: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 1, borderRadius: radius.pill },
});
