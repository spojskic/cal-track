import { createContext, useContext } from 'react';
import { useWindowDimensions } from 'react-native';

import { SIDEBAR_WIDTH } from '@/theme/desktop';

/**
 * True while the desktop shell (sidebar + status bar, components/desktop/DesktopFrame.tsx) is drawn around the screens. Screens and
 * headers read it to know which layout they are in: the window is wide, but a full-screen route (sign-in, onboarding, the barcode
 * camera) is drawn without the shell and then looks as it does on a phone.
 */
const DesktopShellContext = createContext(false);

export const DesktopShellProvider = DesktopShellContext.Provider;

export function useDesktopShell(): boolean {
  return useContext(DesktopShellContext);
}

/**
 * The width of the area a screen is drawn in: the window, less the sidebar while the desktop shell is on. Use it instead of the
 * window width to decide how many columns fit (a window of 900 px leaves a screen only 652 px next to the sidebar).
 */
export function useContentWidth(): number {
  const { width } = useWindowDimensions();
  return useDesktopShell() ? Math.max(0, width - SIDEBAR_WIDTH) : width;
}
