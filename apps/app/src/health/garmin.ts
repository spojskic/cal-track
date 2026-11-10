// Direct Garmin Connect link ("Connect Garmin"): feature flag and pure helpers. Imports nothing from react-native / expo,
// so it can be unit-tested in Node (tools/db-tests/src/app-garmin.test.ts).
//
// The server side lives in supabase/functions/garmin-* (see docs/garmin-integration.md). The feature ships dormant: nothing
// Garmin related renders or is called unless EXPO_PUBLIC_GARMIN_ENABLED=true was set when the app was built.

/**
 * Expo inlines `EXPO_PUBLIC_*` variables only when they are written exactly as `process.env.EXPO_PUBLIC_NAME`, so do not
 * refactor this into a lookup by name.
 */
export const GARMIN_ENABLED: boolean = process.env.EXPO_PUBLIC_GARMIN_ENABLED === 'true';

export const GARMIN_PAST_DATA_NOTE =
  'Garmin only sends data from the moment you connect; past days are not imported. Keep Garmin sharing with Apple Health / Health Connect on if you want older days.';

export const GARMIN_PRIVACY_NOTE =
  'While connected, Cal Track receives your Garmin daily summaries, workouts, sleep and body measurements. Disconnecting stops this and deletes the Garmin link; you can also delete the Garmin data that was already imported.';

// ---------------------------------------------------------------------------------------------------------------------
// Connection status (public.garmin_connection_status())
// ---------------------------------------------------------------------------------------------------------------------

export interface GarminStatus {
  connected: boolean;
  /** ISO timestamps (kept as strings so the persisted query cache can store them). */
  connectedAt: string | null;
  lastPushAt: string | null;
  /** Short machine code of the last problem (never a token or a payload). */
  lastError: string | null;
}

export const NOT_CONNECTED: GarminStatus = { connected: false, connectedAt: null, lastPushAt: null, lastError: null };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const asIso = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v) return null;
  return Number.isNaN(Date.parse(v)) ? null : v;
};

/** The RPC answers one row (as an array through PostgREST); anything unexpected means "not connected". */
export function parseGarminStatus(data: unknown): GarminStatus {
  const row = Array.isArray(data) ? data[0] : data;
  if (!isRecord(row) || row.connected !== true) return NOT_CONNECTED;
  return {
    connected: true,
    connectedAt: asIso(row.connected_at),
    lastPushAt: asIso(row.last_push_at),
    lastError: typeof row.last_error === 'string' && row.last_error ? row.last_error : null,
  };
}

/** Friendly text for `last_error`; null when there is nothing to show. */
export function describeLastError(code: string | null): string | null {
  if (!code) return null;
  if (code === 'apply_failed') {
    return 'The last Garmin update could not be saved. The next sync from your watch normally fixes this.';
  }
  return 'There was a problem with the last Garmin update. If it keeps happening, disconnect and connect again.';
}

// ---------------------------------------------------------------------------------------------------------------------
// Return from Garmin (?garmin=connected | ?garmin=error&reason=...)
// ---------------------------------------------------------------------------------------------------------------------

export type GarminReturn = { status: 'connected' } | { status: 'error'; reason: string };

type Param = string | string[] | undefined;
const firstParam = (p: Param): string | undefined => (Array.isArray(p) ? p[0] : p);

/** From router search params (web return) or any parsed query. null = nothing to report. */
export function parseGarminReturn(params: { garmin?: Param; reason?: Param }): GarminReturn | null {
  const status = firstParam(params.garmin);
  if (status === 'connected') return { status: 'connected' };
  if (status === 'error') {
    const reason = firstParam(params.reason);
    return { status: 'error', reason: reason && /^[a-z0-9_]{1,40}$/.test(reason) ? reason : 'unknown' };
  }
  return null;
}

/** From the URL that ends a native auth session, e.g. `caltrack://settings/integrations?garmin=connected`. */
export function parseGarminReturnUrl(url: string | undefined | null): GarminReturn | null {
  if (!url) return null;
  const q = url.indexOf('?');
  if (q === -1) return null;
  const hash = url.indexOf('#', q);
  const query = new URLSearchParams(url.slice(q + 1, hash === -1 ? undefined : hash));
  return parseGarminReturn({ garmin: query.get('garmin') ?? undefined, reason: query.get('reason') ?? undefined });
}

const REASON_TEXT: Record<string, string> = {
  access_denied: 'You did not allow Cal Track in Garmin, so nothing was connected.',
  authorization_failed: 'Garmin did not complete the sign-in. Please try again.',
  account_already_linked: 'This Garmin account is already linked to another Cal Track user.',
  not_configured: 'Garmin is not set up on the server yet.',
  missing_code: 'Garmin sign-in could not be completed. Please try again.',
  token_exchange_failed: 'Garmin sign-in could not be completed. Please try again; if it keeps failing the server setup may be incomplete.',
  token_response_invalid: 'Garmin sign-in could not be completed. Please try again; if it keeps failing the server setup may be incomplete.',
  user_id_failed: 'Garmin sign-in worked, but Cal Track could not read your Garmin account. Please try again later.',
  save_failed: 'Garmin sign-in worked, but the connection could not be saved. Please try again.',
};

export interface GarminMessage {
  tone: 'success' | 'danger';
  text: string;
}

export function describeGarminReturn(result: GarminReturn): GarminMessage {
  if (result.status === 'connected') {
    return { tone: 'success', text: 'Garmin is connected. Data arrives when your watch syncs with the Garmin Connect app.' };
  }
  return { tone: 'danger', text: REASON_TEXT[result.reason] ?? 'Garmin sign-in failed. Please try again.' };
}

// ---------------------------------------------------------------------------------------------------------------------
// Edge function failures (garmin-oauth-start / garmin-disconnect)
// ---------------------------------------------------------------------------------------------------------------------

/** `status` / `error` come from the function's JSON error body `{ error, message }`. */
export function describeGarminFunctionError(failure: { status: number | null; error?: string | null }): string {
  if (failure.status === null) return 'Could not reach the server. Check your connection and try again.';
  if (failure.error === 'garmin_not_configured') return 'Garmin is not set up on the server yet.';
  if (failure.status === 429 || failure.error === 'rate_limited') return 'Too many attempts. Wait a minute and try again.';
  if (failure.status === 404) return 'Garmin support is not deployed on the server yet.';
  if (failure.status === 401) return 'You are signed out. Please sign in again.';
  return 'Garmin could not be reached right now. Please try again.';
}

/** "last sync" wording of the card: never claims data that has not arrived. */
export function describeLastPush(lastPushAt: string | null, format: (d: Date) => string): string {
  if (!lastPushAt) return 'No data received yet. Sync your watch with the Garmin Connect app.';
  return format(new Date(lastPushAt));
}
