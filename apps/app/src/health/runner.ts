// Glue between the platform provider, the pure sync and Supabase. Safe to call from the foreground, from the
// bootstrap hook and from the background task (no React involved). Single-flight: a second call while one is running
// returns `skipped: busy`.
import { queryClient } from '@/lib/query';
import { keys } from '@/data/keys';

import { todayLocal } from './dates';
import { currentUserId, fetchIntegration, saveIntegration, type IntegrationRow } from './integration-store';
import { needsExtendedHistory, planSyncRange, type SyncMode } from './plan';
import { getHealthProvider } from './provider';
import { DATA_TYPE_INFO, defaultBackfillDate, enabledTypes, parseSettings, serializeSettings } from './settings';
import { useHealthSyncStore } from './status';
import { errorText, runSync } from './sync';
import type { HealthProvider, HealthProviderId, LocalDate, SyncResult } from './types';
import { createSupabaseWriter } from './writer';

export type SyncTrigger = 'manual' | 'foreground' | 'background';

export interface RunHealthSyncOptions {
  mode: SyncMode;
  trigger: SyncTrigger;
  /** Show the permission prompt for types that still need it. Foreground only. */
  interactive?: boolean;
  /** Backfill start. Saved to `integrations.backfill_date` when it differs. */
  backfillDate?: LocalDate;
}

export type SkipReason = 'unavailable' | 'signed_out' | 'not_connected' | 'no_types' | 'busy';

export type SyncOutcome =
  | { status: 'skipped'; reason: SkipReason; message?: string }
  | { status: 'done'; provider: HealthProviderId; result: SyncResult; warnings: string[] }
  | { status: 'failed'; provider: HealthProviderId; error: string; result?: SyncResult; warnings: string[] };

/** Everything that can display health data. */
export function invalidateHealthQueries(): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['day'] }),
    queryClient.invalidateQueries({ queryKey: ['integrations'] }),
    queryClient.invalidateQueries({ queryKey: ['biometrics'] }),
    queryClient.invalidateQueries({ queryKey: keys.latestWeight }),
    queryClient.invalidateQueries({ queryKey: keys.targets }),
  ]);
}

let inFlight: Promise<SyncOutcome> | null = null;

export function runHealthSync(options: RunHealthSyncOptions): Promise<SyncOutcome> {
  if (inFlight) return Promise.resolve({ status: 'skipped', reason: 'busy' });
  const run = execute(options).finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return run;
}

/** Cheap check used by the bootstrap hook: is the platform provider connected for the signed-in user? */
export async function isHealthConnected(): Promise<boolean> {
  try {
    const provider = getHealthProvider();
    if (!(await provider.isAvailable())) return false;
    const userId = await currentUserId();
    if (!userId) return false;
    return Boolean((await fetchIntegration(provider.id, userId))?.enabled);
  } catch {
    return false;
  }
}

async function execute(options: RunHealthSyncOptions): Promise<SyncOutcome> {
  const provider = getHealthProvider();
  const availability = await provider.getAvailability();
  if (!availability.available) return { status: 'skipped', reason: 'unavailable', message: availability.message };

  const userId = await currentUserId();
  if (!userId) return { status: 'skipped', reason: 'signed_out' };

  let row: IntegrationRow | null;
  try {
    row = await fetchIntegration(provider.id, userId);
  } catch (error) {
    return { status: 'failed', provider: provider.id, error: errorText(error), warnings: [] };
  }
  if (!row?.enabled) return { status: 'skipped', reason: 'not_connected' };

  const settings = parseSettings(row.settings);
  const wanted = enabledTypes(settings.toggles);
  if (wanted.length === 0) return { status: 'skipped', reason: 'no_types' };

  const store = useHealthSyncStore.getState();
  store.start(provider.id, options.trigger);
  const warnings: string[] = [];

  try {
    const { types, warnings: permissionWarnings } = await resolveTypes(provider, wanted, options.interactive === true);
    warnings.push(...permissionWarnings);
    if (types.length === 0) {
      const error = 'Ration has no permission to read the selected data. Review the access in your health app.';
      useHealthSyncStore.getState().finish(provider.id, null, error, warnings);
      return { status: 'failed', provider: provider.id, error, warnings };
    }

    const backfillDate = options.backfillDate ?? row.backfill_date ?? null;
    if (options.backfillDate && options.backfillDate !== row.backfill_date) {
      row = await saveIntegration(userId, provider.id, { backfill_date: options.backfillDate });
    }

    // A backfill reaching past the platform's default window (Health Connect: 30 days) needs the history permission.
    let extendedHistory = settings.extendedHistory;
    const today = todayLocal();
    if (
      options.interactive &&
      options.mode === 'backfill' &&
      !extendedHistory &&
      needsExtendedHistory(provider.historyLimitDays, backfillDate ?? defaultBackfillDate(today), today)
    ) {
      const asked = await provider.requestPermissions(types, { wantHistory: true });
      if (asked.extendedHistoryRequested) {
        extendedHistory = true;
        row = await saveIntegration(userId, provider.id, {
          settings: serializeSettings({ ...settings, extendedHistory: true }, row.settings),
        });
      }
    }

    const plan = planSyncRange({
      mode: options.mode,
      today,
      backfillDate,
      lastSyncAt: row.last_sync_at,
      historyLimitDays: provider.historyLimitDays,
      extendedHistory,
      connectedAt: settings.connectedAt,
    });
    warnings.push(...plan.warnings);

    const result = await runSync({
      provider,
      writer: createSupabaseWriter(),
      userId,
      types,
      range: plan.range,
      onProgress: (progress) => useHealthSyncStore.getState().setProgress(progress),
    });

    if (result.steps.total > 0 && result.steps.succeeded === 0) {
      const error = result.issues[0]?.message ?? 'Nothing could be read from your health data.';
      useHealthSyncStore.getState().finish(provider.id, result, error, warnings);
      return { status: 'failed', provider: provider.id, error, result, warnings };
    }

    // Only advance last_sync_at when everything worked, so a transient failure is retried over the same days.
    const summary = result.ok ? result.summary : `${result.summary} (some data could not be read)`;
    await saveIntegration(userId, provider.id, {
      settings: serializeSettings({ ...settings, lastSummary: summary }, row.settings),
      ...(result.ok ? { last_sync_at: new Date().toISOString() } : {}),
    });
    await invalidateHealthQueries();
    useHealthSyncStore.getState().finish(provider.id, result, null, warnings);
    return { status: 'done', provider: provider.id, result, warnings };
  } catch (error) {
    const message = errorText(error);
    useHealthSyncStore.getState().finish(provider.id, null, message, warnings);
    return { status: 'failed', provider: provider.id, error: message, warnings };
  }
}

/** Which of the wanted types may be read; prompts for the missing ones when allowed to. */
async function resolveTypes(
  provider: HealthProvider,
  wanted: ReturnType<typeof enabledTypes>,
  interactive: boolean,
) {
  const warnings: string[] = [];
  let permission = await provider.checkPermissions(wanted);
  if (permission.missingTypes.length > 0 && interactive) {
    await provider.requestPermissions(permission.missingTypes);
    permission = await provider.checkPermissions(wanted);
  }
  if (permission.missingTypes.length > 0) {
    const labels = permission.missingTypes.map((t) => DATA_TYPE_INFO[t].label).join(', ');
    warnings.push(`No permission yet for: ${labels}.`);
  }
  return { types: permission.grantedTypes, warnings };
}
