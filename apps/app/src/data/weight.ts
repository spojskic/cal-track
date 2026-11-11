import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lbToKg } from '@ration/core';

import { requireUserId } from '@/lib/auth-user';
import { supabase } from '@/lib/supabase';
import { addDays, todayISO } from '@/state/selected-date';

import { invalidateDay, keys } from './keys';
import { useUserId } from './profile';

/*
 * Body measurements live in `biometrics` (shared with the dashboard / device sync):
 *   weight    -> type 'weight',   unit 'kg',      value in kg
 *   body fat  -> type 'body_fat', unit 'percent', value 0-100
 * entry_date is the user's LOCAL date, source is 'manual' for hand-entered values.
 */

export const WEIGHT_TYPE = 'weight';
export const BODY_FAT_TYPE = 'body_fat';

/** Most recent weight and body fat readings (either may be missing). */
export interface LatestBody {
  weightKg: number | null;
  weightDate: string | null;
  bodyFatPct: number | null;
  bodyFatDate: string | null;
}

/** One chart point: the last weight logged on a local date. */
export interface WeightPoint {
  /** YYYY-MM-DD */
  date: string;
  kg: number;
}

interface BiometricRow {
  entry_date: string;
  value: number | string;
  unit: string | null;
  recorded_at?: string | null;
}

/** Normalises a stored weight to kg (tolerates rows that were written in lb). */
function toKg(row: BiometricRow): number {
  const v = Number(row.value);
  return row.unit && row.unit.toLowerCase().startsWith('lb') ? lbToKg(v) : v;
}

async function fetchLatestOf(type: string): Promise<BiometricRow | null> {
  const { data, error } = await supabase
    .from('biometrics')
    .select('entry_date,value,unit,recorded_at')
    .eq('type', type)
    .order('entry_date', { ascending: false })
    .order('recorded_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return ((data ?? [])[0] as BiometricRow | undefined) ?? null;
}

/** Latest weight (kg) and body fat (%), by entry date then recording time. */
export function useLatestBody() {
  const userId = useUserId();
  return useQuery({
    queryKey: [...keys.latestWeight, userId ?? 'anon'],
    enabled: Boolean(userId),
    queryFn: async (): Promise<LatestBody> => {
      const [weight, fat] = await Promise.all([fetchLatestOf(WEIGHT_TYPE), fetchLatestOf(BODY_FAT_TYPE)]);
      return {
        weightKg: weight ? toKg(weight) : null,
        weightDate: weight?.entry_date ?? null,
        bodyFatPct: fat ? Number(fat.value) : null,
        bodyFatDate: fat?.entry_date ?? null,
      };
    },
  });
}

/** Weight points for charts: one per local date (the last one logged), oldest first. `days <= 0` = all time. */
export function useWeightHistory(days: number) {
  const userId = useUserId();
  return useQuery({
    queryKey: ['biometrics', 'weight_history', userId ?? 'anon', days] as const,
    enabled: Boolean(userId),
    queryFn: async (): Promise<WeightPoint[]> => {
      let query = supabase
        .from('biometrics')
        .select('entry_date,value,unit,recorded_at')
        .eq('type', WEIGHT_TYPE)
        .order('entry_date', { ascending: true })
        .order('recorded_at', { ascending: true });
      if (days > 0) query = query.gte('entry_date', addDays(todayISO(), -days));
      const { data, error } = await query;
      if (error) throw error;
      const byDate = new Map<string, number>();
      for (const row of (data ?? []) as BiometricRow[]) byDate.set(row.entry_date, toKg(row));
      return [...byDate.entries()].map(([date, kg]) => ({ date, kg }));
    },
  });
}

/** Inserts a weight (and optionally body fat) reading. Does not touch caches. */
export async function insertBodyReadings(input: {
  weightKg: number;
  bodyFatPct?: number | null;
  /** Local date, default today. */
  date?: string;
}): Promise<string> {
  const userId = await requireUserId();
  const entry_date = input.date ?? todayISO();
  const rows: Record<string, unknown>[] = [
    {
      user_id: userId,
      entry_date,
      type: WEIGHT_TYPE,
      value: Math.round(input.weightKg * 100) / 100,
      unit: 'kg',
      source: 'manual',
    },
  ];
  if (typeof input.bodyFatPct === 'number' && Number.isFinite(input.bodyFatPct)) {
    rows.push({
      user_id: userId,
      entry_date,
      type: BODY_FAT_TYPE,
      value: Math.round(input.bodyFatPct * 10) / 10,
      unit: 'percent',
      source: 'manual',
    });
  }
  const { error } = await supabase.from('biometrics').insert(rows);
  if (error) throw error;
  return entry_date;
}

/** Logs weight (kg) and optional body fat (%). Refreshes weight queries, the day's biometrics and targets. */
export function useLogWeight() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: insertBodyReadings,
    onSuccess: async (entryDate) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['biometrics'] }),
        qc.invalidateQueries({ queryKey: keys.targets }),
        invalidateDay(qc, entryDate),
      ]);
    },
  });
}
