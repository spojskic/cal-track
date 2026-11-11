/** Pure parts of the harness: static file serving, Playwright routing (with fakes), report, CLI, Chrome lookup. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Route } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { xpathLiteral } from './actions';
import { backendIssues, dedupeIssues } from './analysis';
import { AppFiles, contentTypeFor } from './app-files';
import { isValidExport } from './build';
import { MAC_CHROME, resolveChrome } from './chrome';
import { DEFAULT_DIST, DEFAULT_OUT, USAGE, parseArgs } from './cli';
import { ANON_KEY, APP_ORIGIN, BACKEND_ORIGIN, STORAGE_KEY } from './constants';
import { IDS, buildFixtures } from './fixtures';
import { classifyConsole } from './known-noise';
import { createMockBackend } from './mock-backend';
import {
  exitCodeOf,
  renderMarkdown,
  renderSummary,
  statusOf,
  summarizeUnhandled,
  totalsOf,
  type Report,
  type ScenarioResult,
} from './report';
import { createRouteHandler, type RequestLog } from './routing';
import { compareRoutes, routePatternOf, scanRoutes } from './routes-scan';
import { SCENARIOS } from './scenarios';
import { DEFAULT_VIEWPORTS, VIEWPORTS, resolvePath } from './types';

const here = dirname(fileURLToPath(import.meta.url));

describe('constants', () => {
  it('derive the supabase storage key from the mock URL exactly like supabase-js', () => {
    expect(STORAGE_KEY).toBe('sb-mock-auth-token');
    expect(new URL(BACKEND_ORIGIN).hostname.split('.')[0]).toBe('mock');
  });
});

describe('AppFiles (static serving with SPA fallback)', () => {
  let dist: string;
  beforeAll(() => {
    dist = mkdtempSync(join(tmpdir(), 'ui-smoke-dist-'));
    mkdirSync(join(dist, '_expo', 'static', 'js', 'web'), { recursive: true });
    mkdirSync(join(dist, 'assets', 'node_modules', 'pkg', 'fonts'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(join(dist, '_expo', 'static', 'js', 'web', 'entry-abc.js'), 'console.log(1)');
    writeFileSync(join(dist, 'assets', 'node_modules', 'pkg', 'fonts', 'Icons.ttf'), 'font');
    writeFileSync(join(dist, 'favicon.ico'), 'ico');
    writeFileSync(join(dist, 'secret.txt'), 'top secret');
  });
  afterAll(() => rmSync(dist, { recursive: true, force: true }));

  it('serves files with the right content types', () => {
    const files = new AppFiles(dist);
    const js = files.serve('/_expo/static/js/web/entry-abc.js');
    expect(js?.contentType).toBe('text/javascript; charset=utf-8');
    expect(js?.body.toString()).toBe('console.log(1)');
    expect(js?.fallback).toBe(false);
    expect(files.serve('/assets/node_modules/pkg/fonts/Icons.ttf')?.contentType).toBe('font/ttf');
    expect(files.serve('/favicon.ico')?.contentType).toBe('image/x-icon');
    expect(files.serve('/')?.contentType).toBe('text/html; charset=utf-8');
    expect(files.serve('/index.html')?.fallback).toBe(false);
  });

  it('knows the content types a web export needs', () => {
    expect(contentTypeFor('a/b.wasm')).toBe('application/wasm');
    expect(contentTypeFor('x.PNG')).toBe('image/png');
    expect(contentTypeFor('x.json')).toBe('application/json; charset=utf-8');
    expect(contentTypeFor('x.woff2')).toBe('font/woff2');
    expect(contentTypeFor('x.unknown')).toBe('application/octet-stream');
  });

  it('falls back to index.html for client side routes but 404s missing assets', () => {
    const files = new AppFiles(dist);
    for (const path of ['/diary', '/food/70d7298e-57b3-4137-ae26-eed81ab766fd', '/food/%5Bid%5D', '/settings/targets/', '/coach/history']) {
      const res = files.serve(path);
      expect(res?.fallback, path).toBe(true);
      expect(res?.status).toBe(200);
      expect(res?.contentType).toContain('text/html');
    }
    expect(files.serve('/_expo/static/js/web/missing.js')).toBeNull();
    expect(files.serve('/assets/missing.png')).toBeNull();
    // a dotted segment is a route when the browser asks for a page
    expect(files.serve('/food/1.5', 'text/html,application/xhtml+xml')?.fallback).toBe(true);
    expect(files.serve('/food/1.5', '*/*')).toBeNull();
  });

  it('never leaves the dist directory', () => {
    const files = new AppFiles(join(dist, 'assets'));
    expect(files.serve('/../secret.txt')).toBeNull();
    expect(files.serve('/%2e%2e/secret.txt')).toBeNull();
    expect(files.serve('/..%2fsecret.txt')).toBeNull();
    expect(files.serve('/%00')).toBeNull();
    expect(files.serve('/%E0%A4%A')).toBeNull();
  });

  it('isValidExport needs index.html and a JS bundle', () => {
    expect(isValidExport(dist)).toEqual({ ok: true });
    expect(isValidExport(join(dist, 'assets')).ok).toBe(false);
  });
});

describe('route handler (fake Playwright route)', () => {
  interface Fake {
    route: Route;
    result: { fulfilled?: { status?: number; headers?: Record<string, string>; body?: string | Buffer; contentType?: string }; aborted?: string };
  }
  function fake(url: string, init: { method?: string; headers?: Record<string, string>; postData?: string | null; resourceType?: string } = {}): Fake {
    const result: Fake['result'] = {};
    const route = {
      request: () => ({
        url: () => url,
        method: () => init.method ?? 'GET',
        headers: () => init.headers ?? {},
        postData: () => init.postData ?? null,
        resourceType: () => init.resourceType ?? 'fetch',
      }),
      fulfill: async (o: Fake['result']['fulfilled']) => void (result.fulfilled = o),
      abort: async (code?: string) => void (result.aborted = code ?? 'failed'),
    } as unknown as Route;
    return { route, result };
  }

  let dist: string;
  beforeAll(() => {
    dist = mkdtempSync(join(tmpdir(), 'ui-smoke-route-'));
    writeFileSync(join(dist, 'index.html'), '<div id="root"></div>');
  });
  afterAll(() => rmSync(dist, { recursive: true, force: true }));

  const setup = () => {
    const log: RequestLog = { blocked: [], app404: [] };
    const backend = createMockBackend(buildFixtures().seed);
    return { log, backend, handle: createRouteHandler({ files: new AppFiles(dist), getBackend: () => backend, log }) };
  };

  it('serves the app from disk', async () => {
    const { handle, log } = setup();
    const page = fake(`${APP_ORIGIN}/diary`, { headers: { accept: 'text/html' } });
    await handle(page.route);
    expect(page.result.fulfilled?.status).toBe(200);
    expect(String(page.result.fulfilled?.body)).toContain('id="root"');
    const missing = fake(`${APP_ORIGIN}/_expo/static/js/web/nope.js`);
    await handle(missing.route);
    expect(missing.result.fulfilled?.status).toBe(404);
    expect(log.app404).toEqual(['GET /_expo/static/js/web/nope.js']);
  });

  it('answers backend calls from the in-process mock, with CORS', async () => {
    const { handle, backend } = setup();
    const call = fake(`${BACKEND_ORIGIN}/rest/v1/rpc/search_foods`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, authorization: `Bearer ${ANON_KEY}`, 'content-type': 'application/json' },
      postData: JSON.stringify({ q: 'cevapi' }),
    });
    await handle(call.route);
    // anon token: PostgREST would refuse - the mock does too (and the app always sends the user token)
    expect(call.result.fulfilled?.status).toBe(401);
    expect(call.result.fulfilled?.headers?.['access-control-allow-origin']).toBe(APP_ORIGIN);
    expect(backend.calls).toHaveLength(1);
  });

  it('aborts and logs everything else', async () => {
    const { handle, log } = setup();
    const external = fake('https://openrouter.ai/api/v1/key', { resourceType: 'fetch' });
    await handle(external.route);
    expect(external.result.aborted).toBe('blockedbyclient');
    expect(log.blocked).toEqual([{ url: 'https://openrouter.ai/api/v1/key', method: 'GET', resourceType: 'fetch' }]);
    const garbage = fake('not a url');
    await handle(garbage.route);
    expect(garbage.result.aborted).toBe('failed');
  });
});

describe('routes-scan', () => {
  it('maps expo-router files to route patterns', () => {
    expect(routePatternOf('(app)/index.tsx')).toBe('/');
    expect(routePatternOf('(app)/diary.tsx')).toBe('/diary');
    expect(routePatternOf('(auth)/sign-in.tsx')).toBe('/sign-in');
    expect(routePatternOf('food/[id].tsx')).toBe('/food/[id]');
    expect(routePatternOf('food/edit/[id].tsx')).toBe('/food/edit/[id]');
    expect(routePatternOf('settings/index.tsx')).toBe('/settings');
    expect(routePatternOf('coach/[...rest].tsx')).toBe('/coach/[...rest]');
    expect(routePatternOf('index.web.tsx')).toBe('/');
    for (const ignored of ['_layout.tsx', '(app)/_layout.tsx', '+not-found.tsx', '+html.tsx', 'x.test.tsx', 'readme.md', 'data.json']) {
      expect(routePatternOf(ignored), ignored).toBeNull();
    }
  });

  it('scans a directory tree and compares it with the scenario routes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ui-smoke-app-'));
    try {
      for (const f of ['_layout.tsx', '(app)/_layout.tsx', '(app)/index.tsx', '(app)/diary.tsx', 'food/[id].tsx', 'food/new.tsx']) {
        mkdirSync(dirname(join(dir, f)), { recursive: true });
        writeFileSync(join(dir, f), '');
      }
      const routes = scanRoutes(dir);
      expect(routes.map((r) => r.pattern)).toEqual(['/', '/diary', '/food/[id]', '/food/new']);
      const coverage = compareRoutes(routes, ['/', '/diary', '/food/[id]', '/old/route']);
      expect(coverage.uncovered.map((r) => r.pattern)).toEqual(['/food/new']);
      expect(coverage.unknown).toEqual(['/old/route']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('every route file of apps/app/src/app has a scenario (add one to scenarios.ts when this fails)', () => {
    const coverage = compareRoutes(scanRoutes(join(here, '..', '..', '..', 'apps', 'app', 'src', 'app')), SCENARIOS.map((s) => s.route));
    expect(coverage.uncovered.map((r) => `${r.pattern} (${r.file})`)).toEqual([]);
    expect(coverage.unknown).toEqual([]);
  });
});

describe('scenarios', () => {
  const fixtures = buildFixtures();
  it('have unique names and well formed paths', () => {
    const names = SCENARIOS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of SCENARIOS) {
      const path = resolvePath(s, fixtures);
      expect(path.startsWith('/'), s.name).toBe(true);
      expect(s.route.startsWith('/'), s.name).toBe(true);
      expect(path).not.toContain('undefined');
      for (const vp of s.viewports ?? []) expect(VIEWPORTS[vp], s.name).toBeDefined();
    }
  });

  it('only reference fixture ids that exist', () => {
    const foodIds = new Set((fixtures.seed.tables.foods ?? []).map((f) => f.id));
    for (const s of SCENARIOS) {
      const match = /\/food(?:\/edit)?\/([0-9a-f-]{36})$/.exec(resolvePath(s, fixtures));
      if (match && s.name !== 'food detail: unknown id shows "not found"') expect(foodIds.has(match[1]), s.name).toBe(true);
    }
    expect(foodIds.has(IDS.missing)).toBe(false);
  });

  it('cover both auth modes and every fixture variant', () => {
    expect(new Set(SCENARIOS.map((s) => s.auth))).toEqual(new Set(['signed-in', 'signed-out']));
    expect(new Set(SCENARIOS.map((s) => s.fixtures ?? 'default'))).toEqual(new Set(['default', 'imperial', 'not-onboarded', 'empty-diary', 'fresh-account', 'admin']));
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(55);
  });

  it('define the viewports of the brief: phone 390x844 @2x (touch) and desktop 1280x800; dark is opt-in', () => {
    expect(VIEWPORTS.phone).toMatchObject({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    expect(VIEWPORTS.desktop).toMatchObject({ width: 1280, height: 800, isMobile: false });
    expect(DEFAULT_VIEWPORTS).toEqual(['phone', 'desktop']);
    expect(VIEWPORTS['phone-dark'].colorScheme).toBe('dark');
  });
});

describe('report', () => {
  const result = (over: Partial<ScenarioResult>): ScenarioResult => ({
    index: 1,
    name: 'dashboard',
    route: '/',
    path: '/',
    viewport: 'phone',
    status: 'OK',
    durationMs: 1000,
    issues: [],
    screenshots: [],
    backendCalls: 5,
    mutations: 0,
    textLength: 200,
    ...over,
  });
  const report = (results: ScenarioResult[], over: Partial<Report> = {}): Report => ({
    startedAt: '2026-11-10T11:00:00.000Z',
    finishedAt: '2026-11-10T11:05:00.000Z',
    outDir: '/tmp/out',
    distDir: '/tmp/dist',
    chrome: '/chrome',
    viewports: ['phone', 'desktop'],
    results,
    unhandled: [],
    warnings: [],
    blockedExternal: [],
    edgeFunctions: [],
    ignoredConsole: 0,
    ...over,
  });

  it('derives the status from the worst issue', () => {
    expect(statusOf([])).toBe('OK');
    expect(statusOf([{ severity: 'warn', kind: 'console', message: 'x' }])).toBe('WARN');
    expect(statusOf([{ severity: 'warn', kind: 'console', message: 'x' }, { severity: 'fail', kind: 'blank', message: 'y' }])).toBe('FAIL');
  });

  it('counts totals and exits 1 on any FAIL', () => {
    const results = [result({}), result({ status: 'WARN' }), result({ status: 'FAIL' })];
    expect(totalsOf(results)).toEqual({ total: 3, ok: 1, warn: 1, fail: 1 });
    expect(exitCodeOf({ results })).toBe(1);
    expect(exitCodeOf({ results: results.slice(0, 2) })).toBe(0);
  });

  it('merges unhandled endpoints and collapses ids', () => {
    const u = summarizeUnhandled([
      { scenario: 'a', method: 'GET', path: '/rest/v1/x?id=eq.70d7298e-57b3-4137-ae26-eed81ab766fd', reason: 'unknown table "x"' },
      { scenario: 'b', method: 'GET', path: '/rest/v1/x?id=eq.afc0600d-ae86-4ce9-af15-ca3af2e7b946', reason: 'unknown table "x"' },
      { scenario: 'b', method: 'POST', path: '/auth/v1/signup', reason: 'auth endpoint not emulated' },
    ]);
    expect(u).toHaveLength(2);
    expect(u[0]).toMatchObject({ endpoint: 'GET /rest/v1/x?id=eq.<uuid>', count: 2, scenarios: ['a', 'b'] });
  });

  it('renders a markdown table per scenario and viewport, problems and unhandled endpoints', () => {
    const md = renderMarkdown(
      report(
        [
          result({}),
          result({ viewport: 'desktop' }),
          result({ index: 2, name: 'diary | entries', status: 'FAIL', issues: [{ severity: 'fail', kind: 'pageerror', message: 'Uncaught exception: boom | bang' }], screenshots: ['phone/002-diary.png'] }),
          result({ index: 2, name: 'diary | entries', viewport: 'desktop', status: 'WARN', issues: [{ severity: 'warn', kind: 'console', message: 'console.warning: hmm' }] }),
        ],
        { unhandled: [{ endpoint: 'GET /rest/v1/ghosts', reason: 'unknown table "ghosts"', count: 2, scenarios: ['diary | entries'] }], warnings: ['UNCOVERED ROUTE /coach'], ignoredConsole: 4 },
      ),
    );
    expect(md).toContain('| Scenario | phone | desktop |');
    expect(md).toContain('| 001 dashboard | OK | OK |');
    expect(md).toContain('| 002 diary \\| entries | FAIL (1) | WARN (1) |');
    expect(md).toContain('Uncaught exception: boom \\| bang');
    expect(md).toContain('## Unhandled backend endpoints');
    expect(md).toContain('GET /rest/v1/ghosts');
    expect(md).toContain('UNCOVERED ROUTE /coach');
    expect(md).toContain('**FAIL**');
    expect(md).toContain('phone/002-diary.png');
    expect(renderMarkdown(report([result({})]))).toContain('None: every request was answered by the mock.');
  });

  it('prints a short summary', () => {
    const text = renderSummary(report([result({ status: 'FAIL', issues: [{ severity: 'fail', kind: 'blank', message: 'Blank screen: 0 characters' }] }), result({})], { warnings: ['w1'] }));
    expect(text).toContain('1 OK, 0 WARN, 1 FAIL');
    expect(text).toContain('Blank screen');
    expect(text).toContain('warning: w1');
    expect(text).toContain('/tmp/out/report.md');
  });
});

describe('backend log analysis', () => {
  const call = (over: Record<string, unknown>) => ({ seq: 1, method: 'GET', path: '/rest/v1/foods', query: '?select=x', status: 200, kind: 'rest' as const, target: 'foods', ...over });

  it('turns schema mistakes into FAILs and handled flows into WARNs', () => {
    const issues = backendIssues({
      calls: [
        call({ status: 400, error: '42703: column foods.nope does not exist' }),
        call({ status: 406, error: 'PGRST116: JSON object requested, multiple (or no) rows returned' }),
        call({ status: 409, error: '23505: duplicate key' }),
        call({ method: 'POST', path: '/auth/v1/token', kind: 'auth', target: '/token', status: 400, error: 'invalid_credentials: Invalid login credentials' }),
        call({ method: 'POST', path: '/functions/v1/online-search', kind: 'function', status: 404 }),
        call({ status: 200 }),
      ],
      unhandled: [{ seq: 9, method: 'GET', path: '/rest/v1/ghosts', reason: 'unknown table "ghosts"' }],
      warnings: ['GET /rest/v1/foods: Mock backend does not support x'],
    });
    expect(issues.map((i) => i.severity)).toEqual(['fail', 'warn', 'warn', 'warn', 'fail', 'warn']);
    expect(issues[0]?.message).toContain('42703');
    expect(issues[1]?.message).toContain('PGRST116');
    expect(issues[2]?.message).toContain('23505');
    expect(issues[3]?.message).toContain('/auth/v1/token');
    expect(issues[4]?.message).toBe('unhandled backend call: GET /rest/v1/ghosts (unknown table "ghosts")');
    expect(issues[5]?.message).toContain('Mock backend does not support x');
    expect(issues.some((i) => i.message.includes('online-search'))).toBe(false);
  });

  it('honours the allow list and deduplicates', () => {
    const calls = [call({ status: 400, error: '22P02: invalid input' }), call({ status: 400, error: '22P02: invalid input' })];
    expect(backendIssues({ calls, unhandled: [], warnings: [] }, ['22P02'])).toEqual([]);
    expect(backendIssues({ calls, unhandled: [], warnings: [] }, [/nothing/])[0]?.message).toMatch(/\(x2\)$/);
    expect(dedupeIssues([{ severity: 'warn', kind: 'request', message: 'a' }, { severity: 'warn', kind: 'request', message: 'a' }, { severity: 'fail', kind: 'request', message: 'a' }])).toHaveLength(2);
  });
});

describe('console classification', () => {
  it('ignores known noise, fails errors, warns warnings', () => {
    expect(classifyConsole({ type: 'error', text: 'Failed to load resource: the server responded with a status of 404 ()', url: `${BACKEND_ORIGIN}/functions/v1/x` }).kind).toBe('ignore');
    expect(classifyConsole({ type: 'error', text: 'Failed to load resource: the server responded with a status of 404 ()', url: `${APP_ORIGIN}/x.js` }).kind).toBe('fail');
    expect(classifyConsole({ type: 'error', text: 'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT', url: 'https://openrouter.ai/x' }).kind).toBe('ignore');
    expect(classifyConsole({ type: 'error', text: 'Warning: Each child in a list should have a unique "key" prop.' }).kind).toBe('fail');
    expect(classifyConsole({ type: 'error', text: 'boom' }, { errorSeverity: 'warn' }).kind).toBe('warn');
    expect(classifyConsole({ type: 'warning', text: 'careful' }).kind).toBe('warn');
    expect(classifyConsole({ type: 'log', text: 'hello' }).kind).toBe('ignore');
    expect(classifyConsole({ type: 'error', text: 'custom thing' }, { extra: [/custom/] }).kind).toBe('ignore');
  });
});

describe('cli', () => {
  it('has defaults', () => {
    const { options, errors } = parseArgs([]);
    expect(errors).toEqual([]);
    expect(options).toMatchObject({ skipBuild: false, out: DEFAULT_OUT, dist: DEFAULT_DIST, headed: false, list: false, consoleErrors: 'fail', workers: 2, timeoutMs: 120_000 });
    expect(DEFAULT_OUT).toBe('/tmp/cal-ui-smoke');
    expect(options.theme).toBeUndefined(); // nothing seeded: the app starts with its own default theme
    expect(options.corners).toBeUndefined();
  });

  it('--theme takes a known palette id (both forms) and rejects anything else', () => {
    expect(parseArgs(['--theme=dracula']).options.theme).toBe('dracula');
    expect(parseArgs(['--', '--theme', 'kanagawa-lotus', '--skip-build']).options).toMatchObject({ theme: 'kanagawa-lotus', skipBuild: true });
    const bad = parseArgs(['--theme=solarized-hot']);
    expect(bad.options.theme).toBeUndefined();
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors[0]).toContain('unknown palette "solarized-hot"');
    expect(bad.errors[0]).toContain('kanagawa-wave'); // lists the known ids
    expect(parseArgs(['--theme']).errors).toEqual(['--theme needs a value']);
    expect(USAGE).toContain('--theme=<paletteId>');
  });

  it('--corners takes rounded or boxy (both forms), combines with --theme, and rejects anything else', () => {
    expect(parseArgs(['--corners=boxy']).options.corners).toBe('boxy');
    expect(parseArgs(['--', '--corners', 'rounded', '--theme=paper']).options).toMatchObject({ corners: 'rounded', theme: 'paper' });
    const bad = parseArgs(['--corners=square']);
    expect(bad.options.corners).toBeUndefined();
    expect(bad.errors).toEqual(['--corners: unknown corner style "square" (known: rounded, boxy)']);
    expect(parseArgs(['--corners']).errors).toEqual(['--corners needs a value']);
    expect(USAGE).toContain('--corners=<style>');
  });

  it('parses flags in both --k=v and --k v form and ignores the pnpm "--" separator', () => {
    const { options, errors } = parseArgs(['--', '--skip-build', '--only=diary', '--out', '/tmp/x', '--chrome=/usr/bin/chrome', '--viewports=phone', '--console-errors=warn', '--timeout=30', '--workers=3', '--headed', '--list']);
    expect(errors).toEqual([]);
    expect(options).toMatchObject({ skipBuild: true, only: 'diary', out: '/tmp/x', chrome: '/usr/bin/chrome', viewports: ['phone'], consoleErrors: 'warn', timeoutMs: 30_000, workers: 3, headed: true, list: true });
  });

  it('reports bad input', () => {
    const { errors } = parseArgs(['--nope', '--console-errors=maybe', '--workers=0', '--timeout=abc', 'stray', '--out']);
    expect(errors).toEqual([
      'unknown option --nope',
      '--console-errors must be "warn" or "fail"',
      '--workers must be an integer between 1 and 8',
      '--timeout must be a number of seconds',
      'unexpected argument "stray"',
      '--out needs a value',
    ]);
  });
});

describe('chrome lookup', () => {
  it('prefers the flag, then CHROME_PATH, the macOS app and the Playwright cache', () => {
    const exists = (set: string[]) => (p: string) => set.includes(p);
    expect(resolveChrome({ flag: '/a', env: { CHROME_PATH: '/b' }, exists: exists(['/a', '/b', MAC_CHROME]) })).toMatchObject({ ok: true, path: '/a', source: 'flag' });
    expect(resolveChrome({ env: { CHROME_PATH: '/b' }, exists: exists(['/b', MAC_CHROME]) })).toMatchObject({ ok: true, path: '/b', source: 'env' });
    expect(resolveChrome({ env: { CHROME_PATH: '/missing' }, exists: exists([MAC_CHROME]) })).toMatchObject({ ok: true, path: MAC_CHROME, source: 'default' });
    expect(resolveChrome({ env: {}, exists: exists(['/pw']), playwrightPath: () => '/pw' })).toMatchObject({ ok: true, path: '/pw', source: 'playwright' });
    const none = resolveChrome({ env: {}, exists: () => false, playwrightPath: () => '/pw' });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.tried).toEqual([MAC_CHROME, 'playwright cache: /pw']);
  });

  it('does not silently fall back when --chrome points nowhere', () => {
    const res = resolveChrome({ flag: '/nope', exists: (p) => p === MAC_CHROME });
    expect(res.ok).toBe(false);
  });
});

describe('xpathLiteral', () => {
  it('quotes any text', () => {
    expect(xpathLiteral('height (cm)')).toBe("'height (cm)'");
    expect(xpathLiteral("don't")).toBe('"don\'t"');
    expect(xpathLiteral(`a'b"c`)).toBe(`concat('a', "'", 'b"c')`);
  });
});
