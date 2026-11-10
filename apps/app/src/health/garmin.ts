// Direct Garmin link ("Connect Garmin"): pure helpers. Imports nothing from react-native / expo, so they are unit-tested in
// Node (tools/db-tests/src/app-garmin-pull.test.ts).
//
// How it works (docs/features.md): the phone signs in on Garmin's own page inside a web view, keeps the token Garmin issues in
// its secure storage, reads the user's data from Garmin itself with the same undocumented interface Garmin's own mobile app
// uses (packages/garmin), and saves it to the user's Cal Track account like the Apple Health / Health Connect sync does.
// Nothing is ever written to Garmin and no Garmin token ever leaves the phone.
import { addDays, localDateOfIso, maxDate, minDate } from './dates';
import type { DateRange, LocalDate } from './types';

// ---------------------------------------------------------------------------------------------------------------------
// Texts (shown on the card; kept here so tests can pin them)
// ---------------------------------------------------------------------------------------------------------------------

export const GARMIN_WEB_NOTE =
  'Garmin sync runs in the iPhone and Android app. Browsers cannot read Garmin directly, so open Cal Track on your phone to connect.';

export const GARMIN_HOW_IT_WORKS =
  "You sign in on Garmin's own page. Cal Track never sees your password, only the token Garmin issues, which is kept in this phone's secure storage. Your phone reads your data from Garmin and saves it to your Cal Track account. Nothing is written to Garmin.";

export const GARMIN_UNOFFICIAL_NOTE =
  "This uses the same private interface as Garmin's own mobile app. It is not an official Garmin integration, so it can stop working when Garmin changes it.";

export const GARMIN_IMPORTS_NOTE =
  'Imports calories burned (active and resting), steps, resting heart rate, stress, body battery, sleep, HRV, weight, body fat and workouts. Connecting reads the last 14 days; every sync after that re-reads the last few days.';

export const GARMIN_SIGNED_OUT_NOTE =
  'Garmin signed this phone out (the session expired or was revoked), so the sync stopped. Sign in to Garmin again to continue. Data already imported stays.';

// ---------------------------------------------------------------------------------------------------------------------
// Settings stored in integrations.settings (jsonb) of the provider = 'garmin' row. Never a token.
// ---------------------------------------------------------------------------------------------------------------------

export interface GarminSettings {
  connectedAt: string | null;
  /** The refresh was refused (HTTP 400 / 401): the session is dead and the user has to sign in again. */
  needsSignIn: boolean;
  /** Result sentence of the last sync that wrote something, e.g. '14 days of energy, 3 workouts'. */
  lastSummary: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseGarminSettings(raw: unknown): GarminSettings {
  const obj = isRecord(raw) ? raw : {};
  return {
    connectedAt: typeof obj.connected_at === 'string' ? obj.connected_at : null,
    needsSignIn: obj.needs_sign_in === true,
    lastSummary: typeof obj.last_summary === 'string' && obj.last_summary ? obj.last_summary : null,
  };
}

/** Merges `settings` over the raw jsonb so keys this code does not know are kept. */
export function serializeGarminSettings(settings: GarminSettings, base: unknown = {}): Record<string, unknown> {
  const out: Record<string, unknown> = isRecord(base) ? { ...base } : {};
  if (settings.connectedAt) out.connected_at = settings.connectedAt;
  else delete out.connected_at;
  out.needs_sign_in = settings.needsSignIn;
  if (settings.lastSummary) out.last_summary = settings.lastSummary;
  else delete out.last_summary;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Connection state of the card
// ---------------------------------------------------------------------------------------------------------------------

export type GarminConnectionState =
  /** A browser: Garmin cannot be read from here (CORS), the card only explains. */
  | 'web'
  | 'not_connected'
  | 'connected'
  /** The session is dead (or the token is gone from this phone after it died). */
  | 'needs_sign_in';

export interface GarminRowLike {
  enabled: boolean;
  settings: unknown;
}

/**
 * The tokens live in THIS phone's secure storage and nowhere else, so an enabled row alone proves nothing: a second phone
 * with the same account has the row but no tokens and must offer "Connect Garmin" itself.
 */
export function deriveGarminState(input: { native: boolean; row: GarminRowLike | null; hasTokens: boolean }): GarminConnectionState {
  if (!input.native) return 'web';
  if (!input.row?.enabled) return 'not_connected';
  if (parseGarminSettings(input.row.settings).needsSignIn) return 'needs_sign_in';
  return input.hasTokens ? 'connected' : 'not_connected';
}

// ---------------------------------------------------------------------------------------------------------------------
// Which days a run reads
// ---------------------------------------------------------------------------------------------------------------------

export type GarminSyncMode = 'incremental' | 'backfill';

/** Right after signing in: this many days (today included). */
export const GARMIN_BACKFILL_DAYS = 14;
/** Every later run re-reads at least today and the two days before it (late uploads, last night's sleep). */
export const GARMIN_INCREMENTAL_DAYS = 3;
/** ...and reaches back to the last successful sync, but never further than this (three requests per day on a real account). */
export const GARMIN_MAX_INCREMENTAL_DAYS = 7;

export function planGarminRange(input: { mode: GarminSyncMode; today: LocalDate; lastSyncAt: string | null }): DateRange {
  const { today } = input;
  const backfillFrom = addDays(today, -(GARMIN_BACKFILL_DAYS - 1));
  if (input.mode === 'backfill' || !input.lastSyncAt) return { from: backfillFrom, to: today };
  let from = addDays(today, -(GARMIN_INCREMENTAL_DAYS - 1));
  const lastDay = localDateOfIso(input.lastSyncAt);
  // Days since the last good sync that were never read (the app was closed for a while): fill the hole, within the cap.
  if (lastDay) from = minDate(from, addDays(lastDay, -1));
  from = maxDate(from, addDays(today, -(GARMIN_MAX_INCREMENTAL_DAYS - 1)));
  return { from: minDate(from, today), to: today };
}

// ---------------------------------------------------------------------------------------------------------------------
// Rate limit (HTTP 429): stop the run, remember the time, try later
// ---------------------------------------------------------------------------------------------------------------------

export const RATE_LIMIT_DEFAULT_MS = 30 * 60_000;
export const RATE_LIMIT_MIN_MS = 5 * 60_000;
export const RATE_LIMIT_MAX_MS = 6 * 3_600_000;

/** Epoch ms until which no run starts. Garmin's Retry-After wins, within [5 min, 6 h]; without one, 30 minutes. */
export function rateLimitedUntil(nowMs: number, retryAfterSec?: number): number {
  const wanted = retryAfterSec === undefined ? RATE_LIMIT_DEFAULT_MS : retryAfterSec * 1000;
  return nowMs + Math.min(RATE_LIMIT_MAX_MS, Math.max(RATE_LIMIT_MIN_MS, wanted));
}

export const isRateLimited = (untilMs: number | null, nowMs: number): boolean => untilMs !== null && untilMs > nowMs;

/** True when the last run was at least `minIntervalMs` ago (or never). Used for the foreground throttle. */
export const isDueByInterval = (lastAtMs: number | null, nowMs: number, minIntervalMs: number): boolean =>
  lastAtMs === null || nowMs - lastAtMs >= minIntervalMs;

// ---------------------------------------------------------------------------------------------------------------------
// State kept on this phone only (AsyncStorage): not worth a database column and not secret
// ---------------------------------------------------------------------------------------------------------------------

export interface GarminLocalState {
  rateLimitedUntilMs: number | null;
  /** Plain-text report of the last sync: no values, no tokens (see packages/garmin report.ts). */
  report: string | null;
  reportAtMs: number | null;
  /** Why the last run did not finish, as a sentence. Cleared by the next complete run. */
  lastIssue: string | null;
}

export const EMPTY_LOCAL_STATE: GarminLocalState = { rateLimitedUntilMs: null, report: null, reportAtMs: null, lastIssue: null };

const finiteOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const textOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export function parseLocalState(raw: string | null | undefined): GarminLocalState {
  if (!raw) return EMPTY_LOCAL_STATE;
  try {
    const obj: unknown = JSON.parse(raw);
    if (!isRecord(obj)) return EMPTY_LOCAL_STATE;
    return {
      rateLimitedUntilMs: finiteOrNull(obj.rateLimitedUntilMs),
      report: textOrNull(obj.report),
      reportAtMs: finiteOrNull(obj.reportAtMs),
      lastIssue: textOrNull(obj.lastIssue),
    };
  } catch {
    return EMPTY_LOCAL_STATE;
  }
}

export const serializeLocalState = (state: GarminLocalState): string => JSON.stringify(state);

// ---------------------------------------------------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------------------------------------------------

export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The sentence for a run that ended early. `stop` is the package's GarminSyncStop (structural copy, no import). */
export function describeStop(stop: { kind: string; message: string }, until: number | null): string {
  switch (stop.kind) {
    case 'rate_limited':
      return until !== null
        ? `Garmin asked the app to slow down. Cal Track will try again after ${formatClock(until)}.`
        : 'Garmin asked the app to slow down. Cal Track will try again later.';
    case 'session_dead':
      return GARMIN_SIGNED_OUT_NOTE;
    case 'network':
    case 'timeout':
      return 'Could not reach Garmin. Check your internet connection; the next sync tries again.';
    default:
      return stop.message;
  }
}

/** What 'Copy sync report' says when there is nothing to copy yet. */
export const GARMIN_NO_REPORT = 'No sync has run on this phone yet, so there is no report. Tap Sync now first.';
