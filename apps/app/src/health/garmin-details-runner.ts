// Glue between the Garmin detail read (garmin-details.ts, all effects injected), the phone (secure storage, fetch), Supabase and the
// query cache. Safe to call from a screen, from the coach and from the Garmin sync runner (no React involved).
//
//  - One read per workout at a time: asking again while a read is running returns the same promise.
//  - Every read runs through the Garmin gate (garmin-gate.ts), so it never overlaps a sync or another read.
//  - On the web nothing runs (Garmin cannot be read from a browser).
import { GarminConnectClient, type FetchInit, type FetchLike } from '@cal/garmin';
import { Platform } from 'react-native';

import { fetchNewestGarminWorkouts, refreshWorkouts, saveWorkoutDetails } from '@/data/workouts';
import { queryClient } from '@/lib/query';

import { loadLocalState, saveLocalState } from './garmin-local';
import { loadDetailStats, saveDetailStats } from './garmin-detail-local';
import {
  DETAIL_MESSAGES,
  endsBatch,
  ensureGarminDetails,
  pickQuietTargets,
  type DetailOutcome,
  type DetailTarget,
  type GarminDetailDeps,
} from './garmin-details';
import { withGarminGate } from './garmin-gate';
import { clearGarminTokens, loadGarminTokens, saveGarminTokens } from './garmin-tokens';
import { currentUserId, fetchIntegration, saveIntegration } from './integration-store';

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

const nativeFetch: FetchLike = (url: string, init: FetchInit) => fetch(url, init as RequestInit);

function realDeps(): GarminDetailDeps {
  return {
    now: () => Date.now(),
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
    stats: { load: loadDetailStats, save: saveDetailStats },
    // Sequential, paced GETs; a rotated refresh token is saved before the request goes on (packages/garmin client).
    createClient: (tokens, onTokensChanged) => new GarminConnectClient({ fetch: nativeFetch, tokens, onTokensChanged }),
    saveDetails: saveWorkoutDetails,
  };
}

const inFlight = new Map<string, Promise<DetailOutcome>>();

/**
 * Reads the details of a Garmin workout (when they are missing, only the list summary, or stale) and saves them into its row.
 * Resolves with what happened; never rejects. The workout queries are refreshed when something was saved.
 */
export function ensureWorkoutDetails(target: DetailTarget, options: { force?: boolean } = {}): Promise<DetailOutcome> {
  if (!isNative) return Promise.resolve({ status: 'skipped', reason: 'unavailable', message: DETAIL_MESSAGES.unavailable });
  const running = inFlight.get(target.id);
  if (running) return running;
  const run = withGarminGate(() => ensureGarminDetails(realDeps(), target, options))
    .then(async (outcome) => {
      if (outcome.status === 'done') await refreshWorkouts(queryClient, target.id).catch(() => undefined);
      return outcome;
    })
    .finally(() => {
      inFlight.delete(target.id);
    });
  inFlight.set(target.id, run);
  return run;
}

/**
 * After a sync: the details of the three newest Garmin workouts that have none yet, one after the other (paced by the client).
 * Stops at the first problem that would hit the next one too (429, dead session, no network). Never rejects.
 */
export async function fetchNewestDetailsQuietly(limit = 3): Promise<void> {
  if (!isNative) return;
  try {
    const targets = pickQuietTargets(await fetchNewestGarminWorkouts(12), limit);
    for (const target of targets) {
      const outcome = await ensureWorkoutDetails(target);
      if (endsBatch(outcome)) break;
    }
  } catch {
    // quiet by design: a failing background read is not worth telling the user about
  }
}
