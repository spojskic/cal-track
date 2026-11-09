// Platform independent sync orchestration. Pure: the provider and the writer are injected, so it is unit-testable with
// fakes. Reads newest chunk first, never aborts the whole run because one data type or one chunk failed.
import { chunkRangeNewestFirst } from './dates';
import { summarizeCounts } from './mapping';
import { buildBiometricRows, buildDailyEnergyRows, buildExerciseRows } from './rows';
import type {
  BiometricDataType,
  BiometricRowType,
  DateRange,
  HealthDataType,
  HealthProvider,
  SyncCounts,
  SyncIssue,
  SyncProgress,
  SyncResult,
  SyncWriter,
} from './types';

export const DEFAULT_CHUNK_DAYS = 7;

export interface RunSyncParams {
  provider: HealthProvider;
  writer: SyncWriter;
  userId: string;
  /** Data types to import (already filtered by the user's toggles and by granted permissions). */
  types: readonly HealthDataType[];
  /** Inclusive local-date range. */
  range: DateRange;
  chunkDays?: number;
  onProgress?: (progress: SyncProgress) => void;
  isCancelled?: () => boolean;
}

export const errorText = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return typeof error === 'string' && error ? error : 'Unknown error';
};

export async function runSync(params: RunSyncParams): Promise<SyncResult> {
  const { provider, writer, userId, types, range, onProgress, isCancelled } = params;
  const chunks = chunkRangeNewestFirst(range, params.chunkDays ?? DEFAULT_CHUNK_DAYS);
  const issues: SyncIssue[] = [];
  const counts: SyncCounts = { energyDays: 0, workouts: 0, biometrics: {} };
  const steps = { total: 0, succeeded: 0 };
  // A workout / sample touching two chunks is read twice but must be counted once.
  const countedWorkouts = new Set<string>();
  const countedBiometrics = new Set<string>();
  const seenIssue = new Set<string>();

  const report = (scope: SyncIssue['scope'], chunk: DateRange, error: unknown) => {
    const message = errorText(error);
    const key = `${scope}:${message}`;
    // The same failure on every chunk (e.g. permission denied) is one issue, not five.
    if (seenIssue.has(key)) return;
    seenIssue.add(key);
    issues.push({ scope, range: chunk, message });
  };

  const attempt = async (scope: HealthDataType, chunk: DateRange, work: () => Promise<void>) => {
    steps.total += 1;
    try {
      await work();
      steps.succeeded += 1;
    } catch (error) {
      report(scope, chunk, error);
    }
  };

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i] as DateRange;
    for (const type of types) {
      if (isCancelled?.()) break;
      const progress = (message: string) =>
        onProgress?.({ chunkIndex: i + 1, chunkCount: chunks.length, range: chunk, type, message });
      progress(`Reading ${chunk.from} to ${chunk.to}`);

      if (type === 'activity') {
        await attempt('activity', chunk, async () => {
          const rows = buildDailyEnergyRows(userId, provider.id, await provider.readDailyEnergy(chunk));
          if (rows.length > 0) await writer.upsertDailyEnergy(rows);
          counts.energyDays += rows.length;
        });
        await attempt('activity', chunk, async () => {
          const rows = buildExerciseRows(userId, provider.id, await provider.readWorkouts(chunk));
          if (rows.length > 0) await writer.upsertExercises(rows);
          for (const row of rows) {
            if (!countedWorkouts.has(row.external_id)) {
              countedWorkouts.add(row.external_id);
              counts.workouts += 1;
            }
          }
        });
      } else {
        await attempt(type, chunk, async () => {
          const rows = buildBiometricRows(userId, provider.id, await provider.readBiometrics(type as BiometricDataType, chunk));
          if (rows.length > 0) await writer.upsertBiometrics(rows);
          for (const row of rows) {
            if (countedBiometrics.has(row.external_id)) continue;
            countedBiometrics.add(row.external_id);
            const key: BiometricRowType = row.type;
            counts.biometrics[key] = (counts.biometrics[key] ?? 0) + 1;
          }
        });
      }
    }
    if (isCancelled?.()) break;
  }

  return {
    ok: issues.length === 0,
    range,
    counts,
    issues,
    summary: summarizeCounts(counts),
    steps,
  };
}
