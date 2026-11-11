// The saved theme choice as a small zustand store (same pattern as ai/ai-store.ts + ai/prefs.ts): a versioned key, best-effort
// load and save. Device-local on purpose: the choice is never sent to the account.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Appearance, Platform } from 'react-native';
import { create } from 'zustand';

import { migrateAsyncKey } from '@/lib/migrate-key';

import { applyNativeScheme, applyWebChrome } from './chrome';
import {
  DEFAULT_THEME_PREFS,
  THEME_STORAGE_KEY,
  getPalette,
  parseThemePrefs,
  resolvePalette,
  serializeThemePrefs,
  type ThemeMode,
  type ThemePrefs,
} from './palettes';
import type { Corners } from './shape';

/** The theme key from before the app was renamed; read once, then moved to `THEME_STORAGE_KEY`. */
const LEGACY_THEME_STORAGE_KEY = 'cal-track.theme.v1';

export interface ThemeState extends ThemePrefs {
  /** The saved choice was read (always true on the web, where it is read synchronously). */
  hydrated: boolean;
  setMode: (mode: ThemeMode) => void;
  /** Picks the palette used on the light side. Ignored for an id that is not a light palette. */
  setLight: (id: string) => void;
  /** Picks the palette used on the dark side. Ignored for an id that is not a dark palette. */
  setDark: (id: string) => void;
  /** Picks the corner style (Rounded or Boxy). Applies to the whole app at once. */
  setCorners: (corners: Corners) => void;
  /** Back to Match system with the default palettes and the default (boxy) corners. */
  reset: () => void;
  /** Native: reads the saved choice. Does nothing once the choice was read or changed. */
  hydrate: () => Promise<void>;
}

/** Web: localStorage is synchronous, so the saved palette is known before the first render and the page never flashes. */
function readWebSync(): string | null {
  if (Platform.OS !== 'web') return null;
  try {
    if (typeof localStorage === 'undefined') return null;
    const current = localStorage.getItem(THEME_STORAGE_KEY);
    if (current !== null) return current;
    const legacy = localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
    if (legacy === null) return null;
    localStorage.setItem(THEME_STORAGE_KEY, legacy);
    localStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
    return legacy;
  } catch {
    return null;
  }
}

async function save(prefs: ThemePrefs): Promise<void> {
  try {
    await AsyncStorage.setItem(THEME_STORAGE_KEY, serializeThemePrefs(prefs));
  } catch {
    // the choice is best effort: it still applies until the app closes
  }
}

const initial = parseThemePrefs(readWebSync());

export const useThemeStore = create<ThemeState>()((set, get) => {
  const commit = (next: ThemePrefs): void => {
    applyNativeScheme(next.mode);
    set({ ...next, hydrated: true });
    void save(next);
  };
  const prefs = (): ThemePrefs => {
    const { mode, light, dark, corners } = get();
    return { mode, light, dark, corners };
  };
  return {
    ...initial,
    hydrated: Platform.OS === 'web',
    setMode: (mode) => commit({ ...prefs(), mode }),
    setLight: (id) => {
      if (getPalette(id)?.appearance === 'light') commit({ ...prefs(), light: id });
    },
    setDark: (id) => {
      if (getPalette(id)?.appearance === 'dark') commit({ ...prefs(), dark: id });
    },
    setCorners: (corners) => commit({ ...prefs(), corners }),
    reset: () => commit(DEFAULT_THEME_PREFS),
    hydrate: async () => {
      if (get().hydrated) return;
      let stored: string | null = null;
      try {
        await migrateAsyncKey(LEGACY_THEME_STORAGE_KEY, THEME_STORAGE_KEY);
        stored = await AsyncStorage.getItem(THEME_STORAGE_KEY);
      } catch {
        // an unreadable store means the defaults
      }
      // the user may have changed the theme while the read was running: their choice wins
      if (get().hydrated) return;
      const loaded = parseThemePrefs(stored);
      applyNativeScheme(loaded.mode);
      set({ ...loaded, hydrated: true });
    },
  };
});

if (Platform.OS === 'web') {
  // the first paint: body background, color-scheme and focus colour before React renders anything
  applyWebChrome(resolvePalette(initial, Appearance.getColorScheme()));
} else {
  void useThemeStore.getState().hydrate();
}
