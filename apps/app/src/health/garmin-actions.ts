// Sign in to / sign out of Garmin. Foreground only (the sign-in screen and the card call these).
import { redeemServiceTicket, type FetchInit, type FetchLike } from '@cal/garmin';

import { keys } from '@/data/keys';
import { requireUserId } from '@/lib/auth-user';
import { queryClient } from '@/lib/query';
import { supabase } from '@/lib/supabase';

import { registerHealthBackgroundTask, unregisterHealthBackgroundTask } from './background';
import { parseGarminSettings, serializeGarminSettings } from './garmin';
import { clearLocalState } from './garmin-local';
import { invalidateGarminQueries, runGarminSync } from './garmin-runner';
import { clearGarminTokens, saveGarminTokens } from './garmin-tokens';
import { fetchIntegration, saveIntegration } from './integration-store';
import { isHealthConnected } from './runner';

const nativeFetch: FetchLike = (url: string, init: FetchInit) => fetch(url, init as RequestInit);

/**
 * The web view handed us the single-use ticket of Garmin's own sign-in page: trade it ONCE for the token pair, keep the pair in
 * this phone's secure storage, switch the integration on and start the first sync (the last 14 days, paced) in the background.
 * Throws a GarminError (userMessage is safe to show) when Garmin refuses the ticket.
 */
export async function completeGarminSignIn(ticket: string): Promise<void> {
  const userId = await requireUserId();
  const tokens = await redeemServiceTicket(nativeFetch, ticket);
  await saveGarminTokens(userId, tokens);
  await clearLocalState().catch(() => undefined); // a new session: forget an old rate-limit time and report

  const existing = await fetchIntegration('garmin', userId);
  const settings = parseGarminSettings(existing?.settings);
  await saveIntegration(userId, 'garmin', {
    enabled: true,
    last_sync_at: null,
    settings: serializeGarminSettings(
      { connectedAt: settings.connectedAt ?? new Date().toISOString(), needsSignIn: false, lastSummary: settings.lastSummary },
      existing?.settings,
    ),
  });
  void registerHealthBackgroundTask();
  await invalidateGarminQueries();
  // Not awaited: the card shows the progress, the user goes back to it.
  void runGarminSync({ mode: 'backfill', trigger: 'signin' });
}

const GARMIN_TABLES = ['daily_energy', 'exercise_entries', 'biometrics'] as const;

/**
 * Removes the Garmin token from this phone and switches the integration off. With `deleteData` the rows imported from Garmin
 * (source = 'garmin') are deleted from the user's account too; otherwise they stay in the diary. The token is removed FIRST, so
 * a network problem while deleting cannot leave a working Garmin session behind.
 */
export async function signOutGarmin(options: { deleteData: boolean }): Promise<void> {
  const userId = await requireUserId();
  await clearGarminTokens();
  await clearLocalState().catch(() => undefined);

  if (options.deleteData) {
    for (const table of GARMIN_TABLES) {
      const { error } = await supabase.from(table).delete().eq('user_id', userId).eq('source', 'garmin');
      if (error) throw error;
    }
  }
  const existing = await fetchIntegration('garmin', userId);
  await saveIntegration(userId, 'garmin', {
    enabled: false,
    last_sync_at: null,
    settings: serializeGarminSettings({ connectedAt: null, needsSignIn: false, lastSummary: null }, existing?.settings),
  });

  if (!(await isHealthConnected())) await unregisterHealthBackgroundTask();
  await invalidateGarminQueries();
  if (options.deleteData) {
    // imported rows feed the diary, the energy numbers, the weight chart and the coach
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['day'] }),
      queryClient.invalidateQueries({ queryKey: ['biometrics'] }),
      queryClient.invalidateQueries({ queryKey: keys.latestWeight }),
    ]);
  }
}
