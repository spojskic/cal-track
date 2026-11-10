/**
 * Exercises runner.ts / routing end to end with a FAKE Playwright browser: the fake executes the real init scripts
 * in a vm sandbox, routes requests through the real route handler (static files + mock backend) and lets the test
 * "act as the app" by issuing fetches. It proves the orchestration (listeners, screenshots, issue classification,
 * assertions, timeouts, cleanup) without Chrome.
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

import type { Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppFiles } from './app-files';
import { ANON_KEY, APP_ORIGIN, BACKEND_ORIGIN, FIXED_NOW_MS, STORAGE_KEY, TIMEZONE } from './constants';
import { USER } from './fixtures';
import { slugify, runScenario, type RunDeps } from './runner';
import { SCENARIOS } from './scenarios';
import { resolvePath, type Scenario } from './types';

const USER_ID = USER.id;

interface FakeRouteHandler {
  (route: unknown): Promise<void>;
}

class FakeLocator {
  constructor(
    private readonly page: FakePage,
    private readonly description: string,
  ) {}
  first() {
    return this;
  }
  nth() {
    return this;
  }
  async waitFor(options: { state?: string }) {
    if (this.page.permissive) return;
    const present = this.page.visibleTexts.some((t) => this.page.matches(this.description, t));
    if (options.state === 'hidden' ? present : !present) throw new Error(`Timeout waiting for ${this.description} (${options.state})`);
  }
  async click() {
    if (!this.page.permissive && !this.page.visibleTexts.some((t) => this.page.matches(this.description, t))) throw new Error(`Timeout: no element for ${this.description}`);
    this.page.clicked.push(this.description);
    await this.page.onClick?.(this.description);
  }
  async scrollIntoViewIfNeeded() {}
  async count() {
    if (this.page.permissive) return 1;
    return this.page.visibleTexts.filter((t) => this.page.matches(this.description, t)).length;
  }
  async fill() {}
  async isVisible() {
    return (await this.count()) > 0;
  }
  async isEnabled() {
    return true;
  }
  async inputValue() {
    return this.page.inputValues.get(this.description) ?? '';
  }
}

class FakePage extends EventEmitter {
  /** Every locator exists, every URL matches: lets scenario scripts run to the end. */
  permissive = false;
  visibleTexts: string[] = ['Dashboard', 'Today 1,850 kcal remaining and more text'];
  clicked: string[] = [];
  currentUrl = 'about:blank';
  screenshots: string[] = [];
  viewports: { width: number; height: number }[] = [];
  evaluateOverrides: { textLength?: number; fatalHits?: string[]; suspectHits?: string[]; extra?: number } = {};
  /** Successive `textLength` values of the page inspection (the last one repeats): a screen that fills up while loading. */
  textLengthSequence: number[] = [];
  /** Value of an input by locator description (`text:<label>`). */
  inputValues = new Map<string, string>();
  inspections = 0;
  onClick?: (description: string) => Promise<void> | void;
  onGoto?: (url: string) => Promise<void>;
  keyboard = { press: async () => undefined };
  mouse = { wheel: async () => undefined };

  constructor(private readonly context: FakeContext) {
    super();
  }
  matches(description: string, text: string): boolean {
    const needle = description.replace(/^text:/, '').toLowerCase();
    return text.toLowerCase().includes(needle);
  }
  url() {
    return this.currentUrl;
  }
  async goto(url: string) {
    this.currentUrl = url;
    // the page document, then whatever the "app" does after loading
    await this.context.request(url, { headers: { accept: 'text/html' } });
    await this.onGoto?.(url);
  }
  async waitForLoadState() {}
  async waitForTimeout(ms?: number) {
    if (this.permissive) vi.advanceTimersByTime(ms ?? 0);
  }
  async waitForURL(pattern: RegExp) {
    if (!this.permissive && !pattern.test(this.currentUrl)) throw new Error('Timeout waiting for URL');
  }
  async setViewportSize(size: { width: number; height: number }) {
    this.viewports.push(size);
  }
  async screenshot(options: { path: string }) {
    writeFileSync(options.path, 'png');
    this.screenshots.push(options.path);
  }
  async evaluate(script: string) {
    if (script.includes('fatalHits')) {
      const o = this.evaluateOverrides;
      const sequenced = this.textLengthSequence[Math.min(this.inspections, this.textLengthSequence.length - 1)];
      this.inspections += 1;
      return { textLength: sequenced ?? o.textLength ?? 300, sample: 'sample', fatalHits: o.fatalHits ?? [], suspectHits: o.suspectHits ?? [] };
    }
    return { innerWidth: 390, innerHeight: 844, extra: this.evaluateOverrides.extra ?? 0 };
  }
  getByText(text: string | RegExp) {
    return new FakeLocator(this, `text:${String(text)}`);
  }
  getByRole(_role: string, options: { name?: string | RegExp }) {
    return new FakeLocator(this, `text:${String(options.name)}`);
  }
  getByPlaceholder(text: string | RegExp) {
    return new FakeLocator(this, `text:${String(text)}`);
  }
  getByLabel(text: string | RegExp) {
    return new FakeLocator(this, `text:${String(text)}`);
  }
  locator(selector: string) {
    return new FakeLocator(this, selector);
  }
}

class FakeContext {
  initScripts: string[] = [];
  handler?: FakeRouteHandler;
  pages: FakePage[] = [];
  closed = false;
  storage = new Map<string, string>();
  sessionStorage = new Map<string, string>();

  constructor(readonly options: Record<string, unknown>) {}

  async addInitScript(script: { content: string }) {
    this.initScripts.push(script.content);
  }
  async route(_match: unknown, handler: FakeRouteHandler) {
    this.handler = handler;
  }
  async newPage() {
    const page = new FakePage(this);
    page.permissive = this.options.__permissive === true;
    this.pages.push(page);
    return page;
  }
  async close() {
    this.closed = true;
  }

  /** Runs the init scripts for a document at `origin` (what Chrome does before the app scripts run). */
  runInitScripts(origin: string) {
    const storage = (map: Map<string, string>) => ({ getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) });
    const sandbox: Record<string, unknown> = { location: { origin }, localStorage: storage(this.storage), sessionStorage: storage(this.sessionStorage) };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    for (const script of this.initScripts) vm.runInContext(script, sandbox);
    return sandbox;
  }

  /** What a request from the page looks like to the route handler. */
  async request(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; resourceType?: string } = {}) {
    const result: { status?: number; headers?: Record<string, string>; body?: string; aborted?: string } = {};
    const route = {
      request: () => ({
        url: () => url,
        method: () => init.method ?? 'GET',
        headers: () => init.headers ?? {},
        postData: () => init.body ?? null,
        resourceType: () => init.resourceType ?? 'fetch',
      }),
      fulfill: async (o: { status?: number; headers?: Record<string, string>; body?: string | Buffer }) => {
        result.status = o.status;
        result.headers = o.headers;
        result.body = o.body === undefined ? '' : o.body.toString();
      },
      abort: async (code?: string) => void (result.aborted = code),
    };
    await this.handler?.(route);
    return result;
  }
}

class FakeBrowser {
  contexts: FakeContext[] = [];
  onContext?: (context: FakeContext) => void;
  permissive = false;
  async newContext(options: Record<string, unknown>) {
    const context = new FakeContext({ ...options, __permissive: this.permissive });
    this.contexts.push(context);
    this.onContext?.(context);
    return context;
  }
}

describe('runScenario with a fake browser', () => {
  let dist: string;
  let out: string;
  beforeAll(() => {
    dist = mkdtempSync(join(tmpdir(), 'ui-smoke-runner-dist-'));
    writeFileSync(join(dist, 'index.html'), '<div id="root"></div>');
  });
  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), 'ui-smoke-runner-out-'));
  });
  afterAll(() => {
    rmSync(dist, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  const deps = (browser: FakeBrowser, over: Partial<RunDeps> = {}): RunDeps => ({
    browser: browser as unknown as Browser,
    files: new AppFiles(dist),
    outDir: out,
    consoleErrors: 'fail',
    timeoutMs: 5000,
    ...over,
  });
  const scenario = (over: Partial<Scenario> = {}): Scenario => ({ name: 'Demo: scenario / one', route: '/', path: '/', auth: 'signed-in', ...over });
  const page = (browser: FakeBrowser) => browser.contexts[0]!.pages[0]!;

  it('slugifies names for files', () => {
    expect(slugify('Diary: entries, entry sheet, edit & delete')).toBe('diary-entries-entry-sheet-edit-delete');
    expect(slugify('Ćevapi!')).toBe('cevapi');
    expect(slugify('***')).toBe('scenario');
  });

  it('creates a context with the phone settings, the time shift and the seeded session, and reports OK', async () => {
    const browser = new FakeBrowser();
    const run = await runScenario(deps(browser), scenario({ expect: ['Dashboard'] }), 7, 'phone');
    expect(run.result).toMatchObject({ status: 'OK', index: 7, viewport: 'phone', issues: [] });
    const ctx = browser.contexts[0]!;
    expect(ctx.options).toMatchObject({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: TIMEZONE, serviceWorkers: 'block', locale: 'en-US' });
    expect(ctx.closed).toBe(true);
    expect(ctx.initScripts).toHaveLength(2);
    // run the init scripts like Chrome would on the app origin: the session lands in localStorage, Date is shifted
    const sandbox = ctx.runInitScripts(APP_ORIGIN);
    const stored = JSON.parse(ctx.storage.get(STORAGE_KEY)!);
    expect(stored.user.email).toBe('demo@caltrack.test');
    expect(stored.expires_at * 1000).toBeGreaterThan(FIXED_NOW_MS + 5 * 365 * 86_400_000);
    expect(Math.abs((vm.runInContext('Date.now()', sandbox) as number) - FIXED_NOW_MS)).toBeLessThan(2000);
    expect(run.result.screenshots).toEqual(['phone/007-demo-scenario-one.png']);
    expect(existsSync(join(out, 'phone', '007-demo-scenario-one.png'))).toBe(true);
    expect(page(browser).currentUrl).toBe(`${APP_ORIGIN}/`);
  });

  it('signed-out scenarios get no session; the desktop viewport is used for desktop', async () => {
    const browser = new FakeBrowser();
    await runScenario(deps(browser), scenario({ auth: 'signed-out', path: '/sign-in' }), 1, 'desktop');
    const ctx = browser.contexts[0]!;
    expect(ctx.initScripts).toHaveLength(1);
    ctx.runInitScripts(APP_ORIGIN);
    expect(ctx.storage.size).toBe(0);
    expect(ctx.options).toMatchObject({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });
  });

  it('fails on a blank screen, error text and uncaught exceptions; warns on suspicious text and console warnings', async () => {
    const browser = new FakeBrowser();
    browser.onContext = (ctx) => {
      const original = ctx.newPage.bind(ctx);
      ctx.newPage = async () => {
        const p = await original();
        p.evaluateOverrides = { textLength: 3, fatalHits: ['Unmatched Route'], suspectHits: ['NaN'] };
        p.onGoto = async () => {
          p.emit('pageerror', new Error('boom: x is not a function\n    at foo'));
          p.emit('console', { type: () => 'warning', text: () => 'be careful', location: () => ({ url: `${APP_ORIGIN}/a.js` }) });
          p.emit('console', { type: () => 'error', text: () => 'React: bad key', location: () => ({ url: `${APP_ORIGIN}/a.js` }) });
          p.emit('console', { type: () => 'log', text: () => 'fine', location: () => ({ url: '' }) });
        };
        return p;
      };
    };
    const run = await runScenario(deps(browser), scenario(), 1, 'phone');
    const kinds = run.result.issues.map((i) => `${i.severity}:${i.kind}`);
    expect(run.result.status).toBe('FAIL');
    expect(kinds).toEqual(expect.arrayContaining(['fail:blank', 'fail:overlay', 'warn:text', 'fail:pageerror', 'warn:console', 'fail:console']));
    expect(run.result.issues.find((i) => i.kind === 'pageerror')?.message).toBe('Uncaught exception: boom: x is not a function');
    expect(run.result.issues.some((i) => i.message.includes('log'))).toBe(false);
  });

  it('does not call a screen blank while it is still loading, but does once it stays empty', async () => {
    const loading = new FakeBrowser();
    loading.onContext = (ctx) => {
      const original = ctx.newPage.bind(ctx);
      ctx.newPage = async () => {
        const p = await original();
        p.textLengthSequence = [4, 4, 4, 120]; // spinner, spinner, spinner, then the content
        return p;
      };
    };
    const ok = await runScenario(deps(loading), scenario(), 1, 'phone');
    expect(ok.result.issues.filter((i) => i.kind === 'blank')).toEqual([]);

    const empty = new FakeBrowser();
    empty.onContext = (ctx) => {
      const original = ctx.newPage.bind(ctx);
      ctx.newPage = async () => {
        const p = await original();
        p.textLengthSequence = [4];
        return p;
      };
    };
    const blank = await runScenario(deps(empty), scenario(), 1, 'phone');
    expect(blank.result.issues.filter((i) => i.kind === 'blank')).toHaveLength(1);
  });

  it('checks input values (scenario.expectInputs and ctx.expectInputValue)', async () => {
    const browser = new FakeBrowser();
    browser.onContext = (ctx) => {
      const original = ctx.newPage.bind(ctx);
      ctx.newPage = async () => {
        const p = await original();
        p.visibleTexts = ['Dashboard and some more text', 'Food name', 'Recipe name'];
        p.inputValues.set('text:Food name', 'Ćevapi');
        return p;
      };
    };
    const run = await runScenario(
      deps(browser),
      scenario({
        expectInputs: [
          { field: 'Food name', value: 'Ćevapi' },
          { field: 'Food name', value: 'Burek' },
        ],
        async after(_p, ctx) {
          expect(await ctx.expectInputValue('Food name', /^Ćev/, { timeout: 50 })).toBe(true);
          expect(await ctx.expectInputValue('Recipe name', 'Piletina', { timeout: 50 })).toBe(false);
          expect(await ctx.expectInputValue('Not on the page', 'x', { timeout: 50 })).toBe(false);
        },
      }),
      1,
      'phone',
    );
    const messages = run.result.issues.map((i) => i.message);
    expect(messages).toContain('Expected input Food name to have the value Burek but it is "Ćevapi"');
    expect(messages).toContain('Expected input Recipe name to have the value Piletina but it is ""');
    expect(messages.some((m) => m.startsWith('Expected input Not on the page to have the value x'))).toBe(true);
    expect(messages.some((m) => m.includes('value Ćevapi'))).toBe(false);
  });

  it('honours allowText / allowConsole and the --console-errors=warn setting', async () => {
    const browser = new FakeBrowser();
    browser.onContext = (ctx) => {
      const original = ctx.newPage.bind(ctx);
      ctx.newPage = async () => {
        const p = await original();
        p.evaluateOverrides = { fatalHits: ['Unmatched Route'], suspectHits: ['Could not load'] };
        p.onGoto = async () => {
          p.emit('console', { type: () => 'error', text: () => 'expected noise', location: () => ({ url: '' }) });
        };
        return p;
      };
    };
    const allowed = await runScenario(deps(browser), scenario({ allowText: [/Unmatched/, /Could not/], allowConsole: [/expected noise/] }), 1, 'phone');
    expect(allowed.result.status).toBe('OK');
    expect(allowed.ignoredConsole).toBe(1);
    const downgraded = await runScenario(deps(new FakeBrowser(), { consoleErrors: 'warn' }), scenario(), 1, 'phone');
    expect(downgraded.result.status).toBe('OK');
  });

  it('plays the app: backend calls through the route handler, mutations, assertions and unhandled endpoints', async () => {
    const browser = new FakeBrowser();
    let token = '';
    browser.onContext = (ctx) => {
      const original = ctx.newPage.bind(ctx);
      ctx.newPage = async () => {
        const p = await original();
        p.onGoto = async () => {
          ctx.runInitScripts(APP_ORIGIN);
          token = JSON.parse(ctx.storage.get(STORAGE_KEY)!).access_token;
          const auth = { apikey: ANON_KEY, authorization: `Bearer ${token}`, 'content-type': 'application/json' };
          const profile = await ctx.request(`${BACKEND_ORIGIN}/rest/v1/profiles?select=*`, { headers: auth });
          expect(profile.status).toBe(200);
          expect(profile.headers?.['access-control-allow-origin']).toBe(APP_ORIGIN);
          // the app inserts a water entry, asks for a table that does not exist, and calls OpenRouter
          await ctx.request(`${BACKEND_ORIGIN}/rest/v1/water_entries`, { method: 'POST', headers: auth, body: JSON.stringify({ user_id: USER_ID, entry_date: '2026-11-10', ml: 500 }) });
          await ctx.request(`${BACKEND_ORIGIN}/rest/v1/ghosts?select=*`, { headers: auth });
          await ctx.request(`${BACKEND_ORIGIN}/rest/v1/foods?select=nope`, { headers: auth });
          await ctx.request(`${BACKEND_ORIGIN}/functions/v1/online-search`, { method: 'POST', headers: auth, body: '{}' });
          await ctx.request('https://openrouter.ai/api/v1/models', { headers: {} });
        };
        return p;
      };
    };
    const seen: string[] = [];
    const run = await runScenario(
      deps(browser),
      scenario({
        expect: ['Dashboard', 'Not on the screen'],
        async after(_p, ctx) {
          await ctx.expectMutation('water_entries', 'insert', (m) => (m.payload as { ml?: number }).ml === 500, 300);
          await ctx.expectMutation('diary_entries', 'insert', undefined, 200);
          await ctx.check('custom check passes', () => undefined);
          await ctx.check('custom check fails', () => {
            throw new Error('nope\nsecond line');
          });
          expect(await ctx.step('failing interaction', async () => Promise.reject(new Error('Timeout 6000ms exceeded.\n  - waiting for locator')))).toBe(false);
          expect(await ctx.step('working interaction', async () => undefined)).toBe(true);
          await ctx.expectUrl(/never-matches/);
          await ctx.snapshot('extra shot');
          seen.push(ctx.backend.mutations.map((m) => m.table).join(','));
        },
      }),
      3,
      'desktop',
    );
    expect(seen).toEqual(['water_entries']);
    const messages = run.result.issues.map((i) => `${i.severity}|${i.kind}|${i.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        'fail|assertion|Expected text not visible: Not on the screen',
        expect.stringContaining('fail|assertion|Expected insert on diary_entries; recorded: insert water_entries'),
        'fail|assertion|custom check fails: nope',
        'warn|step|failing interaction: Timeout 6000ms exceeded.',
        expect.stringContaining('fail|assertion|Expected URL /never-matches/ but the page is at'),
        'fail|backend|unhandled backend call: GET /rest/v1/ghosts (unknown table "ghosts")',
        expect.stringContaining('fail|backend|backend error: GET /rest/v1/foods?select=nope -> 400 42703'),
        'warn|external|blocked external request: GET https://openrouter.ai/api/v1/models (fetch)',
      ]),
    );
    expect(run.unhandled).toEqual([{ scenario: 'Demo: scenario / one', method: 'GET', path: '/rest/v1/ghosts', reason: 'unknown table "ghosts"' }]);
    expect(run.functionCalls).toEqual(['online-search']);
    expect(run.blocked.map((b) => b.url)).toEqual(['https://openrouter.ai/api/v1/models']);
    expect(run.result.mutations).toBe(1);
    expect(run.result.screenshots).toEqual(['desktop/003-demo-scenario-one.png', 'desktop/003-demo-scenario-one-extra-shot.png', 'desktop/003-demo-scenario-one-after.png']);
  });

  it('adds a tall screenshot when the page scrolls, and restores the viewport', async () => {
    const browser = new FakeBrowser();
    browser.onContext = (ctx) => {
      const original = ctx.newPage.bind(ctx);
      ctx.newPage = async () => {
        const p = await original();
        p.evaluateOverrides = { extra: 1500 };
        return p;
      };
    };
    const run = await runScenario(deps(browser), scenario({ name: 'tall page' }), 2, 'phone');
    expect(run.result.screenshots).toEqual(['phone/002-tall-page.png', 'phone/002-tall-page-full.png']);
    expect(page(browser).viewports).toEqual([
      { width: 390, height: 844 + 1500 + 8 },
      { width: 390, height: 844 },
    ]);
  });

  it('turns a hanging scenario into a timeout FAIL and still closes the context', async () => {
    const browser = new FakeBrowser();
    browser.onContext = (ctx) => {
      const original = ctx.newPage.bind(ctx);
      ctx.newPage = async () => {
        const p = await original();
        p.onGoto = () => new Promise(() => undefined); // never finishes
        return p;
      };
    };
    const run = await runScenario(deps(browser, { timeoutMs: 150 }), scenario({ name: 'hangs' }), 4, 'phone');
    expect(run.result.status).toBe('FAIL');
    expect(run.result.issues[0]).toMatchObject({ kind: 'timeout' });
    expect(browser.contexts[0]!.closed).toBe(true);
    expect(readdirSync(join(out, 'phone'))).toContain('004-hangs-FAILED.png');
  });

  it('turns a crashing setup into a harness FAIL instead of throwing', async () => {
    const browser = new FakeBrowser();
    const run = await runScenario(
      deps(browser),
      scenario({
        name: 'bad setup',
        async setup() {
          throw new Error('setup exploded');
        },
      }),
      5,
      'phone',
    );
    expect(run.result.status).toBe('FAIL');
    expect(run.result.issues[0]).toMatchObject({ severity: 'fail', kind: 'harness', message: 'Scenario crashed: setup exploded' });
    expect(browser.contexts[0]!.closed).toBe(true);
  });

  it('every scenario script runs to the end against a permissive fake page (no crashes in the scenario code)', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      for (const [i, s] of SCENARIOS.entries()) {
        const browser = new FakeBrowser();
        browser.permissive = true;
        const run = await runScenario(deps(browser, { timeoutMs: 2_000_000_000 }), s, i + 1, 'phone');
        const crashed = run.result.issues.filter((issue) => issue.kind === 'harness' || issue.kind === 'timeout');
        expect(crashed, `${s.name}: ${resolvePath(s, { ids: {} } as never)}`).toEqual([]);
        expect(browser.contexts[0]!.closed, s.name).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives a browser that cannot create a context', async () => {
    const broken = {
      newContext: async () => {
        throw new Error('Browser closed');
      },
    } as unknown as Browser;
    const run = await runScenario({ browser: broken, files: new AppFiles(dist), outDir: out, consoleErrors: 'fail', timeoutMs: 1000 }, scenario(), 1, 'phone');
    expect(run.result.status).toBe('FAIL');
    expect(run.result.issues[0]?.message).toContain('Browser closed');
    mkdirSync(join(out, 'x'), { recursive: true });
  });
});
