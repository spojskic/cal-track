// Coach conversations (public.coach_threads / public.coach_messages) and the raw rows the coach summary is
// built from. Chat text lives in Supabase only; the OpenRouter key never does. RLS limits every query to the
// signed-in user, deleting a thread cascades to its messages, and a scheduled job purges messages older than
// the retention window for users whose profiles.coach_auto_delete is on.
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { lbToKg } from '@ration/core';

import {
  RECOVERY_BIOMETRIC_TYPES,
  SLEEP_BIOMETRIC_TYPES,
  type SummaryBiometricRow,
  type SummaryDailyTotal,
  type SummaryDeviceEnergyRow,
  type SummaryExerciseRow,
  type SummaryWaterRow,
  type SummaryWeightRow,
} from '@/ai/coach-summary';
import { detectRefusal, type RefusalCategory } from '@/ai/coach-history';
import { NEW_CHAT_TITLE, coachThreadTitle, sameTopic, topicFromJson, topicThreadTitle, type CoachTopic } from '@/ai/coach-topic';
import { requireUserId } from '@/lib/auth-user';
import { supabase } from '@/lib/supabase';
import { addDays } from '@/state/selected-date';

import { useUserId } from './profile';

// ---------------------------------------------------------------------------------------------------------------
// Types + keys
// ---------------------------------------------------------------------------------------------------------------

export type CoachRole = 'user' | 'assistant';
export type { RefusalCategory };
export { NEW_CHAT_TITLE, coachThreadTitle, detectRefusal };

export interface CoachThread {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  /** What the conversation is about (a workout ...). null for an ordinary chat, and when the column does not exist yet. */
  topic: CoachTopic | null;
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
/** Messages of one thread that are loaded: the NEWEST ones (a very long thread must never lose its latest turns). */
const MESSAGE_LIMIT = 500;

interface ThreadRow {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  topic?: unknown;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: CoachRole;
  content: string;
  created_at: string;
}

/** Without `topic`: lists and the plain reads must keep working on a database that has not got migration …106 yet. */
const THREAD_COLUMNS = 'id,title,created_at,updated_at';
const THREAD_COLUMNS_WITH_TOPIC = `${THREAD_COLUMNS},topic`;
const MESSAGE_COLUMNS = 'id,thread_id,role,content,created_at';

const toThread = (r: ThreadRow): CoachThread => ({
  id: r.id,
  title: r.title,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  topic: topicFromJson(r.topic),
});

/**
 * True when Postgres / PostgREST says a column does not exist (42703 on a read, PGRST204 on a write): the database has
 * not got the migration that added it yet. The coach then works without that column instead of failing.
 */
export function isMissingColumnError(error: unknown, column?: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : '';
  const named = column ? message.includes(column) : true;
  if ((code === '42703' || code === 'PGRST204') && named) return true;
  return /column .* (does not exist|schema cache)|could not find the .* column/i.test(message) && named;
}

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

// (Pure helpers - coachThreadTitle, detectRefusal, topics - live in ai/coach-topic.ts and ai/coach-history.ts.)

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

/** One thread (with its topic), or null when it does not exist (deleted, purged, or somebody else's). */
export async function fetchCoachThread(threadId: string): Promise<CoachThread | null> {
  const withTopic = await supabase.from('coach_threads').select(THREAD_COLUMNS_WITH_TOPIC).eq('id', threadId).maybeSingle();
  if (withTopic.error && isMissingColumnError(withTopic.error, 'topic')) {
    const plain = await supabase.from('coach_threads').select(THREAD_COLUMNS).eq('id', threadId).maybeSingle();
    if (plain.error) throw plain.error;
    return plain.data ? toThread(plain.data as ThreadRow) : null;
  }
  if (withTopic.error) throw withTopic.error;
  return withTopic.data ? toThread(withTopic.data as unknown as ThreadRow) : null;
}

/** One thread, or null when it does not exist (deleted, purged, or somebody else's). */
export function useCoachThread(threadId: string | null) {
  return useQuery({
    queryKey: coachKeys.thread(threadId ?? 'none'),
    enabled: threadId !== null,
    gcTime: COACH_GC_MS,
    queryFn: (): Promise<CoachThread | null> => fetchCoachThread(threadId as string),
  });
}

/**
 * Messages of a thread, oldest first, read straight from the database. A very long thread returns its NEWEST
 * `MESSAGE_LIMIT` messages (ascending order with a limit would keep the oldest ones and silently lose the latest turns).
 */
export async function fetchCoachMessages(threadId: string): Promise<CoachMessage[]> {
  const { data, error } = await supabase
    .from('coach_messages')
    .select(MESSAGE_COLUMNS)
    .eq('thread_id', threadId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(MESSAGE_LIMIT);
  if (error) throw error;
  return ((data ?? []) as MessageRow[]).map(toMessage).reverse();
}

/** Messages of a thread, oldest first. */
export function useCoachMessages(threadId: string | null) {
  return useQuery({
    queryKey: coachKeys.messages(threadId ?? 'none'),
    enabled: threadId !== null,
    gcTime: COACH_GC_MS,
    queryFn: (): Promise<CoachMessage[]> => fetchCoachMessages(threadId as string),
  });
}

/**
 * The newest thread whose topic is `topic`, or null (also when the database has no `topic` column yet). Opening
 * "ask the coach" on the same workout again resumes that conversation instead of starting a new one.
 */
export async function findCoachThreadForTopic(topic: CoachTopic): Promise<CoachThread | null> {
  const { data, error } = await supabase
    .from('coach_threads')
    .select(THREAD_COLUMNS_WITH_TOPIC)
    .eq('topic->>kind', topic.kind)
    .eq('topic->>id', topic.id)
    .order('updated_at', { ascending: false })
    .limit(1);
  if (error) {
    if (isMissingColumnError(error, 'topic')) return null;
    throw error;
  }
  const row = ((data ?? []) as unknown as ThreadRow[])[0];
  if (!row) return null;
  const thread = toThread(row);
  return sameTopic(thread.topic, topic) ? thread : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Writes (plain functions so the chat state machine can sequence them; hooks below wrap the UI actions)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Creates a thread titled after its first message ("Workout: ..." when it has a topic). If the database does not have
 * the `topic` column yet the thread is created without it (returned with `topic: null`); the caller keeps the topic for
 * the running session.
 */
export async function createCoachThread(firstMessage: string, topic: CoachTopic | null = null): Promise<CoachThread> {
  const userId = await requireUserId();
  const title = topicThreadTitle(topic, firstMessage);
  if (topic) {
    const withTopic = await supabase
      .from('coach_threads')
      .insert({ user_id: userId, title, topic })
      .select(THREAD_COLUMNS_WITH_TOPIC)
      .single();
    if (!withTopic.error) return toThread(withTopic.data as unknown as ThreadRow);
    if (!isMissingColumnError(withTopic.error, 'topic')) throw withTopic.error;
  }
  const { data, error } = await supabase.from('coach_threads').insert({ user_id: userId, title }).select(THREAD_COLUMNS).single();
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
  water: SummaryWaterRow[] | null;
  /** Newest day that has any food logged (any age), or null when unknown / never. */
  lastLoggedDate: string | null;
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

/** Days of history per series. Findings need 28 days of workouts / recovery and 6 weeks of weight; food is 14. */
export const GROUNDING_DAYS = { intake: 14, activity: 28, weight: 42, water: 14 } as const;

const EXERCISE_BASE = 'id,entry_date,name,minutes,kcal,source,started_at,ended_at';
/** The Workouts feature stores heart rate in exercise_entries.details (jsonb, migration …105); PostgREST can alias two keys of it. */
const EXERCISE_WITH_HR = `${EXERCISE_BASE},avg_hr:details->avgHr,max_hr:details->maxHr`;

/** Set once the database answered "no such column": no point asking again until the app restarts (the migration was not pushed). */
let heartRateColumnsMissing = false;

/** Workout rows of the last 28 days. Heart rate is added when the `details` column exists; otherwise the plain rows. */
async function fetchExerciseRows(from: string, today: string): Promise<{ data: unknown; error: unknown }> {
  const query = (columns: string) =>
    supabase.from('exercise_entries').select(columns).gte('entry_date', from).lte('entry_date', today).order('entry_date', { ascending: true });
  if (!heartRateColumnsMissing) {
    const rich = await query(EXERCISE_WITH_HR);
    if (!rich.error) return rich;
    if (isMissingColumnError(rich.error, 'details')) heartRateColumnsMissing = true;
  }
  return query(EXERCISE_BASE);
}

/**
 * Reads the last weeks straight from Supabase so the coach never sees stale cached numbers. Each series is
 * loaded independently: one failing query yields `null` for that series only and the coach simply gets less
 * data (it is told what is missing) instead of the whole turn failing.
 *
 * Privacy: numbers only. Diary notes, names, e-mail and the OpenRouter key are never read here.
 */
export async function fetchCoachGrounding(today: string): Promise<CoachGroundingRows> {
  const intakeFrom = addDays(today, -GROUNDING_DAYS.intake);
  const activityFrom = addDays(today, -(GROUNDING_DAYS.activity - 1));
  const weightFrom = addDays(today, -GROUNDING_DAYS.weight);
  const waterFrom = addDays(today, -(GROUNDING_DAYS.water - 1));

  const [totals, weight, exercise, energy, biometrics, water, newest] = await Promise.allSettled([
    supabase
      .from('daily_totals')
      .select('entry_date,kcal,protein_g,carbs_g,fat_g,fiber_g,entry_count,nutrients')
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
    fetchExerciseRows(activityFrom, today),
    supabase
      .from('daily_energy')
      .select('local_date,source,active_kcal,steps')
      .gte('local_date', activityFrom)
      .lte('local_date', today),
    supabase
      .from('biometrics')
      .select('entry_date,type,value,unit,source')
      .in('type', [...SLEEP_BIOMETRIC_TYPES, ...RECOVERY_BIOMETRIC_TYPES])
      .gte('entry_date', activityFrom)
      .lte('entry_date', today),
    supabase.from('water_entries').select('entry_date,ml').gte('entry_date', waterFrom).lte('entry_date', today),
    supabase.from('daily_totals').select('entry_date').lte('entry_date', today).gt('entry_count', 0).order('entry_date', { ascending: false }).limit(1),
  ]);

  type Rows = Record<string, unknown>[];
  const rowsOf = (r: PromiseSettledResult<{ data: unknown; error: unknown }>): Rows | null =>
    r.status === 'fulfilled' && !r.value.error && Array.isArray(r.value.data) ? (r.value.data as Rows) : null;

  const totalRows = rowsOf(totals);
  const weightRows = rowsOf(weight);
  const exerciseRows = rowsOf(exercise);
  const energyRows = rowsOf(energy);
  const biometricRows = rowsOf(biometrics);
  const waterRows = rowsOf(water);
  const newestRows = rowsOf(newest);

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

  const nutrientMap = (v: unknown): Record<string, number> | null => {
    if (!v || typeof v !== 'object') return null;
    const out: Record<string, number> = {};
    for (const [code, amount] of Object.entries(v as Record<string, unknown>)) {
      const n = numOrNull(amount);
      if (n !== null) out[code] = n;
    }
    return Object.keys(out).length ? out : null;
  };

  let waterSeries: SummaryWaterRow[] | null = null;
  if (waterRows) {
    const perDate = new Map<string, number>();
    for (const r of waterRows) perDate.set(String(r.entry_date), (perDate.get(String(r.entry_date)) ?? 0) + num(r.ml));
    waterSeries = [...perDate.entries()].map(([date, ml]) => ({ date, ml }));
  }

  const last = newestRows?.[0]?.entry_date;

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
          nutrients: nutrientMap(r.nutrients),
        }))
      : null,
    weight: weightSeries,
    exercise: exerciseRows
      ? exerciseRows.map((r) => ({
          id: typeof r.id === 'string' ? r.id : undefined,
          date: String(r.entry_date),
          name: String(r.name ?? 'Workout'),
          minutes: numOrNull(r.minutes),
          kcal: num(r.kcal),
          source: typeof r.source === 'string' ? r.source : null,
          startedAt: typeof r.started_at === 'string' ? r.started_at : null,
          endedAt: typeof r.ended_at === 'string' ? r.ended_at : null,
          avgHr: numOrNull(r.avg_hr),
          maxHr: numOrNull(r.max_hr),
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
          source: typeof r.source === 'string' ? r.source : null,
        }))
      : null,
    water: waterSeries,
    lastLoggedDate: typeof last === 'string' ? last : null,
  };
}
