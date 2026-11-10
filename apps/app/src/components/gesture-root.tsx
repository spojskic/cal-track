import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

/**
 * Root of every react-native-gesture-handler gesture (swipe-to-delete rows). Must wrap the whole tree; the web build
 * uses gesture-root.web.tsx, which renders its children untouched.
 */
export function GestureRoot({ children }: { children: ReactNode }) {
  return <GestureHandlerRootView style={styles.root}>{children}</GestureHandlerRootView>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
