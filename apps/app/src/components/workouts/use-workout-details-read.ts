import { needsGarminDetails } from '@ration/garmin';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Platform } from 'react-native';

import type { WorkoutEntry } from '@/data/workouts';
import { ensureWorkoutDetails } from '@/health/garmin-details-runner';
import type { DetailFailCode, DetailSkipReason } from '@/health/garmin-details';

export type DetailsReadState =
  /** Nothing to read (not a Garmin workout, the details are fresh, or this is a browser). */
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string; reason: DetailFailCode | DetailSkipReason; retry: () => void };

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

/**
 * Lazily reads the details of a Garmin workout from Garmin when the screen opens (details missing, only the list summary, or older
 * than a day on a recent workout), saves them into the row and lets the screen refetch. Shows loading and a clear error.
 */
export function useWorkoutDetailsRead(entry: WorkoutEntry | null | undefined): DetailsReadState {
  // "Now" at the moment the screen opened: the decision to read must not flip while the screen is open.
  const [openedAt] = useState(() => Date.now());
  const wants = Boolean(entry) && isNative && needsGarminDetails(entry as WorkoutEntry, openedAt);
  const query = useQuery({
    queryKey: ['workouts', 'details-read', entry?.id ?? 'none'],
    enabled: wants,
    // Not a cache of Garmin data: the answer ("could not read it") must not outlive the screen, not even through the persisted
    // query cache, so every opening of the screen asks again (a fresh workout answers "nothing to read" without any request).
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    queryFn: () => ensureWorkoutDetails(entry as WorkoutEntry),
  });

  if (!wants) return { status: 'idle' };
  const retry = () => void query.refetch();
  if (query.isFetching || (query.isPending && !query.isError)) return { status: 'loading' };
  const outcome = query.data;
  if (!outcome) return { status: 'error', message: 'Could not read the details from Garmin. Try again later.', reason: 'other', retry };
  if (outcome.status === 'failed') return { status: 'error', message: outcome.message, reason: outcome.code, retry };
  if (outcome.status === 'skipped' && outcome.reason !== 'fresh') return { status: 'error', message: outcome.message, reason: outcome.reason, retry };
  return { status: 'idle' };
}
