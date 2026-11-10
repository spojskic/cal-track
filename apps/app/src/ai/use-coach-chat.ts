/**
 * State machine around `runCoachTurn` for the coach chat screen.
 *
 * One turn, in order:
 *   1. persist  - create the thread if needed (title from the first message, with its topic when the chat is about a
 *                 workout) and store the USER message, so a failed turn still keeps what the user wrote (shown with a
 *                 "failed - retry" affordance)
 *   2. history  - read the whole conversation BEFORE the new message from the database (not from the query cache,
 *                 which only drives the screen and can be stale or incomplete) and hand all of it to the coach
 *   3. ground   - build a FRESH CoachSummary from Supabase (findings, intake, weight, workouts, sleep, goals) plus the
 *                 description of the workout the chat is about
 *   4. guard    - `runCoachTurn` classifies the new message; off-topic / red-flag / eating-disorder messages get a
 *                 fixed refusal and the coach model is never called
 *   5. answer   - the coach reply streams in (`streamText`); the output audit may replace it (`result.replaced`)
 *   6. persist  - the assistant message (or refusal) is stored; only then is the turn complete
 * A failed or stopped turn saves nothing for the assistant. Partial streamed text is discarded on stop: it never
 * went through the output audit, so it is not kept.
 *
 * The OpenRouter key never leaves the device and never appears in state or logs: errors are passed through
 * `presentAiError`, which redacts it.
 */

import NetInfo from '@react-native-community/netinfo';
import {
  AbortError,
  isAbortError,
  isOpenRouterError,
  presentAiError,
  runCoachTurn,
  type CoachSummary,
  type GuardCategory,
} from '@cal/ai';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';

import {
  appendCoachMessage,
  cacheCoachMessage,
  coachKeys,
  createCoachThread,
  detectRefusal,
  fetchCoachMessages,
  findCoachThreadForTopic,
  invalidateCoachThreads,
  useCoachMessages,
  useCoachThread,
  type CoachMessage,
  type CoachRole,
  type CoachThread,
} from '@/data/coach';

import { useAiStore } from './ai-store';
import { loadTurnHistory } from './coach-history';
import { topicPrefill, type CoachTopic } from './coach-topic';
import { useAiClient } from './use-ai-client';
import { useCoachSummary } from './use-coach-summary';

export { toCoachHistory } from './coach-history';

// ---------------------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------------------

export type CoachPhase = 'idle' | 'preparing' | 'streaming' | 'finishing';

export type CoachErrorKind =
  | 'credits' // OpenRouter credits are used up
  | 'auth' // key rejected: reconnect in Settings
  | 'rate_limit' // too many requests, retried automatically
  | 'offline' // no connection
  | 'network' // OpenRouter unreachable / timed out
  | 'model' // model-specific failure: try another model
  | 'save' // Supabase write failed
  | 'other';

export interface CoachChatError {
  kind: CoachErrorKind;
  message: string;
  hint?: string;
  retryable: boolean;
  /** Epoch ms of the automatic retry (rate limits only). */
  autoRetryAt?: number;
}

/** A message as the screen shows it. */
export interface CoachChatMessage {
  id: string;
  role: CoachRole;
  content: string;
  createdAt: string;
  /** Not (yet) stored in Supabase. */
  local?: boolean;
  /** Set on assistant messages that are one of the fixed refusals. */
  refusal?: Exclude<GuardCategory, 'on_topic'> | null;
}

export const MAX_MESSAGE_CHARS = 2000;
const MAX_AUTO_RETRIES = 2;

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers (exported for reuse; no React)
// ---------------------------------------------------------------------------------------------------------------

function toChatMessage(m: CoachMessage): CoachChatMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    refusal: m.role === 'assistant' ? detectRefusal(m.content) : null,
  };
}

const SAVE_ERROR: CoachChatError = {
  kind: 'save',
  message: 'Could not save to your chat history. Check your connection and try again.',
  retryable: true,
};

const OFFLINE_ERROR: CoachChatError = {
  kind: 'offline',
  message: 'You are offline. Connect to the internet to talk to your coach.',
  retryable: false,
};

/** Turns any AI-layer failure into banner content. `retryAttempt` scales the automatic rate-limit retry. */
export function mapCoachError(e: unknown, secrets: (string | null)[], retryAttempt: number): CoachChatError {
  const p = presentAiError(e, secrets);
  switch (p.kind) {
    case 'credits':
      return { kind: 'credits', message: p.message, retryable: false };
    case 'auth':
      return { kind: 'auth', message: p.message, retryable: false };
    case 'rate_limit': {
      const retryAfter = isOpenRouterError(e) ? (e.retryAfterMs ?? 0) : 0;
      const delay = Math.min(60_000, Math.max(retryAfter, 10_000 * 2 ** retryAttempt));
      return {
        kind: 'rate_limit',
        message: p.message,
        retryable: true,
        ...(retryAttempt < MAX_AUTO_RETRIES ? { autoRetryAt: Date.now() + delay } : {}),
      };
    }
    case 'network':
    case 'timeout':
      return { kind: 'network', message: p.message, retryable: true };
    default:
      if (p.tryAnotherModel) return { kind: 'model', message: p.message, hint: p.hint, retryable: p.retryable };
      return { kind: 'other', message: p.message, hint: p.hint, retryable: p.retryable };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------------------------------------------

/**
 * True unless the device reports no connection. Web uses the browser's online/offline events; native uses
 * NetInfo's `isConnected` (reachability probing is deliberately ignored: it can be wrong behind proxies).
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined') return undefined;
      const update = () => setOnline(typeof navigator === 'undefined' || navigator.onLine !== false);
      update();
      window.addEventListener('online', update);
      window.addEventListener('offline', update);
      return () => {
        window.removeEventListener('online', update);
        window.removeEventListener('offline', update);
      };
    }
    return NetInfo.addEventListener((state) => setOnline(state.isConnected !== false));
  }, []);
  return online;
}

// ---------------------------------------------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------------------------------------------

interface Job {
  text: string;
  /** Id of the already stored user message (retry). Omitted for a brand new message. */
  persistedId?: string;
}

interface Run {
  controller: AbortController;
  epoch: number;
}

const NO_MESSAGES: CoachMessage[] = [];

export interface UseCoachChatOptions {
  /** Open this stored thread (route `/coach/[threadId]`). */
  initialThreadId?: string | null;
  /**
   * What a NEW conversation is about (route `/coach?topicKind=workout&topicId=...`). If a thread for the same topic
   * exists it is resumed, otherwise the first message creates one with this topic. Pass a stable object.
   */
  topic?: CoachTopic | null;
}

export function useCoachChat({ initialThreadId = null, topic: topicProp = null }: UseCoachChatOptions = {}) {
  const qc = useQueryClient();
  const ai = useAiClient();
  const buildSummary = useCoachSummary();
  const online = useOnline();

  const [threadId, setThreadId] = useState<string | null>(initialThreadId);
  // The topic of a blank chat that was opened "about" something. A stored thread brings its own topic (below).
  const [activeTopic, setActiveTopic] = useState<CoachTopic | null>(initialThreadId ? null : topicProp);
  // While the topic's earlier thread is being looked up, sending is held back so a duplicate thread is never created.
  const [resolving, setResolving] = useState<boolean>(Boolean(topicProp && !initialThreadId));
  const [phase, setPhase] = useState<CoachPhase>('idle');
  const [streamText, setStreamText] = useState('');
  const [savedAssistantId, setSavedAssistantId] = useState<string | null>(null);
  const [localUser, setLocalUser] = useState<CoachChatMessage | null>(null);
  const [unsaved, setUnsaved] = useState<{ message: CoachChatMessage; threadId: string } | null>(null);
  const [error, setError] = useState<CoachChatError | null>(null);
  const [stopped, setStopped] = useState(false);

  const messagesQ = useCoachMessages(threadId);
  const threadQ = useCoachThread(threadId);
  const topic: CoachTopic | null = threadQ.data?.topic ?? activeTopic;

  // Refs let the long-running async turn read the latest values without re-creating callbacks.
  const threadIdRef = useRef(threadId);
  const topicRef = useRef<CoachTopic | null>(topic);
  const navigatedRef = useRef(false);
  const runRef = useRef<Run | null>(null);
  const epochRef = useRef(0);
  const mountedRef = useRef(true);
  const autoRetriesRef = useRef(0);
  // "Latest value" refs for the long-running turn and the stable callbacks. They are synced in an effect
  // (below), never during render.
  const aiRef = useRef(ai);
  const buildSummaryRef = useRef(buildSummary);
  const onlineRef = useRef(online);
  const unsavedRef = useRef(unsaved);
  const canSendRef = useRef(false);
  const messagesRef = useRef<CoachChatMessage[]>([]);
  const retryRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      runRef.current?.controller.abort();
    };
  }, []);

  // Opening the coach "about" something resumes the conversation that already has this topic.
  useEffect(() => {
    if (!topicProp || initialThreadId) return undefined;
    let cancelled = false;
    findCoachThreadForTopic(topicProp)
      .then((found) => {
        if (cancelled || !found || navigatedRef.current || threadIdRef.current !== null) return;
        qc.setQueryData(coachKeys.thread(found.id), found);
        threadIdRef.current = found.id;
        setThreadId(found.id);
      })
      .catch(() => undefined) // a failed lookup only means "start a new thread"
      .finally(() => {
        if (!cancelled) setResolving(false);
      });
    return () => {
      cancelled = true;
    };
  }, [topicProp, initialThreadId, qc]);

  // ---- display model -------------------------------------------------------------------------------------

  const persisted = messagesQ.data ?? NO_MESSAGES;
  const messages = useMemo<CoachChatMessage[]>(() => {
    const list = persisted.map(toChatMessage);
    if (localUser && !persisted.some((m) => m.id === localUser.id)) list.push(localUser);
    if (unsaved && unsaved.threadId === threadId) list.push(unsaved.message);
    return list;
  }, [persisted, localUser, unsaved, threadId]);

  /** The streamed / finishing reply, hidden as soon as the stored copy shows up in the message list. */
  const pendingReply =
    streamText && !(savedAssistantId && persisted.some((m) => m.id === savedAssistantId)) ? streamText : '';

  // ---- one turn ----------------------------------------------------------------------------------------------

  const runTurn = useCallback(
    async (job: Job): Promise<void> => {
      if (runRef.current) return;
      const handle = aiRef.current;
      if (!handle) {
        setError({
          kind: 'auth',
          message: 'Connect OpenRouter in Settings > AI to use the coach.',
          retryable: false,
        });
        return;
      }

      const controller = new AbortController();
      const run: Run = { controller, epoch: epochRef.current };
      runRef.current = run;
      const live = () => mountedRef.current && epochRef.current === run.epoch;
      let streamTimer: ReturnType<typeof setTimeout> | null = null;

      setError(null);
      setStopped(false);
      setStreamText('');
      setSavedAssistantId(null);
      setPhase('preparing');

      let tid = threadIdRef.current;
      let userMessageId = job.persistedId;
      let reply: string | null = null;

      try {
        // 1. persist the user message (creating the thread on the first message)
        try {
          if (userMessageId === undefined) {
            const optimistic: CoachChatMessage = {
              id: `local-${Date.now()}`,
              role: 'user',
              content: job.text,
              createdAt: new Date().toISOString(),
              local: true,
            };
            if (live()) setLocalUser(optimistic);
            if (!tid) {
              const created: CoachThread = await createCoachThread(job.text, topicRef.current);
              // A database without the topic column stores no topic; this session still knows it.
              const thread: CoachThread = created.topic || !topicRef.current ? created : { ...created, topic: topicRef.current };
              tid = thread.id;
              // Seed the caches: the observer mounted for the new thread must not refetch an empty list
              // over the message appended next.
              qc.setQueryData(coachKeys.thread(tid), thread);
              qc.setQueryData<CoachMessage[]>(coachKeys.messages(tid), []);
              void invalidateCoachThreads(qc);
              if (live()) {
                threadIdRef.current = tid;
                setThreadId(tid);
              }
            }
            const row = await appendCoachMessage(tid, 'user', job.text);
            await cacheCoachMessage(qc, row);
            userMessageId = row.id;
            if (!live()) return; // the user moved on while saving: the message is kept, nothing is asked
            setLocalUser({ ...optimistic, id: row.id, createdAt: row.createdAt, local: false });
          }
        } catch {
          if (live()) setError(SAVE_ERROR);
          return;
        }
        if (!tid || !live()) return;

        // 2. history = everything stored before this user message. Read from the DATABASE, not from the query cache: the
        //    cache only drives the screen and can be stale (thread opened from History, app resumed), incomplete or
        //    reordered by an optimistic row; a missing turn here is exactly "the coach forgot what I said".
        const cached = qc.getQueryData<CoachMessage[]>(coachKeys.messages(tid)) ?? [];
        const loaded = await loadTurnHistory<CoachMessage>({
          threadId: tid,
          userMessageId,
          text: job.text,
          fetchRows: fetchCoachMessages,
          cached,
        });
        // heal a screen that missed rows
        if (loaded.fromDatabase && (loaded.rows.length !== cached.length || loaded.rows.some((m, i) => m.id !== cached[i]?.id))) {
          qc.setQueryData<CoachMessage[]>(coachKeys.messages(tid), loaded.rows);
        }
        if (controller.signal.aborted) throw new AbortError();
        const history = loaded.history;

        // 3. fresh grounding data (never rejects; missing series are simply omitted)
        const summary: CoachSummary = await buildSummaryRef
          .current({ topic: topicRef.current })
          .catch((): CoachSummary => ({}));
        if (controller.signal.aborted) throw new AbortError();

        // 4 + 5. guard, then stream the answer
        let streamed = '';
        const flush = () => {
          streamTimer = null;
          if (!live()) return;
          setStreamText(streamed);
          setPhase('streaming');
        };
        const result = await runCoachTurn({
          client: handle.client,
          model: handle.modelId,
          history,
          userMessage: job.text,
          summary,
          signal: controller.signal,
          onDelta: (delta) => {
            streamed += delta;
            if (!streamTimer) streamTimer = setTimeout(flush, 60);
          },
        });
        if (streamTimer) clearTimeout(streamTimer);
        streamTimer = null;
        // Stop pressed just as the reply finished: honour it, nothing is shown or stored.
        if (controller.signal.aborted) throw new AbortError();
        reply = result.text; // a replaced answer swaps the streamed text for the redirect
        if (live()) {
          setStreamText(result.text);
          setPhase('finishing');
        }

        // 6. persist the assistant message
        const saved = await appendCoachMessage(tid, 'assistant', result.text, { touch: true });
        reply = null;
        // Remember the stored id BEFORE the cache gets the message, so the live reply is hidden exactly when
        // the stored copy appears (never shown twice, never missing for a frame).
        if (live()) setSavedAssistantId(saved.id);
        await cacheCoachMessage(qc, saved);
        void invalidateCoachThreads(qc);
        if (live()) {
          setLocalUser(null);
          autoRetriesRef.current = 0;
        }
      } catch (e) {
        if (!live()) return;
        if (reply !== null && tid) {
          // The answer exists but could not be stored: keep it visible and offer "retry saving".
          setUnsaved({
            threadId: tid,
            message: {
              id: `local-reply-${Date.now()}`,
              role: 'assistant',
              content: reply,
              createdAt: new Date().toISOString(),
              local: true,
              refusal: detectRefusal(reply),
            },
          });
          setStreamText('');
          setError(SAVE_ERROR);
        } else if (isAbortError(e) || controller.signal.aborted) {
          setStopped(true);
          setStreamText('');
        } else {
          const secrets = [useAiStore.getState().apiKey];
          const mapped = mapCoachError(e, secrets, autoRetriesRef.current);
          // 401 mid-session: the key was revoked. Re-check it so the gate closes and AI UI disappears.
          if (mapped.kind === 'auth') void useAiStore.getState().revalidate();
          setStreamText('');
          setError(mapped);
        }
      } finally {
        if (streamTimer) clearTimeout(streamTimer);
        if (runRef.current === run) runRef.current = null;
        if (live()) setPhase('idle');
      }
    },
    [qc],
  );

  /** Retries storing a reply that was shown but not saved. */
  const saveUnsavedReply = useCallback(async (): Promise<void> => {
    const pending = unsavedRef.current;
    if (!pending || runRef.current) return;
    setError(null);
    try {
      const saved = await appendCoachMessage(pending.threadId, 'assistant', pending.message.content, { touch: true });
      await cacheCoachMessage(qc, saved);
      void invalidateCoachThreads(qc);
      if (!mountedRef.current) return;
      setUnsaved(null);
      setLocalUser(null);
    } catch {
      if (mountedRef.current) setError(SAVE_ERROR);
    }
  }, [qc]);

  // ---- actions -----------------------------------------------------------------------------------------------

  /** Starts a turn. Returns false (and keeps the draft) when nothing was sent. */
  const send = useCallback(
    (raw: string): boolean => {
      const text = raw.trim().slice(0, MAX_MESSAGE_CHARS);
      if (!text || runRef.current || unsavedRef.current || !canSendRef.current) return false;
      if (!onlineRef.current) {
        setError(OFFLINE_ERROR);
        return false;
      }
      autoRetriesRef.current = 0;
      void runTurn({ text });
      return true;
    },
    [runTurn],
  );

  /** Re-runs the last unanswered user message (or re-saves an unsaved reply). */
  const retry = useCallback((): void => {
    if (runRef.current) return;
    if (unsavedRef.current) {
      void saveUnsavedReply();
      return;
    }
    if (!onlineRef.current) {
      setError(OFFLINE_ERROR);
      return;
    }
    const last = messagesRef.current[messagesRef.current.length - 1];
    if (!last || last.role !== 'user') {
      setError(null);
      return;
    }
    void runTurn(last.local ? { text: last.content } : { text: last.content, persistedId: last.id });
  }, [runTurn, saveUnsavedReply]);

  /** Aborts the running request. The partial answer is discarded and the user message offers a retry. */
  const stop = useCallback((): void => {
    runRef.current?.controller.abort();
  }, []);

  /** Switches to another thread (or a blank chat with `null`), aborting any running turn. */
  const openThread = useCallback((id: string | null): void => {
    if (id !== null && id === threadIdRef.current) return;
    runRef.current?.controller.abort();
    runRef.current = null;
    epochRef.current += 1;
    autoRetriesRef.current = 0;
    navigatedRef.current = true;
    threadIdRef.current = id;
    setThreadId(id);
    setActiveTopic(null);
    setResolving(false);
    setPhase('idle');
    setStreamText('');
    setSavedAssistantId(null);
    setLocalUser(null);
    setUnsaved(null);
    setError(null);
    setStopped(false);
  }, []);

  const newChat = useCallback((): void => openThread(null), [openThread]);
  const dismissError = useCallback((): void => setError(null), []);

  // Rate limits retry on their own (at most twice per message).
  useEffect(() => {
    const at = error?.autoRetryAt;
    if (!at) return undefined;
    const timer = setTimeout(
      () => {
        autoRetriesRef.current += 1;
        retryRef.current();
      },
      Math.max(0, at - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [error]);

  // ---- derived -------------------------------------------------------------------------------------------------

  const busy = phase !== 'idle';
  const last = messages[messages.length - 1];
  /** The last user message has no answer and nothing is running: show "failed - retry" on it. */
  const failedMessageId = !busy && last?.role === 'user' && !unsaved ? last.id : null;
  const threadMissing = threadId !== null && threadQ.isSuccess && threadQ.data === null && !localUser;
  const ready = !resolving && (threadId === null || messagesQ.isSuccess);
  /** A blank chat about something: the question that is pre-filled in the input (never sent automatically). */
  const suggestedInput = topic && ready && !threadMissing && messages.length === 0 && !busy ? topicPrefill(topic) : '';

  useEffect(() => {
    topicRef.current = topic;
    aiRef.current = ai;
    buildSummaryRef.current = buildSummary;
    onlineRef.current = online;
    unsavedRef.current = unsaved;
    canSendRef.current = ready && !threadMissing;
    messagesRef.current = messages;
    retryRef.current = retry;
  });

  return {
    threadId,
    /** What this conversation is about, or null for an ordinary chat. */
    topic,
    suggestedInput,
    thread: threadQ.data ?? null,
    threadMissing,
    messages,
    /** Existing thread whose messages are still loading. */
    loading: threadId !== null && messagesQ.isLoading,
    loadFailed: threadId !== null && messagesQ.isError && !messagesQ.data,
    reload: () => void messagesQ.refetch(),
    /** Safe to send: a blank chat, or an existing one whose messages are loaded. */
    ready,
    phase,
    busy,
    /** Live text of the reply being streamed / just finished and not yet in `messages`. */
    pendingReply,
    error,
    stopped,
    failedMessageId,
    online,
    send,
    stop,
    retry,
    openThread,
    newChat,
    dismissError,
  };
}

export type CoachChat = ReturnType<typeof useCoachChat>;
