// Pure (no React Native imports): builds a complete `ThemeColors` from the hand-picked part of a palette.
import { bestInk } from './contrast';
import type { ThemeColors } from './colors';

/** The colours a palette author chooses. The `on*` text colours and the scrim are derived, see {@link defineColors}. */
export type BaseColors = Omit<ThemeColors, 'onPrimary' | 'onDanger' | 'onWarning' | 'onSuccess' | 'scrim'>;

/** The palette's own darkest and lightest text colours (used on top of bright or dark fills). */
export interface Ink {
  dark: string;
  light: string;
}

/**
 * Completes a palette: every `on*` colour is whichever of the two inks reads best on its fill (plain black or white when
 * neither reaches 4.5:1), and the scrim is the dark ink (drawn at partial opacity behind sheets, see `withAlpha`).
 */
export function defineColors(base: BaseColors, ink: Ink): ThemeColors {
  const on = (fill: string) => bestInk(fill, [ink.dark, ink.light]);
  return {
    ...base,
    onPrimary: on(base.primary),
    onDanger: on(base.danger),
    onWarning: on(base.warning),
    onSuccess: on(base.success),
    scrim: ink.dark,
  };
}
