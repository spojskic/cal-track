// React Native side effects of a theme change that React itself cannot express: the web page chrome (what shows outside the
// React tree) and the native appearance override. Nothing here is needed to render a screen.
import { Appearance, Platform } from 'react-native';

import type { PaletteDef } from './colors';
import type { ThemeMode } from './palettes';

/**
 * Web only. react-native-web has no `Appearance.setColorScheme`, so the page is told directly: the CSS `color-scheme`
 * (scrollbars, form controls, the default text caret), the body and root background (overscroll, the first paint before
 * React renders), the browser UI colour (`<meta name="theme-color">`), and the CSS variable that the focus ring in
 * lib/web-styles.ts reads. Safe to call before the first render and as often as needed.
 */
export function applyWebChrome(palette: PaletteDef): void {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.colorScheme = palette.appearance;
  root.style.backgroundColor = palette.colors.background;
  root.style.setProperty('--ct-primary', palette.colors.primary);
  root.setAttribute('data-theme', palette.id);
  if (document.body) document.body.style.backgroundColor = palette.colors.background;
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', palette.colors.background);
}

/**
 * Native only. A pinned Light or Dark mode also pins the system dialogs, keyboard and pickers to that side. In `system` mode
 * the override MUST be removed ('unspecified'), otherwise `useColorScheme()` keeps reporting the old override instead of the
 * real device setting and Match system could never switch back.
 */
export function applyNativeScheme(mode: ThemeMode): void {
  if (Platform.OS === 'web') return;
  try {
    Appearance.setColorScheme(mode === 'system' ? 'unspecified' : mode);
  } catch {
    // an unsupported platform keeps following the device
  }
}
