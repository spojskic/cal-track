// Typed wrappers for the Personal API endpoints, an endpoint registry (used by sync and by the probe), and chunking
// helpers. Raw responses are returned as `unknown`: their shapes are unverified, the mappers interpret them.

import {
  ACTIVITY_MAX_PAGES,
  ACTIVITY_PAGE_SIZE,
  MAX_DAYS,
  PATHS,
  type GarminScope,
} from './constants';
import { chunkDateRange, eachDate, type DateChunk } from './dates';
import type { GarminDataClient, QueryParams } from './client';
import { isFatalAuthError, toGarminError } from './errors';
import {
  isObject,
  mapActivities,
  mapBodyBattery,
  mapDailySummaries,
  mapHeartRateDay,
  mapHrv,
  mapSleep,
  mapSpo2Day,
  mapStepsDaily,
  mapStressDaily,
  mapWeight,
} from './mappers';
import type {
  GarminBiometric,
  GarminDailyEnergy,
  GarminMap,
  GarminSyncError,
  GarminWorkout,
} from './normalized';

export { chunkDateRange };
export type { DateChunk };

// ---------------------------------------------------------------------------------------------------------------------
// Typed wrappers (one request each; the caller respects the range limits, or use fetchEndpointRange)
// ---------------------------------------------------------------------------------------------------------------------

type Raw = Promise<unknown>;

export const getUserSettings = (c: GarminDataClient): Raw => c.get(PATHS.userSettings);
export const getDailySummaries = (c: GarminDataClient, startDate: string, endDate: string): Raw =>
  c.get(PATHS.dailySummaries, { startDate, endDate });
export const getDailySummaryDay = (c: GarminDataClient, calendarDate: string): Raw =>
  c.get(PATHS.dailySummaryDay, { calendarDate });
export const getSleepSummaries = (c: GarminDataClient, startDate: string, endDate: string): Raw =>
  c.get(PATHS.sleepRange, { startDate, endDate });
export const getSleepDay = (c: GarminDataClient, date: string): Raw => c.get(PATHS.sleepDay, { date });
export const getHrvRange = (c: GarminDataClient, from: string, to: string): Raw => c.get(PATHS.hrvRange(from, to));
export const getHrvDay = (c: GarminDataClient, date: string): Raw => c.get(PATHS.hrvDay(date));
export const getWeightAll = (c: GarminDataClient, from: string, to: string): Raw => c.get(PATHS.weightAll(from, to));
export const getWeightRange = (c: GarminDataClient, from: string, to: string): Raw =>
  c.get(PATHS.weightRange(from, to), { includeAll: true });
export const getBodyBattery = (c: GarminDataClient, startDate: string, endDate: string): Raw =>
  c.get(PATHS.bodyBattery, { startDate, endDate });
export const getHeartRateDay = (c: GarminDataClient, date: string): Raw => c.get(PATHS.heartRateDay, { date });
export const getSpo2Day = (c: GarminDataClient, date: string): Raw => c.get(PATHS.spo2Day(date));
export const getStepsDaily = (c: GarminDataClient, from: string, to: string): Raw => c.get(PATHS.stepsDaily(from, to));
export const getStressDaily = (c: GarminDataClient, from: string, to: string): Raw => c.get(PATHS.stressDaily(from, to));
export const getHydrationDaily = (c: GarminDataClient, from: string, to: string): Raw =>
  c.get(PATHS.hydrationDaily(from, to));
export const getWellnessActivities = (c: GarminDataClient, from: string, until: string): Raw =>
  c.get(PATHS.wellnessActivities(from, until));
export const getActivities = (
  c: GarminDataClient,
  p: { start: number; limit: number; startDate?: string; endDate?: string; activityType?: string },
): Raw => c.get(PATHS.activities, { ...p });

// ---------------------------------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------------------------------

export const ENDPOINT_IDS = [
  'userSettings',
  'dailySummaries',
  'sleep',
  'sleepDay',
  'hrv',
  'hrvDay',
  'weight',
  'weightRange',
  'bodyBattery',
  'heartRateDay',
  'spo2Day',
  'steps',
  'stress',
  'hydration',
  'activities',
  'wellnessActivities',
] as const;
export type EndpointId = (typeof ENDPOINT_IDS)[number];

export type EndpointKind =
  /** One request, no dates. */
  | 'single'
  /** Date range, split into chunks of `maxDays`. */
  | 'range'
  /** One request per calendar day. */
  | 'perDay'
  /** Offset/limit pagination over a date range. */
  | 'paged';

export interface RequestSpec {
  path: string;
  params?: QueryParams;
}

/** What a mapper produced for one response. */
export interface EndpointMapped extends GarminMap {
  energy?: GarminDailyEnergy[];
  biometrics?: GarminBiometric[];
  workouts?: GarminWorkout[];
}

export interface EndpointSpec {
  id: EndpointId;
  title: string;
  kind: EndpointKind;
  /** Max inclusive days per request (range endpoints). */
  maxDays?: number;
  /** Best guess of the key scope needed (UNVERIFIED), to explain a 403. */
  scopeHint: GarminScope;
  /** Builds the request for a chunk (range: start..end, perDay: start === end, single: ignored). */
  request(chunk: DateChunk, page?: { start: number; limit: number }): RequestSpec;
  /** Maps a raw response; absent for endpoints without a normalized shape (hydration, wellness activities). */
  map?(raw: unknown, ctx: { date?: string }): EndpointMapped;
}

const biometricsOf = (r: { items: GarminBiometric[]; diagnostics: GarminMap['diagnostics']; coverage: GarminMap['coverage'] }): EndpointMapped => ({
  biometrics: r.items,
  diagnostics: r.diagnostics,
  coverage: r.coverage,
});

export const GARMIN_ENDPOINTS: Record<EndpointId, EndpointSpec> = {
  userSettings: {
    id: 'userSettings',
    title: 'User profile settings',
    kind: 'single',
    scopeHint: 'PERSONAL_API_USER_READ',
    request: () => ({ path: PATHS.userSettings }),
  },
  dailySummaries: {
    id: 'dailySummaries',
    title: 'Daily summaries (energy, steps, resting HR, stress, body battery, respiration, SpO2)',
    kind: 'range',
    maxDays: MAX_DAYS.dailySummaries,
    scopeHint: 'PERSONAL_API_WELLNESS_READ',
    request: (c) => ({ path: PATHS.dailySummaries, params: { startDate: c.start, endDate: c.end } }),
    map: (raw) => {
      const r = mapDailySummaries(raw);
      return { energy: r.energy, biometrics: r.biometrics, diagnostics: r.diagnostics, coverage: r.coverage };
    },
  },
  sleep: {
    id: 'sleep',
    title: 'Sleep summaries (range)',
    kind: 'range',
    maxDays: MAX_DAYS.sleep,
    scopeHint: 'PERSONAL_API_WELLNESS_READ',
    request: (c) => ({ path: PATHS.sleepRange, params: { startDate: c.start, endDate: c.end } }),
    map: (raw) => biometricsOf(mapSleep(raw)),
  },
  sleepDay: {
    id: 'sleepDay',
    title: 'Sleep (single day)',
    kind: 'perDay',
    scopeHint: 'PERSONAL_API_WELLNESS_READ',
    request: (c) => ({ path: PATHS.sleepDay, params: { date: c.start } }),
    map: (raw) => biometricsOf(mapSleep(raw)),
  },
  hrv: {
    id: 'hrv',
    title: 'HRV daily summaries (range)',
    kind: 'range',
    maxDays: MAX_DAYS.hrv,
    scopeHint: 'PERSONAL_API_WELLNESS_READ',
    request: (c) => ({ path: PATHS.hrvRange(c.start, c.end) }),
    map: (raw) => biometricsOf(mapHrv(raw)),
  },
  hrvDay: {
    id: 'hrvDay',
    title: 'HRV (single day)',
    kind: 'perDay',
    scopeHint: 'PERSONAL_API_WELLNESS_READ',
    request: (c) => ({ path: PATHS.hrvDay(c.start) }),
    map: (raw) => biometricsOf(mapHrv(raw)),
  },
  weight: {
    id: 'weight',
    title: 'Weigh-ins (weight/all)',
    kind: 'range',
    maxDays: MAX_DAYS.weightAll,
    scopeHint: 'PERSONAL_API_USER_READ',
    request: (c) => ({ path: PATHS.weightAll(c.start, c.end) }),
    map: (raw) => biometricsOf(mapWeight(raw)),
  },
  weightRange: {
    id: 'weightRange',
    title: 'Weigh-ins (weight/range, includeAll)',
    kind: 'range',
    maxDays: MAX_DAYS.weightRange,
    scopeHint: 'PERSONAL_API_USER_READ',
    request: (c) => ({ path: PATHS.weightRange(c.start, c.end), params: { includeAll: true } }),
    map: (raw) => biometricsOf(mapWeight(raw)),
  },
  bodyBattery: {
    id: 'bodyBattery',
    title: 'Body battery reports',
    kind: 'range',
    maxDays: MAX_DAYS.bodyBattery,
    scopeHint: 'PERSONAL_API_WELLNESS_READ',
    request: (c) => ({ path: PATHS.bodyBattery, params: { startDate: c.start, endDate: c.end } }),
    map: (raw) => biometricsOf(mapBodyBattery(raw)),
  },
  heartRateDay: {
    id: 'heartRateDay',
    title: 'Daily heart rate (single day)',
    kind: 'perDay',
    scopeHint: 'PERSONAL_API_WELLNESS_READ',
    request: (c) => ({ path: PATHS.heartRateDay, params: { date: c.start } }),
    map: (raw, ctx) => biometricsOf(mapHeartRateDay(raw, ctx.date)),
  },
  spo2Day: {
    id: 'spo2Day',
    title: 'SpO2 (single day)',
    kind: 'perDay',
    scopeHint: 'PERSONAL_API_WELLNESS_READ',
    request: (c) => ({ path: PATHS.spo2Day(c.start) }),
    map: (raw, ctx) => biometricsOf(mapSpo2Day(raw, ctx.date)),
  },
  steps: {
    id: 'steps',
    title: 'Daily steps (range)',
    kind: 'range',
    maxDays: MAX_DAYS.steps,
    scopeHint: 'PERSONAL_API_WELLNESS_READ',
    request: (c) => ({ path: PATHS.stepsDaily(c.start, c.end) }),
    map: (raw) => {
      const r = mapStepsDaily(raw);
      return { energy: r.items, diagnostics: r.diagnostics, coverage: r.coverage };
    },
  },
  stress: {
    id: 'stress',
    title: 'Daily stress (range)',
    kind: 'range',
    maxDays: MAX_DAYS.stress,
    scopeHint: 'PERSONAL_API_WELLNESS_READ',
    request: (c) => ({ path: PATHS.stressDaily(c.start, c.end) }),
    map: (raw) => biometricsOf(mapStressDaily(raw)),
  },
  hydration: {
    id: 'hydration',
    title: 'Daily hydration (range)',
    kind: 'range',
    maxDays: MAX_DAYS.hydration,
    scopeHint: 'PERSONAL_API_WELLNESS_READ',
    request: (c) => ({ path: PATHS.hydrationDaily(c.start, c.end) }),
  },
  activities: {
    id: 'activities',
    title: 'Activities (search, paginated)',
    kind: 'paged',
    scopeHint: 'PERSONAL_API_FITNESS_READ',
    request: (c, page = { start: 0, limit: ACTIVITY_PAGE_SIZE }) => ({
      path: PATHS.activities,
      params: { start: page.start, limit: page.limit, startDate: c.start, endDate: c.end },
    }),
    map: (raw) => {
      const r = mapActivities(raw);
      return { workouts: r.items, diagnostics: r.diagnostics, coverage: r.coverage };
    },
  },
  wellnessActivities: {
    id: 'wellnessActivities',
    title: 'Wellness activity summaries (range)',
    kind: 'range',
    maxDays: MAX_DAYS.wellnessActivities,
    scopeHint: 'PERSONAL_API_WELLNESS_READ',
    request: (c) => ({ path: PATHS.wellnessActivities(c.start, c.end) }),
  },
};

export function isEndpointId(s: string): s is EndpointId {
  return (ENDPOINT_IDS as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------------------------------------------------------
// Chunked fetching
// ---------------------------------------------------------------------------------------------------------------------

export interface ChunkResult {
  start: string;
  end: string;
  /** Page index for paginated endpoints. */
  page?: number;
  /** Parsed JSON; null for HTTP 204 / empty body. */
  raw: unknown;
}

export interface FetchRangeResult {
  chunks: ChunkResult[];
  errors: GarminSyncError[];
  /** Number of `client.get` calls made. */
  requests: number;
}

export interface FetchRangeOptions {
  /** Called after every request (success or failure). */
  onRequest?: (info: { endpoint: EndpointId; start: string; end: string }) => void;
  /** Overrides the registry's maxDays (tests). */
  maxDays?: number;
  /** Safety cap for perDay endpoints (default: no cap). */
  maxRequests?: number;
  /** Page size for paged endpoints (default 100). */
  pageSize?: number;
}

/** Chunks that `fetchEndpointRange` will request for a range endpoint (perDay: one per date). */
export function planChunks(id: EndpointId, from: string, to: string, maxDays?: number): DateChunk[] {
  const spec = GARMIN_ENDPOINTS[id];
  if (spec.kind === 'single') return [{ start: from, end: to }];
  if (spec.kind === 'perDay') return eachDate(from, to).map((d) => ({ start: d, end: d }));
  if (spec.kind === 'paged') return [{ start: from, end: to }];
  return chunkDateRange(from, to, maxDays ?? spec.maxDays ?? 31);
}

export function toSyncError(endpoint: string, err: unknown, chunk?: { start?: string; end?: string }): GarminSyncError {
  const e = toGarminError(err);
  return {
    endpoint,
    ...(chunk?.start ? { start: chunk.start } : {}),
    ...(chunk?.end ? { end: chunk.end } : {}),
    kind: e.kind,
    ...(e.status !== undefined ? { status: e.status } : {}),
    retryable: e.retryable,
    message: e.userMessage,
  };
}

function pageLength(raw: unknown): number {
  if (Array.isArray(raw)) return raw.length;
  if (isObject(raw)) {
    for (const k of ['activityList', 'activities', 'data', 'items']) {
      const v = raw[k];
      if (Array.isArray(v)) return v.length;
    }
  }
  return 0;
}

/**
 * Fetches `id` for [from, to], splitting into maxDays chunks (range), one request per date (perDay) or pages of 100
 * (paged). A failed chunk is recorded in `errors` and the rest continue; a fatal AUTH error (bad/expired key or token)
 * is rethrown so the caller can stop. 204 / null responses give `raw: null`.
 */
export async function fetchEndpointRange(
  client: GarminDataClient,
  id: EndpointId,
  from: string,
  to: string,
  opts: FetchRangeOptions = {},
): Promise<FetchRangeResult> {
  const spec = GARMIN_ENDPOINTS[id];
  const chunks: ChunkResult[] = [];
  const errors: GarminSyncError[] = [];
  let requests = 0;

  const run = async (chunk: DateChunk, page?: { start: number; limit: number }, pageIndex?: number): Promise<{ ok: boolean; raw: unknown }> => {
    const req = spec.request(chunk, page);
    requests += 1;
    try {
      const raw = await client.get(req.path, req.params);
      chunks.push({ start: chunk.start, end: chunk.end, ...(pageIndex !== undefined ? { page: pageIndex } : {}), raw });
      return { ok: true, raw };
    } catch (e) {
      if (isFatalAuthError(e)) throw e;
      errors.push(toSyncError(id, e, chunk));
      return { ok: false, raw: null };
    } finally {
      opts.onRequest?.({ endpoint: id, start: chunk.start, end: chunk.end });
    }
  };

  if (spec.kind === 'paged') {
    const limit = opts.pageSize ?? ACTIVITY_PAGE_SIZE;
    for (let page = 0; page < ACTIVITY_MAX_PAGES; page++) {
      const r = await run({ start: from, end: to }, { start: page * limit, limit }, page);
      if (!r.ok || pageLength(r.raw) < limit) break;
    }
    return { chunks, errors, requests };
  }

  const plan = planChunks(id, from, to, opts.maxDays);
  const cap = opts.maxRequests ?? Number.POSITIVE_INFINITY;
  for (const chunk of plan) {
    if (requests >= cap) break;
    await run(chunk);
  }
  return { chunks, errors, requests };
}

/** Alias: `fetchRange(client, 'sleep', from, to)` chunks automatically and collects non-auth failures. */
export const fetchRange = fetchEndpointRange;

type RangeFetcher = (client: GarminDataClient, from: string, to: string, opts?: FetchRangeOptions) => Promise<FetchRangeResult>;
const fetcher = (id: EndpointId): RangeFetcher => (client, from, to, opts) => fetchEndpointRange(client, id, from, to, opts);

/** Per-endpoint conveniences (same behaviour as `fetchEndpointRange` with the id fixed). */
export const fetchDailySummariesRange: RangeFetcher = fetcher('dailySummaries');
export const fetchSleepRange: RangeFetcher = fetcher('sleep');
export const fetchHrvRange: RangeFetcher = fetcher('hrv');
export const fetchWeightAllRange: RangeFetcher = fetcher('weight');
export const fetchBodyBatteryRange: RangeFetcher = fetcher('bodyBattery');
export const fetchStepsRange: RangeFetcher = fetcher('steps');
export const fetchStressRange: RangeFetcher = fetcher('stress');
export const fetchHydrationRange: RangeFetcher = fetcher('hydration');
export const fetchActivitiesRange: RangeFetcher = fetcher('activities');
