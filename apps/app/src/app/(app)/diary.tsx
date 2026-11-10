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
import { ConfirmSheet } from '@/components/diary/ConfirmSheet';
import { dateMenuItems, groupMenuItems, type DateMenuKey, type GroupMenuKey } from '@/components/diary/copy-menus';
import { CopyDiarySheet } from '@/components/diary/CopyDiarySheet';
import { DateBar, DateControls } from '@/components/diary/DateBar';
import { buildDeviceRows, DevicesGroup } from '@/components/diary/DevicesGroup';
import { DesktopDiaryBody } from '@/components/diary/DiaryDesktop';
import { EntryActionSheet } from '@/components/diary/EntryActionSheet';
import { formatDayLabel } from '@/components/diary/dates';
import { haptic } from '@/components/diary/haptics';
import { MealGroupSection } from '@/components/diary/MealGroupSection';
import { go } from '@/components/diary/nav';
import { NutrientTargetsPanel } from '@/components/diary/NutrientTargetsPanel';
import { NutritionSummarySheet } from '@/components/diary/NutritionSummarySheet';
import { ActionMenu, type MenuAction } from '@/components/diary/Sheet';
import { energySummaryProps } from '@/components/diary/energy-view';
import { buildHighlights, buildMacroRows, consumedSplit, targetSplit } from '@/components/diary/targets-view';
import { TargetsHeader, TargetsPager } from '@/components/diary/TargetsPager';
import { ToastHost } from '@/components/diary/ToastHost';
import { useCopyActions } from '@/components/diary/use-copy-actions';
import { DEFAULT_WATER_TARGET_ML, QUICK_WATER_ML, WaterRow } from '@/components/diary/WaterRow';
import { DesktopPage } from '@/components/panel';
import { AddSavedMealSheet, SaveMealSheet } from '@/components/recipes/SavedMealControls';
import { AppText, Button, Card } from '@/components/ui';
import { useBiometrics, useNotes, useWaterMl } from '@/data/activity';
import { UNGROUPED, useDayNutrients, useDiaryEntries, type DiaryEntry } from '@/data/diary';
import { isPastDate, itemWord, sortEntriesByTime } from '@/data/diary-copy';
import { useDayEnergyFrom } from '@/data/energy';
import { useEnergySummaryMode } from '@/data/energy-mode';
import { useMealGroups, type MealGroup } from '@/data/meal-groups';
import { useProfile } from '@/data/profile';
import { useTargets } from '@/data/targets';
import { showDiaryToast } from '@/state/diary-toast';
import { buildRecipeDraft, useRecipeDraft } from '@/state/recipe-draft';
import { addDays, todayISO, useSelectedDate } from '@/state/selected-date';
import { MAX_CONTENT_WIDTH, WIDE_BREAKPOINT, spacing, useTheme } from '@/theme';

interface Section {
  id: string;
  name: string;
  group: MealGroup | undefined;
  entries: DiaryEntry[];
  kcal: number;
}

// A group menu keeps the section id (not the section) so its actions always act on the live entries.
type MenuState = { kind: 'date' } | { kind: 'group'; sectionId: string };

type ConfirmState = { kind: 'delete-group'; sectionId: string } | { kind: 'copy-diary' };

const NO_ENTRIES: DiaryEntry[] = [];

/** Entries as listed: the order they were logged, or newest first. */
const sortedEntries = (entries: DiaryEntry[], newest: boolean): DiaryEntry[] =>
  newest ? sortEntriesByTime(entries, true) : entries;

export default function DiaryScreen() {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_BREAKPOINT;
  const qc = useQueryClient();

  const date = useSelectedDate((s) => s.date);
  const shift = useSelectedDate((s) => s.shift);
  const goToday = useSelectedDate((s) => s.goToday);

  const day = useDayNutrients(date);
  const energy = useDayEnergyFrom(date, day);
  const summary = useEnergySummaryMode();
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
  // Section ids for the sheets opened from the group menu.
  const [summaryId, setSummaryId] = useState<string | null>(null);
  const [mealId, setMealId] = useState<string | null>(null);
  const [savedMealId, setSavedMealId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  // Meal groups listed newest first (view only; the default order is the time the entries were logged).
  const [newestFirst, setNewestFirst] = useState<Record<string, boolean>>({});

  const copyActions = useCopyActions(date);
  const yesterday = addDays(date, -1);
  const yesterdayEntries = useDiaryEntries(yesterday).data;
  const yesterdayByGroup = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of yesterdayEntries ?? []) if (e.mealGroupId) counts[e.mealGroupId] = (counts[e.mealGroupId] ?? 0) + 1;
    return counts;
  }, [yesterdayEntries]);
  const yesterdayCount = yesterdayEntries?.length ?? 0;

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
    ...energySummaryProps(energy, summary.toggle),
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
        entries: sortedEntries(byGroup.get(g.id) ?? [], newestFirst[g.id] === true),
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
  }, [groupsQ.data, day.entries, day.byGroup, newestFirst]);

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
  const sectionById = (id: string | null) => (id === null ? undefined : sections.find((s) => s.id === id));

  const startRecipe = (section: Section) => {
    const draft = buildRecipeDraft(`${section.name} recipe`, section.entries);
    if (!draft) {
      showDiaryToast({ message: 'Nothing in this meal can become a recipe.', tone: 'error' });
      return;
    }
    useRecipeDraft.getState().setDraft(draft);
    go('/recipe/new');
  };

  const groupHandlers = (section: Section): Record<GroupMenuKey, () => void> => {
    const group = section.group;
    return {
      add: () => group && go('/search', { mealGroupId: group.id }),
      'add-saved-meal': () => group && setSavedMealId(section.id),
      'copy-yesterday': () => group && void copyActions.copyYesterdayGroup({ id: group.id, name: group.name }),
      'copy-to-today': () => group && void copyActions.copyGroupToToday({ id: group.id, name: group.name }),
      'copy-group': () =>
        copyActions.copyToClipboard({ kind: 'group', label: section.name, sourceGroupId: group?.id ?? null, entries: section.entries }),
      paste: () => group && void copyActions.pasteClipboard(group.id, section.name),
      'copy-from-day': () => group && setCopyGroup({ id: group.id, name: group.name }),
      'create-recipe': () => startRecipe(section),
      'create-meal': () => setMealId(section.id),
      'nutrition-summary': () => setSummaryId(section.id),
      'sort-time': () => setNewestFirst((c) => ({ ...c, [section.id]: !c[section.id] })),
      collapse: () => toggleGroup(section.id),
      delete: () => setConfirm({ kind: 'delete-group', sectionId: section.id }),
    };
  };

  const dateHandlers: Record<DateMenuKey, () => void> = {
    today: goToday,
    'copy-yesterday-diary': () => {
      // Copying into a day that already has food adds to it: ask first.
      if (day.hasEntries) setConfirm({ kind: 'copy-diary' });
      else void copyActions.copyYesterdayDiary();
    },
    'copy-day': () => setCopyGroup(null),
    'toggle-all': () => {
      const allCollapsed = sections.length > 0 && sections.every((s) => collapsed[s.id]);
      setCollapsed(Object.fromEntries(sections.map((s) => [s.id, !allCollapsed])));
    },
  };

  const menuActions: MenuAction[] = (() => {
    if (!menu) return [];
    if (menu.kind === 'date') {
      const specs = dateMenuItems({
        isToday: date === todayISO(),
        yesterdayCount,
        sectionCount: sections.length,
        allCollapsed: sections.length > 0 && sections.every((s) => collapsed[s.id]),
      });
      return specs.map((spec) => ({ ...spec, onPress: dateHandlers[spec.key] }));
    }
    const section = sectionById(menu.sectionId);
    if (!section) return [];
    const handlers = groupHandlers(section);
    const specs = groupMenuItems({
      name: section.name,
      hasGroup: section.group !== undefined,
      entryCount: section.entries.length,
      yesterdayCount: section.group ? (yesterdayByGroup[section.group.id] ?? 0) : 0,
      isPastDate: isPastDate(date, todayISO()),
      clipboard: copyActions.clipboard,
      collapsed: collapsed[section.id] === true,
      newestFirst: newestFirst[section.id] === true,
    });
    return specs.map((spec) => ({ ...spec, onPress: handlers[spec.key] }));
  })();

  // Sheets and dialogs of the group menu actions (live sections, so they follow undo / refetch).
  const menuSection = menu?.kind === 'group' ? sectionById(menu.sectionId) : undefined;
  const summarySection = sectionById(summaryId);
  const mealSection = sectionById(mealId);
  const savedMealSection = sectionById(savedMealId);
  const confirmSection = confirm?.kind === 'delete-group' ? sectionById(confirm.sectionId) : undefined;
  const deleteCount = confirmSection?.entries.length ?? 0;

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
    <View style={[styles.centered, styles.pad]}>
      <AppText style={{ color: colors.danger }}>Could not load this day.</AppText>
      <AppText variant="small" muted>
        {day.error?.message}
      </AppText>
      <Button label="Try again" variant="secondary" onPress={() => day.refetch()} />
    </View>
  ) : (
    <View>
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
          onMenu={() => openMenu({ kind: 'group', sectionId: section.id })}
          onEntryPress={(entry) => {
            haptic('light');
            setEditingId(entry.id);
          }}
          onEntryLongPress={(entry) => {
            haptic('medium');
            setEditingId(entry.id);
          }}
          onEntryDelete={(entry) => void copyActions.deleteEntry(entry)}
        />
      ))}
      {!day.hasEntries && devices.rows.length === 0 && sections.length === 0 && !groupsQ.isLoading ? (
        <AppText muted style={styles.hint}>
          Nothing logged yet. Tap + to add food.
        </AppText>
      ) : null}
      <WaterRow ml={waterQ.data} target={waterTarget} onAdd={() => go('/water/new', { ml: QUICK_WATER_ML })} />
    </View>
  );

  // Tabs on the plain page background and flat lists under them: no card around any of it.
  const diaryList = (
    <View>
      <DiaryTabs value={tab} onChange={setTab} counts={counts} />
      {tab === 'food' ? (
        foodTab
      ) : tab === 'exercise' ? (
        <View>
          <ExerciseList entries={energy.exercise} />
          <AddRow label="Add exercise" onPress={() => go('/exercise/new')} />
        </View>
      ) : tab === 'biometric' ? (
        <View>
          <BiometricList entries={biometrics} unitSystem={unitSystem} />
          <AddRow label="Add biometric" onPress={() => go('/biometric/new')} />
        </View>
      ) : (
        <View>
          <NotesList entries={notesQ.data ?? []} />
          <AddRow label="Add note" onPress={() => go('/note/new')} />
        </View>
      )}
    </View>
  );

  // Phones: the targets scroll away with the page; only the date bar stays on top.
  const phoneTargets = (
    <View style={[styles.pad, styles.phoneTargets]}>
      <TargetsHeader onPress={() => go('/settings/targets')} />
      <TargetsPager rows={rows} energy={energyProps} highlights={highlights} />
    </View>
  );

  const energyCard = (
    <Card>
      <AppText variant="heading">Energy Summary</AppText>
      <EnergySummary {...energyProps} />
    </Card>
  );

  // Wide windows (beside the sidebar): the page header carries the date controls, the body is the panels of DiaryDesktop.tsx.
  // Phones: the sticky date bar and the single column below.
  const body = wide ? (
    <DesktopPage
      title="Diary"
      right={
        <DateControls
          date={date}
          onPrev={() => shift(-1)}
          onNext={() => shift(1)}
          onToday={goToday}
          onAdd={() => go('/add')}
          onMenu={() => openMenu({ kind: 'date' })}
        />
      }
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}>
      <DesktopDiaryBody
        list={diaryList}
        rows={rows}
        energyProps={energyProps}
        day={day}
        targets={targets}
        netCarbs={netCarbs}
        needsOnboarding={targetsQ.needsOnboarding}
      />
    </DesktopPage>
  ) : (
    <ScrollView
      stickyHeaderIndices={[0]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled">
      <View style={[styles.stickyOuter, { backgroundColor: colors.background, borderBottomColor: colors.border }]}>
        <View style={[styles.inner, styles.pad]}>
          <DateBar
            date={date}
            onPrev={() => shift(-1)}
            onNext={() => shift(1)}
            onToday={goToday}
            onAdd={() => go('/add')}
            onMenu={() => openMenu({ kind: 'date' })}
          />
        </View>
      </View>

      <View style={[styles.inner, styles.body]}>
        {onboardingPrompt ? <View style={styles.pad}>{onboardingPrompt}</View> : null}
        {phoneTargets}
        {diaryList}
        <View style={styles.pad}>{energyCard}</View>
        <View style={styles.pad}>
          <NutrientTargetsPanel
            totals={day.totals}
            hasEntries={day.hasEntries}
            incompleteNutrients={day.incompleteNutrients}
            targets={targets}
            netCarbs={netCarbs}
          />
        </View>
      </View>
    </ScrollView>
  );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      {body}

      <EntryActionSheet
        entryId={editingId}
        date={date}
        groups={(groupsQ.data ?? []).filter((g) => !g.hidden)}
        copyActions={copyActions}
        onClose={() => setEditingId(null)}
      />
      <ActionMenu
        visible={menuVisible}
        title={menu?.kind === 'group' ? (menuSection?.name ?? 'Meal') : 'Diary'}
        actions={menuActions}
        onClose={() => setMenuVisible(false)}
      />
      <CopyDiarySheet
        visible={copyGroup !== undefined}
        targetDate={date}
        group={copyGroup}
        announceCopy={copyActions.announceCopy}
        onClose={() => setCopyGroup(undefined)}
      />
      <NutritionSummarySheet
        visible={summarySection !== undefined}
        name={summarySection?.name ?? 'Meal'}
        entries={summarySection?.entries ?? NO_ENTRIES}
        netCarbs={netCarbs}
        onClose={() => setSummaryId(null)}
      />
      <AddSavedMealSheet
        visible={savedMealSection?.group !== undefined}
        name={savedMealSection?.name ?? 'Meal'}
        mealGroupId={savedMealSection?.group?.id}
        onClose={() => setSavedMealId(null)}
      />
      <SaveMealSheet
        visible={mealSection !== undefined}
        name={mealSection?.name ?? 'Meal'}
        entries={mealSection?.entries ?? NO_ENTRIES}
        onClose={() => setMealId(null)}
      />
      <ConfirmSheet
        visible={confirm?.kind === 'copy-diary'}
        title="Copy yesterday's entire diary?"
        message={`${formatDayLabel(date)} already has ${day.entries.length} ${itemWord(day.entries.length)}. The ${yesterdayCount} ${itemWord(yesterdayCount)} from yesterday are added to them.`}
        confirmLabel={`Copy ${yesterdayCount} ${itemWord(yesterdayCount)}`}
        cancelLabel="Cancel"
        onConfirm={() => void copyActions.copyYesterdayDiary()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmSheet
        visible={confirmSection !== undefined && deleteCount > 0}
        title={`Delete ${confirmSection?.name ?? 'meal'} entries?`}
        message={`This removes ${deleteCount} ${itemWord(deleteCount)} from ${confirmSection?.name ?? 'this meal'} on ${formatDayLabel(date)}. You can undo it right after.`}
        confirmLabel={`Delete ${deleteCount} ${itemWord(deleteCount)}`}
        cancelLabel="Keep"
        destructive
        onConfirm={() => confirmSection && void copyActions.deleteEntries(confirmSection.entries, confirmSection.name)}
        onClose={() => setConfirm(null)}
      />
      <ToastHost />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { flexGrow: 1, paddingBottom: spacing.xxl * 2 },
  stickyOuter: { paddingVertical: spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth },
  // The centred, max-width column. Blocks that need side padding add `pad`; the lists run edge to edge.
  inner: { width: '100%', maxWidth: MAX_CONTENT_WIDTH, alignSelf: 'center' },
  pad: { paddingHorizontal: spacing.lg },
  body: { gap: spacing.md, paddingTop: spacing.sm },
  phoneTargets: { gap: spacing.xs },
  centered: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.lg },
  hint: { textAlign: 'center', paddingVertical: spacing.md },
});
