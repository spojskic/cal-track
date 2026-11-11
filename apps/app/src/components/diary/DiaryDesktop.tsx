// The desktop (wide window) diary body: the entry list in one panel at the left, and Targets / Energy summary / Nutrient targets as
// panels at the right (stacked under the list on a narrow content), then the nutrient tables as a grid of panels across the width.
// Phones keep the swipeable targets pager and the cards of diary.tsx.
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { EnergySummary, type EnergySummaryProps } from '@/components/charts/EnergySummary';
import { BarList, Panel, SplitPanes, ToolbarButton } from '@/components/panel';
import { AppText } from '@/components/ui';
import type { DayNutrients } from '@/data/diary';
import type { ResolvedTargets } from '@/data/targets';
import { useTheme } from '@/theme';

import { entriesMeta, macroBarRows } from './dashboard-view';
import { go } from './nav';
import { NutrientGroupPanels, NutrientSummaryPanel } from './NutrientPanels';
import type { MacroRow } from './targets-view';
import { useNutrientModel } from './use-nutrient-model';

export function DesktopDiaryBody({
  list,
  rows,
  energyProps,
  day,
  targets,
  netCarbs,
  needsOnboarding,
}: {
  /** The tab strip and the lists of the day (diary.tsx builds them; they are the same on every layout). */
  list: ReactNode;
  rows: MacroRow[];
  energyProps: EnergySummaryProps;
  day: DayNutrients;
  targets: ResolvedTargets | undefined;
  netCarbs: boolean;
  needsOnboarding: boolean;
}) {
  const { colors } = useTheme();
  const model = useNutrientModel({
    totals: day.totals,
    hasEntries: day.hasEntries,
    incompleteNutrients: day.incompleteNutrients,
    targets,
    netCarbs,
  });

  return (
    <>
      {needsOnboarding ? (
        <Panel title="Set up your targets">
          <AppText muted variant="small">
            Answer a few questions so Ration can calculate your calorie, macro and nutrient targets. Your entries are listed below in
            the meantime.
          </AppText>
          <View style={styles.alignStart}>
            <ToolbarButton primary label="Set up targets" onPress={() => go('/onboarding')} />
          </View>
        </Panel>
      ) : null}
      <SplitPanes
        main={
          // The rows of the list are drawn in the page colour, so the panel is too.
          <Panel title="Entries" meta={entriesMeta(day.entries.length, day.kcal)} flush tone="page">
            {list}
          </Panel>
        }
        side={
          <>
            <Panel
              title="Targets"
              meta="Consumed vs target"
              action={{ label: 'Edit', accessibilityLabel: 'Open target settings', onPress: () => go('/settings/targets') }}>
              <BarList rows={macroBarRows(rows, { danger: colors.danger, success: colors.success })} />
            </Panel>
            <Panel title="Energy summary">
              <EnergySummary {...energyProps} />
            </Panel>
            <NutrientSummaryPanel model={model} />
          </>
        }
      />
      <NutrientGroupPanels model={model} incompleteNutrients={day.incompleteNutrients} />
    </>
  );
}

const styles = StyleSheet.create({
  alignStart: { alignSelf: 'flex-start' },
});
