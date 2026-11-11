// Pure (no React Native imports): the colour tokens every screen uses, and the original Ration look.
import { defineColors } from './define-colors';

/** Brand/semantic palette of the original Ration look. Inspired by Cronometer's look (orange accent, green/teal/purple macros). */
export const palette = {
  orange: '#EF7B54',
  green: '#85D49C',
  teal: '#6ECBD9',
  purple: '#B57FC9',
  red: '#D64545',
  amber: '#F2B84B',
  deepTeal: '#235A5B',
} as const;

/**
 * Every colour a screen may use. ALL values are plain 6-digit `#RRGGBB` strings: several components append a 2-digit hex
 * alpha to a token (`${tint}22`), which only works on that form. For alpha on purpose use {@link withAlpha}.
 */
export interface ThemeColors {
  /** The page behind everything. */
  background: string;
  /** Cards and sheets. */
  surface: string;
  /** Inputs, segmented controls, callouts: one step away from `surface`. */
  surfaceAlt: string;
  border: string;
  text: string;
  textMuted: string;
  /** The main interactive colour (buttons, selected states, focus ring). */
  primary: string;
  /** Text and icons on a `primary` fill. */
  onPrimary: string;
  /** Second accent (links, info callouts, custom foods). */
  accent: string;
  /** Sidebar (wide screens) and bottom tab bar. */
  sidebar: string;
  onSidebar: string;
  onSidebarMuted: string;
  energy: string;
  protein: string;
  carbs: string;
  fat: string;
  danger: string;
  /** Text and icons on a `danger` fill. */
  onDanger: string;
  warning: string;
  /** Text and icons on a `warning` fill. */
  onWarning: string;
  success: string;
  /** Text and icons on a `success` fill. */
  onSuccess: string;
  /** Progress bar tracks. */
  track: string;
  /** The dim layer behind sheets and dialogs. Draw it with {@link withAlpha}, never opaque. */
  scrim: string;
}

export type PaletteAppearance = 'light' | 'dark';

/** One selectable palette (see palettes.ts for the registry). */
export interface PaletteDef {
  /** Stable id, saved on the device: never rename or reuse one. */
  id: string;
  name: string;
  /** Decides `isDark` (status bar, navigation theme, native dialogs, the web `color-scheme`). */
  appearance: PaletteAppearance;
  colors: ThemeColors;
}

/** Every key of {@link ThemeColors}, in declaration order (the palette tests iterate it). */
export const THEME_COLOR_KEYS = [
  'background',
  'surface',
  'surfaceAlt',
  'border',
  'text',
  'textMuted',
  'primary',
  'onPrimary',
  'accent',
  'sidebar',
  'onSidebar',
  'onSidebarMuted',
  'energy',
  'protein',
  'carbs',
  'fat',
  'danger',
  'onDanger',
  'warning',
  'onWarning',
  'success',
  'onSuccess',
  'track',
  'scrim',
] as const satisfies readonly (keyof ThemeColors)[];

/** `#RRGGBB` plus an opacity from 0 to 1 as `#RRGGBBAA` (supported on native and on the web). */
export function withAlpha(hex: string, opacity: number): string {
  const alpha = Math.round(Math.min(1, Math.max(0, opacity)) * 255);
  return `${hex}${alpha.toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * The original look, kept as the "Ration Day" and "Ration Night" palettes (see palettes.ts). The values are the
 * first version's, except the ones marked `nudged`: on the light page the old orange (2.6 : 1), green (2.6 : 1) and
 * amber (1.7 : 1) were too faint for the 3 : 1 floor of theme.test.ts, so they are a little darker. The text on orange,
 * red and amber fills is now picked by contrast (dark on orange instead of white, which was 2.8 : 1).
 */
export const lightColors: ThemeColors = defineColors(
  {
    background: '#FBFAF5',
    surface: '#FFFFFF',
    surfaceAlt: '#EEF0F7',
    border: '#E2E4EC',
    text: '#232A3B',
    textMuted: '#6B7285',
    primary: '#ED693D', // nudged from palette.orange (#EF7B54)
    accent: palette.deepTeal,
    sidebar: '#262A3B',
    onSidebar: '#F2F3F8',
    onSidebarMuted: '#9AA0B5',
    energy: palette.orange,
    protein: palette.green,
    carbs: palette.teal,
    fat: palette.purple,
    danger: palette.red,
    warning: '#C1830E', // nudged from palette.amber (#F2B84B)
    success: '#46A170', // nudged from #4CAF7A
    track: '#E9EAF1',
  },
  { dark: '#12141F', light: '#FFFFFF' },
);

export const darkColors: ThemeColors = defineColors(
  {
    background: '#12141F',
    surface: '#262A3B',
    surfaceAlt: '#1D2030',
    border: '#363B52',
    text: '#F2F3F8',
    textMuted: '#9AA0B5',
    primary: palette.orange,
    accent: '#4FB3B5',
    sidebar: '#1D2030',
    onSidebar: '#F2F3F8',
    onSidebarMuted: '#9AA0B5',
    energy: palette.orange,
    protein: palette.green,
    carbs: palette.teal,
    fat: palette.purple,
    danger: '#F06A6A',
    warning: palette.amber,
    success: '#5FD39A',
    track: '#363B52',
  },
  { dark: '#12141F', light: '#F2F3F8' },
);
