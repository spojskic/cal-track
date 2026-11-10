import { useCallback, useRef, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { useAiGate } from '@/ai/use-ai-gate';
import { EnergySummary } from '@/components/charts/EnergySummary';
import { AverageCard, CoachCard, QuickAddRow, StreakCard, WeightCard } from '@/components/diary/DashboardCards';
import { DesktopDashboard } from '@/components/diary/DashboardPanels';
import { ResponsiveGrid } from '@/components/diary/layout';
import { go } from '@/components/diary/nav';
import { energySummaryProps } from '@/components/diary/energy-view';
import { buildMacroRows, consumedSplit, targetSplit } from '@/components/diary/targets-view';
import { MacroBars } from '@/components/diary/TargetsPager';
import { AppText, Button, Card, Screen } from '@/components/ui';
import { useDayNutrients, useRecentDays } from '@/data/diary';
import { useDayEnergyFrom } from '@/data/energy';
import { useEnergySummaryMode } from '@/data/energy-mode';
import { useProfile } from '@/data/profile';
import { useTargets } from '@/data/targets';
import { useWeightHistory, type WeightPoint } from '@/data/weight';
import { todayISO } from '@/state/selected-date';
import { WIDE_BREAKPOINT, spacing, useTheme } from '@/theme';

type Range = '7' | '14' | '30';

const EMPTY_POINTS: WeightPoint[] = [];

export default function DashboardScreen() {
  const { colors } = useTheme();
  const wide = useWindowDimensions().width >= WIDE_BREAKPOINT;
  const today = todayISO();

  const day = useDayNutrients(today);
  const energy = useDayEnergyFrom(today, day);
  const summary = useEnergySummaryMode();
  const targetsQ = useTargets();
  const profileQ = useProfile();
  const gate = useAiGate();
  const recent = useRecentDays(90);
  const weight = useWeightHistory(30);
  const [range, setRange] = useState<Range>('7');

  const weightPoints = weight.data ?? EMPTY_POINTS;
  const firstWeight = weightPoints[0];
  const lastWeight = weightPoints[weightPoints.length - 1];
  const weightChangeKg = firstWeight && lastWeight && weightPoints.length > 1 ? lastWeight.kg - firstWeight.kg : undefined;

  const targets = targetsQ.data;
  const netCarbs = profileQ.data?.net_carbs ?? targets?.profile.net_carbs ?? true;
  const unitSystem = profileQ.data?.unit_system ?? 'metric';

  const rows = buildMacroRows({
    colors,
    totals: day.totals,
    hasEntries: day.hasEntries,
    targets,
    netCarbs,
    exerciseBurnedKcal: energy.exerciseBurnedKcal,
  });

  // Entries added elsewhere (search, copy, quick add) invalidate the day; also refresh the aggregates on focus.
  const refetchRecent = recent.refetch;
  const refetchWeight = weight.refetch;
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      void refetchRecent();
      void refetchWeight();
    }, [refetchRecent, refetchWeight]),
  );

  // Wide windows (beside the sidebar) get panels and a KPI strip; the phone keeps the cards below.
  if (wide) {
    return (
      <DesktopDashboard
        today={today}
        energy={energy}
        energyProps={{
          ...energySummaryProps(energy, summary.toggle),
          split: { target: targetSplit(targets), consumed: consumedSplit(day.totals) },
        }}
        day={day}
        targets={targets}
        needsOnboarding={targetsQ.needsOnboarding}
        netCarbs={netCarbs}
        rows={rows}
        recent={{ days: recent.days, streak: recent.streak, isLoading: recent.isLoading }}
        weight={{ points: weightPoints, isLoading: weight.isLoading }}
        unitSystem={unitSystem}
        range={range}
        onRangeChange={setRange}
        aiEnabled={gate.enabled}
      />
    );
  }

  return (
    <Screen title="Dashboard">
      <QuickAddRow />

      {targetsQ.needsOnboarding ? (
        <Card>
          <AppText variant="heading">Set up your targets</AppText>
          <AppText muted>Tell us a bit about you to get calorie, macro and nutrient targets.</AppText>
          <Button label="Set up targets" onPress={() => go('/onboarding')} />
        </Card>
      ) : null}

      <ResponsiveGrid minItemWidth={320}>
        <Card>
          <View style={styles.cardHeader}>
            <AppText variant="heading">Today</AppText>
            <Button label="Open diary" variant="ghost" onPress={() => go('/diary')} />
          </View>
          <EnergySummary
            {...energySummaryProps(energy, summary.toggle)}
            split={{ target: targetSplit(targets), consumed: consumedSplit(day.totals) }}
            compact
          />
          <MacroBars rows={rows} />
          {day.isError ? (
            <AppText variant="small" style={{ color: colors.danger }}>
              Could not load today&apos;s entries.
            </AppText>
          ) : null}
        </Card>
        <AverageCard
          days={recent.days}
          range={range}
          onRangeChange={setRange}
          targetKcal={energy.targetKcal}
          loading={recent.isLoading}
        />
        <StreakCard days={recent.days} streak={recent.streak} loading={recent.isLoading} />
        <WeightCard
          points={weightPoints}
          changeKg={weightChangeKg}
          unitSystem={unitSystem}
          loading={weight.isLoading}
        />
        {gate.enabled ? <CoachCard /> : null}
      </ResponsiveGrid>
    </Screen>
  );
}

const styles = StyleSheet.create({
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: -spacing.xs },
});
