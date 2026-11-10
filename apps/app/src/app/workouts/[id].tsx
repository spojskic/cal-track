import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Note } from '@/components/settings/rows';
import { AppText, Button, Screen } from '@/components/ui';
import { DetailsStatus } from '@/components/workouts/DetailsStatus';
import { LapsCard, SetsCard, SummaryCards, ZonesCard } from '@/components/workouts/DetailCards';
import { DiscussWithCoach } from '@/components/workouts/DiscussWithCoach';
import { WORKOUTS_HREF } from '@/components/workouts/links';
import { useWorkoutDetailsRead } from '@/components/workouts/use-workout-details-read';
import type { ExerciseEntry } from '@/data/activity';
import { useDeleteActivity } from '@/data/diary-activity';
import { useUnitSystem } from '@/data/profile';
import { refreshWorkouts, useWorkout, type WorkoutEntry } from '@/data/workouts';
import { errorMessage } from '@/data/foods';
import { spacing } from '@/theme';

function idOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** One workout: summary, heart rate and zones, training effect, strength sets, and a button to talk about it with the coach. */
export default function WorkoutDetailScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = idOf(params.id);
  const query = useWorkout(id);
  const entry = query.data ?? null;
  const system = useUnitSystem();
  const read = useWorkoutDetailsRead(entry);

  const title = entry?.name ?? 'Workout';

  let body;
  if (query.isPending && query.fetchStatus !== 'idle') {
    body = <ActivityIndicator style={styles.state} />;
  } else if (query.isError) {
    body = (
      <View style={styles.state}>
        <AppText muted>Could not load this workout.</AppText>
        <Button label="Try again" variant="secondary" onPress={() => void query.refetch()} />
      </View>
    );
  } else if (!entry) {
    body = (
      <View style={styles.state}>
        <AppText variant="heading">Workout not found</AppText>
        <AppText muted>It may have been deleted.</AppText>
        <Button label="Back to workouts" variant="secondary" onPress={() => router.replace(WORKOUTS_HREF)} />
      </View>
    );
  } else {
    body = (
      <>
        <DiscussWithCoach workoutId={entry.id} />
        <DetailsStatus state={read} />
        <SummaryCards entry={entry} system={system} />
        <ZonesCard details={entry.details} />
        <SetsCard details={entry.details} system={system} />
        <LapsCard details={entry.details} system={system} />
        <Footer entry={entry} />
      </>
    );
  }

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title }} />
      {body}
    </Screen>
  );
}

/** Device workouts are read-only (the next sync would bring them back); manual ones can be deleted. */
function Footer({ entry }: { entry: WorkoutEntry }) {
  if (entry.source !== 'manual') {
    return (
      <AppText variant="small" muted>
        This workout comes from {entry.source === 'garmin' ? 'Garmin' : entry.source === 'apple_health' ? 'Apple Health' : 'Health Connect'} and cannot be edited here.
      </AppText>
    );
  }
  return <DeleteWorkout entry={entry} />;
}

function toDiaryRow(entry: WorkoutEntry): ExerciseEntry {
  return {
    id: entry.id,
    entry_date: entry.entry_date,
    activity_code: entry.activity_code,
    name: entry.name,
    minutes: entry.minutes,
    kcal: entry.kcal,
    source: entry.source,
    external_id: entry.external_id,
    started_at: entry.started_at,
    ended_at: entry.ended_at,
    counts_toward_energy: entry.counts_toward_energy,
  };
}

function DeleteWorkout({ entry }: { entry: WorkoutEntry }) {
  const qc = useQueryClient();
  const remove = useDeleteActivity();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onDelete = async () => {
    setError(null);
    try {
      await remove.mutateAsync({ kind: 'exercise', row: toDiaryRow(entry) });
    } catch (e) {
      setError(errorMessage(e));
      return;
    }
    await refreshWorkouts(qc);
    if (router.canGoBack()) router.back();
    else router.replace(WORKOUTS_HREF);
  };

  if (!confirming) {
    return <Button label="Delete workout" variant="secondary" onPress={() => setConfirming(true)} />;
  }
  return (
    <View style={styles.confirm}>
      <Note tone="danger">Delete this workout from your diary? This cannot be undone here.</Note>
      {error ? <Note tone="danger">{error}</Note> : null}
      <Button label="Yes, delete it" loading={remove.isPending} onPress={() => void onDelete()} />
      <Button label="Cancel" variant="ghost" onPress={() => setConfirming(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  state: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xl },
  confirm: { gap: spacing.sm },
});
