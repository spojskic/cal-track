import { router, Stack } from 'expo-router';
import { Platform } from 'react-native';

import { ConnectionSummary, IntegrationCard } from '@/components/health';
import { GarminCard } from '@/components/health/GarminCard';
import { Divider, NavRow, Note } from '@/components/settings/rows';
import { AppText, Card, Screen } from '@/components/ui';
import { GARMIN_ENABLED } from '@/health/garmin';
import { providerIdForPlatform } from '@/health/platform';
import { ENERGY_MODE_NOTE, GARMIN_NOTE, WEB_NOTE } from '@/health/settings';

export default function IntegrationsScreen() {
  const providerId = providerIdForPlatform(Platform.OS);

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title: 'Connected Apps & Devices' }} />

      {providerId ? (
        <IntegrationCard providerId={providerId} />
      ) : (
        <Card>
          <AppText variant="heading">Connected Apps & Devices</AppText>
          <Note>{WEB_NOTE}</Note>
          <ConnectionSummary providerId="apple_health" />
          <ConnectionSummary providerId="health_connect" />
          <Divider />
          <Note>{GARMIN_NOTE}</Note>
        </Card>
      )}

      {/* Dormant until Garmin approves the app: the card (and every Garmin call) exists only with EXPO_PUBLIC_GARMIN_ENABLED=true. */}
      {GARMIN_ENABLED ? <GarminCard /> : null}

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
