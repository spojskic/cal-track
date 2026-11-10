// Reads the extra data of ONE Garmin activity (heart rate, time in zones, strength sets, laps) with the per-activity GET endpoints,
// and turns it into {@link WorkoutDetails}. Pure orchestration: the client (any object with the four GET methods) is injected, the
// result is returned, nothing is stored here (the app saves it into exercise_entries.details).
//
// Order (strictly one request at a time; the client also paces them, 250 ms apart, with the usual 429 / 5xx backoff):
//   1. /activity-service/activity/{id}                 summaryDTO: type, min / avg / max heart rate, distance, speed, climb, calories
//   2. /activity-service/activity/{id}/hrTimeInZones   time in each heart-rate zone
//   3. a strength-like session: .../exerciseSets       sets, reps, rest      anything else: .../splits   laps
// Failure policy = the sync's (sync.ts): a dead session, a token Garmin keeps refusing, a 429, a dropped network and a failed
// token save END the read; a 404 / 403 / 204 / empty body is "no data" (a manual activity has no heart rate), not a problem; any
// other failure of one call makes the result "partial" (stored as a summary, so it is read again next time).

import type { GarminConnectClient, GarminReply } from './client';
import { isFatalForRun, isNoData, toGarminError, type GarminErrorKind } from './errors';
import type { GarminDiagnostic, GarminFieldCoverage } from './normalized';
import { mergeCoverage, mergeDiagnostics } from './pick';
import { mapActivitySummary, mapExerciseSets, mapHrZones, mapSplits } from './activity-mappers';
import { outcomeLabel } from './sync';
import { hasWorkoutData, isStrengthLike, toStoredDetails, type WorkoutDetails } from './workout-details';

/** What the detail read needs from a client. {@link GarminConnectClient} satisfies it; tests pass a fake. */
export type GarminActivitySource = Pick<GarminConnectClient, 'activity' | 'activityHrZones' | 'activityExerciseSets' | 'activitySplits'>;

export type DetailEndpoint = 'activity' | 'activityZones' | 'activitySets' | 'activitySplits';

export const DETAIL_ENDPOINT_ORDER: readonly DetailEndpoint[] = ['activity', 'activityZones', 'activitySets', 'activitySplits'];

export interface DetailEndpointStats {
  requests: number;
  /** Outcome label -> count ('ok', 'empty', 'HTTP 404', 'rate limited (HTTP 429)', ...). No values. */
  results: Record<string, number>;
}

export interface DetailRunReport {
  endpoints: Partial<Record<DetailEndpoint, DetailEndpointStats>>;
  coverage: GarminFieldCoverage[];
  diagnostics: GarminDiagnostic[];
}

export interface DetailStop {
  kind: GarminErrorKind;
  endpoint: DetailEndpoint;
  retryAfterSec?: number;
  /** Friendly text, no secrets. */
  message: string;
}

export interface FetchActivityDetailsResult {
  /**
   * The details to store, or null when nothing should be stored (the read was stopped, or it failed and there is nothing to keep).
   * `level` is 'full' only when every call answered (with data or with "no data").
   */
  details: WorkoutDetails | null;
  /** complete: every call answered. partial: a call failed in a way that may be temporary. stopped: the read ended early (see `stop`). */
  status: 'complete' | 'partial' | 'stopped';
  stop?: DetailStop;
  report: DetailRunReport;
}

export interface FetchActivityDetailsOptions {
  client: GarminActivitySource;
  /** The numeric Garmin activity id (garminActivityIdOf(external_id)). */
  activityId: string;
  nowMs: number;
  /** What is already stored (list summary, older full read): kept for every value the endpoints do not return. */
  base?: WorkoutDetails | null;
  /** The workout's name: only used to recognise a strength session when Garmin gave no type key. */
  name?: string;
}

class ReadStopped extends Error {
  constructor(readonly stop: DetailStop) {
    super(stop.message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Reads one activity. Never throws: a Garmin problem ends the read and says so in the result. */
export async function fetchActivityDetails(options: FetchActivityDetailsOptions): Promise<FetchActivityDetailsResult> {
  const { client, activityId, nowMs } = options;
  const base = options.base ?? null;
  const endpoints: Partial<Record<DetailEndpoint, DetailEndpointStats>> = {};
  const maps: { coverage: GarminFieldCoverage[]; diagnostics: GarminDiagnostic[] }[] = [];
  let partial = false;

  const record = (name: DetailEndpoint, label: string) => {
    const e = (endpoints[name] ??= { requests: 0, results: {} });
    e.requests += 1;
    e.results[label] = (e.results[label] ?? 0) + 1;
  };
  const report = (): DetailRunReport => ({
    endpoints,
    coverage: mergeCoverage(...maps.map((m) => m.coverage)),
    diagnostics: mergeDiagnostics(...maps.map((m) => m.diagnostics)),
  });

  /** One request. Null when there is nothing to map (no data, or a problem with this one call). Throws ReadStopped when the read must end. */
  const call = async (name: DetailEndpoint, make: () => Promise<GarminReply>): Promise<GarminReply | null> => {
    try {
      const reply = await make();
      record(name, outcomeLabel(reply, null));
      return reply.empty ? null : reply;
    } catch (raw) {
      const e = toGarminError(raw);
      record(name, outcomeLabel(null, e));
      if (isFatalForRun(e)) {
        throw new ReadStopped({
          kind: e.kind,
          endpoint: name,
          ...(e.retryAfterSeconds !== undefined ? { retryAfterSec: e.retryAfterSeconds } : {}),
          message: e.userMessage,
        });
      }
      if (!isNoData(e)) partial = true;
      return null;
    }
  };

  try {
    const summary = await call('activity', () => client.activity(activityId));
    const mappedSummary = summary ? mapActivitySummary(summary.data) : null;
    if (mappedSummary) maps.push(mappedSummary);

    const zonesReply = await call('activityZones', () => client.activityHrZones(activityId));
    const mappedZones = zonesReply ? mapHrZones(zonesReply.data) : null;
    if (mappedZones) maps.push(mappedZones);

    const typeKey = mappedSummary?.part.typeKey ?? base?.typeKey;
    let sets: ReturnType<typeof mapExerciseSets>['sets'] = [];
    let laps: ReturnType<typeof mapSplits>['laps'] = [];
    if (isStrengthLike(typeKey, options.name)) {
      const reply = await call('activitySets', () => client.activityExerciseSets(activityId));
      if (reply) {
        const mapped = mapExerciseSets(reply.data);
        maps.push(mapped);
        sets = mapped.sets;
      }
    } else {
      const reply = await call('activitySplits', () => client.activitySplits(activityId));
      if (reply) {
        const mapped = mapSplits(reply.data);
        maps.push(mapped);
        laps = mapped.laps;
      }
    }

    const { v: _v, source: _s, level: _l, fetchedAt: _f, ...kept } = base ?? ({} as Partial<WorkoutDetails>);
    const merged = {
      ...kept,
      ...(mappedSummary?.part ?? {}),
      ...(mappedZones && mappedZones.zones.length > 0 ? { hrZones: mappedZones.zones } : {}),
      ...(sets.length > 0 ? { sets } : {}),
      ...(laps.length > 0 ? { laps } : {}),
      v: 1,
      source: 'garmin',
      level: partial ? 'summary' : 'full',
      fetchedAt: new Date(nowMs).toISOString(),
    } as WorkoutDetails;
    const details = toStoredDetails(merged);
    // A failed read that gained nothing and had nothing to build on is not worth a column write.
    const keep = !partial || base !== null || hasWorkoutData(details);
    return { details: keep ? details : null, status: partial ? 'partial' : 'complete', report: report() };
  } catch (e) {
    if (!(e instanceof ReadStopped)) throw e;
    return { details: null, status: 'stopped', stop: e.stop, report: report() };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// what the "Copy sync report" button adds: the detail reads of this phone, accumulated (no values, no ids, no tokens)
// ---------------------------------------------------------------------------------------------------------------------

export interface DetailStats {
  v: 1;
  /** Activities read (a read that was stopped counts too). */
  reads: number;
  lastReadAtMs: number | null;
  endpoints: Partial<Record<DetailEndpoint, DetailEndpointStats>>;
  /** 'rate_limited' -> 2: how often a read was stopped, by reason. */
  stops: Record<string, number>;
  coverage: GarminFieldCoverage[];
  diagnostics: GarminDiagnostic[];
}

export function emptyDetailStats(): DetailStats {
  return { v: 1, reads: 0, lastReadAtMs: null, endpoints: {}, stops: {}, coverage: [], diagnostics: [] };
}

const MAX_STAT_LABELS = 12;

/** Adds one read to the accumulated stats. Bounded: result labels and coverage keys are a small closed set. */
export function addDetailRun(stats: DetailStats, report: DetailRunReport, stop: DetailStop | undefined, nowMs: number): DetailStats {
  const endpoints: DetailStats['endpoints'] = {};
  for (const name of DETAIL_ENDPOINT_ORDER) {
    const before = stats.endpoints[name];
    const add = report.endpoints[name];
    if (!before && !add) continue;
    const results: Record<string, number> = { ...(before?.results ?? {}) };
    for (const [label, n] of Object.entries(add?.results ?? {})) {
      if (label in results || Object.keys(results).length < MAX_STAT_LABELS) results[label] = (results[label] ?? 0) + n;
    }
    endpoints[name] = { requests: (before?.requests ?? 0) + (add?.requests ?? 0), results };
  }
  const stops = { ...stats.stops };
  if (stop) stops[stop.kind] = (stops[stop.kind] ?? 0) + 1;
  return {
    v: 1,
    reads: stats.reads + 1,
    lastReadAtMs: nowMs,
    endpoints,
    stops,
    coverage: mergeCoverage(stats.coverage, report.coverage),
    diagnostics: mergeDiagnostics(stats.diagnostics, report.diagnostics),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** Reads stored stats defensively; anything unreadable gives empty stats. */
export function parseDetailStats(raw: unknown): DetailStats {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return emptyDetailStats();
    }
  }
  if (!isRecord(value) || value.v !== 1) return emptyDetailStats();
  const endpoints: DetailStats['endpoints'] = {};
  if (isRecord(value.endpoints)) {
    for (const name of DETAIL_ENDPOINT_ORDER) {
      const e = value.endpoints[name];
      if (!isRecord(e)) continue;
      const results: Record<string, number> = {};
      if (isRecord(e.results)) for (const [label, n] of Object.entries(e.results).slice(0, MAX_STAT_LABELS)) results[label] = count(n);
      endpoints[name] = { requests: count(e.requests), results };
    }
  }
  const stops: Record<string, number> = {};
  if (isRecord(value.stops)) for (const [k, n] of Object.entries(value.stops).slice(0, 14)) stops[k] = count(n);
  const keep = <T>(v: unknown): T[] => (Array.isArray(v) ? (v.filter(isRecord).slice(0, 80) as unknown as T[]) : []);
  return {
    v: 1,
    reads: count(value.reads),
    lastReadAtMs: typeof value.lastReadAtMs === 'number' && Number.isFinite(value.lastReadAtMs) ? value.lastReadAtMs : null,
    endpoints,
    stops,
    coverage: keep<GarminFieldCoverage>(value.coverage),
    diagnostics: keep<GarminDiagnostic>(value.diagnostics),
  };
}
