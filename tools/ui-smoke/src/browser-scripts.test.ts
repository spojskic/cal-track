/** The browser-side scripts are plain JS strings: execute them in a node:vm sandbox to prove they work. */
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  FATAL_TEXT_PATTERNS,
  SUSPECT_TEXT_PATTERNS,
  dateShiftScript,
  inspectPageScript,
  scrollMainScript,
  scrollMetricsScript,
  seedSessionScript,
} from './browser-scripts';
import { FIXED_NOW_MS } from './constants';

function sandbox(extra: Record<string, unknown> = {}): vm.Context {
  const g: Record<string, unknown> = { ...extra };
  g.window = g;
  return vm.createContext(g);
}

const run = <T = unknown>(code: string, ctx: vm.Context): T => vm.runInContext(code, ctx) as T;

function storage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe('every script is syntactically valid JavaScript', () => {
  it('compiles', () => {
    for (const code of [dateShiftScript(1), seedSessionScript({ origin: 'https://a.test', storageKey: 'k', session: {} }), inspectPageScript(), scrollMetricsScript(), scrollMainScript(100)]) {
      expect(() => new vm.Script(code)).not.toThrow();
    }
  });

  it('has no TypeScript artefacts (esbuild __name helper, type annotations)', () => {
    for (const code of [dateShiftScript(1), seedSessionScript({ origin: 'o', storageKey: 'k', session: {} }), inspectPageScript(), scrollMetricsScript(), scrollMainScript(1)]) {
      expect(code).not.toMatch(/__name|: string|: number|as unknown/);
    }
  });
});

describe('dateShiftScript', () => {
  it('starts "now" at the target and keeps time flowing', async () => {
    const ctx = sandbox();
    run(dateShiftScript(FIXED_NOW_MS), ctx);
    const first = run<number>('Date.now()', ctx);
    expect(Math.abs(first - FIXED_NOW_MS)).toBeLessThan(2000);
    await new Promise((r) => setTimeout(r, 30));
    expect(run<number>('Date.now()', ctx)).toBeGreaterThan(first);
    expect(run<string>('new Date().toISOString().slice(0, 10)', ctx)).toBe('2026-11-10');
    expect(run<string>('new Date().toISOString().slice(0, 13)', ctx)).toBe('2026-11-10T11');
  });

  it('behaves like Date for everything else', () => {
    const ctx = sandbox();
    run(dateShiftScript(FIXED_NOW_MS), ctx);
    expect(run<number>('new Date(2020, 0, 15).getFullYear()', ctx)).toBe(2020);
    expect(run<number>('new Date(2020, 0, 15, 10, 20, 30, 40).getMilliseconds()', ctx)).toBe(40);
    expect(run<string>("new Date('2026-01-01T00:00:00Z').toISOString()", ctx)).toBe('2026-01-01T00:00:00.000Z');
    expect(run<number>('new Date(0).getTime()', ctx)).toBe(0);
    expect(run<number>("Date.parse('2026-11-10T12:00:00+01:00')", ctx)).toBe(FIXED_NOW_MS);
    expect(run<number>('Date.UTC(2026, 10, 10, 11)', ctx)).toBe(FIXED_NOW_MS);
    expect(run<string>('typeof Date()', ctx)).toBe('string');
    expect(run<boolean>('new Date() instanceof Date', ctx)).toBe(true);
    expect(run<boolean>('Object.prototype.toString.call(new Date()) === "[object Date]"', ctx)).toBe(true);
  });

  it('is idempotent (a second run does not shift twice)', () => {
    const ctx = sandbox();
    run(dateShiftScript(FIXED_NOW_MS), ctx);
    run(dateShiftScript(FIXED_NOW_MS + 86_400_000), ctx);
    expect(Math.abs(run<number>('Date.now()', ctx) - FIXED_NOW_MS)).toBeLessThan(2000);
  });
});

describe('seedSessionScript', () => {
  const session = { access_token: 'a.b.c', refresh_token: 'r', expires_at: 4_000_000_000, user: { id: 'u' } };

  it('stores the session once per tab, on the app origin only', () => {
    const local = storage();
    const sess = storage();
    const ctx = sandbox({ location: { origin: 'https://app.test' }, localStorage: local, sessionStorage: sess });
    const code = seedSessionScript({ origin: 'https://app.test', storageKey: 'sb-mock-auth-token', session });
    run(code, ctx);
    expect(JSON.parse(local.data.get('sb-mock-auth-token') as string)).toEqual(session);
    // the app signed out and reloaded: the session must not be re-seeded
    local.data.delete('sb-mock-auth-token');
    run(code, ctx);
    expect(local.data.size).toBe(0);
  });

  it('does nothing on other origins (about:blank)', () => {
    const local = storage();
    const ctx = sandbox({ location: { origin: 'null' }, localStorage: local, sessionStorage: storage() });
    run(seedSessionScript({ origin: 'https://app.test', storageKey: 'k', session }), ctx);
    expect(local.data.size).toBe(0);
  });

  it('never throws when storage is unavailable', () => {
    const ctx = sandbox({
      location: { origin: 'https://app.test' },
      localStorage: { setItem() { throw new Error('denied'); }, getItem: () => null },
      sessionStorage: storage(),
    });
    expect(() => run(seedSessionScript({ origin: 'https://app.test', storageKey: 'k', session }), ctx)).not.toThrow();
  });
});

describe('inspectPageScript', () => {
  const doc = (text: string, root = true) => ({
    title: 'Cal Track',
    body: { innerText: text },
    getElementById: () => (root ? { children: { length: 1 } } : null),
    querySelectorAll: () => ({ length: 3 }),
  });
  const inspect = (text: string) =>
    run<{ textLength: number; fatalHits: string[]; suspectHits: string[]; sample: string; hasRoot: boolean }>(
      inspectPageScript(),
      sandbox({ document: doc(text), location: { href: 'https://app.test/diary' } }),
    );

  it('measures visible text and normalises whitespace', () => {
    const info = inspect('  Dashboard \n\n Today   1,850 kcal ');
    expect(info.textLength).toBe('Dashboard Today 1,850 kcal'.length);
    expect(info.sample).toBe('Dashboard Today 1,850 kcal');
    expect(info.fatalHits).toEqual([]);
    expect(info.suspectHits).toEqual([]);
    expect(info.hasRoot).toBe(true);
  });

  it('finds fatal and suspicious texts', () => {
    expect(inspect('Unmatched Route Page could not be found.').fatalHits).toEqual(['Unmatched Route', 'Page could not be found']);
    expect(inspect("This screen doesn't exist.").fatalHits).toEqual(["This screen doesn't exist"]);
    expect(inspect('Something went wrong. Energy NaN kcal and undefined g').suspectHits).toEqual(['Something went wrong', 'NaN', 'undefined']);
    expect(inspect('Value [object Object]').suspectHits).toEqual(['[object Object]']);
    expect(inspect('Banana, raw 89 kcal Nanny').suspectHits).toEqual([]);
  });

  it('every pattern is a valid regular expression', () => {
    for (const p of [...FATAL_TEXT_PATTERNS, ...SUSPECT_TEXT_PATTERNS]) expect(() => new RegExp(p)).not.toThrow();
  });

  it('survives an empty document', () => {
    const info = run<{ textLength: number }>(inspectPageScript(), sandbox({ document: { title: '', body: null, getElementById: () => null, querySelectorAll: () => ({ length: 0 }) }, location: { href: 'x' } }));
    expect(info.textLength).toBe(0);
  });
});

describe('scroll scripts', () => {
  const el = (overflowY: string, scrollHeight: number, clientHeight: number) => ({ overflowY, scrollHeight, clientHeight, scrollTop: 0 });
  const make = (elements: ReturnType<typeof el>[], docHeight = 800) => {
    const scrolled: number[] = [];
    return {
      scrolled,
      ctx: sandbox({
        document: { querySelectorAll: () => elements, documentElement: { scrollHeight: docHeight } },
        getComputedStyle: (e: { overflowY: string }) => ({ overflowY: e.overflowY }),
        innerWidth: 390,
        innerHeight: 800,
        scrollBy: (_x: number, y: number) => scrolled.push(y),
        scrollY: 0,
      }),
    };
  };

  it('reports the largest hidden scroll height of any scroll container', () => {
    const { ctx } = make([el('visible', 5000, 100), el('auto', 2100, 700), el('scroll', 1500, 800)]);
    expect(run(scrollMetricsScript(), ctx)).toEqual({ innerWidth: 390, innerHeight: 800, extra: 1400 });
  });

  it('reports 0 for a page that fits', () => {
    const { ctx } = make([el('auto', 700, 700)]);
    expect((run(scrollMetricsScript(), ctx) as { extra: number }).extra).toBe(0);
  });

  it('scrolls the biggest container, or the window as a fallback', () => {
    const big = el('auto', 3000, 800);
    const { ctx } = make([el('auto', 900, 800), big]);
    expect(run<number>(scrollMainScript(500), ctx)).toBe(500);
    expect(big.scrollTop).toBe(500);
    const none = make([el('visible', 3000, 800)]);
    run(scrollMainScript(300), none.ctx);
    expect(none.scrolled).toEqual([300]);
  });
});
