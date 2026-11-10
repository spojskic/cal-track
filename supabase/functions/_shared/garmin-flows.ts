/**
 * Orchestration of the four Garmin Edge Functions (pure: every side effect is injected, so it is unit-tested in Vitest
 * with fakes and, for the SQL side, against the real migration in PGlite).
 *
 *   garmin-oauth-start     startOAuth()          user JWT   -> { url }
 *   garmin-oauth-callback  finishOAuth()         browser    -> 302 back to the app
 *   garmin-webhook         handleWebhookRequest() Garmin    -> 200 (store the push, map it into the health tables)
 *   garmin-disconnect      disconnectGarmin()    user JWT   -> { ok: true }
 *
 * UNVERIFIED (mirrored in docs/garmin-integration.md): everything about Garmin's endpoints, parameters and payloads.
 * Secrets, tokens, authorisation codes and PKCE verifiers are never written to logs or returned to clients.
 */
import {
  apiError,
  asRecord,
  fetchUpstreamJson,
  ok,
  rateLimited,
  type ApiResult,
  type FetchLike,
} from './http.ts';
import { readRequestText } from './garmin-http.ts';
import {
  buildAppRedirect,
  buildAuthorizeUrl,
  buildTokenRequest,
  canExchangeToken,
  canStartOAuth,
  createPkce,
  isReturnKind,
  parseGarminUserId,
  parseTokenResponse,
  webhookAuthorized,
  type GarminConfig,
  type RandomBytes,
  type ReturnKind,
  type TokenSet,
} from './garmin-oauth.ts';
import {
  extractPushItems,
  hasRows,
  isMappedKind,
  mapPushItem,
  mergeMapped,
  trimPayload,
  type PushItem,
} from './garmin-push.ts';
import {
  GarminAccountInUseError,
  type GarminConnectionRecord,
  type GarminStore,
} from './garmin-store.ts';
import { GLOBAL_RATE_LIMIT_USER, type ConsumeRateLimit } from './rate-limit.ts';

/** The PKCE state lives this long between "start" and "callback". */
export const OAUTH_STATE_TTL_SECONDS = 600;
/** A webhook secret shorter than this is treated as "not configured" (it would be guessable). */
export const MIN_WEBHOOK_SECRET_LENGTH = 16;
/** Chance per webhook call to also run the retention purge (the cron job is the primary mechanism). */
export const OPPORTUNISTIC_PURGE_PROBABILITY = 0.02;

export interface GarminDeps {
  cfg: GarminConfig;
  store: GarminStore;
  fetch: FetchLike;
  consumeRateLimit?: ConsumeRateLimit;
  random?: RandomBytes;
  /** Uniform [0, 1); injectable for tests. */
  roll?: () => number;
  log?: (message: string, detail?: unknown) => void;
  /** Timeout of each request to Garmin (default 15 s). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

const notConfigured = (message = 'Garmin is not set up on the server yet.'): ApiResult =>
  apiError(503, 'garmin_not_configured', message);

async function limit(
  deps: GarminDeps,
  userId: string,
  bucket: string,
  max: number,
  windowSeconds: number,
): Promise<number> {
  return deps.consumeRateLimit ? deps.consumeRateLimit(userId, bucket, max, windowSeconds) : 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// garmin-oauth-start
// ---------------------------------------------------------------------------------------------------------------------

/** Creates the PKCE verifier / challenge and a single-use state, and returns the Garmin authorize URL. */
export async function startOAuth(
  body: unknown,
  userId: string,
  deps: GarminDeps,
): Promise<ApiResult> {
  const { cfg, store } = deps;
  if (!canStartOAuth(cfg)) return notConfigured();

  const platform = asRecord(body)?.platform ?? 'native';
  if (!isReturnKind(platform))
    return apiError(400, 'invalid_request', 'platform must be "native" or "web".');
  if (platform === 'web' && !cfg.appUrl) {
    return notConfigured(
      'Garmin is not set up for the web app yet (APP_URL is missing on the server).',
    );
  }

  const wait = await limit(deps, userId, 'garmin-start', 10, 60);
  if (wait > 0) return rateLimited(wait);

  const pkce = await createPkce(deps.random);
  await store.createOAuthState({
    state: pkce.state,
    userId,
    codeVerifier: pkce.verifier,
    returnKind: platform,
    ttlSeconds: OAUTH_STATE_TTL_SECONDS,
  });
  return ok({ url: buildAuthorizeUrl(cfg, pkce) });
}

// ---------------------------------------------------------------------------------------------------------------------
// garmin-oauth-callback
// ---------------------------------------------------------------------------------------------------------------------

/** A redirect back to the app, or (when no app target is known) a plain-text answer. */
export type CallbackResult = { redirect: string } | { status: number; message: string };

/**
 * Handles Garmin's redirect (`?code=...&state=...` or `?error=...`). The state is consumed exactly once; the user is
 * identified by the state we stored, never by anything in the URL.
 */
export async function finishOAuth(
  params: URLSearchParams,
  deps: GarminDeps,
): Promise<CallbackResult> {
  const { cfg, store } = deps;
  const log = deps.log ?? (() => {});

  const wait = await limit(deps, GLOBAL_RATE_LIMIT_USER, 'garmin-callback', 60, 60);
  if (wait > 0) return { status: 429, message: 'Too many requests. Please try again in a minute.' };

  const state = params.get('state');
  if (!state || state.length > 200) return { status: 400, message: 'Invalid request.' };

  const consumed = await store.consumeOAuthState(state, OAUTH_STATE_TTL_SECONDS);
  if (!consumed) {
    return {
      status: 400,
      message:
        'This Garmin sign-in link has expired or was already used. Return to Cal Track and try again.',
    };
  }
  const kind: ReturnKind = consumed.returnKind;
  const back = (outcome: { ok: true } | { ok: false; reason: string }): CallbackResult => {
    const redirect = buildAppRedirect(cfg, kind, outcome);
    return redirect
      ? { redirect }
      : {
          status: 400,
          message: outcome.ok
            ? 'Connected. You can close this page.'
            : 'Garmin sign-in failed. Return to Cal Track and try again.',
        };
  };

  const garminError = params.get('error');
  if (garminError) {
    log('garmin authorization was not granted', { error: garminError.slice(0, 40) });
    return back({
      ok: false,
      reason: garminError === 'access_denied' ? 'access_denied' : 'authorization_failed',
    });
  }
  const code = params.get('code');
  if (!code || code.length > 2000) return back({ ok: false, reason: 'missing_code' });
  if (!canExchangeToken(cfg)) return back({ ok: false, reason: 'not_configured' });

  // 1. code + verifier -> tokens
  const tokenReq = buildTokenRequest(cfg, {
    grant: 'authorization_code',
    code,
    codeVerifier: consumed.codeVerifier,
  });
  const tokenRes = await fetchUpstreamJson(
    deps.fetch,
    tokenReq.url,
    tokenReq.init,
    deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (tokenRes.kind !== 'ok') {
    log('garmin token exchange failed', {
      outcome: tokenRes.kind === 'error' ? tokenRes.reason : tokenRes.kind,
    });
    return back({ ok: false, reason: 'token_exchange_failed' });
  }
  const tokens = parseTokenResponse(tokenRes.json);
  if (!tokens) {
    log('garmin token response unusable');
    return back({ ok: false, reason: 'token_response_invalid' });
  }

  // 2. tokens -> the Garmin user id (the key under which Garmin will push this user's data)
  // UNVERIFIED: that pushes carry this `userId` (items may identify the user by `userAccessToken` instead; both are accepted).
  const idRes = await fetchUpstreamJson(
    deps.fetch,
    cfg.userIdUrl,
    { headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: 'application/json' } },
    deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const garminUserId = idRes.kind === 'ok' ? parseGarminUserId(idRes.json) : null;
  if (!garminUserId) {
    log('garmin user id lookup failed', {
      outcome: idRes.kind === 'error' ? idRes.reason : idRes.kind,
    });
    return back({ ok: false, reason: 'user_id_failed' });
  }

  // 3. store
  try {
    await store.saveConnection({
      userId: consumed.userId,
      garminUserId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt,
      scopes: tokens.scopes,
    });
  } catch (err) {
    if (err instanceof GarminAccountInUseError)
      return back({ ok: false, reason: 'account_already_linked' });
    log(
      'garmin connection could not be saved',
      err instanceof Error ? err.message : 'unknown error',
    );
    return back({ ok: false, reason: 'save_failed' });
  }
  return back({ ok: true });
}

// ---------------------------------------------------------------------------------------------------------------------
// garmin-disconnect
// ---------------------------------------------------------------------------------------------------------------------

async function refreshTokens(
  conn: GarminConnectionRecord,
  deps: GarminDeps,
): Promise<TokenSet | null> {
  if (!conn.refreshToken || !canExchangeToken(deps.cfg)) return null;
  const req = buildTokenRequest(deps.cfg, {
    grant: 'refresh_token',
    refreshToken: conn.refreshToken,
  });
  const res = await fetchUpstreamJson(
    deps.fetch,
    req.url,
    req.init,
    deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  return res.kind === 'ok' ? parseTokenResponse(res.json) : null;
}

/** Best effort: tell Garmin to drop the registration. true = Garmin confirmed (or already forgot the user). */
async function deregisterAtGarmin(
  conn: GarminConnectionRecord,
  deps: GarminDeps,
): Promise<boolean> {
  // UNVERIFIED: DELETE <GARMIN_DEREGISTER_URL> with `Authorization: Bearer <access token>`; 2xx / 404 / 410 count as done.
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const call = async (token: string): Promise<number> => {
    try {
      return (
        await deps.fetch(deps.cfg.deregisterUrl, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
            ? { signal: AbortSignal.timeout(timeoutMs) }
            : {}),
        })
      ).status;
    } catch {
      return 0;
    }
  };
  let status = await call(conn.accessToken);
  if (status === 401) {
    const fresh = await refreshTokens(conn, deps);
    if (fresh) status = await call(fresh.accessToken);
  }
  return (status >= 200 && status < 300) || status === 404 || status === 410;
}

/**
 * Deregisters the user at Garmin (best effort) and ALWAYS deletes the local connection, tokens and raw push buffer.
 * `deleteData: true` additionally removes the rows imported from Garmin (source = 'garmin').
 */
export async function disconnectGarmin(
  body: unknown,
  userId: string,
  deps: GarminDeps,
): Promise<ApiResult> {
  const deleteData = asRecord(body)?.deleteData === true;
  const wait = await limit(deps, userId, 'garmin-disconnect', 10, 60);
  if (wait > 0) return rateLimited(wait);

  const conn = await deps.store.getConnection({ userId });
  let deregistered = false;
  if (conn) {
    try {
      deregistered = await deregisterAtGarmin(conn, deps);
    } catch {
      deregistered = false;
    }
    if (!deregistered)
      deps.log?.('garmin deregistration did not succeed; the local connection is removed anyway');
  }
  await deps.store.deleteConnection(userId, deleteData);
  return ok({ ok: true, deregistered });
}

// ---------------------------------------------------------------------------------------------------------------------
// garmin-webhook
// ---------------------------------------------------------------------------------------------------------------------

interface UserBucket {
  userId: string;
  garminUserId: string;
  items: PushItem[];
}

export interface WebhookSummary {
  ok: true;
  received: number;
  accepted: number;
  rejected: number;
  deregistered: number;
}

/**
 * Receives a Garmin push. Order of work (fast path first):
 *   1. authenticate with the shared secret (constant-time), 401 otherwise (failed attempts are rate limited globally);
 *   2. parse the body; unknown Garmin user ids are rejected (counted, not stored) but still answered 200, so Garmin does not
 *      retry or disable the endpoint because of a user we no longer know;
 *   3. `deregistrations` delete the connection + tokens (+ imported data unless GARMIN_DELETE_DATA_ON_DEREGISTER=false);
 *   4. every other item is buffered in garmin_push_events (trimmed), then mapped into daily_energy / exercise_entries /
 *      biometrics. A mapping/database failure after buffering still answers 200 (the event keeps its error for replay);
 *   5. occasionally the retention purge runs.
 * The whole thing is a handful of RPC round trips, far below Garmin's response deadline.
 */
export async function handleWebhookRequest(req: Request, deps: GarminDeps): Promise<ApiResult> {
  const { cfg, store } = deps;
  const log = deps.log ?? (() => {});

  if (req.method !== 'POST') {
    return apiError(405, 'method_not_allowed', 'Use POST.', {}, { Allow: 'POST' });
  }
  if (!cfg.webhookSecret || cfg.webhookSecret.length < MIN_WEBHOOK_SECRET_LENGTH) {
    return notConfigured('The webhook secret is not configured.');
  }
  if (!webhookAuthorized(req, cfg.webhookSecret)) {
    const wait = await limit(deps, GLOBAL_RATE_LIMIT_USER, 'garmin-webhook-badauth', 30, 60);
    if (wait > 0) return rateLimited(wait);
    return apiError(401, 'unauthorized', 'Invalid or missing webhook secret.');
  }

  const read = await readRequestText(req);
  if (!read.ok) return apiError(read.status, read.error, 'The request body could not be read.');
  let body: unknown;
  try {
    body = JSON.parse(read.text);
  } catch {
    return apiError(400, 'invalid_json', 'Request body must be valid JSON.');
  }

  // UNVERIFIED: the shape of the push (top-level kind keys holding arrays of per-user items, `deregistrations`, PUSH not PING).
  const extracted = extractPushItems(body);
  const received = extracted.items.length + extracted.deregistrations.length;

  // Resolve Garmin user ids (or, as a fallback, access tokens) to Cal Track users once per request.
  const known = new Map<string, GarminConnectionRecord | null>();
  const resolveUser = async (garminUserId: string | null, accessToken: string | null) => {
    const key = garminUserId ? `u:${garminUserId}` : accessToken ? `t:${accessToken}` : null;
    if (key === null) return null;
    if (!known.has(key)) {
      known.set(
        key,
        await store.getConnection(garminUserId ? { garminUserId } : { accessToken: accessToken! }),
      );
    }
    return known.get(key) ?? null;
  };

  // Deregistrations first: the user withdrew consent, so nothing pushed in the same body is stored for them.
  const deregisteredUsers = new Set<string>();
  for (const d of extracted.deregistrations) {
    const conn = await resolveUser(d.garminUserId, d.accessToken);
    if (!conn || deregisteredUsers.has(conn.userId)) continue;
    await store.deleteConnection(conn.userId, cfg.deleteDataOnDeregister);
    deregisteredUsers.add(conn.userId);
  }

  const buckets = new Map<string, UserBucket>();
  let rejected = 0;
  for (const item of extracted.items) {
    const conn = await resolveUser(item.garminUserId, item.accessToken);
    if (!conn || deregisteredUsers.has(conn.userId)) {
      rejected += 1;
      continue;
    }
    const bucket = buckets.get(conn.userId) ?? {
      userId: conn.userId,
      garminUserId: conn.garminUserId,
      items: [],
    };
    bucket.items.push(item);
    buckets.set(conn.userId, bucket);
  }

  let accepted = 0;
  for (const bucket of buckets.values()) {
    accepted += bucket.items.length;
    await processBucket(bucket, deps);
  }

  if ((deps.roll ?? Math.random)() < OPPORTUNISTIC_PURGE_PROBABILITY) {
    await store
      .purge()
      .catch((err: unknown) =>
        log('garmin purge failed', err instanceof Error ? err.message : 'unknown'),
      );
  }

  const summary: WebhookSummary = {
    ok: true,
    received,
    accepted,
    rejected,
    deregistered: deregisteredUsers.size,
  };
  return ok(summary);
}

async function processBucket(bucket: UserBucket, deps: GarminDeps): Promise<void> {
  const { store } = deps;
  const log = deps.log ?? (() => {});

  // 1. Buffer first (trimmed): if this throws, the whole request fails and Garmin can retry (writes are idempotent).
  const ids = await store.recordPushEvents(
    bucket.userId,
    bucket.garminUserId,
    bucket.items.map((i) => ({ kind: i.kind, payload: trimPayload(i.raw) })),
  );

  // 2. Map (pure, never throws) and apply in one transaction.
  const mapped = bucket.items.map((i) => mapPushItem(i.kind, i.raw));
  const itemErrors = bucket.items.map((item, idx) => {
    if (!isMappedKind(item.kind)) return 'unmapped_kind';
    if (typeof item.raw.callbackURL === 'string') return 'ping_payload_without_data';
    const notes = mapped[idx]!.notes;
    return notes.length > 0 ? notes.join('; ').slice(0, 480) : null;
  });
  const all = mergeMapped(mapped);

  let applyFailed = false;
  if (hasRows(all)) {
    try {
      await store.applyHealth(bucket.userId, all);
    } catch (err) {
      applyFailed = true;
      log('garmin push could not be applied', err instanceof Error ? err.message : 'unknown');
    }
  }

  // 3. Mark the buffered events (one call per distinct error text) and stamp the connection.
  try {
    if (ids.length === bucket.items.length) {
      const byError = new Map<string | null, number[]>();
      ids.forEach((id, idx) => {
        const error = applyFailed ? 'apply_failed' : (itemErrors[idx] ?? null);
        byError.set(error, [...(byError.get(error) ?? []), id]);
      });
      for (const [error, group] of byError) await store.finishPushEvents(group, error);
    } else {
      await store.finishPushEvents(ids, applyFailed ? 'apply_failed' : null);
    }
    await store.touchConnection(
      bucket.userId,
      !applyFailed,
      applyFailed ? 'apply_failed' : undefined,
    );
  } catch (err) {
    log('garmin bookkeeping failed', err instanceof Error ? err.message : 'unknown');
  }
}
