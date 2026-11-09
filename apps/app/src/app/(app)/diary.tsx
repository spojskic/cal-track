import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import { EnergySummary, type EnergySummaryProps } from '@/components/charts/EnergySummary';
import { AddRow, BiometricList, DiaryTabs, ExerciseList, NotesList, type DiaryTab } from '@/components/diary/ActivityTabs';
import { CopyDiarySheet } from '@/components/diary/CopyDiarySheet';
import { DateBar } from '@/components/diary/DateBar';
import { buildDeviceRows, DevicesGroup } from '@/components/diary/DevicesGroup';
import { EntryActionSheet } from '@/components/diary/EntryActionSheet';
import { haptic } from '@/components/diary/haptics';
import { useMeasuredWidth } from '@/components/diary/layout';
import { MealGroupSection } from '@/components/diary/MealGroupSection';
import { go } from '@/components/diary/nav';
import { NutrientTargetsPanel } from '@/components/diary/NutrientTargetsPanel';
import { ActionMenu, type MenuAction } from '@/components/diary/Sheet';
import { buildHighlights, buildMacroRows, consumedSplit, targetSplit } from '@/components/diary/targets-view';
import { MacroBars, TargetsPager } from '@/components/diary/TargetsPager';
import { DEFAULT_WATER_TARGET_ML, QUICK_WATER_ML, WaterRow } from '@/components/diary/WaterRow';
import { AppText, Button, Card } from '@/components/ui';
import { useBiometrics, useNotes, useWaterMl } from '@/data/activity';
import { UNGROUPED, useDayNutrients, type DiaryEntry } from '@/data/diary';
import { useDayEnergyFrom } from '@/data/energy';
import { useMealGroups, type MealGroup } from '@/data/meal-groups';
import { useProfile } from '@/data/profile';
import { useTargets } from '@/data/targets';
import { todayISO, useSelectedDate } from '@/state/selected-date';
import { MAX_CONTENT_WIDTH, WIDE_BREAKPOINT, spacing, useTheme } from '@/theme';

interface Section {
  id: string;
  name: string;
  group: MealGroup | undefined;
  entries: DiaryEntry[];
  kcal: number;
}

type MenuState = { kind: 'date' } | { kind: 'group'; section: Section };

export default function DiaryScreen() {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_BREAKPOINT;
  const qc = useQueryClient();
  const [bodyWidth, onBodyLayout] = useMeasuredWidth();
  const twoColumns = wide && bodyWidth >= 780;

  const date = useSelectedDate((s) => s.date);
  const shift = useSelectedDate((s) => s.shift);
  const goToday = useSelectedDate((s) => s.goToday);

  const day = useDayNutrients(date);
  const energy = useDayEnergyFrom(date, day);
  const targetsQ = useTargets();
  const profileQ = useProfile();
  const groupsQ = useMealGroups();
  const waterQ = useWaterMl(date);
  const biometricsQ = useBiometrics(date);
  const notesQ = useNotes(date);

  const [tab, setTab] = useState<DiaryTab>('food');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [menuVisible, setMenuVisible] = useState(false);
  // undefined = copy sheet closed, null = copy a whole day, object = copy one meal group.
  const [copyGroup, setCopyGroup] = useState<{ id: string; name: string } | null | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);

  const targets = targetsQ.data;
  const netCarbs = profileQ.data?.net_carbs ?? targets?.profile.net_carbs ?? true;
  const unitSystem = profileQ.data?.unit_system ?? 'metric';
  const waterTarget = Math.round(targets?.nutrients.WATER_G?.min ?? DEFAULT_WATER_TARGET_ML);

  const rows = useMemo(
    () =>
      buildMacroRows({
        colors,
        totals: day.totals,
        hasEntries: day.hasEntries,
        targets,
        netCarbs,
        exerciseBurnedKcal: energy.exerciseBurnedKcal,
      }),
    [colors, day.totals, day.hasEntries, targets, netCarbs, energy.exerciseBurnedKcal],
  );
  const highlights = useMemo(
    () => buildHighlights({ colors, totals: day.totals, hasEntries: day.hasEntries, targets, netCarbs }),
    [colors, day.totals, day.hasEntries, targets, netCarbs],
  );
  const energyProps: EnergySummaryProps = {
    consumed: day.kcal,
    expenditure: energy.expenditureKcal,
    target: energy.targetKcal,
    exerciseBurned: energy.exerciseBurnedKcal,
    remaining: energy.remainingKcal,
    split: { target: targetSplit(targets), consumed: consumedSplit(day.totals) },
  };

  const sections = useMemo<Section[]>(() => {
    const groups = groupsQ.data ?? [];
    const known = new Set(groups.map((g) => g.id));
    const byGroup = new Map<string, DiaryEntry[]>();
    const orphans: DiaryEntry[] = [];
    for (const entry of day.entries) {
      if (entry.mealGroupId && known.has(entry.mealGroupId)) {
        const list = byGroup.get(entry.mealGroupId) ?? [];
        list.push(entry);
        byGroup.set(entry.mealGroupId, list);
      } else {
        orphans.push(entry);
      }
    }
    const list: Section[] = groups
      .filter((g) => !g.hidden || byGroup.has(g.id))
      .map((g) => ({
        id: g.id,
        name: g.name,
        group: g,
        entries: byGroup.get(g.id) ?? [],
        kcal: day.byGroup[g.id]?.kcal ?? 0,
      }));
    if (orphans.length > 0) {
      list.push({
        id: UNGROUPED,
        name: 'Other',
        group: undefined,
        entries: orphans,
        kcal: orphans.reduce((s, e) => s + (e.kcal ?? 0), 0),
      });
    }
    return list;
  }, [groupsQ.data, day.entries, day.byGroup]);

  const devices = useMemo(
    () => buildDeviceRows(energy.exercise, energy.deviceEnergyRows, biometricsQ.data ?? []),
    [energy.exercise, energy.deviceEnergyRows, biometricsQ.data],
  );
  const biometrics = biometricsQ.data ?? [];

  const openMenu = (m: MenuState) => {
    haptic('light');
    setMenu(m);
    setMenuVisible(true);
  };
  const toggleGroup = (id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  const menuActions: MenuAction[] = (() => {
    if (!menu) return [];
    if (menu.kind === 'date') {
      const actions: MenuAction[] = [];
      if (date !== todayISO()) actions.push({ key: 'today', label: 'Go to today', onPress: goToday });
      actions.push({ key: 'copy-day', label: 'Copy a day from...', onPress: () => setCopyGroup(null) });
      const allCollapsed = sections.length > 0 && sections.every((s) => collapsed[s.id]);
      actions.push({
        key: 'toggle-all',
        label: allCollapsed ? 'Expand all meals' : 'Collapse all meals',
        onPress: () => setCollapsed(Object.fromEntries(sections.map((s) => [s.id, !allCollapsed]))),
      });
      return actions;
    }
    const { section } = menu;
    const actions: MenuAction[] = [];
    const group = section.group;
    if (group) {
      actions.push({
        key: 'add',
        label: `Add food to ${section.name}`,
        onPress: () => go('/search', { mealGroupId: group.id }),
      });
      actions.push({
        key: 'copy',
        label: `Copy ${section.name} from another day...`,
        onPress: () => setCopyGroup({ id: group.id, name: group.name }),
      });
    }
    actions.push({
      key: 'collapse',
      label: collapsed[section.id] ? `Expand ${section.name}` : `Collapse ${section.name}`,
      onPress: () => toggleGroup(section.id),
    });
    return actions;
  })();

  const onRefresh = () => {
    setRefreshing(true);
    Promise.all([
      qc.invalidateQueries({ queryKey: ['day', date] }),
      qc.invalidateQueries({ queryKey: ['meal_groups'] }),
      qc.invalidateQueries({ queryKey: ['targets'] }),
    ]).finally(() => setRefreshing(false));
  };

  const counts: Partial<Record<DiaryTab, number>> = {
    exercise: energy.exercise.length || undefined,
    biometric: biometrics.length || undefined,
    note: (notesQ.data ?? []).length || undefined,
  };

  // ------------------------------------------------------------------------------ blocks of the page

  const onboardingPrompt = targetsQ.needsOnboarding ? (
    <Card>
      <AppText variant="heading">Set up your targets</AppText>
      <AppText muted>
        Answer a few questions so Cal Track can calculate your calorie, macro and nutrient targets. Your entries are
        listed below in the meantime.
      </AppText>
      <Button label="Set up targets" onPress={() => go('/onboarding')} />
    </Card>
  ) : null;

  const foodTab = day.isLoading ? (
    <View style={styles.centered} accessibilityLabel="Loading your diary">
      <ActivityIndicator color={colors.primary} />
    </View>
  ) : day.isError ? (
    <View style={styles.centered}>
      <AppText style={{ color: colors.danger }}>Could not load this day.</AppText>
      <AppText variant="small" muted>
        {day.error?.message}
      </AppText>
      <Button label="Try again" variant="secondary" onPress={() => day.refetch()} />
    </View>
  ) : (
    <View style={styles.stack}>
      <DevicesGroup rows={devices.rows} sources={devices.sources} />
      {groupsQ.isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : null}
      {sections.map((section) => (
        <MealGroupSection
          key={section.id}
          name={section.name}
          kcal={section.kcal}
          entries={section.entries}
          collapsed={collapsed[section.id] === true}
          onToggle={() => toggleGroup(section.id)}
          onAdd={() => go('/search', section.group ? { mealGroupId: section.group.id } : undefined)}
          onMenu={() => openMenu({ kind: 'group', section })}
          onEntryPress={(entry) => {
            haptic('light');
            setEditingId(entry.id);
          }}
          onEntryLongPress={(entry) => {
            haptic('medium');
            setEditingId(entry.id);
          }}
        />
      ))}
      {!day.hasEntries && devices.rows.length === 0 && !groupsQ.isLoading ? (
        <AppText muted style={styles.hint}>
          Nothing logged yet. Tap + on a meal to add food.
        </AppText>
      ) : null}
      <WaterRow ml={waterQ.data} target={waterTarget} onAdd={() => go('/water/new', { ml: QUICK_WATER_ML })} />
    </View>
  );

  const diaryCard = (
    <Card style={styles.tabCard}>
      <DiaryTabs value={tab} onChange={setTab} counts={counts} />
      <View style={styles.tabBody}>
        {tab === 'food' ? (
          foodTab
        ) : tab === 'exercise' ? (
          <View style={styles.stack}>
            <ExerciseList entries={energy.exercise} />
            <AddRow label="Add exercise" onPress={() => go('/exercise/new')} />
          </View>
        ) : tab === 'biometric' ? (
          <View style={styles.stack}>
            <BiometricList entries={biometrics} unitSystem={unitSystem} />
            <AddRow label="Add biometric" onPress={() => go('/biometric/new')} />
          </View>
        ) : (
          <View style={styles.stack}>
            <NotesList entries={notesQ.data ?? []} />
            <AddRow label="Add note" onPress={() => go('/note/new')} />
          </View>
        )}
      </View>
    </Card>
  );

  const targetsCard = (
    <Card>
      <AppText variant="heading">Targets</AppText>
      <MacroBars rows={rows} />
    </Card>
  );
  const energyCard = (
    <Card>
      <AppText variant="heading">Energy Summary</AppText>
      <EnergySummary {...energyProps} />
    </Card>
  );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScrollView
        stickyHeaderIndices={[0]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled">
        <View style={[styles.stickyOuter, { backgroundColor: colors.background }]}>
          <View style={styles.inner}>
            <DateBar
              date={date}
              onPrev={() => shift(-1)}
              onNext={() => shift(1)}
              onToday={goToday}
              onAdd={() => go('/add')}
              onMenu={() => openMenu({ kind: 'date' })}
            />
            {!wide ? (
              <Card style={styles.pagerCard}>
                <TargetsPager rows={rows} energy={energyProps} highlights={highlights} />
              </Card>
            ) : null}
          </View>
        </View>

        <View style={[styles.inner, styles.body]} onLayout={onBodyLayout}>
          {onboardingPrompt}
          {twoColumns ? (
            <View style={styles.columns}>
              <View style={styles.mainColumn}>{diaryCard}</View>
              <View style={styles.sideColumn}>
                {targetsCard}
                {energyCard}
              </View>
            </View>
          ) : (
            <>
              {diaryCard}
              {wide ? targetsCard : null}
              {energyCard}
            </>
          )}
          <NutrientTargetsPanel
            totals={day.totals}
            hasEntries={day.hasEntries}
            incompleteNutrients={day.incompleteNutrients}
            targets={targets}
            netCarbs={netCarbs}
          />
        </View>
      </ScrollView>

      <EntryActionSheet
        entryId={editingId}
        date={date}
        groups={(groupsQ.data ?? []).filter((g) => !g.hidden)}
        onClose={() => setEditingId(null)}
      />
      <ActionMenu
        visible={menuVisible}
        title={menu?.kind === 'group' ? menu.section.name : 'Diary'}
        actions={menuActions}
        onClose={() => setMenuVisible(false)}
      />
      <CopyDiarySheet
        visible={copyGroup !== undefined}
        targetDate={date}
        group={copyGroup}
        onClose={() => setCopyGroup(undefined)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { flexGrow: 1, paddingBottom: spacing.xxl * 2 },
  stickyOuter: { paddingTop: spacing.sm, paddingBottom: spacing.sm },
  inner: { width: '100%', maxWidth: MAX_CONTENT_WIDTH, alignSelf: 'center', paddingHorizontal: spacing.lg, gap: spacing.sm },
  body: { gap: spacing.lg, paddingTop: spacing.sm },
  pagerCard: { padding: spacing.md, gap: spacing.sm },
  tabCard: { padding: 0, gap: 0, overflow: 'hidden' },
  tabBody: { padding: spacing.md, gap: spacing.md },
  stack: { gap: spacing.md },
  centered: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.lg },
  hint: { textAlign: 'center', paddingVertical: spacing.sm },
  columns: { flexDirection: 'row', gap: spacing.lg, alignItems: 'flex-start' },
  mainColumn: { flex: 3 },
  sideColumn: { flex: 2, gap: spacing.lg },
});
