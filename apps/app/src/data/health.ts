// react-query hooks for the device health sync (Apple Health / Health Connect). The platform work lives in src/health.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  connectProvider,
  disconnectProvider,
  updateIntegrationSettings,
  type ConnectInput,
  type SettingsChange,
} from '@/health/actions';
import {
  registerHealthBackgroundTask,
  unregisterHealthBackgroundTask,
} from '@/health/background';
import { fetchIntegration, type IntegrationRow } from '@/health/integration-store';
import type { SyncMode } from '@/health/plan';
import { runHealthSync, type SyncOutcome } from '@/health/runner';
import { parseSettings, type HealthIntegrationSettings } from '@/health/settings';
import { useHealthSyncStore } from '@/health/status';
import type { HealthProviderId, LocalDate } from '@/health/types';

import { useUserId } from './profile';

export type { HealthIntegrationSettings, IntegrationRow, SyncOutcome };

export const integrationKey = (provider: HealthProviderId | null, userId: string | undefined) =>
  ['integrations', provider ?? 'none', userId ?? 'anon'] as const;

/** The signed-in user's `integrations` row for a provider (null until they connect). */
export function useIntegration(provider: HealthProviderId | null) {
  const userId = useUserId();
  return useQuery({
    queryKey: integrationKey(provider, userId),
    enabled: Boolean(userId && provider),
    queryFn: async (): Promise<IntegrationRow | null> => {
      if (!userId || !provider) return null;
      return fetchIntegration(provider, userId);
    },
  });
}

export interface LastSyncInfo {
  connected: boolean;
  settings: HealthIntegrationSettings;
  /** `integrations.last_sync_at` */
  lastSyncAt: Date | null;
  /** e.g. '12 days of energy, 5 workouts, 3 weights' */
  summary: string | null;
  backfillDate: LocalDate | null;
}

/** Parsed settings + last-sync information of an integration row. */
export function useLastSyncInfo(provider: HealthProviderId | null): LastSyncInfo & { isLoading: boolean } {
  const query = useIntegration(provider);
  const row = query.data;
  return useMemo(() => {
    const settings = parseSettings(row?.settings);
    return {
      isLoading: query.isLoading,
      connected: Boolean(row?.enabled),
      settings,
      lastSyncAt: row?.last_sync_at ? new Date(row.last_sync_at) : null,
      summary: settings.lastSummary,
      backfillDate: row?.backfill_date ?? null,
    };
  }, [row, query.isLoading]);
}

function useCacheRow(provider: HealthProviderId) {
  const qc = useQueryClient();
  const userId = useUserId();
  return (row: IntegrationRow) => qc.setQueryData(integrationKey(provider, userId), row);
}

/** Asks the platform for access and saves the integration as enabled. Does not sync (call useSyncNow next). */
export function useConnectIntegration(provider: HealthProviderId) {
  const setRow = useCacheRow(provider);
  return useMutation({
    mutationFn: (input?: ConnectInput) => connectProvider(input),
    onSuccess: ({ row }) => {
      setRow(row);
      if (row.enabled) void registerHealthBackgroundTask();
    },
  });
}

/** Saves toggles and/or the backfill date; asks for permission for newly enabled types when connected. */
export function useUpdateIntegrationSettings(provider: HealthProviderId) {
  const setRow = useCacheRow(provider);
  return useMutation({
    mutationFn: (change: SettingsChange) => updateIntegrationSettings(change),
    onSuccess: setRow,
  });
}

/** Stops syncing; imported rows are kept. */
export function useDisconnectIntegration(provider: HealthProviderId) {
  const setRow = useCacheRow(provider);
  return useMutation({
    mutationFn: () => disconnectProvider(),
    onSuccess: (row) => {
      setRow(row);
      void unregisterHealthBackgroundTask();
    },
  });
}

export interface SyncNowInput {
  /** 'incremental' (default) re-reads the last days; 'backfill' re-reads from the backfill date. */
  mode?: SyncMode;
  /** Backfill start; saved to the integration. */
  backfillDate?: LocalDate;
}

/** Runs a sync now with progress in {@link useHealthSyncStatus}. Rejects with a readable message when nothing synced. */
export function useSyncNow() {
  return useMutation({
    mutationFn: async (input: SyncNowInput = {}): Promise<Extract<SyncOutcome, { status: 'done' }>> => {
      const outcome = await runHealthSync({
        mode: input.mode ?? 'incremental',
        trigger: 'manual',
        interactive: true,
        backfillDate: input.backfillDate,
      });
      if (outcome.status === 'done') return outcome;
      if (outcome.status === 'failed') throw new Error(outcome.error);
      throw new Error(skipMessage(outcome));
    },
  });
}

function skipMessage(outcome: Extract<SyncOutcome, { status: 'skipped' }>): string {
  switch (outcome.reason) {
    case 'busy':
      return 'A sync is already running.';
    case 'signed_out':
      return 'You are signed out. Please sign in again.';
    case 'not_connected':
      return 'Connect first, then sync.';
    case 'no_types':
      return 'Choose at least one kind of data to import.';
    case 'unavailable':
      return outcome.message ?? 'Health sync is not available on this device.';
  }
}

/** Live progress / last result of the sync (also reflects foreground and background runs of this session). */
export function useHealthSyncStatus() {
  return useHealthSyncStore();
}
