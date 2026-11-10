import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { Redirect, Stack, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { GestureRoot } from '@/components/gesture-root';
import { SetupRequired } from '@/components/setup-required';
import { StackHeader } from '@/components/stack-header';
import { useProfile } from '@/data/profile';
import { AuthProvider, useAuth } from '@/lib/auth';
import { queryClient, queryPersister } from '@/lib/query';
import '@/lib/web-styles';
import { isSupabaseConfigured } from '@/lib/supabase';
import { useTheme } from '@/theme';

SplashScreen.preventAutoHideAsync();

function RootNavigator() {
  const { session, loading } = useAuth();
  const segments = useSegments();
  const { colors, isDark } = useTheme();
  const profile = useProfile();

  useEffect(() => {
    if (!loading) SplashScreen.hideAsync();
  }, [loading]);

  if (!isSupabaseConfigured) return <SetupRequired />;
  if (loading) return null;

  const inAuthGroup = segments[0] === '(auth)';
  if (!session && !inAuthGroup) return <Redirect href="/sign-in" />;
  if (session && inAuthGroup) return <Redirect href="/" />;

  // First run: send signed-in users who have not completed onboarding to the setup wizard.
  if (session && profile.isLoading) return null;
  if (session && profile.isSuccess && !profile.data?.onboarded && segments[0] !== 'onboarding') {
    return <Redirect href="/onboarding" />;
  }

  return (
    <>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          // Screens that opt in with `<Stack.Screen options={{ headerShown: true }} />` get the app's own header (themed, no
          // native liquid-glass buttons), see components/stack-header.tsx.
          header: (props) => <StackHeader {...props} />,
        }}>
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(app)" />
        <Stack.Screen
          name="add"
          options={{ presentation: 'modal', headerShown: true, title: 'Add to diary' }}
        />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <GestureRoot>
      <PersistQueryClientProvider client={queryClient} persistOptions={{ persister: queryPersister }}>
        <AuthProvider>
          <RootNavigator />
        </AuthProvider>
      </PersistQueryClientProvider>
    </GestureRoot>
  );
}
