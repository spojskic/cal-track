/**
 * Supabase adapters for the `friend-request` Edge Function (pure, like ./signup-store.ts): thin wrappers over
 * the service-role-only `public.send_friend_request_internal` (migration 110) and over the sender's profile.
 * Only the tiny surfaces below are needed, so unit tests pass fakes and `friend-request/index.ts` passes the
 * real service-role client.
 */
import { StoreError, type SupabaseLike } from './food-store.ts';
import type { SendRequestOutcome } from './friend-request.ts';

/**
 * The database's refusals of send_friend_request_internal -> outcomes. 22023 with the "own e-mail" message is
 * its own outcome (the app words it differently from a malformed address); 54000 is the 20-a-day limit. The
 * `reason` of an unknown error is a sanitised code (never the message, which could contain the address).
 */
export function classifyFriendRequestError(error: { message?: string; code?: string }): SendRequestOutcome {
  const code = typeof error.code === 'string' ? error.code : '';
  if (code === '22023') {
    if (/own e-mail/i.test(error.message ?? '')) return { kind: 'own_email' };
    return { kind: 'invalid_email' };
  }
  if (code === '54000') return { kind: 'too_many' };
  const safeCode = /^[a-z0-9_]{1,60}$/.test(code) ? code : '';
  return { kind: 'error', reason: safeCode || 'unknown' };
}

const REQUEST_STATUSES = new Set(['sent', 'accepted', 'already_friends', 'already_requested']);

export interface FriendRequestStore {
  sendRequestInternal(requesterId: string, email: string): Promise<SendRequestOutcome>;
  displayNameOf(userId: string): Promise<string>;
}

export function makeFriendRequestStore(admin: SupabaseLike): FriendRequestStore {
  return {
    async sendRequestInternal(requesterId, email) {
      const res = await admin.rpc('send_friend_request_internal', {
        p_requester: requesterId,
        p_email: email,
      });
      if (res.error) return classifyFriendRequestError(res.error);
      const row = res.data;
      if (
        row === null || typeof row !== 'object' ||
        typeof (row as Record<string, unknown>).status !== 'string' ||
        !REQUEST_STATUSES.has(String((row as Record<string, unknown>).status)) ||
        typeof (row as Record<string, unknown>).created !== 'boolean'
      ) {
        throw new StoreError('send_friend_request_internal', { message: 'unexpected response' });
      }
      const ok = row as { status: string; created: boolean };
      return { kind: 'ok', status: ok.status, created: ok.created };
    },

    async displayNameOf(userId) {
      const res = await admin.from('profiles').select('display_name').eq('user_id', userId);
      if (res.error) throw new StoreError('profiles', res.error);
      const row = (res.data ?? [])[0];
      const name = row !== null && typeof row === 'object' ? (row as Record<string, unknown>).display_name : null;
      return typeof name === 'string' ? name : '';
    },
  };
}
