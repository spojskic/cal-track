// Test helpers (not exported from index.ts).

import type { FetchInit, FetchLike, ResponseLike } from './client';

/** base64url of a UTF-8 string (test-only; uses the DOM btoa available in Node 22). */
export function b64url(s: string): string {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function makeJwt(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.c2lnbmF0dXJlLXNpZ25hdHVyZQ`;
}

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

export function createFakeFetch(handler: (call: FakeCall) => FakeReply | Promise<FakeReply>): {
  fetch: FetchLike;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: FakeCall = { url, init, n: calls.length };
    calls.push(call);
    const r = await handler(call);
    if (r instanceof Error) throw r;
    return toResponse(r);
  };
  return { fetch, calls };
}

export function createClock(startMs = Date.UTC(2026, 10, 10, 12, 0, 0)) {
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

export const KEY = 'GCDC_SUPERSECRETKEY0123456789';

import type { GarminDataClient, QueryParams } from './client';

export interface FakeClientCall {
  path: string;
  params: QueryParams | undefined;
  n: number;
}

type Route = [match: string | RegExp, handler: (call: FakeClientCall) => unknown];

/** A GarminDataClient with scripted responses. A handler may return a value, or an Error to make the call fail. */
export function createFakeClient(routes: Route[]): GarminDataClient & { calls: FakeClientCall[]; paths(): string[] } {
  const calls: FakeClientCall[] = [];
  const client = {
    calls,
    paths: () => calls.map((c) => c.path),
    get: async <T = unknown>(path: string, params?: QueryParams): Promise<T | null> => {
      const call: FakeClientCall = { path, params, n: calls.length };
      calls.push(call);
      const route = routes.find(([m]) => (typeof m === 'string' ? m === path : m.test(path)));
      if (!route) return null;
      const v = route[1](call);
      if (v instanceof Error) throw v;
      return (v ?? null) as T | null;
    },
  };
  return client;
}
