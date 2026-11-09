import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import {
  NUTRIENT_GROUPS,
  NUTRIENTS,
  completeness as computeCompleteness,
  deriveNutrients,
  type CarbBasis,
  type NutrientCode,
  type NutrientGroup,
  type NutrientMap,
  type Target,
  type Targets,
} from '@cal/core';

import { radius, spacing, useTheme } from '@/theme';

import { AppText, Card } from '../ui';
import { UNIT_LABEL, formatAmount } from './format';

/** Nutrients drawn indented under their parent (fiber under carbs, saturated under fat ...). */
const SUB_NUTRIENTS: ReadonlySet<NutrientCode> = new Set<NutrientCode>([
  'FIBER_G',
  'SOLUBLE_FIBER_G',
  'INSOLUBLE_FIBER_G',
  'STARCH_G',
  'SUGARS_G',
  'ADDED_SUGARS_G',
  'SATURATED_FAT_G',
  'MONOUNSATURATED_FAT_G',
  'POLYUNSATURATED_FAT_G',
  'TRANS_FAT_G',
]);

export type TargetStatus = 'below' | 'in_range' | 'above';

/** Where an amount sits relative to a daily target: below min (grey), within range (green), above max (red). */
export function targetStatus(value: number, target: Target): TargetStatus {
  if (target.max !== undefined && value > target.max) return 'above';
  if (target.min !== undefined && value < target.min) return 'below';
  return 'in_range';
}

function targetReference(target: Target): number | undefined {
  const ref = target.min ?? target.max;
  return ref !== undefined && ref > 0 ? ref : undefined;
}

function isKnown(v: number | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

const NON_COMPUTED_TOTAL = NUTRIENTS.filter((n) => !n.computed).length;

interface NutrientPanelProps {
  /** Amounts for the serving being shown (already scaled, catalog units). Missing key = unknown. */
  amounts: NutrientMap;
  /** How CARBS_G of the food is defined; used for net carbs. Default includes_fiber. */
  carbBasis?: CarbBasis;
  /** Daily targets by nutrient; rows with a target get a %-of-target bar. */
  targets?: Targets;
  /** Show every nutrient, even those without data, on first render. */
  initialShowAll?: boolean;
  /** Hide the "data completeness" note. */
  hideCompleteness?: boolean;
}

/**
 * Nutrient panel grouped like Cronometer (General, Carbohydrates, Lipids, Protein, Vitamins,
 * Minerals): amount + unit, optional %-of-daily-target bar, "-" for unknown values (never 0).
 */
export function NutrientPanel({
  amounts,
  carbBasis = 'includes_fiber',
  targets,
  initialShowAll = false,
  hideCompleteness = false,
}: NutrientPanelProps) {
  const { colors } = useTheme();
  const [showAll, setShowAll] = useState(initialShowAll);
  const [collapsed, setCollapsed] = useState<Partial<Record<NutrientGroup, boolean>>>({});

  const derived = deriveNutrients(amounts, { carbBasis });
  const knownCount = NUTRIENTS.filter((n) => !n.computed && isKnown(amounts[n.code])).length;
  const frac = computeCompleteness(amounts);

  const groups = NUTRIENT_GROUPS.map((g) => {
    const all = NUTRIENTS.filter((n) => n.group === g.code);
    const rows = all.filter((n) => {
      const shown = isKnown(derived[n.code]) || targets?.[n.code] !== undefined;
      return shown || showAll;
    });
    const known = all.filter((n) => isKnown(derived[n.code])).length;
    // Rows hidden because they have no data (only when "show all" is off).
    const hidden = showAll ? 0 : all.length - rows.length;
    return { ...g, rows, known, hidden, total: all.length };
  });
  const hiddenCount = groups.reduce((sum, g) => sum + g.hidden, 0);

  return (
    <View style={styles.panel}>
      {!hideCompleteness ? (
        <AppText variant="small" muted>
          Data completeness: {knownCount} of {NON_COMPUTED_TOTAL} nutrients have values ({Math.round(frac * 100)}%).
          A dash means the amount is unknown, not zero.
        </AppText>
      ) : null}
      {groups.map((g) => {
        if (g.rows.length === 0) return null;
        const isCollapsed = collapsed[g.code] === true;
        return (
          <Card key={g.code} style={styles.groupCard}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${g.label}, ${g.known} of ${g.total} nutrients known. ${isCollapsed ? 'Expand' : 'Collapse'}`}
              accessibilityState={{ expanded: !isCollapsed }}
              onPress={() => setCollapsed((c) => ({ ...c, [g.code]: !isCollapsed }))}
              style={styles.groupHeader}>
              <AppText variant="heading">{g.label}</AppText>
              <AppText variant="small" muted>
                {g.known}/{g.total} {isCollapsed ? '\u25B8' : '\u25BE'}
              </AppText>
            </Pressable>
            {!isCollapsed
              ? g.rows.map((n) => (
                  <NutrientRow
                    key={n.code}
                    name={n.shortName && SUB_NUTRIENTS.has(n.code) ? n.shortName : n.name}
                    unit={n.unit}
                    value={derived[n.code]}
                    target={targets?.[n.code]}
                    indented={SUB_NUTRIENTS.has(n.code)}
                    computed={n.computed === true}
                    barTrack={colors.track}
                  />
                ))
              : null}
          </Card>
        );
      })}
      {hiddenCount > 0 || showAll ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setShowAll((v) => !v)}
          style={[styles.toggle, { borderColor: colors.border }]}>
          <AppText variant="small" style={{ fontWeight: '700', color: colors.accent }}>
            {showAll ? 'Hide nutrients without data' : `Show ${hiddenCount} nutrients without data`}
          </AppText>
        </Pressable>
      ) : null}
      <AppText variant="small" muted>
        Net carbs and omega-3 / omega-6 totals are calculated from other nutrients.
      </AppText>
    </View>
  );
}

function NutrientRow({
  name,
  unit,
  value,
  target,
  indented,
  computed,
  barTrack,
}: {
  name: string;
  unit: (typeof NUTRIENTS)[number]['unit'];
  value: number | undefined;
  target: Target | undefined;
  indented: boolean;
  computed: boolean;
  barTrack: string;
}) {
  const { colors } = useTheme();
  const known = isKnown(value);
  const ref = target ? targetReference(target) : undefined;
  const pct = known && ref !== undefined ? (value / ref) * 100 : null;
  const status = known && target ? targetStatus(value, target) : null;
  const barColor =
    status === 'above' ? colors.danger : status === 'in_range' ? colors.success : colors.textMuted;
  const valueText = known ? `${formatAmount(value, unit)} ${UNIT_LABEL[unit]}` : '-';
  const pctText = pct === null ? null : pct > 999 ? '999%+' : `${Math.round(pct)}%`;

  const a11y = known
    ? `${name}${computed ? ' (calculated)' : ''}: ${valueText}${pctText ? `, ${pctText} of daily ${target?.min === undefined ? 'limit' : 'target'}` : ''}`
    : `${name}: no data`;

  return (
    <View accessible accessibilityLabel={a11y} style={[styles.row, indented && styles.indented]}>
      <View style={styles.rowTop}>
        <AppText variant="body" muted={indented} style={[styles.rowName, indented && { fontSize: 14 }]}>
          {name}
        </AppText>
        <AppText variant="body" muted={!known} style={styles.rowValue}>
          {valueText}
        </AppText>
      </View>
      {target && ref !== undefined ? (
        <View style={styles.barRow}>
          <View style={[styles.bar, { backgroundColor: barTrack }]}>
            {pct !== null ? (
              <View
                style={[styles.barFill, { width: `${Math.min(100, Math.max(0, pct))}%`, backgroundColor: barColor }]}
              />
            ) : null}
          </View>
          <AppText variant="small" muted style={styles.pct}>
            {pctText ?? '-'}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: spacing.md },
  groupCard: { gap: spacing.sm, paddingVertical: spacing.md },
  groupHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 32,
  },
  row: { gap: 4, paddingVertical: 2 },
  indented: { paddingLeft: spacing.lg },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: spacing.md },
  rowName: { flex: 1, fontSize: 15 },
  rowValue: { fontWeight: '700', fontSize: 15, textAlign: 'right' },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  bar: { flex: 1, height: 4, borderRadius: 2, overflow: 'hidden' },
  barFill: { height: 4, borderRadius: 2 },
  pct: { width: 48, textAlign: 'right' },
  toggle: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.pill,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
});
