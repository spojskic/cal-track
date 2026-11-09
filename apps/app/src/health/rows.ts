// Row builders: provider points -> the exact column sets written to Supabase. Pure.
import { isFiniteNumber, round } from './mapping';
import type {
  BiometricPoint,
  BiometricRowInput,
  DailyEnergyPoint,
  DailyEnergyRowInput,
  ExerciseRowInput,
  HealthProviderId,
  WorkoutPoint,
} from './types';

export function buildDailyEnergyRows(
  userId: string,
  source: HealthProviderId,
  points: readonly DailyEnergyPoint[],
): DailyEnergyRowInput[] {
  const rows: DailyEnergyRowInput[] = [];
  for (const p of points) {
    const active = isFiniteNumber(p.activeKcal) && p.activeKcal >= 0 ? round(p.activeKcal, 0) : null;
    const resting = isFiniteNumber(p.restingKcal) && p.restingKcal >= 0 ? round(p.restingKcal, 0) : null;
    const steps = isFiniteNumber(p.steps) && p.steps >= 0 ? Math.round(p.steps) : null;
    // A row with nothing in it would only overwrite a good earlier value with nulls.
    if (active === null && resting === null && steps === null) continue;
    rows.push({
      user_id: userId,
      local_date: p.date,
      source,
      active_kcal: active,
      resting_kcal: resting,
      steps,
    });
  }
  return rows;
}

/** Device workouts are informational (counts_toward_energy = false): their energy is already in the daily active kcal. */
export function buildExerciseRows(
  userId: string,
  source: HealthProviderId,
  workouts: readonly WorkoutPoint[],
): ExerciseRowInput[] {
  const seen = new Set<string>();
  const rows: ExerciseRowInput[] = [];
  for (const w of workouts) {
    if (!w.externalId || seen.has(w.externalId)) continue;
    if (!(Date.parse(w.endedAt) >= Date.parse(w.startedAt))) continue;
    seen.add(w.externalId);
    rows.push({
      user_id: userId,
      entry_date: w.date,
      activity_code: null,
      name: w.name || 'Workout',
      minutes: round(Math.max(0, w.minutes), 1),
      kcal: round(Math.max(0, isFiniteNumber(w.kcal) ? w.kcal : 0), 0),
      source,
      external_id: w.externalId,
      started_at: w.startedAt,
      ended_at: w.endedAt,
      counts_toward_energy: false,
    });
  }
  return rows;
}

export function buildBiometricRows(
  userId: string,
  source: HealthProviderId,
  points: readonly BiometricPoint[],
): BiometricRowInput[] {
  const seen = new Set<string>();
  const rows: BiometricRowInput[] = [];
  for (const p of points) {
    if (!isFiniteNumber(p.value) || p.value <= 0 || !p.externalId) continue;
    if (seen.has(p.externalId)) continue;
    seen.add(p.externalId);
    rows.push({
      user_id: userId,
      entry_date: p.date,
      type: p.type,
      value: round(p.value, 3),
      unit: p.unit,
      source,
      external_id: p.externalId,
      recorded_at: p.recordedAt,
      meta: p.meta ?? {},
    });
  }
  return rows;
}

export interface ExistingIdMap {
  get(externalId: string): string | undefined;
}

/**
 * `exercise_entries` and `biometrics` are unique on (user_id, source, external_id) through a PARTIAL index
 * (`where external_id is not null`). PostgREST cannot target a partial index in ON CONFLICT, so the writer looks up the
 * existing rows first: known external ids are updated by primary key, the rest are inserted.
 */
export function planUpsert<Row extends { external_id: string }>(
  rows: readonly Row[],
  existing: ExistingIdMap,
): { toInsert: Row[]; toUpdate: (Row & { id: string })[] } {
  const toInsert: Row[] = [];
  const toUpdate: (Row & { id: string })[] = [];
  for (const row of rows) {
    const id = existing.get(row.external_id);
    if (id) toUpdate.push({ ...row, id });
    else toInsert.push(row);
  }
  return { toInsert, toUpdate };
}
