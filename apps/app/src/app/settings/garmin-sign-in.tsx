import { router, Stack } from 'expo-router';
import { View } from 'react-native';

import { GarminSignInView } from '@/components/health/GarminSignInView';
import { useTheme } from '@/theme';

/**
 * Sign in to Garmin on Garmin's own page (a web view; the iPhone and Android app only). On success the token is stored on this
 * phone, the first sync (last 14 days) starts in the background and this screen closes.
 */
export default function GarminSignInScreen() {
  const { colors } = useTheme();
  const done = () => (router.canGoBack() ? router.back() : router.replace('/settings/integrations'));
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen options={{ headerShown: true, title: 'Sign in to Garmin' }} />
      <GarminSignInView onDone={done} />
    </View>
  );
}
