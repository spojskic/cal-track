/**
 * The theme side of the smoke harness: `--theme=<paletteId>` and `--corners=rounded|boxy` seed the app's saved theme choice, and
 * the appearance scenario compares what the page shows with what a palette (and a corner style) says. Pure; the palettes and the
 * corner scales come straight from apps/app/src/theme.
 */
import {
  DEFAULT_DARK_ID,
  DEFAULT_LIGHT_ID,
  DEFAULT_THEME_PREFS,
  PALETTES,
  THEME_STORAGE_KEY,
  getPalette,
  type ThemePrefs,
} from '../../../apps/app/src/theme/palettes';
import { CORNERS, DEFAULT_CORNERS, type Corners } from '../../../apps/app/src/theme/shape';

export { THEME_STORAGE_KEY };
export type { Corners };

/** Values that `--corners` accepts. */
export const KNOWN_CORNERS: readonly Corners[] = CORNERS;

/** Ids that `--theme` accepts. */
export const KNOWN_PALETTE_IDS: readonly string[] = PALETTES.map((p) => p.id);

/**
 * The saved choice that makes this palette show: pinned to its side (so the browser's prefers-color-scheme does not matter) with
 * the other side at its default, and the given corner style (default: rounded, the original look). `null` for an unknown id.
 */
export function themePrefsFor(paletteId: string, corners: Corners = DEFAULT_CORNERS): ThemePrefs | null {
  const palette = getPalette(paletteId);
  if (!palette) return null;
  return {
    mode: palette.appearance,
    light: palette.appearance === 'light' ? palette.id : DEFAULT_LIGHT_ID,
    dark: palette.appearance === 'dark' ? palette.id : DEFAULT_DARK_ID,
    corners,
  };
}

/**
 * What a run seeds into localStorage for `--theme` and `--corners`: `--theme` alone pins that palette (rounded corners),
 * `--corners` alone keeps Match system with the default palettes and only changes the corners, both flags combine, and neither
 * seeds nothing (`null`: the app starts with its own default). `null` as well for an unknown palette id.
 */
export function themeSeedFor(opts: { theme?: string | undefined; corners?: Corners | undefined }): ThemePrefs | null {
  if (opts.theme !== undefined) return themePrefsFor(opts.theme, opts.corners);
  if (opts.corners !== undefined) return { ...DEFAULT_THEME_PREFS, corners: opts.corners };
  return null;
}

/** The corner radii (px) the Appearance card must show. Rounded: the card is `radius.lg` (16), at least 12. Boxy: at most 8. */
export const ROUNDED_CARD_MIN_PX = 12;
export const BOXY_CARD_MAX_PX = 8;

/**
 * Compares the computed `border-top-left-radius` (px) of a Card with the corner style that should be on screen. `null` = it
 * matches. A page without a Card (`null` reading) is a mismatch too.
 */
export function cardRadiusMismatch(corners: Corners, px: number | null | undefined): string | null {
  if (px === null || px === undefined || !Number.isFinite(px)) return 'no rounded card was found around the "Appearance" heading';
  if (corners === 'boxy') {
    return px <= BOXY_CARD_MAX_PX && px > 0 ? null : `a card has a corner radius of ${px}px, expected 1-${BOXY_CARD_MAX_PX}px with Boxy corners`;
  }
  return px >= ROUNDED_CARD_MIN_PX ? null : `a card has a corner radius of ${px}px, expected at least ${ROUNDED_CARD_MIN_PX}px with Rounded corners`;
}

/** `#1F1F28` as the `rgb(31, 31, 40)` that `getComputedStyle` reports. */
export function cssRgb(hex: string): string {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (!m) throw new Error(`not a #RRGGBB colour: ${hex}`);
  return `rgb(${parseInt(m[1] as string, 16)}, ${parseInt(m[2] as string, 16)}, ${parseInt(m[3] as string, 16)})`;
}

/** What `readThemeScript` returns. Every field may be missing on a page that is not the app. */
export interface ThemeReading {
  stored?: string | null;
  bodyBackground?: string | null;
  colorScheme?: string;
  themeColor?: string | null;
  paletteId?: string | null;
}

/** What a step expects to see: the palette on screen, and optionally part of the saved choice. */
export interface ThemeExpectation {
  paletteId: string;
  /** Fields of the saved choice that must match; `null` = nothing saved yet. Leave out to accept any. */
  stored?: Partial<ThemePrefs> | null;
}

/** The differences between the page and the expectation, one sentence each. Empty = it matches. */
export function themeMismatches(reading: ThemeReading, want: ThemeExpectation): string[] {
  const palette = getPalette(want.paletteId);
  if (!palette) return [`unknown palette "${want.paletteId}"`];
  const problems: string[] = [];
  const differs = (what: string, actual: unknown, expected: string) => {
    if (actual !== expected) problems.push(`${what} is ${JSON.stringify(actual ?? null)}, expected ${JSON.stringify(expected)}`);
  };
  differs('page background', reading.bodyBackground, cssRgb(palette.colors.background));
  differs('root color-scheme', reading.colorScheme, palette.appearance);
  differs('theme-color meta', reading.themeColor, palette.colors.background);
  differs('palette on the root element', reading.paletteId, palette.id);
  if (want.stored !== undefined) {
    if (want.stored === null) {
      if (reading.stored != null) problems.push(`saved choice is ${reading.stored}, expected nothing saved`);
    } else if (reading.stored == null) {
      problems.push('nothing is saved in localStorage');
    } else {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(reading.stored) as Record<string, unknown>;
      } catch {
        problems.push(`saved choice is not JSON: ${reading.stored.slice(0, 80)}`);
      }
      for (const [key, value] of Object.entries(want.stored)) {
        if (parsed[key] !== value) problems.push(`saved ${key} is ${JSON.stringify(parsed[key] ?? null)}, expected ${JSON.stringify(value)}`);
      }
    }
  }
  return problems;
}
