// Reads the details of a Garmin workout (heart rate, zones, strength sets, laps) when they are needed, and saves them into the
// workout row. Device side, every effect injected (clock, storage, tokens, network, database), so the flow is unit tested in Node
// (tools/db-tests/src/app-garmin-details.test.ts) and Garmin is never called by a test.
//
// When this runs (docs/features.md "Workouts"):
//   - the workout screen / the coach opens a Garmin workout whose details are missing, only the list summary, or older than a day
//     while the workout is still recent: `ensureGarminDetails`
//   - after a sync, quietly for the newest Garmin workouts that have no full details: `pickQuietTargets` + `ensureGarminDetails`
// It follows the rules of the sync: GET only, one request at a time (the shared gate, garmin-gate.ts), a 429 is remembered in the same
// phone-local state the sync reads (no run starts before the time Garmin asked for), a dead session deletes the phone's tokens and
// marks the integration "needs sign-in".
//
// Pure: imports nothing from react-native / expo / supabase.
import {
  addDetailRun,
  fetchActivityDetails,
  garminActivityIdOf,
  needsGarminDetails,
  parseWorkoutDetails,
  type DetailStats,
  type GarminActivitySource,
  type GarminTokens,
  type WorkoutDetails,
} from '@cal/garmin';

import { formatClock, isRateLimited, parseGarminSettings, rateLimitedUntil, serializeGarminSettings, type GarminLocalState } from './garmin';
import type { GarminIntegrationPatch, GarminIntegrationRow } from './garmin-sync';
import { errorText } from './sync';

/** The slice of a workout row the detail read needs. */
export interface DetailTarget {
  /** exercise_entries.id */
  id: string;
  name: string;
  source: string;
  external_id: string | null;
  entry_date: string;
  started_at: string | null;
  /** The stored `details` value, whatever it is. */
  details: unknown;
}

export interface GarminDetailDeps {
  now(): number;
  userId(): Promise<string | null>;
  integration: {
    load(userId: string): Promise<GarminIntegrationRow | null>;
    save(userId: string, patch: GarminIntegrationPatch): Promise<GarminIntegrationRow>;
  };
  tokens: {
    load(userId: string): Promise<GarminTokens | null>;
    save(userId: string, tokens: GarminTokens): Promise<void>;
    clear(): Promise<void>;
  };
  /** The phone-local Garmin state the sync also uses (only the rate-limit time is read and written here). */
  local: {
    load(): Promise<GarminLocalState>;
    save(patch: Partial<GarminLocalState>): Promise<void>;
  };
  /** What "Copy sync report" prints about the detail reads. */
  stats: {
    load(): Promise<DetailStats>;
    save(stats: DetailStats): Promise<void>;
  };
  createClient(tokens: GarminTokens, onTokensChanged: (tokens: GarminTokens) => Promise<void>): GarminActivitySource;
  /** Writes `exercise_entries.details` of the workout. */
  saveDetails(id: string, details: WorkoutDetails): Promise<void>;
}

export type DetailSkipReason = 'not_garmin' | 'fresh' | 'signed_out' | 'not_connected' | 'needs_sign_in' | 'rate_limited' | 'unavailable';
export type DetailFailCode = 'needs_sign_in' | 'rate_limited' | 'network' | 'write_failed' | 'other';

export type DetailOutcome =
  | { status: 'skipped'; reason: DetailSkipReason; message: string }
  | { status: 'done'; details: WorkoutDetails }
  | { status: 'failed'; code: DetailFailCode; message: string };

const PREFIX = 'Could not read the details from Garmin.';

/** What the screen says when the details could not be read. Plain sentences, no secrets. */
export const DETAIL_MESSAGES = {
  needs_sign_in: `${PREFIX} Open Connected apps to sign in again.`,
  not_connected: `${PREFIX} Garmin is not signed in on this phone. Open Connected apps to connect it.`,
  signed_out: 'You are signed out. Please sign in again.',
  network: `${PREFIX} Check your internet connection and try again.`,
  other: `${PREFIX} Try again later.`,
  write_failed: 'The details were read from Garmin but could not be saved. Try again.',
  unavailable: 'Garmin details can only be read in the iPhone and Android app.',
  not_garmin: 'This workout does not come from Garmin.',
  fresh: 'The details are up to date.',
} as const;

export function rateLimitedMessage(untilMs: number | null): string {
  return untilMs !== null
    ? `${PREFIX} Garmin asked the app to slow down. Try again after ${formatClock(untilMs)}.`
    : `${PREFIX} Garmin asked the app to slow down. Try again later.`;
}

const skip = (reason: DetailSkipReason, message: string): DetailOutcome => ({ status: 'skipped', reason, message });

/**
 * Reads the details of one Garmin workout and stores them. Skips (without any request) when the row is not a Garmin workout, when
 * its details are fresh enough (`force` overrides that), when nobody is signed in, when Garmin is not connected on this phone, when
 * the session is known to be dead, or while Garmin's "slow down" time has not passed. Never throws.
 */
export async function ensureGarminDetails(deps: GarminDetailDeps, target: DetailTarget, options: { force?: boolean } = {}): Promise<DetailOutcome> {
  const activityId = target.source === 'garmin' ? garminActivityIdOf(target.external_id) : null;
  if (activityId === null) return skip('not_garmin', DETAIL_MESSAGES.not_garmin);
  if (!options.force && !needsGarminDetails(target, deps.now())) return skip('fresh', DETAIL_MESSAGES.fresh);

  try {
    const userId = await deps.userId();
    if (!userId) return skip('signed_out', DETAIL_MESSAGES.signed_out);

    const row = await deps.integration.load(userId);
    if (!row?.enabled) return skip('not_connected', DETAIL_MESSAGES.not_connected);
    const settings = parseGarminSettings(row.settings);
    if (settings.needsSignIn) return skip('needs_sign_in', DETAIL_MESSAGES.needs_sign_in);

    const tokens = await deps.tokens.load(userId);
    if (!tokens) return skip('not_connected', DETAIL_MESSAGES.not_connected);

    const local = await deps.local.load();
    if (isRateLimited(local.rateLimitedUntilMs, deps.now())) {
      return skip('rate_limited', rateLimitedMessage(local.rateLimitedUntilMs));
    }

    const client = deps.createClient(tokens, (fresh) => deps.tokens.save(userId, fresh));
    const result = await fetchActivityDetails({
      client,
      activityId,
      nowMs: deps.now(),
      base: parseWorkoutDetails(target.details),
      name: target.name,
    });

    // The report section ("Copy sync report"): endpoint outcomes and field names, never a value.
    try {
      await deps.stats.save(addDetailRun(await deps.stats.load(), result.report, result.stop, deps.now()));
    } catch {
      // a statistics problem must never hide the details
    }

    if (result.status === 'stopped' && result.stop) {
      const stop = result.stop;
      if (stop.kind === 'session_dead') {
        await deps.tokens.clear().catch(() => undefined);
        await deps.integration
          .save(userId, { settings: serializeGarminSettings({ ...settings, needsSignIn: true }, row.settings) })
          .catch(() => undefined);
        return { status: 'failed', code: 'needs_sign_in', message: DETAIL_MESSAGES.needs_sign_in };
      }
      if (stop.kind === 'rate_limited') {
        const until = rateLimitedUntil(deps.now(), stop.retryAfterSec);
        await deps.local.save({ rateLimitedUntilMs: until }).catch(() => undefined);
        return { status: 'failed', code: 'rate_limited', message: rateLimitedMessage(until) };
      }
      if (stop.kind === 'network' || stop.kind === 'timeout') return { status: 'failed', code: 'network', message: DETAIL_MESSAGES.network };
      return { status: 'failed', code: 'other', message: DETAIL_MESSAGES.other };
    }

    if (!result.details) return { status: 'failed', code: 'other', message: DETAIL_MESSAGES.other };
    try {
      await deps.saveDetails(target.id, result.details);
    } catch (e) {
      return { status: 'failed', code: 'write_failed', message: `${DETAIL_MESSAGES.write_failed} (${errorText(e)})` };
    }
    return { status: 'done', details: result.details };
  } catch (e) {
    // fetchActivityDetails never throws; this is a storage / database problem before or after it. The message never contains a token.
    return { status: 'failed', code: 'other', message: `${DETAIL_MESSAGES.other} (${errorText(e)})` };
  }
}

/** Failures after which the next workout is not tried either (the same reasons that end a sync). */
export function endsBatch(outcome: DetailOutcome): boolean {
  return (
    (outcome.status === 'failed' && outcome.code !== 'write_failed' && outcome.code !== 'other') ||
    (outcome.status === 'skipped' && outcome.reason !== 'fresh' && outcome.reason !== 'not_garmin')
  );
}

export interface QuietCandidate {
  id: string;
  name: string;
  source: string;
  external_id: string | null;
  entry_date: string;
  started_at: string | null;
  details: unknown;
}

/**
 * The newest Garmin workouts that have no FULL details yet (nothing stored, or only the list summary), at most `limit`. The input
 * is newest first (as fetchNewestGarminWorkouts returns it) and keeps its order.
 */
export function pickQuietTargets<T extends QuietCandidate>(rows: readonly T[], limit = 3): T[] {
  const picked: T[] = [];
  for (const row of rows) {
    if (picked.length >= limit) break;
    if (row.source !== 'garmin' || garminActivityIdOf(row.external_id) === null) continue;
    const details = parseWorkoutDetails(row.details);
    if (details && details.level !== 'summary') continue;
    picked.push(row);
  }
  return picked;
}
