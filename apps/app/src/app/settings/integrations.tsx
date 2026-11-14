import { router, Stack } from 'expo-router';
import { Platform } from 'react-native';

import { ConnectionSummary, IntegrationCard } from '@/components/health';
import { GarminCard } from '@/components/health/GarminCard';
import { Divider, NavRow, Note } from '@/components/settings/rows';
import { AppText, Card, Screen } from '@/components/ui';
import { providerIdForPlatform } from '@/health/platform';
import { orderConnections, ENERGY_MODE_NOTE, GARMIN_NOTE, WEB_NOTE } from '@/health/settings';
import { useGarminConnection } from '@/data/garmin';
import { useLastSyncInfo } from '@/data/health';

export default function IntegrationsScreen() {
  const providerId = providerIdForPlatform(Platform.OS);
  const garmin = useGarminConnection();
  const platform = useLastSyncInfo(providerId);

  // Connected services first: the user must not scroll past a card to reach the one they actually use.
  const cards = orderConnections([
    { key: 'platform', connected: platform.connected, lastSyncAt: platform.lastSyncAt },
    { key: 'garmin', connected: garmin.state === 'connected', lastSyncAt: garmin.lastSyncAt ?? null },
  ]);

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title: 'Connected Apps & Devices' }} />

      {cards.map((card) =>
        card.key === 'platform' ? (
          providerId ? (
            <IntegrationCard key="platform" providerId={providerId} />
          ) : (
            <Card key="platform">
              <AppText variant="heading">Connected Apps & Devices</AppText>
              <Note>{WEB_NOTE}</Note>
              <ConnectionSummary providerId="apple_health" />
              <ConnectionSummary providerId="health_connect" />
              <Divider />
              <Note>{GARMIN_NOTE}</Note>
            </Card>
          )
        ) : (
          /* Native: connect / sync / sign out. Web: says that Garmin sync runs in the iPhone and Android app. */
          <GarminCard key="garmin" />
        ),
      )}

      <Card>
        <AppText variant="heading">Energy mode</AppText>
        <AppText variant="small" muted>{ENERGY_MODE_NOTE}</AppText>
        <Divider />
        <NavRow
          label="Profile & targets"
          description="Open the Energy mode setting"
          onPress={() => router.push('/settings/targets')}
        />
      </Card>
    </Screen>
  );
}
