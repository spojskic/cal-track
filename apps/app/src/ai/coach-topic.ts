/**
 * What a coach conversation can be ABOUT. Pure (no React / Supabase imports) so it can be unit tested.
 *
 * A topic is stored on the thread (`coach_threads.topic`, jsonb, migration 20261110000106) as
 *   { kind: 'workout', id: '<exercise_entries uuid>' }
 * and reaches the coach through the route `/coach?topicKind=workout&topicId=<uuid>`. On every turn of such a thread the
 * app asks `loadWorkoutCoachContext(id)` (ai/workout-context.ts) for a plain-text description of that workout and puts it
 * into the data block under "The user is asking about this workout:".
 */

import type { CoachWorkoutDetail } from '@cal/ai';

import { isUuid } from '@/lib/uuid';

export type CoachTopic = { kind: 'workout'; id: string };

export const TOPIC_KINDS = ['workout'] as const;

/** Cap for the description of the workout the chat is about (characters). */
export const TOPIC_CONTEXT_MAX_CHARS = 3000;
/** Cap for the description of the latest workout in a chat that has no topic. */
export const LATEST_WORKOUT_MAX_CHARS = 1800;

export const TOPIC_HEADING = 'The user is asking about this workout:';
export const LATEST_WORKOUT_HEADING = "The user's most recent workout, in detail:";

type Param = string | string[] | undefined | null;
const first = (p: Param): string | undefined => (Array.isArray(p) ? p[0] : (p ?? undefined));

/** Reads the route params of `/coach`. Anything that is not a known kind with a valid id is no topic. */
export function parseCoachTopic(params: { topicKind?: Param; topicId?: Param }): CoachTopic | null {
  const kind = first(params.topicKind);
  const id = first(params.topicId);
  if (kind === 'workout' && isUuid(id)) return { kind: 'workout', id: id.toLowerCase() };
  return null;
}

/** Validates a jsonb value read from the database. */
export function topicFromJson(value: unknown): CoachTopic | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  return v.kind === 'workout' && typeof v.id === 'string' && isUuid(v.id) ? { kind: 'workout', id: v.id.toLowerCase() } : null;
}

export function sameTopic(a: CoachTopic | null | undefined, b: CoachTopic | null | undefined): boolean {
  return Boolean(a && b && a.kind === b.kind && a.id.toLowerCase() === b.id.toLowerCase());
}

/** Stable string for effect dependencies and React keys. */
export function topicKey(topic: CoachTopic | null | undefined): string {
  return topic ? `${topic.kind}:${topic.id}` : 'none';
}

export function topicLabel(topic: CoachTopic): string {
  return topic.kind === 'workout' ? 'Workout' : 'Chat';
}

/** The question that is pre-filled in the input (never sent automatically). */
export function topicPrefill(topic: CoachTopic): string {
  return topic.kind === 'workout' ? 'How was this workout?' : '';
}

/** Tappable starters for an empty topic thread. */
export function topicPrompts(topic: CoachTopic): readonly string[] {
  return topic.kind === 'workout'
    ? [
        'How was this workout?',
        'How hard was it for my heart?',
        'What should I eat after it?',
        'How should I recover from it?',
        'What would you change next time?',
      ]
    : [];
}

// ---------------------------------------------------------------------------------------------------------------
// Titles
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

/** "Workout: <first message>" for a thread that has a topic, else the plain title. */
export function topicThreadTitle(topic: CoachTopic | null | undefined, firstMessage: string): string {
  if (!topic) return coachThreadTitle(firstMessage);
  const label = topicLabel(topic);
  const title = coachThreadTitle(firstMessage);
  return title === NEW_CHAT_TITLE ? label : `${label}: ${title}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------------------------------------------

/** `loadWorkoutCoachContext` result (plain text or null) to the sections of the data block. */
export function workoutDetailSections(input: { topicText?: string | null; latestText?: string | null }): CoachWorkoutDetail[] {
  const out: CoachWorkoutDetail[] = [];
  const topic = input.topicText?.trim();
  const latest = input.latestText?.trim();
  if (topic) out.push({ heading: TOPIC_HEADING, text: topic, maxChars: TOPIC_CONTEXT_MAX_CHARS });
  else if (latest) out.push({ heading: LATEST_WORKOUT_HEADING, text: latest, maxChars: LATEST_WORKOUT_MAX_CHARS });
  return out;
}
