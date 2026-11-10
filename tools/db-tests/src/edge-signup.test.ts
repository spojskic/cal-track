import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseLike } from '../../../supabase/functions/_shared/food-store.ts';
import { handleHttp, type ApiResult } from '../../../supabase/functions/_shared/http.ts';
import {
  GLOBAL_RATE_LIMIT_USER,
  makeConsumeRateLimit,
} from '../../../supabase/functions/_shared/rate-limit.ts';
import {
  DEFAULT_SIGNUP_LIMITS,
  SIGNUP_CLIENT_BUCKET,
  SIGNUP_GLOBAL_BUCKET,
  addressBucket,
  clientAddress,
  clientKeyFromRequest,
  normalizeInviteCode,
  parseSignUpRequest,
  signUp,
  type CreateUserOutcome,
  type InviteOutcome,
  type SignUpDeps,
} from '../../../supabase/functions/_shared/signup.ts';
import {
  classifyCreateUserError,
  makeCreateUser,
  makeInviteStore,
  type AdminAuthLike,
} from '../../../supabase/functions/_shared/signup-store.ts';
import { asService, createDb } from './harness';

const PASSWORD = 'Sup3r-Secret-pw';
const CODE = 'K7M2-9QXA-F3TW';
const EMAIL = 'Anna.Example@Example.com';
const IP = '203.0.113.77';
const CLIENT = '11111111-2222-4333-8444-555555555555';

const GOOD_BODY = { email: EMAIL, password: PASSWORD, inviteCode: CODE };

// ---------------------------------------------------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------------------------------------------------

function setup(
  over: Partial<SignUpDeps> & {
    waits?: number[];
    invite?: InviteOutcome;
    created?: CreateUserOutcome;
  } = {},
) {
  const logs: string[] = [];
  const waits = [...(over.waits ?? [])];
  const consumeRateLimit = vi.fn(async (..._args: unknown[]) => waits.shift() ?? 0);
  const consumeInvite = vi.fn(async (_code: string): Promise<InviteOutcome> => over.invite ?? 'ok');
  const releaseInvite = vi.fn(async (_code: string) => {});
  const createUser = vi.fn(
    async (_email: string, _password: string): Promise<CreateUserOutcome> =>
      over.created ?? { kind: 'created' },
  );
  const deps: SignUpDeps = {
    consumeRateLimit,
    consumeInvite,
    releaseInvite,
    createUser,
    clientKey: CLIENT,
    log: (message, detail) =>
      logs.push(`${message} ${typeof detail === 'string' ? detail : JSON.stringify(detail ?? '')}`),
    ...over,
  };
  return { deps, logs, consumeRateLimit, consumeInvite, releaseInvite, createUser };
}

const isApiResult = (v: unknown): v is ApiResult =>
  typeof v === 'object' && v !== null && 'status' in v;

const post = (body: unknown, headers: Record<string, string> = {}, method = 'POST') =>
  new Request('https://abc.supabase.co/functions/v1/sign-up', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });

// ---------------------------------------------------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------------------------------------------------

describe('parseSignUpRequest', () => {
  it('accepts a good body, trims and lower-cases the e-mail and keeps the code as typed (trimmed)', () => {
    expect(
      parseSignUpRequest({
        email: `  ${EMAIL} `,
        password: PASSWORD,
        inviteCode: `  ${CODE.toLowerCase()} `,
      }),
    ).toEqual({
      email: 'anna.example@example.com',
      password: PASSWORD,
      inviteCode: CODE.toLowerCase(),
    });
  });

  it('keeps the password exactly as typed (no trimming)', () => {
    const parsed = parseSignUpRequest({ ...GOOD_BODY, password: '  spaced pw  ' });
    expect(parsed).toMatchObject({ password: '  spaced pw  ' });
  });

  it.each([
    ['no body', null, 'invalid_request'],
    ['an array', [], 'invalid_request'],
    ['a string body', 'hi', 'invalid_request'],
    ['missing e-mail', { password: PASSWORD, inviteCode: CODE }, 'invalid_email'],
    ['numeric e-mail', { ...GOOD_BODY, email: 5 }, 'invalid_email'],
    ['blank e-mail', { ...GOOD_BODY, email: '   ' }, 'invalid_email'],
    ['e-mail without @', { ...GOOD_BODY, email: 'anna.example.com' }, 'invalid_email'],
    ['e-mail without a domain dot', { ...GOOD_BODY, email: 'anna@example' }, 'invalid_email'],
    ['e-mail with a space', { ...GOOD_BODY, email: 'an na@example.com' }, 'invalid_email'],
    ['e-mail with two @', { ...GOOD_BODY, email: 'a@b@example.com' }, 'invalid_email'],
    [
      'e-mail over 254 characters',
      { ...GOOD_BODY, email: `${'a'.repeat(247)}@abc.com` },
      'invalid_email',
    ],
    ['missing password', { email: EMAIL, inviteCode: CODE }, 'invalid_password'],
    ['numeric password', { ...GOOD_BODY, password: 12345678 }, 'invalid_password'],
    ['7 character password', { ...GOOD_BODY, password: '1234567' }, 'invalid_password'],
    ['73 character password', { ...GOOD_BODY, password: 'p'.repeat(73) }, 'invalid_password'],
    // bcrypt works on bytes: 37 two-byte characters are 74 bytes although only 37 characters long
    ['password over 72 bytes', { ...GOOD_BODY, password: 'ć'.repeat(37) }, 'invalid_password'],
    ['missing code', { email: EMAIL, password: PASSWORD }, 'invalid_invite_code'],
    ['non-string code', { ...GOOD_BODY, inviteCode: 123456789012 }, 'invalid_invite_code'],
    ['blank code', { ...GOOD_BODY, inviteCode: '   ' }, 'invalid_invite_code'],
    ['code of only separators', { ...GOOD_BODY, inviteCode: '- - -' }, 'invalid_invite_code'],
    [
      'code over 32 characters',
      { ...GOOD_BODY, inviteCode: 'A'.repeat(33) },
      'invalid_invite_code',
    ],
  ])('400 for %s', (_label, body, error) => {
    const parsed = parseSignUpRequest(body);
    expect(isApiResult(parsed)).toBe(true);
    expect(parsed).toMatchObject({ status: 400, body: { error, message: expect.any(String) } });
  });

  it('accepts the boundaries: 8 and 72-byte passwords, 254 character e-mail, 32 character code', () => {
    const email = `${'a'.repeat(242)}@abc.com`; // 242 + 1 + 7 = 250
    expect(email.length).toBeLessThanOrEqual(254);
    expect(isApiResult(parseSignUpRequest({ ...GOOD_BODY, email, password: '12345678' }))).toBe(
      false,
    );
    expect(isApiResult(parseSignUpRequest({ ...GOOD_BODY, password: 'p'.repeat(72) }))).toBe(false);
    expect(isApiResult(parseSignUpRequest({ ...GOOD_BODY, password: 'ć'.repeat(36) }))).toBe(false);
    expect(isApiResult(parseSignUpRequest({ ...GOOD_BODY, inviteCode: 'A'.repeat(32) }))).toBe(
      false,
    );
    expect(
      isApiResult(
        parseSignUpRequest({ ...GOOD_BODY, email: `${'a'.repeat(64)}@${'b'.repeat(185)}.com` }),
      ),
    ).toBe(false); // exactly 254
  });

  it('normalizeInviteCode drops everything but letters and digits and upper-cases', () => {
    expect(normalizeInviteCode(' k7m2-9qxa f3tw ')).toBe('K7M29QXAF3TW');
    expect(normalizeInviteCode('--')).toBe('');
  });
});

describe('signUp: validation happens before throttling and before any database access', () => {
  it.each([
    [{ ...GOOD_BODY, email: 'nope' }],
    [{ ...GOOD_BODY, password: 'short' }],
    [{ ...GOOD_BODY, inviteCode: '' }],
    [null],
  ])('400 for %j without touching the limiter, the code table or auth', async (body) => {
    const t = setup();
    const res = await signUp(body, t.deps);
    expect(res.status).toBe(400);
    expect(t.consumeRateLimit).not.toHaveBeenCalled();
    expect(t.consumeInvite).not.toHaveBeenCalled();
    expect(t.createUser).not.toHaveBeenCalled();
    expect(t.releaseInvite).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Throttling
// ---------------------------------------------------------------------------------------------------------------------

describe('signUp: throttling', () => {
  it('uses 5 attempts per client and 20 over everybody per 10 minutes by default', () => {
    expect(DEFAULT_SIGNUP_LIMITS).toEqual({ perClient: 5, global: 20, windowSeconds: 600 });
  });

  it('consumes the client bucket first, then the global one, before the code table is touched', async () => {
    const order: string[] = [];
    const t = setup();
    t.consumeRateLimit.mockImplementation(async (_user, bucket) => {
      order.push(`limit:${String(bucket)}`);
      return 0;
    });
    t.consumeInvite.mockImplementation(async () => {
      order.push('consume');
      return 'ok';
    });
    t.createUser.mockImplementation(async () => {
      order.push('create');
      return { kind: 'created' };
    });
    expect((await signUp(GOOD_BODY, t.deps)).status).toBe(201);
    expect(order).toEqual([
      `limit:${SIGNUP_CLIENT_BUCKET}`,
      `limit:${SIGNUP_GLOBAL_BUCKET}`,
      'consume',
      'create',
    ]);
    expect(t.consumeRateLimit.mock.calls).toEqual([
      [CLIENT, 'sign-up-client', 5, 600],
      [GLOBAL_RATE_LIMIT_USER, 'sign-up-global', 20, 600],
    ]);
  });

  it('429 with retryAfterSeconds (body and Retry-After header) when the client is over its budget; the global budget is not spent', async () => {
    const t = setup({ waits: [37] });
    const res = await signUp(GOOD_BODY, t.deps);
    expect(res).toMatchObject({
      status: 429,
      body: { error: 'rate_limited', retryAfterSeconds: 37, scope: 'client' },
      headers: { 'Retry-After': '37' },
    });
    expect(t.consumeRateLimit).toHaveBeenCalledTimes(1);
    expect(t.consumeInvite).not.toHaveBeenCalled();
    expect(t.createUser).not.toHaveBeenCalled();
  });

  it('429 when the global budget is spent, without touching the code table', async () => {
    const t = setup({ waits: [0, 410] });
    const res = await signUp(GOOD_BODY, t.deps);
    expect(res).toMatchObject({
      status: 429,
      body: { error: 'rate_limited', retryAfterSeconds: 410, scope: 'global' },
      headers: { 'Retry-After': '410' },
    });
    expect(t.consumeInvite).not.toHaveBeenCalled();
    expect(t.createUser).not.toHaveBeenCalled();
  });

  it('honours custom limits', async () => {
    const t = setup({ limits: { perClient: 2, global: 3, windowSeconds: 60 } });
    await signUp(GOOD_BODY, t.deps);
    expect(t.consumeRateLimit.mock.calls).toEqual([
      [CLIENT, 'sign-up-client', 2, 60],
      [GLOBAL_RATE_LIMIT_USER, 'sign-up-global', 3, 60],
    ]);
  });

  it('fails closed: a limiter error propagates (the HTTP wrapper turns it into a 500) and nothing else runs', async () => {
    const t = setup();
    t.consumeRateLimit.mockRejectedValue(new Error('db down'));
    await expect(signUp(GOOD_BODY, t.deps)).rejects.toThrow('db down');
    expect(t.consumeInvite).not.toHaveBeenCalled();
    expect(t.createUser).not.toHaveBeenCalled();
  });

  it('a throwing code table propagates without creating a user', async () => {
    const t = setup();
    t.consumeInvite.mockRejectedValue(new Error('db down'));
    await expect(signUp(GOOD_BODY, t.deps)).rejects.toThrow('db down');
    expect(t.createUser).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------------------------------

describe('signUp: outcomes', () => {
  it('201 { ok: true } creates the user with the normalised e-mail, keeps the code consumed', async () => {
    const t = setup();
    const res = await signUp(GOOD_BODY, t.deps);
    expect(res).toEqual({ status: 201, body: { ok: true } });
    expect(t.consumeInvite).toHaveBeenCalledWith(CODE);
    expect(t.createUser).toHaveBeenCalledWith('anna.example@example.com', PASSWORD);
    expect(t.releaseInvite).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid', 'invite_invalid', 'That invite code is not valid.'],
    ['revoked', 'invite_revoked', 'That invite code is no longer valid.'],
    ['expired', 'invite_expired', 'That invite code has expired.'],
    ['used_up', 'invite_used_up', 'That invite code has already been used.'],
  ] as const)(
    '403 %s -> %s, no user is created and nothing is released',
    async (invite, error, message) => {
      const t = setup({ invite });
      const res = await signUp(GOOD_BODY, t.deps);
      expect(res).toEqual({ status: 403, body: { error, message } });
      expect(t.createUser).not.toHaveBeenCalled();
      expect(t.releaseInvite).not.toHaveBeenCalled();
    },
  );

  it('an unknown code and a malformed one get the same answer (no extra detail to enumerate with)', async () => {
    const a = await signUp(
      { ...GOOD_BODY, inviteCode: 'ZZZZ-ZZZZ-ZZZZ' },
      setup({ invite: 'invalid' }).deps,
    );
    const b = await signUp({ ...GOOD_BODY, inviteCode: 'x' }, setup({ invite: 'invalid' }).deps);
    expect(a).toEqual(b);
  });

  it('409 email_taken releases the code', async () => {
    const t = setup({ created: { kind: 'email_taken' } });
    const res = await signUp(GOOD_BODY, t.deps);
    expect(res).toMatchObject({
      status: 409,
      body: { error: 'email_taken', message: expect.any(String) },
    });
    expect(t.releaseInvite).toHaveBeenCalledExactlyOnceWith(CODE);
  });

  it.each([
    [{ kind: 'invalid_email' }, 'invalid_email'],
    [{ kind: 'invalid_password' }, 'invalid_password'],
  ] as const)('400 %j (rejected by the auth server) releases the code', async (created, error) => {
    const t = setup({ created });
    const res = await signUp(GOOD_BODY, t.deps);
    expect(res).toMatchObject({ status: 400, body: { error } });
    expect(t.releaseInvite).toHaveBeenCalledExactlyOnceWith(CODE);
  });

  it('500 internal_error for any other failure, and the code is released', async () => {
    const t = setup({ created: { kind: 'error', reason: 'status_500' } });
    const res = await signUp(GOOD_BODY, t.deps);
    expect(res).toMatchObject({ status: 500, body: { error: 'internal_error' } });
    expect(t.releaseInvite).toHaveBeenCalledExactlyOnceWith(CODE);
    expect(t.logs).toContain('outcome create_failed:status_500');
  });

  it('500 and release when createUser throws', async () => {
    const t = setup();
    t.createUser.mockRejectedValue(new TypeError('fetch failed for anna.example@example.com'));
    const res = await signUp(GOOD_BODY, t.deps);
    expect(res).toMatchObject({ status: 500, body: { error: 'internal_error' } });
    expect(t.releaseInvite).toHaveBeenCalledExactlyOnceWith(CODE);
    // the error NAME is logged, never its message (which can contain the address)
    expect(t.logs).toEqual(['outcome create_failed:TypeError']);
  });

  it('still answers 409 when giving the code back fails, and records that', async () => {
    const t = setup({ created: { kind: 'email_taken' } });
    t.releaseInvite.mockRejectedValue(new Error('db down'));
    const res = await signUp(GOOD_BODY, t.deps);
    expect(res.status).toBe(409);
    expect(t.logs).toEqual(['outcome release_failed', 'outcome email_taken']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// No secrets in logs or responses
// ---------------------------------------------------------------------------------------------------------------------

describe('signUp: secrets', () => {
  const outcomes: Array<{ label: string; over: Parameters<typeof setup>[0] }> = [
    { label: 'created', over: {} },
    { label: 'invalid code', over: { invite: 'invalid' } },
    { label: 'expired', over: { invite: 'expired' } },
    { label: 'used up', over: { invite: 'used_up' } },
    { label: 'revoked', over: { invite: 'revoked' } },
    { label: 'email taken', over: { created: { kind: 'email_taken' } } },
    { label: 'create failed', over: { created: { kind: 'error', reason: 'status_500' } } },
    { label: 'client throttled', over: { waits: [30] } },
    { label: 'global throttled', over: { waits: [0, 30] } },
  ];

  it.each(outcomes)(
    'logs only outcome kinds and never echoes secrets ($label)',
    async ({ over }) => {
      const t = setup(over);
      const res = await signUp(GOOD_BODY, t.deps);
      const everything = JSON.stringify([t.logs, res]);
      for (const secret of [
        PASSWORD,
        CODE,
        normalizeInviteCode(CODE),
        CODE.slice(0, 4),
        'anna',
        'example.com',
        IP,
        CLIENT,
      ]) {
        expect(everything.toLowerCase(), `leaked ${secret}`).not.toContain(secret.toLowerCase());
      }
      expect(t.logs.length).toBeGreaterThan(0);
      for (const line of t.logs) expect(line).toMatch(/^outcome [a-z_:A-Z0-9]+$/);
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// Client key (hashed IP)
// ---------------------------------------------------------------------------------------------------------------------

describe('client key', () => {
  const req = (headers: Record<string, string>) => post({}, headers);
  const key = (headers: Record<string, string>, secret = 'service-role-key') =>
    clientKeyFromRequest(req(headers), secret);

  it('prefers cf-connecting-ip over x-forwarded-for and falls back to the first forwarded entry', () => {
    expect(
      clientAddress(new Headers({ 'cf-connecting-ip': ' 1.2.3.4 ', 'x-forwarded-for': '9.9.9.9' })),
    ).toBe('1.2.3.4');
    expect(clientAddress(new Headers({ 'x-forwarded-for': '5.6.7.8, 10.0.0.1' }))).toBe('5.6.7.8');
    expect(clientAddress(new Headers({ 'x-forwarded-for': '  ' }))).toBeNull();
    expect(clientAddress(new Headers())).toBeNull();
  });

  it('reduces addresses to a canonical bucket (port stripped, IPv6 /64, IPv4-mapped = IPv4)', () => {
    expect(addressBucket('203.0.113.77')).toBe('203.0.113.77');
    expect(addressBucket('203.0.113.77:51234')).toBe('203.0.113.77');
    expect(addressBucket('::ffff:203.0.113.77')).toBe('203.0.113.77');
    expect(addressBucket('2001:DB8:1:2:aaaa:bbbb:cccc:dddd')).toBe('v6:2001:0db8:0001:0002');
    expect(addressBucket('2001:db8:1:2::1')).toBe('v6:2001:0db8:0001:0002');
    expect(addressBucket('[2001:db8:1:2::9]:443')).toBe('v6:2001:0db8:0001:0002');
    expect(addressBucket('2001:db8::')).toBe('v6:2001:0db8:0000:0000');
    expect(addressBucket('::1')).toBe('v6:0000:0000:0000:0000');
    expect(addressBucket('::')).toBe('v6:0000:0000:0000:0000');
    expect(addressBucket(null)).toBe('unknown');
    expect(addressBucket('')).toBe('unknown');
    expect(addressBucket('not an ip')).toBe('other:not an ip');
    expect(addressBucket('1::2::3')).toBe('other:1::2::3');
    expect(addressBucket('1:2:3:4:5:6:7:8:9')).toBe('other:1:2:3:4:5:6:7:8:9');
  });

  it('is a stable UUID that does not contain the address', async () => {
    const a = await key({ 'cf-connecting-ip': IP });
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await key({ 'cf-connecting-ip': IP })).toBe(a);
    expect(a).not.toContain('203');
    expect(a).not.toBe(GLOBAL_RATE_LIMIT_USER);
  });

  it('differs per address and per secret; one IPv6 /64 shares a key; a missing address has its own key', async () => {
    const a = await key({ 'cf-connecting-ip': IP });
    expect(await key({ 'cf-connecting-ip': '203.0.113.78' })).not.toBe(a);
    expect(await key({ 'cf-connecting-ip': IP }, 'another-secret')).not.toBe(a);
    expect(await key({ 'cf-connecting-ip': '2001:db8:1:2::1' })).toBe(
      await key({ 'cf-connecting-ip': '2001:db8:1:2:ffff::5' }),
    );
    expect(await key({ 'cf-connecting-ip': '2001:db8:1:3::1' })).not.toBe(
      await key({ 'cf-connecting-ip': '2001:db8:1:2::1' }),
    );
    const unknown = await key({});
    expect(unknown).not.toBe(a);
    expect(await key({})).toBe(unknown);
  });

  it('is keyed: the same address hashes differently without the secret (no plain SHA-256 of the address)', async () => {
    const plain = new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`${SIGNUP_CLIENT_BUCKET}:${IP}`),
      ),
    );
    const hex = Array.from(plain, (b) => b.toString(16).padStart(2, '0')).join('');
    const k = (await key({ 'cf-connecting-ip': IP })).replace(/-/g, '');
    expect(k.slice(0, 12)).not.toBe(hex.slice(0, 12));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Supabase adapters
// ---------------------------------------------------------------------------------------------------------------------

describe('signup-store', () => {
  const unusedFrom = () => {
    throw new Error('not used');
  };

  it('makeInviteStore calls the RPCs with p_code and validates the answer', async () => {
    const rpc = vi.fn(async (_fn: string, _args?: Record<string, unknown>) => ({
      data: 'expired',
      error: null,
    }));
    const store = makeInviteStore({ rpc, from: unusedFrom } as SupabaseLike);
    expect(await store.consume(CODE)).toBe('expired');
    expect(rpc).toHaveBeenCalledWith('consume_invite_code', { p_code: CODE });
    await store.release(CODE);
    expect(rpc).toHaveBeenLastCalledWith('release_invite_code', { p_code: CODE });
  });

  it('throws StoreError on rpc errors and unexpected answers (so the function fails closed)', async () => {
    const failing = makeInviteStore({
      rpc: async () => ({ data: null, error: { message: 'boom', code: '42501' } }),
      from: unusedFrom,
    } as SupabaseLike);
    await expect(failing.consume(CODE)).rejects.toMatchObject({
      name: 'StoreError',
      code: '42501',
    });
    await expect(failing.release(CODE)).rejects.toMatchObject({ name: 'StoreError' });
    for (const data of [null, 5, 'maybe', { r: 'ok' }]) {
      const odd = makeInviteStore({
        rpc: async () => ({ data, error: null }),
        from: unusedFrom,
      } as SupabaseLike);
      await expect(odd.consume(CODE)).rejects.toMatchObject({ name: 'StoreError' });
    }
  });

  it.each([
    [
      {
        code: 'email_exists',
        status: 422,
        message: 'A user with this email address has already been registered',
      },
      { kind: 'email_taken' },
    ],
    [{ code: 'user_already_exists', status: 422 }, { kind: 'email_taken' }],
    [{ message: 'User already registered', status: 400 }, { kind: 'email_taken' }],
    [
      { message: 'A user with this email address has already been registered' },
      { kind: 'email_taken' },
    ],
    [
      { code: 'weak_password', status: 422, message: 'Password should be at least 8 characters' },
      { kind: 'invalid_password' },
    ],
    [
      { code: 'email_address_invalid', status: 400, message: 'Email address "x" is invalid' },
      { kind: 'invalid_email' },
    ],
    [
      { code: 'unexpected_failure', status: 500, message: 'Database error creating new user' },
      { kind: 'error', reason: 'unexpected_failure' },
    ],
    [
      { status: 502, message: 'bad gateway for anna@example.com' },
      { kind: 'error', reason: 'status_502' },
    ],
    [
      { code: 'Some Odd Code!', message: 'weird' },
      { kind: 'error', reason: 'unknown' },
    ],
    [{}, { kind: 'error', reason: 'unknown' }],
  ])('classifies the auth error %j', (error, outcome) => {
    expect(classifyCreateUserError(error)).toEqual(outcome);
  });

  it('never puts the error message of an unknown failure into the reason', () => {
    const outcome = classifyCreateUserError({ status: 500, message: `db error for ${EMAIL}` });
    expect(JSON.stringify(outcome)).not.toContain('anna');
  });

  it('makeCreateUser creates a pre-confirmed user through auth.admin and maps the answer', async () => {
    const createUser = vi.fn(
      async (_attrs: { email: string; password: string; email_confirm: boolean }) => ({
        data: { user: { id: 'u1' } } as unknown,
        error: null as { message?: string; code?: string; status?: number } | null,
      }),
    );
    const client: { auth: AdminAuthLike } = { auth: { admin: { createUser } } };
    const create = makeCreateUser(client);

    expect(await create('a@b.co', 'password1')).toEqual({ kind: 'created' });
    expect(createUser).toHaveBeenCalledWith({
      email: 'a@b.co',
      password: 'password1',
      email_confirm: true,
    });

    createUser.mockResolvedValueOnce({ data: null, error: { code: 'email_exists', status: 422 } });
    expect(await create('a@b.co', 'password1')).toEqual({ kind: 'email_taken' });

    createUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    expect(await create('a@b.co', 'password1')).toEqual({ kind: 'error', reason: 'no_user' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// HTTP wrapper (CORS, methods, bad JSON) around the real handler
// ---------------------------------------------------------------------------------------------------------------------

describe('HTTP wiring', () => {
  const handle = (req: Request, over: Parameters<typeof setup>[0] = {}) => {
    const t = setup(over);
    const quiet = vi.fn();
    return {
      t,
      quiet,
      res: handleHttp(req, (body) => signUp(body, t.deps), quiet),
    };
  };

  it('answers the CORS preflight of the browser without running anything', async () => {
    const { res, t } = handle(
      new Request('https://abc.supabase.co/functions/v1/sign-up', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization, apikey, content-type, x-client-info',
        },
      }),
    );
    const r = await res;
    expect(r.status).toBe(204);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(r.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(r.headers.get('Access-Control-Allow-Headers')).toBe(
      'authorization, apikey, content-type, x-client-info',
    );
    expect(t.consumeRateLimit).not.toHaveBeenCalled();
  });

  it('201 / 403 / 409 / 429 / 400 all carry JSON and CORS headers', async () => {
    const cases: Array<[Parameters<typeof setup>[0], number, string | undefined]> = [
      [{}, 201, undefined],
      [{ invite: 'expired' }, 403, 'invite_expired'],
      [{ created: { kind: 'email_taken' } }, 409, 'email_taken'],
      [{ waits: [12] }, 429, 'rate_limited'],
    ];
    for (const [over, status, error] of cases) {
      const r = await handle(post(GOOD_BODY), over).res;
      expect(r.status).toBe(status);
      expect(r.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(r.headers.get('Content-Type')).toContain('application/json');
      expect(r.headers.get('Cache-Control')).toBe('no-store');
      const body = (await r.json()) as Record<string, unknown>;
      if (error) expect(body.error).toBe(error);
      else expect(body).toEqual({ ok: true });
    }
    const limited = await handle(post(GOOD_BODY), { waits: [12] }).res;
    expect(limited.headers.get('Retry-After')).toBe('12');
    const bad = await handle(post({ ...GOOD_BODY, password: 'x' })).res;
    expect(bad.status).toBe(400);
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('405 for GET, 400 for invalid JSON, and a 500 with CORS (and a log) for an unexpected error', async () => {
    expect((await handle(post(null, {}, 'GET')).res).status).toBe(405);
    expect((await handle(post('{not json')).res).status).toBe(400);

    const t = setup();
    t.consumeRateLimit.mockRejectedValue(new Error('db down'));
    const quiet = vi.fn();
    const r = await handleHttp(post(GOOD_BODY), (body) => signUp(body, t.deps), quiet);
    expect(r.status).toBe(500);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await r.json()).toMatchObject({ error: 'internal_error' });
    expect(quiet).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The whole flow against the real migrations in PGlite
// ---------------------------------------------------------------------------------------------------------------------

/** A Supabase-like client whose rpc() runs the REAL migration functions in PGlite as service_role. */
function pgliteAdmin(db: PGlite): SupabaseLike {
  return {
    rpc(fn, args = {}) {
      return (async () => {
        const names = Object.keys(args);
        const placeholders = names.map((n, i) => `${n} => $${i + 1}`).join(', ');
        try {
          const r = await asService(db, () =>
            db.query<Record<string, unknown>>(
              `select * from public.${fn}(${placeholders})`,
              names.map((n) => args[n]),
            ),
          );
          return { data: r.rows[0]?.[fn] ?? null, error: null };
        } catch (err) {
          const e = err as Error & { code?: string };
          return { data: null, error: { message: e.message, code: e.code } };
        }
      })();
    },
    from() {
      throw new Error('not used by sign-up');
    },
  } as SupabaseLike;
}

describe('sign-up against the real migrations', () => {
  let db: PGlite;
  let admin: SupabaseLike;
  let logs: string[];

  /** auth.admin.createUser stand-in: inserts into auth.users (which fires handle_new_user) like GoTrue would. */
  const fakeAuth = (): { auth: AdminAuthLike } => ({
    auth: {
      admin: {
        async createUser({ email }) {
          const existing = await db.query(
            'select 1 from auth.users where lower(email) = lower($1)',
            [email],
          );
          if (existing.rows.length > 0) {
            return {
              data: null,
              error: { code: 'email_exists', status: 422, message: 'already registered' },
            };
          }
          const r = await db.query<{ id: string }>(
            'insert into auth.users (email) values ($1) returning id',
            [email],
          );
          return { data: { user: { id: r.rows[0]!.id } }, error: null };
        },
      },
    },
  });

  const flow = async (
    body: unknown,
    headers: Record<string, string> = { 'cf-connecting-ip': IP },
    over: Partial<SignUpDeps> = {},
  ) => {
    const invites = makeInviteStore(admin);
    const res = await signUp(body, {
      consumeRateLimit: makeConsumeRateLimit(admin),
      consumeInvite: invites.consume,
      releaseInvite: invites.release,
      createUser: makeCreateUser(fakeAuth()),
      clientKey: await clientKeyFromRequest(post({}, headers), 'service-role-key'),
      log: (message, detail) => logs.push(`${message} ${String(detail ?? '')}`.trim()),
      ...over,
    });
    return res;
  };

  const newCode = async (maxUses = 1, validDays: number | null = 14) =>
    (
      await db.query<{ c: string }>('select public.create_invite_code(null, $1, $2) as c', [
        maxUses,
        validDays,
      ])
    ).rows[0]!.c;

  const usesOf = async (code: string) =>
    (
      await db.query<{ uses: number }>('select uses from private.invite_codes where code = $1', [
        normalizeInviteCode(code),
      ])
    ).rows[0]!.uses;

  beforeAll(async () => {
    db = await createDb();
    admin = pgliteAdmin(db);
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    logs = [];
    await db.exec('delete from private.invite_codes; delete from private.edge_rate_limits;');
  });

  it('creates the account (profile and meal groups via the signup trigger) and spends the code', async () => {
    const code = await newCode();
    const res = await flow({
      email: 'Friend@Example.com',
      password: PASSWORD,
      inviteCode: code.toLowerCase().replace(/-/g, ' '),
    });
    expect(res).toEqual({ status: 201, body: { ok: true } });
    const user = await db.query<{ id: string; email: string }>(
      `select id, email from auth.users where email = 'friend@example.com'`,
    );
    expect(user.rows).toHaveLength(1);
    const profile = await db.query(`select 1 from public.profiles where user_id = $1`, [
      user.rows[0]!.id,
    ]);
    expect(profile.rows).toHaveLength(1);
    expect(
      (await db.query(`select 1 from public.meal_groups where user_id = $1`, [user.rows[0]!.id]))
        .rows,
    ).toHaveLength(4);
    expect(await usesOf(code)).toBe(1);
    expect(logs).toEqual(['outcome created']);
  });

  it('a single-use code works exactly once: the second sign-up is refused as used up and creates nothing', async () => {
    const code = await newCode();
    expect(
      (await flow({ email: 'one@example.com', password: PASSWORD, inviteCode: code })).status,
    ).toBe(201);
    const second = await flow({ email: 'two@example.com', password: PASSWORD, inviteCode: code });
    expect(second).toMatchObject({ status: 403, body: { error: 'invite_used_up' } });
    expect(
      (await db.query(`select 1 from auth.users where email = 'two@example.com'`)).rows,
    ).toEqual([]);
  });

  it('a multi-use code serves its limit', async () => {
    const code = await newCode(2);
    expect(
      (await flow({ email: 'm1@example.com', password: PASSWORD, inviteCode: code })).status,
    ).toBe(201);
    expect(
      (
        await flow(
          { email: 'm2@example.com', password: PASSWORD, inviteCode: code },
          { 'cf-connecting-ip': '198.51.100.2' },
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await flow(
          { email: 'm3@example.com', password: PASSWORD, inviteCode: code },
          { 'cf-connecting-ip': '198.51.100.3' },
        )
      ).status,
    ).toBe(403);
  });

  it('an existing e-mail gets 409 and the code is given back, so the friend can retry with another e-mail', async () => {
    const code = await newCode();
    await db.query(`insert into auth.users (email) values ('taken@example.com')`);
    const res = await flow({ email: 'TAKEN@example.com', password: PASSWORD, inviteCode: code });
    expect(res).toMatchObject({ status: 409, body: { error: 'email_taken' } });
    expect(await usesOf(code)).toBe(0);
    expect(
      (await flow({ email: 'fresh@example.com', password: PASSWORD, inviteCode: code })).status,
    ).toBe(201);
    expect(await usesOf(code)).toBe(1);
  });

  it('any other creation failure releases the code too', async () => {
    const code = await newCode();
    const broken = makeCreateUser({
      auth: {
        admin: {
          createUser: async () => ({
            data: null,
            error: { status: 500, code: 'unexpected_failure', message: 'boom' },
          }),
        },
      },
    });
    const res = await flow(
      { email: 'x@example.com', password: PASSWORD, inviteCode: code },
      undefined,
      { createUser: broken },
    );
    expect(res).toMatchObject({ status: 500, body: { error: 'internal_error' } });
    expect(await usesOf(code)).toBe(0);
  });

  it.each([
    ['unknown', async () => 'ABCD-EFGH-2345', 'invite_invalid'],
    [
      'expired',
      async () => {
        const code = await newCode();
        await db.query(`update private.invite_codes set expires_at = now() - interval '1 minute'`);
        return code;
      },
      'invite_expired',
    ],
    [
      'revoked',
      async () => {
        const code = await newCode();
        await db.query('select public.revoke_invite_code($1)', [code]);
        return code;
      },
      'invite_revoked',
    ],
  ])('403 for a %s code', async (_label, prepare, error) => {
    const inviteCode = await prepare();
    const res = await flow({ email: 'nobody@example.com', password: PASSWORD, inviteCode });
    expect(res).toMatchObject({ status: 403, body: { error } });
    expect(
      (await db.query(`select 1 from auth.users where email = 'nobody@example.com'`)).rows,
    ).toEqual([]);
  });

  it('the 6th attempt of one client within the window is throttled BEFORE the code table is consulted', async () => {
    const code = await newCode(1000);
    const attempt = (n: number) =>
      flow({ email: `u${n}@example.com`, password: PASSWORD, inviteCode: code });
    for (let n = 1; n <= 5; n++) expect((await attempt(n)).status).toBe(201);
    const sixth = await attempt(6);
    expect(sixth).toMatchObject({ status: 429, body: { error: 'rate_limited', scope: 'client' } });
    expect((sixth.body as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(590);
    expect(await usesOf(code)).toBe(5); // the 6th attempt never reached the code
    // another client is not affected
    const other = await flow(
      { email: 'other@example.com', password: PASSWORD, inviteCode: code },
      { 'cf-connecting-ip': '198.51.100.9' },
    );
    expect(other.status).toBe(201);
  });

  it('guessing codes is capped globally: 20 attempts per window over all clients, then everybody waits', async () => {
    await newCode(); // a real code exists; the guesses below never hit it
    let refused = 0;
    for (let n = 0; n < 20; n++) {
      const ip = `198.51.100.${n + 10}`; // a different client every time: only the global bucket can stop them
      const res = await flow(
        { email: 'g@example.com', password: PASSWORD, inviteCode: 'ZZZZ-ZZZZ-ZZZZ' },
        { 'cf-connecting-ip': ip },
      );
      expect(res).toMatchObject({ status: 403, body: { error: 'invite_invalid' } });
      refused++;
    }
    expect(refused).toBe(20);
    const blocked = await flow(
      { email: 'g@example.com', password: PASSWORD, inviteCode: 'ZZZZ-ZZZZ-ZZZZ' },
      { 'cf-connecting-ip': '198.51.100.99' },
    );
    expect(blocked).toMatchObject({
      status: 429,
      body: { error: 'rate_limited', scope: 'global' },
    });
  });

  it('stores only the keyed hash of the client address, never the address', async () => {
    const code = await newCode();
    await flow(
      { email: 'h@example.com', password: PASSWORD, inviteCode: code },
      { 'cf-connecting-ip': IP },
    );
    const limits = await db.query<{ user_id: string; bucket: string; count: number }>(
      'select user_id::text, bucket, count from private.edge_rate_limits order by bucket',
    );
    expect(limits.rows.map((r) => [r.bucket, r.count])).toEqual([
      [SIGNUP_CLIENT_BUCKET, 1],
      [SIGNUP_GLOBAL_BUCKET, 1],
    ]);
    const client = limits.rows.find((r) => r.bucket === SIGNUP_CLIENT_BUCKET)!;
    expect(client.user_id).toBe(
      await clientKeyFromRequest(post({}, { 'cf-connecting-ip': IP }), 'service-role-key'),
    );
    expect(JSON.stringify(limits.rows)).not.toContain('203.0.113');
    expect(limits.rows.find((r) => r.bucket === SIGNUP_GLOBAL_BUCKET)!.user_id).toBe(
      GLOBAL_RATE_LIMIT_USER,
    );
  });
});
