// Pure (no React Native / Expo imports): the words and rules of the Friends screen (app/friends.tsx). Kept apart so they can be unit-tested
// without a renderer (tools/ui-smoke/src/friends-view.test.ts).
import { isPlausibleEmail } from '../../lib/signup';
import { formatShortDate } from '../settings/format';

export type FriendshipStatus = 'pending' | 'accepted';
export type FriendshipDirection = 'incoming' | 'outgoing';

/** A friend or a request, from the point of view of the signed-in user (a row of `list_friendships`). */
export interface Friendship {
  id: string;
  status: FriendshipStatus;
  /** 'incoming': they asked you. 'outgoing': you asked them. */
  direction: FriendshipDirection;
  /** The OTHER person. */
  userId: string;
  displayName: string;
  email: string;
  createdAt: string;
  respondedAt: string | null;
}

export interface FriendSplit {
  /** Accepted. */
  friends: Friendship[];
  /** Pending requests that were sent to me. */
  incoming: Friendship[];
  /** Pending requests I sent. */
  outgoing: Friendship[];
  friendIds: string[];
  /** user id -> display name (else the e-mail), for the accepted friends. */
  names: Map<string, string>;
}

/** The list the server returns, split into friends and the two kinds of requests. */
export function splitFriendships(all: readonly Friendship[]): FriendSplit {
  const friends = all.filter((f) => f.status === 'accepted');
  return {
    friends,
    incoming: all.filter((f) => f.status === 'pending' && f.direction === 'incoming'),
    outgoing: all.filter((f) => f.status === 'pending' && f.direction === 'outgoing'),
    friendIds: friends.map((f) => f.userId),
    names: new Map(friends.map((f) => [f.userId, f.displayName || f.email] as const)),
  };
}

/** What `send_friend_request` answers (see data/friends.ts). */
export type SendAnswer = 'sent' | 'accepted' | 'already_friends' | 'already_requested';

export type EmailCheck = { ok: true; email: string } | { ok: false; error: string };

/** The e-mail field: trimmed and lower-case, and it has to look like an address. */
export function parseFriendEmail(raw: string): EmailCheck {
  const email = raw.trim().toLowerCase();
  if (email === '') return { ok: false, error: "Enter your friend's e-mail address." };
  if (!isPlausibleEmail(email)) return { ok: false, error: 'Enter a valid e-mail address, for example anna@example.com.' };
  return { ok: true, email };
}

/**
 * What the screen says after a request. "sent" is also what an address without an account gets, on purpose, so the message never claims
 * that the person got it: "if ... uses Ration". (The list of waiting requests still shows only the real ones.)
 */
export function sendAnswerMessage(answer: SendAnswer, email: string): string {
  switch (answer) {
    case 'sent':
      return `Request sent. If ${email} uses Ration, they will see it the next time they open the app.`;
    case 'accepted':
      return `${email} had already asked you, so you are friends now.`;
    case 'already_friends':
      return `You are already friends with ${email}.`;
    case 'already_requested':
      return `You already sent ${email} a request. It is waiting for their answer.`;
  }
}

/** The sentence under a failed request or answer: the database's own refusals are put in plain words, anything else is shown. */
export function friendErrorMessage(error: unknown): string {
  const e = error as { code?: unknown; message?: unknown } | null;
  const message = typeof e?.message === 'string' ? e.message : '';
  if (e?.code === '54000') return 'You have sent a lot of requests today. Try again tomorrow.';
  if (e?.code === '22023' && /own e-mail/i.test(message)) return 'That is your own e-mail address.';
  if (e?.code === '22023') return 'Enter a valid e-mail address, for example anna@example.com.';
  if (e?.code === '42501') return 'You are signed out. Please sign in again.';
  return message !== '' ? message : 'Something went wrong. Try again.';
}

interface Person {
  displayName: string;
  email: string;
}

/** The name of a friend: their name when it adds something, else the e-mail. */
export function personTitle(p: Person): string {
  const name = p.displayName.trim();
  return name !== '' ? name : p.email;
}

/** The line under the name: the e-mail, unless the name already is the e-mail. */
export function personSubtitle(p: Person): string | null {
  return personTitle(p) === p.email ? null : p.email;
}

const day = (iso: string): string => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? formatShortDate(iso.slice(0, 10)) : '');

/** "Friends since Nov 10, 2026" (the day the request was accepted). */
export function friendsSince(f: { respondedAt: string | null; createdAt: string }): string {
  const d = day(f.respondedAt ?? f.createdAt);
  return d === '' ? 'Friends' : `Friends since ${d}`;
}

/** "Sent Nov 10, 2026" / "Received Nov 10, 2026". */
export function requestDate(f: { createdAt: string; direction: 'incoming' | 'outgoing' }): string {
  const d = day(f.createdAt);
  const word = f.direction === 'incoming' ? 'Received' : 'Sent';
  return d === '' ? word : `${word} ${d}`;
}

/** The small pill on the Friends row of More and of the sidebar: how many requests wait for an answer. Empty when none. */
export function friendRequestsBadge(count: number): string | undefined {
  if (!Number.isFinite(count) || count <= 0) return undefined;
  const n = Math.floor(count);
  return `${n} ${n === 1 ? 'request' : 'requests'}`;
}

/** The number on the More tab of the phone: capped so it fits the little circle. */
export function tabBadgeText(count: number): string | undefined {
  if (!Number.isFinite(count) || count <= 0) return undefined;
  return count > 9 ? '9+' : String(Math.floor(count));
}

/** "from Anna" on a food or recipe somebody else made; null for your own and for database foods. */
export function sharedByLabel(name: string | null): string | null {
  return name === null || name.trim() === '' ? null : `from ${name.trim()}`;
}

/** What a food made by somebody who is no longer your friend is credited to (you still use it, so you can still see it). */
export const FORMER_FRIEND = 'a former friend';

/** The line on a food or recipe page that somebody else made: "Shared by Anna. You can use it, but only Anna can change it." Null for your own. */
export function sharedByDetail(name: string | null): string | null {
  if (name === null || name.trim() === '') return null;
  const who = name.trim();
  return `Shared by ${who}. You can use it, but only ${who === FORMER_FRIEND ? 'they' : who} can change it.`;
}

/** What the confirmation says before a friend is removed. */
export function removeFriendMessage(name: string): string {
  return `${name} will no longer see your custom foods and recipes, and you will no longer see theirs. Foods you already logged or saved stay in your diary and recipes.`;
}

/** What the screen says to people with no friends yet. */
export const NO_FRIENDS_TEXT =
  'No friends yet. Send a request to the e-mail address of somebody who uses Ration. Once they accept, you see each other\u2019s custom foods and recipes.';

/** Said once on the screen so nobody has to guess what a friend sees. */
export const SHARING_NOTE = 'Friends see your custom foods and recipes, and nothing else: no diary, weight, targets or AI estimates.';
