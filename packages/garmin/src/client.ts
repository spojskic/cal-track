// HTTP client for the Garmin Personal API. Client-side only: the API key belongs to one person and must stay on that
// person's device (Garmin ToS). Uses only `fetch`, timers and AbortController, so it runs on Hermes and Node 22.
// The key is sent to exactly one URL (the token endpoint); data calls carry only the short-lived bearer token.

import {
  API_KEY_PREFIX,
  DEFAULT_TIMEOUT_MS,
  GARMIN_BASE_URL,
  PATHS,
  RATE_LIMIT,
  TOKEN_LIFETIME_SEC,
  TOKEN_PATH,
  TOKEN_REFRESH_MARGIN_SEC,
} from './constants';
import { classifyHttpError, GarminError, isFatalAuthError, redactSecrets, toGarminError } from './errors';
import { decodeJwtExp } from './jwt';
import { mapUserSettings, type GarminUserSettings } from './mappers';

/** The slice of `Response` the client needs. The global `Response` satisfies it. */
export interface ResponseLike {
  status: number;
  headers?: { get(name: string): string | null } | null;
  text(): Promise<string>;
}

export interface FetchInit {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  signal?: AbortSignal;
}

/** `fetch` (or a fake). */
export type FetchLike = (url: string, init: FetchInit) => Promise<ResponseLike>;

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue>;

export interface GarminLogEvent {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  method?: string;
  /** Path only (no query string), never a header. */
  path?: string;
  status?: number;
  waitMs?: number;
}

export interface GarminClientOptions {
  /** The Personal API key (starts with GCDC_). Never logged, never sent anywhere but the token endpoint. */
  apiKey: string;
  fetch?: FetchLike;
  /** Defaults to the global host; use GARMIN_BASE_URL_CN for China. */
  baseUrl?: string;
  /** Clock in epoch milliseconds. Injectable for tests. */
  now?: () => number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Per-request timeout. Default 30 s. */
  timeoutMs?: number;
  /** Receives redacted diagnostic events. Errors thrown by the callback are ignored. */
  onLog?: (event: GarminLogEvent) => void;
  /** Override the client-side request budget (default 90 requests per rolling 60 s). */
  budget?: { maxRequests?: number; windowMs?: number };
}

export interface TokenInfo {
  /** Epoch ms when the current JWT expires. */
  expiresAtMs: number;
  /** True when this call exchanged the key for a new token. */
  refreshed: boolean;
}

export type GarminValidation =
  | ({ ok: true; tokenExpiresAtMs: number; profileError?: GarminError } & GarminUserSettings)
  | { ok: false; error: GarminError };

/** What endpoints.ts / sync.ts need from a client (lets tests pass a fake). */
export interface GarminDataClient {
  get<T = unknown>(path: string, params?: QueryParams): Promise<T | null>;
}

export interface GarminClient extends GarminDataClient {
  /** Exchanges the key for a JWT when there is none or less than 60 minutes of validity remain. */
  ensureToken(opts?: { force?: boolean }): Promise<TokenInfo>;
  /** GET returning parsed JSON; `null` for 204 / empty body. Non-JSON bodies come back as the raw string. */
  get<T = unknown>(path: string, params?: QueryParams): Promise<T | null>;
  /** GET returning the body as text; `null` for 204 / empty body. */
  getText(path: string, params?: QueryParams): Promise<string | null>;
  /** Checks the key (token exchange) and reads the account name. Never throws. */
  validate(): Promise<GarminValidation>;
  /** HTTP requests actually sent so far (token calls and retries included). */
  getRequestCount(): number;
}

const NEW_TOKEN_GRACE_MS = 5 * 60_000;
const MIN_USABLE_SEC = 30;

function stripKey(raw: unknown): string {
  let k = typeof raw === 'string' ? raw.trim() : '';
  if (k.length >= 2 && (k[0] === '"' || k[0] === "'") && k[k.length - 1] === k[0]) k = k.slice(1, -1).trim();
  return k;
}

/** Local check that a string looks like a Personal API key. Never sends anything. */
export function looksLikeGarminApiKey(raw: unknown): boolean {
  const k = stripKey(raw);
  return k.startsWith(API_KEY_PREFIX) && k.length > API_KEY_PREFIX.length && !/\s/.test(k);
}

function buildUrl(baseUrl: string, path: string, params?: QueryParams): string {
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
  return baseUrl + path + (parts.length ? `${path.includes('?') ? '&' : '?'}${parts.join('&')}` : '');
}

/** The token endpoint answers with the bare JWT. Be lenient about quotes / a JSON wrapper. */
function extractToken(body: string): string | null {
  let t = body.trim();
  if (t.startsWith('{')) {
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      const v = obj.token ?? obj.accessToken ?? obj.access_token ?? obj.jwt ?? obj.id_token;
      if (typeof v !== 'string') return null;
      t = v.trim();
    } catch {
      return null;
    }
  }
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') t = t.slice(1, -1).trim();
  return /^[A-Za-z0-9._~+/=-]{20,}$/.test(t) ? t : null;
}

interface RawResponse {
  status: number;
  text: string;
  contentType: string;
  retryAfterHeaderSec?: number;
}

export function createGarminClient(options: GarminClientOptions): GarminClient {
  const apiKey = stripKey(options.apiKey);
  const baseUrl = (options.baseUrl ?? GARMIN_BASE_URL).replace(/\/+$/, '');
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const budgetMax = Math.max(1, options.budget?.maxRequests ?? RATE_LIMIT.clientBudgetPerWindow);
  const budgetWindowMs = Math.max(1, options.budget?.windowMs ?? RATE_LIMIT.windowMs);
  const fetchImpl: FetchLike =
    options.fetch ??
    ((url, init) => {
      const g = (globalThis as { fetch?: FetchLike }).fetch;
      if (typeof g !== 'function') {
        return Promise.reject(new GarminError({ kind: 'network', message: 'fetch is not available in this runtime' }));
      }
      return g(url, init);
    });

  // Every secret this client has seen: scrubbed from all messages and log events.
  const secrets = new Set<string>(apiKey ? [apiKey] : []);
  const redact = (s: string): string => redactSecrets(s, [...secrets]);
  const makeError = (init: ConstructorParameters<typeof GarminError>[0]): GarminError =>
    new GarminError({ ...init, secrets: [...secrets, ...(init.secrets ?? [])] });

  const log = (event: GarminLogEvent): void => {
    if (!options.onLog) return;
    try {
      options.onLog({ ...event, message: redact(event.message) });
    } catch {
      // A broken logger must not break requests.
    }
  };

  interface TokenRecord {
    value: string;
    expSec: number;
    issuedAtMs: number;
  }
  let token: TokenRecord | null = null;
  let inflight: Promise<TokenRecord> | null = null;
  let keyWorked = false;
  let requestCount = 0;
  let stamps: number[] = [];

  async function acquireSlot(): Promise<void> {
    for (let i = 0; i < 1000; i++) {
      const t = now();
      stamps = stamps.filter((s) => s > t - budgetWindowMs && s <= t);
      if (stamps.length < budgetMax) {
        stamps.push(t);
        return;
      }
      const waitMs = Math.max(1, (stamps[0] as number) + budgetWindowMs - t);
      log({ level: 'debug', message: 'request budget reached; waiting', waitMs });
      await sleep(waitMs);
    }
    stamps.push(now());
  }

  async function sendRaw(method: 'GET' | 'POST', path: string, url: string, headers: Record<string, string>): Promise<RawResponse> {
    await acquireSlot();
    requestCount += 1;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller?.abort();
        reject(new Error('timeout'));
      }, timeoutMs);
    });
    try {
      const work = (async (): Promise<RawResponse> => {
        const res = await fetchImpl(url, { method, headers, ...(controller ? { signal: controller.signal } : {}) });
        const text = await res.text();
        const ra = res.headers?.get?.('retry-after');
        const raNum = ra !== null && ra !== undefined && ra.trim() !== '' ? Number(ra) : NaN;
        return {
          status: res.status,
          text: typeof text === 'string' ? text : '',
          contentType: res.headers?.get?.('content-type') ?? '',
          ...(Number.isFinite(raNum) && raNum >= 0 ? { retryAfterHeaderSec: raNum } : {}),
        };
      })();
      work.catch(() => undefined); // avoid an unhandled rejection when the timeout wins the race
      const raw = await Promise.race([work, timeout]);
      log({ level: 'debug', message: `${method} ${path} -> ${raw.status}`, method, path, status: raw.status });
      return raw;
    } catch (e) {
      if (timedOut) {
        log({ level: 'warn', message: `${method} ${path} timed out`, method, path });
        throw makeError({ kind: 'timeout', message: `request timed out after ${timeoutMs} ms`, detail: path });
      }
      const reason = e instanceof Error ? e.message : String(e);
      log({ level: 'warn', message: `${method} ${path} failed: ${reason}`, method, path });
      throw makeError({ kind: 'network', message: `network error: ${reason.slice(0, 200)}`, detail: path });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  function rateLimitWaitSec(raw: RawResponse, phase: 'token' | 'data', path: string): { waitSec: number; error: GarminError } {
    const error = classifyHttpError({
      status: 429,
      bodyText: raw.text,
      phase,
      path,
      secrets: [...secrets],
      ...(raw.retryAfterHeaderSec !== undefined ? { retryAfterHeaderSec: raw.retryAfterHeaderSec } : {}),
    });
    const asked = error.retryAfterSeconds ?? RATE_LIMIT.defaultWaitSec;
    return { waitSec: Math.min(Math.max(asked, 0), RATE_LIMIT.maxWaitSec), error };
  }

  async function exchangeToken(): Promise<TokenRecord> {
    if (!looksLikeGarminApiKey(apiKey)) {
      throw makeError({
        kind: 'invalid_key',
        message: 'API key is empty or does not start with GCDC_',
        userMessage: `That does not look like a Garmin Personal API key (it should start with ${API_KEY_PREFIX}). Copy the whole key from Garmin Connect.`,
      });
    }
    let retries = 0;
    for (;;) {
      const raw = await sendRaw('POST', TOKEN_PATH, baseUrl + TOKEN_PATH, {
        Authorization: `ApiKey ${apiKey}`,
        Accept: '*/*',
      });
      if (raw.status >= 200 && raw.status < 300) {
        const value = extractToken(raw.text);
        if (!value) {
          throw makeError({
            kind: 'unexpected',
            status: raw.status,
            message: 'token endpoint returned a body that is not a token',
            detail: TOKEN_PATH,
          });
        }
        secrets.add(value);
        let expSec: number;
        try {
          expSec = decodeJwtExp(value);
        } catch {
          expSec = now() / 1000 + TOKEN_LIFETIME_SEC;
          log({ level: 'warn', message: 'token expiry could not be read; assuming the documented 24 h lifetime' });
        }
        const record: TokenRecord = { value, expSec, issuedAtMs: now() };
        token = record;
        keyWorked = true;
        log({ level: 'info', message: 'Garmin token obtained', path: TOKEN_PATH });
        return record;
      }
      if (raw.status === 429) {
        const { waitSec, error } = rateLimitWaitSec(raw, 'token', TOKEN_PATH);
        if (retries < RATE_LIMIT.maxRetries) {
          retries += 1;
          log({ level: 'warn', message: `rate limited on token call; waiting ${waitSec} s`, path: TOKEN_PATH, status: 429, waitMs: waitSec * 1000 });
          await sleep(waitSec * 1000);
          continue;
        }
        throw error;
      }
      throw classifyHttpError({
        status: raw.status,
        bodyText: raw.text,
        phase: 'token',
        keyWorkedBefore: keyWorked,
        path: TOKEN_PATH,
        secrets: [...secrets],
      });
    }
  }

  function tokenUsable(): boolean {
    if (!token) return false;
    const t = now();
    const remaining = token.expSec - t / 1000;
    if (remaining > TOKEN_REFRESH_MARGIN_SEC) return true;
    // A token that was short-lived from the start (key about to expire) must not be re-fetched on every call.
    return t - token.issuedAtMs < NEW_TOKEN_GRACE_MS && remaining > MIN_USABLE_SEC;
  }

  async function acquireToken(force = false): Promise<{ record: TokenRecord; refreshed: boolean }> {
    if (force) token = null;
    if (token && tokenUsable()) return { record: token, refreshed: false };
    if (!inflight) {
      inflight = exchangeToken().finally(() => {
        inflight = null;
      });
    }
    return { record: await inflight, refreshed: true };
  }

  async function ensureToken(opts?: { force?: boolean }): Promise<TokenInfo> {
    const { record, refreshed } = await acquireToken(opts?.force === true);
    return { expiresAtMs: record.expSec * 1000, refreshed };
  }

  function parseBody(raw: RawResponse, path: string): unknown {
    const text = raw.text;
    const trimmed = text.trim();
    if (raw.status === 204 || trimmed === '') return null;
    const jsonType = /json/i.test(raw.contentType);
    const looksJson = /^[[{"]/.test(trimmed) || /^(null|true|false|-?\d)/.test(trimmed);
    if (!jsonType && !looksJson) return text;
    try {
      return JSON.parse(trimmed);
    } catch {
      if (jsonType) {
        throw makeError({ kind: 'unexpected', status: raw.status, message: 'response was not valid JSON', detail: path });
      }
      return text;
    }
  }

  async function request(path: string, params: QueryParams | undefined, mode: 'json' | 'text'): Promise<unknown> {
    const url = buildUrl(baseUrl, path, params);
    let rateRetries = 0;
    let authRetried = false;
    for (;;) {
      const { record: used } = await acquireToken();
      const raw = await sendRaw('GET', path, url, { Authorization: `Bearer ${used.value}`, Accept: '*/*' });

      if (raw.status >= 200 && raw.status < 300) {
        if (mode === 'text') return raw.status === 204 || raw.text.trim() === '' ? null : raw.text;
        return parseBody(raw, path);
      }
      if (raw.status === 401 && !authRetried) {
        authRetried = true;
        if (token && token.value === used.value) token = null;
        log({ level: 'info', message: 'token rejected (401); fetching a new one and retrying once', path, status: 401 });
        continue;
      }
      if (raw.status === 429) {
        const { waitSec, error } = rateLimitWaitSec(raw, 'data', path);
        if (rateRetries < RATE_LIMIT.maxRetries) {
          rateRetries += 1;
          log({ level: 'warn', message: `rate limited; waiting ${waitSec} s`, path, status: 429, waitMs: waitSec * 1000 });
          await sleep(waitSec * 1000);
          continue;
        }
        throw error;
      }
      throw classifyHttpError({ status: raw.status, bodyText: raw.text, phase: 'data', path, secrets: [...secrets] });
    }
  }

  async function validate(): Promise<GarminValidation> {
    let info: TokenInfo;
    try {
      info = await ensureToken();
    } catch (e) {
      return { ok: false, error: toGarminError(e, [...secrets]) };
    }
    try {
      const profile = await request(PATHS.userSettings, undefined, 'json');
      return { ok: true, tokenExpiresAtMs: info.expiresAtMs, ...mapUserSettings(profile) };
    } catch (e) {
      const error = toGarminError(e, [...secrets]);
      if (isFatalAuthError(error)) return { ok: false, error };
      // The key itself works (token exchange succeeded); only the profile read failed (e.g. no USER_READ scope).
      return { ok: true, tokenExpiresAtMs: info.expiresAtMs, profileError: error };
    }
  }

  return {
    ensureToken,
    get: async <T = unknown>(path: string, params?: QueryParams): Promise<T | null> =>
      (await request(path, params, 'json')) as T | null,
    getText: async (path: string, params?: QueryParams): Promise<string | null> =>
      (await request(path, params, 'text')) as string | null,
    validate,
    getRequestCount: () => requestCount,
  };
}
