import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { DarkTheme, DefaultTheme, Redirect, Stack, ThemeProvider, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, type ReactNode } from 'react';

import { DesktopFrame } from '@/components/desktop/DesktopFrame';
import { GestureRoot } from '@/components/gesture-root';
import { SetupRequired } from '@/components/setup-required';
import { StackHeader } from '@/components/stack-header';
import { useProfile } from '@/data/profile';
import { AuthProvider, useAuth } from '@/lib/auth';
import { queryClient, queryPersister } from '@/lib/query';
import '@/lib/web-styles';
import { isSupabaseConfigured } from '@/lib/supabase';
import { useTheme, useThemeChrome, useThemeReady } from '@/theme';

SplashScreen.preventAutoHideAsync();

function RootNavigator() {
  const { session, loading } = useAuth();
  const segments = useSegments();
  const { colors, isDark } = useTheme();
  const profile = useProfile();
  // The saved theme is read before the splash screen hides, so the app never flashes the default palette first.
  const themeReady = useThemeReady();

  useEffect(() => {
    if (!loading && themeReady) SplashScreen.hideAsync();
  }, [loading, themeReady]);

  // The native window / root view behind the screens. Without this it stays white and shows through at the rounded
  // corners and between screens while a transition runs.
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.background).catch(() => {});
  }, [colors.background]);

  if (!themeReady) return null;
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
      {/* On a wide window (and only for a signed-in, onboarded user, off the full-screen routes) the frame draws the desktop sidebar and
          status bar around the Stack, so every screen below shares them: components/desktop/DesktopFrame.tsx. Otherwise it is a
          plain container and the app looks as it always did. */}
      <DesktopFrame signedIn={Boolean(session)} onboarded={!(profile.isSuccess && !profile.data?.onboarded)}>
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
      </DesktopFrame>
    </>
  );
}

/** React Navigation's own colours (screen containers, headers, tab areas) follow the app theme instead of its light default. */
function NavigationTheme({ children }: { children: ReactNode }) {
  const { colors, isDark } = useTheme();
  useThemeChrome();
  const base = isDark ? DarkTheme : DefaultTheme;
  const value = {
    ...base,
    colors: {
      ...base.colors,
      background: colors.background,
      card: colors.surface,
      border: colors.border,
      text: colors.text,
      primary: colors.primary,
      notification: colors.danger,
    },
  };
  return <ThemeProvider value={value}>{children}</ThemeProvider>;
}

export default function RootLayout() {
  return (
    <GestureRoot>
      <PersistQueryClientProvider client={queryClient} persistOptions={{ persister: queryPersister }}>
        <AuthProvider>
          <NavigationTheme>
            <RootNavigator />
          </NavigationTheme>
        </AuthProvider>
      </PersistQueryClientProvider>
    </GestureRoot>
  );
}
