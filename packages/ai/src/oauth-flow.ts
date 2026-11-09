/**
 * Pure helpers for the OpenRouter "Connect" return trip on WEB.
 *
 * The web flow redirects the whole page to openrouter.ai and OpenRouter redirects back to
 * `callback_url?code=...`. The app keeps the PKCE verifier (+ our `state`) in sessionStorage; these
 * helpers decide what an incoming URL means. No platform APIs here, so they are unit tested.
 *
 * `state` handling: OpenRouter documents `code_challenge`/`callback_url` but not `state`. We still send
 * it, and when the callback echoes one it MUST match. When it is absent the code is still bound to our
 * PKCE verifier (a forged code fails the exchange), so we do not reject a missing `state`.
 */

import { parseAuthCallback } from './pkce';

/** What the app remembers between "open openrouter.ai" and "back on our page". */
export interface PendingOAuth {
  verifier: string;
  state: string;
  /** ms since epoch when the flow started. */
  startedAt: number;
  /** Whether the user wants the resulting key remembered on this device. */
  persist: boolean;
}

export type OAuthReturn =
  /** The URL is not an OAuth return (or there is nothing pending): ignore it. */
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  | { kind: 'code'; code: string; verifier: string; persist: boolean };

/** OpenRouter codes live 10 minutes; allow a little slack. */
export const OAUTH_MAX_AGE_MS = 12 * 60 * 1000;

function queryOf(url: string): string {
  const hashIdx = url.indexOf('#');
  const noHash = hashIdx === -1 ? url : url.slice(0, hashIdx);
  const qIdx = noHash.indexOf('?');
  return qIdx === -1 ? '' : noHash.slice(qIdx + 1);
}

function hasParam(url: string, name: string): boolean {
  return queryOf(url)
    .split('&')
    .some((pair) => pair === name || pair.startsWith(`${name}=`));
}

/** True when the URL carries an OAuth `code` or `error` query parameter. */
export function looksLikeOAuthReturn(url: string): boolean {
  return hasParam(url, 'code') || hasParam(url, 'error');
}

/** Interprets a page URL that may be OpenRouter's redirect back to us. */
export function resolveOAuthReturn(
  url: string,
  pending: PendingOAuth | null,
  now: number = Date.now(),
  maxAgeMs: number = OAUTH_MAX_AGE_MS,
): OAuthReturn {
  if (!looksLikeOAuthReturn(url)) return { kind: 'none' };
  // A code/error with no flow in progress is a stale reload of the return URL: ignore it quietly.
  if (!pending) return { kind: 'none' };
  if (now - pending.startedAt > maxAgeMs) {
    return { kind: 'error', message: 'The sign-in took too long and expired. Please connect OpenRouter again.' };
  }
  const parsed = parseAuthCallback(url);
  if (!parsed.ok) return { kind: 'error', message: parsed.message };
  if (parsed.state !== undefined && parsed.state !== '' && parsed.state !== pending.state) {
    return { kind: 'error', message: 'The sign-in response did not match this request. Please start again.' };
  }
  return { kind: 'code', code: parsed.code, verifier: pending.verifier, persist: pending.persist };
}

/** Removes `code`, `state`, `error*` query parameters, keeping the rest of the URL intact. */
export function stripOAuthParams(url: string): string {
  const hashIdx = url.indexOf('#');
  const hash = hashIdx === -1 ? '' : url.slice(hashIdx);
  const noHash = hashIdx === -1 ? url : url.slice(0, hashIdx);
  const qIdx = noHash.indexOf('?');
  if (qIdx === -1) return url;
  const base = noHash.slice(0, qIdx);
  const kept = noHash
    .slice(qIdx + 1)
    .split('&')
    .filter((pair) => {
      if (!pair) return false;
      const name = pair.split('=')[0] ?? '';
      return !(name === 'code' || name === 'state' || name === 'error' || name.startsWith('error_'));
    });
  return `${base}${kept.length ? `?${kept.join('&')}` : ''}${hash}`;
}

/** `callback_url` for the web flow: this page's own origin + path (no query, no hash). */
export function callbackUrlFor(origin: string, pathname: string): string {
  const base = origin.replace(/\/+$/, '');
  const path = pathname && pathname.startsWith('/') ? pathname : `/${pathname ?? ''}`;
  return `${base}${path}`;
}
