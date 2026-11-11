import { router, Stack } from 'expo-router';
import { Component, lazy, Suspense, type ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { AppText, Button } from '@/components/ui';
import { spacing, useTheme } from '@/theme';

// Loaded on demand: the sign-in page needs the native module react-native-webview. An app installed before it was added
// does not contain it, and a plain import would take the whole app down; here only this screen shows a message.
const GarminSignInView = lazy(() =>
  import('@/components/health/GarminSignInView').then((m) => ({ default: m.GarminSignInView })),
);

class NativeModuleBoundary extends Component<{ children: ReactNode; onBack: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <View style={{ padding: spacing.lg, gap: spacing.lg }}>
        <AppText variant="heading">This copy of the app cannot show the Garmin sign-in page</AppText>
        <AppText muted>
          It was installed before the sign-in view was added to Ration. Build and install the newest version of the app (a
          new native build, not just a reload), then try again.
        </AppText>
        <Button label="Back" variant="secondary" onPress={this.props.onBack} />
      </View>
    );
  }
}

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
      <NativeModuleBoundary onBack={done}>
        <Suspense fallback={<ActivityIndicator style={{ marginTop: spacing.xxl }} />}>
          <GarminSignInView onDone={done} />
        </Suspense>
      </NativeModuleBoundary>
    </View>
  );
}
