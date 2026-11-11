/**
 * The app's themes: the palette registry (apps/app/src/theme/palettes*.ts), the contrast floors every palette has to meet, how a
 * saved choice becomes the palette on screen, and the small pure helpers around them. Pure Node: nothing here touches React
 * Native (the store and the hook are the non-pure side and are covered by the browser smoke scenario `settings: appearance`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { paletteCardWidth, paletteColumns, PALETTE_CARD_MIN_WIDTH, PALETTE_GRID_GAP } from '../../../apps/app/src/components/settings/palette-grid';
import { darkColors, lightColors, THEME_COLOR_KEYS, withAlpha, type ThemeColors } from '../../../apps/app/src/theme/colors';
import { bestInk, contrastRatio, hexToRgb, relativeLuminance } from '../../../apps/app/src/theme/contrast';
import { defineColors } from '../../../apps/app/src/theme/define-colors';
import {
  DARK_PALETTES,
  DEFAULT_DARK,
  DEFAULT_DARK_ID,
  DEFAULT_LIGHT,
  DEFAULT_LIGHT_ID,
  DEFAULT_THEME_PREFS,
  LIGHT_PALETTES,
  PALETTES,
  THEME_STORAGE_KEY,
  getPalette,
  isDefaultThemePrefs,
  parseThemePrefs,
  resolvePalette,
  sanitizeThemePrefs,
  serializeThemePrefs,
  type ThemePrefs,
} from '../../../apps/app/src/theme/palettes';

import { CORNERS, DEFAULT_CORNERS } from '../../../apps/app/src/theme/shape';

import {
  BOXY_CARD_MAX_PX,
  KNOWN_CORNERS,
  KNOWN_PALETTE_IDS,
  ROUNDED_CARD_MIN_PX,
  THEME_STORAGE_KEY as THEME_STORAGE_KEY_FOR_SMOKE,
  cardRadiusMismatch,
  cssRgb,
  themeMismatches,
  themePrefsFor,
  themeSeedFor,
} from './theme-seed';

const here = dirname(fileURLToPath(import.meta.url));
const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** [foreground token, background token, minimum contrast ratio]. Text 4.5, large text and UI parts 3 (WCAG 2.2 AA). */
const FLOORS: readonly (readonly [keyof ThemeColors, keyof ThemeColors, number])[] = [
  ['text', 'background', 7],
  ['text', 'surface', 4.5],
  ['textMuted', 'background', 4.5],
  ['textMuted', 'surface', 4.5],
  ['textMuted', 'surfaceAlt', 3.5],
  ['onPrimary', 'primary', 4.5],
  ['onDanger', 'danger', 4.5],
  ['onWarning', 'warning', 4.5],
  ['onSuccess', 'success', 4.5],
  ['primary', 'background', 3],
  ['danger', 'background', 3],
  ['success', 'background', 3],
  ['warning', 'background', 3],
  ['onSidebar', 'sidebar', 4.5],
  // the spec asks for 3.5 here; every palette reaches 4.5, which the small tab bar labels need
  ['onSidebarMuted', 'sidebar', 4.5],
  // Beyond the required floors: the same colours also sit on cards, and the focused tab is drawn in `primary` on the sidebar.
  ['primary', 'surface', 3],
  ['danger', 'surface', 3],
  ['success', 'surface', 3],
  ['warning', 'surface', 3],
  ['primary', 'sidebar', 3],
];

describe('palette registry', () => {
  it('has at least 9 light and 11 dark palettes, light ones in LIGHT_PALETTES and dark ones in DARK_PALETTES', () => {
    expect(LIGHT_PALETTES.length).toBeGreaterThanOrEqual(9);
    expect(DARK_PALETTES.length).toBeGreaterThanOrEqual(11);
    for (const p of LIGHT_PALETTES) expect(p.appearance, p.id).toBe('light');
    for (const p of DARK_PALETTES) expect(p.appearance, p.id).toBe('dark');
    expect(PALETTES).toHaveLength(LIGHT_PALETTES.length + DARK_PALETTES.length);
  });

  it('has unique ids and names; ids are lower-case kebab-case (they are saved on the device)', () => {
    const ids = PALETTES.map((p) => p.id);
    const names = PALETTES.map((p) => p.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
    for (const id of ids) expect(id, id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    for (const name of names) expect(name.trim().length, name).toBeGreaterThan(0);
  });

  it('ships exactly the agreed palettes (renaming or dropping an id would reset people to the default)', () => {
    expect(LIGHT_PALETTES.map((p) => p.id)).toEqual([
      'kanagawa-lotus',
      'catppuccin-latte',
      'solarized-light',
      'gruvbox-light',
      'github-light',
      'rose-pine-dawn',
      'tokyo-night-day',
      'one-light',
      'paper',
      'ration-day',
    ]);
    expect(DARK_PALETTES.map((p) => p.id)).toEqual([
      'kanagawa-wave',
      'kanagawa-dragon',
      'tokyo-night',
      'catppuccin-mocha',
      'dracula',
      'nord',
      'gruvbox-dark',
      'rose-pine',
      'one-dark',
      'github-dark',
      'solarized-dark',
      'ration-night',
    ]);
    expect(getPalette('kanagawa-wave')?.name).toBe('Kanagawa Wave');
    expect(getPalette('kanagawa-lotus')?.name).toBe('Kanagawa Lotus');
    expect(getPalette('catppuccin-mocha')?.name).toBe('Catppuccin Mocha');
    expect(getPalette('dracula')?.name).toBe('Dracula');
  });

  it('defaults to Kanagawa Lotus (light) and Kanagawa Wave (dark)', () => {
    expect(DEFAULT_LIGHT_ID).toBe('kanagawa-lotus');
    expect(DEFAULT_DARK_ID).toBe('kanagawa-wave');
    expect(DEFAULT_LIGHT.appearance).toBe('light');
    expect(DEFAULT_DARK.appearance).toBe('dark');
    expect(getPalette(DEFAULT_LIGHT_ID)).toBe(DEFAULT_LIGHT);
    expect(getPalette(DEFAULT_DARK_ID)).toBe(DEFAULT_DARK);
    expect(DEFAULT_DARK.colors.background).toBe('#1F1F28'); // sumiInk3, also the native splash colour in app.json
  });

  it('keeps the original look as Ration Day / Night, and lightColors / darkColors are those palettes', () => {
    expect(getPalette('ration-day')?.colors).toBe(lightColors);
    expect(getPalette('ration-night')?.colors).toBe(darkColors);
    expect(getPalette('ration-day')?.name).toBe('Ration Day');
    expect(getPalette('ration-night')?.name).toBe('Ration Night');
    // the navy page, the orange primary and the macro colours are still the ones of the first version
    expect(darkColors.background).toBe('#12141F');
    expect(darkColors.primary).toBe('#EF7B54');
    expect(lightColors.background).toBe('#FBFAF5');
  });

  it('the native splash colours in app.json are the default dark page (a static splash cannot follow the palette)', () => {
    const app = JSON.parse(readFileSync(join(here, '..', '..', '..', 'apps', 'app', 'app.json'), 'utf8')) as {
      expo: {
        backgroundColor: string;
        android: { adaptiveIcon: { backgroundColor: string } };
        plugins: unknown[];
      };
    };
    const splash = app.expo.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-splash-screen') as [string, { backgroundColor: string }];
    expect(app.expo.backgroundColor).toBe(DEFAULT_DARK.colors.background);
    expect(app.expo.android.adaptiveIcon.backgroundColor).toBe(DEFAULT_DARK.colors.background);
    expect(splash[1].backgroundColor).toBe(DEFAULT_DARK.colors.background);
  });

  it('no palette name could be mistaken for the Imperial units toggle the display scenario clicks', () => {
    for (const p of PALETTES) expect(p.name, p.id).not.toMatch(/imperial|metric/i);
  });
});

describe('every palette is a complete ThemeColors of plain #RRGGBB colours', () => {
  it.each(PALETTES.map((p) => [p.id, p] as const))('%s', (_id, p) => {
    // exactly the keys of ThemeColors: nothing missing, nothing extra
    expect(Object.keys(p.colors).sort()).toEqual([...THEME_COLOR_KEYS].sort());
    for (const key of THEME_COLOR_KEYS) {
      // plain 6-digit hex: several components append a 2-digit alpha (`${tint}22`), which breaks on any other form
      expect(p.colors[key], `${p.id}.${key}`).toMatch(HEX6);
    }
  });
});

describe('contrast floors (WCAG)', () => {
  it.each(PALETTES.map((p) => [p.id, p] as const))('%s meets every floor', (_id, p) => {
    const failures: string[] = [];
    for (const [fg, bg, min] of FLOORS) {
      const ratio = contrastRatio(p.colors[fg], p.colors[bg]);
      if (ratio < min) failures.push(`${fg} ${p.colors[fg]} on ${bg} ${p.colors[bg]} = ${ratio.toFixed(2)} (needs ${min})`);
    }
    expect(failures).toEqual([]);
  });

  it('the page, card and input colours of a palette are three different steps', () => {
    for (const p of PALETTES) {
      const { background, surface, surfaceAlt, border } = p.colors;
      expect(new Set([background, surface, surfaceAlt]).size, p.id).toBe(3);
      expect(border, p.id).not.toBe(surface);
    }
  });

  it('the dim layer behind sheets is the dark ink: dark enough to dim a light page and a dark one', () => {
    for (const p of PALETTES) expect(relativeLuminance(p.colors.scrim), p.id).toBeLessThan(0.2);
  });
});

describe('contrast helpers', () => {
  it('computes WCAG ratios', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 5);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 1); // the classic "just fails 4.5" grey
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 5);
  });

  it('rejects anything but #RRGGBB', () => {
    expect(hexToRgb('#1f1F28')).toEqual([31, 31, 40]);
    for (const bad of ['#FFF', '#FFFFFFFF', 'FFFFFF', 'rgb(0,0,0)', '']) expect(() => hexToRgb(bad), bad).toThrow();
  });

  it('bestInk takes the better candidate, and plain black or white when neither reaches the minimum', () => {
    expect(bestInk('#FFFFFF', ['#222222', '#EEEEEE'])).toBe('#222222');
    expect(bestInk('#101010', ['#222222', '#EEEEEE'])).toBe('#EEEEEE');
    // mid grey: both candidates are too close, so the fallback decides
    expect(bestInk('#808080', ['#777777', '#888888'])).toBe('#000000');
    expect(bestInk('#303030', ['#383838', '#404040'])).toBe('#FFFFFF');
    expect(bestInk('#123456', [])).toBe('#FFFFFF');
  });

  it('defineColors derives the on* colours from the two inks and keeps the dark ink as the scrim', () => {
    const base = { ...lightColors } as Record<string, string>;
    for (const key of ['onPrimary', 'onDanger', 'onWarning', 'onSuccess', 'scrim']) delete base[key];
    const built = defineColors(base as never, { dark: '#101018', light: '#F8F8F0' });
    expect(built.scrim).toBe('#101018');
    expect(built.onPrimary).toBe(bestInk(built.primary, ['#101018', '#F8F8F0']));
    expect(built.onDanger).toBe(bestInk(built.danger, ['#101018', '#F8F8F0']));
    expect(built.onWarning).toBe(bestInk(built.warning, ['#101018', '#F8F8F0']));
    expect(built.onSuccess).toBe(bestInk(built.success, ['#101018', '#F8F8F0']));
    expect(built.background).toBe(lightColors.background);
  });

  it('withAlpha appends a 2-digit alpha to a 6-digit colour', () => {
    expect(withAlpha('#16161D', 0.45)).toBe('#16161D73');
    expect(withAlpha('#16161D', 0)).toBe('#16161D00');
    expect(withAlpha('#16161D', 1)).toBe('#16161DFF');
    expect(withAlpha('#16161D', 7)).toBe('#16161DFF'); // clamped
    expect(withAlpha('#16161D', -1)).toBe('#16161D00');
  });
});

describe('resolvePalette: which palette is on screen', () => {
  const prefs = (mode: ThemePrefs['mode'], light = 'github-light', dark = 'dracula'): ThemePrefs => ({ mode, light, dark, corners: 'rounded' });

  it('Match system follows the device', () => {
    expect(resolvePalette(prefs('system'), 'light').id).toBe('github-light');
    expect(resolvePalette(prefs('system'), 'dark').id).toBe('dracula');
  });

  it('Match system with an unknown device scheme counts as light', () => {
    for (const scheme of [null, undefined, 'unspecified', '']) expect(resolvePalette(prefs('system'), scheme).id).toBe('github-light');
  });

  it('Light and Dark ignore the device', () => {
    for (const scheme of ['light', 'dark', null, undefined]) {
      expect(resolvePalette(prefs('light'), scheme).id).toBe('github-light');
      expect(resolvePalette(prefs('dark'), scheme).id).toBe('dracula');
    }
  });

  it('the default choice is Kanagawa Lotus by day and Kanagawa Wave at night', () => {
    expect(resolvePalette(DEFAULT_THEME_PREFS, 'light')).toBe(DEFAULT_LIGHT);
    expect(resolvePalette(DEFAULT_THEME_PREFS, 'dark')).toBe(DEFAULT_DARK);
  });

  it('an unknown or removed id falls back to the default of that side, a palette of the other side too', () => {
    expect(resolvePalette(prefs('light', 'gone-palette'), 'light')).toBe(DEFAULT_LIGHT);
    expect(resolvePalette(prefs('dark', 'light', 'gone-palette'), 'dark')).toBe(DEFAULT_DARK);
    expect(resolvePalette(prefs('light', 'dracula'), 'light')).toBe(DEFAULT_LIGHT); // a dark palette in the light slot
    expect(resolvePalette(prefs('dark', 'github-light', 'paper'), 'dark')).toBe(DEFAULT_DARK); // a light palette in the dark slot
  });

  it('every palette can be selected on its side and resolves to itself', () => {
    for (const p of LIGHT_PALETTES) expect(resolvePalette({ mode: 'light', light: p.id, dark: DEFAULT_DARK_ID }, 'dark')).toBe(p);
    for (const p of DARK_PALETTES) expect(resolvePalette({ mode: 'dark', light: DEFAULT_LIGHT_ID, dark: p.id }, 'light')).toBe(p);
  });

  it('gives back the same colors object for the same palette (so useTheme().colors is referentially stable)', () => {
    const a = resolvePalette(prefs('system'), 'dark');
    const b = resolvePalette(prefs('dark'), 'light');
    expect(a.colors).toBe(b.colors);
  });
});

describe('saved theme choice', () => {
  it('is saved under a versioned key', () => {
    expect(THEME_STORAGE_KEY).toBe('ration.theme.v1');
  });

  it('sanitises: bad mode -> system, unknown ids -> defaults, wrong types ignored', () => {
    expect(sanitizeThemePrefs(null)).toEqual(DEFAULT_THEME_PREFS);
    expect(sanitizeThemePrefs(undefined)).toEqual(DEFAULT_THEME_PREFS);
    expect(sanitizeThemePrefs('dark')).toEqual(DEFAULT_THEME_PREFS);
    expect(sanitizeThemePrefs([])).toEqual(DEFAULT_THEME_PREFS);
    expect(sanitizeThemePrefs({ mode: 'sepia', light: 7, dark: {} })).toEqual(DEFAULT_THEME_PREFS);
    expect(sanitizeThemePrefs({ mode: 'dark', light: 'paper', dark: 'nord' })).toEqual({ mode: 'dark', light: 'paper', dark: 'nord', corners: DEFAULT_CORNERS });
    expect(sanitizeThemePrefs({ mode: 'light', light: 'removed' })).toEqual({ mode: 'light', light: DEFAULT_LIGHT_ID, dark: DEFAULT_DARK_ID, corners: DEFAULT_CORNERS });
    expect(sanitizeThemePrefs({ mode: 'system', light: 'nord', dark: 'paper' })).toEqual(DEFAULT_THEME_PREFS);
  });

  it('parses stored JSON and never throws on bad input', () => {
    expect(parseThemePrefs(null)).toEqual(DEFAULT_THEME_PREFS);
    expect(parseThemePrefs(undefined)).toEqual(DEFAULT_THEME_PREFS);
    expect(parseThemePrefs('')).toEqual(DEFAULT_THEME_PREFS);
    expect(parseThemePrefs('{not json')).toEqual(DEFAULT_THEME_PREFS);
    expect(parseThemePrefs('42')).toEqual(DEFAULT_THEME_PREFS);
    expect(parseThemePrefs('{"mode":"dark","light":"one-light","dark":"one-dark"}')).toEqual({ mode: 'dark', light: 'one-light', dark: 'one-dark', corners: DEFAULT_CORNERS });
  });

  it('round-trips through the stored string', () => {
    const chosen: ThemePrefs = { mode: 'light', light: 'rose-pine-dawn', dark: 'tokyo-night', corners: 'boxy' };
    expect(JSON.parse(serializeThemePrefs(chosen))).toEqual(chosen);
    expect(parseThemePrefs(serializeThemePrefs(chosen))).toEqual(chosen);
    // what the smoke harness seeds is the same shape
    expect(Object.keys(JSON.parse(serializeThemePrefs(chosen))).sort()).toEqual(['corners', 'dark', 'light', 'mode']);
  });

  it('corners: Boxy is the default; a choice saved before the Boxy look existed (no field) and anything unknown get the default', () => {
    expect(DEFAULT_THEME_PREFS.corners).toBe('boxy');
    expect(DEFAULT_CORNERS).toBe('boxy');
    // the exact payload an older version saved
    const old = '{"mode":"dark","light":"paper","dark":"nord"}';
    expect(parseThemePrefs(old)).toEqual({ mode: 'dark', light: 'paper', dark: 'nord', corners: 'boxy' });
    for (const bad of ['square', 'BOXY', 'Boxy', '', 7, null, true, {}, ['boxy']]) {
      expect(sanitizeThemePrefs({ ...DEFAULT_THEME_PREFS, corners: bad }).corners, JSON.stringify(bad)).toBe('boxy');
    }
    expect(sanitizeThemePrefs({ corners: 'rounded' })).toEqual({ ...DEFAULT_THEME_PREFS, corners: 'rounded' });
    expect(parseThemePrefs('{"corners":"rounded"}')).toEqual({ ...DEFAULT_THEME_PREFS, corners: 'rounded' });
    expect(parseThemePrefs('{"corners":"sharp"}')).toEqual(DEFAULT_THEME_PREFS);
  });

  it('corners: round trips and is always written, with the same storage key as before', () => {
    for (const corners of CORNERS) {
      const prefs: ThemePrefs = { ...DEFAULT_THEME_PREFS, corners };
      expect(serializeThemePrefs(prefs)).toContain(`"corners":"${corners}"`);
      expect(parseThemePrefs(serializeThemePrefs(prefs))).toEqual(prefs);
    }
    expect(serializeThemePrefs({ ...DEFAULT_THEME_PREFS, corners: 'boxy' })).toBe(
      '{"mode":"system","light":"kanagawa-lotus","dark":"kanagawa-wave","corners":"boxy"}',
    );
    expect(THEME_STORAGE_KEY).toBe('ration.theme.v1'); // no version bump: the new field is optional on read
  });

  it('corners never change which palette is on screen', () => {
    for (const corners of CORNERS) {
      expect(resolvePalette({ ...DEFAULT_THEME_PREFS, corners }, 'light')).toBe(DEFAULT_LIGHT);
      expect(resolvePalette({ ...DEFAULT_THEME_PREFS, corners }, 'dark')).toBe(DEFAULT_DARK);
    }
  });

  it('knows when the choice is the default (the Reset to default button shows otherwise)', () => {
    expect(isDefaultThemePrefs(DEFAULT_THEME_PREFS)).toBe(true);
    expect(isDefaultThemePrefs({ ...DEFAULT_THEME_PREFS, mode: 'dark' })).toBe(false);
    expect(isDefaultThemePrefs({ ...DEFAULT_THEME_PREFS, light: 'paper' })).toBe(false);
    expect(isDefaultThemePrefs({ ...DEFAULT_THEME_PREFS, dark: 'nord' })).toBe(false);
    expect(isDefaultThemePrefs({ ...DEFAULT_THEME_PREFS, corners: 'rounded' })).toBe(false); // Reset to default is offered for Rounded too
    expect(isDefaultThemePrefs({ ...DEFAULT_THEME_PREFS, corners: 'boxy' })).toBe(true);
  });
});

describe('palette grid layout', () => {
  it('uses two columns on a phone and up to five on a wide screen', () => {
    expect(paletteColumns(326)).toBe(2); // 390 px phone, inside the page padding and the card padding
    expect(paletteColumns(296)).toBe(2);
    expect(paletteColumns(440)).toBe(3);
    expect(paletteColumns(600)).toBe(4);
    expect(paletteColumns(816)).toBe(5); // desktop content column
    expect(paletteColumns(4000)).toBe(5);
  });

  it('never goes below two columns, also while the grid has not been measured', () => {
    for (const w of [0, -5, 40, Number.NaN]) expect(paletteColumns(w)).toBe(2);
  });

  it('cards are at least the minimum width wherever there is room, and a row fills the container', () => {
    for (const width of [326, 440, 600, 816]) {
      const columns = paletteColumns(width);
      const card = paletteCardWidth(width, columns);
      expect(card).toBeGreaterThanOrEqual(PALETTE_CARD_MIN_WIDTH);
      expect(card * columns + PALETTE_GRID_GAP * (columns - 1)).toBeLessThanOrEqual(width);
      expect(card * columns + PALETTE_GRID_GAP * (columns - 1)).toBeGreaterThan(width - columns);
    }
  });
});

describe('smoke harness: theme seeding and page checks (src/theme-seed.ts)', () => {
  it('--theme pins the palette to its own side and leaves the other side at its default', () => {
    expect(themePrefsFor('dracula')).toEqual({ mode: 'dark', light: DEFAULT_LIGHT_ID, dark: 'dracula', corners: DEFAULT_CORNERS });
    expect(themePrefsFor('paper')).toEqual({ mode: 'light', light: 'paper', dark: DEFAULT_DARK_ID, corners: DEFAULT_CORNERS });
    expect(themePrefsFor('paper', 'rounded')).toEqual({ mode: 'light', light: 'paper', dark: DEFAULT_DARK_ID, corners: 'rounded' });
    expect(themePrefsFor('nope')).toBeNull();
    for (const id of KNOWN_PALETTE_IDS) {
      const prefs = themePrefsFor(id)!;
      // what is seeded survives the app's own sanitising unchanged, and resolves to that very palette in either browser scheme
      expect(sanitizeThemePrefs(prefs), id).toEqual(prefs);
      for (const scheme of ['light', 'dark'] as const) expect(resolvePalette(prefs, scheme).id, id).toBe(id);
    }
    expect(KNOWN_PALETTE_IDS).toEqual(PALETTES.map((p) => p.id));
    expect(THEME_STORAGE_KEY_FOR_SMOKE).toBe('ration.theme.v1');
  });

  it('--corners and --theme decide what is seeded: neither seeds nothing, either one alone seeds a valid choice', () => {
    expect(themeSeedFor({})).toBeNull();
    expect(themeSeedFor({ theme: 'dracula' })).toEqual({ mode: 'dark', light: DEFAULT_LIGHT_ID, dark: 'dracula', corners: DEFAULT_CORNERS });
    // corners alone: Match system with the default palettes, only the corners differ
    expect(themeSeedFor({ corners: 'rounded' })).toEqual({ mode: 'system', light: DEFAULT_LIGHT_ID, dark: DEFAULT_DARK_ID, corners: 'rounded' });
    expect(themeSeedFor({ corners: 'boxy' })).toEqual(DEFAULT_THEME_PREFS);
    expect(themeSeedFor({ theme: 'paper', corners: 'rounded' })).toEqual({ mode: 'light', light: 'paper', dark: DEFAULT_DARK_ID, corners: 'rounded' });
    expect(themeSeedFor({ theme: 'nope', corners: 'rounded' })).toBeNull();
    for (const corners of KNOWN_CORNERS) {
      const seeded = themeSeedFor({ corners })!;
      expect(sanitizeThemePrefs(seeded)).toEqual(seeded); // survives the app's own sanitising unchanged
    }
    expect(KNOWN_CORNERS).toEqual(CORNERS);
  });

  it('judges the corner radius of a card read from the page', () => {
    expect(cardRadiusMismatch('rounded', 16)).toBeNull();
    expect(cardRadiusMismatch('rounded', ROUNDED_CARD_MIN_PX)).toBeNull();
    expect(cardRadiusMismatch('rounded', 6)).toContain('at least 12px');
    expect(cardRadiusMismatch('boxy', 6)).toBeNull();
    expect(cardRadiusMismatch('boxy', BOXY_CARD_MAX_PX)).toBeNull();
    expect(cardRadiusMismatch('boxy', 16)).toContain('expected 1-8px');
    expect(cardRadiusMismatch('boxy', 0)).toContain('expected 1-8px'); // square corners would mean the radius is gone, not boxy
    for (const bad of [null, undefined, Number.NaN]) {
      expect(cardRadiusMismatch('rounded', bad)).toContain('"Appearance" heading');
      expect(cardRadiusMismatch('boxy', bad)).toContain('"Appearance" heading');
    }
  });

  it('turns a #RRGGBB colour into what getComputedStyle reports', () => {
    expect(cssRgb('#1F1F28')).toBe('rgb(31, 31, 40)');
    expect(cssRgb('#ffffff')).toBe('rgb(255, 255, 255)');
    expect(() => cssRgb('#fff')).toThrow();
  });

  it('compares a page reading with a palette and names every difference', () => {
    const wave = getPalette('kanagawa-wave')!;
    const good = {
      stored: '{"mode":"dark","light":"kanagawa-lotus","dark":"kanagawa-wave"}',
      bodyBackground: 'rgb(31, 31, 40)',
      colorScheme: 'dark',
      themeColor: wave.colors.background,
      paletteId: 'kanagawa-wave',
    };
    expect(themeMismatches(good, { paletteId: 'kanagawa-wave' })).toEqual([]);
    expect(themeMismatches(good, { paletteId: 'kanagawa-wave', stored: { mode: 'dark', dark: 'kanagawa-wave' } })).toEqual([]);
    expect(themeMismatches({ ...good, stored: null }, { paletteId: 'kanagawa-wave', stored: null })).toEqual([]);

    const wrong = themeMismatches({ ...good, bodyBackground: 'rgb(255, 255, 255)', colorScheme: 'light' }, { paletteId: 'kanagawa-wave' });
    expect(wrong).toHaveLength(2);
    expect(wrong[0]).toContain('page background');
    expect(wrong[1]).toContain('color-scheme');

    expect(themeMismatches(good, { paletteId: 'kanagawa-wave', stored: { dark: 'dracula' } })).toEqual(['saved dark is "kanagawa-wave", expected "dracula"']);
    expect(themeMismatches({ ...good, stored: null }, { paletteId: 'kanagawa-wave', stored: { mode: 'dark' } })).toEqual(['nothing is saved in localStorage']);
    expect(themeMismatches(good, { paletteId: 'kanagawa-wave', stored: null })[0]).toContain('expected nothing saved');
    expect(themeMismatches({ ...good, stored: '{oops' }, { paletteId: 'kanagawa-wave', stored: { mode: 'dark' } })[0]).toContain('not JSON');
    // a page that is not the app at all (the fake pages of the runner test) never matches, and never throws
    expect(themeMismatches({}, { paletteId: 'kanagawa-wave' })).toHaveLength(4);
    expect(themeMismatches({}, { paletteId: 'no-such-palette' })).toEqual(['unknown palette "no-such-palette"']);
  });
});
