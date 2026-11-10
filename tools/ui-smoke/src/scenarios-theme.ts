/**
 * Smoke scenario of the theme picker (Settings > Display & units > Appearance). Appended to the main list by scenarios.ts.
 *
 * The scenario drives the real picker and then reads the page: the saved choice in localStorage (`cal-track.theme.v1`), the
 * computed background of the page body, the root `color-scheme`, the `<meta name="theme-color">` and the palette id the app puts
 * on the root element. Everything it compares with comes from apps/app/src/theme/palettes.ts, so a changed palette needs no edit
 * here. The browser's own colour scheme (the default viewports are light; `--viewports=phone-dark` is dark) decides which side
 * Match system shows, and the scenario accounts for it.
 */
import type { Page } from 'playwright-core';

import { DEFAULT_DARK_ID, DEFAULT_LIGHT_ID } from '../../../apps/app/src/theme/palettes';
import { choose } from './actions';
import { readThemeScript } from './browser-scripts';
import { THEME_STORAGE_KEY, themeMismatches, type ThemeExpectation, type ThemeReading } from './theme-seed';
import type { Scenario, ScenarioContext } from './types';

/** Runs an interaction; runs the follow-up assertions only when the interaction worked. */
async function stepThen(ctx: ScenarioContext, label: string, act: () => Promise<unknown>, then: () => Promise<unknown>): Promise<void> {
  if (await ctx.step(label, act)) await then();
}

/** Waits (the choice is saved and applied asynchronously) until the page shows the palette, else FAIL with every difference. */
async function expectTheme(ctx: ScenarioContext, page: Page, label: string, want: ThemeExpectation, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let problems: string[] = [];
  for (;;) {
    const reading = (await page.evaluate(readThemeScript(THEME_STORAGE_KEY))) as ThemeReading | null;
    problems = themeMismatches(reading ?? {}, want);
    if (problems.length === 0) return;
    if (Date.now() > deadline) break;
    await page.waitForTimeout(100);
  }
  ctx.fail(`${label}: ${problems.join('; ')}`);
}

export const THEME_SCENARIOS: Scenario[] = [
  {
    name: 'settings: appearance (theme picker)',
    route: '/settings/display',
    path: '/settings/display',
    auth: 'signed-in',
    expect: ['Appearance', 'Mode', 'Light palette', 'Dark palette', 'Kanagawa Wave', 'Kanagawa Lotus', 'Catppuccin Mocha'],
    async after(page, ctx) {
      // What Match system shows depends on the browser's colour scheme.
      const osDark = ctx.viewport.endsWith('dark');
      const systemPalette = (light: string, dark: string): string => (osDark ? dark : light);

      // A run started with --theme=<id> begins with a saved choice: go back to the defaults first.
      await ctx.step('start from the defaults (Reset to default, only offered when the choice differs)', async () => {
        const reset = page.getByRole('button', { name: 'Reset to default', exact: true });
        if ((await reset.count()) > 0) await reset.first().click({ timeout: 6000 });
      });
      await expectTheme(ctx, page, 'default: Kanagawa Lotus by day, Kanagawa Wave at night', {
        paletteId: systemPalette(DEFAULT_LIGHT_ID, DEFAULT_DARK_ID),
      });
      await ctx.expectNoText('Reset to default', { exact: true });

      await stepThen(ctx, 'mode: Dark', () => choose(page, 'Dark', { exact: true }), async () => {
        await expectTheme(ctx, page, 'Dark mode shows the dark palette', { paletteId: DEFAULT_DARK_ID, stored: { mode: 'dark', dark: DEFAULT_DARK_ID } });
        await ctx.expectText('Reset to default', { exact: true });
      });

      await stepThen(ctx, 'dark palette: Dracula', () => choose(page, 'Dracula', { exact: true }), async () => {
        await expectTheme(ctx, page, 'Dracula is applied and saved', { paletteId: 'dracula', stored: { mode: 'dark', light: DEFAULT_LIGHT_ID, dark: 'dracula' } });
        await ctx.snapshot('dracula', { tall: false });
      });

      await stepThen(ctx, 'mode: Light', () => choose(page, 'Light', { exact: true }), async () => {
        await expectTheme(ctx, page, 'Light mode shows the light palette', { paletteId: DEFAULT_LIGHT_ID, stored: { mode: 'light' } });
      });

      await stepThen(ctx, 'light palette: Catppuccin Latte', () => choose(page, 'Catppuccin Latte', { exact: true }), async () => {
        await expectTheme(ctx, page, 'Catppuccin Latte is applied and saved', { paletteId: 'catppuccin-latte', stored: { mode: 'light', light: 'catppuccin-latte', dark: 'dracula' } });
        await ctx.snapshot('catppuccin-latte', { tall: false });
      });

      await stepThen(ctx, 'mode: Match system', () => choose(page, 'Match system', { exact: true }), async () => {
        await expectTheme(ctx, page, 'Match system follows the browser and keeps both choices', {
          paletteId: systemPalette('catppuccin-latte', 'dracula'),
          stored: { mode: 'system', light: 'catppuccin-latte', dark: 'dracula' },
        });
      });

      await stepThen(ctx, 'Reset to default', () => choose(page, 'Reset to default', { exact: true }), async () => {
        await expectTheme(ctx, page, 'Reset to default brings back Match system and the Kanagawa palettes', {
          paletteId: systemPalette(DEFAULT_LIGHT_ID, DEFAULT_DARK_ID),
          stored: { mode: 'system', light: DEFAULT_LIGHT_ID, dark: DEFAULT_DARK_ID },
        });
        await ctx.expectNoText('Reset to default', { exact: true });
      });
    },
  },
];
