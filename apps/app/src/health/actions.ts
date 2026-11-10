// Connect / change settings / disconnect. Foreground only (they show permission prompts).
import { todayLocal } from './dates';
import { needsExtendedHistory } from './plan';
import {
  currentUserId,
  fetchIntegration,
  saveIntegration,
  type IntegrationRow,
} from './integration-store';
import { getHealthProvider } from './provider';
import {
  DEFAULT_TOGGLES,
  defaultBackfillDate,
  enabledTypes,
  newlyEnabled,
  parseSettings,
  serializeSettings,
  type HealthToggles,
} from './settings';
import { friendlyPermissionError } from './errors';
import type { HealthProvider, LocalDate } from './types';

const SIGNED_OUT = 'You are signed out. Please sign in again.';

async function requireUser(): Promise<string> {
  const userId = await currentUserId();
  if (!userId) throw new Error(SIGNED_OUT);
  return userId;
}

async function requireProvider(): Promise<HealthProvider> {
  const provider = getHealthProvider();
  const availability = await provider.getAvailability();
  if (!availability.available) throw new Error(availability.message ?? 'Health sync is not available on this device.');
  return provider;
}

export interface ConnectInput {
  toggles?: HealthToggles;
  backfillDate?: LocalDate;
}

export interface ConnectResult {
  row: IntegrationRow;
  /** The platform prompt finished but granted nothing readable (Health Connect only; HealthKit cannot tell). */
  nothingGranted: boolean;
}

/** Asks for the permissions of the toggled types, then saves the integration as enabled. */
export async function connectProvider(input: ConnectInput = {}): Promise<ConnectResult> {
  const provider = await requireProvider();
  const userId = await requireUser();
  const existing = await fetchIntegration(provider.id, userId);
  const current = parseSettings(existing?.settings);
  const toggles = input.toggles ?? current.toggles ?? DEFAULT_TOGGLES;
  const types = enabledTypes(toggles);
  if (types.length === 0) throw new Error('Choose at least one kind of data to import.');

  const backfillDate = input.backfillDate ?? existing?.backfill_date ?? defaultBackfillDate(todayLocal());
  let permission: Awaited<ReturnType<HealthProvider['requestPermissions']>>;
  try {
    permission = await provider.requestPermissions(types, {
      wantHistory: needsExtendedHistory(provider.historyLimitDays, backfillDate, todayLocal()),
    });
  } catch (error) {
    throw friendlyPermissionError(error);
  }

  const row = await saveIntegration(userId, provider.id, {
    enabled: permission.granted,
    backfill_date: backfillDate,
    settings: serializeSettings(
      {
        ...current,
        toggles,
        connectedAt: current.connectedAt ?? new Date().toISOString(),
        extendedHistory: current.extendedHistory || permission.extendedHistoryRequested === true,
      },
      existing?.settings,
    ),
  });
  return { row, nothingGranted: !permission.granted };
}

export interface SettingsChange {
  toggles?: Partial<HealthToggles>;
  /** null clears the backfill date (falls back to the 14-day default). */
  backfillDate?: LocalDate | null;
}

/** Saves toggles / backfill date; asks for permission for newly enabled types when already connected. */
export async function updateIntegrationSettings(change: SettingsChange): Promise<IntegrationRow> {
  const provider = getHealthProvider();
  const userId = await requireUser();
  const existing = await fetchIntegration(provider.id, userId);
  const current = parseSettings(existing?.settings);
  const nextToggles: HealthToggles = { ...current.toggles, ...change.toggles };

  if (existing?.enabled) {
    const added = newlyEnabled(current.toggles, nextToggles);
    if (added.length > 0) {
      await requireProvider();
      await provider.requestPermissions(added);
    }
  }

  return saveIntegration(userId, provider.id, {
    settings: serializeSettings({ ...current, toggles: nextToggles }, existing?.settings),
    ...(change.backfillDate !== undefined ? { backfill_date: change.backfillDate } : {}),
  });
}

/** Stops syncing. Already imported rows stay; access is revoked in the system health app. */
export async function disconnectProvider(): Promise<IntegrationRow> {
  const provider = getHealthProvider();
  const userId = await requireUser();
  return saveIntegration(userId, provider.id, { enabled: false });
}
