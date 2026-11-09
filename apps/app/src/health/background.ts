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
        return outcome.status === 'failed'
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
 * Mount once near the root (inside the auth + query providers):
 *  (a) on start and every time the app returns to the foreground, runs an incremental sync (last ~3 days, at most once
 *      per ~10 minutes) when a health provider is connected;
 *  (b) makes sure the periodic background task is registered while connected.
 */
export function useHealthBootstrap(): void {
  useEffect(() => {
    if (!isNative) return;
    let cancelled = false;

    const start = async () => {
      if (!(await isHealthConnected()) || cancelled) return;
      void registerHealthBackgroundTask();
      void syncIfDue();
    };
    void start();

    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void isHealthConnected().then((connected) => {
        if (connected && !cancelled) void syncIfDue();
      });
    });
    // Signing in after app start: pick the connection up without waiting for the next foreground. Deferred because
    // supabase-js must not be called synchronously from inside its own auth callback.
    const { data: auth } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') setTimeout(() => void start(), 0);
    });
    return () => {
      cancelled = true;
      subscription.remove();
      auth.subscription.unsubscribe();
    };
  }, []);
}
