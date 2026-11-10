import type { Href } from 'expo-router';

// Typed routes are generated from the files of src/app when the dev server runs, so a route added in the same change is not known to
// the compiler yet; the casts keep this compiling before and after (same as `COACH` in app/(app)/more.tsx).

/** `/workouts`: the list. */
export const WORKOUTS_HREF = '/workouts' as unknown as Href;

/** `/workouts/<exercise_entries id>`: one workout. */
export const workoutHref = (id: string): Href => `/workouts/${id}` as unknown as Href;

/**
 * `/coach` with the topic the coach opens on: a chat about one workout. The coach screen reads exactly these two search params:
 * `topicKind=workout` and `topicId=<exercise_entries id>`.
 */
export const discussWorkoutHref = (id: string): Href =>
  ({ pathname: '/coach', params: { topicKind: 'workout', topicId: id } }) as unknown as Href;
