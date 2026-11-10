// Background + app-start health sync.
//
// IMPORTANT: this module must be imported at startup (e.g. from the root layout) so `TaskManager.defineTask` runs at
// module scope - an app launched in the background mounts no components. It is safe on web / Expo Go: everything is
// guarded by Platform and try/catch.
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';

import { supabase } from '@/lib/supabase';

import { isDueByInterval } from './garmin';
import { isGarminConnected, runGarminSync } from './garmin-runner';
import { isHealthConnected, runHealthSync } from './runner';

export const HEALTH_BACKGROUND_TASK = 'cal-track-health-sync';
/** The OS treats this as a minimum (15 min on Android, much longer on iOS in practice). */
const BACKGROUND_INTERVAL_MINUTES = 15;
/** Foreground syncs triggered by app start / returning to the app are throttled to this. */
export const FOREGROUND_SYNC_MIN_INTERVAL_MS = 10 * 60 * 1000;

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

if (isNative) {
  try {
    TaskManager.defineTask(HEALTH_BACKGROUND_TASK, async () => {
      try {
        const outcome = await runHealthSync({ mode: 'incremental', trigger: 'background', interactive: false });
        // Garmin (read straight from Garmin by the phone) after Apple Health / Health Connect, never in parallel. A Garmin run
        // that was refused (sign in again, slow down) is not a failure of the task: the card says what to do.
        const garmin = await runGarminSync({ mode: 'incremental', trigger: 'background' });
        const garminFailed = garmin.status === 'failed' && (garmin.code === 'other' || garmin.code === 'write_failed');
        return outcome.status === 'failed' || garminFailed
          ? BackgroundTask.BackgroundTaskResult.Failed
          : BackgroundTask.BackgroundTaskResult.Success;
      } catch {
        return BackgroundTask.BackgroundTaskResult.Failed;
      }
    });
  } catch {
    // Task manager unavailable (Expo Go on Android): foreground sync still works.
  }
}

/** Schedules the periodic background sync. Best effort: returns false when the platform refuses (Expo Go, simulator). */
export async function registerHealthBackgroundTask(): Promise<boolean> {
  if (!isNative) return false;
  try {
    if ((await BackgroundTask.getStatusAsync()) !== BackgroundTask.BackgroundTaskStatus.Available) return false;
    if (await TaskManager.isTaskRegisteredAsync(HEALTH_BACKGROUND_TASK)) return true;
    await BackgroundTask.registerTaskAsync(HEALTH_BACKGROUND_TASK, { minimumInterval: BACKGROUND_INTERVAL_MINUTES });
    return true;
  } catch {
    return false;
  }
}

export async function unregisterHealthBackgroundTask(): Promise<void> {
  if (!isNative) return;
  try {
    if (await TaskManager.isTaskRegisteredAsync(HEALTH_BACKGROUND_TASK)) {
      await BackgroundTask.unregisterTaskAsync(HEALTH_BACKGROUND_TASK);
    }
  } catch {
    // nothing to clean up
  }
}

let lastForegroundSyncAt = 0;
let lastGarminForegroundSyncAt: number | null = null;

/** Incremental sync (last days) if connected and the last foreground sync was at least ~10 minutes ago. */
export async function syncIfDue(now: number = Date.now()): Promise<void> {
  if (!isNative) return;
  if (now - lastForegroundSyncAt < FOREGROUND_SYNC_MIN_INTERVAL_MS) return;
  lastForegroundSyncAt = now;
  try {
    const outcome = await runHealthSync({ mode: 'incremental', trigger: 'foreground', interactive: false });
    if (outcome.status === 'skipped' && outcome.reason === 'busy') lastForegroundSyncAt = 0; // retry on next foreground
  } catch {
    // errors are reported through the sync status store; never crash the app from here
  }
}

/**
 * The same for Garmin, with its own throttle: an incremental run (last ~3 days) when Garmin is connected and the last foreground
 * run was at least ~10 minutes ago. A Garmin 429 additionally keeps runs away until the time Garmin asked for.
 */
export async function syncGarminIfDue(now: number = Date.now()): Promise<void> {
  if (!isNative) return;
  if (!isDueByInterval(lastGarminForegroundSyncAt, now, FOREGROUND_SYNC_MIN_INTERVAL_MS)) return;
  lastGarminForegroundSyncAt = now;
  try {
    const outcome = await runGarminSync({ mode: 'incremental', trigger: 'foreground' });
    if (outcome.status === 'skipped' && outcome.reason === 'busy') lastGarminForegroundSyncAt = null; // retry on next foreground
  } catch {
    // errors are reported through the Garmin status store; never crash the app from here
  }
}

/**
 * Mount once near the root (inside the auth + query providers):
 *  (a) on start and every time the app returns to the foreground, runs an incremental sync (last ~3 days, at most once
 *      per ~10 minutes) for each connected source: the platform health store (Apple Health / Health Connect) and Garmin;
 *  (b) makes sure the periodic background task is registered while either is connected.
 */
export function useHealthBootstrap(): void {
  useEffect(() => {
    if (!isNative) return;
    let cancelled = false;

    const syncConnected = async (registerTask: boolean) => {
      const [health, garmin] = await Promise.all([isHealthConnected(), isGarminConnected()]);
      if (cancelled) return;
      if (registerTask && (health || garmin)) void registerHealthBackgroundTask();
      if (health) void syncIfDue();
      if (garmin) void syncGarminIfDue();
    };
    void syncConnected(true);

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void syncConnected(false);
    });
    // Signing in after app start: pick the connection up without waiting for the next foreground. Deferred because
    // supabase-js must not be called synchronously from inside its own auth callback.
    const { data: auth } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') setTimeout(() => void syncConnected(true), 0);
    });
    return () => {
      cancelled = true;
      subscription.remove();
      auth.subscription.unsubscribe();
    };
  }, []);
}
