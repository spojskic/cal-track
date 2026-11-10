import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, View } from 'react-native';

import { Badge, Divider, KeyValueRow, Note } from '@/components/settings/rows';
import { errorMessage } from '@/components/settings/save-row';
import { AppText, Button, Card } from '@/components/ui';
import { switchToDeviceEnergyMode } from '@/data/energy-mode-notice';
import {
  useConnectIntegration,
  useDisconnectIntegration,
  useHealthSyncStatus,
  useLastSyncInfo,
  useSyncNow,
  useUpdateIntegrationSettings,
} from '@/data/health';
import { todayLocal } from '@/health/dates';
import { getHealthProvider } from '@/health/provider';
import {
  DEFAULT_TOGGLES,
  GARMIN_NOTE,
  PROVIDER_LABELS,
  defaultBackfillDate,
  enabledTypes,
  type HealthToggles,
} from '@/health/settings';
import type { HealthDataType, HealthProviderId } from '@/health/types';
import { spacing } from '@/theme';

import { BackfillControls } from './BackfillControls';
import { DataTypeChecklist } from './DataTypeChecklist';
import { formatRelativeTime, validateBackfillDate } from './format';
import { SyncStatusPanel } from './SyncStatusPanel';
import { UnavailableNotice } from './UnavailableNotice';
import { useProviderAvailability } from './use-availability';

const HEALTH_CONNECT_HISTORY_NOTE =
  'Health Connect only lets Cal Track read the 30 days before you first connected, unless you grant "Access past data" when asked. Backfill dates older than that are skipped.';
const HEALTH_CONNECT_MANAGE_NOTE =
  'Cal Track can only read what you allowed in Health Connect. To change it, open Health Connect > App permissions > Cal Track.';
const APPLE_HEALTH_NOTE =
  'Apple Health does not tell apps which categories you allowed. If something stays empty, check Health > Sharing > Apps > Cal Track.';

/** "Connected Apps & Devices" card of one platform provider: toggles, backfill, sync now, disconnect, last sync. */
export function IntegrationCard({ providerId }: { providerId: HealthProviderId }) {
  const label = PROVIDER_LABELS[providerId];
  const { availability } = useProviderAvailability();
  const info = useLastSyncInfo(providerId);
  const syncStatus = useHealthSyncStatus();
  const connect = useConnectIntegration(providerId);
  const update = useUpdateIntegrationSettings(providerId);
  const disconnect = useDisconnectIntegration(providerId);
  const sync = useSyncNow();

  const today = todayLocal();
  const [draft, setDraft] = useState<HealthToggles>(DEFAULT_TOGGLES);
  const [backfillText, setBackfillText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const initialised = useRef(false);

  // Seed the local fields once the saved integration has loaded.
  useEffect(() => {
    if (info.isLoading || initialised.current) return;
    initialised.current = true;
    setDraft(info.settings.toggles);
    setBackfillText(info.backfillDate ?? defaultBackfillDate(today));
  }, [info, today]);

  const validation = useMemo(() => validateBackfillDate(backfillText, today), [backfillText, today]);
  const toggles: HealthToggles = info.connected
    ? { ...info.settings.toggles, ...(update.isPending ? update.variables?.toggles : undefined) }
    : draft;
  const syncing = syncStatus.running || sync.isPending;
  const busy = syncing || connect.isPending || disconnect.isPending;

  const onToggle = (type: HealthDataType, value: boolean) => {
    setNote(null);
    if (info.connected) update.mutate({ toggles: { [type]: value } });
    else setDraft((current) => ({ ...current, [type]: value }));
  };

  const onConnect = async () => {
    setNote(null);
    if (enabledTypes(draft).length === 0) {
      setNote('Choose at least one kind of data to import.');
      return;
    }
    try {
      const { row, nothingGranted } = await connect.mutateAsync({
        toggles: draft,
        backfillDate: validation.value ?? undefined,
      });
      if (nothingGranted || !row.enabled) {
        setNote(`${label} did not grant access to any of the selected data. Try again and allow access when asked.`);
        return;
      }
      sync.mutate({ mode: 'backfill', backfillDate: validation.value ?? undefined });
      void switchToDeviceEnergyMode();
    } catch {
      // shown through connect.error
    }
  };

  const onDisconnect = () => {
    const run = () => disconnect.mutate();
    if (Platform.OS === 'web') return run();
    Alert.alert(
      `Disconnect ${label}?`,
      `Cal Track stops importing from ${label}. Data already imported stays in your diary. To revoke access completely, remove Cal Track in the ${label} app.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Disconnect', style: 'destructive', onPress: run },
      ],
    );
  };

  const provider = getHealthProvider();
  const lastSync = info.lastSyncAt ? formatRelativeTime(info.lastSyncAt) : 'Never';

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <AppText variant="heading" style={{ flex: 1 }}>{label}</AppText>
        {info.connected ? <Badge label="Connected" tone="primary" /> : null}
      </View>

      {availability === null || info.isLoading ? (
        <ActivityIndicator accessibilityLabel={`Checking ${label}`} />
      ) : !availability.available ? (
        <UnavailableNotice availability={availability} />
      ) : (
        <>
          <AppText variant="small" muted>
            {info.connected
              ? 'Choose what Cal Track imports. Changes apply to the next sync.'
              : `Choose what to import, then connect. Cal Track only asks ${label} for the data you tick.`}
          </AppText>

          <DataTypeChecklist toggles={toggles} onToggle={onToggle} disabled={busy} />

          <Divider />

          <BackfillControls
            value={backfillText}
            onChange={setBackfillText}
            validation={validation}
            hint={
              providerId === 'health_connect'
                ? HEALTH_CONNECT_HISTORY_NOTE
                : 'Default is 14 days back. Older history can take a moment to import.'
            }
            onBackfill={
              info.connected
                ? () => sync.mutate({ mode: 'backfill', backfillDate: validation.value ?? undefined })
                : undefined
            }
            busy={syncing}
            disabled={busy}
          />

          {info.connected ? (
            <>
              <Button label="Sync now" onPress={() => sync.mutate({ mode: 'incremental' })} loading={syncing} disabled={busy} />
              <KeyValueRow label="Last sync" value={lastSync} hint={info.summary ?? undefined} />
              <Button label="Disconnect" variant="ghost" onPress={onDisconnect} disabled={busy} loading={disconnect.isPending} />
            </>
          ) : (
            <Button
              label={`Connect ${label}`}
              onPress={onConnect}
              loading={connect.isPending}
              disabled={busy || validation.value === null}
            />
          )}

          <SyncStatusPanel providerLabel={label} />

          {note ? <Note tone="warning">{note}</Note> : null}
          {connect.error ? <Note tone="danger">{errorMessage(connect.error)}</Note> : null}
          {update.error ? <Note tone="danger">{errorMessage(update.error)}</Note> : null}
          {disconnect.error ? <Note tone="danger">{errorMessage(disconnect.error)}</Note> : null}
          {sync.error && !syncStatus.lastError ? <Note tone="danger">{errorMessage(sync.error)}</Note> : null}

          <Note>{providerId === 'apple_health' ? APPLE_HEALTH_NOTE : HEALTH_CONNECT_MANAGE_NOTE}</Note>
          {provider.openSystemSettings ? (
            <Button
              label={providerId === 'apple_health' ? 'Open the Health app' : 'Open Health Connect settings'}
              variant="ghost"
              onPress={() => provider.openSystemSettings?.()}
            />
          ) : null}
        </>
      )}

      <Divider />
      <Note>{GARMIN_NOTE}</Note>
    </Card>
  );
}
