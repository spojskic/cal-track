import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';

import { Badge, Divider, KeyValueRow, Note } from '@/components/settings/rows';
import { errorMessage } from '@/components/settings/save-row';
import { AppText, Button, Card } from '@/components/ui';
import { useCopyGarminReport, useGarminConnection, useGarminSignOut, useGarminSyncNow, useGarminSyncStatus } from '@/data/garmin';
import {
  GARMIN_HOW_IT_WORKS,
  GARMIN_IMPORTS_NOTE,
  GARMIN_SIGNED_OUT_NOTE,
  GARMIN_UNOFFICIAL_NOTE,
  GARMIN_WEB_NOTE,
} from '@/health/garmin';
import { spacing } from '@/theme';

import { formatRelativeTime } from './format';

const SIGN_IN_ROUTE = '/settings/garmin-sign-in';

const Header = ({ badge }: { badge?: string }) => (
  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
    <AppText variant="heading" style={{ flex: 1 }}>Garmin</AppText>
    {badge ? <Badge label={badge} tone={badge === 'Connected' ? 'primary' : 'neutral'} /> : null}
  </View>
);

/**
 * "Garmin" card of Connected Apps & Devices. The phone reads Garmin itself (same private interface as Garmin's own mobile app),
 * so it only works in the iPhone and Android app; in a browser the card just says so. Nothing is ever written to Garmin.
 */
export function GarminCard() {
  return Platform.OS === 'ios' || Platform.OS === 'android' ? <GarminNativeCard /> : <GarminWebCard />;
}

function GarminWebCard() {
  return (
    <Card>
      <Header />
      <Note>{GARMIN_WEB_NOTE}</Note>
      <AppText variant="small" muted>{GARMIN_HOW_IT_WORKS}</AppText>
      <Note>{GARMIN_UNOFFICIAL_NOTE}</Note>
    </Card>
  );
}

function GarminNativeCard() {
  const connection = useGarminConnection();
  const status = useGarminSyncStatus();
  const sync = useGarminSyncNow();
  const signOut = useGarminSignOut();
  const copy = useCopyGarminReport();
  const [confirming, setConfirming] = useState(false);

  const { state } = connection;
  const syncing = status.running || sync.isPending;
  const busy = syncing || signOut.isPending;
  const signIn = () => router.push(SIGN_IN_ROUTE);

  const onSignOut = (deleteData: boolean) =>
    signOut.mutate({ deleteData }, { onSuccess: () => setConfirming(false) });

  const signOutControls = confirming ? (
    <View style={{ gap: spacing.sm }}>
      <AppText variant="body">Sign out of Garmin?</AppText>
      <AppText variant="small" muted>
        Cal Track removes the Garmin token from this phone and stops reading Garmin. Choose whether the Garmin data already imported stays in your diary. To end the session on Garmin&apos;s side too, remove it in your Garmin account settings.
      </AppText>
      <Button label="Sign out, keep imported data" variant="secondary" onPress={() => onSignOut(false)} loading={signOut.isPending} disabled={busy} />
      <Button label="Sign out and delete Garmin data" variant="primary" onPress={() => onSignOut(true)} disabled={busy} />
      <Button label="Cancel" variant="ghost" onPress={() => setConfirming(false)} disabled={busy} />
    </View>
  ) : (
    <Button label="Sign out" variant="ghost" onPress={() => setConfirming(true)} disabled={busy} />
  );

  const copyReport = (
    <View style={{ gap: spacing.xs }}>
      <Button
        label="Copy sync report"
        variant="secondary"
        onPress={() => copy.mutate()}
        loading={copy.isPending}
        disabled={busy}
      />
      <AppText variant="small" muted>
        A plain-text report of the last sync: which Garmin requests worked and which fields were found. No health values and no tokens. Paste it back if something is missing.
      </AppText>
      {copy.isSuccess ? (
        <AppText variant="small" style={{ textAlign: 'center' }} accessibilityLiveRegion="polite">
          {copy.data ? 'Report copied.' : 'Nothing to copy yet. Run a sync first.'}
        </AppText>
      ) : null}
      {copy.error ? <Note tone="danger">{errorMessage(copy.error)}</Note> : null}
    </View>
  );

  return (
    <Card>
      <Header badge={state === 'connected' ? 'Connected' : state === 'needs_sign_in' ? 'Sign-in needed' : undefined} />

      {connection.isLoading ? (
        <ActivityIndicator accessibilityLabel="Checking Garmin" />
      ) : connection.error ? (
        <>
          <Note tone="danger">{errorMessage(connection.error)}</Note>
          <Button label="Try again" variant="secondary" onPress={connection.refetch} />
        </>
      ) : state === 'connected' ? (
        <>
          <KeyValueRow label="Last sync" value={connection.lastSyncAt ? formatRelativeTime(connection.lastSyncAt) : 'Never'} />
          {syncing ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }} accessibilityLiveRegion="polite">
              <ActivityIndicator accessibilityLabel="Syncing Garmin" />
              <AppText variant="small" muted style={{ flex: 1 }}>{status.message ?? 'Syncing Garmin...'}</AppText>
            </View>
          ) : connection.summary ? (
            <Note tone={connection.local.lastIssue ? 'warning' : 'success'}>{`Last result: ${connection.summary}.`}</Note>
          ) : (
            <Note>{status.lastOutcome ? 'Last result: no new data.' : 'No result yet. Tap Sync now.'}</Note>
          )}
          {!syncing && connection.local.lastIssue ? <Note tone="warning">{connection.local.lastIssue}</Note> : null}
          <Button label="Sync now" onPress={() => sync.mutate()} loading={syncing} disabled={busy} />
          {sync.error && !connection.local.lastIssue ? <Note tone="danger">{errorMessage(sync.error)}</Note> : null}
          {copyReport}
          <Divider />
          {signOutControls}
          <Note>{GARMIN_UNOFFICIAL_NOTE}</Note>
        </>
      ) : state === 'needs_sign_in' ? (
        <>
          <Note tone="warning">{GARMIN_SIGNED_OUT_NOTE}</Note>
          <Button label="Sign in to Garmin again" onPress={signIn} disabled={busy} />
          {copyReport}
          <Divider />
          {signOutControls}
        </>
      ) : (
        <>
          <AppText variant="small" muted>
            See the calories your Garmin watch burned, steps, heart rate, sleep, stress and weight next to what you eat.
          </AppText>
          <Note>{GARMIN_HOW_IT_WORKS}</Note>
          <Button label="Connect Garmin" onPress={signIn} disabled={busy} />
          <AppText variant="small" muted>{GARMIN_IMPORTS_NOTE}</AppText>
          <Note>{GARMIN_UNOFFICIAL_NOTE}</Note>
        </>
      )}

      {signOut.error ? <Note tone="danger">{errorMessage(signOut.error)}</Note> : null}
    </Card>
  );
}
