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

/**
 * exercise_entries / biometrics are unique on (user_id, source, external_id) through a PARTIAL index
 * (`where external_id is not null`), which PostgREST cannot use as an ON CONFLICT target. So: look up the existing ids,
 * update those by primary key and insert the rest. A concurrent writer making the insert fail with a unique violation
 * is handled by one retry (the second pass sees the rows and updates them).
 */
async function writeExternal<Row extends ExternalRow>(
  table: 'exercise_entries' | 'biometrics',
  rows: readonly Row[],
  stripForUpdate: (row: Row & { id: string }) => Record<string, unknown>,
  attempt = 0,
): Promise<void> {
  const first = rows[0];
  if (!first) return;
  const { data, error } = await supabase
    .from(table)
    .select('id, external_id')
    .eq('user_id', first.user_id)
    .eq('source', first.source)
    .in('external_id', rows.map((r) => r.external_id));
  if (error) throw error;

  const existing = new Map<string, string>();
  for (const r of (data ?? []) as { id: string; external_id: string }[]) existing.set(r.external_id, r.id);
  const { toInsert, toUpdate } = planUpsert(rows, existing);

  if (toInsert.length > 0) {
    const { error: insertError } = await supabase.from(table).insert(toInsert);
    if (insertError) {
      if (insertError.code === UNIQUE_VIOLATION && attempt < 1) return writeExternal(table, rows, stripForUpdate, attempt + 1);
      throw insertError;
    }
  }
  if (toUpdate.length > 0) {
    const { error: updateError } = await supabase.from(table).upsert(toUpdate.map(stripForUpdate), { onConflict: 'id' });
    if (updateError) throw updateError;
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
        await writeExternal('exercise_entries', batch, (row) => {
          // Keep user choices (counts_toward_energy, activity_code) on rows that already exist.
          const { counts_toward_energy: _c, activity_code: _a, ...rest } = row;
          return rest;
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
