import { needsGarminDetails } from '@ration/garmin';

import { selectComparable } from '@/components/workouts/kinds';
import { fetchWorkout, fetchWorkoutsUpTo, type WorkoutEntry } from '@/data/workouts';
import { ensureWorkoutDetails } from '@/health/garmin-details-runner';

import { buildWorkoutContext, type PreviousWorkout } from './workout-context-text';

/** How long a coach turn waits for a lazy read of a Garmin workout's details (the read goes on in the background and is saved). */
const LAZY_READ_TIMEOUT_MS = 3500;
/** After a read that failed (offline, rate limited, signed out), the next turns do not wait for another one for this long. */
const RETRY_AFTER_FAILURE_MS = 5 * 60_000;

const failedAt = new Map<string, number>();

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** The details of a Garmin workout, read now when they are missing or stale and the read is quick enough. */
async function withFreshDetails(entry: WorkoutEntry): Promise<WorkoutEntry> {
  const now = Date.now();
  if (!needsGarminDetails(entry, now)) return entry;
  const failed = failedAt.get(entry.id);
  if (failed !== undefined && now - failed < RETRY_AFTER_FAILURE_MS) return entry;
  const outcome = await withTimeout(ensureWorkoutDetails(entry), LAZY_READ_TIMEOUT_MS);
  if (outcome?.status === 'done') {
    failedAt.delete(entry.id);
    return { ...entry, details: outcome.details };
  }
  // A timeout (null) is not a failure: the read finishes in the background and is saved. Anything else that brought nothing is one.
  if (outcome !== null && !(outcome.status === 'skipped' && outcome.reason === 'fresh')) failedAt.set(entry.id, now);
  return entry;
}

/** The user's earlier workouts of the same kind (at most three, newest first), or none when they cannot be loaded. */
async function previousOfSameKind(entry: WorkoutEntry): Promise<PreviousWorkout[]> {
  try {
    const candidates = await fetchWorkoutsUpTo(entry.entry_date);
    const current = {
      id: entry.id,
      name: entry.name,
      activity_code: entry.activity_code,
      type_key: entry.details?.typeKey ?? null,
      entry_date: entry.entry_date,
      started_at: entry.started_at,
    };
    return selectComparable(current, candidates, 3).map((w) => ({
      entry_date: w.entry_date,
      started_at: w.started_at,
      minutes: w.minutes,
      kcal: w.kcal,
      avg_hr: w.avg_hr,
    }));
  } catch {
    return [];
  }
}

/**
 * Everything known about one workout as compact plain text for the coach (type, date and local time, duration, kcal, source, heart
 * rate and zones, training effect, distance / pace, strength sets per exercise, the user's previous workouts of the same type, and
 * what is NOT known). `id` is an `exercise_entries.id`. Null when the id is not a workout of the signed-in user (or cannot be read).
 *
 * A Garmin workout whose details were never read gets one quick read first (3.5 s at most); once the details are saved, later
 * calls (every turn of the chat) only read the database. No account name, e-mail, notes or tokens are included. Never throws.
 */
export async function loadWorkoutCoachContext(id: string): Promise<string | null> {
  try {
    const found = await fetchWorkout(id);
    if (!found) return null;
    const entry = await withFreshDetails(found);
    const previous = await previousOfSameKind(entry);
    return buildWorkoutContext({ workout: entry, previous });
  } catch {
    return null;
  }
}
