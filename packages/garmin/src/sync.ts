// The sync walk: which Garmin endpoints are read, in which order, and what is done with each answer.
//
// Pure orchestration: the client (any object with the six GET methods) and the sink (`onBatch`) are injected. Nothing here
// knows about storage, Supabase or the clock beyond the injected `now`.
//
// Order of work (everything strictly one request at a time; the client also paces them):
//   1. profile                      -> displayName (needed in the path of two endpoints)
//   2. activities (newest first)    -> workouts of the range, as long as the pages still reach into the range
//   3. weight/dateRange (one call)  -> weigh-ins of the range
//   4. each day, newest first       -> usersummary/daily, dailySleepData, hrv  (3 requests per day)
// Data is handed to `onBatch` as soon as a step has it, so a run that is stopped half way (429, dropped network) has
// already delivered the most recent days.
//
// Failure policy (mirrors the reference's sync.rs): a dead session, a token Garmin keeps refusing, a 429, a dropped
// network or a failed token save END the run. A 404 / 403 / 204 / empty body is "no data" and not a problem. Any other
// status is a note in the report. Three days in a row with a server error end the run (Garmin is down).

import { diffDays, eachDate } from './dates';
import {
  ENDPOINT_TEMPLATES,
  type GarminEndpointName,
} from './constants';
import { GarminError, isFatalForRun, isNoData, toGarminError, type GarminErrorKind } from './errors';
import type { GarminReply } from './client';
import type { GarminConnectClient } from './client';
import {
  hrvFromSleep,
  mapActivities,
  mapHrvDay,
  mapProfile,
  mapSleepDay,
  mapUserSummary,
  mapWeightRange,
} from './mappers';
import { mergeCoverage, mergeDiagnostics } from './pick';
import type {
  GarminBiometric,
  GarminDailyEnergy,
  GarminDiagnostic,
  GarminFieldCoverage,
  GarminMap,
  GarminWorkout,
} from './normalized';

/** What the sync needs from a client. {@link GarminConnectClient} satisfies it; tests pass a fake. */
export type GarminSyncSource = Pick<
  GarminConnectClient,
  'profile' | 'userSummary' | 'sleep' | 'hrv' | 'weightRange' | 'activities'
>;

export interface GarminDateRange {
  from: string;
  to: string;
}

export interface GarminBatch {
  /** Where the data came from, e.g. '2026-11-09', 'activities', 'weight'. */
  label: string;
  energy: GarminDailyEnergy[];
  workouts: GarminWorkout[];
  biometrics: GarminBiometric[];
}

export interface GarminProgress {
  step: 'profile' | 'activities' | 'weight' | 'day';
  /** The day being read, when step is 'day'. */
  date?: string;
  /** Days finished so far / days in the range. */
  daysDone: number;
  daysTotal: number;
}

export interface GarminSyncOptions {
  client: GarminSyncSource;
  range: GarminDateRange;
  /** Receives data as soon as a step has it. Awaited; if it throws, the sync ends and the error is rethrown. */
  onBatch: (batch: GarminBatch) => Promise<void>;
  onProgress?: (progress: GarminProgress) => void;
  isCancelled?: () => boolean;
  /** Days in a row with a server error that end the run. Default 3. */
  outageDays?: number;
  /** Activity pages (50 each) read at most. Default 6. */
  maxActivityPages?: number;
  now?: () => number;
}

// ---- report ---------------------------------------------------------------------------------------------------

export interface EndpointReport {
  endpoint: GarminEndpointName;
  /** Path template without real values. */
  path: string;
  /** Logical requests (retries are not counted separately). */
  requests: number;
  /** Outcome label -> count: 'ok', 'empty', 'HTTP 404', 'rate limited (HTTP 429)', 'network error', ... */
  results: Record<string, number>;
  /** Days / items that carried data and were mapped. */
  records: number;
}

export interface GarminSyncStop {
  kind: GarminErrorKind;
  endpoint: GarminEndpointName | 'writer';
  retryAfterSec?: number;
  /** Friendly text, no secrets. */
  message: string;
}

export interface GarminSyncReport {
  range: GarminDateRange;
  days: number;
  startedAtMs: number;
  finishedAtMs: number;
  endpoints: EndpointReport[];
  coverage: GarminFieldCoverage[];
  diagnostics: GarminDiagnostic[];
  notes: string[];
  stop?: GarminSyncStop;
}

export interface GarminSyncCounts {
  daysRead: number;
  energyDays: number;
  workouts: number;
  /** Distinct rows per biometric type. */
  biometrics: Record<string, number>;
}

export interface GarminSyncOutcome {
  /** 'complete': every step ran. 'stopped': the run ended early (see report.stop). 'cancelled': the caller asked to stop. */
  status: 'complete' | 'stopped' | 'cancelled';
  report: GarminSyncReport;
  counts: GarminSyncCounts;
  /** What `onBatch` threw, when saving failed (the run then ends with report.stop.endpoint = 'writer'). */
  writeError?: unknown;
}

const ENDPOINT_ORDER: readonly GarminEndpointName[] = ['profile', 'activities', 'weight', 'userSummary', 'sleep', 'hrv'];

/** Short label of what happened to one request. No values, no tokens. */
export function outcomeLabel(reply: GarminReply | null, error: unknown): string {
  if (reply) return reply.empty ? 'empty' : 'ok';
  const e = error instanceof GarminError ? error : null;
  if (!e) return 'error';
  switch (e.kind) {
    case 'rate_limited':
      return 'rate limited (HTTP 429)';
    case 'server':
      return `server error (HTTP ${e.status ?? '5xx'})`;
    case 'network':
      return 'network error';
    case 'timeout':
      return 'timeout';
    case 'parse':
      return 'not JSON';
    case 'session_dead':
      return `session dead (HTTP ${e.status ?? '401'})`;
    case 'unauthorized':
      return 'unauthorized after refresh (HTTP 401)';
    case 'storage':
      return 'token save failed';
    case 'http':
      return `HTTP ${e.status ?? '?'}`;
    default:
      return e.kind;
  }
}

class Recorder {
  private readonly endpoints = new Map<GarminEndpointName, EndpointReport>();
  private readonly maps: GarminMap[] = [];
  readonly notes: string[] = [];

  constructor(readonly startedAtMs: number) {}

  private endpoint(name: GarminEndpointName): EndpointReport {
    let e = this.endpoints.get(name);
    if (!e) {
      e = { endpoint: name, path: ENDPOINT_TEMPLATES[name], requests: 0, results: {}, records: 0 };
      this.endpoints.set(name, e);
    }
    return e;
  }

  request(name: GarminEndpointName, label: string): void {
    const e = this.endpoint(name);
    e.requests += 1;
    e.results[label] = (e.results[label] ?? 0) + 1;
  }

  records(name: GarminEndpointName, n: number): void {
    this.endpoint(name).records += n;
  }

  map(m: GarminMap): void {
    this.maps.push(m);
  }

  build(range: GarminDateRange, days: number, finishedAtMs: number, stop: GarminSyncStop | undefined): GarminSyncReport {
    return {
      range,
      days,
      startedAtMs: this.startedAtMs,
      finishedAtMs,
      endpoints: ENDPOINT_ORDER.flatMap((n) => {
        const e = this.endpoints.get(n);
        return e ? [e] : [];
      }),
      coverage: mergeCoverage(...this.maps.map((m) => m.coverage)),
      diagnostics: mergeDiagnostics(...this.maps.map((m) => m.diagnostics)),
      notes: [...this.notes],
      ...(stop ? { stop } : {}),
    };
  }
}

class RunStopped extends Error {
  constructor(
    readonly stop: GarminSyncStop,
    readonly writeError?: unknown,
  ) {
    super(stop.message);
    // Same as GarminError: `instanceof` must keep working when a build transpiles classes (Hermes / Babel).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const PAGE_SIZE = 50;

/**
 * Reads the range from Garmin and hands the mapped rows to `onBatch`. Never throws: a Garmin problem or a failing
 * `onBatch` ends the run and says so in `report.stop` (the `onBatch` error itself is in `writeError`).
 */
export async function runGarminSync(options: GarminSyncOptions): Promise<GarminSyncOutcome> {
  const { client, range, onBatch } = options;
  const now = options.now ?? (() => Date.now());
  const outageDays = options.outageDays ?? 3;
  const maxPages = options.maxActivityPages ?? 6;
  const recorder = new Recorder(now());
  const days = Math.max(0, diffDays(range.from, range.to) + 1);
  const dates = days > 0 ? eachDate(range.from, range.to).reverse() : [];
  const counts: GarminSyncCounts = { daysRead: 0, energyDays: 0, workouts: 0, biometrics: {} };
  const seenBiometrics = new Set<string>();
  const seenWorkouts = new Set<string>();
  let stop: GarminSyncStop | undefined;
  let writeError: unknown;
  let cancelled = false;
  const cancelRequested = (): boolean => {
    if (options.isCancelled?.()) cancelled = true;
    return cancelled;
  };

  const progress = (p: Omit<GarminProgress, 'daysTotal'>) => options.onProgress?.({ ...p, daysTotal: days });

  /** Records and counts a batch, then delivers it. */
  const deliver = async (batch: GarminBatch) => {
    if (batch.energy.length === 0 && batch.workouts.length === 0 && batch.biometrics.length === 0) return;
    try {
      await onBatch(batch);
    } catch (err) {
      throw new RunStopped(
        { kind: 'storage', endpoint: 'writer', message: 'Saving the Garmin data to your Cal Track account failed.' },
        err,
      );
    }
    counts.energyDays += batch.energy.length;
    for (const w of batch.workouts) {
      if (!seenWorkouts.has(w.externalId)) {
        seenWorkouts.add(w.externalId);
        counts.workouts += 1;
      }
    }
    for (const b of batch.biometrics) {
      if (seenBiometrics.has(b.externalId)) continue;
      seenBiometrics.add(b.externalId);
      counts.biometrics[b.type] = (counts.biometrics[b.type] ?? 0) + 1;
    }
  };

  /**
   * One request. Returns the reply, or null when there is nothing to map (no data, a problem with this one request).
   * Throws RunStopped for errors that end the run. `serverError` is set when the request ended in a 5xx.
   */
  const call = async (
    name: GarminEndpointName,
    make: () => Promise<GarminReply>,
    flags?: { serverError: boolean },
  ): Promise<GarminReply | null> => {
    try {
      const reply = await make();
      recorder.request(name, outcomeLabel(reply, null));
      return reply.empty ? null : reply;
    } catch (raw) {
      const e = toGarminError(raw);
      recorder.request(name, outcomeLabel(null, e));
      if (isFatalForRun(e)) {
        throw new RunStopped({
          kind: e.kind,
          endpoint: name,
          ...(e.retryAfterSeconds !== undefined ? { retryAfterSec: e.retryAfterSeconds } : {}),
          message: e.userMessage,
        });
      }
      if (e.kind === 'server' && flags) flags.serverError = true;
      if (!isNoData(e) && e.kind !== 'server') recorder.notes.push(`${name}: ${e.message}`);
      return null;
    }
  };

  try {
    // 1. profile ------------------------------------------------------------------------------------------------
    progress({ step: 'profile', daysDone: 0 });
    let displayName: string | undefined;
    const profileReply = await call('profile', () => client.profile());
    if (profileReply) {
      const mapped = mapProfile(profileReply.data);
      recorder.map(mapped);
      displayName = mapped.displayName;
      if (displayName) recorder.records('profile', 1);
    }
    if (!displayName) {
      recorder.notes.push('profile: no displayName, so userSummary and sleep were skipped (hrv, weight and activities still ran)');
    }

    // 2. activities ---------------------------------------------------------------------------------------------
    if (days > 0) {
      progress({ step: 'activities', daysDone: 0 });
      const workouts: GarminWorkout[] = [];
      for (let page = 0; page < maxPages; page++) {
        if (cancelRequested()) break;
        const reply = await call('activities', () => client.activities(page * PAGE_SIZE, PAGE_SIZE));
        if (!reply) break;
        const mapped = mapActivities(reply.data, { nowMs: now() });
        recorder.map(mapped);
        for (const w of mapped.items) if (w.date >= range.from && w.date <= range.to) workouts.push(w);
        recorder.records('activities', mapped.items.length);
        const rawCount = Array.isArray(reply.data) ? reply.data.length : mapped.items.length;
        const oldest = mapped.items.reduce<string | null>((min, w) => (min === null || w.date < min ? w.date : min), null);
        // Newest first: once a page reaches back before the range (or is the last page), nothing older is wanted.
        if (rawCount < PAGE_SIZE || (oldest !== null && oldest < range.from)) break;
      }
      await deliver({ label: 'activities', energy: [], workouts, biometrics: [] });

      // 3. weight -----------------------------------------------------------------------------------------------
      if (!cancelRequested()) {
        progress({ step: 'weight', daysDone: 0 });
        const reply = await call('weight', () => client.weightRange(range.from, range.to));
        if (reply) {
          const mapped = mapWeightRange(reply.data);
          recorder.map(mapped);
          recorder.records('weight', mapped.items.length);
          await deliver({ label: 'weight', energy: [], workouts: [], biometrics: mapped.items });
        }
      }
    }

    // 4. the days, newest first ---------------------------------------------------------------------------------
    let outageStreak = 0;
    for (const [i, date] of dates.entries()) {
      if (cancelRequested()) break;
      progress({ step: 'day', date, daysDone: i });
      const batch: GarminBatch = { label: date, energy: [], workouts: [], biometrics: [] };
      const flags = { serverError: false };
      let hrvFound = false;
      let sleepHrv: number | undefined;
      let hadData = false;

      try {
        if (displayName) {
          const name = displayName;
          const summary = await call('userSummary', () => client.userSummary(name, date), flags);
          if (summary) {
            const mapped = mapUserSummary(summary.data, date);
            recorder.map(mapped);
            if (mapped.energy) batch.energy.push(mapped.energy);
            batch.biometrics.push(...mapped.biometrics);
            if (mapped.energy || mapped.biometrics.length > 0) {
              recorder.records('userSummary', 1);
              hadData = true;
            }
          }
          const sleep = await call('sleep', () => client.sleep(name, date), flags);
          if (sleep) {
            const mapped = mapSleepDay(sleep.data, date);
            recorder.map(mapped);
            batch.biometrics.push(...mapped.biometrics);
            sleepHrv = mapped.avgOvernightHrv;
            if (mapped.biometrics.length > 0) {
              recorder.records('sleep', 1);
              hadData = true;
            }
          }
        }

        const hrv = await call('hrv', () => client.hrv(date), flags);
        if (hrv) {
          const mapped = mapHrvDay(hrv.data, date);
          recorder.map(mapped);
          batch.biometrics.push(...mapped.biometrics);
          if (mapped.biometrics.length > 0) {
            recorder.records('hrv', 1);
            hrvFound = true;
            hadData = true;
          }
        }
        if (!hrvFound && sleepHrv !== undefined) {
          batch.biometrics.push(hrvFromSleep(date, sleepHrv));
          recorder.notes.push('hrv: used the overnight average of the sleep reply for nights the HRV endpoint had nothing for');
          hadData = true;
        }
      } catch (e) {
        // The run ends here, but what this day already returned (say its energy, before the sleep request hit a 429) is kept.
        if (e instanceof RunStopped && e.stop.endpoint !== 'writer') await deliver(batch).catch(() => undefined);
        throw e;
      }

      counts.daysRead += 1;
      outageStreak = flags.serverError ? outageStreak + 1 : 0;
      if (hadData || batch.energy.length > 0) await deliver(batch);
      progress({ step: 'day', date, daysDone: i + 1 });
      if (outageStreak >= outageDays) {
        throw new RunStopped({
          kind: 'server',
          endpoint: 'userSummary',
          message: `Garmin answered with server errors on ${outageDays} days in a row`,
        });
      }
    }
  } catch (e) {
    if (!(e instanceof RunStopped)) throw e;
    stop = e.stop;
    writeError = e.writeError;
  }

  const finishedAtMs = now();
  return {
    status: stop ? 'stopped' : cancelled ? 'cancelled' : 'complete',
    report: recorder.build(range, days, finishedAtMs, stop),
    counts,
    ...(writeError !== undefined ? { writeError } : {}),
  };
}
