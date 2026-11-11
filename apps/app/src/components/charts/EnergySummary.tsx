import { energySummaryCaption, type EnergyBreakdown, type EnergySummaryMode } from '@ration/core';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { EnergyBreakdownSheet } from '@/components/diary/EnergyBreakdownSheet';
import { AppText } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

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
  /** What the energy burned above the baseline adds to today's budget (kcal of food) in the Target view. */
  aboveBaseline?: number;
  /** The TEF share the target allows for (0.1 = 10%), for the budget explanation. */
  tefPct?: number;
  /**
   * The third circle's value for `summaryMode`: Target = (target + aboveBaseline) - consumed (negative = Over),
   * Balance = expenditure - consumed (negative = Surplus). Derived from the other props when omitted.
   */
  remaining?: number;
  /** What the third circle shows (default Target). */
  summaryMode?: EnergySummaryMode;
  /** Makes the label under the third circle a button that switches between Target and Balance. */
  onToggleSummaryMode?: () => void;
  /** Parts of the expenditure; makes the Expenditure circle open the breakdown. */
  breakdown?: EnergyBreakdown;
  /** A watch / health app supplies tracker activity (the breakdown lists it). */
  hasDevice?: boolean;
  /** Calorie split by macro for the Target / Consumed toggle. */
  split?: { target?: MacroKcal; consumed?: MacroKcal };
  compact?: boolean;
  animated?: boolean;
}

type SplitView = 'target' | 'consumed';

/**
 * Three donuts (Consumed / Expenditure / third circle) and an optional target-vs-consumed macro split. The third
 * circle is Remaining or Over (Target view) or Deficit or Surplus (Balance view); its label switches the view.
 */
export function EnergySummary({
  consumed,
  expenditure,
  target,
  aboveBaseline = 0,
  tefPct = 0,
  remaining,
  summaryMode = 'target',
  onToggleSummaryMode,
  breakdown,
  hasDevice = false,
  split,
  compact = false,
  animated = true,
}: EnergySummaryProps) {
  const { colors, radius, shape } = useTheme();
  const [view, setView] = useState<SplitView>('consumed');
  const [showBreakdown, setShowBreakdown] = useState(false);
  const size = compact ? 76 : 100;
  const balance = summaryMode === 'balance';

  const budget = target === undefined ? undefined : target + aboveBaseline;
  const left =
    remaining ??
    (balance
      ? expenditure === undefined
        ? undefined
        : expenditure - consumed
      : budget === undefined
        ? undefined
        : budget - consumed);
  const negative = left !== undefined && left < 0; // Over (Target) / Surplus (Balance)
  const thirdCaption = energySummaryCaption(summaryMode, left);

  // Consumed is drawn against the budget (Target) or against what was burned (Balance).
  const scale = balance ? expenditure : budget;
  const consumedFraction = scale && scale > 0 ? consumed / scale : 0;
  const leftFraction = scale && scale > 0 && left !== undefined ? Math.abs(left) / scale : 0;

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
      caption: thirdCaption,
      label: left === undefined ? '-' : formatNumber(Math.abs(left)),
      fraction: negative && !balance ? 1 : leftFraction,
      color: balance ? (negative ? colors.warning : colors.success) : negative ? colors.danger : colors.success,
      overColor: undefined,
    },
  ];

  const activeSplit = view === 'target' ? split?.target : split?.consumed;

  const ringView = (ring: (typeof rings)[number]) => (
    <ProgressRing
      value={ring.fraction}
      size={size}
      color={ring.color}
      overColor={ring.overColor}
      label={ring.label}
      sublabel="kcal"
      animated={animated}
    />
  );
  const ringLabel = (ring: (typeof rings)[number]) =>
    `${ring.caption} ${ring.label === '-' ? 'unknown' : `${ring.label} kilocalories`}`;

  return (
    <View style={styles.wrap}>
      <View style={styles.rings}>
        {rings.map((ring) => {
          if (ring.key === 'expenditure' && breakdown) {
            return (
              <Pressable
                key={ring.key}
                accessibilityRole="button"
                accessibilityLabel={`${ringLabel(ring)}, show how it adds up`}
                onPress={() => setShowBreakdown(true)}
                style={[styles.ringCell, { minWidth: size }]}>
                {ringView(ring)}
                <AppText variant="small" muted style={[styles.caption, styles.link]}>
                  {ring.caption}
                </AppText>
              </Pressable>
            );
          }
          if (ring.key === 'left' && onToggleSummaryMode) {
            return (
              <View key={ring.key} style={[styles.ringCell, { minWidth: size }]}>
                <View accessible accessibilityLabel={ringLabel(ring)}>
                  {ringView(ring)}
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Switch between Target and Balance"
                  hitSlop={8}
                  onPress={onToggleSummaryMode}>
                  <AppText variant="small" muted style={[styles.caption, styles.link]}>
                    {ring.caption}
                  </AppText>
                </Pressable>
              </View>
            );
          }
          return (
            <View key={ring.key} accessible accessibilityLabel={ringLabel(ring)} style={[styles.ringCell, { minWidth: size }]}>
              {ringView(ring)}
              <AppText variant="small" muted style={styles.caption}>
                {ring.caption}
              </AppText>
            </View>
          );
        })}
      </View>

      {balance ? (
        expenditure !== undefined ? (
          <AppText variant="small" muted style={styles.center}>
            Expenditure {formatNumber(expenditure)} kcal - Consumed {formatNumber(consumed)} kcal
          </AppText>
        ) : null
      ) : target !== undefined ? (
        <AppText variant="small" muted style={styles.center}>
          Target {formatNumber(target)} kcal
          {aboveBaseline >= 0.5 ? ` + ${formatNumber(aboveBaseline)} for activity = ${formatNumber(budget)} kcal` : ''}
        </AppText>
      ) : null}

      {breakdown ? (
        <EnergyBreakdownSheet
          visible={showBreakdown}
          onClose={() => setShowBreakdown(false)}
          breakdown={breakdown}
          hasDevice={hasDevice}
          target={target}
          budgetExtra={aboveBaseline}
          tefPct={tefPct}
        />
      ) : null}

      {!compact && split ? (
        <View style={styles.splitSection}>
          <View style={styles.splitHeader}>
            <AppText variant="label" muted>
              Macro split
            </AppText>
            <View style={[styles.toggle, { backgroundColor: colors.surfaceAlt, borderColor: colors.border, borderRadius: radius.pill }]}>
              {(['target', 'consumed'] as const).map((opt) => {
                const selected = opt === view;
                return (
                  <Pressable
                    key={opt}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`Show ${opt} macro split`}
                    onPress={() => setView(opt)}
                    style={[
                      styles.toggleOption,
                      { borderRadius: shape.inner(radius.pill, TOGGLE_PADDING) },
                      selected && { backgroundColor: colors.primary },
                    ]}>
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

/** Inner space of the TARGET / CONSUMED toggle: its options sit this far inside the outer border. */
const TOGGLE_PADDING = 2;

const styles = StyleSheet.create({
  wrap: { gap: spacing.md },
  rings: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'flex-start', gap: spacing.sm },
  ringCell: { alignItems: 'center', gap: spacing.xs + 2, flexShrink: 1 },
  caption: { textAlign: 'center' },
  link: { textDecorationLine: 'underline' },
  center: { textAlign: 'center' },
  splitSection: { gap: spacing.sm },
  splitHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  toggle: { flexDirection: 'row', borderWidth: StyleSheet.hairlineWidth, padding: TOGGLE_PADDING, gap: TOGGLE_PADDING },
  toggleOption: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 1 },
});
