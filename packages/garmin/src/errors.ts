// Typed errors with friendly messages and a hard redaction guarantee: no GarminError message, userMessage, detail or
// serialisation can contain a Garmin access token, a refresh token or a sign-in ticket. Redaction runs in the
// constructor, so even a message built by a caller from a failing fetch implementation is scrubbed.

export type GarminErrorKind =
  /** The token endpoint refused the refresh token (HTTP 400 / 401): the session is dead, the user must sign in again. */
  | 'session_dead'
  /** A data call stayed 401 after a fresh token: stop, do not loop. */
  | 'unauthorized'
  /** HTTP 429 after the retries: stop the run and try again later. */
  | 'rate_limited'
  /** The auth host answered with another client error (403 and so on): probably a block, not a dead session. */
  | 'blocked'
  /** The single-use sign-in ticket was already used or expired. */
  | 'ticket_rejected'
  /** No known client id accepted the ticket (Garmin probably rotated them). */
  | 'exchange_failed'
  /** A data endpoint answered with another non-success status (404, 403, ...). */
  | 'http'
  /** 5xx after the retries. */
  | 'server'
  | 'network'
  | 'timeout'
  /** The body was not the JSON that was expected. */
  | 'parse'
  /** A rotated token pair could not be saved. */
  | 'storage'
  | 'bad_request'
  | 'unexpected';

const REDACTED = '[redacted]';

/** Shapes that look like secrets even when the exact secret is unknown. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(Bearer|Basic)\s+[A-Za-z0-9_.~+/=-]+/gi,
  /eyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*){0,2}/g,
  // CAS service tickets: ST-123456-abcDEF...-cas
  /\bST-[A-Za-z0-9._-]{6,}/g,
  /\b(ticket|refresh_token|access_token|service_ticket)=[^&\s"']+/gi,
];

/** Replaces every exact secret (and anything shaped like a bearer token / JWT / ticket) in `text`. */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (m) => {
      const head = /^(Bearer|Basic)\s/i.exec(m);
      if (head) return `${head[1]} ${REDACTED}`;
      const param = /^([a-z_]+)=/i.exec(m);
      return param ? `${param[1]}=${REDACTED}` : REDACTED;
    });
  }
  return out;
}

export const USER_MESSAGES: Record<GarminErrorKind, string> = {
  session_dead: 'Garmin signed you out (the session expired or was revoked). Sign in to Garmin again.',
  unauthorized: 'Garmin did not accept the fresh access token. Try again later; if it keeps failing, sign in again.',
  rate_limited: 'Garmin asked the app to slow down. The sync will try again later.',
  blocked: 'Garmin refused the request (HTTP 403). It may be blocking this connection. Try again later.',
  ticket_rejected: 'Garmin rejected the sign-in ticket: it had already been used or it expired. Sign in again.',
  exchange_failed: 'Garmin did not accept the sign-in on any known app id. Garmin has probably changed its sign-in; this needs an app update.',
  http: 'Garmin answered with an error for this request.',
  server: 'Garmin is having trouble right now. Try again later.',
  network: 'Could not reach Garmin. Check your internet connection and try again.',
  timeout: 'Garmin took too long to respond. Try again.',
  parse: 'Garmin returned something this app cannot read.',
  storage: 'The new Garmin sign-in could not be saved on this phone. Try again.',
  bad_request: 'The app built an invalid Garmin request. This is a bug in the app.',
  unexpected: 'Something unexpected went wrong while talking to Garmin.',
};

const RETRYABLE: Record<GarminErrorKind, boolean> = {
  session_dead: false,
  unauthorized: false,
  rate_limited: true,
  blocked: false,
  ticket_rejected: false,
  exchange_failed: false,
  http: false,
  server: true,
  network: true,
  timeout: true,
  parse: false,
  storage: false,
  bad_request: false,
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
  /** Short extra context (e.g. the endpoint name). Redacted and truncated. */
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
  readonly detail?: string;

  constructor(init: GarminErrorInit) {
    const secrets = init.secrets ?? [];
    const clean = (s: string): string => redactSecrets(s, secrets);
    const userMessage = clean(init.userMessage ?? USER_MESSAGES[init.kind]);
    const fallback = `${init.kind}${init.status !== undefined ? ` (HTTP ${init.status})` : ''}: ${userMessage}`;
    super(clean(init.message ?? fallback));
    this.name = 'GarminError';
    this.kind = init.kind;
    if (init.status !== undefined) this.status = init.status;
    if (init.retryAfterSeconds !== undefined) this.retryAfterSeconds = init.retryAfterSeconds;
    this.userMessage = userMessage;
    this.retryable = init.retryable ?? RETRYABLE[init.kind];
    if (init.detail !== undefined) this.detail = clean(String(init.detail)).slice(0, 240);
    // Deliberately no `cause`: the original error could carry a token.
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
      detail: this.detail,
      message: this.message,
    };
  }
}

export function isGarminError(e: unknown): e is GarminError {
  return e instanceof GarminError;
}

/**
 * Errors that make every further request of a run pointless (or harmful): stop the whole run.
 * A dead session, a token Garmin keeps refusing, a 429, a dropped network and a failed token save all end the run.
 * Everything else (404, 403 on one endpoint, one 5xx, a body that is not JSON) only affects that one request.
 */
export function isFatalForRun(e: unknown): boolean {
  if (!(e instanceof GarminError)) return false;
  return (
    e.kind === 'session_dead' ||
    e.kind === 'unauthorized' ||
    e.kind === 'rate_limited' ||
    e.kind === 'network' ||
    e.kind === 'timeout' ||
    e.kind === 'storage'
  );
}

/**
 * Garmin answers 404 / 403 / 204 for a day with nothing recorded (watch not worn, no sleep, no HRV): that is "no data",
 * not a problem.
 */
export function isNoData(e: unknown): boolean {
  return e instanceof GarminError && e.kind === 'http' && (e.status === 404 || e.status === 403 || e.status === 204);
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
  message?: string;
}

/** Never throws. Accepts the raw body text; keeps at most a short error code / message. */
export function parseErrorBody(text: string | null | undefined): ParsedErrorBody {
  if (!text) return {};
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return {};
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const message = obj.error ?? obj.error_description ?? obj.message ?? obj.errorMessage;
    return typeof message === 'string' ? { message: message.slice(0, 120) } : {};
  } catch {
    return {};
  }
}
