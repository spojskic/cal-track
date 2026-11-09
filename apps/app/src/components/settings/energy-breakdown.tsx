import type { MacroTargets, ResolvedTargetsCore, UnitSystem } from '@cal/core';
import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

import { formatAmount, formatInt, formatKcal, formatPct, formatSigned } from './format';
import { describeRate } from './goal-draft';
import { Divider, KeyValueRow } from './rows';
import { activityBoost, activityLabel, bmrFormulaLabel } from './options';

/**
 * The Cronometer-style "Target breakdown" table:
 * BMR + baseline activity = baseline expenditure, then the weight goal adjustment gives the energy target.
 */
export function EnergyBreakdownTable({
  result,
  unitSystem,
}: {
  result: ResolvedTargetsCore;
  unitSystem: UnitSystem;
}) {
  const { colors } = useTheme();
  const { energy } = result;
  return (
    <View style={{ gap: spacing.xs }}>
      <KeyValueRow
        label="Basal Metabolic Rate (BMR)"
        hint={bmrFormulaLabel(result.bmrFormula)}
        value={formatKcal(result.bmr)}
      />
      <KeyValueRow
        label="Baseline Activity Level"
        hint={`${activityLabel(result.activityLevel)} (${activityBoost(result.activityLevel)})`}
        value={formatSigned(result.baselineActivityKcal)}
      />
      <Divider />
      <KeyValueRow label="Baseline Expenditure" hint="BMR + baseline activity" value={formatKcal(energy.maintenance)} strong />
      <KeyValueRow
        label="Weight Goal Adjustment"
        hint={describeRate(result.rateKgPerWeek, unitSystem)}
        value={formatSigned(energy.delta)}
      />
      {energy.flooredBy > 0 ? (
        <KeyValueRow
          label="Raised to minimum"
          hint={`Targets never go below ${formatKcal(energy.floor)}`}
          value={formatSigned(energy.flooredBy)}
          valueColor={colors.warning}
        />
      ) : null}
      <Divider />
      <KeyValueRow label="Energy Target" value={formatKcal(energy.target)} strong />
      <AppText variant="small" muted style={{ marginTop: spacing.xs }}>
        Expenditure above baseline: + when logged. Exercise you log (and device activity, if enabled) adds to your
        budget on top of this target.
      </AppText>
    </View>
  );
}

/** Protein / carbs / fat in grams, kcal and share of energy. */
export function MacroSummaryTable({ macros, carbsLabel }: { macros: MacroTargets; carbsLabel: string }) {
  const { colors } = useTheme();
  const rows = [
    { label: 'Protein', color: colors.protein, amount: macros.protein },
    { label: carbsLabel, color: colors.carbs, amount: macros.carbs },
    { label: 'Fat', color: colors.fat, amount: macros.fat },
  ];
  return (
    <View style={{ gap: spacing.sm }}>
      {rows.map((row) => (
        <View
          key={row.label}
          style={styles.macroRow}
          accessible
          accessibilityLabel={`${row.label}: ${formatAmount(row.amount.grams)} grams, ${formatInt(row.amount.kcal)} kilocalories, ${formatPct(row.amount.pct)} percent`}>
          <View style={[styles.swatch, { backgroundColor: row.color }]} />
          <AppText variant="body" style={styles.macroName}>{row.label}</AppText>
          <AppText variant="body" style={styles.bold}>{formatAmount(row.amount.grams)} g</AppText>
          <AppText variant="small" muted style={styles.macroMeta}>
            {formatInt(row.amount.kcal)} kcal {'\u00B7'} {formatPct(row.amount.pct)}%
          </AppText>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  macroRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  swatch: { width: 10, height: 10, borderRadius: 5 },
  macroName: { flex: 1 },
  macroMeta: { minWidth: 110, textAlign: 'right' },
  bold: { fontWeight: '700' },
});
