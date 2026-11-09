/**
 * Small Playwright helpers for react-native-web DOM: Pressable => div[role=button], Text => div, TextInput =>
 * input / textarea that is a direct child of the field's View, next to the label Text (the app's TextField does
 * NOT associate the label with the input, so label based lookup walks the DOM).
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
