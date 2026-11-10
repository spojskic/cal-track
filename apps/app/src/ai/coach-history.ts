/**
 * The conversation as the coach model should see it. Pure (no React / Supabase imports) so it can be unit tested.
 *
 * Source of truth for the history is the database (`fetchCoachMessages`), read right after the new user message was
 * stored; the query cache only decides what the screen shows. The functions here turn stored rows into the
 * `CoachHistoryMessage[]` that `runCoachTurn` receives. Trimming to the model's budget (whole oldest turns first, with
 * a note) is `@cal/ai`'s job (`prepareHistory`); nothing here cuts text.
 */

import { DEFAULT_REFUSALS, type CoachHistoryMessage, type GuardCategory } from '@cal/ai';

export type RefusalCategory = Exclude<GuardCategory, 'on_topic'>;

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

/**
 * A fixed refusal is long boilerplate. In the history the model gets one short line instead, so it neither copies the
 * wording nor drifts into refusing the next (on-topic) message, but still knows what happened in that turn.
 */
export const REFUSAL_MARKERS: Readonly<Record<RefusalCategory, string>> = {
  off_topic: '(The coach declined to answer the previous message because it was outside the topics it covers.)',
  medical_red_flag: '(The coach advised the user to get medical care for the previous message instead of coaching on it.)',
  eating_disorder_risk:
    '(The coach answered the previous message supportively and suggested professional help instead of giving restriction advice.)',
};

export interface HistoryRow {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Stored messages (oldest first) to model history. Everything is kept: a user message that never got an answer is NOT
 * dropped (the user wrote it; `@cal/ai` merges it into the next message), and replies are passed whole. Only fixed
 * refusals are shortened to a marker.
 */
export function toCoachHistory(rows: readonly HistoryRow[]): CoachHistoryMessage[] {
  const out: CoachHistoryMessage[] = [];
  for (const m of rows) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (typeof m.content !== 'string' || !m.content.trim()) continue;
    const refusal = m.role === 'assistant' ? detectRefusal(m.content) : null;
    out.push({ role: m.role, content: refusal ? REFUSAL_MARKERS[refusal] : m.content });
  }
  return out;
}

/**
 * The rows stored BEFORE the user message that is being sent.
 *  - normal case: everything before the row with `userMessageId`
 *  - the row is not in the list (a list that was loaded before it was saved, a retry of a message that was never
 *    stored): the whole list, minus a trailing copy of the text being sent, so the message never appears twice
 */
export function historyBefore<T extends HistoryRow & { id: string }>(
  rows: readonly T[],
  userMessageId: string | undefined,
  currentText?: string,
): T[] {
  const at = userMessageId === undefined ? -1 : rows.findIndex((m) => m.id === userMessageId);
  if (at >= 0) return rows.slice(0, at);
  const out = [...rows];
  const last = out[out.length - 1];
  if (last && last.role === 'user' && currentText !== undefined && last.content.trim() === currentText.trim()) out.pop();
  return out;
}

export interface TurnHistory<T> {
  /** What the coach model gets (everything before the new message). */
  history: CoachHistoryMessage[];
  /** The stored rows that were read (the screen's cache is healed with them when they differ). */
  rows: T[];
  /** False when the database read failed and the (possibly stale) cache was used instead. */
  fromDatabase: boolean;
}

/**
 * The conversation before the user message that is being sent. The DATABASE is the source of truth: the query cache only
 * drives the screen and can be stale (a thread opened from History, an app that was resumed), incomplete or hold an
 * optimistic row; a missing turn here is exactly "the coach forgot what I said". If the read fails the cache is used.
 */
export async function loadTurnHistory<T extends HistoryRow & { id: string }>(args: {
  threadId: string;
  userMessageId: string | undefined;
  text: string;
  fetchRows: (threadId: string) => Promise<T[]>;
  cached: readonly T[];
}): Promise<TurnHistory<T>> {
  let rows: T[];
  let fromDatabase = true;
  try {
    rows = await args.fetchRows(args.threadId);
  } catch {
    rows = [...args.cached];
    fromDatabase = false;
  }
  return { history: toCoachHistory(historyBefore(rows, args.userMessageId, args.text)), rows, fromDatabase };
}
