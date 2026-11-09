import { Linking, View } from 'react-native';

import { Note } from '@/components/settings/rows';
import { AppText, Button } from '@/components/ui';
import { spacing } from '@/theme';
import type { ProviderAvailability } from '@/health/types';

const PLAY_STORE_MARKET = 'market://details?id=com.google.android.apps.healthdata';
const PLAY_STORE_WEB = 'https://play.google.com/store/apps/details?id=com.google.android.apps.healthdata';

/** Explains why the health store cannot be used and, for Health Connect, how to install or update it. */
export function UnavailableNotice({ availability }: { availability: ProviderAvailability }) {
  const needsPlayStore = availability.reason === 'not_installed' || availability.reason === 'update_required';
  const openStore = () => {
    Linking.openURL(PLAY_STORE_MARKET).catch(() => {
      Linking.openURL(PLAY_STORE_WEB).catch(() => {});
    });
  };
  return (
    <View style={{ gap: spacing.md }}>
      <Note tone="warning">{availability.message ?? 'Health sync is not available on this device.'}</Note>
      {needsPlayStore ? (
        <>
          <AppText variant="small" muted>
            Health Connect is the Android store that Garmin Connect, Samsung Health, Fitbit and Google Fit share data
            through. Once it is installed and up to date, return here.
          </AppText>
          <Button
            label={availability.reason === 'update_required' ? 'Update Health Connect' : 'Get Health Connect'}
            variant="secondary"
            onPress={openStore}
          />
        </>
      ) : null}
    </View>
  );
}
