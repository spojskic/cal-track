// The Garmin pull sync, device side: turns what packages/garmin read into the rows the app already writes for health data
// (daily_energy, exercise_entries, biometrics, all with source = 'garmin'), and runs one whole sync with every effect
// (clock, storage, tokens, network, database) injected, so the flow is unit-tested in Node (tools/db-tests/src/app-garmin-pull.test.ts).
//
// Pure: imports nothing from react-native / expo / supabase.
import {
  formatSyncReport,
  runGarminSync,
  type GarminBatch,
  type GarminBiometric,
  type GarminDailyEnergy,
  type GarminSyncOutcome,
  type GarminSyncSource,
  type GarminTokens,
  type GarminWorkout,
} from '@cal/garmin';

import {
  GARMIN_SIGNED_OUT_NOTE,
  describeStop,
  formatClock,
  isRateLimited,
  parseGarminSettings,
  planGarminRange,
  rateLimitedUntil,
  serializeGarminSettings,
  type GarminLocalState,
  type GarminSyncMode,
} from './garmin';
import { isoOfMs, noonIso, summarizeCounts } from './mapping';
import { buildBiometricRows, buildDailyEnergyRows, buildExerciseRows } from './rows';
import { errorText } from './sync';
import type {
  BiometricPoint,
  DailyEnergyPoint,
  DateRange,
  LocalDate,
  SyncCounts,
  SyncWriter,
  WorkoutPoint,
} from './types';

// ---------------------------------------------------------------------------------------------------------------------
// package rows -> the app's points -> the app's row builders
// ---------------------------------------------------------------------------------------------------------------------

export const toDailyEnergyPoints = (energy: readonly GarminDailyEnergy[]): DailyEnergyPoint[] =>
  energy.map((e) => ({
    date: e.date,
    activeKcal: e.activeKcal ?? null,
    restingKcal: e.restingKcal ?? null,
    steps: e.steps ?? null,
  }));

/** 'YYYY-MM-DD HH:MM:SS' read as wall-clock time of this phone. Used only when Garmin sent no GMT start. */
export function localWallClockMs(startLocal: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(startLocal);
  if (!m) return null;
  const ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function toWorkoutPoints(workouts: readonly GarminWorkout[]): WorkoutPoint[] {
  const out: WorkoutPoint[] = [];
  for (const w of workouts) {
    const startMs = w.startMs ?? localWallClockMs(w.startLocal);
    if (startMs === null) continue;
    out.push({
      externalId: w.externalId,
      date: w.date,
      startedAt: isoOfMs(startMs),
      endedAt: isoOfMs(startMs + w.durationSec * 1000),
      name: w.name,
      minutes: w.durationSec / 60,
      kcal: w.kcal ?? 0,
      // heart rate, zones and training effect from the activity list: a summary, read at no extra request
      ...(w.details ? { details: w.details as unknown as Record<string, unknown> } : {}),
    });
  }
  return out;
}

export const toBiometricPoints = (list: readonly GarminBiometric[]): BiometricPoint[] =>
  list.map((b) => ({
    type: b.type,
    date: b.date,
    value: b.value,
    unit: b.unit,
    externalId: b.externalId,
    recordedAt: b.recordedAtMs !== undefined ? isoOfMs(b.recordedAtMs) : noonIso(b.date),
    ...(b.meta ? { meta: b.meta } : {}),
  }));

/** Rows that were actually written by one batch (after the row builders dropped what is invalid). */
export interface WrittenBatch {
  energyDates: LocalDate[];
  workoutIds: string[];
  biometrics: { type: BiometricPoint['type']; externalId: string }[];
}

/**
 * Writes one batch with the app's usual writers. Daily energy is upserted on (user, day, source): the latest values of the day
 * REPLACE the stored ones (they are cumulative counters), they are never added. Workouts are informational
 * (counts_toward_energy = false) and device-sourced rows are not user-deletable (data/diary-activity-rules.ts).
 */
export async function writeGarminBatch(writer: SyncWriter, userId: string, batch: GarminBatch): Promise<WrittenBatch> {
  const energy = buildDailyEnergyRows(userId, 'garmin', toDailyEnergyPoints(batch.energy));
  const exercises = buildExerciseRows(userId, 'garmin', toWorkoutPoints(batch.workouts));
  const biometrics = buildBiometricRows(userId, 'garmin', toBiometricPoints(batch.biometrics));
  if (energy.length > 0) await writer.upsertDailyEnergy(energy);
  if (exercises.length > 0) await writer.upsertExercises(exercises);
  if (biometrics.length > 0) await writer.upsertBiometrics(biometrics);
  return {
    energyDates: energy.map((r) => r.local_date),
    workoutIds: exercises.map((r) => r.external_id),
    biometrics: biometrics.map((r) => ({ type: r.type, externalId: r.external_id })),
  };
}

export interface GarminPullParams {
  client: GarminSyncSource;
  writer: SyncWriter;
  userId: string;
  range: DateRange;
  appInfo: string;
  now: () => number;
  onProgress?: (message: string) => void;
  isCancelled?: () => boolean;
}

export interface GarminPullResult {
  outcome: GarminSyncOutcome;
  /** Rows actually written. */
  counts: SyncCounts;
  summary: string;
  report: string;
}

/** Reads the range from Garmin (packages/garmin) and writes every batch as it arrives. */
export async function pullGarmin(params: GarminPullParams): Promise<GarminPullResult> {
  const counts: SyncCounts = { energyDays: 0, workouts: 0, biometrics: {} };
  const energyDays = new Set<string>();
  const workouts = new Set<string>();
  const biometrics = new Set<string>();

  const outcome = await runGarminSync({
    client: params.client,
    range: params.range,
    now: params.now,
    ...(params.isCancelled ? { isCancelled: params.isCancelled } : {}),
    onProgress: (p) => {
      if (!params.onProgress) return;
      if (p.step === 'profile') params.onProgress('Looking up your Garmin account');
      else if (p.step === 'activities') params.onProgress('Reading your workouts');
      else if (p.step === 'weight') params.onProgress('Reading your weigh-ins');
      else params.onProgress(`Reading ${p.date ?? 'a day'} (${Math.min(p.daysDone + 1, p.daysTotal)} of ${p.daysTotal})`);
    },
    onBatch: async (batch) => {
      const written = await writeGarminBatch(params.writer, params.userId, batch);
      for (const d of written.energyDates) energyDays.add(d);
      for (const id of written.workoutIds) workouts.add(id);
      for (const b of written.biometrics) {
        if (biometrics.has(b.externalId)) continue;
        biometrics.add(b.externalId);
        counts.biometrics[b.type] = (counts.biometrics[b.type] ?? 0) + 1;
      }
    },
  });
  counts.energyDays = energyDays.size;
  counts.workouts = workouts.size;
  const report = formatSyncReport(outcome.report, { generatedAtMs: params.now(), app: params.appInfo }, outcome.counts);
  return { outcome, counts, summary: summarizeCounts(counts), report };
}

// ---------------------------------------------------------------------------------------------------------------------
// One whole run, every effect injected
// ---------------------------------------------------------------------------------------------------------------------

export interface GarminIntegrationRow {
  enabled: boolean;
  settings: unknown;
  last_sync_at: string | null;
}

export interface GarminIntegrationPatch {
  enabled?: boolean;
  settings?: Record<string, unknown>;
  last_sync_at?: string | null;
}

export interface GarminDeps {
  now(): number;
  today(): LocalDate;
  userId(): Promise<string | null>;
  integration: {
    load(userId: string): Promise<GarminIntegrationRow | null>;
    save(userId: string, patch: GarminIntegrationPatch): Promise<GarminIntegrationRow>;
  };
  tokens: {
    /** The tokens of THIS user on this phone, or null (never another user's). */
    load(userId: string): Promise<GarminTokens | null>;
    save(userId: string, tokens: GarminTokens): Promise<void>;
    clear(): Promise<void>;
  };
  local: {
    load(): Promise<GarminLocalState>;
    save(patch: Partial<GarminLocalState>): Promise<void>;
  };
  createClient(tokens: GarminTokens, onTokensChanged: (tokens: GarminTokens) => Promise<void>): GarminSyncSource;
  writer: SyncWriter;
  /** e.g. 'Ration 0.1.0 (ios)' for the head of the sync report. */
  appInfo: string;
  onProgress?: (message: string) => void;
}

export type GarminSkipReason = 'signed_out' | 'not_connected' | 'needs_sign_in' | 'rate_limited';

export type GarminFailCode = 'needs_sign_in' | 'rate_limited' | 'network' | 'write_failed' | 'other';

export type GarminOutcome =
  | { status: 'skipped'; reason: GarminSkipReason; message: string }
  | { status: 'done'; complete: boolean; summary: string; counts: SyncCounts; range: DateRange }
  | { status: 'failed'; code: GarminFailCode; error: string; summary: string | null; counts: SyncCounts; range: DateRange | null };

const NO_COUNTS: SyncCounts = { energyDays: 0, workouts: 0, biometrics: {} };

export function skipMessage(reason: GarminSkipReason, untilMs?: number | null): string {
  switch (reason) {
    case 'signed_out':
      return 'You are signed out. Please sign in again.';
    case 'not_connected':
      return 'Connect Garmin first, then sync.';
    case 'needs_sign_in':
      return GARMIN_SIGNED_OUT_NOTE;
    case 'rate_limited':
      return untilMs
        ? `Garmin asked the app to slow down. Ration will try again after ${formatClock(untilMs)}.`
        : 'Garmin asked the app to slow down. Try again later.';
  }
}

/**
 * One sync run: checks the connection, plans the days, pulls and writes, then books the result.
 *
 *  - HTTP 400 / 401 from the token refresh = the session is dead: the tokens are deleted from this phone, the integration is
 *    marked "needs sign-in", and the run stops. Nothing retries it; the next run is skipped until the user signs in again.
 *  - HTTP 429 = stop, remember the time (local state), and skip runs until then.
 *  - `last_sync_at` only advances when every step ran, so a half run is repeated over the same days.
 */
export async function executeGarminSync(deps: GarminDeps, options: { mode: GarminSyncMode; isCancelled?: () => boolean }): Promise<GarminOutcome> {
  const userId = await deps.userId();
  if (!userId) return { status: 'skipped', reason: 'signed_out', message: skipMessage('signed_out') };

  const row = await deps.integration.load(userId);
  if (!row?.enabled) return { status: 'skipped', reason: 'not_connected', message: skipMessage('not_connected') };
  const settings = parseGarminSettings(row.settings);
  if (settings.needsSignIn) return { status: 'skipped', reason: 'needs_sign_in', message: skipMessage('needs_sign_in') };

  const tokens = await deps.tokens.load(userId);
  if (!tokens) return { status: 'skipped', reason: 'not_connected', message: 'Garmin is not signed in on this phone. Connect Garmin here first.' };

  const local = await deps.local.load();
  const startedAt = deps.now();
  if (isRateLimited(local.rateLimitedUntilMs, startedAt)) {
    return { status: 'skipped', reason: 'rate_limited', message: skipMessage('rate_limited', local.rateLimitedUntilMs) };
  }

  const range = planGarminRange({ mode: options.mode, today: deps.today(), lastSyncAt: row.last_sync_at });
  const client = deps.createClient(tokens, (fresh) => deps.tokens.save(userId, fresh));

  let pulled: GarminPullResult;
  try {
    pulled = await pullGarmin({
      client,
      writer: deps.writer,
      userId,
      range,
      appInfo: deps.appInfo,
      now: deps.now,
      ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
      ...(options.isCancelled ? { isCancelled: options.isCancelled } : {}),
    });
  } catch (e) {
    // runGarminSync reports Garmin problems in its outcome; anything thrown here is a bug in the app.
    const error = errorText(e);
    await deps.local.save({ lastIssue: error }).catch(() => undefined);
    return { status: 'failed', code: 'other', error, summary: null, counts: NO_COUNTS, range };
  }

  const { outcome, counts, summary, report } = pulled;
  const stop = outcome.report.stop;
  const finishedAt = deps.now();

  if (!stop) {
    // Complete (or cancelled by the caller): book the summary; only a complete run moves last_sync_at.
    const complete = outcome.status === 'complete';
    await deps.local.save({ report, reportAtMs: finishedAt, lastIssue: null, ...(complete ? { rateLimitedUntilMs: null } : {}) });
    try {
      await deps.integration.save(userId, {
        settings: serializeGarminSettings({ ...settings, needsSignIn: false, lastSummary: summary }, row.settings),
        ...(complete ? { last_sync_at: new Date(finishedAt).toISOString() } : {}),
      });
    } catch (e) {
      return { status: 'failed', code: 'write_failed', error: errorText(e), summary, counts, range };
    }
    return { status: 'done', complete, summary, counts, range };
  }

  // The run ended early. What was read before that is saved; say why it ended.
  let code: GarminFailCode = 'other';
  let error: string;
  let until: number | null = null;
  const patch: Partial<GarminLocalState> = { report, reportAtMs: finishedAt };

  if (stop.endpoint === 'writer') {
    code = 'write_failed';
    error = `Saving the Garmin data to your Ration account failed: ${errorText(outcome.writeError)}`;
  } else if (stop.kind === 'session_dead') {
    code = 'needs_sign_in';
    error = describeStop(stop, null);
    await deps.tokens.clear().catch(() => undefined);
    await deps.integration
      .save(userId, { settings: serializeGarminSettings({ ...settings, needsSignIn: true }, row.settings) })
      .catch(() => undefined);
  } else if (stop.kind === 'rate_limited') {
    code = 'rate_limited';
    until = rateLimitedUntil(finishedAt, stop.retryAfterSec);
    patch.rateLimitedUntilMs = until;
    error = describeStop(stop, until);
  } else if (stop.kind === 'network' || stop.kind === 'timeout') {
    code = 'network';
    error = describeStop(stop, null);
  } else {
    error = describeStop(stop, null);
  }
  patch.lastIssue = error;
  await deps.local.save(patch).catch(() => undefined);

  const wrote = counts.energyDays + counts.workouts + Object.values(counts.biometrics).reduce((a, b) => a + (b ?? 0), 0) > 0;
  if (wrote && code !== 'needs_sign_in') {
    // Keep the summary of what did arrive, but do NOT advance last_sync_at.
    await deps.integration
      .save(userId, { settings: serializeGarminSettings({ ...settings, lastSummary: summary }, row.settings) })
      .catch(() => undefined);
  }
  return { status: 'failed', code, error, summary: wrote ? summary : null, counts, range };
}
