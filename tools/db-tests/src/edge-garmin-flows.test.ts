import type { PGlite } from '@electric-sql/pglite';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseLike } from '../../../supabase/functions/_shared/food-store.ts';
import {
  OAUTH_STATE_TTL_SECONDS,
  disconnectGarmin,
  finishOAuth,
  handleWebhookRequest,
  startOAuth,
  type GarminDeps,
} from '../../../supabase/functions/_shared/garmin-flows.ts';
import { readGarminConfig } from '../../../supabase/functions/_shared/garmin-oauth.ts';
import {
  makeGarminStore,
  type GarminStore,
} from '../../../supabase/functions/_shared/garmin-store.ts';
import { USER_A, USER_B, asService, asUser, createDb, createUsers } from './harness';

// ---------------------------------------------------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------------------------------------------------

const TABLE_RETURNING = new Set([
  'garmin_oauth_state_consume',
  'garmin_connection_get',
  'garmin_connection_status',
]);
const JSON_ARGS = new Set(['p_events', 'p_energy', 'p_exercises', 'p_biometrics']);

/** A Supabase-like client whose rpc() runs the REAL migration functions in PGlite as service_role. */
function pgliteAdmin(db: PGlite): SupabaseLike {
  return {
    rpc(fn, args = {}) {
      return (async () => {
        const names = Object.keys(args);
        const placeholders = names
          .map((n, i) => `${n} => $${i + 1}${JSON_ARGS.has(n) ? '::jsonb' : ''}`)
          .join(', ');
        const params = names.map((n) => (JSON_ARGS.has(n) ? JSON.stringify(args[n]) : args[n]));
        try {
          const r = await asService(db, () =>
            db.query<Record<string, unknown>>(
              `select * from public.${fn}(${placeholders})`,
              params,
            ),
          );
          return {
            data: TABLE_RETURNING.has(fn) ? r.rows : (r.rows[0]?.[fn] ?? null),
            error: null,
          };
        } catch (err) {
          const e = err as Error & { code?: string };
          return { data: null, error: { message: e.message, code: e.code } };
        }
      })();
    },
    from() {
      throw new Error('not used by the Garmin flows');
    },
  } as SupabaseLike;
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

type Handler = (
  call: Call,
) =>
  | { status?: number; json?: unknown; text?: string }
  | Promise<{ status?: number; json?: unknown; text?: string }>;

function fakeFetch(handler: Handler) {
  const calls: Call[] = [];
  const fn = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const call: Call = {
      url: input,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
      body: typeof init.body === 'string' ? init.body : null,
    };
    calls.push(call);
    const r = await handler(call);
    const status = r.status ?? 200;
    // 204 / 205 / 304 must not carry a body
    return new Response(
      [204, 205, 304].includes(status) ? null : (r.text ?? JSON.stringify(r.json ?? {})),
      { status },
    );
  };
  return { fn, calls };
}

const ENV = {
  SUPABASE_URL: 'https://abc.supabase.co',
  GARMIN_CLIENT_ID: 'client-id',
  GARMIN_CLIENT_SECRET: 'client-secret',
  GARMIN_WEBHOOK_SECRET: 'webhook-secret-0123456789',
  APP_URL: 'https://app.example.com',
};
const cfgWith = (extra: Record<string, string | undefined> = {}) =>
  readGarminConfig((name) => ({ ...ENV, ...extra })[name]);

const TOKEN_RESPONSE = {
  access_token: 'ACCESS-TOKEN-1',
  refresh_token: 'REFRESH-TOKEN-1',
  expires_in: 86400,
  scope: 'WELLNESS',
};

// 2026-11-10 00:00:00 UTC
const DAY = Date.UTC(2026, 10, 10) / 1000;

describe('garmin flows against the real migration', () => {
  let db: PGlite;
  let store: GarminStore;
  let logs: string[];

  const deps = (over: Partial<GarminDeps> = {}): GarminDeps => ({
    cfg: cfgWith(),
    store,
    fetch: async () => new Response('{}'),
    log: (message, detail) =>
      logs.push(`${message} ${typeof detail === 'string' ? detail : JSON.stringify(detail ?? '')}`),
    roll: () => 0.99, // no opportunistic purge unless a test asks for it
    ...over,
  });

  const count = async (sql: string, params: unknown[] = []) =>
    (await db.query<{ n: number }>(`select count(*)::int as n from ${sql}`, params)).rows[0]!.n;

  beforeAll(async () => {
    db = await createDb();
    await createUsers(db);
    store = makeGarminStore(pgliteAdmin(db));
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    logs = [];
    await db.exec(`
      delete from private.garmin_connections; delete from private.garmin_oauth_states; delete from private.garmin_push_events;
      delete from public.daily_energy; delete from public.exercise_entries; delete from public.biometrics;`);
  });

  const connect = (userId = USER_A, garminUserId = 'garmin-1', accessToken = 'access-x') =>
    store.saveConnection({
      userId,
      garminUserId,
      accessToken,
      refreshToken: 'refresh-x',
      expiresAt: null,
      refreshExpiresAt: null,
      scopes: [],
    });

  // -------------------------------------------------------------------------------------------------------------------
  describe('garmin-oauth-start', () => {
    it('answers 503 garmin_not_configured until GARMIN_CLIENT_ID is set', async () => {
      const r = await startOAuth(
        {},
        USER_A,
        deps({ cfg: cfgWith({ GARMIN_CLIENT_ID: undefined }) }),
      );
      expect(r.status).toBe(503);
      expect(r.body).toMatchObject({ error: 'garmin_not_configured' });
      expect(await count('private.garmin_oauth_states')).toBe(0);
    });

    it('needs APP_URL for the web surface and a valid platform', async () => {
      const web = await startOAuth(
        { platform: 'web' },
        USER_A,
        deps({ cfg: cfgWith({ APP_URL: undefined }) }),
      );
      expect(web.status).toBe(503);
      expect(web.body).toMatchObject({ error: 'garmin_not_configured' });
      const bad = await startOAuth({ platform: 'desktop' }, USER_A, deps());
      expect(bad.status).toBe(400);
    });

    it('stores verifier + single-use state and returns only the authorize URL', async () => {
      const r = await startOAuth({ platform: 'web' }, USER_A, deps());
      expect(r.status).toBe(200);
      const url = new URL((r.body as { url: string }).url);
      expect(url.origin + url.pathname).toBe('https://apis.garmin.com/tools/oauth2/authorizeUser');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('client_id')).toBe('client-id');

      const rows = await db.query<{
        state: string;
        user_id: string;
        code_verifier: string;
        return_kind: string;
      }>(`select state, user_id, code_verifier, return_kind from private.garmin_oauth_states`);
      expect(rows.rows).toHaveLength(1);
      const row = rows.rows[0]!;
      expect(row).toMatchObject({ user_id: USER_A, return_kind: 'web' });
      expect(url.searchParams.get('state')).toBe(row.state);
      const { createHash } = await import('node:crypto');
      expect(url.searchParams.get('code_challenge')).toBe(
        createHash('sha256').update(row.code_verifier).digest('base64url'),
      );
      expect(JSON.stringify(r.body)).not.toContain(row.code_verifier);
      expect(JSON.stringify(r.body)).not.toContain('client-secret');
    });

    it('is rate limited per user', async () => {
      const limiter = vi.fn(async () => 17);
      const r = await startOAuth({}, USER_A, deps({ consumeRateLimit: limiter }));
      expect(r.status).toBe(429);
      expect(r.headers).toEqual({ 'Retry-After': '17' });
      expect(limiter).toHaveBeenCalledWith(USER_A, 'garmin-start', 10, 60);
      expect(await count('private.garmin_oauth_states')).toBe(0);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('garmin-oauth-callback', () => {
    const begin = async (platform: 'native' | 'web' = 'native', userId = USER_A) => {
      const r = await startOAuth({ platform }, userId, deps());
      const url = new URL((r.body as { url: string }).url);
      return { state: url.searchParams.get('state')! };
    };
    const params = (o: Record<string, string>) => new URLSearchParams(o);
    const garmin = (
      over: Partial<{
        token: { status?: number; json?: unknown };
        id: { status?: number; json?: unknown };
      }> = {},
    ) =>
      fakeFetch((c) => {
        if (c.url.includes('/oauth/token')) return over.token ?? { json: TOKEN_RESPONSE };
        if (c.url.includes('/user/id')) return over.id ?? { json: { userId: 'garmin-1' } };
        return { status: 404 };
      });

    it('exchanges the code with the stored verifier, stores the connection and redirects the native app', async () => {
      const { state } = await begin('native');
      const verifier = (
        await db.query<{ code_verifier: string }>(
          `select code_verifier from private.garmin_oauth_states`,
        )
      ).rows[0]!.code_verifier;
      const g = garmin();
      const r = await finishOAuth(params({ code: 'THE-CODE', state }), deps({ fetch: g.fn }));
      expect(r).toEqual({ redirect: 'caltrack://settings/integrations?garmin=connected' });

      const token = g.calls[0]!;
      expect(token.method).toBe('POST');
      expect(Object.fromEntries(new URLSearchParams(token.body!))).toMatchObject({
        grant_type: 'authorization_code',
        code: 'THE-CODE',
        code_verifier: verifier,
        client_id: 'client-id',
        client_secret: 'client-secret',
        redirect_uri: 'https://abc.supabase.co/functions/v1/garmin-oauth-callback',
      });
      const idCall = g.calls[1]!;
      expect(idCall.method).toBe('GET');
      expect(idCall.headers.Authorization).toBe('Bearer ACCESS-TOKEN-1');

      const stored = await store.getConnection({ userId: USER_A });
      expect(stored).toMatchObject({
        garminUserId: 'garmin-1',
        accessToken: 'ACCESS-TOKEN-1',
        refreshToken: 'REFRESH-TOKEN-1',
      });
      expect(await count('private.garmin_oauth_states')).toBe(0);
      // the status RPC the app calls says "connected" without exposing tokens
      const status = await asUser(db, USER_A, () =>
        db.query(`select * from public.garmin_connection_status()`),
      );
      expect(status.rows[0]).toMatchObject({ connected: true, last_error: null });
    });

    it('returns web users to APP_URL and keeps the state single use', async () => {
      const { state } = await begin('web');
      const g = garmin();
      const r = await finishOAuth(params({ code: 'c', state }), deps({ fetch: g.fn }));
      expect(r).toEqual({
        redirect: 'https://app.example.com/settings/integrations?garmin=connected',
      });
      const replay = await finishOAuth(params({ code: 'c', state }), deps({ fetch: g.fn }));
      expect(replay).toMatchObject({ status: 400 });
      expect(g.calls).toHaveLength(2); // the replay never reached Garmin
    });

    it('rejects an unknown, missing or expired state without calling Garmin', async () => {
      const g = garmin();
      expect(
        await finishOAuth(params({ code: 'c', state: 'x'.repeat(32) }), deps({ fetch: g.fn })),
      ).toMatchObject({ status: 400 });
      expect(await finishOAuth(params({ code: 'c' }), deps({ fetch: g.fn }))).toMatchObject({
        status: 400,
      });
      const { state } = await begin();
      await db.query(
        `update private.garmin_oauth_states set created_at = now() - make_interval(secs => $1)`,
        [OAUTH_STATE_TTL_SECONDS + 5],
      );
      expect(await finishOAuth(params({ code: 'c', state }), deps({ fetch: g.fn }))).toMatchObject({
        status: 400,
      });
      expect(g.calls).toHaveLength(0);
      expect(await store.getConnection({ userId: USER_A })).toBeNull();
    });

    it('handles the user denying access, a missing code and missing server secrets', async () => {
      const g = garmin();
      let { state } = await begin();
      expect(
        await finishOAuth(params({ error: 'access_denied', state }), deps({ fetch: g.fn })),
      ).toEqual({
        redirect: 'caltrack://settings/integrations?garmin=error&reason=access_denied',
      });
      ({ state } = await begin());
      expect(
        await finishOAuth(params({ error: 'server_error', state }), deps({ fetch: g.fn })),
      ).toEqual({
        redirect: 'caltrack://settings/integrations?garmin=error&reason=authorization_failed',
      });
      ({ state } = await begin());
      expect(await finishOAuth(params({ state }), deps({ fetch: g.fn }))).toEqual({
        redirect: 'caltrack://settings/integrations?garmin=error&reason=missing_code',
      });
      ({ state } = await begin());
      expect(
        await finishOAuth(
          params({ code: 'c', state }),
          deps({ fetch: g.fn, cfg: cfgWith({ GARMIN_CLIENT_SECRET: undefined }) }),
        ),
      ).toEqual({
        redirect: 'caltrack://settings/integrations?garmin=error&reason=not_configured',
      });
      expect(g.calls).toHaveLength(0);
      expect(await count('private.garmin_connections')).toBe(0);
    });

    it('reports a failed token exchange or user-id lookup and stores nothing', async () => {
      let { state } = await begin();
      const failedToken = garmin({ token: { status: 400, json: { error: 'invalid_grant' } } });
      expect(
        await finishOAuth(params({ code: 'c', state }), deps({ fetch: failedToken.fn })),
      ).toEqual({
        redirect: 'caltrack://settings/integrations?garmin=error&reason=token_exchange_failed',
      });
      ({ state } = await begin());
      const garbage = garmin({ token: { json: { nope: true } } });
      expect(await finishOAuth(params({ code: 'c', state }), deps({ fetch: garbage.fn }))).toEqual({
        redirect: 'caltrack://settings/integrations?garmin=error&reason=token_response_invalid',
      });
      ({ state } = await begin());
      const noId = garmin({ id: { status: 500 } });
      expect(await finishOAuth(params({ code: 'c', state }), deps({ fetch: noId.fn }))).toEqual({
        redirect: 'caltrack://settings/integrations?garmin=error&reason=user_id_failed',
      });
      expect(await count('private.garmin_connections')).toBe(0);
    });

    it('refuses a Garmin account that is already linked to another user', async () => {
      await connect(USER_B, 'garmin-1');
      const { state } = await begin('native', USER_A);
      const g = garmin();
      expect(await finishOAuth(params({ code: 'c', state }), deps({ fetch: g.fn }))).toEqual({
        redirect: 'caltrack://settings/integrations?garmin=error&reason=account_already_linked',
      });
      expect((await store.getConnection({ userId: USER_B }))?.garminUserId).toBe('garmin-1');
      expect(await store.getConnection({ userId: USER_A })).toBeNull();
    });

    it('never writes the code, verifier, tokens or secrets to the log', async () => {
      let { state } = await begin();
      const verifier = (
        await db.query<{ code_verifier: string }>(
          `select code_verifier from private.garmin_oauth_states`,
        )
      ).rows[0]!.code_verifier;
      await finishOAuth(
        params({ code: 'SECRET-CODE', state }),
        deps({ fetch: garmin({ token: { status: 400, json: { error: 'x' } } }).fn }),
      );
      ({ state } = await begin());
      await finishOAuth(
        params({ code: 'SECRET-CODE-2', state }),
        deps({ fetch: garmin({ id: { status: 500 } }).fn }),
      );
      await connect(USER_B, 'garmin-1');
      ({ state } = await begin());
      await finishOAuth(params({ code: 'SECRET-CODE-3', state }), deps({ fetch: garmin().fn }));
      const all = logs.join('\n');
      expect(logs.length).toBeGreaterThan(0);
      for (const secret of [
        'SECRET-CODE',
        verifier,
        'ACCESS-TOKEN-1',
        'REFRESH-TOKEN-1',
        'client-secret',
        state,
      ]) {
        expect(all).not.toContain(secret);
      }
    });

    it('is rate limited globally', async () => {
      const r = await finishOAuth(
        params({ code: 'c', state: 's'.repeat(32) }),
        deps({ consumeRateLimit: async () => 9 }),
      );
      expect(r).toMatchObject({ status: 429 });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('garmin-disconnect', () => {
    it('deregisters at Garmin with the access token and deletes the connection', async () => {
      await connect(USER_A, 'garmin-1', 'ACCESS-A');
      const g = fakeFetch(() => ({ status: 204 }));
      const r = await disconnectGarmin({}, USER_A, deps({ fetch: g.fn }));
      expect(r).toMatchObject({ status: 200, body: { ok: true, deregistered: true } });
      expect(g.calls).toHaveLength(1);
      expect(g.calls[0]).toMatchObject({
        method: 'DELETE',
        url: 'https://apis.garmin.com/wellness-api/rest/user/registration',
      });
      expect(g.calls[0]!.headers.Authorization).toBe('Bearer ACCESS-A');
      expect(await store.getConnection({ userId: USER_A })).toBeNull();
    });

    it('deletes the connection even when Garmin fails or is unreachable', async () => {
      await connect(USER_A);
      const failing = fakeFetch(() => ({ status: 500 }));
      expect(await disconnectGarmin({}, USER_A, deps({ fetch: failing.fn }))).toMatchObject({
        body: { ok: true, deregistered: false },
      });
      expect(await store.getConnection({ userId: USER_A })).toBeNull();

      await connect(USER_A);
      const down = async (): Promise<Response> => {
        throw new Error('network down');
      };
      expect(await disconnectGarmin({}, USER_A, deps({ fetch: down }))).toMatchObject({
        body: { ok: true, deregistered: false },
      });
      expect(await store.getConnection({ userId: USER_A })).toBeNull();
    });

    it('refreshes an expired token once and retries the deregistration', async () => {
      await connect(USER_A, 'garmin-1', 'OLD-ACCESS');
      const g = fakeFetch((c) => {
        if (c.url.includes('/oauth/token'))
          return { json: { access_token: 'NEW-ACCESS', refresh_token: 'r2' } };
        return { status: c.headers.Authorization === 'Bearer NEW-ACCESS' ? 200 : 401 };
      });
      const r = await disconnectGarmin({}, USER_A, deps({ fetch: g.fn }));
      expect(r).toMatchObject({ body: { ok: true, deregistered: true } });
      expect(g.calls.map((c) => c.method + ' ' + new URL(c.url).pathname)).toEqual([
        'DELETE /wellness-api/rest/user/registration',
        'POST /di-oauth2-service/oauth/token',
        'DELETE /wellness-api/rest/user/registration',
      ]);
      expect(new URLSearchParams(g.calls[1]!.body!).get('grant_type')).toBe('refresh_token');
    });

    it('is idempotent without a connection and honours deleteData', async () => {
      const g = fakeFetch(() => ({ status: 204 }));
      expect(await disconnectGarmin({}, USER_A, deps({ fetch: g.fn }))).toMatchObject({
        body: { ok: true, deregistered: false },
      });
      expect(g.calls).toHaveLength(0);

      await connect(USER_A);
      await db.query(
        `insert into public.daily_energy (user_id, local_date, source, active_kcal) values ($1, '2026-11-09', 'garmin', 5), ($1, '2026-11-09', 'apple_health', 6)`,
        [USER_A],
      );
      await disconnectGarmin({ deleteData: false }, USER_A, deps({ fetch: g.fn }));
      expect(await count('public.daily_energy')).toBe(2);
      await connect(USER_A);
      await disconnectGarmin({ deleteData: true }, USER_A, deps({ fetch: g.fn }));
      expect(
        (await db.query<{ source: string }>(`select source from public.daily_energy`)).rows,
      ).toEqual([{ source: 'apple_health' }]);
    });

    it('is rate limited per user', async () => {
      await connect(USER_A);
      const r = await disconnectGarmin({}, USER_A, deps({ consumeRateLimit: async () => 5 }));
      expect(r.status).toBe(429);
      expect(await store.getConnection({ userId: USER_A })).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('garmin-webhook', () => {
    const SECRET = ENV.GARMIN_WEBHOOK_SECRET;
    const push = (
      body: unknown,
      opts: { headers?: Record<string, string>; url?: string; raw?: string | Uint8Array } = {},
    ) =>
      new Request(opts.url ?? 'https://abc.supabase.co/functions/v1/garmin-webhook', {
        method: 'POST',
        headers: {
          'x-garmin-webhook-secret': SECRET,
          'content-type': 'application/json',
          ...opts.headers,
        },
        body: opts.raw ?? JSON.stringify(body),
        duplex: 'half',
      } as RequestInit);

    const dailies = (over: Record<string, unknown> = {}) => ({
      userId: 'garmin-1',
      summaryId: 'sum-d',
      calendarDate: '2026-11-10',
      startTimeInSeconds: DAY,
      startTimeOffsetInSeconds: 3600,
      durationInSeconds: 43_200,
      steps: 4210,
      activeKilocalories: 321,
      bmrKilocalories: 801,
      restingHeartRateInBeatsPerMinute: 58,
      averageStressLevel: 34,
      ...over,
    });
    const energy = async () =>
      (
        await db.query<{
          active_kcal: number | null;
          resting_kcal: number | null;
          steps: number | null;
        }>(
          `select active_kcal::float8 as active_kcal, resting_kcal::float8 as resting_kcal, steps from public.daily_energy
           where user_id = $1 and local_date = '2026-11-10' and source = 'garmin'`,
          [USER_A],
        )
      ).rows;

    describe('authentication and transport', () => {
      it('only accepts POST', async () => {
        const r = await handleWebhookRequest(new Request('https://x/f', { method: 'GET' }), deps());
        expect(r.status).toBe(405);
      });

      it('is closed (503) while no usable webhook secret is configured', async () => {
        for (const secret of [undefined, 'short']) {
          const r = await handleWebhookRequest(
            push({ dailies: [] }),
            deps({ cfg: cfgWith({ GARMIN_WEBHOOK_SECRET: secret }) }),
          );
          expect(r.status).toBe(503);
          expect(r.body).toMatchObject({ error: 'garmin_not_configured' });
        }
      });

      it('rejects a missing or wrong secret with 401 and stores nothing', async () => {
        await connect();
        const wrong = await handleWebhookRequest(
          push({ dailies: [dailies()] }, { headers: { 'x-garmin-webhook-secret': 'nope' } }),
          deps(),
        );
        expect(wrong.status).toBe(401);
        const none = new Request('https://x/f', {
          method: 'POST',
          body: JSON.stringify({ dailies: [dailies()] }),
        });
        expect((await handleWebhookRequest(none, deps())).status).toBe(401);
        expect(await count('private.garmin_push_events')).toBe(0);
        expect(await energy()).toEqual([]);
      });

      it('throttles repeated failed attempts globally (brute-force brake)', async () => {
        const limiter = vi.fn(async () => 20);
        const r = await handleWebhookRequest(
          push({}, { headers: { 'x-garmin-webhook-secret': 'guess' } }),
          deps({ consumeRateLimit: limiter }),
        );
        expect(r.status).toBe(429);
        expect(limiter).toHaveBeenCalledWith(
          '00000000-0000-0000-0000-000000000000',
          'garmin-webhook-badauth',
          30,
          60,
        );
        // a correct secret does not consume the failed-attempt budget
        limiter.mockClear();
        await connect();
        const ok = await handleWebhookRequest(
          push({ dailies: [dailies()] }),
          deps({ consumeRateLimit: limiter }),
        );
        expect(ok.status).toBe(200);
        expect(limiter).not.toHaveBeenCalled();
      });

      it('accepts the secret as Bearer token or ?secret= query parameter', async () => {
        await connect();
        const bearer = push(
          { dailies: [dailies()] },
          { headers: { 'x-garmin-webhook-secret': '', authorization: `Bearer ${SECRET}` } },
        );
        expect((await handleWebhookRequest(bearer, deps())).status).toBe(200);
        const query = new Request(
          `https://abc.supabase.co/functions/v1/garmin-webhook?secret=${SECRET}`,
          {
            method: 'POST',
            body: JSON.stringify({ dailies: [dailies({ steps: 5000 })] }),
          },
        );
        expect((await handleWebhookRequest(query, deps())).status).toBe(200);
        expect((await energy())[0]!.steps).toBe(5000);
      });

      it('answers 400 for invalid JSON, 413 for oversized bodies and understands gzip', async () => {
        await connect();
        expect((await handleWebhookRequest(push(null, { raw: '{not json' }), deps())).status).toBe(
          400,
        );
        const big = push(null, { raw: 'x'.repeat(5 * 1024 * 1024 + 10) });
        expect((await handleWebhookRequest(big, deps())).status).toBe(413);
        const zipped = push(null, {
          raw: gzipSync(JSON.stringify({ dailies: [dailies()] })),
          headers: { 'content-encoding': 'gzip' },
        });
        const r = await handleWebhookRequest(zipped, deps());
        expect(r).toMatchObject({ status: 200, body: { accepted: 1 } });
      });
    });

    describe('storing and mapping', () => {
      it('buffers the push, writes source=garmin energy + biometrics, and stamps the connection', async () => {
        await connect();
        const r = await handleWebhookRequest(push({ dailies: [dailies()] }), deps());
        expect(r).toMatchObject({
          status: 200,
          body: { ok: true, received: 1, accepted: 1, rejected: 0, deregistered: 0 },
        });
        expect(await energy()).toEqual([{ active_kcal: 321, resting_kcal: 801, steps: 4210 }]);
        const bios = await db.query<{ type: string; value: number; source: string }>(
          `select type, value::float8 as value, source from public.biometrics order by type`,
        );
        expect(bios.rows).toEqual([
          { type: 'resting_heart_rate', value: 58, source: 'garmin' },
          { type: 'stress', value: 34, source: 'garmin' },
        ]);
        const events = await db.query<{
          kind: string;
          processed: boolean;
          error: string | null;
          user_id: string;
        }>(
          `select kind, processed_at is not null as processed, error, user_id from private.garmin_push_events`,
        );
        expect(events.rows).toEqual([
          { kind: 'dailies', processed: true, error: null, user_id: USER_A },
        ]);
        const status = await asUser(db, USER_A, () =>
          db.query<{ connected: boolean; last_push_at: Date | null; last_error: string | null }>(
            `select connected, last_push_at, last_error from public.garmin_connection_status()`,
          ),
        );
        expect(status.rows[0]).toMatchObject({ connected: true, last_error: null });
        expect(status.rows[0]!.last_push_at).not.toBeNull();
      });

      it('treats repeated cumulative pushes of one day as the latest value, never a sum', async () => {
        await connect();
        await handleWebhookRequest(push({ dailies: [dailies()] }), deps());
        await handleWebhookRequest(push({ dailies: [dailies()] }), deps()); // exact duplicate (retry)
        expect(await energy()).toEqual([{ active_kcal: 321, resting_kcal: 801, steps: 4210 }]);
        await handleWebhookRequest(
          push({
            dailies: [
              dailies({
                durationInSeconds: 64_800,
                steps: 8000,
                activeKilocalories: 540,
                bmrKilocalories: 1250,
              }),
            ],
          }),
          deps(),
        );
        expect(await energy()).toEqual([{ active_kcal: 540, resting_kcal: 1250, steps: 8000 }]);
        // a delayed OLDER push must not roll it back
        await handleWebhookRequest(push({ dailies: [dailies()] }), deps());
        expect(await energy()).toEqual([{ active_kcal: 540, resting_kcal: 1250, steps: 8000 }]);
        expect(await count('public.biometrics', [])).toBe(2); // one resting HR + one stress row for the day
      });

      it('maps sleeps, activities, body composition, HRV and body battery from one body', async () => {
        await connect();
        const body = {
          sleeps: [
            {
              userId: 'garmin-1',
              summaryId: 'sl1',
              calendarDate: '2026-11-10',
              startTimeInSeconds: DAY - 8 * 3600,
              durationInSeconds: 8 * 3600,
              deepSleepDurationInSeconds: 5400,
              lightSleepDurationInSeconds: 14400,
              remSleepInSeconds: 7200,
              awakeDurationInSeconds: 1800,
            },
          ],
          activities: [
            {
              userId: 'garmin-1',
              summaryId: 'ac1',
              activityId: 555,
              activityType: 'RUNNING',
              startTimeInSeconds: DAY + 6 * 3600,
              startTimeOffsetInSeconds: 3600,
              durationInSeconds: 1800,
              activeKilocalories: 300,
            },
          ],
          bodyComps: [
            {
              userId: 'garmin-1',
              measurementTimeInSeconds: DAY + 7 * 3600,
              weightInGrams: 72_000,
              bodyFatInPercent: 18,
            },
          ],
          hrv: [{ userId: 'garmin-1', calendarDate: '2026-11-10', lastNightAvg: 47 }],
          stressDetails: [
            {
              userId: 'garmin-1',
              calendarDate: '2026-11-10',
              startTimeInSeconds: DAY,
              durationInSeconds: 86_400,
              timeOffsetBodyBatteryValues: { '0': 30, '600': 80 },
            },
          ],
        };
        const r = await handleWebhookRequest(push(body), deps());
        expect(r).toMatchObject({ status: 200, body: { received: 5, accepted: 5 } });
        const bios = await db.query<{
          type: string;
          value: number;
          unit: string;
          entry_date: string;
        }>(
          `select type, value::float8 as value, unit, entry_date::text as entry_date from public.biometrics order by type`,
        );
        expect(bios.rows).toEqual([
          { type: 'body_battery', value: 80, unit: 'percent', entry_date: '2026-11-10' },
          { type: 'body_fat', value: 18, unit: 'percent', entry_date: '2026-11-10' },
          { type: 'hrv', value: 47, unit: 'ms', entry_date: '2026-11-10' },
          { type: 'sleep', value: 7.5, unit: 'hr', entry_date: '2026-11-10' },
          { type: 'weight', value: 72, unit: 'kg', entry_date: '2026-11-10' },
        ]);
        const ex = await db.query<{
          name: string;
          kcal: number;
          external_id: string;
          counts: boolean;
          source: string;
        }>(
          `select name, kcal::float8 as kcal, external_id, counts_toward_energy as counts, source from public.exercise_entries`,
        );
        expect(ex.rows).toEqual([
          {
            name: 'Running',
            kcal: 300,
            external_id: 'garmin:activity:555',
            counts: false,
            source: 'garmin',
          },
        ]);
        // pushing the identical body again changes nothing (idempotent)
        await handleWebhookRequest(push(body), deps());
        expect(await count('public.biometrics')).toBe(5);
        expect(await count('public.exercise_entries')).toBe(1);
      });

      it('stores unknown kinds raw (trimmed) with an error marker, and trims big sample maps', async () => {
        await connect();
        const samples = Object.fromEntries(
          Array.from({ length: 5000 }, (_, i) => [String(i * 15), 70]),
        );
        await handleWebhookRequest(
          push({
            userMetrics: [{ userId: 'garmin-1', calendarDate: '2026-11-10', vo2Max: 51 }],
            dailies: [dailies({ timeOffsetHeartRateSamples: samples })],
          }),
          deps(),
        );
        const ev = await db.query<{
          kind: string;
          error: string | null;
          size: number;
          payload: Record<string, unknown>;
        }>(
          `select kind, error, length(payload::text) as size, payload from private.garmin_push_events order by id`,
        );
        expect(ev.rows.map((e) => [e.kind, e.error])).toEqual([
          ['userMetrics', 'unmapped_kind'],
          ['dailies', null],
        ]);
        expect(ev.rows[0]!.payload).toMatchObject({ vo2Max: 51 });
        expect(ev.rows[1]!.size).toBeLessThan(2000);
        expect(ev.rows[1]!.payload.timeOffsetHeartRateSamples).toMatchObject({
          _trimmed: 'object',
          entries: 5000,
        });
      });

      it('records why an item produced no rows, and flags ping-style payloads', async () => {
        await connect();
        await handleWebhookRequest(
          push({
            dailies: [
              {
                userId: 'garmin-1',
                summaryId: 'ping',
                callbackURL: 'https://apis.garmin.com/wellness-api/rest/dailies?token=x',
              },
              { userId: 'garmin-1' },
            ],
          }),
          deps(),
        );
        const ev = await db.query<{ error: string | null }>(
          `select error from private.garmin_push_events order by id`,
        );
        expect(ev.rows.map((e) => e.error)).toEqual([
          'ping_payload_without_data',
          'dailies: no calendarDate / start time',
        ]);
        expect(await count('public.daily_energy')).toBe(0);
      });
    });

    describe('users', () => {
      it('rejects (counts, does not store) items of unknown Garmin users but still answers 200', async () => {
        await connect();
        const r = await handleWebhookRequest(
          push({ dailies: [dailies({ userId: 'someone-else', steps: 999 }), dailies()] }),
          deps(),
        );
        expect(r).toMatchObject({ status: 200, body: { received: 2, accepted: 1, rejected: 1 } });
        expect(await count('private.garmin_push_events')).toBe(1);
        expect(await energy()).toEqual([{ active_kcal: 321, resting_kcal: 801, steps: 4210 }]);
        const none = await handleWebhookRequest(
          push({ dailies: [dailies({ userId: 'ghost' })] }),
          deps(),
        );
        expect(none).toMatchObject({ status: 200, body: { accepted: 0, rejected: 1 } });
      });

      it('routes items to the right user, and falls back to userAccessToken when there is no userId', async () => {
        await connect(USER_A, 'garmin-1', 'access-a');
        await connect(USER_B, 'garmin-2', 'access-b');
        const { userId: _omit, ...noUserId } = dailies({ steps: 777 });
        await handleWebhookRequest(
          push({
            dailies: [
              dailies(),
              dailies({ userId: 'garmin-2', steps: 3333 }),
              { ...noUserId, userAccessToken: 'access-a', steps: 4300 },
            ],
          }),
          deps(),
        );
        const rows = await db.query<{ user_id: string; steps: number }>(
          `select user_id, steps from public.daily_energy order by steps`,
        );
        expect(rows.rows).toEqual([
          { user_id: USER_B, steps: 3333 },
          { user_id: USER_A, steps: 4300 },
        ]);
      });

      it('a deregistration deletes the connection, buffer and imported Garmin data, and later pushes are rejected', async () => {
        await connect();
        await handleWebhookRequest(push({ dailies: [dailies()] }), deps());
        await db.query(
          `insert into public.daily_energy (user_id, local_date, source, steps) values ($1, '2026-11-10', 'apple_health', 1)`,
          [USER_A],
        );
        const r = await handleWebhookRequest(
          push({ deregistrations: [{ userId: 'garmin-1' }], dailies: [dailies({ steps: 9999 })] }),
          deps(),
        );
        expect(r).toMatchObject({
          status: 200,
          body: { deregistered: 1, accepted: 0, rejected: 1 },
        });
        expect(await store.getConnection({ userId: USER_A })).toBeNull();
        expect(await count('private.garmin_push_events')).toBe(0);
        expect(
          (await db.query<{ source: string }>(`select source from public.daily_energy`)).rows,
        ).toEqual([{ source: 'apple_health' }]);
        expect(await count('public.biometrics')).toBe(0);
        const later = await handleWebhookRequest(push({ dailies: [dailies()] }), deps());
        expect(later).toMatchObject({ body: { accepted: 0, rejected: 1 } });
      });

      it('keeps the imported data on deregistration when GARMIN_DELETE_DATA_ON_DEREGISTER=false (tokens are always removed)', async () => {
        await connect();
        await handleWebhookRequest(push({ dailies: [dailies()] }), deps());
        await handleWebhookRequest(
          push({ deregistrations: [{ userId: 'garmin-1' }] }),
          deps({ cfg: cfgWith({ GARMIN_DELETE_DATA_ON_DEREGISTER: 'false' }) }),
        );
        expect(await store.getConnection({ userId: USER_A })).toBeNull();
        expect(await energy()).toHaveLength(1);
        expect(await count('private.garmin_push_events')).toBe(0);
      });

      it('ignores deregistrations of unknown users', async () => {
        await connect();
        const r = await handleWebhookRequest(
          push({ deregistrations: [{ userId: 'ghost' }] }),
          deps(),
        );
        expect(r).toMatchObject({ status: 200, body: { received: 1, deregistered: 0 } });
        expect(await store.getConnection({ userId: USER_A })).not.toBeNull();
      });
    });

    describe('failures', () => {
      it('still answers 200 when applying fails after buffering; the event and the connection carry the error', async () => {
        await connect();
        const failingApply: GarminStore = {
          ...store,
          applyHealth: async () => {
            throw new Error('db hiccup');
          },
        };
        const r = await handleWebhookRequest(
          push({ dailies: [dailies()] }),
          deps({ store: failingApply }),
        );
        expect(r).toMatchObject({ status: 200, body: { accepted: 1 } });
        expect(
          (await db.query<{ error: string | null }>(`select error from private.garmin_push_events`))
            .rows,
        ).toEqual([{ error: 'apply_failed' }]);
        const status = await asUser(db, USER_A, () =>
          db.query(`select last_push_at, last_error from public.garmin_connection_status()`),
        );
        expect(status.rows[0]).toMatchObject({ last_push_at: null, last_error: 'apply_failed' });
        expect(logs.join('\n')).toContain('could not be applied');

        // the next good push clears the error
        await handleWebhookRequest(push({ dailies: [dailies()] }), deps());
        const healed = await asUser(db, USER_A, () =>
          db.query(`select last_error from public.garmin_connection_status()`),
        );
        expect(healed.rows[0]).toMatchObject({ last_error: null });
      });

      it('fails the request (so Garmin retries) when the push cannot even be buffered', async () => {
        await connect();
        const broken: GarminStore = {
          ...store,
          recordPushEvents: async () => {
            throw new Error('db down');
          },
        };
        await expect(
          handleWebhookRequest(push({ dailies: [dailies()] }), deps({ store: broken })),
        ).rejects.toThrow('db down');
        expect(await energy()).toEqual([]);
      });
    });

    describe('retention', () => {
      it('sometimes runs the purge (deletes buffered events older than 14 days)', async () => {
        await connect();
        await handleWebhookRequest(push({ dailies: [dailies()] }), deps());
        await db.query(
          `update private.garmin_push_events set received_at = now() - interval '15 days'`,
        );
        await handleWebhookRequest(push({ dailies: [dailies()] }), deps({ roll: () => 0.5 }));
        expect(await count('private.garmin_push_events')).toBe(2);
        await handleWebhookRequest(push({ dailies: [dailies()] }), deps({ roll: () => 0.001 }));
        expect(await count('private.garmin_push_events')).toBe(2); // the 15-day-old one is gone, two recent ones stay
        expect(
          (
            await db.query<{ n: number }>(
              `select count(*)::int as n from private.garmin_push_events where received_at < now() - interval '14 days'`,
            )
          ).rows[0]!.n,
        ).toBe(0);
      });
    });
  });
});
