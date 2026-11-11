// react-query hooks for the Garmin link. The phone reads Garmin itself (src/health/garmin*.ts, packages/garmin); there is no
// server side. On the web nothing runs: no query is enabled and no Garmin code is called.
import { useMutation, useQuery } from '@tanstack/react-query';
import { formatDetailReport } from '@ration/garmin';
import { Platform } from 'react-native';

import {
  GARMIN_NO_REPORT,
  EMPTY_LOCAL_STATE,
  deriveGarminState,
  parseGarminSettings,
  type GarminConnectionState,
  type GarminLocalState,
} from '@/health/garmin';
import { signOutGarmin } from '@/health/garmin-actions';
import { loadDetailStats } from '@/health/garmin-detail-local';
import { loadLocalState } from '@/health/garmin-local';
import { runGarminSync } from '@/health/garmin-runner';
import { useGarminSyncStore } from '@/health/garmin-status';
import { hasGarminTokens } from '@/health/garmin-tokens';
import { copyText } from '@/lib/copy-text';

import { useIntegration } from './health';
import { useUserId } from './profile';

const NATIVE = Platform.OS === 'ios' || Platform.OS === 'android';

/** Includes the user id so a cached answer never leaks across accounts (same convention as integrationKey). */
export const garminTokensKey = (userId: string | undefined) => ['garmin', 'tokens', userId ?? 'anon'] as const;
export const garminLocalKey = ['garmin', 'local'] as const;

export interface GarminConnection {
  state: GarminConnectionState;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
  /** `integrations.last_sync_at` of the Garmin row: only a run that finished moves it. */
  lastSyncAt: Date | null;
  /** Sentence of the last run that wrote something, e.g. '14 days of energy, 3 workouts'. */
  summary: string | null;
  /** Kept on this phone only: last problem, rate-limit time, last sync report. */
  local: GarminLocalState;
}

/** What the card shows: the integration row of the signed-in user, the tokens of THIS phone, and the phone-local state. */
export function useGarminConnection(): GarminConnection {
  const userId = useUserId();
  const row = useIntegration(NATIVE ? 'garmin' : null);
  const tokens = useQuery({
    queryKey: garminTokensKey(userId),
    enabled: NATIVE && Boolean(userId),
    queryFn: async () => (userId ? hasGarminTokens(userId) : false),
  });
  const local = useQuery({ queryKey: garminLocalKey, enabled: NATIVE, queryFn: loadLocalState });

  const state = deriveGarminState({ native: NATIVE, row: row.data ?? null, hasTokens: tokens.data === true });
  const settings = parseGarminSettings(row.data?.settings);
  return {
    state,
    isLoading: NATIVE && (row.isLoading || tokens.isLoading),
    error: row.error ?? tokens.error,
    refetch: () => {
      void row.refetch();
      void tokens.refetch();
      void local.refetch();
    },
    lastSyncAt: row.data?.last_sync_at ? new Date(row.data.last_sync_at) : null,
    summary: settings.lastSummary,
    local: local.data ?? EMPTY_LOCAL_STATE,
  };
}

/** Live progress / last outcome of the Garmin sync (also reflects foreground and background runs of this session). */
export function useGarminSyncStatus() {
  return useGarminSyncStore();
}

/** Runs an incremental sync now. Rejects with a readable message when nothing synced (or only part of it did). */
export function useGarminSyncNow() {
  return useMutation({
    mutationFn: async () => {
      const outcome = await runGarminSync({ mode: 'incremental', trigger: 'manual' });
      if (outcome.status === 'done') return outcome;
      throw new Error(outcome.status === 'failed' ? outcome.error : outcome.message);
    },
  });
}

/**
 * Removes the Garmin token from this phone and switches the integration off. With `deleteData` the rows imported from Garmin
 * are deleted from the account too; otherwise they stay in the diary.
 */
export function useGarminSignOut() {
  return useMutation({ mutationFn: (input: { deleteData: boolean }) => signOutGarmin(input) });
}

/**
 * Copies the plain-text report of the last sync (endpoints, HTTP outcomes, fields found / not found; no values, no tokens), followed
 * by a "Workout details" section when workout details have been read on this phone (which endpoints, what they answered).
 */
export function useCopyGarminReport() {
  return useMutation({
    mutationFn: async (): Promise<boolean> => {
      const local = await loadLocalState();
      const details = formatDetailReport(await loadDetailStats().catch(() => null));
      await copyText([local.report ?? GARMIN_NO_REPORT, details].filter(Boolean).join('\n\n'));
      return local.report !== null || details !== '';
    },
  });
}
