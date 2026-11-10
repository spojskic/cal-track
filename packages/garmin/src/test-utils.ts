// Test helpers (not exported from index.ts). Nothing here ever touches the network: every `fetch` is a fake.

import type { FetchInit, FetchLike, ResponseLike } from './http';

/** base64url of a UTF-8 string (test-only; uses the btoa available in Node 22). */
export function b64url(s: string): string {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function makeJwt(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.c2lnbmF0dXJlLXNpZ25hdHVyZQ`;
}

/** 2026-11-10 12:00:00 UTC */
export const NOW_MS = Date.UTC(2026, 10, 10, 12, 0, 0);
export const NOW_SEC = NOW_MS / 1000;

export interface FakeCall {
  url: string;
  init: FetchInit;
  n: number;
}

export type FakeReply = { status: number; body?: string; headers?: Record<string, string> } | Error;

export function reply(status: number, body = '', headers: Record<string, string> = {}): FakeReply {
  return { status, body, headers };
}

export function json(status: number, value: unknown): FakeReply {
  return { status, body: JSON.stringify(value), headers: { 'content-type': 'application/json' } };
}

export function toResponse(r: { status: number; body?: string; headers?: Record<string, string> }): ResponseLike {
  const headers = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status: r.status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => r.body ?? '',
  };
}

/** A fake fetch that records every call and how many were in flight at once. */
export function createFakeFetch(handler: (call: FakeCall) => FakeReply | Promise<FakeReply>): {
  fetch: FetchLike;
  calls: FakeCall[];
  maxInFlight: () => number;
} {
  const calls: FakeCall[] = [];
  let inFlight = 0;
  let max = 0;
  const fetch: FetchLike = async (url, init) => {
    const call: FakeCall = { url, init, n: calls.length };
    calls.push(call);
    inFlight += 1;
    max = Math.max(max, inFlight);
    try {
      // Yield once so overlapping calls would really overlap.
      await Promise.resolve();
      const r = await handler(call);
      if (r instanceof Error) throw r;
      return toResponse(r);
    } finally {
      inFlight -= 1;
    }
  };
  return { fetch, calls, maxInFlight: () => max };
}

/** A clock whose sleep() advances time instantly and records every pause. */
export function createClock(startMs = NOW_MS) {
  const clock = {
    t: startMs,
    sleeps: [] as number[],
    now: () => clock.t,
    advance(ms: number) {
      clock.t += ms;
    },
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
      clock.t += ms;
    },
  };
  return clock;
}

/** An access token that expires `inSec` seconds after NOW. */
export function accessToken(inSec: number, extra: Record<string, unknown> = {}): string {
  return makeJwt({ exp: NOW_SEC + inSec, client_id: 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2', ...extra });
}

export const REFRESH_TOKEN = 'refresh-token-SECRET-0123456789';
export const TICKET = 'ST-1234567-aBcDeFgHiJkLmNoPqRs-cas';

/** Parses an application/x-www-form-urlencoded body into an object. */
export function parseForm(body: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (body ?? '').split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
  }
  return out;
}

/** Reference base64 of a UTF-8 string, computed with the platform's btoa. */
export function referenceBase64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}
