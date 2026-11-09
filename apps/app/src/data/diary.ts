// Diary read/write hooks. Entries store only (food_id, grams); per-entry nutrients are computed on the
// client from the joined food (scaleNutrients, then deriveNutrients with THAT food's carb basis, then summed).
import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  deriveNutrients,
  scaleNutrients,
  sumNutrientsDetailed,
  type CarbBasis,
  type NutrientCode,
  type NutrientMap,
} from '@cal/core';

import { supabase } from '@/lib/supabase';
import { addDays, todayISO } from '@/state/selected-date';

import type { DiarySource } from './diary-write';
import { dayKey, invalidateDay } from './keys';

// ---------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------

interface FoodJoin {
  name: string;
  brand: string | null;
  kind: string;
  nutrients: NutrientMap | null;
  carb_basis: CarbBasis | null;
}

/** Raw row of diary_entries with the embedded food (what is cached in react-query). */
export interface DiaryEntryRow {
  id: string;
  entry_date: string;
  meal_group_id: string | null;
  food_id: string;
  grams: number;
  amount: number | null;
  portion_label: string | null;
  source: DiarySource;
  note: string | null;
  logged_at: string;
  foods: FoodJoin | FoodJoin[] | null;
}

export interface DiaryFoodInfo {
  name: string;
  brand: string | null;
  kind: string;
  carbBasis: CarbBasis;
  /** Per 100 g, as stored (missing key = unknown). */
  nutrients: NutrientMap;
}

/** A diary entry with computed nutrients. Macros are `undefined` when the food has no data for them. */
export interface DiaryEntry {
  id: string;
  entryDate: string;
  mealGroupId: string | null;
  foodId: string;
  grams: number;
  /** Display amount in a portion unit, e.g. 2 for "2 x slice". */
  amount: number | null;
  portionLabel: string | null;
  source: DiarySource;
  note: string | null;
  loggedAt: string;
  food: DiaryFoodInfo;
  /** Scaled to the consumed grams and derived (net carbs, omega totals, energy fallback). */
  nutrients: NutrientMap;
  kcal: number | undefined;
  proteinG: number | undefined;
  carbsG: number | undefined;
  netCarbsG: number | undefined;
  fatG: number | undefined;
}

export interface GroupTotals {
  count: number;
  kcal: number;
  proteinG: number;
  carbsG: number;
  netCarbsG: number;
  fatG: number;
}

/** Key used in `byGroup` for entries without a (valid) meal group. */
export const UNGROUPED = 'none';

export interface DayNutrients {
  date: string;
  entries: DiaryEntry[];
  hasEntries: boolean;
  /** Sum of the per-entry nutrients. A missing key = no entry has data for it (unknown, not zero). */
  totals: NutrientMap;
  /** Nutrients known for some entries but not all: the total is a lower bound. */
  incompleteNutrients: NutrientCode[];
  /** Convenience macro sums (0 when unknown). */
  kcal: number;
  proteinG: number;
  carbsG: number;
  netCarbsG: number;
  fatG: number;
  fiberG: number;
  /** Per meal group id ({@link UNGROUPED} for orphans). */
  byGroup: Record<string, GroupTotals>;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------

const ENTRY_SELECT =
  'id,entry_date,meal_group_id,food_id,grams,amount,portion_label,source,note,logged_at,foods(name,brand,kind,nutrients,carb_basis)';

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** Computes the per-entry nutrients: scale per-100g by grams, then derive using the food's own carb basis. */
export function toDiaryEntry(row: DiaryEntryRow): DiaryEntry {
  const joined = Array.isArray(row.foods) ? row.foods[0] : row.foods;
  const food: DiaryFoodInfo = {
    name: joined?.name ?? 'Unknown food',
    brand: joined?.brand ?? null,
    kind: joined?.kind ?? 'custom',
    carbBasis: joined?.carb_basis ?? 'includes_fiber',
    nutrients: joined?.nutrients ?? {},
  };
  const grams = num(row.grams) ?? 0;
  const nutrients = deriveNutrients(scaleNutrients(food.nutrients, grams), { carbBasis: food.carbBasis });
  return {
    id: row.id,
    entryDate: row.entry_date,
    mealGroupId: row.meal_group_id,
    foodId: row.food_id,
    grams,
    amount: num(row.amount),
    portionLabel: row.portion_label,
    source: row.source,
    note: row.note,
    loggedAt: row.logged_at,
    food,
    nutrients,
    kcal: nutrients.ENERGY_KCAL,
    proteinG: nutrients.PROTEIN_G,
    carbsG: nutrients.CARBS_G,
    netCarbsG: nutrients.NET_CARBS_G,
    fatG: nutrients.FAT_G,
  };
}

const EMPTY_ENTRIES: DiaryEntry[] = [];

function emptyGroup(): GroupTotals {
  return { count: 0, kcal: 0, proteinG: 0, carbsG: 0, netCarbsG: 0, fatG: 0 };
}

/** Day aggregate from entries. Exported for reuse/testing. */
export function summarizeEntries(entries: readonly DiaryEntry[], knownGroupIds?: ReadonlySet<string>) {
  const { totals, incompleteNutrients } = sumNutrientsDetailed(entries.map((e) => e.nutrients));
  const byGroup: Record<string, GroupTotals> = {};
  for (const e of entries) {
    const key = e.mealGroupId && (!knownGroupIds || knownGroupIds.has(e.mealGroupId)) ? e.mealGroupId : UNGROUPED;
    const g = (byGroup[key] ??= emptyGroup());
    g.count += 1;
    g.kcal += e.kcal ?? 0;
    g.proteinG += e.proteinG ?? 0;
    g.carbsG += e.carbsG ?? 0;
    g.netCarbsG += e.netCarbsG ?? 0;
    g.fatG += e.fatG ?? 0;
  }
  return { totals, incompleteNutrients, byGroup };
}

// ---------------------------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------------------------

async function fetchEntries(date: string): Promise<DiaryEntryRow[]> {
  const { data, error } = await supabase
    .from('diary_entries')
    .select(ENTRY_SELECT)
    .eq('entry_date', date)
    .order('logged_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as DiaryEntryRow[];
}

const selectEntries = (rows: DiaryEntryRow[]): DiaryEntry[] => rows.map(toDiaryEntry);

/** Diary entries of one local date with computed per-entry kcal/macros/nutrients, oldest first. */
export function useDiaryEntries(date: string) {
  return useQuery({
    queryKey: dayKey(date, 'entries'),
    queryFn: () => fetchEntries(date),
    select: selectEntries,
  });
}

/** Day totals + per-entry data. Totals are the sum of per-entry (scaled, then derived) nutrient maps. */
export function useDayNutrients(date: string): DayNutrients {
  const q = useDiaryEntries(date);
  const entries = q.data ?? EMPTY_ENTRIES;
  const summary = useMemo(() => summarizeEntries(entries), [entries]);
  return {
    date,
    entries,
    hasEntries: entries.length > 0,
    totals: summary.totals,
    incompleteNutrients: summary.incompleteNutrients,
    kcal: summary.totals.ENERGY_KCAL ?? 0,
    proteinG: summary.totals.PROTEIN_G ?? 0,
    carbsG: summary.totals.CARBS_G ?? 0,
    netCarbsG: summary.totals.NET_CARBS_G ?? 0,
    fatG: summary.totals.FAT_G ?? 0,
    fiberG: summary.totals.FIBER_G ?? 0,
    byGroup: summary.byGroup,
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    isError: q.isError,
    error: q.error,
    refetch: q.refetch,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Mutations (optimistic on the cached raw rows; the DB trigger keeps daily_totals in sync)
// ---------------------------------------------------------------------------------------------------------------

/** Refetch every dashboard "recent days" query (they are keyed under today's day prefix). */
function invalidateRecent(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({
    queryKey: ['day'],
    predicate: (q) => q.queryKey[2] === 'totals' && q.queryKey[3] === 'recent',
  });
}

async function settle(qc: QueryClient, date: string): Promise<void> {
  await Promise.all([invalidateDay(qc, date), invalidateRecent(qc)]);
}

interface OptimisticContext {
  previous: DiaryEntryRow[] | undefined;
  key: ReturnType<typeof dayKey>;
}

async function patchRows(
  qc: QueryClient,
  date: string,
  fn: (rows: DiaryEntryRow[]) => DiaryEntryRow[],
): Promise<OptimisticContext> {
  const key = dayKey(date, 'entries');
  await qc.cancelQueries({ queryKey: key });
  const previous = qc.getQueryData<DiaryEntryRow[]>(key);
  if (previous) qc.setQueryData<DiaryEntryRow[]>(key, fn(previous));
  return { previous, key };
}

function rollback(qc: QueryClient, ctx: OptimisticContext | undefined) {
  if (ctx?.previous) qc.setQueryData(ctx.key, ctx.previous);
}

export interface UpdateDiaryEntryInput {
  id: string;
  entryDate: string;
  grams: number;
  /** Portion display fields; omit/null for a plain gram amount. */
  amount?: number | null;
  portionLabel?: string | null;
}

/** Changes the amount of an entry (grams are authoritative; amount/portion label are display only). */
export function useUpdateDiaryEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateDiaryEntryInput) => {
      const { error } = await supabase
        .from('diary_entries')
        .update({ grams: input.grams, amount: input.amount ?? null, portion_label: input.portionLabel ?? null })
        .eq('id', input.id);
      if (error) throw error;
    },
    onMutate: (input) =>
      patchRows(qc, input.entryDate, (rows) =>
        rows.map((r) =>
          r.id === input.id
            ? { ...r, grams: input.grams, amount: input.amount ?? null, portion_label: input.portionLabel ?? null }
            : r,
        ),
      ),
    onError: (_e, _i, ctx) => rollback(qc, ctx),
    onSettled: (_d, _e, input) => settle(qc, input.entryDate),
  });
}

/** Moves an entry to another meal group of the same day. */
export function useMoveDiaryEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; entryDate: string; mealGroupId: string }) => {
      const { error } = await supabase
        .from('diary_entries')
        .update({ meal_group_id: input.mealGroupId })
        .eq('id', input.id);
      if (error) throw error;
    },
    onMutate: (input) =>
      patchRows(qc, input.entryDate, (rows) =>
        rows.map((r) => (r.id === input.id ? { ...r, meal_group_id: input.mealGroupId } : r)),
      ),
    onError: (_e, _i, ctx) => rollback(qc, ctx),
    onSettled: (_d, _e, input) => settle(qc, input.entryDate),
  });
}

export function useDeleteDiaryEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; entryDate: string }) => {
      const { error } = await supabase.from('diary_entries').delete().eq('id', input.id);
      if (error) throw error;
    },
    onMutate: (input) => patchRows(qc, input.entryDate, (rows) => rows.filter((r) => r.id !== input.id)),
    onError: (_e, _i, ctx) => rollback(qc, ctx),
    onSettled: (_d, _e, input) => settle(qc, input.entryDate),
  });
}

export interface CopyDiaryEntriesInput {
  fromDate: string;
  toDate: string;
  /** Copy only this meal group of the source day. Omit to copy the whole day (groups are preserved). */
  fromMealGroupId?: string;
  /** Target group for a single-group copy (defaults to the same group id). */
  toMealGroupId?: string;
}

/** Copies a meal group (or a whole day) from another date as new entries with source='copy'. Returns the count. */
export function useCopyDiaryEntries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CopyDiaryEntriesInput): Promise<number> => {
      const { data: auth } = await supabase.auth.getSession();
      const userId = auth.session?.user.id;
      if (!userId) throw new Error('Not signed in');

      let query = supabase
        .from('diary_entries')
        .select('meal_group_id,food_id,grams,amount,portion_label,note,logged_at')
        .eq('entry_date', input.fromDate)
        .order('logged_at', { ascending: true });
      if (input.fromMealGroupId) query = query.eq('meal_group_id', input.fromMealGroupId);
      const { data, error } = await query;
      if (error) throw error;

      const source = (data ?? []) as {
        meal_group_id: string | null;
        food_id: string;
        grams: number;
        amount: number | null;
        portion_label: string | null;
        note: string | null;
      }[];
      if (source.length === 0) return 0;

      const targetGroup = input.toMealGroupId ?? input.fromMealGroupId ?? null;
      const rows = source.map((s) => ({
        user_id: userId,
        entry_date: input.toDate,
        meal_group_id: input.fromMealGroupId ? targetGroup : s.meal_group_id,
        food_id: s.food_id,
        grams: s.grams,
        amount: s.amount,
        portion_label: s.portion_label,
        note: s.note,
        source: 'copy' as const,
      }));
      const { error: insertError } = await supabase.from('diary_entries').insert(rows);
      if (insertError) throw insertError;
      return rows.length;
    },
    onSettled: (_d, _e, input) => settle(qc, input.toDate),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Recent days (dashboard): daily_totals cache
// ---------------------------------------------------------------------------------------------------------------

export interface RecentDay {
  date: string;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number;
  entryCount: number;
  /** At least one diary entry that day. */
  logged: boolean;
}

export interface DayAverages {
  /** Days with at least one entry inside the window; averages are over these days only. */
  loggedDays: number;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number;
  /** Share of macro energy (4/4/9 kcal per g), adds up to 100 (all 0 when nothing logged). */
  proteinPct: number;
  carbsPct: number;
  fatPct: number;
}

/** Average of the logged days among the last `lastN` days of `days` (oldest first). */
export function averageOfDays(days: readonly RecentDay[], lastN: number = days.length): DayAverages {
  const logged = days.slice(Math.max(0, days.length - lastN)).filter((d) => d.logged);
  const n = logged.length;
  const avg = (pick: (d: RecentDay) => number) => (n === 0 ? 0 : logged.reduce((s, d) => s + pick(d), 0) / n);
  const proteinG = avg((d) => d.proteinG);
  const carbsG = avg((d) => d.carbsG);
  const fatG = avg((d) => d.fatG);
  const pKcal = proteinG * 4;
  const cKcal = carbsG * 4;
  const fKcal = fatG * 9;
  const sum = pKcal + cKcal + fKcal;
  const pct = (k: number) => (sum > 0 ? (k / sum) * 100 : 0);
  return {
    loggedDays: n,
    kcal: avg((d) => d.kcal),
    proteinG,
    carbsG,
    fatG,
    fiberG: avg((d) => d.fiberG),
    proteinPct: pct(pKcal),
    carbsPct: pct(cKcal),
    fatPct: pct(fKcal),
  };
}

/**
 * Consecutive logged days ending today. If today has no entry yet the streak that ended yesterday is kept
 * (it only breaks once a whole day passes without an entry).
 */
export function currentStreak(days: readonly RecentDay[]): number {
  let i = days.length - 1;
  if (i >= 0 && !days[i]?.logged) i -= 1;
  let count = 0;
  while (i >= 0 && days[i]?.logged) {
    count += 1;
    i -= 1;
  }
  return count;
}

interface DailyTotalsRow {
  entry_date: string;
  kcal: number | string;
  protein_g: number | string;
  carbs_g: number | string;
  fat_g: number | string;
  fiber_g: number | string;
  entry_count: number;
}

/**
 * The last `n` days (oldest first, ending today, missing days filled with zeros) from the daily_totals cache,
 * plus the current streak and the average over the logged days.
 */
export function useRecentDays(n: number) {
  const end = todayISO();
  const start = addDays(end, -(n - 1));
  const q = useQuery({
    // Under today's day prefix so invalidateDay(today) refreshes it after a diary change.
    queryKey: [...dayKey(end, 'totals'), 'recent', n] as const,
    queryFn: async (): Promise<DailyTotalsRow[]> => {
      const { data, error } = await supabase
        .from('daily_totals')
        .select('entry_date,kcal,protein_g,carbs_g,fat_g,fiber_g,entry_count')
        .gte('entry_date', start)
        .lte('entry_date', end)
        .order('entry_date', { ascending: true });
      if (error) throw error;
      return (data ?? []) as DailyTotalsRow[];
    },
    staleTime: 0,
  });

  const days = useMemo<RecentDay[]>(() => {
    const byDate = new Map((q.data ?? []).map((r) => [r.entry_date, r] as const));
    return Array.from({ length: n }, (_, i) => {
      const date = addDays(start, i);
      const r = byDate.get(date);
      const count = r?.entry_count ?? 0;
      return {
        date,
        kcal: num(r?.kcal) ?? 0,
        proteinG: num(r?.protein_g) ?? 0,
        carbsG: num(r?.carbs_g) ?? 0,
        fatG: num(r?.fat_g) ?? 0,
        fiberG: num(r?.fiber_g) ?? 0,
        entryCount: count,
        logged: count > 0,
      };
    });
  }, [q.data, n, start]);

  const streak = useMemo(() => currentStreak(days), [days]);
  const averages = useMemo(() => averageOfDays(days), [days]);

  return {
    days,
    streak,
    averages,
    isLoading: q.isLoading,
    isError: q.isError,
    error: q.error,
    refetch: q.refetch,
  };
}
