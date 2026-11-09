// Coach conversations (public.coach_threads / public.coach_messages) and the raw rows the coach summary is
// built from. Chat text lives in Supabase only; the OpenRouter key never does. RLS limits every query to the
// signed-in user, deleting a thread cascades to its messages, and a scheduled job purges messages older than
// the retention window for users whose profiles.coach_auto_delete is on.
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { DEFAULT_REFUSALS, type GuardCategory } from '@cal/ai';
import { lbToKg } from '@cal/core';

import {
  SLEEP_BIOMETRIC_TYPES,
  type SummaryBiometricRow,
  type SummaryDailyTotal,
  type SummaryDeviceEnergyRow,
  type SummaryExerciseRow,
  type SummaryWeightRow,
} from '@/ai/coach-summary';
import { supabase } from '@/lib/supabase';
import { addDays } from '@/state/selected-date';

import { requireUserId, useUserId } from './profile';

// ---------------------------------------------------------------------------------------------------------------
// Types + keys
// ---------------------------------------------------------------------------------------------------------------

export type CoachRole = 'user' | 'assistant';
export type RefusalCategory = Exclude<GuardCategory, 'on_topic'>;

export interface CoachThread {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A thread plus a preview of its newest message (for the history list). */
export interface CoachThreadItem extends CoachThread {
  lastMessage: string | null;
  lastRole: CoachRole | null;
  /** Newest message time, falling back to the thread's own update time. */
  lastActivityAt: string;
}

export interface CoachMessage {
  id: string;
  threadId: string;
  role: CoachRole;
  content: string;
  createdAt: string;
}

/**
 * Every coach query lives under ['coach', ...]: the Settings "delete all coach chats" action invalidates that
 * prefix (see ai/use-coach-retention.ts), and so does {@link useDeleteAllCoachChats}.
 */
export const coachKeys = {
  all: ['coach'] as const,
  threads: (userId: string | undefined) => ['coach', 'threads', userId ?? 'anon'] as const,
  thread: (id: string) => ['coach', 'thread', id] as const,
  messages: (threadId: string) => ['coach', 'messages', threadId] as const,
};

/**
 * Chat text is sensitive and already lives server side: let the react-query cache forget it soon after the
 * screen closes, so little of it lingers in the on-device persisted cache.
 */
const COACH_GC_MS = 2 * 60 * 1000;

const MAX_PREVIEW_CHARS = 240;
const THREAD_LIMIT = 100;
const MESSAGE_LIMIT = 500;

interface ThreadRow {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: CoachRole;
  content: string;
  created_at: string;
}

const THREAD_COLUMNS = 'id,title,created_at,updated_at';
const MESSAGE_COLUMNS = 'id,thread_id,role,content,created_at';

const toThread = (r: ThreadRow): CoachThread => ({
  id: r.id,
  title: r.title,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toMessage = (r: MessageRow): CoachMessage => ({
  id: r.id,
  threadId: r.thread_id,
  role: r.role,
  content: r.content,
  createdAt: r.created_at,
});

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------

export const NEW_CHAT_TITLE = 'New chat';
const TITLE_MAX = 40;

/** Thread title from the first user message: one line, markdown marks removed, about 40 characters. */
export function coachThreadTitle(firstMessage: string): string {
  const flat = firstMessage
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return NEW_CHAT_TITLE;
  if (flat.length <= TITLE_MAX) return flat;
  const cut = flat.slice(0, TITLE_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '')}\u2026`;
}

/**
 * The refusal category when `content` is one of the fixed refusal texts of @cal/ai, else null.
 * Refusals are stored as ordinary assistant messages (the table has no `kind` column); because the texts are
 * fixed, an exact match identifies them after a reload so they keep rendering as a refusal card.
 */
export function detectRefusal(content: string): RefusalCategory | null {
  const text = content.trim();
  for (const category of Object.keys(DEFAULT_REFUSALS) as RefusalCategory[]) {
    if (DEFAULT_REFUSALS[category] === text) return category;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------------------------

/** The user's threads, newest activity first, with a preview of the last message. */
export function useCoachThreads(enabled = true) {
  const userId = useUserId();
  return useQuery({
    queryKey: coachKeys.threads(userId),
    enabled: enabled && Boolean(userId),
    gcTime: COACH_GC_MS,
    queryFn: async (): Promise<CoachThreadItem[]> => {
      type Row = ThreadRow & { coach_messages?: { role: CoachRole; content: string; created_at: string }[] | null };
      // One round trip: each thread with only its newest message (the preview). If the embedded select is ever
      // rejected, fall back to the plain thread list instead of failing the whole history.
      const embedded = await supabase
        .from('coach_threads')
        .select(`${THREAD_COLUMNS},coach_messages(role,content,created_at)`)
        .order('updated_at', { ascending: false })
        .limit(THREAD_LIMIT)
        .order('created_at', { ascending: false, referencedTable: 'coach_messages' })
        .limit(1, { referencedTable: 'coach_messages' });
      let rows = (embedded.data ?? []) as unknown as Row[];
      if (embedded.error) {
        const plain = await supabase
          .from('coach_threads')
          .select(THREAD_COLUMNS)
          .order('updated_at', { ascending: false })
          .limit(THREAD_LIMIT);
        if (plain.error) throw plain.error;
        rows = (plain.data ?? []) as unknown as Row[];
      }
      return rows
        .map((r): CoachThreadItem => {
          const last = r.coach_messages?.[0];
          return {
            ...toThread(r),
            lastMessage: last ? last.content.slice(0, MAX_PREVIEW_CHARS) : null,
            lastRole: last?.role ?? null,
            lastActivityAt: last && last.created_at > r.updated_at ? last.created_at : r.updated_at,
          };
        })
        .sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0));
    },
  });
}

/** One thread, or null when it does not exist (deleted, purged, or somebody else's). */
export function useCoachThread(threadId: string | null) {
  return useQuery({
    queryKey: coachKeys.thread(threadId ?? 'none'),
    enabled: threadId !== null,
    gcTime: COACH_GC_MS,
    queryFn: async (): Promise<CoachThread | null> => {
      const { data, error } = await supabase
        .from('coach_threads')
        .select(THREAD_COLUMNS)
        .eq('id', threadId as string)
        .maybeSingle();
      if (error) throw error;
      return data ? toThread(data as ThreadRow) : null;
    },
  });
}

/** Messages of a thread, oldest first. */
export function useCoachMessages(threadId: string | null) {
  return useQuery({
    queryKey: coachKeys.messages(threadId ?? 'none'),
    enabled: threadId !== null,
    gcTime: COACH_GC_MS,
    queryFn: async (): Promise<CoachMessage[]> => {
      const { data, error } = await supabase
        .from('coach_messages')
        .select(MESSAGE_COLUMNS)
        .eq('thread_id', threadId as string)
        .order('created_at', { ascending: true })
        .limit(MESSAGE_LIMIT);
      if (error) throw error;
      return ((data ?? []) as MessageRow[]).map(toMessage);
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Writes (plain functions so the chat state machine can sequence them; hooks below wrap the UI actions)
// ---------------------------------------------------------------------------------------------------------------

/** Creates a thread titled after its first message. */
export async function createCoachThread(firstMessage: string): Promise<CoachThread> {
  const userId = await requireUserId();
  const { data, error } = await supabase
    .from('coach_threads')
    .insert({ user_id: userId, title: coachThreadTitle(firstMessage) })
    .select(THREAD_COLUMNS)
    .single();
  if (error) throw error;
  return toThread(data as ThreadRow);
}

/** Appends one message. `touch` also bumps the thread's updated_at (a DB trigger sets it on any update). */
export async function appendCoachMessage(
  threadId: string,
  role: CoachRole,
  content: string,
  opts: { touch?: boolean } = {},
): Promise<CoachMessage> {
  const userId = await requireUserId();
  const { data, error } = await supabase
    .from('coach_messages')
    .insert({ thread_id: threadId, user_id: userId, role, content })
    .select(MESSAGE_COLUMNS)
    .single();
  if (error) throw error;
  if (opts.touch) {
    // Best effort: the history order must never make a saved message look like a failure.
    await supabase.from('coach_threads').update({ updated_at: new Date().toISOString() }).eq('id', threadId);
  }
  return toMessage(data as MessageRow);
}

/** Cache helper: appends a message to a thread's cached list (creating it) without a refetch. */
export async function cacheCoachMessage(qc: QueryClient, message: CoachMessage): Promise<void> {
  const key = coachKeys.messages(message.threadId);
  await qc.cancelQueries({ queryKey: key });
  qc.setQueryData<CoachMessage[]>(key, (old) =>
    old?.some((m) => m.id === message.id) ? old : [...(old ?? []), message],
  );
}

export function invalidateCoachThreads(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: ['coach', 'threads'] });
}

export function useRenameCoachThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; title: string }): Promise<void> => {
      const title = input.title.replace(/\s+/g, ' ').trim().slice(0, 80);
      const { error } = await supabase
        .from('coach_threads')
        .update({ title: title || NEW_CHAT_TITLE })
        .eq('id', input.id);
      if (error) throw error;
    },
    onSettled: async (_d, _e, input) => {
      await Promise.all([invalidateCoachThreads(qc), qc.invalidateQueries({ queryKey: coachKeys.thread(input.id) })]);
    },
  });
}

/** Deletes a thread; its messages go with it (FK cascade). The list updates immediately. */
export function useDeleteCoachThread() {
  const qc = useQueryClient();
  const userId = useUserId();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const { error } = await supabase.from('coach_threads').delete().eq('id', id);
      if (error) throw error;
    },
    onMutate: async (id) => {
      const key = coachKeys.threads(userId);
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<CoachThreadItem[]>(key);
      if (previous) qc.setQueryData<CoachThreadItem[]>(key, previous.filter((t) => t.id !== id));
      return { previous, key };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(ctx.key, ctx.previous);
    },
    // Invalidate (not remove): a screen that still has this thread open then refetches and shows "no longer available".
    onSettled: async (_d, _e, id) => {
      await Promise.all([
        invalidateCoachThreads(qc),
        qc.invalidateQueries({ queryKey: coachKeys.thread(id) }),
        qc.invalidateQueries({ queryKey: coachKeys.messages(id) }),
      ]);
    },
  });
}

/** Deletes every coach thread of the user through the `delete_all_my_coach_data` RPC. Returns the thread count. */
export function useDeleteAllCoachChats() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<number> => {
      const { data, error } = await supabase.rpc('delete_all_my_coach_data');
      if (error) throw error;
      return Number(data ?? 0);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: coachKeys.all }),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Grounding rows for the coach summary (fetched fresh for every turn, see ai/use-coach-summary.ts)
// ---------------------------------------------------------------------------------------------------------------

export interface CoachGroundingRows {
  dailyTotals: SummaryDailyTotal[] | null;
  weight: SummaryWeightRow[] | null;
  exercise: SummaryExerciseRow[] | null;
  deviceEnergy: SummaryDeviceEnergyRow[] | null;
  biometrics: SummaryBiometricRow[] | null;
}

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/**
 * Reads the last ~30 days straight from Supabase so the coach never sees stale cached numbers. Each series is
 * loaded independently: one failing query yields `null` for that series only and the coach simply gets less
 * data (it is told what is missing) instead of the whole turn failing.
 */
export async function fetchCoachGrounding(today: string): Promise<CoachGroundingRows> {
  const intakeFrom = addDays(today, -14);
  const activityFrom = addDays(today, -13);
  const weightFrom = addDays(today, -30);

  const [totals, weight, exercise, energy, biometrics] = await Promise.allSettled([
    supabase
      .from('daily_totals')
      .select('entry_date,kcal,protein_g,carbs_g,fat_g,fiber_g,entry_count')
      .gte('entry_date', intakeFrom)
      .lte('entry_date', today)
      .order('entry_date', { ascending: true }),
    supabase
      .from('biometrics')
      .select('entry_date,value,unit,recorded_at')
      .eq('type', 'weight')
      .gte('entry_date', weightFrom)
      .lte('entry_date', today)
      .order('entry_date', { ascending: true })
      .order('recorded_at', { ascending: true }),
    supabase
      .from('exercise_entries')
      .select('entry_date,name,minutes,kcal')
      .gte('entry_date', activityFrom)
      .lte('entry_date', today)
      .order('entry_date', { ascending: true }),
    supabase
      .from('daily_energy')
      .select('local_date,source,active_kcal,steps')
      .gte('local_date', activityFrom)
      .lte('local_date', today),
    supabase
      .from('biometrics')
      .select('entry_date,type,value,unit')
      .in('type', [...SLEEP_BIOMETRIC_TYPES])
      .gte('entry_date', activityFrom)
      .lte('entry_date', today),
  ]);

  type Rows = Record<string, unknown>[];
  const rowsOf = (r: PromiseSettledResult<{ data: unknown; error: unknown }>): Rows | null =>
    r.status === 'fulfilled' && !r.value.error && Array.isArray(r.value.data) ? (r.value.data as Rows) : null;

  const totalRows = rowsOf(totals);
  const weightRows = rowsOf(weight);
  const exerciseRows = rowsOf(exercise);
  const energyRows = rowsOf(energy);
  const biometricRows = rowsOf(biometrics);

  let weightSeries: SummaryWeightRow[] | null = null;
  if (weightRows) {
    // one point per local date: the last reading of the day wins (rows are ordered by recording time)
    const perDate = new Map<string, number>();
    for (const r of weightRows) {
      const value = num(r.value);
      const unit = typeof r.unit === 'string' ? r.unit.toLowerCase() : '';
      if (value > 0) perDate.set(String(r.entry_date), unit.startsWith('lb') ? lbToKg(value) : value);
    }
    weightSeries = [...perDate.entries()].map(([date, kg]) => ({ date, kg }));
  }

  return {
    dailyTotals: totalRows
      ? totalRows.map((r) => ({
          date: String(r.entry_date),
          kcal: num(r.kcal),
          proteinG: num(r.protein_g),
          carbsG: num(r.carbs_g),
          fatG: num(r.fat_g),
          fiberG: num(r.fiber_g),
          entryCount: num(r.entry_count),
        }))
      : null,
    weight: weightSeries,
    exercise: exerciseRows
      ? exerciseRows.map((r) => ({
          date: String(r.entry_date),
          name: String(r.name ?? 'Workout'),
          minutes: numOrNull(r.minutes),
          kcal: num(r.kcal),
        }))
      : null,
    deviceEnergy: energyRows
      ? energyRows.map((r) => ({
          date: String(r.local_date),
          source: String(r.source ?? ''),
          activeKcal: numOrNull(r.active_kcal),
          steps: numOrNull(r.steps),
        }))
      : null,
    biometrics: biometricRows
      ? biometricRows.map((r) => ({
          date: String(r.entry_date),
          type: String(r.type),
          value: num(r.value),
          unit: typeof r.unit === 'string' ? r.unit : null,
        }))
      : null,
  };
}
