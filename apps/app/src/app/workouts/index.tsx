import { router, Stack, type Href } from 'expo-router';
import { useMemo, useState, type ReactElement } from 'react';
import { ActivityIndicator, FlatList, Platform, RefreshControl, StyleSheet, View } from 'react-native';

import { ChipRow } from '@/components/workouts/FilterChips';
import { flattenSections, groupWorkouts, type ListItem } from '@/components/workouts/groups';
import { KIND_LABELS, availableKinds, filterByKind, type WorkoutKind } from '@/components/workouts/kinds';
import { sourceFilters, type SourceFilter } from '@/components/workouts/format';
import { WorkoutListRow } from '@/components/workouts/WorkoutListRow';
import { workoutHref } from '@/components/workouts/links';
import { AppText, Button } from '@/components/ui';
import { useWorkouts, type WorkoutRow } from '@/data/workouts';
import { todayLocal } from '@/health/dates';
import { MAX_CONTENT_WIDTH, spacing, useTheme } from '@/theme';

const SETTINGS_INTEGRATIONS = '/settings/integrations' as unknown as Href;

/** Workouts list: every exercise entry (manual and from a device), newest first, grouped by week and month. */
export default function WorkoutsScreen() {
  const { colors } = useTheme();
  const [source, setSource] = useState<SourceFilter>('all');
  const [kind, setKind] = useState<WorkoutKind | 'all'>('all');
  const query = useWorkouts(source);

  const rows = useMemo<WorkoutRow[]>(() => query.data?.pages.flat() ?? [], [query.data]);
  const kinds = useMemo(() => availableKinds(rows), [rows]);
  // A kind that is not in the loaded rows any more (another source was picked) simply stops filtering.
  const activeKind: WorkoutKind | 'all' = kind !== 'all' && kinds.some((k) => k.kind === kind) ? kind : 'all';
  const visible = useMemo(() => filterByKind(rows, activeKind), [rows, activeKind]);
  const items = useMemo(() => flattenSections(groupWorkouts(visible, todayLocal())), [visible]);

  const sourceItems = useMemo(() => sourceFilters(Platform.OS), []);
  const kindItems = useMemo(
    () => [{ key: 'all' as const, label: 'All types' }, ...kinds.map((k) => ({ key: k.kind, label: KIND_LABELS[k.kind] }))],
    [kinds],
  );

  const header = (
    <View style={styles.filters}>
      <ChipRow items={sourceItems} value={source} onChange={setSource} label="Filter by source" />
      {kinds.length >= 2 ? <ChipRow items={kindItems} value={activeKind} onChange={setKind} label="Filter by type" /> : null}
    </View>
  );

  const footer = query.isFetchingNextPage ? (
    <ActivityIndicator style={styles.footer} color={colors.primary} />
  ) : query.hasNextPage ? (
    <View style={styles.footer}>
      <Button label="Load more" variant="ghost" onPress={() => void query.fetchNextPage()} />
    </View>
  ) : null;

  let empty: ReactElement | undefined;
  if (query.isPending) {
    empty = <ActivityIndicator style={styles.state} color={colors.primary} />;
  } else if (query.isError) {
    empty = (
      <View style={styles.state}>
        <AppText muted style={styles.centered}>
          Could not load your workouts.
        </AppText>
        <Button label="Try again" variant="secondary" onPress={() => void query.refetch()} />
      </View>
    );
  } else if (rows.length === 0) {
    empty = (
      <View style={styles.state}>
        <AppText muted style={styles.centered}>
          {source === 'all' ? 'No workouts yet. Log one or connect Garmin.' : 'No workouts from this source yet.'}
        </AppText>
        {source === 'all' ? (
          <View style={styles.actions}>
            <Button label="Log a workout" onPress={() => router.push('/exercise/new')} />
            <Button label="Connect Garmin" variant="secondary" onPress={() => router.push(SETTINGS_INTEGRATIONS)} />
          </View>
        ) : null}
      </View>
    );
  } else if (visible.length === 0) {
    empty = (
      <View style={styles.state}>
        <AppText muted style={styles.centered}>
          No workouts of this type among the ones loaded.
        </AppText>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: true, title: 'Workouts' }} />
      <FlatList
        data={items}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => <ListEntry item={item} />}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        ListFooterComponent={footer ?? undefined}
        onEndReached={() => {
          if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
        }}
        onEndReachedThreshold={0.6}
        refreshControl={<RefreshControl refreshing={query.isRefetching && !query.isFetchingNextPage} onRefresh={() => void query.refetch()} tintColor={colors.primary} />}
        contentContainerStyle={styles.content}
      />
    </View>
  );
}

function ListEntry({ item }: { item: ListItem<WorkoutRow> }) {
  const { colors } = useTheme();
  if (item.type === 'header') {
    return (
      <View style={[styles.sectionHeader, { backgroundColor: colors.surfaceAlt }]} accessibilityRole="header">
        <AppText variant="label" muted>
          {item.title}
        </AppText>
        <AppText variant="small" muted>
          {item.count}
        </AppText>
      </View>
    );
  }
  return <WorkoutListRow row={item.row} onPress={() => router.push(workoutHref(item.row.id))} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { width: '100%', maxWidth: MAX_CONTENT_WIDTH, alignSelf: 'center', paddingBottom: spacing.xxl },
  filters: { gap: spacing.xs, paddingVertical: spacing.md },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs + 2,
  },
  state: { alignItems: 'center', gap: spacing.md, padding: spacing.xl },
  centered: { textAlign: 'center' },
  actions: { alignSelf: 'stretch', gap: spacing.sm },
  footer: { padding: spacing.lg, alignItems: 'center' },
});
