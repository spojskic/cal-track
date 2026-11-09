// Typed errors with friendly messages and a hard redaction guarantee: no GarminError message, userMessage, detail or
// serialisation can contain the API key or a bearer token. Redaction runs in the constructor, so even a message built
// by a caller from a failing fetch implementation is scrubbed.

export type GarminErrorKind =
  | 'invalid_key'
  | 'key_expired_or_revoked'
  | 'unauthorized'
  | 'rate_limited'
  | 'not_acceptable'
  | 'bad_request'
  | 'server'
  | 'network'
  | 'timeout'
  | 'unexpected';

const REDACTED = '[redacted]';

/** Shapes that look like secrets even when the exact secret is unknown. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /GCDC_[A-Za-z0-9_.~+/=-]*/g,
  /\b(Bearer|ApiKey)\s+[A-Za-z0-9_.~+/=-]+/gi,
  /eyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*){0,2}/g,
];

/** Replaces every exact secret (and anything shaped like a key / bearer token / JWT) in `text`. */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (m) => {
      const head = /^(Bearer|ApiKey)\s/i.exec(m);
      return head ? `${head[1]} ${REDACTED}` : REDACTED;
    });
  }
  return out;
}

export const USER_MESSAGES = {
  invalid_key:
    'Garmin rejected this key. Create a new Personal API key in Garmin Connect (it may have expired or been deleted).',
  key_expired_or_revoked:
    'This Garmin key has expired or was revoked. Create a new Personal API key in Garmin Connect and paste it here.',
  unauthorized: 'Garmin did not accept the access token. Try again; if it keeps failing, create a new Personal API key.',
  forbidden:
    'Your Garmin key does not have permission for this data. Create a new key that includes fitness, wellness and user read access.',
  rate_limited: 'Garmin is limiting requests right now. Wait a minute and try again.',
  not_acceptable: 'Garmin rejected the format of the request (HTTP 406). This is a bug in the app.',
  bad_request: 'Garmin could not process this request. Check the dates and try again.',
  server: 'Garmin is having trouble right now. Try again later.',
  network: 'Could not reach Garmin. Check your internet connection and try again.',
  timeout: 'Garmin took too long to respond. Try again.',
  unexpected: 'Garmin returned something unexpected. Try again later.',
} as const;

const RETRYABLE: Record<GarminErrorKind, boolean> = {
  invalid_key: false,
  key_expired_or_revoked: false,
  unauthorized: false,
  rate_limited: true,
  not_acceptable: false,
  bad_request: false,
  server: true,
  network: true,
  timeout: true,
  unexpected: false,
};

export interface GarminErrorInit {
  kind: GarminErrorKind;
  status?: number;
  retryAfterSeconds?: number;
  /** Friendly text for the end user. Defaults per kind. */
  userMessage?: string;
  /** Developer text. Defaults to a summary built from kind/status. */
  message?: string;
  /** Garmin's `errorId`, when the error body had one. */
  errorId?: string;
  /** Short extra context (e.g. the endpoint). Redacted and truncated. */
  detail?: string;
  retryable?: boolean;
  /** Exact secrets to scrub in addition to the built-in patterns. Never stored. */
  secrets?: readonly string[];
}

export class GarminError extends Error {
  readonly kind: GarminErrorKind;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  readonly userMessage: string;
  readonly retryable: boolean;
  readonly errorId?: string;
  readonly detail?: string;

  constructor(init: GarminErrorInit) {
    const secrets = init.secrets ?? [];
    const clean = (s: string): string => redactSecrets(s, secrets);
    const userMessage = clean(
      init.userMessage ?? (init.kind === 'unauthorized' && init.status === 403 ? USER_MESSAGES.forbidden : USER_MESSAGES[init.kind]),
    );
    const fallback = `${init.kind}${init.status !== undefined ? ` (HTTP ${init.status})` : ''}: ${userMessage}`;
    super(clean(init.message ?? fallback));
    this.name = 'GarminError';
    this.kind = init.kind;
    if (init.status !== undefined) this.status = init.status;
    if (init.retryAfterSeconds !== undefined) this.retryAfterSeconds = init.retryAfterSeconds;
    this.userMessage = userMessage;
    this.retryable = init.retryable ?? RETRYABLE[init.kind];
    if (init.errorId !== undefined) this.errorId = clean(String(init.errorId)).slice(0, 80);
    if (init.detail !== undefined) this.detail = clean(String(init.detail)).slice(0, 240);
    // Deliberately no `cause`: the original error could carry the key or a token.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      kind: this.kind,
      status: this.status,
      retryAfterSeconds: this.retryAfterSeconds,
      userMessage: this.userMessage,
      retryable: this.retryable,
      errorId: this.errorId,
      detail: this.detail,
      message: this.message,
    };
  }
}

export function isGarminError(e: unknown): e is GarminError {
  return e instanceof GarminError;
}

/**
 * True for errors that make every further call pointless: the key/token is wrong. A 403 on a data call (key lacks the
 * scope for ONE endpoint) is NOT fatal, so partial syncs can continue with the other endpoints.
 */
export function isFatalAuthError(e: unknown): boolean {
  if (!(e instanceof GarminError)) return false;
  if (e.kind === 'invalid_key' || e.kind === 'key_expired_or_revoked') return true;
  return e.kind === 'unauthorized' && e.status !== 403;
}

/** Wraps anything thrown into a GarminError (already-typed errors pass through). */
export function toGarminError(e: unknown, secrets: readonly string[] = []): GarminError {
  if (e instanceof GarminError) return e;
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return new GarminError({
    kind: 'unexpected',
    message: `unexpected error${raw ? `: ${raw.slice(0, 200)}` : ''}`,
    secrets,
  });
}

/** What the client reads out of a (JSON) error body. */
export interface ParsedErrorBody {
  errorId?: string;
  message?: string;
  retryInSeconds?: number;
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Never throws. Accepts the raw body text. */
export function parseErrorBody(text: string | null | undefined): ParsedErrorBody {
  if (!text) return {};
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return trimmed ? { message: trimmed.slice(0, 200) } : {};
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const out: ParsedErrorBody = {};
    const errorId = obj.errorId ?? obj.error_id ?? obj.errorCode;
    if (typeof errorId === 'string' || typeof errorId === 'number') out.errorId = String(errorId);
    const message = obj.message ?? obj.error ?? obj.errorMessage;
    if (typeof message === 'string') out.message = message.slice(0, 200);
    const retry = toNumber(obj.retryInSeconds ?? obj.retry_in_seconds ?? obj.retryAfterSeconds);
    if (retry !== undefined && retry >= 0) out.retryInSeconds = retry;
    return out;
  } catch {
    return { message: trimmed.slice(0, 200) };
  }
}

export interface ClassifyHttpErrorInput {
  status: number;
  bodyText?: string | null;
  /** Which call failed. */
  phase: 'token' | 'data';
  /** A token exchange already succeeded earlier with this key (so a rejection now means expiry/revocation). */
  keyWorkedBefore?: boolean;
  /** `Retry-After` header seconds, used when the body has no `retryInSeconds`. */
  retryAfterHeaderSec?: number;
  /** Request path, used as `detail`. */
  path?: string;
  secrets?: readonly string[];
}

/** Maps an HTTP failure to a GarminError. */
export function classifyHttpError(input: ClassifyHttpErrorInput): GarminError {
  const { status, phase, secrets } = input;
  const body = parseErrorBody(input.bodyText);
  const common = {
    status,
    errorId: body.errorId,
    detail: [input.path, body.message].filter(Boolean).join(' - ') || undefined,
    secrets,
  };

  if (status === 429) {
    const retryAfterSeconds = body.retryInSeconds ?? input.retryAfterHeaderSec;
    return new GarminError({ kind: 'rate_limited', ...common, retryAfterSeconds });
  }
  if (status === 406) return new GarminError({ kind: 'not_acceptable', ...common });
  if (status === 408) return new GarminError({ kind: 'timeout', ...common });

  if (phase === 'token') {
    if (status === 401 || status === 403 || status === 400) {
      const expired =
        input.keyWorkedBefore === true || /expired|revoked/i.test(`${body.message ?? ''} ${body.errorId ?? ''}`);
      return new GarminError({ kind: expired ? 'key_expired_or_revoked' : 'invalid_key', ...common });
    }
  } else {
    if (status === 401 || status === 403) return new GarminError({ kind: 'unauthorized', ...common });
  }

  if (status >= 500) return new GarminError({ kind: 'server', ...common });
  if (status >= 400) return new GarminError({ kind: 'bad_request', ...common });
  return new GarminError({
    kind: 'unexpected',
    ...common,
    message: `unexpected HTTP ${status}`,
  });
}
