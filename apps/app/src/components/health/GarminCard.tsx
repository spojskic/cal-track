import { useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Badge, Divider, KeyValueRow, Note } from '@/components/settings/rows';
import { errorMessage } from '@/components/settings/save-row';
import { AppText, Button, Card } from '@/components/ui';
import { garminStatusKey, useConnectGarmin, useDisconnectGarmin, useGarminStatus } from '@/data/garmin';
import { useUserId } from '@/data/profile';
import {
  GARMIN_PAST_DATA_NOTE,
  GARMIN_PRIVACY_NOTE,
  describeGarminReturn,
  describeLastError,
  describeLastPush,
  parseGarminReturn,
} from '@/health/garmin';
import { spacing } from '@/theme';

import { formatRelativeTime } from './format';

const formatDay = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '-';

/**
 * "Garmin Connect" card of Connected Apps & Devices. Rendered only when EXPO_PUBLIC_GARMIN_ENABLED=true (see
 * app/settings/integrations.tsx): one tap on Connect opens Garmin's sign-in, the server stores the link, and Garmin then
 * pushes data whenever the watch syncs. There is no key to paste anywhere.
 */
export function GarminCard() {
  const userId = useUserId();
  const queryClient = useQueryClient();
  const status = useGarminStatus();
  const connect = useConnectGarmin();
  const disconnect = useDisconnectGarmin();
  const [confirming, setConfirming] = useState(false);

  // Web: Garmin sends the browser back to .../settings/integrations?garmin=connected | error&reason=...
  const params = useLocalSearchParams<{ garmin?: string; reason?: string }>();
  const fromUrl = parseGarminReturn(params);
  const returned = connect.data ?? fromUrl;
  const message = returned ? describeGarminReturn(returned) : null;

  const returnedStatus = fromUrl?.status;
  const refetchStatus = status.refetch;
  useEffect(() => {
    if (returnedStatus) void refetchStatus();
  }, [returnedStatus, refetchStatus]);

  const data = status.data;
  const busy = connect.isPending || disconnect.isPending;

  const onConnect = () => {
    setConfirming(false);
    router.setParams({ garmin: undefined, reason: undefined });
    connect.mutate();
  };

  const onDisconnect = (deleteData: boolean) => {
    disconnect.mutate(
      { deleteData },
      {
        onSuccess: () => {
          setConfirming(false);
          connect.reset();
          router.setParams({ garmin: undefined, reason: undefined });
          // show "not connected" immediately instead of waiting for the refetch
          queryClient.setQueryData(garminStatusKey(userId), { connected: false, connectedAt: null, lastPushAt: null, lastError: null });
        },
      },
    );
  };

  const lastError = describeLastError(data?.lastError ?? null);

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <AppText variant="heading" style={{ flex: 1 }}>Garmin Connect</AppText>
        {data?.connected ? <Badge label="Connected" tone="primary" /> : null}
      </View>

      {message ? <Note tone={message.tone}>{message.text}</Note> : null}

      {status.isLoading ? (
        <ActivityIndicator accessibilityLabel="Checking Garmin" />
      ) : status.error ? (
        <Note tone="danger">{errorMessage(status.error)}</Note>
      ) : data?.connected ? (
        <>
          <KeyValueRow label="Connected since" value={formatDay(data.connectedAt)} />
          <KeyValueRow label="Last data received" value={describeLastPush(data.lastPushAt, formatRelativeTime)} />
          {lastError ? <Note tone="warning">{lastError}</Note> : null}
          <Note>{GARMIN_PAST_DATA_NOTE}</Note>

          {confirming ? (
            <View style={{ gap: spacing.sm }}>
              <AppText variant="body">Disconnect Garmin?</AppText>
              <AppText variant="small" muted>
                Cal Track stops receiving data and deletes the link to your Garmin account. Choose whether the Garmin data already imported stays in your diary.
              </AppText>
              <Button label="Disconnect, keep imported data" variant="secondary" onPress={() => onDisconnect(false)} loading={disconnect.isPending} disabled={busy} />
              <Button label="Disconnect and delete Garmin data" variant="primary" onPress={() => onDisconnect(true)} disabled={busy} />
              <Button label="Cancel" variant="ghost" onPress={() => setConfirming(false)} disabled={busy} />
            </View>
          ) : (
            <Button label="Disconnect" variant="ghost" onPress={() => setConfirming(true)} disabled={busy} />
          )}
        </>
      ) : (
        <>
          <AppText variant="small" muted>
            See the calories your Garmin watch burned, steps, heart rate, sleep, stress and body battery next to what you eat.
          </AppText>
          <Button label="Connect Garmin" onPress={onConnect} loading={connect.isPending} disabled={busy} />
          <Note>{GARMIN_PAST_DATA_NOTE}</Note>
        </>
      )}

      {connect.error ? <Note tone="danger">{errorMessage(connect.error)}</Note> : null}
      {disconnect.error ? <Note tone="danger">{errorMessage(disconnect.error)}</Note> : null}

      <Divider />
      <Note>{GARMIN_PRIVACY_NOTE}</Note>
    </Card>
  );
}
