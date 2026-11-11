// react-query hooks for the Invite people screen (super admin only). The database is the gate: every call is an RPC that raises 42501
// for anybody whose profile has is_admin = false (supabase/migrations/20261110000107_super_admin_invites.sql and
// 20261110000108_invite_email.sql). The screen only calls them when the profile says the user is an admin, so an ordinary user never
// sends these requests.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { INVITE_PAGE_SIZE, type InviteCode, type NewInvite } from '@/components/settings/invite-view';
import { supabase } from '@/lib/supabase';

import { useProfile, useUserId } from './profile';

/** Includes the user id so a cached list never leaks across accounts (same convention as profileKey). */
export const inviteKey = (userId: string | undefined) => ['admin', 'invites', userId ?? 'anon'] as const;

/** Whether the signed-in user is the super admin, and whether we still do not know (the profile is loading). */
export function useIsSuperAdmin(): { isAdmin: boolean; isLoading: boolean } {
  const profile = useProfile();
  return { isAdmin: profile.data?.is_admin === true, isLoading: profile.isLoading };
}

/** Which codes a list shows: the ones that can still be used, or the closed ones (used up, expired, revoked). */
export type InviteFilter = 'active' | 'closed';

export interface InvitePage {
  rows: InviteCode[];
  /** How many codes the filter matches in all (not only on this page). */
  total: number;
}

/**
 * One page of a list, newest first. The server returns every code of `admin_list_invites()`; PostgREST filters it by status, cuts the
 * page (`offset` / `limit`) and counts the match (`Prefer: count=exact`), so only `pageSize` rows travel however many codes exist.
 */
export async function fetchInvitePage(filter: InviteFilter, page: number, pageSize: number = INVITE_PAGE_SIZE): Promise<InvitePage> {
  const from = Math.max(0, page) * pageSize;
  const base = supabase.rpc('admin_list_invites', undefined, { count: 'exact' });
  const filtered = filter === 'active' ? base.eq('status', 'active') : base.neq('status', 'active');
  const { data, count, error } = await filtered
    .order('created_at', { ascending: false })
    .order('code', { ascending: true })
    .range(from, from + pageSize - 1);
  if (error) throw error;
  const rows = (data ?? []) as InviteCode[];
  return { rows, total: count ?? from + rows.length };
}

/** One page of the active or the closed codes. Only runs for the super admin; the previous page stays on screen while the next loads. */
export function useInvitePage(filter: InviteFilter, page: number, enabled = true) {
  const userId = useUserId();
  const { isAdmin } = useIsSuperAdmin();
  return useQuery({
    queryKey: [...inviteKey(userId), 'page', filter, page] as const,
    enabled: enabled && Boolean(userId) && isAdmin,
    queryFn: () => fetchInvitePage(filter, page),
    placeholderData: keepPreviousData,
  });
}

/** Creates a code for an e-mail address and returns it (XXXX-XXXX-XXXX). Nothing is sent to the address. */
export function useCreateInviteCode() {
  const qc = useQueryClient();
  const userId = useUserId();
  return useMutation({
    mutationFn: async (invite: NewInvite): Promise<string> => {
      const { data, error } = await supabase.rpc('admin_create_invite_code_for', {
        p_email: invite.email,
        p_max_uses: invite.maxUses,
        p_valid_days: invite.validDays,
      });
      if (error) throw error;
      return String(data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: inviteKey(userId) }),
  });
}

/** Revokes a code so nobody can sign up with it any more. Returns whether the code existed. */
export function useRevokeInviteCode() {
  const qc = useQueryClient();
  const userId = useUserId();
  return useMutation({
    mutationFn: async (code: string): Promise<boolean> => {
      const { data, error } = await supabase.rpc('admin_revoke_invite_code', { p_code: code });
      if (error) throw error;
      return data === true;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: inviteKey(userId) }),
  });
}
