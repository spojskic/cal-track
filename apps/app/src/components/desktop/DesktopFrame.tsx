// The desktop shell: on a wide window (WIDE_BREAKPOINT or more) the sidebar at the left and the status bar along the bottom, around
// whatever the root navigator shows. Mounted ONCE, by the root layout (app/_layout.tsx), so every screen shares it: the dashboard, the
// diary and the foods list (the tabs of app/(app)) as well as settings, coach, workouts, search and the food pages (siblings in the root
// Stack). Which routes are left out is decided in shell-routes.ts.
//
// The navigator is always the same element in the same place: the sidebar and the status bar come and go around it (as `null`
// siblings), so crossing the breakpoint or opening a full-screen route never remounts the navigator and loses its state. On a phone
// (and on the excluded routes) the three wrapper views are plain flex:1 containers and nothing else is drawn.
import { usePathname } from 'expo-router';
import type { ReactNode } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { WIDE_BREAKPOINT } from '@/theme';

import { Sidebar } from './Sidebar';
import { ShellStatusBar } from './ShellStatusBar';
import { DesktopShellProvider } from './shell-context';
import { shouldShowDesktopShell } from './shell-routes';

export function DesktopFrame({ children, signedIn, onboarded }: { children: ReactNode; signedIn: boolean; onboarded: boolean }) {
  const { width } = useWindowDimensions();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const active = shouldShowDesktopShell({ wide: width >= WIDE_BREAKPOINT, signedIn, onboarded, pathname });

  return (
    <DesktopShellProvider value={active}>
      <View style={styles.root}>
        {active ? <Sidebar /> : null}
        <View style={styles.column}>
          {/* The window's top inset (a notch or status bar on a tablet; 0 on the web) is kept free once, here; the headers of the
              screens do not add it again while the shell is on. */}
          <View style={active ? [styles.content, { paddingTop: insets.top }] : styles.content}>{children}</View>
          {active ? <ShellStatusBar /> : null}
        </View>
      </View>
    </DesktopShellProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row' },
  column: { flex: 1, minWidth: 0, flexDirection: 'column' },
  content: { flex: 1, minHeight: 0 },
});
