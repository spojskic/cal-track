/**
 * The Edge Function `sign-up` as the mock backend answers it (signup-function.ts), and the app's own account creation code
 * (apps/app/src/data/signup.ts) talking to it through the REAL supabase-js client. The browser scenarios in scenarios.ts
 * depend on exactly this behaviour; Chrome itself is not needed to prove it.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { ANON_KEY, APP_ORIGIN, BACKEND_ORIGIN } from './constants';
import { USER, buildFixtures } from './fixtures';
import { createMockBackend, type MockBackend } from './mock-backend';
import {
  SIGNUP_ATTEMPTS_PER_CLIENT,
  SIGNUP_EXPIRED_CODE,
  SIGNUP_USED_UP_CODE,
  SIGNUP_VALID_CODE,
} from './signup-function';

const holder = vi.hoisted(() => ({ client: null as any }));

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: true,
  supabase: new Proxy({}, { get: (_target, prop) => holder.client[prop] }),
}));

const here = dirname(fileURLToPath(import.meta.url));

async function loadCreateClient(): Promise<((url: string, key: string, options: unknown) => any) | null> {
  try {
    const require = createRequire(join(here, '..', '..', '..', 'apps', 'app', 'package.json'));
    const mod = (await import(pathToFileURL(require.resolve('@supabase/supabase-js')).href)) as { createClient: (url: string, key: string, options: unknown) => any };
    return mod.createClient;
  } catch {
    return null;
  }
}

const createClient = await loadCreateClient();
const load = (specifier: string): Promise<any> => import(/* @vite-ignore */ specifier);

interface Reply {
  status: number;
  headers: Record<string, string>;
  json: any;
}

/** Raw HTTP to the mock, the way a browser would send it. */
function http(backend: MockBackend) {
  return (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Reply => {
    const res = backend.handle({
      method,
      url: `${BACKEND_ORIGIN}${path}`,
      headers: { apikey: ANON_KEY, authorization: `Bearer ${ANON_KEY}`, origin: APP_ORIGIN, 'content-type': 'application/json', ...headers },
      body: body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, json: res.body ? JSON.parse(res.body) : null };
  };
}

const NEW_USER = { email: 'New.Friend@Example.com', password: 'a-good-password' };
const signUpBody = (over: Record<string, unknown> = {}) => ({ ...NEW_USER, inviteCode: SIGNUP_VALID_CODE, ...over });

function setup() {
  const backend = createMockBackend(buildFixtures('default').seed);
  return { backend, call: http(backend) };
}

describe('mock backend: Edge Function sign-up', () => {
  it('creates the account, spends the code and lets the new user sign in with a password grant', () => {
    const { backend, call } = setup();
    const res = call('POST', '/functions/v1/sign-up', signUpBody());
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ ok: true });
    expect(backend.inviteUses(SIGNUP_VALID_CODE)).toBe(1);

    const grant = call('POST', '/auth/v1/token?grant_type=password', { email: ' New.Friend@example.com ', password: NEW_USER.password });
    expect(grant.status).toBe(200);
    expect(grant.json.user).toMatchObject({ email: 'new.friend@example.com', aud: 'authenticated' });
    const wrong = call('POST', '/auth/v1/token?grant_type=password', { email: NEW_USER.email, password: 'nope' });
    expect(wrong.status).toBe(400);

    // handle_new_user: a profile that is not onboarded yet, and the four default meal groups
    const id = grant.json.user.id as string;
    expect(backend.rows('profiles').filter((p) => p.user_id === id)).toMatchObject([{ onboarded: false, display_name: 'new.friend' }]);
    expect(backend.rows('meal_groups').filter((g) => g.user_id === id).map((g) => g.name)).toEqual(['Breakfast', 'Lunch', 'Dinner', 'Snacks']);
    expect(backend.integrityErrors()).toEqual([]);
    expect(backend.unhandled).toEqual([]);
    expect(backend.calls.filter((c) => c.kind === 'function').map((c) => [c.target, c.status])).toEqual([['sign-up', 201]]);

    // the new user sees only their own (empty) data
    const token = grant.json.access_token as string;
    const foods = call('GET', '/rest/v1/diary_entries?select=id', undefined, { authorization: `Bearer ${token}` });
    expect(foods.status).toBe(200);
    expect(foods.json).toEqual([]);
  });

  it('accepts the code in any spelling', () => {
    const { call } = setup();
    expect(call('POST', '/functions/v1/sign-up', signUpBody({ inviteCode: ` ${SIGNUP_VALID_CODE.toLowerCase().replace(/-/g, ' ')} ` })).status).toBe(201);
  });

  it.each([
    ['an unknown code', 'ZZZZ-ZZZZ-ZZZZ', 'invite_invalid'],
    ['an expired code', SIGNUP_EXPIRED_CODE, 'invite_expired'],
    ['a used up code', SIGNUP_USED_UP_CODE, 'invite_used_up'],
  ])('403 for %s and no account is created', (_label, inviteCode, error) => {
    const { backend, call } = setup();
    const res = call('POST', '/functions/v1/sign-up', signUpBody({ inviteCode }));
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ error, message: expect.any(String) });
    expect(call('POST', '/auth/v1/token?grant_type=password', NEW_USER).status).toBe(400);
    expect(backend.rows('profiles')).toHaveLength(1);
  });

  it('a single-use code works once', () => {
    const { call } = setup();
    expect(call('POST', '/functions/v1/sign-up', signUpBody()).status).toBe(201);
    const again = call('POST', '/functions/v1/sign-up', signUpBody({ email: 'other@example.com' }));
    expect(again.status).toBe(403);
    expect(again.json.error).toBe('invite_used_up');
  });

  it('409 email_taken for an existing account (any case) and the code is given back', () => {
    const { backend, call } = setup();
    const res = call('POST', '/functions/v1/sign-up', signUpBody({ email: USER.email.toUpperCase() }));
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('email_taken');
    expect(backend.inviteUses(SIGNUP_VALID_CODE)).toBe(0);
    expect(call('POST', '/functions/v1/sign-up', signUpBody()).status).toBe(201);
  });

  it.each([
    ['an invalid e-mail', { email: 'nope' }, 'invalid_email'],
    ['a short password', { password: 'short' }, 'invalid_password'],
    ['an empty code', { inviteCode: '' }, 'invalid_invite_code'],
  ])('400 for %s (the REAL validation of the function)', (_label, over, error) => {
    const { backend, call } = setup();
    const res = call('POST', '/functions/v1/sign-up', signUpBody(over));
    expect(res.status).toBe(400);
    expect(res.json.error).toBe(error);
    expect(backend.inviteUses(SIGNUP_VALID_CODE)).toBe(0);
  });

  it('throttles like the function: 5 attempts per client, then 429 with retryAfterSeconds', () => {
    const { call } = setup();
    for (let i = 0; i < SIGNUP_ATTEMPTS_PER_CLIENT; i++) {
      expect(call('POST', '/functions/v1/sign-up', signUpBody({ inviteCode: 'ZZZZ-ZZZZ-ZZZZ' })).status).toBe(403);
    }
    const limited = call('POST', '/functions/v1/sign-up', signUpBody());
    expect(limited.status).toBe(429);
    expect(limited.json).toMatchObject({ error: 'rate_limited', retryAfterSeconds: 600 });
    expect(limited.headers['Retry-After']).toBe('600');
  });

  it('answers GET with 405, bad JSON with 400, and the CORS preflight of the browser', () => {
    const { call, backend } = setup();
    expect(call('GET', '/functions/v1/sign-up').status).toBe(405);
    expect(call('POST', '/functions/v1/sign-up', '{nope').json.error).toBe('invalid_json');
    const preflight = backend.handle({
      method: 'OPTIONS',
      url: `${BACKEND_ORIGIN}/functions/v1/sign-up`,
      headers: { origin: APP_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,apikey,content-type,x-client-info' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    expect(preflight.headers['access-control-allow-headers']).toContain('x-client-info');
    // every response carries CORS headers
    expect(call('POST', '/functions/v1/sign-up', signUpBody()).headers['access-control-allow-origin']).toBe(APP_ORIGIN);
  });

  it('the other functions still answer 404 not_deployed', () => {
    const { call, backend } = setup();
    expect(call('POST', '/functions/v1/online-search', { query: 'x' }).json).toMatchObject({ error: 'not_deployed' });
    expect(backend.unhandled).toEqual([]);
  });
});

const suite = createClient ? describe : describe.skip;

suite('apps/app createAccount against the mock backend (real supabase-js)', () => {
  function connect() {
    const backend = createMockBackend(buildFixtures('default').seed);
    const store = new Map<string, string>();
    const network = { offline: false };
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (network.offline) throw new TypeError('Failed to fetch');
      const req = new Request(input, init);
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const res = backend.handle({ method: req.method, url: req.url, headers, body: init?.body == null ? null : String(init.body) });
      return new Response(res.body === '' || res.status === 204 ? null : res.body, { status: res.status, headers: res.headers });
    };
    holder.client = (createClient as NonNullable<typeof createClient>)(BACKEND_ORIGIN, ANON_KEY, {
      auth: {
        storage: { getItem: async (k: string) => store.get(k) ?? null, setItem: async (k: string, v: string) => void store.set(k, v), removeItem: async (k: string) => void store.delete(k) },
        autoRefreshToken: false,
        persistSession: true,
        detectSessionInUrl: false,
      },
      global: { fetch: fetchImpl },
    });
    return { backend, supabase: holder.client, network };
  }

  const input = (over: Record<string, string> = {}) => ({ email: ' New.Friend@Example.com ', password: NEW_USER.password, inviteCode: 'k7m2 9qxa-f3tw', ...over });

  it('creates the account, then the same credentials sign in and the profile asks for onboarding', async () => {
    const { createAccount } = await load('@/data/signup');
    const { backend, supabase } = connect();
    expect(await createAccount(input())).toEqual({ ok: true });
    expect(backend.unhandled).toEqual([]);

    const signedIn = await supabase.auth.signInWithPassword({ email: 'New.Friend@Example.com', password: NEW_USER.password });
    expect(signedIn.error).toBeNull();
    expect(signedIn.data.user.email).toBe('new.friend@example.com');
    const profile = await supabase.from('profiles').select('onboarded').maybeSingle();
    expect(profile.data).toEqual({ onboarded: false });
  });

  it.each([
    ['an unknown code', { inviteCode: 'ZZZZ-ZZZZ-ZZZZ' }, { message: 'That invite code is not valid.', field: 'inviteCode' }],
    ['an expired code', { inviteCode: SIGNUP_EXPIRED_CODE }, { message: 'That code has expired.', field: 'inviteCode' }],
    ['a used up code', { inviteCode: SIGNUP_USED_UP_CODE }, { message: 'That code has already been used.', field: 'inviteCode' }],
    ['an existing e-mail', { email: USER.email }, { message: 'An account with this e-mail already exists. Try signing in.', field: 'email' }],
    ['a rejected e-mail', { email: 'nope' }, { message: 'Enter a valid e-mail address.', field: 'email' }],
    ['a rejected password', { password: 'short' }, { message: 'Use 8 to 72 characters for the password.', field: 'password' }],
  ])('maps %s to a friendly message', async (_label, over, expected) => {
    const { createAccount } = await load('@/data/signup');
    connect();
    expect(await createAccount(input(over))).toEqual({ ok: false, ...expected });
  });

  it('tells how long to wait when the function throttles', async () => {
    const { createAccount } = await load('@/data/signup');
    connect();
    for (let i = 0; i < SIGNUP_ATTEMPTS_PER_CLIENT; i++) await createAccount(input({ inviteCode: 'ZZZZ-ZZZZ-ZZZZ' }));
    expect(await createAccount(input())).toEqual({ ok: false, message: 'Too many attempts. Try again in 10 minutes.' });
  });

  it('degrades gracefully when the request never gets an answer', async () => {
    const { createAccount } = await load('@/data/signup');
    const { network, backend } = connect();
    network.offline = true;
    expect(await createAccount(input())).toEqual({ ok: false, message: 'Could not reach the server. Check your connection and try again.' });
    expect(backend.calls).toHaveLength(0);
  });
});
