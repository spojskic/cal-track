// DI OAuth2 token handling: refresh and the first ticket exchange. Request builders are pure; the two async functions take
// an injected `fetch` and keep NO state and NO storage. Mirrors garmin-companion crates/garmin-core/src/auth.rs.
//
// These two functions are the ONLY place in this package that sends a POST, and only to DI_TOKEN_URL.

import { base64Encode, formEncode } from './base64';
import {
  DI_CLIENT_IDS,
  DI_GRANT_TYPE,
  DI_TOKEN_URL,
  NATIVE_HEADERS,
  REQUEST_TIMEOUT_MS,
  SSO_SERVICE_URL,
} from './constants';
import { GarminError, parseErrorBody } from './errors';
import { fetchWithTimeout, retryAfterSeconds, type FetchInit, type FetchLike } from './http';
import { clientIdFromJwt, type GarminTokens } from './tokens';

export interface TokenRequest {
  url: string;
  init: Omit<FetchInit, 'signal'> & { method: 'POST'; body: string };
}

/** `Basic base64(client_id + ':')`: the client id is the user name, the password is empty. */
export function basicAuthHeader(clientId: string): string {
  return `Basic ${base64Encode(`${clientId}:`)}`;
}

function tokenHeaders(clientId: string): Record<string, string> {
  return {
    ...NATIVE_HEADERS,
    Authorization: basicAuthHeader(clientId),
    Accept: 'application/json',
    'Cache-Control': 'no-cache',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

/** POST https://diauth.garmin.com/... with grant_type=refresh_token, client_id, refresh_token. */
export function buildRefreshRequest(tokens: Pick<GarminTokens, 'diClientId' | 'diRefreshToken'>): TokenRequest {
  return {
    url: DI_TOKEN_URL,
    init: {
      method: 'POST',
      headers: tokenHeaders(tokens.diClientId),
      body: formEncode([
        ['grant_type', 'refresh_token'],
        ['client_id', tokens.diClientId],
        ['refresh_token', tokens.diRefreshToken],
      ]),
    },
  };
}

/** POST with the custom service-ticket grant. `serviceUrl` must equal the `service` of the sign-in URL. */
export function buildTicketExchangeRequest(
  clientId: string,
  ticket: string,
  serviceUrl: string = SSO_SERVICE_URL,
): TokenRequest {
  return {
    url: DI_TOKEN_URL,
    init: {
      method: 'POST',
      headers: tokenHeaders(clientId),
      body: formEncode([
        ['client_id', clientId],
        ['service_ticket', ticket],
        ['grant_type', DI_GRANT_TYPE],
        ['service_url', serviceUrl],
      ]),
    },
  };
}

interface RawTokenResponse {
  access_token: string;
  refresh_token?: string;
}

function parseRawTokenResponse(body: string): RawTokenResponse | null {
  try {
    const obj = JSON.parse(body) as Record<string, unknown>;
    if (typeof obj.access_token !== 'string' || obj.access_token === '') return null;
    return {
      access_token: obj.access_token,
      ...(typeof obj.refresh_token === 'string' && obj.refresh_token !== '' ? { refresh_token: obj.refresh_token } : {}),
    };
  } catch {
    return null;
  }
}

function transportError(e: unknown): GarminError {
  const aborted = e instanceof Error && e.name === 'AbortError';
  return new GarminError({
    kind: aborted ? 'timeout' : 'network',
    // The original error is NOT kept (it could mention a URL with a query, never a token, but the rule is simple).
    message: aborted ? 'request to the Garmin token service timed out' : 'request to the Garmin token service failed',
  });
}

/** Classifies a non-success answer of the token endpoint during a REFRESH. */
function refreshFailure(status: number, body: string, retryAfter: number | undefined, secrets: readonly string[]): GarminError {
  const code = parseErrorBody(body).message;
  const detail = code ? `token endpoint said: ${code}` : undefined;
  // 400 / 401: the refresh token is dead and the user has to sign in again. Anything else is probably transient.
  if (status === 400 || status === 401) return new GarminError({ kind: 'session_dead', status, secrets, ...(detail ? { detail } : {}) });
  if (status === 429) return new GarminError({ kind: 'rate_limited', status, ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}) });
  if (status >= 500) return new GarminError({ kind: 'server', status });
  return new GarminError({ kind: 'blocked', status, secrets, ...(detail ? { detail } : {}) });
}

export interface AuthOptions {
  timeoutMs?: number;
}

/**
 * Exchanges the refresh token for a fresh access token. One attempt: the caller decides about retries.
 * Garmin may rotate the refresh token on each call; the returned pair always holds the one to persist.
 * Throws GarminError: session_dead (400/401), rate_limited, server, blocked, network, timeout, parse.
 */
export async function refreshTokens(
  fetchImpl: FetchLike,
  tokens: GarminTokens,
  options: AuthOptions = {},
): Promise<GarminTokens> {
  const req = buildRefreshRequest(tokens);
  let result: Awaited<ReturnType<typeof fetchWithTimeout>>;
  try {
    result = await fetchWithTimeout(fetchImpl, req.url, req.init, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  } catch (e) {
    throw transportError(e);
  }
  const { response, text } = result;
  if (response.status < 200 || response.status >= 300) {
    throw refreshFailure(response.status, text, retryAfterSeconds(response), [tokens.diToken, tokens.diRefreshToken]);
  }
  const parsed = parseRawTokenResponse(text);
  if (!parsed) throw new GarminError({ kind: 'parse', message: 'the token service returned no access token' });
  return {
    diToken: parsed.access_token,
    diRefreshToken: parsed.refresh_token ?? tokens.diRefreshToken,
    diClientId: clientIdFromJwt(parsed.access_token) ?? tokens.diClientId,
  };
}

export interface RedeemOptions extends AuthOptions {
  serviceUrl?: string;
  clientIds?: readonly string[];
}

/**
 * Redeems a single-use SSO service ticket for the first token pair, trying the known client ids newest first.
 *
 * The ticket works ONCE: a spent or expired ticket fails the same way for every id, so the walk stops there. A 429, a
 * dropped network or a timeout also stop the walk at once. Throws GarminError: ticket_rejected, exchange_failed,
 * rate_limited, network, timeout, parse.
 */
export async function redeemServiceTicket(
  fetchImpl: FetchLike,
  ticket: string,
  options: RedeemOptions = {},
): Promise<GarminTokens> {
  const clientIds = options.clientIds ?? DI_CLIENT_IDS;
  const statuses: string[] = [];

  for (const clientId of clientIds) {
    const req = buildTicketExchangeRequest(clientId, ticket, options.serviceUrl);
    let result: Awaited<ReturnType<typeof fetchWithTimeout>>;
    try {
      result = await fetchWithTimeout(fetchImpl, req.url, req.init, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    } catch (e) {
      throw transportError(e);
    }
    const { response, text } = result;

    if (response.status >= 200 && response.status < 300) {
      const parsed = parseRawTokenResponse(text);
      if (!parsed) throw new GarminError({ kind: 'parse', message: 'the token service returned no access token' });
      // Without a refresh token the session would die within the hour with no way back: fail the sign-in instead.
      if (!parsed.refresh_token) {
        throw new GarminError({
          kind: 'exchange_failed',
          message: 'Garmin issued an access token but no refresh token',
          userMessage: 'Garmin signed you in but did not issue a long-lived session. Try again.',
        });
      }
      return {
        diToken: parsed.access_token,
        diRefreshToken: parsed.refresh_token,
        diClientId: clientIdFromJwt(parsed.access_token) ?? clientId,
      };
    }

    if (/invalid service ticket/i.test(text)) throw new GarminError({ kind: 'ticket_rejected', status: response.status });
    if (response.status === 429) {
      const retryAfter = retryAfterSeconds(response);
      throw new GarminError({ kind: 'rate_limited', status: 429, ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}) });
    }
    statuses.push(`HTTP ${response.status}`);
  }

  throw new GarminError({
    kind: 'exchange_failed',
    message: `the ticket exchange failed for every known client id (${statuses.join(', ')})`,
  });
}
