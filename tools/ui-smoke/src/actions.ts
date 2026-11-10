/**
 * Small Playwright helpers for react-native-web DOM: Pressable => div[role=button], Text => div, TextInput =>
 * input / textarea. The app's TextField sets the label as aria-label (and aria-labelledby), so `getByLabel` finds
 * a field by its visible label; the DOM walk (`fieldByLabel`) remains as a fallback for inputs that are not
 * built with TextField.
 */
import type { Locator, Page } from 'playwright-core';

/** XPath string literal for any text. */
export function xpathLiteral(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat(${s.split("'").map((part) => `'${part}'`).join(`, "'", `)})`;
}

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZĆČŠŽĐ';
const LOWER = 'abcdefghijklmnopqrstuvwxyzćčšžđ';

/** Locator for the input that sits next to a label Text, e.g. `fieldByLabel(page, 'Height (cm)')`. */
export function fieldByLabel(page: Page, label: string, opts: { exact?: boolean } = {}): Locator {
  const folded = `translate(normalize-space(.), '${UPPER}', '${LOWER}')`;
  const lit = xpathLiteral(label.trim().toLowerCase());
  const test = opts.exact ? `${folded}=${lit}` : `starts-with(${folded}, ${lit})`;
  return page.locator(`xpath=//div[./div[${test}]]/*[self::input or self::textarea]`);
}

/**
 * Finds a text input by aria-label, placeholder or visible label (in that order), waiting until one exists.
 * `key` as string: label/placeholder text; as RegExp: aria-label / placeholder.
 */
export async function findField(page: Page, key: string | RegExp, timeoutMs = 6000): Promise<Locator> {
  const candidates = (): Locator[] =>
    typeof key === 'string'
      ? [page.getByLabel(key, { exact: true }), page.getByPlaceholder(key), fieldByLabel(page, key, { exact: true }), fieldByLabel(page, key)]
      : [page.getByLabel(key), page.getByPlaceholder(key)];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const candidate of candidates()) {
      if ((await candidate.count()) > 0) return candidate.first();
    }
    if (Date.now() > deadline) throw new Error(`No input found for ${String(key)}`);
    await page.waitForTimeout(150);
  }
}

export async function fill(page: Page, key: string | RegExp, value: string, timeoutMs = 6000): Promise<void> {
  const field = await findField(page, key, timeoutMs);
  await field.fill(value, { timeout: timeoutMs });
}

export interface ClickOptions {
  /** Whole accessible name / text (case-sensitive) instead of a case-insensitive substring. */
  exact?: boolean;
  timeout?: number;
}

/** Clicks the first button (role=button) whose accessible name matches. */
export async function clickButton(page: Page, name: string | RegExp, opts: ClickOptions = {}): Promise<void> {
  await page.getByRole('button', { name, exact: opts.exact ?? false }).first().click({ timeout: opts.timeout ?? 6000 });
}

/** Clicks a tab (role=tab) by accessible name, e.g. the diary tabs "Exercise, 2". */
export async function clickTab(page: Page, name: string | RegExp, opts: ClickOptions = {}): Promise<void> {
  await page.getByRole('tab', { name, exact: opts.exact ?? false }).first().click({ timeout: opts.timeout ?? 6000 });
}

/** Clicks the first element showing the text (substring, case-insensitive unless `exact`). */
export async function clickText(page: Page, text: string | RegExp, opts: { exact?: boolean; timeout?: number; nth?: number } = {}): Promise<void> {
  const locator = page.getByText(text, { exact: opts.exact ?? false });
  await (opts.nth === undefined ? locator.first() : locator.nth(opts.nth)).click({ timeout: opts.timeout ?? 6000 });
}

/** Clicks a radio / chip / segmented option by its visible label. Tries role=radio, role=button, then plain text. */
export async function choose(page: Page, label: string | RegExp, opts: ClickOptions = {}): Promise<void> {
  const timeout = opts.timeout ?? 6000;
  for (const role of ['radio', 'button'] as const) {
    const loc = page.getByRole(role, { name: label, exact: opts.exact ?? false });
    if ((await loc.count()) > 0) {
      await loc.first().click({ timeout });
      return;
    }
  }
  await clickText(page, label, { timeout, exact: opts.exact ?? false });
}

export async function isVisible(page: Page, text: string | RegExp, exact = false): Promise<boolean> {
  return page.getByText(text, { exact }).first().isVisible();
}

export async function waitForText(page: Page, text: string | RegExp, opts: { timeout?: number; exact?: boolean } = {}): Promise<void> {
  await page.getByText(text, { exact: opts.exact ?? false }).first().waitFor({ state: 'visible', timeout: opts.timeout ?? 8000 });
}

export async function waitForNoText(page: Page, text: string | RegExp, opts: { timeout?: number; exact?: boolean } = {}): Promise<void> {
  await page.getByText(text, { exact: opts.exact ?? false }).first().waitFor({ state: 'hidden', timeout: opts.timeout ?? 8000 });
}

/** Scrolls an element into view (scroll containers are inner divs on react-native-web). */
export async function scrollToText(page: Page, text: string | RegExp, timeoutMs = 6000): Promise<void> {
  await page.getByText(text).first().scrollIntoViewIfNeeded({ timeout: timeoutMs });
}

/** True when `actual` equals `expected` (string: whole value, ignoring surrounding whitespace; RegExp: `test`). */
export function valueMatches(actual: string, expected: string | RegExp): boolean {
  return typeof expected === 'string' ? actual.trim() === expected.trim() : expected.test(actual);
}

export interface InputValueResult {
  ok: boolean;
  /** The last value read, or null when the field was never found / read. */
  actual: string | null;
  /** Why the field could not be found or read. */
  error?: string;
}

/**
 * Waits until the input found by `key` (see {@link findField}) has the expected value. Names such as "Ćevapi" are
 * INPUT VALUES on edit screens, not page text, so `getByText` can never see them.
 */
export async function waitForInputValue(page: Page, key: string | RegExp, expected: string | RegExp, timeoutMs = 8000): Promise<InputValueResult> {
  const deadline = Date.now() + timeoutMs;
  let field: Locator;
  try {
    field = await findField(page, key, timeoutMs);
  } catch (e) {
    return { ok: false, actual: null, error: e instanceof Error ? e.message : String(e) };
  }
  let actual: string | null = null;
  let error: string | undefined;
  for (;;) {
    try {
      actual = await field.inputValue({ timeout: 2000 });
      error = undefined;
      if (valueMatches(actual, expected)) return { ok: true, actual };
    } catch (e) {
      error = e instanceof Error ? (e.message.split('\n')[0] ?? e.message) : String(e);
    }
    if (Date.now() > deadline) return { ok: false, actual, ...(error ? { error } : {}) };
    await page.waitForTimeout(150);
  }
}

/**
 * Closes the open sheet / modal by clicking its scrim (the "Close" button) in the top-left corner, which no sheet
 * covers, and optionally waits until `gone` is no longer visible.
 *
 * Prefer this to the Escape key where the test is not about the keyboard: it needs no keyboard focus and no timing.
 * (react-native-web's Modal only starts listening for Escape once its fade-in animation ended, which is why the app's
 * Sheet does not animate on the web; a sheet that stays open leaves a scrim that swallows every following click.)
 */
export async function closeSheet(page: Page, gone?: string | RegExp, timeoutMs = 6000): Promise<void> {
  await page.getByRole('button', { name: 'Close', exact: true }).first().click({ position: { x: 4, y: 4 }, timeout: timeoutMs });
  if (gone !== undefined) await page.getByText(gone).first().waitFor({ state: 'hidden', timeout: timeoutMs });
}
