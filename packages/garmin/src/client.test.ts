import { describe, expect, it } from 'vitest';
import { createGarminClient, looksLikeGarminApiKey, type FetchLike, type GarminLogEvent } from './client';
import { GARMIN_BASE_URL, GARMIN_BASE_URL_CN, TOKEN_PATH } from './constants';
import { GarminError } from './errors';
import { createClock, createFakeFetch, json, KEY, makeJwt, reply, type FakeCall, type FakeReply } from './test-utils';

const BASE = GARMIN_BASE_URL;
const TOKEN_URL = BASE + TOKEN_PATH;
const isToken = (c: FakeCall): boolean => c.url === TOKEN_URL;

/** exp relative to the fake clock, in seconds. */
const jwtFor = (clockMs: number, lifetimeSec: number, extra: Record<string, unknown> = {}): string =>
  makeJwt({ exp: Math.floor(clockMs / 1000) + lifetimeSec, ...extra });

interface Setup {
  tokens: string[];
  data?: (call: FakeCall) => FakeReply;
  token?: (call: FakeCall, n: number) => FakeReply;
  lifetimeSec?: number;
}

function setup(opts: Partial<Setup> = {}, clientOpts: Record<string, unknown> = {}) {
  const clock = createClock();
  let tokenN = 0;
  const logs: GarminLogEvent[] = [];
  const issued: string[] = [];
  const f = createFakeFetch((call) => {
    if (isToken(call)) {
      const n = tokenN++;
      if (opts.token) return opts.token(call, n);
      const t = jwtFor(clock.t, opts.lifetimeSec ?? 86400, { jti: `t${n}` });
      issued.push(t);
      return reply(200, `  ${t}\n`, { 'content-type': 'text/plain' });
    }
    return opts.data ? opts.data(call) : json(200, { ok: true });
  });
  const client = createGarminClient({
    apiKey: KEY,
    fetch: f.fetch,
    now: clock.now,
    sleep: clock.sleep,
    onLog: (e) => logs.push(e),
    ...clientOpts,
  });
  return { client, clock, logs, issued, ...f, tokenCalls: () => f.calls.filter(isToken), dataCalls: () => f.calls.filter((c) => !isToken(c)) };
}

describe('types', () => {
  it('the global fetch is assignable to FetchLike (type-level check)', () => {
    const f: FetchLike = fetch;
    expect(typeof f).toBe('function');
  });
});

describe('token exchange', () => {
  it('POSTs to the token endpoint with exactly the documented headers and no body', async () => {
    const s = setup();
    await s.client.ensureToken();
    expect(s.calls).toHaveLength(1);
    const c = s.calls[0]!;
    expect(c.url).toBe('https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token');
    expect(c.init.method).toBe('POST');
    expect(c.init.headers).toEqual({ Authorization: `ApiKey ${KEY}`, Accept: '*/*' });
    expect((c.init as { body?: unknown }).body).toBeUndefined();
  });
  it('uses the bare JWT body, trimmed, as the bearer token', async () => {
    const s = setup();
    await s.client.get('/x');
    expect(s.dataCalls()[0]!.init.headers.Authorization).toBe(`Bearer ${s.issued[0]}`);
  });
  it('accepts a quoted or JSON-wrapped token defensively', async () => {
    const clock = createClock();
    const jwt = jwtFor(clock.t, 86400);
    for (const body of [`"${jwt}"`, JSON.stringify({ token: jwt })]) {
      const f = createFakeFetch((c) => (isToken(c) ? reply(200, body) : json(200, [])));
      const client = createGarminClient({ apiKey: KEY, fetch: f.fetch, now: clock.now, sleep: clock.sleep });
      await client.get('/x');
      expect(f.calls[1]!.init.headers.Authorization).toBe(`Bearer ${jwt}`);
    }
  });
  it('reports the expiry from the exp claim', async () => {
    const s = setup({ lifetimeSec: 3600 * 10 });
    const info = await s.client.ensureToken();
    expect(info.refreshed).toBe(true);
    expect(info.expiresAtMs).toBe((Math.floor(s.clock.t / 1000) + 36000) * 1000);
    const again = await s.client.ensureToken();
    expect(again.refreshed).toBe(false);
  });
  it('assumes 24 h when the token has no readable exp', async () => {
    const clock = createClock();
    const opaque = 'a'.repeat(40);
    const f = createFakeFetch((c) => (isToken(c) ? reply(200, opaque) : json(200, [])));
    const client = createGarminClient({ apiKey: KEY, fetch: f.fetch, now: clock.now, sleep: clock.sleep });
    const info = await client.ensureToken();
    expect(info.expiresAtMs).toBe(clock.t + 86_400_000);
  });
  it('rejects a body that is not a token (HTML page)', async () => {
    const s = setup({ token: () => reply(200, '<html><body>maintenance</body></html>') });
    await expect(s.client.ensureToken()).rejects.toMatchObject({ kind: 'unexpected' });
  });
  it('rejects an empty token body', async () => {
    const s = setup({ token: () => reply(204) });
    await expect(s.client.ensureToken()).rejects.toMatchObject({ kind: 'unexpected' });
  });
  it('dedupes concurrent exchanges', async () => {
    const s = setup();
    await Promise.all([s.client.get('/a'), s.client.get('/b'), s.client.ensureToken()]);
    expect(s.tokenCalls()).toHaveLength(1);
  });
  it('uses the China host when asked', async () => {
    const clock = createClock();
    const f = createFakeFetch((c) => (c.url.endsWith(TOKEN_PATH) ? reply(200, jwtFor(clock.t, 86400)) : json(200, [])));
    const client = createGarminClient({ apiKey: KEY, fetch: f.fetch, now: clock.now, baseUrl: GARMIN_BASE_URL_CN + '/' });
    await client.get('/x');
    expect(f.calls[0]!.url).toBe(`${GARMIN_BASE_URL_CN}${TOKEN_PATH}`);
    expect(f.calls[1]!.url).toBe(`${GARMIN_BASE_URL_CN}/x`);
  });
});

describe('token errors', () => {
  const errorOf = async (reply_: FakeReply) => {
    const s = setup({ token: () => reply_ });
    return s.client.ensureToken().then(
      () => {
        throw new Error('expected failure');
      },
      (e: unknown) => e as GarminError,
    );
  };
  it('401 -> invalid_key with the documented message', async () => {
    const e = await errorOf(json(401, { errorId: 'BAD' }));
    expect(e).toBeInstanceOf(GarminError);
    expect(e.kind).toBe('invalid_key');
    expect(e.status).toBe(401);
    expect(e.errorId).toBe('BAD');
    expect(e.userMessage).toBe('Garmin rejected this key. Create a new Personal API key in Garmin Connect (it may have expired or been deleted).');
  });
  it('403 -> invalid_key', async () => {
    expect((await errorOf(reply(403))).kind).toBe('invalid_key');
  });
  it('406 -> not_acceptable', async () => {
    const e = await errorOf(reply(406));
    expect(e.kind).toBe('not_acceptable');
    expect(e.retryable).toBe(false);
  });
  it('5xx -> server and retryable', async () => {
    for (const st of [500, 502, 503]) {
      const e = await errorOf(reply(st));
      expect(e.kind).toBe('server');
      expect(e.retryable).toBe(true);
    }
  });
  it('429 on the token call waits then succeeds', async () => {
    let n = 0;
    const clock = createClock();
    const jwt = jwtFor(clock.t, 86400);
    const s = setup({ token: () => (n++ === 0 ? json(429, { retryInSeconds: 4 }) : reply(200, jwt)) });
    await s.client.ensureToken();
    expect(s.clock.sleeps).toEqual([4000]);
    expect(s.tokenCalls()).toHaveLength(2);
  });
  it('429 on the token call gives up after 2 retries', async () => {
    const s = setup({ token: () => json(429, { retryInSeconds: 1 }) });
    await expect(s.client.ensureToken()).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(s.tokenCalls()).toHaveLength(3);
    expect(s.clock.sleeps).toEqual([1000, 1000]);
  });
  it('after a successful exchange, a later 401 means the key expired or was revoked', async () => {
    let n = 0;
    const clock = createClock();
    const s = setup({ token: () => (n++ === 0 ? reply(200, jwtFor(clock.t, 86400)) : reply(401)), data: () => reply(401) });
    await expect(s.client.get('/x')).rejects.toMatchObject({ kind: 'key_expired_or_revoked' });
  });
  it('network failure -> network, timeout -> timeout', async () => {
    const f = createFakeFetch(() => new TypeError('Network request failed'));
    const client = createGarminClient({ apiKey: KEY, fetch: f.fetch });
    await expect(client.ensureToken()).rejects.toMatchObject({ kind: 'network', retryable: true });
  });
});

describe('key format', () => {
  it('looksLikeGarminApiKey', () => {
    expect(looksLikeGarminApiKey('GCDC_abc')).toBe(true);
    expect(looksLikeGarminApiKey('  "GCDC_abc"  ')).toBe(true);
    for (const bad of ['', '   ', 'abc', 'GCDC_', 'gcdc_abc', 'GCDC_a b', null, undefined, 5]) expect(looksLikeGarminApiKey(bad)).toBe(false);
  });
  it('rejects a malformed key locally without any network call', async () => {
    for (const apiKey of ['', 'not-a-key', 'GCDC_']) {
      const f = createFakeFetch(() => reply(200, 'x'.repeat(30)));
      const client = createGarminClient({ apiKey, fetch: f.fetch });
      await expect(client.get('/x')).rejects.toMatchObject({ kind: 'invalid_key' });
      expect(f.calls).toHaveLength(0);
    }
  });
  it('trims whitespace and quotes around the key', async () => {
    const clock = createClock();
    const f = createFakeFetch((c) => (isToken(c) ? reply(200, jwtFor(clock.t, 86400)) : json(200, 1)));
    const client = createGarminClient({ apiKey: `  "${KEY}"\n`, fetch: f.fetch, now: clock.now });
    await client.get('/x');
    expect(f.calls[0]!.init.headers.Authorization).toBe(`ApiKey ${KEY}`);
  });
});

describe('expiry and refresh', () => {
  it('reuses the token while more than 60 minutes remain', async () => {
    const s = setup({ lifetimeSec: 86400 });
    await s.client.get('/a');
    s.clock.advance(22 * 3600 * 1000); // 2 h left
    await s.client.get('/b');
    s.clock.advance(59 * 60 * 1000); // 61 min left
    await s.client.get('/c');
    expect(s.tokenCalls()).toHaveLength(1);
  });
  it('fetches a new token when less than 60 minutes remain', async () => {
    const s = setup({ lifetimeSec: 86400 });
    await s.client.get('/a');
    s.clock.advance(23 * 3600 * 1000 + 60_000 + 1000); // 59 min left
    await s.client.get('/b');
    expect(s.tokenCalls()).toHaveLength(2);
    expect(s.dataCalls()[1]!.init.headers.Authorization).toBe(`Bearer ${s.issued[1]}`);
  });
  it('refreshes an expired token', async () => {
    const s = setup({ lifetimeSec: 86400 });
    await s.client.get('/a');
    s.clock.advance(30 * 3600 * 1000);
    await s.client.get('/b');
    expect(s.tokenCalls()).toHaveLength(2);
  });
  it('does not thrash for a short-lived token (key about to expire)', async () => {
    const s = setup({ lifetimeSec: 30 * 60 });
    await s.client.get('/a');
    await s.client.get('/b');
    await s.client.get('/c');
    expect(s.tokenCalls()).toHaveLength(1);
    s.clock.advance(6 * 60_000); // grace window over, 24 min left -> refresh
    await s.client.get('/d');
    expect(s.tokenCalls()).toHaveLength(2);
  });
  it('ensureToken({force}) always exchanges', async () => {
    const s = setup();
    await s.client.ensureToken();
    const info = await s.client.ensureToken({ force: true });
    expect(info.refreshed).toBe(true);
    expect(s.tokenCalls()).toHaveLength(2);
  });
});

describe('data requests', () => {
  it('sends GET with Bearer + Accept */* and never the key', async () => {
    const s = setup();
    await s.client.get('/usersummary-service/v2/dailysummaries', { startDate: '2026-11-01', endDate: '2026-11-07' });
    const c = s.dataCalls()[0]!;
    expect(c.init.method).toBe('GET');
    expect(c.url).toBe(`${BASE}/usersummary-service/v2/dailysummaries?startDate=2026-11-01&endDate=2026-11-07`);
    expect(Object.keys(c.init.headers).sort()).toEqual(['Accept', 'Authorization']);
    expect(c.init.headers.Accept).toBe('*/*');
    expect(JSON.stringify(c)).not.toContain(KEY);
  });
  it('the key is sent to the token endpoint only', async () => {
    const s = setup();
    await s.client.get('/a');
    await s.client.getText('/b');
    await s.client.get('/c', { q: 'x' });
    const carriers = s.calls.filter((c) => JSON.stringify(c).includes(KEY));
    expect(carriers).toHaveLength(1);
    expect(carriers[0]!.url).toBe(TOKEN_URL);
  });
  it('encodes params, skips null/undefined and stringifies booleans/numbers', async () => {
    const s = setup();
    await s.client.get('/p', { a: 'x y&z', b: undefined, c: null, d: true, e: 0, f: 100 });
    expect(s.dataCalls()[0]!.url).toBe(`${BASE}/p?a=x%20y%26z&d=true&e=0&f=100`);
  });
  it('appends to an existing query string', async () => {
    const s = setup();
    await s.client.get('/p?includeAll=true', { x: 1 });
    expect(s.dataCalls()[0]!.url).toBe(`${BASE}/p?includeAll=true&x=1`);
  });
  it('refuses paths that could send the token elsewhere', async () => {
    const s = setup();
    for (const p of ['https://evil.example/x', '//evil.example/x', 'relative', '/a b', '/a\\b', '/x://y']) {
      await expect(s.client.get(p)).rejects.toMatchObject({ kind: 'bad_request' });
    }
    expect(s.calls).toHaveLength(0);
  });
  it('204 and empty bodies give null', async () => {
    for (const r of [reply(204), reply(200, ''), reply(200, '  \n')]) {
      const s = setup({ data: () => r });
      expect(await s.client.get('/x')).toBeNull();
      expect(await s.client.getText('/x')).toBeNull();
    }
  });
  it('parses JSON by content type or by shape', async () => {
    expect(await setup({ data: () => json(200, { a: [1, 2] }) }).client.get('/x')).toEqual({ a: [1, 2] });
    expect(await setup({ data: () => reply(200, '[1,2,3]', { 'content-type': 'text/plain' }) }).client.get('/x')).toEqual([1, 2, 3]);
    expect(await setup({ data: () => reply(200, '{"k":1}') }).client.get('/x')).toEqual({ k: 1 });
    expect(await setup({ data: () => reply(200, 'null', { 'content-type': 'application/json' }) }).client.get('/x')).toBeNull();
    expect(await setup({ data: () => reply(200, '42') }).client.get('/x')).toBe(42);
  });
  it('returns non-JSON bodies as text and getText returns raw text', async () => {
    expect(await setup({ data: () => reply(200, 'hello world', { 'content-type': 'text/plain' }) }).client.get('/x')).toBe('hello world');
    expect(await setup({ data: () => json(200, { a: 1 }) }).client.getText('/x')).toBe('{"a":1}');
  });
  it('invalid JSON with a JSON content type -> unexpected', async () => {
    const s = setup({ data: () => reply(200, '{oops', { 'content-type': 'application/json' }) });
    await expect(s.client.get('/x')).rejects.toMatchObject({ kind: 'unexpected' });
  });
  it('maps data-call statuses', async () => {
    const cases: Array<[number, string]> = [[400, 'bad_request'], [404, 'bad_request'], [406, 'not_acceptable'], [403, 'unauthorized'], [500, 'server'], [503, 'server']];
    for (const [status, kind] of cases) {
      const s = setup({ data: () => json(status, { errorId: 'E1' }) });
      await expect(s.client.get('/x')).rejects.toMatchObject({ kind, status });
    }
  });
  it('403 is not retried with a new token', async () => {
    const s = setup({ data: () => reply(403) });
    await expect(s.client.get('/x')).rejects.toMatchObject({ kind: 'unauthorized', status: 403 });
    expect(s.tokenCalls()).toHaveLength(1);
    expect(s.dataCalls()).toHaveLength(1);
  });
  it('counts every HTTP request', async () => {
    const s = setup();
    await s.client.get('/a');
    await s.client.get('/b');
    expect(s.client.getRequestCount()).toBe(3);
  });
});

describe('401 retry', () => {
  it('retries a 401 exactly once with a fresh token', async () => {
    let dataN = 0;
    const s = setup({ data: () => (dataN++ === 0 ? reply(401) : json(200, { fine: true })) });
    expect(await s.client.get('/x')).toEqual({ fine: true });
    expect(s.tokenCalls()).toHaveLength(2);
    expect(s.dataCalls()).toHaveLength(2);
    expect(s.dataCalls()[0]!.init.headers.Authorization).toBe(`Bearer ${s.issued[0]}`);
    expect(s.dataCalls()[1]!.init.headers.Authorization).toBe(`Bearer ${s.issued[1]}`);
  });
  it('a second 401 surfaces as unauthorized (no endless loop)', async () => {
    const s = setup({ data: () => reply(401) });
    await expect(s.client.get('/x')).rejects.toMatchObject({ kind: 'unauthorized', status: 401 });
    expect(s.tokenCalls()).toHaveLength(2);
    expect(s.dataCalls()).toHaveLength(2);
  });
  it('the retry budget is per call, so the next call may retry again', async () => {
    let dataN = 0;
    const s = setup({ data: () => (dataN++ % 2 === 0 ? reply(401) : json(200, 'ok')) });
    await s.client.get('/a');
    await s.client.get('/b');
    expect(s.tokenCalls()).toHaveLength(3);
  });
});

describe('429 handling', () => {
  it('waits retryInSeconds then retries', async () => {
    let n = 0;
    const s = setup({ data: () => (n++ === 0 ? json(429, { errorId: 'RL', retryInSeconds: 7 }) : json(200, [1])) });
    expect(await s.client.get('/x')).toEqual([1]);
    expect(s.clock.sleeps).toEqual([7000]);
  });
  it('caps the wait at 60 s', async () => {
    let n = 0;
    const s = setup({ data: () => (n++ === 0 ? json(429, { retryInSeconds: 500 }) : json(200, 'ok')) });
    await s.client.get('/x');
    expect(s.clock.sleeps).toEqual([60_000]);
  });
  it('retries at most twice, then throws rate_limited with the requested delay', async () => {
    const s = setup({ data: () => json(429, { retryInSeconds: 3 }) });
    await expect(s.client.get('/x')).rejects.toMatchObject({ kind: 'rate_limited', status: 429, retryAfterSeconds: 3, retryable: true });
    expect(s.dataCalls()).toHaveLength(3);
    expect(s.clock.sleeps).toEqual([3000, 3000]);
  });
  it('falls back to the Retry-After header, then to a default', async () => {
    let n = 0;
    const a = setup({ data: () => (n++ === 0 ? reply(429, '', { 'retry-after': '5' }) : json(200, 'ok')) });
    await a.client.get('/x');
    expect(a.clock.sleeps).toEqual([5000]);
    let m = 0;
    const b = setup({ data: () => (m++ === 0 ? reply(429, 'slow down') : json(200, 'ok')) });
    await b.client.get('/x');
    expect(b.clock.sleeps).toEqual([10_000]);
  });
  it('zero wait is allowed', async () => {
    let n = 0;
    const s = setup({ data: () => (n++ === 0 ? json(429, { retryInSeconds: 0 }) : json(200, 'ok')) });
    await s.client.get('/x');
    expect(s.clock.sleeps).toEqual([0]);
  });
});

describe('request budget', () => {
  it('waits when more than the budget is requested within the window', async () => {
    const s = setup({}, { budget: { maxRequests: 5, windowMs: 60_000 } });
    for (let i = 0; i < 4; i++) await s.client.get(`/r${i}`); // + 1 token = 5 requests
    expect(s.clock.sleeps).toEqual([]);
    await s.client.get('/r4'); // 6th request must wait for the first to leave the window
    expect(s.clock.sleeps).toHaveLength(1);
    expect(s.clock.sleeps[0]).toBe(60_000);
  });
  it('defaults to 90 requests per rolling minute (checked over the fake timeline)', async () => {
    const clock = createClock();
    const times: number[] = [];
    const jwt = jwtFor(clock.t, 10 * 86400);
    const f = createFakeFetch((c) => {
      times.push(clock.t);
      return isToken(c) ? reply(200, jwt) : json(200, []);
    });
    const client = createGarminClient({ apiKey: KEY, fetch: f.fetch, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 250; i++) await client.get(`/r${i}`);
    expect(times).toHaveLength(251);
    expect(clock.sleeps.length).toBeGreaterThan(0);
    for (let i = 0; i < times.length; i++) {
      const inWindow = times.filter((t) => t >= times[i]! && t < times[i]! + 60_000).length;
      expect(inWindow).toBeLessThanOrEqual(90);
    }
  });
  it('lets requests through again after the window passes', async () => {
    const s = setup({}, { budget: { maxRequests: 3, windowMs: 1000 } });
    await s.client.get('/a');
    await s.client.get('/b');
    s.clock.advance(1001);
    await s.client.get('/c');
    await s.client.get('/d');
    expect(s.clock.sleeps).toEqual([]);
  });
  it('counts token exchanges and retries toward the budget', async () => {
    let n = 0;
    const s = setup({ data: () => (n++ === 0 ? json(429, { retryInSeconds: 0 }) : json(200, 'ok')) }, { budget: { maxRequests: 2, windowMs: 60_000 } });
    await s.client.get('/a'); // token + 429 + retry = 3 requests > 2
    expect(s.clock.sleeps.filter((x) => x > 0)).toHaveLength(1);
  });
});

describe('timeout and network', () => {
  it('times out a request that never answers', async () => {
    const clock = createClock();
    const jwt = jwtFor(clock.t, 86400);
    const f = createFakeFetch((c) => (isToken(c) ? reply(200, jwt) : (new Promise(() => undefined) as unknown as FakeReply)));
    const client = createGarminClient({ apiKey: KEY, fetch: f.fetch, now: clock.now, timeoutMs: 20 });
    await expect(client.get('/slow')).rejects.toMatchObject({ kind: 'timeout', retryable: true });
  });
  it('aborts the fetch signal on timeout', async () => {
    const clock = createClock();
    const jwt = jwtFor(clock.t, 86400);
    let aborted = false;
    const client = createGarminClient({
      apiKey: KEY,
      now: clock.now,
      timeoutMs: 20,
      fetch: (url, init) => {
        if (url === TOKEN_URL) return Promise.resolve({ status: 200, text: async () => jwt });
        return new Promise((_, reject) => {
          init.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        });
      },
    });
    await expect(client.get('/slow')).rejects.toMatchObject({ kind: 'timeout' });
    expect(aborted).toBe(true);
  });
  it('maps thrown fetch errors to network', async () => {
    const s = setup({ data: () => new TypeError('Network request failed') });
    await expect(s.client.get('/x')).rejects.toMatchObject({ kind: 'network', retryable: true });
  });
  it('a missing global fetch is reported as a network error', async () => {
    const g = globalThis as { fetch?: unknown };
    const saved = g.fetch;
    g.fetch = undefined;
    try {
      await expect(createGarminClient({ apiKey: KEY }).ensureToken()).rejects.toMatchObject({ kind: 'network' });
    } finally {
      g.fetch = saved;
    }
  });
});

describe('secrets never leak', () => {
  const secretsIn = (value: unknown, secrets: string[]): string[] => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return secrets.filter((s) => text.includes(s));
  };

  it('network errors that echo the key are scrubbed', async () => {
    const f = createFakeFetch(() => new Error(`connect failed for ApiKey ${KEY}`));
    const client = createGarminClient({ apiKey: KEY, fetch: f.fetch });
    const e = await client.ensureToken().then(() => null, (x: GarminError) => x);
    expect(e).not.toBeNull();
    expect(secretsIn([e!.message, e!.userMessage, e!.detail, e!.toJSON(), e!.stack?.split('\n')[0]], [KEY])).toEqual([]);
  });
  it('error bodies that echo the key or the bearer token are scrubbed', async () => {
    const clock = createClock();
    const jwt = jwtFor(clock.t, 86400);
    const f = createFakeFetch((c) =>
      isToken(c) ? reply(200, jwt) : json(500, { message: `bad bearer ${jwt}, key ${KEY}`, errorId: jwt }),
    );
    const client = createGarminClient({ apiKey: KEY, fetch: f.fetch, now: clock.now });
    const e = await client.get('/x').then(() => null, (x: GarminError) => x);
    expect(e).not.toBeNull();
    expect(secretsIn([e!.message, e!.userMessage, e!.detail, e!.errorId, e!.toJSON()], [KEY, jwt])).toEqual([]);
  });
  it('401 on the token call with an echoing body is scrubbed', async () => {
    const f = createFakeFetch(() => json(401, { message: `invalid ${KEY}` }));
    const client = createGarminClient({ apiKey: KEY, fetch: f.fetch });
    const e = await client.ensureToken().then(() => null, (x: GarminError) => x);
    expect(secretsIn(e!.toJSON(), [KEY])).toEqual([]);
  });
  it('onLog output never contains the key or any token, across success and failure paths', async () => {
    const clock = createClock();
    const logs: GarminLogEvent[] = [];
    let n = 0;
    const seen: Record<string, number> = {};
    const issued: string[] = [];
    const f = createFakeFetch((c) => {
      if (isToken(c)) {
        const t = jwtFor(clock.t, 86400, { jti: `x${n++}` });
        issued.push(t);
        return reply(200, t);
      }
      const k = (seen[c.url] = (seen[c.url] ?? 0) + 1);
      if (c.url.endsWith('/a')) return k === 1 ? reply(401) : json(200, []);
      if (c.url.endsWith('/b')) {
        if (k === 1) return json(429, { retryInSeconds: 1, message: `echo ${issued[0]} ${KEY}` });
        return new Error(`oops ${issued[issued.length - 1]} ${KEY}`);
      }
      return json(200, {});
    });
    const client = createGarminClient({ apiKey: KEY, fetch: f.fetch, now: clock.now, sleep: clock.sleep, onLog: (e) => logs.push(e) });
    await client.get('/a');
    await client.get('/b').catch(() => undefined);
    await client.validate();
    expect(logs.length).toBeGreaterThan(3);
    const text = JSON.stringify(logs);
    expect(text).not.toContain(KEY);
    for (const t of issued) expect(text).not.toContain(t);
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
  });
  it('a throwing onLog callback does not break requests', async () => {
    const s = setup({}, { onLog: () => { throw new Error('logger bug'); } });
    expect(await s.client.get('/x')).toEqual({ ok: true });
  });
  it('log events carry paths without query strings', async () => {
    const s = setup();
    await s.client.get('/p', { startDate: '2026-01-01' });
    expect(s.logs.some((l) => l.path === '/p' && l.status === 200)).toBe(true);
    expect(JSON.stringify(s.logs)).not.toContain('startDate');
  });
});

describe('validate()', () => {
  it('returns the account name on success', async () => {
    const s = setup({ data: () => json(200, { displayName: 'Sam', timeZone: 'Europe/Sarajevo', measurementSystem: 'metric' }) });
    const v = await s.client.validate();
    expect(v).toMatchObject({ ok: true, displayName: 'Sam', timeZone: 'Europe/Sarajevo', measurementSystem: 'metric' });
    if (v.ok) expect(v.tokenExpiresAtMs).toBeGreaterThan(s.clock.t);
    expect(s.dataCalls()[0]!.url).toBe(`${BASE}/userprofile-service/userprofile/settings`);
  });
  it('never throws: a rejected key gives ok:false with a GarminError', async () => {
    const s = setup({ token: () => reply(401) });
    const v = await s.client.validate();
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.error.kind).toBe('invalid_key');
      expect(s.dataCalls()).toHaveLength(0);
    }
  });
  it('a malformed key gives ok:false without network', async () => {
    const f = createFakeFetch(() => reply(200, 'x'.repeat(30)));
    const v = await createGarminClient({ apiKey: 'nope', fetch: f.fetch }).validate();
    expect(v.ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
  it('the key is still valid when only the profile read is forbidden (missing USER_READ)', async () => {
    const s = setup({ data: () => reply(403) });
    const v = await s.client.validate();
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.profileError?.status).toBe(403);
  });
  it('is ok with no display name when the profile body is empty or odd', async () => {
    for (const body of [reply(204), json(200, [1, 2]), json(200, 'text')]) {
      const v = await setup({ data: () => body }).client.validate();
      expect(v).toMatchObject({ ok: true });
      if (v.ok) expect(v.displayName).toBeUndefined();
    }
  });
  it('a persistent 401 on the profile call is a failure', async () => {
    const s = setup({ data: () => reply(401) });
    const v = await s.client.validate();
    expect(v.ok).toBe(false);
  });
  it('a network failure on the profile call keeps the validated key', async () => {
    const s = setup({ data: () => new Error('offline') });
    const v = await s.client.validate();
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.profileError?.kind).toBe('network');
  });
});
