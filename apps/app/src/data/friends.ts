// react-query hooks for friends. Two people who are friends see each other's custom foods and recipes (read-only); nothing else is shared.
// The database does the work (supabase/migrations/20261110000109_friends.sql): the RPCs send_friend_request / respond_friend_request /
// list_friendships, the row level security that lets friends read each other's custom foods and recipes, and the search rule.
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

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

/** Sends a request to an e-mail address. Resolves with the server's answer; see {@link SendResult}. */
export function useSendFriendRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (email: string): Promise<SendResult> => {
      const { data, error } = await supabase.rpc('send_friend_request', { p_email: email });
      if (error) throw error;
      const answer = String(data);
      return answer === 'accepted' || answer === 'already_friends' || answer === 'already_requested' ? answer : 'sent';
    },
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
