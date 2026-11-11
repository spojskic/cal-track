/**
 * Smoke scenario of the theme picker (Settings > Display & units > Appearance). Appended to the main list by scenarios.ts.
 *
 * The scenario drives the real picker and then reads the page: the saved choice in localStorage (`ration.theme.v1`), the
 * computed background of the page body, the root `color-scheme`, the `<meta name="theme-color">` and the palette id the app puts
 * on the root element. Everything it compares with comes from apps/app/src/theme/palettes.ts, so a changed palette needs no edit
 * here. The browser's own colour scheme (the default viewports are light; `--viewports=phone-dark` is dark) decides which side
 * Match system shows, and the scenario accounts for it. It also flips the Corners switch (Rounded / Boxy) and checks the saved
 * choice and the computed corner radius of the card around the "Appearance" heading.
 */
import type { Page } from 'playwright-core';

import { DEFAULT_DARK_ID, DEFAULT_LIGHT_ID } from '../../../apps/app/src/theme/palettes';
import { choose } from './actions';
import { cardRadiusScript, readThemeScript } from './browser-scripts';
import { THEME_STORAGE_KEY, cardRadiusMismatch, themeMismatches, type Corners, type ThemeExpectation, type ThemeReading } from './theme-seed';
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

/** The computed corner radius (px) of the card around the "Appearance" heading, or null when there is none. */
async function readAppearanceCardRadius(page: Page): Promise<number | null> {
  return (await page.evaluate(cardRadiusScript('Appearance'))) as number | null;
}

/**
 * Waits (the switch is applied by React after the click) until the card has the corners of `corners`, else FAIL.
 * Returns the radius that was read last (null when the card was not found).
 */
async function expectCardCorners(ctx: ScenarioContext, page: Page, label: string, corners: Corners, timeoutMs = 5000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  let px: number | null = null;
  let problem: string | null = null;
  for (;;) {
    px = await readAppearanceCardRadius(page);
    problem = cardRadiusMismatch(corners, px);
    if (problem === null) return px;
    if (Date.now() > deadline) break;
    await page.waitForTimeout(100);
  }
  ctx.fail(`${label}: ${problem}`);
  return px;
}

export const THEME_SCENARIOS: Scenario[] = [
  {
    name: 'settings: appearance (theme picker)',
    route: '/settings/display',
    path: '/settings/display',
    auth: 'signed-in',
    expect: ['Appearance', 'Mode', 'Corners', 'Rounded', 'Boxy', 'Light palette', 'Dark palette', 'Kanagawa Wave', 'Kanagawa Lotus', 'Catppuccin Mocha'],
    async after(page, ctx) {
      // What Match system shows depends on the browser's colour scheme.
      const osDark = ctx.viewport.endsWith('dark');
      const systemPalette = (light: string, dark: string): string => (osDark ? dark : light);

      // A run started with --theme=<id> or --corners=rounded begins with a saved choice: go back to the defaults first.
      await ctx.step('start from the defaults (Reset to default, only offered when the choice differs)', async () => {
        const reset = page.getByRole('button', { name: 'Reset to default', exact: true });
        if ((await reset.count()) > 0) await reset.first().click({ timeout: 6000 });
      });
      await expectTheme(ctx, page, 'default: Kanagawa Lotus by day, Kanagawa Wave at night', {
        paletteId: systemPalette(DEFAULT_LIGHT_ID, DEFAULT_DARK_ID),
      });
      await ctx.expectNoText('Reset to default', { exact: true });

      // Corners: the default is Boxy; Rounded brings back the original big radius and Boxy shrinks it again.
      const boxyRadius = await expectCardCorners(ctx, page, 'default corners are Boxy', 'boxy');
      await stepThen(ctx, 'corners: Rounded', () => choose(page, 'Rounded', { exact: true }), async () => {
        await expectTheme(ctx, page, 'Rounded is saved', { paletteId: systemPalette(DEFAULT_LIGHT_ID, DEFAULT_DARK_ID), stored: { corners: 'rounded' } });
        await expectCardCorners(ctx, page, 'Rounded gives the cards big corners', 'rounded');
        await ctx.expectText('Reset to default', { exact: true });
        await ctx.snapshot('rounded', { tall: false });
      });
      await stepThen(ctx, 'corners: Boxy', () => choose(page, 'Boxy', { exact: true }), async () => {
        await expectTheme(ctx, page, 'Boxy is saved', { paletteId: systemPalette(DEFAULT_LIGHT_ID, DEFAULT_DARK_ID), stored: { corners: 'boxy' } });
        const back = await expectCardCorners(ctx, page, 'Boxy brings the small corners back', 'boxy');
        if (boxyRadius !== null && back !== null && back !== boxyRadius) ctx.fail(`Boxy corners are ${back}px, they were ${boxyRadius}px before Rounded`);
        await ctx.expectNoText('Reset to default', { exact: true });
      });

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

      // Reset to default brings back everything, the corners included: switch to Rounded first so there is something to reset.
      await stepThen(ctx, 'corners: Rounded (so Reset to default has corners to reset)', () => choose(page, 'Rounded', { exact: true }), async () => {
        await expectCardCorners(ctx, page, 'Rounded is applied together with the other choices', 'rounded');
      });

      await stepThen(ctx, 'Reset to default', () => choose(page, 'Reset to default', { exact: true }), async () => {
        await expectTheme(ctx, page, 'Reset to default brings back Match system, the Kanagawa palettes and Boxy corners', {
          paletteId: systemPalette(DEFAULT_LIGHT_ID, DEFAULT_DARK_ID),
          stored: { mode: 'system', light: DEFAULT_LIGHT_ID, dark: DEFAULT_DARK_ID, corners: 'boxy' },
        });
        await expectCardCorners(ctx, page, 'Reset to default brings back the default (boxy) corners', 'boxy');
        await ctx.expectNoText('Reset to default', { exact: true });
      });
    },
  },
];
