/**
 * HTTP plumbing shared by the Edge Functions (pure: only web-standard
 * `Request` / `Response` / `fetch` / `AbortSignal`, no Deno globals).
 */

export const CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

/** What a function handler returns; turned into a Response by {@link jsonResponse}. */
export interface ApiResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export const ok = (body: unknown): ApiResult => ({ status: 200, body });

export function apiError(
  status: number,
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
  headers?: Record<string, string>,
): ApiResult {
  return { status, body: { error, message, ...extra }, headers };
}

/** 429 with `retryAfterSeconds` in the body and a `Retry-After` header. */
export function rateLimited(
  retryAfterSeconds: number,
  extra: Record<string, unknown> = {},
  message = 'Too many requests, please try again shortly.',
): ApiResult {
  return apiError(
    429,
    'rate_limited',
    message,
    { retryAfterSeconds, ...extra },
    { 'Retry-After': String(retryAfterSeconds) },
  );
}

export function jsonResponse(result: ApiResult): Response {
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...result.headers,
    },
  });
}

/** CORS preflight answer; echoes the requested headers so newer client libraries keep working. */
export function preflightResponse(req: Request): Response {
  const requested = req.headers.get('Access-Control-Request-Headers');
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      ...(requested ? { 'Access-Control-Allow-Headers': requested } : {}),
    },
  });
}

const MAX_BODY_CHARS = 10_000;

/**
 * Wraps a handler: OPTIONS preflight, POST only, bounded JSON body, and a
 * catch-all so that EVERY path (including bugs) answers JSON with CORS headers.
 */
export async function handleHttp(
  req: Request,
  run: (body: unknown, req: Request) => Promise<ApiResult>,
  log: (message: string, error?: unknown) => void = (m, e) => console.error(m, e),
): Promise<Response> {
  if (req.method === 'OPTIONS') return preflightResponse(req);
  try {
    if (req.method !== 'POST') {
      return jsonResponse(
        apiError(
          405,
          'method_not_allowed',
          'Use POST with a JSON body.',
          {},
          { Allow: 'POST, OPTIONS' },
        ),
      );
    }
    const text = await req.text();
    if (text.length > MAX_BODY_CHARS) {
      return jsonResponse(apiError(413, 'payload_too_large', 'Request body is too large.'));
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return jsonResponse(apiError(400, 'invalid_json', 'Request body must be valid JSON.'));
    }
    return jsonResponse(await run(body, req));
  } catch (err) {
    log('unhandled error in edge function', err);
    return jsonResponse(apiError(500, 'internal_error', 'Something went wrong. Please try again.'));
  }
}

// ---------------------------------------------------------------------------
// JWT claims
// ---------------------------------------------------------------------------

export interface CallerClaims {
  userId: string;
  token: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeBase64Url(segment: string): string {
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Identifies the caller from the `Authorization: Bearer <jwt>` header WITHOUT
 * verifying the signature: `verify_jwt = true` makes the Supabase gateway do
 * that before the function runs. We only check that the token belongs to a
 * signed-in USER (`role = authenticated`, `sub` = uuid); the project's anon key
 * is also a valid JWT and must be refused here. Returns null otherwise.
 */
export function callerFromRequest(req: Request): CallerClaims | null {
  const header = req.headers.get('Authorization') ?? req.headers.get('authorization');
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
  if (!match) return null;
  const token = match[1]!;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(decodeBase64Url(parts[1]!)) as Record<string, unknown>;
    if (claims.role !== 'authenticated') return null;
    if (typeof claims.sub !== 'string' || !UUID_RE.test(claims.sub)) return null;
    if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return null;
    return { userId: claims.sub, token };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Upstream (FDC / Open Food Facts) fetching
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type UpstreamOutcome =
  | { kind: 'ok'; json: unknown }
  | { kind: 'not_found' }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'error'; reason: string; status?: number };

export const DEFAULT_RETRY_AFTER_SECONDS = 60;
const MAX_RETRY_AFTER_SECONDS = 3600;

/** `Retry-After` header (delta seconds or HTTP date) -> seconds, clamped to 1..3600. */
export function parseRetryAfter(value: string | null | undefined, nowMs = Date.now()): number {
  if (!value) return DEFAULT_RETRY_AFTER_SECONDS;
  const trimmed = value.trim();
  let seconds: number;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    seconds = Math.ceil(Number(trimmed));
  } else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return DEFAULT_RETRY_AFTER_SECONDS;
    seconds = Math.ceil((at - nowMs) / 1000);
  }
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, seconds));
}

/**
 * GET a JSON document from an upstream API and classify the outcome:
 * 200 -> ok, 404 -> not_found, 429 -> rate_limited, anything else (network
 * error, timeout, 4xx/5xx, non-JSON body) -> error. Never throws; the error
 * `reason` never contains the URL (it may include an API key).
 */
export async function fetchUpstreamJson(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000,
): Promise<UpstreamOutcome> {
  let res: Response;
  try {
    const signal =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined;
    res = await fetchFn(url, { ...init, ...(signal ? { signal } : {}) });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    return {
      kind: 'error',
      reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
    };
  }
  if (res.status === 429) {
    return {
      kind: 'rate_limited',
      retryAfterSeconds: parseRetryAfter(res.headers.get('Retry-After')),
    };
  }
  if (res.status === 404) return { kind: 'not_found' };
  if (!res.ok) return { kind: 'error', reason: `http_${res.status}`, status: res.status };
  try {
    return { kind: 'ok', json: await res.json() };
  } catch {
    return { kind: 'error', reason: 'invalid_json', status: res.status };
  }
}

/** Safe `unknown` -> record view. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
