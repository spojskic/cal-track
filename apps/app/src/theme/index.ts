import { useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';

import { applyWebChrome } from './chrome';
import type { PaletteDef, ThemeColors } from './colors';
import { resolvePalette } from './palettes';
import { radiiFor, shapeFor, type Corners, type Radii, type Shape } from './shape';
import { useThemeStore } from './theme-store';

export * from './colors';
export * from './palettes';
// Only the types and the list of corner styles: the scales themselves are reached through `useTheme()`, so that no module can
// freeze a radius at import time (tools/ui-smoke/src/shape-guard.test.ts checks it).
export { CORNERS } from './shape';
export type { Corners, Radii, Shape } from './shape';
export { useThemeStore } from './theme-store';

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

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
  /** The corner style on screen. */
  corners: Corners;
  /**
   * The corner sizes of the active style (`radius.lg` for a card, `radius.md` for a field, `radius.pill` for a button or chip).
   * Always apply it inline in render (`style={[styles.card, { borderRadius: radius.lg }]}`), never inside a module-level
   * `StyleSheet.create`, which runs once and cannot follow the setting.
   */
  radius: Radii;
  /** Radius helpers for round things that are not on the scale (`shape.circle(38)`, `shape.bar(8)`, `shape.px(14)`, `shape.dot(10)`). */
  shape: Shape;
}

/**
 * The colours and corners to draw with. `colors` is the same object for as long as the palette stays the same, so it is safe in
 * dependency lists, and `isDark` is the palette's own appearance (not the device's). `radius` and `shape` only change when the
 * user switches between Rounded and Boxy.
 */
export function useTheme(): Theme {
  const palette = useResolvedPalette();
  const corners = useThemeStore((s) => s.corners);
  return useMemo(
    () => ({
      colors: palette.colors,
      isDark: palette.appearance === 'dark',
      paletteId: palette.id,
      corners,
      radius: radiiFor(corners),
      shape: shapeFor(corners),
    }),
    [palette, corners],
  );
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
