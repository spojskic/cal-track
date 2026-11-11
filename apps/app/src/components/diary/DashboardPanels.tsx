// The desktop (wide window) dashboard: a page header with the quick-add buttons, a KPI strip and a grid of panels. Phones keep the
// cards of DashboardCards.tsx. Every number is computed in dashboard-view.ts (unit tested); this file only draws it.
import { formatWeight, type UnitSystem } from '@ration/core';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { EnergySummary, type EnergySummaryProps } from '@/components/charts/EnergySummary';
import { MiniBarChart, type MiniBar } from '@/components/charts/MiniBarChart';
import { Sparkline } from '@/components/charts/Sparkline';
import { formatNumber } from '@/components/charts/format';
import { formatLongDate } from '@/components/desktop-layout';
import {
  BarList,
  DesktopPage,
  KpiCell,
  KpiStrip,
  MiniProgress,
  Panel,
  PanelGrid,
  PanelTabs,
  ToolbarButton,
} from '@/components/panel';
import { AppText } from '@/components/ui';
import { WorkoutIcon } from '@/components/workouts/WorkoutIcon';
import { WORKOUTS_HREF, workoutHref } from '@/components/workouts/links';
import { workoutKind } from '@/components/workouts/kinds';
import { workoutRowText } from '@/components/workouts/summary';
import { averageOfDays, type DayNutrients, type RecentDay } from '@/data/diary';
import type { DayEnergy } from '@/data/energy';
import type { ResolvedTargets } from '@/data/targets';
import type { WeightPoint } from '@/data/weight';
import { useWorkouts, type WorkoutRow } from '@/data/workouts';
import { useTheme } from '@/theme';

import { QUICK_ITEMS } from './DashboardCards';
import {
  averageBarRows,
  changeSign,
  macroBarRows,
  macroKpi,
  remainingKpi,
  streakMessage,
  weightStats,
  type KpiData,
} from './dashboard-view';
import { weekdayInitial } from './dates';
import { haptic } from './haptics';
import { go } from './nav';
import { HighlightedNutrientsPanel, NutritionScorePanel } from './NutrientPanels';
import type { MacroRow } from './targets-view';
import { useNutrientModel } from './use-nutrient-model';

export type DashboardRange = '7' | '14' | '30';

/** How many workouts "Recent workouts" lists. */
const RECENT_WORKOUTS = 5;
/** Days of energy the Consumed KPI draws as its sparkline. */
const KPI_TREND_DAYS = 14;

// ------------------------------------------------------------------------------------------------ header

/** Food / Exercise / Biometric / Note as a compact row of buttons in the page header (same names as the phone's tiles: "Add food", ...). */
function QuickAddBar() {
  return (
    <View accessibilityRole="toolbar" accessibilityLabel="Quick add" style={styles.quickBar}>
      {QUICK_ITEMS.map((item) => (
        <ToolbarButton
          key={item.key}
          label={item.label}
          accessibilityLabel={`Add ${item.label.toLowerCase()}`}
          symbol={item.symbol}
          onPress={() => {
            haptic('light');
            go(item.href);
          }}
        />
      ))}
    </View>
  );
}

// ------------------------------------------------------------------------------------------------ KPI strip

function MacroKpiCell({ kpi }: { kpi: KpiData }) {
  return (
    <KpiCell label={kpi.label} value={kpi.value} unit={kpi.unit} delta={kpi.delta} deltaTone={kpi.deltaTone}>
      <MiniProgress fraction={kpi.fraction} color={kpi.color} overColor={kpi.overColor} />
    </KpiCell>
  );
}

/** The last seven days as small markers with their weekday initial. */
function WeekDots({ days }: { days: readonly RecentDay[] }) {
  const { colors, shape } = useTheme();
  return (
    <View style={styles.weekRow}>
      {days.map((d) => (
        <View
          key={d.date}
          accessible
          accessibilityLabel={`${d.date}: ${d.logged ? 'logged' : 'nothing logged'}`}
          style={styles.weekCell}>
          <View
            style={[styles.weekDot, { backgroundColor: d.logged ? colors.success : colors.track, borderRadius: shape.circle(WEEK_DOT_SIZE) }]}
          />
          <AppText muted style={styles.weekInitial}>
            {weekdayInitial(d.date)}
          </AppText>
        </View>
      ))}
    </View>
  );
}

const WEEK_DOT_SIZE = 12;

function DashboardKpis({
  energy,
  rows,
  recent,
}: {
  energy: DayEnergy;
  rows: MacroRow[];
  recent: { days: readonly RecentDay[]; streak: number; isLoading: boolean };
}) {
  const { colors } = useTheme();
  const over = { danger: colors.danger, success: colors.success };
  const [energyRow, ...macroRows] = rows;
  const consumed = energyRow ? macroKpi(energyRow, over) : undefined;
  const remaining = remainingKpi({
    remaining: energy.remainingKcal,
    mode: energy.summaryMode,
    consumed: energy.consumedKcal,
    budget: energy.budgetKcal,
    expenditure: energy.expenditureKcal,
  });
  const trend = recent.days.slice(-KPI_TREND_DAYS).map((d) => d.kcal);
  const week = recent.days.slice(-7);
  const loggedToday = recent.days[recent.days.length - 1]?.logged === true;
  const message = streakMessage(recent.streak, loggedToday, recent.isLoading);

  return (
    <KpiStrip>
      {consumed ? (
        <KpiCell key="consumed" label="Consumed" value={consumed.value} unit={consumed.unit} delta={consumed.delta} deltaTone={consumed.deltaTone}>
          {trend.length > 1 ? (
            <Sparkline
              values={trend}
              height={26}
              color={colors.energy}
              strokeWidth={1.5}
              dotRadius={2.5}
              pad={3}
              accessibilityLabel={`Daily energy, last ${trend.length} days`}
            />
          ) : null}
        </KpiCell>
      ) : null}
      <KpiCell
        key="remaining"
        label={remaining.label}
        value={remaining.value}
        unit={remaining.unit}
        delta={remaining.delta}
        deltaTone={remaining.deltaTone}>
        <MiniProgress
          fraction={remaining.fraction}
          color={remaining.negative ? colors.danger : colors.success}
          overColor={colors.danger}
        />
      </KpiCell>
      {macroRows.map((row) => (
        <MacroKpiCell key={row.key} kpi={macroKpi(row, over)} />
      ))}
      <KpiCell
        key="streak"
        label="Logging streak"
        value={recent.isLoading ? '-' : String(recent.streak)}
        unit={recent.streak === 1 ? 'day' : 'days'}
        valueAccessibilityLabel={`${recent.streak} day streak`}
        delta={message || undefined}>
        <WeekDots days={week} />
      </KpiCell>
    </KpiStrip>
  );
}

// ------------------------------------------------------------------------------------------------ panels

function TodayPanel({
  energyProps,
  rows,
  hasError,
}: {
  energyProps: EnergySummaryProps;
  rows: MacroRow[];
  hasError: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Panel title="Today" action={{ label: 'Open diary', onPress: () => go('/diary') }}>
      <EnergySummary {...energyProps} compact />
      <BarList rows={macroBarRows(rows, { danger: colors.danger, success: colors.success })} />
      {hasError ? (
        <AppText variant="small" style={{ color: colors.danger }}>
          Could not load today&apos;s entries.
        </AppText>
      ) : null}
    </Panel>
  );
}

const RANGE_OPTIONS: { value: DashboardRange; label: string; accessibilityLabel: string }[] = [
  { value: '7', label: '7d', accessibilityLabel: '7 days' },
  { value: '14', label: '14d', accessibilityLabel: '14 days' },
  { value: '30', label: '30d', accessibilityLabel: '30 days' },
];

/** Average kcal and macro split over the last 7 / 14 / 30 days (logged days only). */
function AveragePanel({
  days,
  range,
  onRangeChange,
  targetKcal,
  loading,
}: {
  days: readonly RecentDay[];
  range: DashboardRange;
  onRangeChange: (range: DashboardRange) => void;
  targetKcal: number | undefined;
  loading: boolean;
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
  const macros = averageBarRows(
    [
      { key: 'protein', label: 'Protein', g: avg.proteinG, pct: avg.proteinPct, color: colors.protein },
      { key: 'carbs', label: 'Carbs', g: avg.carbsG, pct: avg.carbsPct, color: colors.carbs },
      { key: 'fat', label: 'Fat', g: avg.fatG, pct: avg.fatPct, color: colors.fat },
    ],
    { danger: colors.danger, success: colors.success },
  );

  return (
    <Panel
      title="Consumed average"
      headerRight={<PanelTabs<DashboardRange> options={RANGE_OPTIONS} value={range} onChange={onRangeChange} />}>
      {loading ? (
        <AppText muted variant="small">
          Loading...
        </AppText>
      ) : avg.loggedDays === 0 ? (
        <AppText muted variant="small">
          Log a few meals to see your averages.
        </AppText>
      ) : (
        <>
          <View style={styles.bigRow}>
            <AppText style={styles.big} accessibilityLabel={`Average ${formatNumber(avg.kcal)} kilocalories per day`}>
              {formatNumber(avg.kcal)}
            </AppText>
            <AppText muted style={styles.bigUnit}>
              kcal / day
            </AppText>
            <AppText muted style={styles.bigNote}>
              Last {n} days, {avg.loggedDays} logged
            </AppText>
          </View>
          <MiniBarChart bars={bars} target={targetKcal} height={84} color={colors.energy} accessibilityLabel={`Daily energy, last ${n} days`} />
          <BarList rows={macros} />
        </>
      )}
    </Panel>
  );
}

/** A row of small figures under a chart: muted label over a semibold value. */
function Stats({ items }: { items: { key: string; label: string; value: string }[] }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.stats, { borderTopColor: colors.border }]}>
      {items.map((item) => (
        <View key={item.key} style={styles.stat}>
          <AppText muted style={styles.statLabel} numberOfLines={1}>
            {item.label}
          </AppText>
          <AppText style={styles.statValue} numberOfLines={1}>
            {item.value}
          </AppText>
        </View>
      ))}
    </View>
  );
}

/** Weight trend of the last 30 days. */
function WeightPanel({
  points,
  unitSystem,
  loading,
}: {
  points: readonly WeightPoint[];
  unitSystem: UnitSystem;
  loading: boolean;
}) {
  const stats = weightStats(points);
  const sign = changeSign(stats.changeKg);
  const { latestKg } = stats;
  return (
    <Panel
      title="Weight trend"
      meta="Last 30 days"
      action={{ label: 'Log weight', onPress: () => go('/biometric/new', { type: 'weight' }) }}>
      {loading ? (
        <AppText muted variant="small">
          Loading...
        </AppText>
      ) : latestKg === undefined ? (
        <AppText muted variant="small">
          No weight logged in the last 30 days.
        </AppText>
      ) : (
        <>
          <View style={styles.bigRow}>
            <AppText style={styles.big}>{formatWeight(latestKg, unitSystem)}</AppText>
            {stats.changeKg !== undefined ? (
              <AppText muted style={styles.bigNote}>
                {sign}
                {formatWeight(Math.abs(stats.changeKg), unitSystem)} in 30 days
              </AppText>
            ) : null}
          </View>
          {points.length > 1 ? (
            <Sparkline
              values={points.map((p) => p.kg)}
              height={104}
              accessibilityLabel={`Weight trend, latest ${formatWeight(latestKg, unitSystem)}`}
            />
          ) : (
            <AppText variant="small" muted>
              Log another weigh-in to see a trend.
            </AppText>
          )}
          {stats.count > 1 && stats.firstKg !== undefined && stats.lowestKg !== undefined && stats.highestKg !== undefined ? (
            <Stats
              items={[
                { key: 'start', label: 'Start', value: formatWeight(stats.firstKg, unitSystem) },
                { key: 'low', label: 'Lowest', value: formatWeight(stats.lowestKg, unitSystem) },
                { key: 'high', label: 'Highest', value: formatWeight(stats.highestKg, unitSystem) },
                { key: 'count', label: 'Weigh-ins', value: String(stats.count) },
              ]}
            />
          ) : null}
        </>
      )}
    </Panel>
  );
}

function WorkoutLine({ row, last }: { row: WorkoutRow; last: boolean }) {
  const { colors } = useTheme();
  const text = workoutRowText(row);
  const kind = workoutKind({ name: row.name, activity_code: row.activity_code, type_key: row.type_key });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={text.label}
      onPress={() => router.push(workoutHref(row.id))}
      style={({ pressed }) => [
        styles.workout,
        { borderBottomColor: colors.border, borderBottomWidth: last ? 0 : 1 },
        pressed && { backgroundColor: colors.surfaceAlt },
      ]}>
      <WorkoutIcon kind={kind} size={30} />
      <View style={styles.workoutText}>
        <AppText numberOfLines={1} style={styles.workoutTitle}>
          {text.title}
        </AppText>
        {text.line ? (
          <AppText muted numberOfLines={1} style={styles.workoutLine}>
            {text.line}
          </AppText>
        ) : null}
      </View>
      <View style={styles.workoutKcal}>
        <AppText numberOfLines={1} style={styles.statValue}>
          {text.kcal}
        </AppText>
        <AppText muted style={styles.statLabel}>
          kcal
        </AppText>
      </View>
    </Pressable>
  );
}

/** The latest workouts (manual and from a device), newest first. */
function WorkoutsPanel() {
  const { colors } = useTheme();
  const query = useWorkouts('all');
  const rows = (query.data?.pages[0] ?? []).slice(0, RECENT_WORKOUTS);
  return (
    <Panel
      title="Recent workouts"
      flush
      action={{ label: 'All workouts', accessibilityLabel: 'Open all workouts', onPress: () => router.push(WORKOUTS_HREF) }}>
      {query.isPending ? (
        <View style={styles.state}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : query.isError ? (
        <View style={styles.state}>
          <AppText muted variant="small">
            Could not load your workouts.
          </AppText>
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.state}>
          <AppText muted variant="small" style={styles.stateText}>
            No workouts yet. Log one or connect Garmin.
          </AppText>
          <ToolbarButton label="Log a workout" onPress={() => go('/exercise/new')} />
        </View>
      ) : (
        rows.map((row, i) => <WorkoutLine key={row.id} row={row} last={i === rows.length - 1} />)
      )}
    </Panel>
  );
}

/** The way into the AI coach, as a slim strip. Only rendered when the AI gate is enabled. */
function CoachPanel() {
  return (
    <Panel title="Coach">
      <View style={styles.coach}>
        <View style={styles.coachText}>
          <AppText style={styles.coachTitle}>Ask your coach</AppText>
          <AppText muted variant="small">
            Get feedback on today and ideas for your next meal.
          </AppText>
        </View>
        <ToolbarButton primary label="Open coach" onPress={() => go('/coach')} />
      </View>
    </Panel>
  );
}

function OnboardingPanel() {
  return (
    <Panel title="Set up your targets">
      <AppText muted variant="small">
        Tell us a bit about you to get calorie, macro and nutrient targets.
      </AppText>
      <View style={styles.alignStart}>
        <ToolbarButton primary label="Set up targets" onPress={() => go('/onboarding')} />
      </View>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------ page

export interface DesktopDashboardProps {
  today: string;
  energy: DayEnergy;
  energyProps: EnergySummaryProps;
  day: DayNutrients;
  targets: ResolvedTargets | undefined;
  needsOnboarding: boolean;
  netCarbs: boolean;
  rows: MacroRow[];
  recent: { days: readonly RecentDay[]; streak: number; isLoading: boolean };
  weight: { points: readonly WeightPoint[]; isLoading: boolean };
  unitSystem: UnitSystem;
  range: DashboardRange;
  onRangeChange: (range: DashboardRange) => void;
  aiEnabled: boolean;
}

/** The dashboard on a wide window: header with quick add, KPI strip, then Today / Consumed average / Weight / Workouts / Nutrition score / Highlighted nutrients, and the coach. */
export function DesktopDashboard(props: DesktopDashboardProps) {
  const { today, energy, energyProps, day, targets, needsOnboarding, netCarbs, rows, recent, weight, unitSystem, range, aiEnabled } = props;
  const nutrients = useNutrientModel({
    totals: day.totals,
    hasEntries: day.hasEntries,
    incompleteNutrients: day.incompleteNutrients,
    targets,
    netCarbs,
  });

  return (
    <DesktopPage title="Dashboard" subtitle={formatLongDate(today, new Date().getFullYear())} right={<QuickAddBar />}>
      {needsOnboarding ? <OnboardingPanel /> : null}
      <DashboardKpis energy={energy} rows={rows} recent={recent} />
      <PanelGrid>
        <TodayPanel energyProps={energyProps} rows={rows} hasError={day.isError} />
        <AveragePanel
          days={recent.days}
          range={range}
          onRangeChange={props.onRangeChange}
          targetKcal={energy.targetKcal}
          loading={recent.isLoading}
        />
        <WeightPanel points={weight.points} unitSystem={unitSystem} loading={weight.isLoading} />
        <WorkoutsPanel />
        <NutritionScorePanel model={nutrients} />
        <HighlightedNutrientsPanel model={nutrients} />
      </PanelGrid>
      {aiEnabled ? <CoachPanel /> : null}
    </DesktopPage>
  );
}

const styles = StyleSheet.create({
  quickBar: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  weekRow: { flexDirection: 'row', justifyContent: 'space-between' },
  weekCell: { alignItems: 'center', gap: 2 },
  weekDot: { width: WEEK_DOT_SIZE, height: WEEK_DOT_SIZE },
  weekInitial: { fontSize: 10 },
  bigRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' },
  big: { fontSize: 28, fontWeight: '600', fontVariant: ['tabular-nums'] },
  bigUnit: { fontSize: 13 },
  bigNote: { fontSize: 12, marginLeft: 'auto' },
  stats: { flexDirection: 'row', gap: 8, paddingTop: 10, borderTopWidth: 1 },
  stat: { flex: 1, gap: 1 },
  statLabel: { fontSize: 11.5 },
  statValue: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  workout: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 50, paddingHorizontal: 14, paddingVertical: 8 },
  workoutText: { flex: 1, gap: 1, minWidth: 0 },
  workoutTitle: { fontSize: 13, fontWeight: '600' },
  workoutLine: { fontSize: 12 },
  workoutKcal: { alignItems: 'flex-end', flexShrink: 0 },
  state: { alignItems: 'center', gap: 10, padding: 20 },
  stateText: { textAlign: 'center' },
  coach: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  coachText: { flex: 1, minWidth: 220, gap: 2 },
  coachTitle: { fontSize: 14, fontWeight: '600' },
  alignStart: { alignSelf: 'flex-start' },
});
