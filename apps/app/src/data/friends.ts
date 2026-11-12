// react-query hooks for friends. Two people who are friends see each other's custom foods and recipes (read-only); nothing else is shared.
// The work happens in the `friend-request` Edge Function and in the database RPCs (supabase/migrations/20261110000109_friends.sql and
// 20261110000110_friend_request_internal.sql); the function also e-mails the addressee when a request was actually created.
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { readFunctionFailure } from '@/lib/function-error';
import { FORMER_FRIEND, splitFriendships, type Friendship, type SendAnswer } from '@/components/friends/friends-view';
import { supabase } from '@/lib/supabase';

import { useUserId } from './profile';

/** What `send_friend_request` answers. An e-mail without an account also answers 'sent' (and creates nothing). */
export type SendResult = SendAnswer;

/** Includes the user id so a cached list never leaks across accounts. */
export const friendKey = (userId: string | undefined) => ['friends', userId ?? 'anon'] as const;

/** How often the open app asks for new requests: this is the "notification" (a count on More and on the Friends row). */
export const FRIENDS_POLL_MS = 60_000;

export type { Friendship, FriendSplit, FriendshipDirection, FriendshipStatus } from '@/components/friends/friends-view';
export { splitFriendships } from '@/components/friends/friends-view';

type Row = Record<string, unknown>;

function mapFriendship(row: Row): Friendship {
  return {
    id: String(row.id),
    status: row.status === 'accepted' ? 'accepted' : 'pending',
    direction: row.direction === 'outgoing' ? 'outgoing' : 'incoming',
    userId: String(row.user_id),
    displayName: String(row.display_name ?? ''),
    email: String(row.email ?? ''),
    createdAt: String(row.created_at ?? ''),
    respondedAt: row.responded_at ? String(row.responded_at) : null,
  };
}

export async function fetchFriendships(): Promise<Friendship[]> {
  const { data, error } = await supabase.rpc('list_friendships');
  if (error) throw error;
  return ((data ?? []) as Row[]).map(mapFriendship);
}

/** Everything about friends, split up. The query refetches when the app comes back to the foreground and once a minute while it is open. */
export function useFriendships(options: { enabled?: boolean } = {}) {
  const userId = useUserId();
  const query = useQuery({
    queryKey: friendKey(userId),
    enabled: Boolean(userId) && (options.enabled ?? true),
    queryFn: fetchFriendships,
    staleTime: 15_000,
    refetchInterval: FRIENDS_POLL_MS,
  });
  const all = query.data;
  const split = splitFriendships(all ?? []);
  return { ...query, ...split };
}

/** How many requests wait for an answer: the number on the More tab and on the Friends row. 0 until the list is known. */
export function useFriendRequestCount(): number {
  return useFriendships().incoming.length;
}

/**
 * Who shared a food or recipe: the friend's name when `ownerId` is somebody else (a friend), null for your own and for global foods.
 * A food of somebody who is no longer a friend (you still use it) says "a former friend". Only asks for the friends when it has to.
 */
export function useSharedBy(ownerId: string | null | undefined): string | null {
  const me = useUserId();
  const foreign = Boolean(ownerId) && ownerId !== me;
  const { names, isSuccess } = useFriendships({ enabled: foreign });
  // Until the friends are known nothing is said: a friend must not flash up as "a former friend".
  if (!foreign || !ownerId || !isSuccess) return null;
  return names.get(ownerId) ?? FORMER_FRIEND;
}

/** After a friendship starts or ends: the lists and searches that show friends' foods change. */
export function invalidateFriendData(qc: QueryClient): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ['friends'] }),
    qc.invalidateQueries({ queryKey: ['my_foods'] }),
    qc.invalidateQueries({ queryKey: ['friend_foods'] }),
    qc.invalidateQueries({ queryKey: ['recipes'] }),
    qc.invalidateQueries({ queryKey: ['food_search'] }),
    qc.invalidateQueries({ queryKey: ['recent_foods'] }),
    qc.invalidateQueries({ queryKey: ['favorites'] }),
  ]);
}

/**
 * The `friend-request` Edge Function creates the request and e-mails the addressee when it was actually created. When the
 * function cannot answer at all (not deployed, network) the direct RPC keeps working, exactly as before.
 *
 * The function's error tokens are re-shaped into the SQLSTATE forms the screen already words (friendErrorMessage): the
 * database refusals of the request go out of the function as `own_email` / `invalid_email` / `too_many`.
 */
async function sendFriendRequest(email: string): Promise<SendResult> {
  const fromFunction = (body: Record<string, unknown> | null): SendResult => {
    const status = typeof body?.status === 'string' ? body.status : '';
    return status === 'accepted' || status === 'already_friends' || status === 'already_requested' ? status : 'sent';
  };

  let res: Awaited<ReturnType<typeof supabase.functions.invoke>>;
  try {
    res = await supabase.functions.invoke('friend-request', { body: { email } });
  } catch {
    return sendFriendRequestByRpc(email); // network: the request must not depend on the mail path
  }
  if (res.error) {
    const failure = await readFunctionFailure(res.error);
    if (failure.status === null || failure.status === 404) return sendFriendRequestByRpc(email);
    const token = typeof failure.body?.error === 'string' ? failure.body.error : '';
    const dbShape =
      token === 'own_email'
        ? { code: '22023', message: 'that is your own e-mail address' }
        : token === 'invalid_email'
          ? { code: '22023', message: 'that is not a valid e-mail address' }
          : token === 'rate_limited' || failure.status === 429
            ? { code: '54000', message: 'too many friend requests today, try again tomorrow' }
            : null;
    if (dbShape) {
      const refused = new Error(dbShape.message) as Error & { code?: string };
      refused.code = dbShape.code;
      throw refused;
    }
    throw new Error(
      typeof failure.body?.message === 'string' && failure.body.message !== ''
        ? failure.body.message
        : 'Something went wrong. Try again.',
    );
  }
  return fromFunction(res.data as Record<string, unknown> | null);
}

/** The direct RPC of the app builds made before the friend-request function existed (the fallback). */
async function sendFriendRequestByRpc(email: string): Promise<SendResult> {
  const { data, error } = await supabase.rpc('send_friend_request', { p_email: email });
  if (error) throw error;
  const answer = String(data);
  return answer === 'accepted' || answer === 'already_friends' || answer === 'already_requested' ? answer : 'sent';
}

/** Sends a request to an e-mail address. Resolves with the server's answer; see {@link SendResult}. */
export function useSendFriendRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: sendFriendRequest,
    onSuccess: () => invalidateFriendData(qc),
  });
}

/** Accepts or declines a request somebody sent me. Resolves with whether there was such a request. */
export function useRespondFriendRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, accept }: { id: string; accept: boolean }): Promise<boolean> => {
      const { data, error } = await supabase.rpc('respond_friend_request', { p_id: id, p_accept: accept });
      if (error) throw error;
      return data === true;
    },
    onSuccess: () => invalidateFriendData(qc),
  });
}

/** Cancels a request I sent, or ends a friendship (either side may delete the row). */
export function useRemoveFriendship() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const { error } = await supabase.from('friendships').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => invalidateFriendData(qc),
  });
}
