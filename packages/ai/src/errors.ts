/**
 * Typed errors for the OpenRouter layer.
 *
 * Nothing in here ever holds the API key or request headers. `redactSecrets`
 * is applied to every message that originates outside this package (network
 * errors, response bodies) before it is stored on an error.
 */

export type OpenRouterErrorKind =
  | 'auth'
  | 'credits'
  | 'moderation'
  | 'rate_limit'
  | 'timeout'
  | 'provider'
  | 'network'
  | 'invalid_output'
  | 'bad_request';

export interface OpenRouterErrorInit {
  kind: OpenRouterErrorKind;
  message?: string;
  status?: number;
  userMessage?: string;
  retryable?: boolean;
  /** Provider/OpenRouter error code from the body (number or string). */
  code?: number | string;
  /** Safe, redacted metadata from the error body (e.g. moderation reasons). */
  details?: unknown;
  retryAfterMs?: number;
  cause?: unknown;
}

const DEFAULT_USER_MESSAGES: Record<OpenRouterErrorKind, string> = {
  auth: 'Your OpenRouter key was rejected. Reconnect OpenRouter or paste a new key in Settings.',
  credits: 'Your OpenRouter credits are exhausted. Add credits at openrouter.ai/credits.',
  moderation:
    'OpenRouter blocked this request (content moderation or a key/guardrail restriction). Try a different photo or wording, or check your key settings at openrouter.ai.',
  rate_limit: 'OpenRouter is rate limiting requests. Wait a moment and try again.',
  timeout: 'The AI request timed out. Check your connection and try again.',
  provider:
    'The AI provider is temporarily unavailable. Try again in a moment or pick a different model.',
  network: 'Could not reach OpenRouter. Check your internet connection and try again.',
  invalid_output:
    'The AI returned a reply that could not be understood. Try again or pick a different model.',
  bad_request:
    'OpenRouter rejected the request. Try a different model or simplify your input.',
};

const DEFAULT_RETRYABLE: Record<OpenRouterErrorKind, boolean> = {
  auth: false,
  credits: false,
  moderation: false,
  rate_limit: true,
  timeout: true,
  provider: true,
  network: true,
  invalid_output: true,
  bad_request: false,
};

export class OpenRouterError extends Error {
  readonly kind: OpenRouterErrorKind;
  readonly status?: number;
  /** Friendly, actionable text that is safe to show in the UI. */
  readonly userMessage: string;
  /** True when trying the same request again later could succeed. */
  readonly retryable: boolean;
  readonly code?: number | string;
  readonly details?: unknown;
  /** Parsed `Retry-After` in milliseconds, when the server sent one. */
  readonly retryAfterMs?: number;

  constructor(init: OpenRouterErrorInit) {
    super(redactSecrets(init.message ?? init.userMessage ?? DEFAULT_USER_MESSAGES[init.kind]));
    this.name = 'OpenRouterError';
    this.kind = init.kind;
    this.status = init.status;
    this.userMessage = init.userMessage ?? DEFAULT_USER_MESSAGES[init.kind];
    this.retryable = init.retryable ?? DEFAULT_RETRYABLE[init.kind];
    this.code = init.code;
    this.details = init.details;
    this.retryAfterMs = init.retryAfterMs;
    if (init.cause !== undefined) {
      // Assigned manually: ES2022 `cause` option typing varies between libs.
      (this as { cause?: unknown }).cause = init.cause;
    }
  }

  /** Never serialises anything that could contain credentials. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      kind: this.kind,
      status: this.status,
      message: this.message,
      userMessage: this.userMessage,
      retryable: this.retryable,
    };
  }
}

export function isOpenRouterError(e: unknown): e is OpenRouterError {
  return e instanceof OpenRouterError;
}

/** The AI answered, but the photo has no readable nutrition label (not a label, or nothing could be read from it). */
export class NoLabelFoundError extends Error {
  constructor(
    message = 'No nutrition label was found in this photo. Photograph the Nutrition Facts table straight on, close enough to read it, in good light, with the whole table in view.',
  ) {
    super(message);
    this.name = 'NoLabelFoundError';
  }
}

export function isNoLabelFoundError(e: unknown): e is NoLabelFoundError {
  return e instanceof NoLabelFoundError;
}

/** Error thrown when the caller's AbortSignal fires. Mirrors DOM `AbortError`. */
export class AbortError extends Error {
  constructor(message = 'The operation was aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export function isAbortError(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { name?: unknown }).name === 'AbortError'
  );
}

const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const KEY_RE = /sk-or-[A-Za-z0-9_-]+/g;
const AUTH_HEADER_RE = /(authorization["']?\s*[:=]\s*["']?)[^"',}\s]+(\s+[^"',}\s]+)?/gi;

/**
 * Removes anything that looks like an OpenRouter key or an Authorization value
 * from free text. Pass `extraSecrets` (e.g. the live API key) for an exact match.
 */
export function redactSecrets(text: string, ...extraSecrets: Array<string | undefined>): string {
  let out = String(text);
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join('[redacted]');
  }
  return out
    .replace(AUTH_HEADER_RE, '$1[redacted]')
    .replace(BEARER_RE, 'Bearer [redacted]')
    .replace(KEY_RE, 'sk-or-[redacted]');
}

/** Returns a copy of headers that is safe to print. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = /^(authorization|x-api-key|cookie)$/i.test(k) ? '[redacted]' : v;
  }
  return out;
}

interface ParsedErrorBody {
  message?: string;
  code?: number | string;
  metadata?: unknown;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Pulls `{error:{code,message,metadata}}` (or a bare `{message}`) out of a parsed body. */
export function parseErrorBody(body: unknown): ParsedErrorBody {
  const root = asRecord(body);
  if (!root) return typeof body === 'string' && body ? { message: body.slice(0, 500) } : {};
  const err = asRecord(root.error) ?? root;
  const message = typeof err.message === 'string' ? err.message : undefined;
  const code =
    typeof err.code === 'number' || typeof err.code === 'string' ? err.code : undefined;
  return { message, code, metadata: err.metadata };
}

/** Parses a `Retry-After` header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.max(0, Math.round(parseFloat(trimmed) * 1000));
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

function moderationReasons(metadata: unknown): string | undefined {
  const m = asRecord(metadata);
  if (!m) return undefined;
  const reasons = Array.isArray(m.reasons)
    ? m.reasons.filter((r): r is string => typeof r === 'string')
    : [];
  return reasons.length ? reasons.slice(0, 5).join(', ') : undefined;
}

export interface ErrorFromResponseOptions {
  status: number;
  body?: unknown;
  retryAfterMs?: number;
  apiKey?: string;
}

/** Maps an HTTP status (+ optional OpenRouter error body) to a typed error. */
export function errorFromResponse(opts: ErrorFromResponseOptions): OpenRouterError {
  const { status } = opts;
  const parsed = parseErrorBody(opts.body);
  const rawMessage = redactSecrets(parsed.message ?? `HTTP ${status}`, opts.apiKey);
  const base = {
    status,
    message: `OpenRouter ${status}: ${rawMessage}`,
    code: parsed.code,
    retryAfterMs: opts.retryAfterMs,
  };

  if (status === 401) return new OpenRouterError({ ...base, kind: 'auth' });
  if (status === 402) return new OpenRouterError({ ...base, kind: 'credits' });
  if (status === 403) {
    const reasons = moderationReasons(parsed.metadata);
    return new OpenRouterError({
      ...base,
      kind: 'moderation',
      details: parsed.metadata ? safeDetails(parsed.metadata) : undefined,
      userMessage: reasons
        ? `OpenRouter blocked this request (${reasons}). Try a different photo or wording, or check your key settings at openrouter.ai.`
        : undefined,
    });
  }
  if (status === 408) return new OpenRouterError({ ...base, kind: 'timeout' });
  if (status === 429) return new OpenRouterError({ ...base, kind: 'rate_limit' });
  if (status >= 500) return new OpenRouterError({ ...base, kind: 'provider' });

  // Remaining 4xx.
  if (status === 404 && /no endpoints? found/i.test(rawMessage)) {
    return new OpenRouterError({
      ...base,
      kind: 'bad_request',
      userMessage:
        'The selected model cannot handle this request (for example images or structured output). Pick a different model in Settings.',
    });
  }
  return new OpenRouterError({ ...base, kind: 'bad_request' });
}

/** Maps an error object that arrived inside a 200 response body or SSE chunk. */
export function errorFromBodyError(body: unknown, apiKey?: string): OpenRouterError {
  const parsed = parseErrorBody(body);
  const numeric =
    typeof parsed.code === 'number'
      ? parsed.code
      : typeof parsed.code === 'string' && /^\d{3}$/.test(parsed.code)
        ? parseInt(parsed.code, 10)
        : undefined;
  if (numeric !== undefined) {
    return errorFromResponse({ status: numeric, body, apiKey });
  }
  // String codes such as "server_error" / "rate_limit_exceeded".
  const code = String(parsed.code ?? '').toLowerCase();
  const message = redactSecrets(parsed.message ?? 'Unknown provider error', apiKey);
  let kind: OpenRouterErrorKind = 'provider';
  if (/rate/.test(code)) kind = 'rate_limit';
  else if (/auth|invalid_api_key/.test(code)) kind = 'auth';
  else if (/quota|credit|insufficient/.test(code)) kind = 'credits';
  else if (/moderat|content_filter|safety/.test(code)) kind = 'moderation';
  else if (/timeout/.test(code)) kind = 'timeout';
  else if (/invalid_request|bad_request/.test(code)) kind = 'bad_request';
  return new OpenRouterError({
    kind,
    message: `OpenRouter stream error: ${message}`,
    code: parsed.code,
  });
}

function safeDetails(metadata: unknown): unknown {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(metadata)));
  } catch {
    return undefined;
  }
}
