// Orchestration: the minimum number of requests to fill the requested data types for a date range.
//
// Plan: daily summaries (one ranged call) supply energy, steps, resting HR, stress, body battery, respiration and SpO2
// when those fields exist. Dedicated endpoints are used for sleep (31-day chunks), HRV (ranged), weight/body fat
// (ranged) and workouts (paginated). Fallbacks run only for dates/fields the summaries did not provide:
//   - ranged fallbacks (body battery report, stress stats, steps stats, weight/range) are on by default;
//   - per-day fallbacks (daily heart rate, SpO2) are OFF by default and capped, because they cost one request per day;
//   - night-time SpO2 / respiration from the sleep response fill gaps for free (flagged meta.source = 'sleep').
// Auth errors abort the sync (the promise rejects); every other failure is collected in `errors`.

import { diffDays, eachDate, type DateChunk } from './dates';
import {
  fetchEndpointRange,
  planChunks,
  type ChunkResult,
  type EndpointId,
  type FetchRangeResult,
} from './endpoints';
import type { GarminDataClient } from './client';
import { GarminError } from './errors';
import {
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
  mergeCoverage,
  mergeDiagnostics,
  type SleepExtra,
} from './mappers';
import type {
  GarminBiometric,
  GarminBiometricType,
  GarminDailyEnergy,
  GarminDiagnostic,
  GarminFieldCoverage,
  GarminSyncError,
  GarminWorkout,
} from './normalized';
import { GARMIN_BIOMETRIC_UNITS } from './normalized';

export interface GarminSyncInclude {
  /** Active/resting/total kcal and steps. */
  energy?: boolean;
  workouts?: boolean;
  weight?: boolean;
  bodyFat?: boolean;
  restingHr?: boolean;
  hrv?: boolean;
  spo2?: boolean;
  respiration?: boolean;
  sleep?: boolean;
  bodyBattery?: boolean;
  stress?: boolean;
}

export interface GarminSyncFallbacks {
  /** Use other RANGED endpoints for fields the daily summaries lacked. Default true. */
  rangedEndpoints?: boolean;
  /** Use per-day endpoints (daily heart rate, SpO2). One request per day. Default false. */
  perDayEndpoints?: boolean;
  /** Cap for per-day fallback requests per endpoint. Default 31. */
  maxPerDayRequests?: number;
}

export interface GarminSyncProgress {
  endpoint: EndpointId;
  completedRequests: number;
  /** Planned so far (grows when fallbacks are scheduled). */
  plannedRequests: number;
}

export interface FetchGarminDataOptions {
  /** First local date, YYYY-MM-DD. */
  from: string;
  /** Last local date (inclusive). */
  to: string;
  include: GarminSyncInclude;
  onProgress?: (p: GarminSyncProgress) => void;
  fallbacks?: GarminSyncFallbacks;
}

export interface GarminSyncResult {
  energy: GarminDailyEnergy[];
  workouts: GarminWorkout[];
  biometrics: GarminBiometric[];
  diagnostics: GarminDiagnostic[];
  coverage: GarminFieldCoverage[];
  /** Non-fatal failures; the rest of the sync completed. */
  errors: GarminSyncError[];
  /** `client.get` calls made (token exchanges and internal retries are not counted here). */
  requestCount: number;
}

const sortBy = <T>(list: T[], key: (t: T) => string): T[] => list.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

function dedupeBy<T>(list: T[], key: (t: T) => string): T[] {
  const map = new Map<string, T>();
  for (const it of list) map.set(key(it), it);
  return [...map.values()];
}

function sourceBio(type: GarminBiometricType, date: string, value: number, meta: Record<string, string | number | boolean>): GarminBiometric {
  return { date, type, value, unit: GARMIN_BIOMETRIC_UNITS[type], externalId: `garmin:${type}:${date}`, meta };
}

export async function fetchGarminData(client: GarminDataClient, options: FetchGarminDataOptions): Promise<GarminSyncResult> {
  const { from, to } = options;
  if (diffDays(from, to) < 0) {
    throw new GarminError({ kind: 'bad_request', message: 'from is after to', userMessage: 'The start date is after the end date.' });
  }
  const inc = options.include;
  const fb = {
    rangedEndpoints: options.fallbacks?.rangedEndpoints ?? true,
    perDayEndpoints: options.fallbacks?.perDayEndpoints ?? false,
    maxPerDay: Math.max(0, options.fallbacks?.maxPerDayRequests ?? 31),
  };
  const allDates = eachDate(from, to);

  const energy: GarminDailyEnergy[] = [];
  const workouts: GarminWorkout[] = [];
  const biometrics: GarminBiometric[] = [];
  const diagLists: GarminDiagnostic[][] = [];
  const covLists: GarminFieldCoverage[][] = [];
  const errors: GarminSyncError[] = [];
  let requestCount = 0;
  let planned = 0;
  let completed = 0;

  const needSummaries = !!(inc.energy || inc.restingHr || inc.spo2 || inc.respiration || inc.bodyBattery || inc.stress);
  const needWeight = !!(inc.weight || inc.bodyFat);
  const plan = (id: EndpointId, a: string, b: string): number => planChunks(id, a, b).length;
  if (needSummaries) planned += plan('dailySummaries', from, to);
  if (inc.sleep) planned += plan('sleep', from, to);
  if (inc.hrv) planned += plan('hrv', from, to);
  if (needWeight) planned += plan('weight', from, to);
  if (inc.workouts) planned += 1;

  const fetchRange = async (id: EndpointId, a: string, b: string): Promise<FetchRangeResult> => {
    const r = await fetchEndpointRange(client, id, a, b, {
      onRequest: ({ endpoint }) => {
        completed += 1;
        options.onProgress?.({ endpoint, completedRequests: completed, plannedRequests: Math.max(planned, completed) });
      },
    });
    requestCount += r.requests;
    errors.push(...r.errors);
    return r;
  };

  const take = (r: { diagnostics: GarminDiagnostic[]; coverage: GarminFieldCoverage[] }): void => {
    diagLists.push(r.diagnostics);
    covLists.push(r.coverage);
  };

  // Dates whose data we cannot judge because the request failed.
  const unknownDates = new Set<string>();
  const markUnknown = (r: FetchRangeResult): void => {
    for (const e of r.errors) if (e.start && e.end) for (const d of eachDate(e.start, e.end)) unknownDates.add(d);
  };

  // ---- 1. daily summaries ------------------------------------------------------------------------------------------
  const summaryDates = new Set<string>();
  if (needSummaries) {
    const r = await fetchRange('dailySummaries', from, to);
    markUnknown(r);
    for (const ch of r.chunks) {
      const m = mapDailySummaries(ch.raw, {
        include: {
          energy: !!inc.energy,
          restingHr: !!inc.restingHr,
          spo2: !!inc.spo2,
          respiration: !!inc.respiration,
          bodyBattery: !!inc.bodyBattery,
          stress: !!inc.stress,
        },
      });
      energy.push(...m.energy);
      biometrics.push(...m.biometrics);
      for (const d of m.dates) summaryDates.add(d);
      take(m);
    }
  }

  // ---- 2. sleep ----------------------------------------------------------------------------------------------------
  const sleepExtras: SleepExtra[] = [];
  if (inc.sleep) {
    const r = await fetchRange('sleep', from, to);
    for (const ch of r.chunks) {
      const m = mapSleep(ch.raw);
      biometrics.push(...m.items);
      sleepExtras.push(...m.extras);
      take(m);
    }
  }

  // ---- 3. HRV ------------------------------------------------------------------------------------------------------
  if (inc.hrv) {
    const r = await fetchRange('hrv', from, to);
    for (const ch of r.chunks) {
      const m = mapHrv(ch.raw);
      biometrics.push(...m.items);
      take(m);
    }
  }

  // ---- 4. weight / body fat ----------------------------------------------------------------------------------------
  if (needWeight) {
    const weightInclude = { weight: !!inc.weight, bodyFat: !!inc.bodyFat };
    const r = await fetchRange('weight', from, to);
    // Chunks whose request failed, or whose response was not a recognisable container, are retried via weight/range.
    const retry: DateChunk[] = r.errors.filter((e) => e.start && e.end).map((e) => ({ start: e.start as string, end: e.end as string }));
      for (const ch of r.chunks) {
      const m = mapWeight(ch.raw, { include: weightInclude });
      if (fb.rangedEndpoints && m.diagnostics.some((d) => d.field === '$' && d.reason === 'unexpected_shape')) {
        retry.push({ start: ch.start, end: ch.end });
      }
      biometrics.push(...m.items);
      take(m);
    }
    if (retry.length && fb.rangedEndpoints) {
      planned += retry.length;
      diagLists.push([
        { endpoint: 'weight', field: '$', reason: 'fallback_used', count: retry.length, detail: 'weight/all failed or was unreadable for some ranges; tried weight/range' },
      ]);
      for (const c of retry) {
        const rr = await fetchRange('weightRange', c.start, c.end);
        for (const ch of rr.chunks) {
          const m = mapWeight(ch.raw, { include: weightInclude });
          biometrics.push(...m.items);
          take(m);
        }
      }
    }
  }

  // ---- 5. workouts -------------------------------------------------------------------------------------------------
  if (inc.workouts) {
    const r = await fetchRange('activities', from, to);
    for (const ch of r.chunks) {
      const m = mapActivities(ch.raw);
      workouts.push(...m.items);
      take(m);
    }
  }

  // ---- 6. fallbacks for fields the daily summaries did not provide ---------------------------------------------------
  if (needSummaries) {
    const judged = (d: string): boolean => summaryDates.has(d) || unknownDates.has(d);
    const has = (type: GarminBiometricType): Set<string> => new Set(biometrics.filter((b) => b.type === type).map((b) => b.date));
    const missingFor = (type: GarminBiometricType): string[] => {
      const have = has(type);
      return allDates.filter((d) => judged(d) && !have.has(d));
    };
    const missingChunks = (id: EndpointId, dates: string[]): DateChunk[] => {
      if (!dates.length) return [];
      const first = dates[0] as string;
      const last = dates[dates.length - 1] as string;
      return planChunks(id, first, last).filter((c) => dates.some((d) => d >= c.start && d <= c.end));
    };

    // Free: night-time SpO2 / respiration from the sleep response.
    if (inc.sleep && sleepExtras.length) {
      for (const [type, flag] of [['spo2', inc.spo2], ['respiration_rate', inc.respiration]] as const) {
        if (!flag) continue;
        const miss = new Set(missingFor(type));
        let used = 0;
        for (const x of sleepExtras) {
          if (!miss.has(x.date)) continue;
          if (type === 'spo2' && x.spo2 !== undefined) {
            biometrics.push(sourceBio('spo2', x.date, x.spo2, { source: 'sleep', ...(x.spo2Low !== undefined ? { low: x.spo2Low } : {}) }));
            used += 1;
          } else if (type === 'respiration_rate' && x.respiration !== undefined) {
            biometrics.push(sourceBio('respiration_rate', x.date, x.respiration, { source: 'sleep' }));
            used += 1;
          }
        }
        if (used) {
          diagLists.push([{ endpoint: 'sleep', field: type, reason: 'fallback_used', count: used, detail: 'daily value missing; used the night-time average from the sleep response' }]);
        }
      }
    }

    if (fb.rangedEndpoints) {
      if (inc.bodyBattery) {
        const chunks = missingChunks('bodyBattery', missingFor('body_battery'));
        planned += chunks.length;
        for (const c of chunks) {
          const r = await fetchRange('bodyBattery', c.start, c.end);
          for (const ch of r.chunks) {
            const m = mapBodyBattery(ch.raw);
            biometrics.push(...m.items);
            take(m);
          }
        }
      }
      if (inc.stress) {
        const chunks = missingChunks('stress', missingFor('stress'));
        planned += chunks.length;
        for (const c of chunks) {
          const r = await fetchRange('stress', c.start, c.end);
          for (const ch of r.chunks) {
            const m = mapStressDaily(ch.raw);
            biometrics.push(...m.items);
            take(m);
          }
        }
      }
      if (inc.energy) {
        const haveSteps = new Set(energy.filter((e) => e.steps !== undefined).map((e) => e.date));
        const dates = allDates.filter((d) => judged(d) && !haveSteps.has(d));
        const chunks = missingChunks('steps', dates);
        planned += chunks.length;
        for (const c of chunks) {
          const r = await fetchRange('steps', c.start, c.end);
          for (const ch of r.chunks) {
            const m = mapStepsDaily(ch.raw);
            energy.push(...m.items);
            take(m);
          }
        }
      }
    }

    if (fb.perDayEndpoints && fb.maxPerDay > 0) {
      const perDay = async (id: 'heartRateDay' | 'spo2Day', dates: string[], handle: (ch: ChunkResult) => void): Promise<void> => {
        const list = dates.slice(0, fb.maxPerDay);
        planned += list.length;
        for (const d of list) {
          const r = await fetchRange(id, d, d);
          for (const ch of r.chunks) handle(ch);
        }
      };
      if (inc.restingHr) {
        await perDay('heartRateDay', missingFor('resting_heart_rate'), (ch) => {
          const m = mapHeartRateDay(ch.raw, ch.start);
          biometrics.push(...m.items);
          take(m);
        });
      }
      if (inc.spo2) {
        await perDay('spo2Day', missingFor('spo2'), (ch) => {
          const m = mapSpo2Day(ch.raw, ch.start);
          biometrics.push(...m.items);
          take(m);
        });
      }
    }
  }

  // Combine steps-only rows with the summaries' rows.
  const energyByDate = new Map<string, GarminDailyEnergy>();
  for (const e of energy) energyByDate.set(e.date, { ...(energyByDate.get(e.date) ?? {}), ...e });

  return {
    energy: sortBy([...energyByDate.values()], (e) => e.date),
    workouts: sortBy(dedupeBy(workouts, (w) => w.externalId), (w) => String(w.startMs).padStart(16, '0')),
    biometrics: sortBy(dedupeBy(biometrics, (b) => b.externalId), (b) => `${b.date}|${b.type}|${b.externalId}`),
    diagnostics: mergeDiagnostics(...diagLists),
    coverage: mergeCoverage(...covLists),
    errors,
    requestCount,
  };
}
