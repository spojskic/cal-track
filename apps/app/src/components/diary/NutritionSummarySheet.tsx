import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import { formatAmount } from '@/components/charts/format';
import { AppText } from '@/components/ui';
import type { DiaryEntry } from '@/data/diary';
import { radius, spacing, useTheme } from '@/theme';

import { buildGroupSummary } from './group-summary';
import { Sheet } from './Sheet';

/** "Show Nutrition Summary": the totals of one meal group (energy, macros and the main micronutrients). */
export function NutritionSummarySheet({
  visible,
  name,
  entries,
  netCarbs,
  onClose,
}: {
  visible: boolean;
  name: string;
  entries: readonly DiaryEntry[];
  netCarbs: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={`${name} nutrition summary`}
      subtitle={`${entries.length} ${entries.length === 1 ? 'food' : 'foods'}`}>
      {visible ? <SummaryBody entries={entries} netCarbs={netCarbs} /> : null}
    </Sheet>
  );
}

function SummaryBody({ entries, netCarbs }: { entries: readonly DiaryEntry[]; netCarbs: boolean }) {
  const { colors } = useTheme();
  const summary = useMemo(() => buildGroupSummary(entries, netCarbs), [entries, netCarbs]);
  const incompleteAny = summary.incompleteNutrients.length > 0;

  return (
    <>
      <View style={[styles.headline, { backgroundColor: colors.surfaceAlt }]}>
        {summary.headline.map((s) => {
          const text = formatAmount(s.amount, s.unit);
          return (
            <View
              key={s.key}
              style={styles.stat}
              accessible
              accessibilityLabel={`${s.label} ${s.amount === undefined ? 'unknown' : `${text}${s.incomplete ? ', at least' : ''}`}`}>
              <AppText variant="small" muted>
                {s.label}
              </AppText>
              <AppText style={{ fontWeight: '700' }}>{`${text}${s.incomplete && s.amount !== undefined ? '*' : ''}`}</AppText>
            </View>
          );
        })}
      </View>

      {summary.sections.map((section) => (
        <View key={section.key} style={styles.section}>
          <AppText variant="label" muted accessibilityRole="header">
            {section.label}
          </AppText>
          {section.rows.map((row) => {
            const value = formatAmount(row.amount, row.unit);
            return (
              <View
                key={row.code}
                style={[styles.row, { borderBottomColor: colors.border }]}
                accessible
                accessibilityLabel={`${row.name} ${value}${row.incomplete ? ', at least' : ''}`}>
                <AppText style={styles.rowName}>{row.name}</AppText>
                <AppText style={{ fontWeight: '600' }}>{`${value}${row.incomplete ? '*' : ''}`}</AppText>
              </View>
            );
          })}
        </View>
      ))}

      {incompleteAny ? (
        <AppText variant="small" muted>
          * Not every food in this meal has data for this nutrient, so the amount can be higher.
        </AppText>
      ) : null}
      {entries.length === 0 ? <AppText muted>Nothing is logged in this meal yet.</AppText> : null}
    </>
  );
}

const styles = StyleSheet.create({
  headline: { flexDirection: 'row', justifyContent: 'space-between', padding: spacing.md, borderRadius: radius.md },
  stat: { alignItems: 'center', gap: 2, flex: 1 },
  section: { gap: spacing.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    minHeight: 36,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowName: { flex: 1 },
});
