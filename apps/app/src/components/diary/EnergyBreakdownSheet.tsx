import type { EnergyBreakdown } from '@cal/core';
import { StyleSheet, View } from 'react-native';

import { formatInt, formatKcal } from '@/components/settings/format';
import { Divider, KeyValueRow } from '@/components/settings/rows';
import { AppText } from '@/components/ui';
import { spacing } from '@/theme';

import { energyBreakdownRows, energyModeSummary } from './energy-view';
import { Sheet } from './Sheet';

/**
 * The parts of the day's expenditure (BMR, adjusted baseline activity, tracker activity, exercise, thermic effect of
 * food) that add up to the Expenditure ring, plus how they relate to the energy target.
 */
export function EnergyBreakdownSheet({
  visible,
  onClose,
  breakdown,
  hasDevice,
  target,
}: {
  visible: boolean;
  onClose: () => void;
  breakdown: EnergyBreakdown;
  hasDevice: boolean;
  /** Plan target (kcal) the day's budget starts from. */
  target?: number;
}) {
  const rows = energyBreakdownRows(breakdown, { hasDevice });
  return (
    <Sheet visible={visible} onClose={onClose} title="Energy expenditure">
      <View style={styles.rows}>
        {rows.map((row) => (
          <KeyValueRow key={row.key} label={row.label} hint={row.hint} value={formatKcal(row.kcal)} />
        ))}
        <Divider />
        <KeyValueRow label="Total expenditure" value={formatKcal(breakdown.total)} strong />
      </View>
      {target !== undefined ? (
        <AppText variant="small" muted>
          {`Energy target ${formatInt(target)} kcal + ${formatInt(breakdown.aboveBaseline)} kcal burned above your baseline = ${formatInt(target + breakdown.aboveBaseline)} kcal budget (thermic effect of food is not added to the budget).`}
        </AppText>
      ) : null}
      <AppText variant="small" muted>
        {energyModeSummary(breakdown.mode)}
      </AppText>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  rows: { gap: spacing.xs },
});
