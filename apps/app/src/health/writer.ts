// Supabase implementation of SyncWriter. Idempotent: re-syncing never duplicates rows.
import { supabase } from '@/lib/supabase';

import { planUpsert } from './rows';
import type {
  BiometricRowInput,
  DailyEnergyRowInput,
  ExerciseRowInput,
  SyncWriter,
} from './types';

const BATCH = 100;
const UNIQUE_VIOLATION = '23505';

function batches<T>(items: readonly T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type ExternalRow = { user_id: string; source: string; external_id: string };

/** What an update needs to know about the row that is already stored. */
interface ExistingRow {
  id: string;
  /** `exercise_entries.details->>'level'`: 'full' once the details were read from the per-activity endpoints. */
  detailsLevel: string | null;
}

/**
 * exercise_entries / biometrics are unique on (user_id, source, external_id) through a PARTIAL index
 * (`where external_id is not null`), which PostgREST cannot use as an ON CONFLICT target. So: look up the existing ids,
 * update those by primary key and insert the rest. A concurrent writer making the insert fail with a unique violation
 * is handled by one retry (the second pass sees the rows and updates them).
 *
 * `stripForUpdate` returns the columns an UPDATE writes. A bulk upsert writes the union of the columns of its rows (a row without
 * one of them gets null), so updates whose column sets differ (with and without `details`) are sent as separate calls.
 */
async function writeExternal<Row extends ExternalRow>(
  table: 'exercise_entries' | 'biometrics',
  rows: readonly Row[],
  stripForUpdate: (row: Row & { id: string }, existing: ExistingRow) => Record<string, unknown>,
  attempt = 0,
): Promise<void> {
  const first = rows[0];
  if (!first) return;
  const { data, error } = await supabase
    .from(table)
    .select(table === 'exercise_entries' ? 'id, external_id, details_level:details->>level' : 'id, external_id')
    .eq('user_id', first.user_id)
    .eq('source', first.source)
    .in('external_id', rows.map((r) => r.external_id));
  if (error) throw error;

  const existing = new Map<string, ExistingRow>();
  for (const r of (data ?? []) as unknown as { id: string; external_id: string; details_level?: string | null }[]) {
    existing.set(r.external_id, { id: r.id, detailsLevel: r.details_level ?? null });
  }
  const ids = { get: (externalId: string) => existing.get(externalId)?.id };
  const { toInsert, toUpdate } = planUpsert(rows, ids);

  if (toInsert.length > 0) {
    const { error: insertError } = await supabase.from(table).insert(toInsert);
    if (insertError) {
      if (insertError.code === UNIQUE_VIOLATION && attempt < 1) return writeExternal(table, rows, stripForUpdate, attempt + 1);
      throw insertError;
    }
  }
  if (toUpdate.length > 0) {
    const stripped = toUpdate.map((row) => stripForUpdate(row, existing.get(row.external_id) ?? { id: row.id, detailsLevel: null }));
    // Same column set per call.
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const row of stripped) {
      const key = Object.keys(row).sort().join(',');
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const group of groups.values()) {
      const { error: updateError } = await supabase.from(table).upsert(group, { onConflict: 'id' });
      if (updateError) throw updateError;
    }
  }
}

export function createSupabaseWriter(): SyncWriter {
  return {
    async upsertDailyEnergy(rows: DailyEnergyRowInput[]) {
      for (const batch of batches(rows)) {
        const { error } = await supabase.from('daily_energy').upsert(batch, { onConflict: 'user_id,local_date,source' });
        if (error) throw error;
      }
    },

    async upsertExercises(rows: ExerciseRowInput[]) {
      for (const batch of batches(rows)) {
        await writeExternal('exercise_entries', batch, (row, existing) => {
          // Keep user choices (counts_toward_energy, activity_code) on rows that already exist.
          const { counts_toward_energy: _c, activity_code: _a, details, ...rest } = row;
          // The device summary (the activity list's heart rate and zones) fills in details that are missing or are only a summary
          // themselves. Details read from the per-activity endpoints (level 'full') are never replaced by a summary.
          return details !== undefined && existing.detailsLevel !== 'full' ? { ...rest, details } : rest;
        });
      }
    },

    async upsertBiometrics(rows: BiometricRowInput[]) {
      for (const batch of batches(rows)) {
        await writeExternal('biometrics', batch, (row) => ({ ...row }));
      }
    },
  };
}
