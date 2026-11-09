import { describe, expect, it, vi } from 'vitest';
import {
  apiError,
  callerFromRequest,
  CORS_HEADERS,
  fetchUpstreamJson,
  handleHttp,
  jsonResponse,
  parseRetryAfter,
  rateLimited,
} from '../../../supabase/functions/_shared/http.ts';
import {
  makeConsumeRateLimit,
  GLOBAL_RATE_LIMIT_USER,
} from '../../../supabase/functions/_shared/rate-limit.ts';
import { StoreError } from '../../../supabase/functions/_shared/food-store.ts';

const USER = '11111111-2222-4333-8444-555555555555';

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.signature`;
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://x.supabase.co/functions/v1/f', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('handleHttp', () => {
  const quiet = () => {};

  it('answers CORS preflight and echoes requested headers', async () => {
    const res = await handleHttp(
      new Request('https://x/f', {
        method: 'OPTIONS',
        headers: { 'Access-Control-Request-Headers': 'authorization, x-custom' },
      }),
      async () => {
        throw new Error('must not run');
      },
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('authorization, x-custom');
    expect(await res.text()).toBe('');
  });

  it('preflight without requested headers uses the defaults', async () => {
    const res = await handleHttp(new Request('https://x/f', { method: 'OPTIONS' }), async () =>
      apiError(500, 'x', 'x'),
    );
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe(
      CORS_HEADERS['Access-Control-Allow-Headers'],
    );
  });

  it('runs the handler and returns JSON with CORS headers', async () => {
    const run = vi.fn(async (body: unknown) => ({ status: 200, body: { echo: body } }));
    const res = await handleHttp(post({ a: 1 }), run);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await res.json()).toEqual({ echo: { a: 1 } });
    expect(run).toHaveBeenCalledOnce();
  });

  it('405 for other methods, with CORS and Allow', async () => {
    const res = await handleHttp(new Request('https://x/f', { method: 'GET' }), async () =>
      apiError(200, 'x', 'x'),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('POST, OPTIONS');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await res.json()).toMatchObject({ error: 'method_not_allowed' });
  });

  it('400 invalid_json and 413 for oversized bodies', async () => {
    const bad = await handleHttp(post('{nope'), async () => apiError(200, 'x', 'x'));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_json' });
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBe('*');

    const big = await handleHttp(post({ q: 'x'.repeat(20_000) }), async () =>
      apiError(200, 'x', 'x'),
    );
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ error: 'payload_too_large' });
  });

  it('turns thrown errors into a JSON 500 (with CORS) without leaking details', async () => {
    const log = vi.fn();
    const res = await handleHttp(
      post({}),
      async () => {
        throw new StoreError('upsert_branded_food', {
          message: 'password authentication failed for user "postgres"',
        });
      },
      log,
    );
    expect(res.status).toBe(500);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const text = await res.text();
    expect(text).not.toContain('password');
    expect(JSON.parse(text)).toMatchObject({ error: 'internal_error' });
    expect(log).toHaveBeenCalledOnce();
    void quiet;
  });

  it('jsonResponse merges custom headers (Retry-After) and keeps CORS', async () => {
    const res = jsonResponse(rateLimited(30, { upstream: 'off' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await res.json()).toMatchObject({
      error: 'rate_limited',
      retryAfterSeconds: 30,
      upstream: 'off',
    });
  });
});

describe('callerFromRequest', () => {
  const req = (authorization?: string) =>
    new Request('https://x/f', {
      method: 'POST',
      headers: authorization ? { Authorization: authorization } : {},
    });
  const future = Math.floor(Date.now() / 1000) + 3600;

  it('accepts an authenticated user token', () => {
    const token = jwt({ role: 'authenticated', sub: USER, exp: future });
    expect(callerFromRequest(req(`Bearer ${token}`))).toEqual({ userId: USER, token });
  });

  it('refuses the anon key, expired tokens, missing sub and garbage', () => {
    expect(callerFromRequest(req(`Bearer ${jwt({ role: 'anon', exp: future })}`))).toBeNull();
    expect(callerFromRequest(req(`Bearer ${jwt({ role: 'service_role', sub: USER })}`))).toBeNull();
    expect(
      callerFromRequest(req(`Bearer ${jwt({ role: 'authenticated', sub: USER, exp: 1 })}`)),
    ).toBeNull();
    expect(callerFromRequest(req(`Bearer ${jwt({ role: 'authenticated' })}`))).toBeNull();
    expect(
      callerFromRequest(req(`Bearer ${jwt({ role: 'authenticated', sub: 'not-a-uuid' })}`)),
    ).toBeNull();
    expect(callerFromRequest(req('Bearer abc'))).toBeNull();
    expect(callerFromRequest(req('Bearer a.b.c'))).toBeNull();
    expect(callerFromRequest(req('Basic abc'))).toBeNull();
    expect(callerFromRequest(req())).toBeNull();
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates, clamps to 1..3600, defaults to 60', () => {
    expect(parseRetryAfter('42')).toBe(42);
    expect(parseRetryAfter('1.2')).toBe(2);
    expect(parseRetryAfter('0')).toBe(1);
    expect(parseRetryAfter('999999')).toBe(3600);
    expect(parseRetryAfter(null)).toBe(60);
    expect(parseRetryAfter('soon')).toBe(60);
    const now = Date.UTC(2026, 10, 10, 12, 0, 0);
    expect(parseRetryAfter('Tue, 10 Nov 2026 12:02:00 GMT', now)).toBe(120);
    expect(parseRetryAfter('Tue, 10 Nov 2026 11:00:00 GMT', now)).toBe(1);
  });
});

describe('fetchUpstreamJson', () => {
  const run = (impl: () => Promise<Response> | Response) =>
    fetchUpstreamJson(async () => impl(), 'https://example.test/?api_key=SECRET');

  it('classifies responses', async () => {
    expect(await run(() => new Response('{"a":1}'))).toEqual({ kind: 'ok', json: { a: 1 } });
    expect(await run(() => new Response('{}', { status: 404 }))).toEqual({ kind: 'not_found' });
    expect(
      await run(() => new Response('{}', { status: 429, headers: { 'Retry-After': '5' } })),
    ).toEqual({
      kind: 'rate_limited',
      retryAfterSeconds: 5,
    });
    expect(await run(() => new Response('{}', { status: 403 }))).toEqual({
      kind: 'error',
      reason: 'http_403',
      status: 403,
    });
    expect(await run(() => new Response('{}', { status: 502 }))).toMatchObject({
      kind: 'error',
      reason: 'http_502',
    });
    expect(await run(() => new Response('<html>', { status: 200 }))).toMatchObject({
      kind: 'error',
      reason: 'invalid_json',
    });
  });

  it('maps network errors and timeouts without leaking the URL', async () => {
    const net = await run(() =>
      Promise.reject(new TypeError('fetch failed for https://example.test/?api_key=SECRET')),
    );
    expect(net).toEqual({ kind: 'error', reason: 'network' });
    const timeout = await run(() =>
      Promise.reject(Object.assign(new Error('x'), { name: 'TimeoutError' })),
    );
    expect(timeout).toEqual({ kind: 'error', reason: 'timeout' });
    expect(JSON.stringify([net, timeout])).not.toContain('SECRET');
  });

  it('passes an abort signal to fetch', async () => {
    const seen: Array<RequestInit | undefined> = [];
    await fetchUpstreamJson(
      async (_u, init) => (seen.push(init), new Response('{}')),
      'https://example.test/',
      { headers: { A: 'b' } },
      1000,
    );
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(seen[0]!.headers).toEqual({ A: 'b' });
  });
});

describe('makeConsumeRateLimit', () => {
  it('calls consume_rate_limit with the trusted arguments and returns the wait', async () => {
    const rpc = vi.fn(async () => ({ data: 0, error: null }));
    const consume = makeConsumeRateLimit({
      rpc,
      from: () => {
        throw new Error('unused');
      },
    });
    expect(await consume(USER, 'online-search', 5, 60)).toBe(0);
    expect(rpc).toHaveBeenCalledWith('consume_rate_limit', {
      p_user_id: USER,
      p_bucket: 'online-search',
      p_max_per_window: 5,
      p_window_seconds: 60,
    });
    expect(GLOBAL_RATE_LIMIT_USER).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('throws on errors and bad answers (fail closed)', async () => {
    const from = () => {
      throw new Error('unused');
    };
    await expect(
      makeConsumeRateLimit({ rpc: async () => ({ data: null, error: { message: 'x' } }), from })(
        USER,
        'b',
        1,
        1,
      ),
    ).rejects.toBeInstanceOf(StoreError);
    await expect(
      makeConsumeRateLimit({ rpc: async () => ({ data: 'abc', error: null }), from })(
        USER,
        'b',
        1,
        1,
      ),
    ).rejects.toBeInstanceOf(StoreError);
    expect(
      await makeConsumeRateLimit({ rpc: async () => ({ data: 2.2, error: null }), from })(
        USER,
        'b',
        1,
        1,
      ),
    ).toBe(3);
  });
});
