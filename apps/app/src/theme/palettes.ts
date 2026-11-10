// Pure (no React Native imports): the palette registry, the saved choice and how a choice becomes the palette on screen.
// The store (theme-store.ts) and the hook (index.ts) are the React Native side of this.
import type { PaletteAppearance, PaletteDef } from './colors';
import { DARK_PALETTES } from './palettes-dark';
import { LIGHT_PALETTES } from './palettes-light';
import { CORNERS, DEFAULT_CORNERS, type Corners } from './shape';

export { DARK_PALETTES, LIGHT_PALETTES };

/** Every palette, light ones first. */
export const PALETTES: readonly PaletteDef[] = [...LIGHT_PALETTES, ...DARK_PALETTES];

export const DEFAULT_LIGHT_ID = 'kanagawa-lotus';
export const DEFAULT_DARK_ID = 'kanagawa-wave';

/** The palette with this id, or undefined (an id saved by a newer or older version). */
export function getPalette(id: unknown): PaletteDef | undefined {
  return typeof id === 'string' ? PALETTES.find((p) => p.id === id) : undefined;
}

const byId = (id: string): PaletteDef => {
  const found = PALETTES.find((p) => p.id === id);
  if (!found) throw new Error(`default palette missing: ${id}`);
  return found;
};

export const DEFAULT_LIGHT: PaletteDef = byId(DEFAULT_LIGHT_ID);
export const DEFAULT_DARK: PaletteDef = byId(DEFAULT_DARK_ID);

/** `system` follows the device's light/dark setting; `light` and `dark` pin the app to that side. */
export type ThemeMode = 'system' | 'light' | 'dark';

export const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];

/** What the user chose. Saved on the device only (never in the account). */
export interface ThemePrefs {
  mode: ThemeMode;
  /** Id of a light palette. */
  light: string;
  /** Id of a dark palette. */
  dark: string;
  /** Corner style: `rounded` is the original look, `boxy` has small, sharp corners everywhere. */
  corners: Corners;
}

export const DEFAULT_THEME_PREFS: ThemePrefs = { mode: 'system', light: DEFAULT_LIGHT_ID, dark: DEFAULT_DARK_ID, corners: DEFAULT_CORNERS };

/** AsyncStorage / localStorage key. The version is part of the key: change the shape, bump it. */
export const THEME_STORAGE_KEY = 'cal-track.theme.v1';

/**
 * Makes any value (parsed JSON, `null`, a stale object) a valid choice: an unknown mode becomes `system`, an unknown id, or
 * the id of a palette of the other appearance, becomes the default of that side, and a missing or unknown `corners` (a choice
 * saved before the Boxy look existed) becomes `rounded`.
 */
export function sanitizeThemePrefs(raw: unknown): ThemePrefs {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const mode = THEME_MODES.find((m) => m === o.mode) ?? DEFAULT_THEME_PREFS.mode;
  const light = getPalette(o.light);
  const dark = getPalette(o.dark);
  return {
    mode,
    light: light?.appearance === 'light' ? light.id : DEFAULT_LIGHT_ID,
    dark: dark?.appearance === 'dark' ? dark.id : DEFAULT_DARK_ID,
    corners: CORNERS.find((c) => c === o.corners) ?? DEFAULT_CORNERS,
  };
}

/** Reads the stored string. Never throws: anything unreadable gives the defaults. */
export function parseThemePrefs(stored: string | null | undefined): ThemePrefs {
  if (!stored) return DEFAULT_THEME_PREFS;
  try {
    return sanitizeThemePrefs(JSON.parse(stored));
  } catch {
    return DEFAULT_THEME_PREFS;
  }
}

export function serializeThemePrefs(prefs: ThemePrefs): string {
  return JSON.stringify(sanitizeThemePrefs(prefs));
}

export function isDefaultThemePrefs(prefs: ThemePrefs): boolean {
  return (
    prefs.mode === DEFAULT_THEME_PREFS.mode &&
    prefs.light === DEFAULT_LIGHT_ID &&
    prefs.dark === DEFAULT_DARK_ID &&
    prefs.corners === DEFAULT_THEME_PREFS.corners
  );
}

/** What decides the palette: the saved choice without the corner style (accepted, but it plays no part). */
export type PaletteChoice = Pick<ThemePrefs, 'mode' | 'light' | 'dark'> & { corners?: Corners };

/**
 * The palette on screen. `system` follows the device (`systemScheme`; an unknown scheme counts as light), `light` and `dark`
 * pin the side. The side then supplies the palette the user picked for it.
 */
export function resolvePalette(prefs: PaletteChoice, systemScheme: string | null | undefined): PaletteDef {
  const clean = sanitizeThemePrefs(prefs);
  const side: PaletteAppearance = clean.mode === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : clean.mode;
  return byId(side === 'dark' ? clean.dark : clean.light);
}
