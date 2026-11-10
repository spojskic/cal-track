import { Platform } from 'react-native';

import { DEFAULT_LIGHT } from '@/theme/palettes';

/**
 * Web only: replaces the browser's default focus rectangle on text fields.
 *
 * Chrome/Safari draw a square outline around the <input> itself, which looks wrong on our rounded fields and, worse, shows a box
 * *inside* the rounded search pill (the pill owns the border, the input only sits in it). So the outline is turned off and the
 * focus is shown through the border colour of whatever owns the border:
 *   - an input with its own border (text fields, notes, sign-in, chat box)  -> the input's border takes the primary colour;
 *   - an input inside a bordered wrapper (search pills)                      -> the wrapper's border takes the primary colour.
 * Keyboard users still see exactly which field is active.
 *
 * The primary colour is the CSS variable `--ct-primary`, which theme/chrome.ts sets on the root element whenever the palette
 * changes (the fallback only shows if that has not run yet).
 */
const PRIMARY = `var(--ct-primary, ${DEFAULT_LIGHT.colors.primary})`;
const CSS = `
input, textarea { outline: none !important; }
input:focus, textarea:focus { border-color: ${PRIMARY} !important; }
div:has(> input:focus), div:has(> textarea:focus) { border-color: ${PRIMARY} !important; }
`;

if (Platform.OS === 'web' && typeof document !== 'undefined' && !document.getElementById('cal-web-styles')) {
  const style = document.createElement('style');
  style.id = 'cal-web-styles';
  style.textContent = CSS;
  document.head.appendChild(style);
}
