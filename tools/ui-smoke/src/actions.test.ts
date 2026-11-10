/** Playwright helpers of actions.ts against a tiny fake page (no browser). */
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';

import { closeSheet, valueMatches, waitForInputValue } from './actions';

interface Call {
  method: string;
  args: unknown[];
}

class FakeLocator {
  constructor(
    private readonly page: FakePage,
    readonly description: string,
  ) {}
  first() {
    return this;
  }
  async count() {
    return this.page.existing.has(this.description) ? 1 : 0;
  }
  async inputValue(options?: unknown) {
    this.page.calls.push({ method: 'inputValue', args: [this.description, options] });
    const values = this.page.values.get(this.description) ?? [''];
    const value = values[Math.min(this.page.reads, values.length - 1)] as string;
    this.page.reads += 1;
    if (value === '__throw__') throw new Error('Element is not an <input>\n  at locator.inputValue');
    return value;
  }
  async click(options?: unknown) {
    this.page.calls.push({ method: 'click', args: [this.description, options] });
  }
  async waitFor(options?: unknown) {
    this.page.calls.push({ method: 'waitFor', args: [this.description, options] });
  }
}

class FakePage {
  existing = new Set<string>();
  values = new Map<string, string[]>();
  reads = 0;
  calls: Call[] = [];
  getByLabel(key: string | RegExp) {
    return new FakeLocator(this, `label:${String(key)}`);
  }
  getByPlaceholder(key: string | RegExp) {
    return new FakeLocator(this, `placeholder:${String(key)}`);
  }
  getByRole(role: string, options: { name?: string | RegExp; exact?: boolean }) {
    return new FakeLocator(this, `role:${role}:${String(options.name)}:${options.exact === true}`);
  }
  getByText(text: string | RegExp) {
    return new FakeLocator(this, `text:${String(text)}`);
  }
  locator(selector: string) {
    return new FakeLocator(this, selector);
  }
  async waitForTimeout(ms: number) {
    this.calls.push({ method: 'waitForTimeout', args: [ms] });
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const asPage = (page: FakePage): Page => page as unknown as Page;

describe('valueMatches', () => {
  it('compares strings as a whole value (trimmed) and regular expressions by match', () => {
    expect(valueMatches('Ćevapi', 'Ćevapi')).toBe(true);
    expect(valueMatches(' Ćevapi ', 'Ćevapi')).toBe(true);
    expect(valueMatches('Ćevapi (domaći)', 'Ćevapi')).toBe(false);
    expect(valueMatches('', '')).toBe(true);
    expect(valueMatches('', 'x')).toBe(false);
    expect(valueMatches('Ćevapi (domaći)', /^Ćevapi/)).toBe(true);
    expect(valueMatches('x', /y/)).toBe(false);
  });
});

describe('waitForInputValue', () => {
  it('finds the field by label and returns as soon as the value matches', async () => {
    const page = new FakePage();
    page.existing.add('label:Food name');
    page.values.set('label:Food name', ['', '', 'Ćevapi']); // the form fills in after the query returned
    const result = await waitForInputValue(asPage(page), 'Food name', 'Ćevapi', 3000);
    expect(result).toEqual({ ok: true, actual: 'Ćevapi' });
    expect(page.calls.filter((c) => c.method === 'waitForTimeout')).toHaveLength(2);
  });

  it('falls back to the placeholder, and accepts a regular expression for the value', async () => {
    const page = new FakePage();
    page.existing.add('placeholder:Search foods');
    page.values.set('placeholder:Search foods', ['chicken']);
    expect(await waitForInputValue(asPage(page), 'Search foods', /^chick/, 1000)).toEqual({ ok: true, actual: 'chicken' });
  });

  it('reports the last value when it never matches', async () => {
    const page = new FakePage();
    page.existing.add('label:Recipe name');
    page.values.set('label:Recipe name', ['Piletina']);
    const result = await waitForInputValue(asPage(page), 'Recipe name', 'Piletina s rižom', 300);
    expect(result).toEqual({ ok: false, actual: 'Piletina' });
  });

  it('reports a field that does not exist instead of throwing', async () => {
    const result = await waitForInputValue(asPage(new FakePage()), 'Nope', 'x', 200);
    expect(result.ok).toBe(false);
    expect(result.actual).toBeNull();
    expect(result.error).toContain('No input found for Nope');
  });

  it('keeps polling when a read fails (the node is being replaced), and reports the first line of the error', async () => {
    const page = new FakePage();
    page.existing.add('label:Food name');
    page.values.set('label:Food name', ['__throw__', 'Ćevapi']);
    expect(await waitForInputValue(asPage(page), 'Food name', 'Ćevapi', 2000)).toEqual({ ok: true, actual: 'Ćevapi' });

    const broken = new FakePage();
    broken.existing.add('label:Food name');
    broken.values.set('label:Food name', ['__throw__']);
    const failed = await waitForInputValue(asPage(broken), 'Food name', 'x', 200);
    expect(failed).toMatchObject({ ok: false, actual: null, error: 'Element is not an <input>' });
  });
});

describe('closeSheet', () => {
  it('clicks the scrim in its top-left corner (never covered by the sheet) and waits for the sheet text to go', async () => {
    const page = new FakePage();
    await closeSheet(asPage(page), 'Add food to Breakfast', 1234);
    expect(page.calls).toEqual([
      { method: 'click', args: ['role:button:Close:true', { position: { x: 4, y: 4 }, timeout: 1234 }] },
      { method: 'waitFor', args: ['text:Add food to Breakfast', { state: 'hidden', timeout: 1234 }] },
    ]);
  });

  it('does not wait for anything when no text is given', async () => {
    const page = new FakePage();
    await closeSheet(asPage(page));
    expect(page.calls.map((c) => c.method)).toEqual(['click']);
  });
});
