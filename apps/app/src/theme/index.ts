import { useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';

import { applyWebChrome } from './chrome';
import type { PaletteDef, ThemeColors } from './colors';
import { resolvePalette } from './palettes';
import { useThemeStore } from './theme-store';

export * from './colors';
export * from './palettes';
export { useThemeStore } from './theme-store';

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 } as const;

/** Width (px) from which the web/tablet layout switches from bottom tabs to a left sidebar. */
export const WIDE_BREAKPOINT = 900;
/** Max content width for readable pages on large screens. */
export const MAX_CONTENT_WIDTH = 880;

/** How long the app waits for the saved theme before it shows the default one (native only; a read takes milliseconds). */
const HYDRATE_TIMEOUT_MS = 1500;

/** The palette on screen: the saved choice, and for Match system the device's light/dark setting. */
function useResolvedPalette(): PaletteDef {
  const mode = useThemeStore((s) => s.mode);
  const light = useThemeStore((s) => s.light);
  const dark = useThemeStore((s) => s.dark);
  const systemScheme = useColorScheme();
  return resolvePalette({ mode, light, dark }, systemScheme);
}

export interface Theme {
  colors: ThemeColors;
  isDark: boolean;
  paletteId: string;
}

/**
 * The colours to draw with. `colors` is the same object for as long as the palette stays the same, so it is safe in
 * dependency lists, and `isDark` is the palette's own appearance (not the device's).
 */
export function useTheme(): Theme {
  const palette = useResolvedPalette();
  return useMemo(() => ({ colors: palette.colors, isDark: palette.appearance === 'dark', paletteId: palette.id }), [palette]);
}

/** Mount once near the root: keeps the web page chrome (background, color-scheme, focus colour) in step with the palette. */
export function useThemeChrome(): void {
  const palette = useResolvedPalette();
  useEffect(() => {
    applyWebChrome(palette);
  }, [palette]);
}

/**
 * True once the saved choice is known, or after a short timeout. Gate the splash screen on it so the app never flashes the
 * default palette before the saved one.
 */
export function useThemeReady(): boolean {
  const hydrated = useThemeStore((s) => s.hydrated);
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (hydrated) return undefined;
    const timer = setTimeout(() => setTimedOut(true), HYDRATE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [hydrated]);
  return hydrated || timedOut;
}
