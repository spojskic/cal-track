// GET-only client for the Garmin Connect mobile-app interface (connectapi.garmin.com). Mirrors the reference project
// (garmin-companion: crates/garmin-core/src/client.rs) without its one write method (create_workout is NOT ported).
//
// - Bearer token + the native Android app headers; the token is refreshed before it expires (120 s early) and once more
//   when Garmin answers 401 anyway. A rotated refresh token is handed to `onTokensChanged` (persist it, awaited).
// - 429 / 5xx / dropped connections: up to 3 attempts, 1 s then 3 s apart, a Retry-After header wins (capped at 30 s).
// - An empty 200 body is how Garmin says "nothing recorded" (HRV on a night the watch was not worn): `empty: true`.
// - PACING: this is an undocumented API and the user's real account. Every request goes through one queue, so requests
//   are sequential even when callers do not wait for each other, and they start at least `spacingMs` apart.
// - Only `fetch`, timers and AbortController are used: runs on Hermes and Node 22. No global state, no storage.
//
// Method names are the only way to reach Garmin: there is no generic "send" and no method parameter. Data requests are
// GET by construction, and `assertReadOnly` double-checks URL and method right before `fetch` is called.

import { refreshTokens } from './auth';
import {
  BACKOFF_MS,
  CONNECT_API_BASE,
  MAX_ATTEMPTS,
  NATIVE_HEADERS,
  PATHS,
  REQUEST_SPACING_MS,
  REQUEST_TIMEOUT_MS,
  RETRY_AFTER_CAP_SEC,
} from './constants';
import { GarminError, redactSecrets, toGarminError } from './errors';
import { fetchWithTimeout, realSleep, retryAfterSeconds, type FetchLike, type QueryParams, type SleepFn } from './http';
import { isTokenExpired, type GarminTokens } from './tokens';

/** What a data request answered. `empty`: a 200 / 204 with no body (or a JSON null) = "no data". */
export interface GarminReply {
  status: number;
  empty: boolean;
  data: unknown;
}

export interface GarminConnectClientOptions {
  fetch: FetchLike;
  tokens: GarminTokens;
  /**
   * Called whenever the token pair changes (every refresh). Garmin may rotate the refresh token, so the new pair MUST be
   * persisted; the call is awaited, and a failure ends the request with a `storage` error.
   */
  onTokensChanged?: (tokens: GarminTokens) => void | Promise<void>;
  /** Clock in epoch milliseconds. Injectable for tests. */
  now?: () => number;
  /** Injectable for tests. */
  sleep?: SleepFn;
  /** Minimum time between the starts of two requests. Default 250 ms. */
  spacingMs?: number;
  timeoutMs?: number;
}

/** Throws unless this is a plain GET to the Connect API host. The last line of defence before `fetch`. */
export function assertReadOnly(method: string, url: string): void {
  if (method !== 'GET') throw new GarminError({ kind: 'bad_request', message: `refusing a ${method} request to a data endpoint` });
  if (!url.startsWith(`${CONNECT_API_BASE}/`)) {
    throw new GarminError({ kind: 'bad_request', message: 'refusing a request outside the Garmin Connect API host' });
  }
}

/** The numeric id of an activity as the digits that go into a path. Throws GarminError(bad_request) for anything else. */
export function activityIdOf(id: string | number): string {
  const text = typeof id === 'number' ? (Number.isSafeInteger(id) ? String(id) : '') : String(id).trim();
  if (!/^\d{1,19}$/.test(text)) {
    throw new GarminError({ kind: 'bad_request', message: 'the Garmin activity id must be a number' });
  }
  return text;
}

function buildUrl(path: string, params?: QueryParams): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('://') || /[\s\\]/.test(path)) {
    throw new GarminError({ kind: 'bad_request', message: 'request path must be a relative path starting with "/"' });
  }
  const parts: string[] = [];
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }
  return CONNECT_API_BASE + path + (parts.length ? `?${parts.join('&')}` : '');
}

/** Pause before the next attempt: 1 s, then 3 s. A Retry-After value wins, capped. */
export function backoffMs(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec !== undefined) return Math.min(retryAfterSec, RETRY_AFTER_CAP_SEC) * 1000;
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 3000;
}

const RETRYABLE_KINDS = new Set(['network', 'timeout', 'rate_limited', 'server']);

interface RawAnswer {
  status: number;
  text: string;
}

export class GarminConnectClient {
  private tokens: GarminTokens;
  private readonly fetchImpl: FetchLike;
  private readonly onTokensChanged: ((tokens: GarminTokens) => void | Promise<void>) | undefined;
  private readonly now: () => number;
  private readonly pause: SleepFn;
  private readonly spacingMs: number;
  private readonly timeoutMs: number;
  /** The queue: every public call runs after the previous one has finished. */
  private chain: Promise<unknown> = Promise.resolve();
  private lastStartMs: number | null = null;
  private requestCount = 0;

  constructor(options: GarminConnectClientOptions) {
    this.tokens = options.tokens;
    this.fetchImpl = options.fetch;
    this.onTokensChanged = options.onTokensChanged;
    this.now = options.now ?? (() => Date.now());
    this.pause = options.sleep ?? realSleep;
    this.spacingMs = options.spacingMs ?? REQUEST_SPACING_MS;
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : REQUEST_TIMEOUT_MS;
  }

  /** The current token pair (changes after a refresh). Never log it. */
  getTokens(): GarminTokens {
    return this.tokens;
  }

  /** HTTP requests actually sent so far (token calls and retries included). */
  getRequestCount(): number {
    return this.requestCount;
  }

  // ---- the GET endpoints ----------------------------------------------------------------------------------------

  /** `displayName` of the account, which several wellness endpoints need in their path. */
  profile(): Promise<GarminReply> {
    return this.get(PATHS.profile);
  }

  /** Daily wellness rollup (kcal, steps, resting HR, stress, body battery). */
  userSummary(displayName: string, date: string): Promise<GarminReply> {
    return this.get(PATHS.userSummary(displayName), { calendarDate: date });
  }

  /** One night of sleep, keyed by the day the athlete woke up. */
  sleep(displayName: string, date: string): Promise<GarminReply> {
    return this.get(PATHS.sleep(displayName), { date, nonSleepBufferMinutes: 60 });
  }

  /** Overnight HRV. An empty 200 means the watch was not worn. */
  hrv(date: string): Promise<GarminReply> {
    return this.get(PATHS.hrv(date));
  }

  /** Every weigh-in between two dates, inclusive. */
  weightRange(startDate: string, endDate: string): Promise<GarminReply> {
    return this.get(PATHS.weightRange, { startDate, endDate });
  }

  /** Most recent activities, newest first. */
  activities(start: number, limit: number): Promise<GarminReply> {
    return this.get(PATHS.activities, { start, limit });
  }

  // ---- one activity (workout detail) ----------------------------------------------------------------------------
  // All GET, all through the same queue and pacing as everything else. `id` is the numeric Garmin activity id (the number
  // after `garmin:activity:` in exercise_entries.external_id); anything else is refused before a request is built.

  /** Full detail of one activity, including the `summaryDTO` block (reference: client.rs `activity`). */
  activity(id: string | number): Promise<GarminReply> {
    return this.activityGet(id, PATHS.activity);
  }

  /** Time in each heart-rate zone (reference: client.rs `hr_time_in_zones`). */
  activityHrZones(id: string | number): Promise<GarminReply> {
    return this.activityGet(id, PATHS.activityHrZones);
  }

  /** Set-by-set record of a strength session (reference: client.rs `activity_exercise_sets`). */
  activityExerciseSets(id: string | number): Promise<GarminReply> {
    return this.activityGet(id, PATHS.activitySets);
  }

  /** Per-lap splits (reference: client.rs `activity_splits`). */
  activitySplits(id: string | number): Promise<GarminReply> {
    return this.activityGet(id, PATHS.activitySplits);
  }

  // ---- internals ------------------------------------------------------------------------------------------------

  private activityGet(id: string | number, path: (id: string) => string): Promise<GarminReply> {
    let target: string;
    try {
      target = path(activityIdOf(id));
    } catch (e) {
      return Promise.reject(toGarminError(e));
    }
    return this.get(target);
  }

  /** One GET through the queue. */
  private get(path: string, query?: QueryParams): Promise<GarminReply> {
    const run = this.chain.then(
      () => this.getNow(path, query),
      () => this.getNow(path, query),
    );
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async getNow(path: string, query?: QueryParams): Promise<GarminReply> {
    const url = buildUrl(path, query);
    try {
      let refreshed = false;
      if (isTokenExpired(this.tokens, this.now())) {
        await this.refresh();
        refreshed = true;
      }
      for (;;) {
        const answer = await this.withRetries(() => this.attempt(url));
        if (answer.status === 401) {
          // A token we believed valid was refused (clock skew, or Garmin invalidated it): refresh once and ask again.
          if (refreshed) throw new GarminError({ kind: 'unauthorized', status: 401, secrets: this.secrets() });
          await this.refresh();
          refreshed = true;
          continue;
        }
        return this.interpret(answer);
      }
    } catch (e) {
      throw toGarminError(e, this.secrets());
    }
  }

  private secrets(): string[] {
    return [this.tokens.diToken, this.tokens.diRefreshToken];
  }

  /** Waits so that two requests never start closer together than `spacingMs`. */
  private async pace(): Promise<void> {
    if (this.lastStartMs !== null) {
      const wait = this.lastStartMs + this.spacingMs - this.now();
      if (wait > 0) await this.pause(wait);
    }
    this.lastStartMs = this.now();
  }

  /** One HTTP attempt. 429 and 5xx are thrown (so they can be retried); every other status is returned. */
  private async attempt(url: string): Promise<RawAnswer> {
    await this.pace();
    assertReadOnly('GET', url);
    this.requestCount += 1;
    let result: Awaited<ReturnType<typeof fetchWithTimeout>>;
    try {
      result = await fetchWithTimeout(
        this.fetchImpl,
        url,
        {
          method: 'GET',
          headers: { ...NATIVE_HEADERS, Authorization: `Bearer ${this.tokens.diToken}`, Accept: 'application/json' },
        },
        this.timeoutMs,
      );
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      throw new GarminError({
        kind: aborted ? 'timeout' : 'network',
        message: aborted ? 'request to Garmin timed out' : 'request to Garmin failed',
      });
    }
    const { response, text } = result;
    if (response.status === 429) {
      const retryAfter = retryAfterSeconds(response);
      throw new GarminError({ kind: 'rate_limited', status: 429, ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}) });
    }
    if (response.status >= 500) {
      const retryAfter = retryAfterSeconds(response);
      throw new GarminError({ kind: 'server', status: response.status, ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}) });
    }
    return { status: response.status, text };
  }

  /** Runs `op` up to MAX_ATTEMPTS times for network errors, timeouts, 429 and 5xx. */
  private async withRetries<T>(op: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (e) {
        if (attempt < MAX_ATTEMPTS && e instanceof GarminError && RETRYABLE_KINDS.has(e.kind)) {
          await this.pause(backoffMs(attempt, e.retryAfterSeconds));
          continue;
        }
        throw e;
      }
    }
  }

  /** Refreshes the token pair (with the same retry rules) and hands the new pair to `onTokensChanged`. */
  private async refresh(): Promise<void> {
    const fresh = await this.withRetries(async () => {
      await this.pace();
      this.requestCount += 1;
      return refreshTokens(this.fetchImpl, this.tokens, { timeoutMs: this.timeoutMs });
    });
    this.tokens = fresh;
    if (this.onTokensChanged) {
      try {
        await this.onTokensChanged(fresh);
      } catch {
        // The new pair is only in memory now: if it was not saved, the next run may have no valid refresh token.
        throw new GarminError({ kind: 'storage', message: 'the refreshed Garmin tokens could not be saved' });
      }
    }
  }

  private interpret(answer: RawAnswer): GarminReply {
    const { status, text } = answer;
    if (status >= 200 && status < 300) {
      if (status === 204 || text.trim() === '') return { status, empty: true, data: null };
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        // Never put the body into the error: it is the user's health data.
        throw new GarminError({ kind: 'parse', status, message: `Garmin answered HTTP ${status} with a body that is not JSON` });
      }
      return data === null ? { status, empty: true, data: null } : { status, empty: false, data };
    }
    throw new GarminError({
      kind: 'http',
      status,
      message: redactSecrets(`Garmin answered HTTP ${status}`, this.secrets()),
    });
  }
}
