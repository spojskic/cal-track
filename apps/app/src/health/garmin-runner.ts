// Glue between the Garmin pull sync (garmin-sync.ts, all effects injected), the phone (secure storage, fetch), Supabase and the
// status store. Safe to call from the foreground, from the bootstrap hook and from the background task (no React involved).
// Single-flight: a second call while one is running returns `skipped: busy`.
//
// Garmin is a SECOND integration next to Apple Health / Health Connect: its own `integrations` row (provider = 'garmin'), its own
// status store, its own single-flight. Daily energy of both can exist for a day; data/energy.ts prefers the 'garmin' row.
import { GarminConnectClient, type FetchInit, type FetchLike } from '@cal/garmin';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { queryClient } from '@/lib/query';

import { todayLocal } from './dates';
import { fetchNewestDetailsQuietly } from './garmin-details-runner';
import { withGarminGate } from './garmin-gate';
import { executeGarminSync, type GarminDeps, type GarminOutcome } from './garmin-sync';
import { loadLocalState, saveLocalState } from './garmin-local';
import { useGarminSyncStore, type GarminTrigger } from './garmin-status';
import { clearGarminTokens, hasGarminTokens, loadGarminTokens, saveGarminTokens } from './garmin-tokens';
import { parseGarminSettings, type GarminSyncMode } from './garmin';
import { currentUserId, fetchIntegration, saveIntegration } from './integration-store';
import { invalidateHealthQueries } from './runner';
import { errorText } from './sync';
import { createSupabaseWriter } from './writer';

export type { GarminTrigger };

export interface RunGarminSyncOptions {
  mode: GarminSyncMode;
  trigger: GarminTrigger;
}

export type GarminRunOutcome = GarminOutcome | { status: 'skipped'; reason: 'busy' | 'unavailable'; message: string };

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

/** React Native's fetch (the global one) as the package's injectable fetch. */
const nativeFetch: FetchLike = (url: string, init: FetchInit) => fetch(url, init as RequestInit);

export function appInfo(): string {
  return `Cal Track ${Constants.expoConfig?.version ?? '?'} (${Platform.OS})`;
}

/** Everything that can display Garmin data or the Garmin card (the Workouts list and detail included). */
export async function invalidateGarminQueries(): Promise<void> {
  await Promise.all([
    invalidateHealthQueries(),
    queryClient.invalidateQueries({ queryKey: ['garmin'] }),
    queryClient.invalidateQueries({ queryKey: ['workouts'] }),
  ]);
}

function realDeps(): GarminDeps {
  return {
    now: () => Date.now(),
    today: () => todayLocal(),
    userId: currentUserId,
    integration: {
      load: async (userId) => {
        const row = await fetchIntegration('garmin', userId);
        return row ? { enabled: row.enabled, settings: row.settings, last_sync_at: row.last_sync_at } : null;
      },
      save: async (userId, patch) => {
        const row = await saveIntegration(userId, 'garmin', patch);
        return { enabled: row.enabled, settings: row.settings, last_sync_at: row.last_sync_at };
      },
    },
    tokens: { load: loadGarminTokens, save: saveGarminTokens, clear: clearGarminTokens },
    local: { load: loadLocalState, save: saveLocalState },
    // Sequential, paced GETs; a rotated refresh token is saved before the request goes on (packages/garmin client).
    createClient: (tokens, onTokensChanged) => new GarminConnectClient({ fetch: nativeFetch, tokens, onTokensChanged }),
    writer: createSupabaseWriter(),
    appInfo: appInfo(),
    onProgress: (message) => useGarminSyncStore.getState().setMessage(message),
  };
}

let inFlight: Promise<GarminRunOutcome> | null = null;

export function runGarminSync(options: RunGarminSyncOptions): Promise<GarminRunOutcome> {
  if (!isNative) {
    return Promise.resolve({ status: 'skipped', reason: 'unavailable', message: 'Garmin sync runs in the iPhone and Android app.' });
  }
  if (inFlight) return Promise.resolve({ status: 'skipped', reason: 'busy', message: 'A Garmin sync is already running.' });
  // Through the Garmin gate: a workout-detail read that is running finishes first, and no read starts while the sync is running.
  const run = withGarminGate(() => execute(options)).finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return run;
}

async function execute(options: RunGarminSyncOptions): Promise<GarminRunOutcome> {
  const store = useGarminSyncStore.getState();
  store.start(options.trigger);
  let outcome: GarminOutcome;
  try {
    outcome = await executeGarminSync(realDeps(), { mode: options.mode });
  } catch (error) {
    // A storage or database problem before the pull even started. The message never contains a token.
    outcome = { status: 'failed', code: 'other', error: errorText(error), summary: null, counts: { energyDays: 0, workouts: 0, biometrics: {} }, range: null };
  }
  useGarminSyncStore.getState().finish(outcome);
  if (outcome.status !== 'skipped') await invalidateGarminQueries();
  // Quietly read the details (heart rate, zones, sets) of the newest workouts that have none. Not from the background task: it has
  // little time, and a workout's details are read when it is opened anyway.
  if (outcome.status === 'done' && options.trigger !== 'background') void fetchNewestDetailsQuietly();
  return outcome;
}

/** Cheap check for the bootstrap hook: enabled for the signed-in user, signed in on this phone, not waiting for a new sign-in. */
export async function isGarminConnected(): Promise<boolean> {
  if (!isNative) return false;
  try {
    const userId = await currentUserId();
    if (!userId) return false;
    const row = await fetchIntegration('garmin', userId);
    if (!row?.enabled || parseGarminSettings(row.settings).needsSignIn) return false;
    return await hasGarminTokens(userId);
  } catch {
    return false;
  }
}
