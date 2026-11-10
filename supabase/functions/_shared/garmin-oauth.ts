/**
 * Garmin OAuth2 (authorization code + PKCE) helpers and configuration (pure: web-standard APIs only, no Deno globals).
 *
 * UNVERIFIED: Garmin's Starter-tier OAuth specification is only available in its developer portal after access is
 * granted. Every URL, parameter name and response field below is an assumption and is mirrored in
 * docs/garmin-integration.md ("TO CONFIRM AGAINST GARMIN'S DOCS AFTER APPROVAL"). Each endpoint can be overridden with a
 * function secret, so a wrong guess is fixed without a code change.
 */

export type FunctionEnv = (name: string) => string | undefined;

/** The browser surface to send the user back to after the callback. The URL itself always comes from secrets. */
export type ReturnKind = 'native' | 'web';

export interface GarminConfig {
  clientId: string | undefined;
  clientSecret: string | undefined;
  /** UNVERIFIED: lead-supplied default, see docs. */
  authorizeUrl: string;
  /** UNVERIFIED default. */
  tokenUrl: string;
  /** GET with the access token; answers the Garmin API user id. UNVERIFIED default. */
  userIdUrl: string;
  /** DELETE with the access token; removes our registration of the user. UNVERIFIED default. */
  deregisterUrl: string;
  /** The redirect URI registered in the Garmin portal (our garmin-oauth-callback function). */
  redirectUri: string | undefined;
  /** Space separated scopes; omitted from the authorize request when unset. UNVERIFIED: Starter tier may not use scopes. */
  scopes: string | undefined;
  /** How client credentials are sent to the token endpoint. UNVERIFIED. */
  tokenAuthStyle: 'body' | 'basic';
  webhookSecret: string | undefined;
  /** Deep link used for native returns (scheme from apps/app/app.json). */
  appRedirectNative: string;
  /** Web origin of the hosted app, e.g. https://cal-track.example.com. Unset = web returns are not offered. */
  appUrl: string | undefined;
  /** Delete the imported source='garmin' rows when Garmin reports a deregistration (default true). */
  deleteDataOnDeregister: boolean;
}

// UNVERIFIED: authorize page; this URL was supplied with the Starter-tier information, parameters are standard OAuth2 + PKCE.
export const DEFAULT_AUTHORIZE_URL = 'https://apis.garmin.com/tools/oauth2/authorizeUser';
// UNVERIFIED: token endpoint (GARMIN_TOKEN_URL). Recalled from Garmin's Health API OAuth2 material, not read from the spec.
export const DEFAULT_TOKEN_URL = 'https://diauth.garmin.com/di-oauth2-service/oauth/token';
// UNVERIFIED: "who is this token's user" endpoint (GARMIN_USER_ID_URL); the answer is expected as {"userId": "..."}.
export const DEFAULT_USER_ID_URL = 'https://apis.garmin.com/wellness-api/rest/user/id';
// UNVERIFIED: deregistration (GARMIN_DEREGISTER_URL), expected to be a DELETE with the user's access token.
export const DEFAULT_DEREGISTER_URL = 'https://apis.garmin.com/wellness-api/rest/user/registration';
/** Deep link scheme `caltrack` comes from apps/app/app.json ("scheme"). */
export const DEFAULT_APP_REDIRECT = 'caltrack://settings/integrations';
export const APP_RETURN_PATH = '/settings/integrations';

const trimmed = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

export function readGarminConfig(env: FunctionEnv): GarminConfig {
  const supabaseUrl = trimmed(env('SUPABASE_URL'))?.replace(/\/+$/, '');
  const style = trimmed(env('GARMIN_TOKEN_AUTH_STYLE'))?.toLowerCase();
  return {
    clientId: trimmed(env('GARMIN_CLIENT_ID')),
    clientSecret: trimmed(env('GARMIN_CLIENT_SECRET')),
    authorizeUrl: trimmed(env('GARMIN_AUTHORIZE_URL')) ?? DEFAULT_AUTHORIZE_URL,
    tokenUrl: trimmed(env('GARMIN_TOKEN_URL')) ?? DEFAULT_TOKEN_URL,
    userIdUrl: trimmed(env('GARMIN_USER_ID_URL')) ?? DEFAULT_USER_ID_URL,
    deregisterUrl: trimmed(env('GARMIN_DEREGISTER_URL')) ?? DEFAULT_DEREGISTER_URL,
    redirectUri:
      trimmed(env('GARMIN_REDIRECT_URI')) ??
      (supabaseUrl ? `${supabaseUrl}/functions/v1/garmin-oauth-callback` : undefined),
    scopes: trimmed(env('GARMIN_SCOPES')),
    tokenAuthStyle: style === 'basic' ? 'basic' : 'body',
    webhookSecret: trimmed(env('GARMIN_WEBHOOK_SECRET')),
    appRedirectNative: trimmed(env('GARMIN_APP_REDIRECT')) ?? DEFAULT_APP_REDIRECT,
    appUrl: trimmed(env('APP_URL'))?.replace(/\/+$/, ''),
    deleteDataOnDeregister:
      trimmed(env('GARMIN_DELETE_DATA_ON_DEREGISTER'))?.toLowerCase() !== 'false',
  };
}

/** What garmin-oauth-start needs. The token exchange additionally needs the client secret (checked there). */
export function canStartOAuth(cfg: GarminConfig): boolean {
  return Boolean(cfg.clientId && cfg.redirectUri);
}

export function canExchangeToken(cfg: GarminConfig): boolean {
  return Boolean(cfg.clientId && cfg.clientSecret && cfg.redirectUri);
}

// ---------------------------------------------------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------------------------------------------------

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type RandomBytes = (length: number) => Uint8Array;

export const secureRandomBytes: RandomBytes = (length) =>
  crypto.getRandomValues(new Uint8Array(length));

/** RFC 7636 verifier: 43-128 characters of the unreserved alphabet. 48 random bytes -> 64 characters. */
export function generateCodeVerifier(random: RandomBytes = secureRandomBytes): string {
  return base64Url(random(48));
}

/** Unguessable, single-use `state` (24 random bytes -> 32 characters). */
export function generateState(random: RandomBytes = secureRandomBytes): string {
  return base64Url(random(24));
}

/** S256 code challenge: BASE64URL(SHA-256(verifier)). */
export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export interface Pkce {
  state: string;
  verifier: string;
  challenge: string;
}

export async function createPkce(random: RandomBytes = secureRandomBytes): Promise<Pkce> {
  const verifier = generateCodeVerifier(random);
  return { state: generateState(random), verifier, challenge: await codeChallengeS256(verifier) };
}

// UNVERIFIED: authorize parameter names and whether a `scope` is needed on the Starter tier (omitted unless GARMIN_SCOPES is set).
/** The page the user opens in the browser. */
export function buildAuthorizeUrl(
  cfg: GarminConfig,
  pkce: Pick<Pkce, 'state' | 'challenge'>,
): string {
  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId ?? '');
  url.searchParams.set('redirect_uri', cfg.redirectUri ?? '');
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', pkce.state);
  if (cfg.scopes) url.searchParams.set('scope', cfg.scopes);
  return url.toString();
}

// ---------------------------------------------------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------------------------------------------------

export type TokenGrant =
  | { grant: 'authorization_code'; code: string; codeVerifier: string }
  | { grant: 'refresh_token'; refreshToken: string };

export interface HttpRequest {
  url: string;
  init: RequestInit;
}

// UNVERIFIED: parameter names (RFC 6749 + RFC 7636) and how client_id / client_secret are presented
// (GARMIN_TOKEN_AUTH_STYLE = body | basic).
/** Form-encoded POST to the token endpoint. */
export function buildTokenRequest(cfg: GarminConfig, grant: TokenGrant): HttpRequest {
  const body = new URLSearchParams();
  body.set('grant_type', grant.grant);
  if (grant.grant === 'authorization_code') {
    body.set('code', grant.code);
    body.set('code_verifier', grant.codeVerifier);
    body.set('redirect_uri', cfg.redirectUri ?? '');
  } else {
    body.set('refresh_token', grant.refreshToken);
  }
  body.set('client_id', cfg.clientId ?? '');
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  if (cfg.tokenAuthStyle === 'basic') {
    headers.Authorization = `Basic ${btoa(`${cfg.clientId ?? ''}:${cfg.clientSecret ?? ''}`)}`;
  } else {
    body.set('client_secret', cfg.clientSecret ?? '');
  }
  return { url: cfg.tokenUrl, init: { method: 'POST', headers, body: body.toString() } };
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** ISO timestamp, null when the response carries no lifetime. */
  expiresAt: string | null;
  refreshExpiresAt: string | null;
  scopes: string[];
}

const isoIn = (nowMs: number, seconds: unknown): string | null => {
  const n = typeof seconds === 'string' ? Number(seconds) : seconds;
  return typeof n === 'number' && Number.isFinite(n) && n > 0
    ? new Date(nowMs + n * 1000).toISOString()
    : null;
};

// UNVERIFIED: token response field names (RFC 6749: access_token, refresh_token, expires_in, scope) plus
// refresh_token_expires_in; token lifetimes are unknown.
/** OAuth2 token response -> TokenSet. null = unusable. */
export function parseTokenResponse(json: unknown, nowMs = Date.now()): TokenSet | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  const access = typeof o.access_token === 'string' ? o.access_token.trim() : '';
  if (!access) return null;
  const refresh =
    typeof o.refresh_token === 'string' && o.refresh_token.trim() ? o.refresh_token.trim() : null;
  const scope = typeof o.scope === 'string' ? o.scope : '';
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: isoIn(nowMs, o.expires_in),
    refreshExpiresAt: isoIn(nowMs, o.refresh_token_expires_in ?? o.refresh_expires_in),
    scopes: scope
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

// UNVERIFIED: shape of the "user id" answer; `{"userId": "..."}` is assumed, a bare string is tolerated.
/** Garmin user id from the "user id" endpoint. */
export function parseGarminUserId(json: unknown): string | null {
  if (typeof json === 'string') return json.trim() || null;
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  for (const key of ['userId', 'user_id', 'garminUserId', 'id']) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Return to the app
// ---------------------------------------------------------------------------------------------------------------------

export type OAuthOutcome = { ok: true } | { ok: false; reason: string };

/** Reasons are short lowercase codes (they travel in a URL and are shown to the user as text by the app). */
export function sanitizeReason(reason: string): string {
  const r = reason
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return r || 'unknown';
}

/**
 * Where the browser goes after the callback: `<base>?garmin=connected` or `<base>?garmin=error&reason=<code>`.
 * native -> GARMIN_APP_REDIRECT (deep link, default caltrack://settings/integrations), web -> APP_URL + /settings/integrations.
 * The target never comes from the request, so this cannot be abused as an open redirect. null = no target configured.
 */
export function buildAppRedirect(
  cfg: GarminConfig,
  kind: ReturnKind,
  outcome: OAuthOutcome,
): string | null {
  const base =
    kind === 'web'
      ? cfg.appUrl
        ? `${cfg.appUrl}${APP_RETURN_PATH}`
        : null
      : cfg.appRedirectNative;
  if (!base) return null;
  const query = outcome.ok
    ? 'garmin=connected'
    : `garmin=error&reason=${sanitizeReason(outcome.reason)}`;
  return `${base}${base.includes('?') ? '&' : '?'}${query}`;
}

export function isReturnKind(v: unknown): v is ReturnKind {
  return v === 'native' || v === 'web';
}

// ---------------------------------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------------------------------

/** Compares two secrets without exiting at the first differing byte (the loop always covers the longer input). */
export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ea = enc.encode(a);
  const eb = enc.encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

// UNVERIFIED: how Garmin can authenticate its pushes. The portal may only accept a URL (no custom header), then ?secret= is the
// way; Garmin may alternatively publish source IP ranges or signed requests, which this code does not check.
const SECRET_HEADERS = ['x-garmin-webhook-secret', 'x-webhook-secret'];
const SECRET_QUERY = ['secret', 'webhook_secret'];

/**
 * The shared secret presented by a webhook caller: header `x-garmin-webhook-secret` (or `x-webhook-secret`),
 * `Authorization: Bearer <secret>`, or the query parameter `?secret=`. UNVERIFIED: the portal may only let us configure a URL,
 * in which case the query parameter is the one to use.
 */
export function presentedWebhookSecret(req: Request): string | null {
  for (const h of SECRET_HEADERS) {
    const v = req.headers.get(h);
    if (v?.trim()) return v.trim();
  }
  const auth = req.headers.get('authorization');
  const bearer = auth ? /^Bearer\s+(\S+)$/i.exec(auth.trim()) : null;
  if (bearer) return bearer[1]!;
  try {
    const url = new URL(req.url);
    for (const q of SECRET_QUERY) {
      const v = url.searchParams.get(q);
      if (v?.trim()) return v.trim();
    }
  } catch {
    // unparsable URL: no secret
  }
  return null;
}

/** True when the request carries the configured secret. A missing or empty configured secret NEVER authorises. */
export function webhookAuthorized(req: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const given = presentedWebhookSecret(req);
  if (given === null) return false;
  return constantTimeEqual(given, expected);
}
