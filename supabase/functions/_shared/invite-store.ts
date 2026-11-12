/**
 * Supabase adapters for the `send-invite` Edge Function (pure, like ./signup-store.ts): the super-admin
 * check (`profiles.is_admin`, read with the service role - the flag itself is owner-only in the database)
 * and `public.create_invite_code_for` (owner / service role only, migration 108). Unit tests pass fakes;
 * `send-invite/index.ts` passes the real service-role client.
 */
import { StoreError, type SupabaseLike } from './food-store.ts';

/** The code as the database makes it: XXXX-XXXX-XXXX from the look-alike-free alphabet (migration 100). */
const CODE_RE = /^[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/;

export interface InviteAdminStore {
  isSuperAdmin(userId: string): Promise<boolean>;
  createInviteCodeFor(email: string, maxUses: number, validDays: number | null): Promise<string>;
}

export function makeInviteAdminStore(admin: SupabaseLike): InviteAdminStore {
  return {
    async isSuperAdmin(userId) {
      const res = await admin.from('profiles').select('is_admin').eq('user_id', userId);
      if (res.error) throw new StoreError('profiles', res.error);
      const row = (res.data ?? [])[0];
      return row !== null && typeof row === 'object' && (row as Record<string, unknown>).is_admin === true;
    },

    async createInviteCodeFor(email, maxUses, validDays) {
      const res = await admin.rpc('create_invite_code_for', {
        p_invited_email: email,
        p_max_uses: maxUses,
        p_valid_days: validDays,
      });
      if (res.error) throw new StoreError('create_invite_code_for', res.error);
      if (typeof res.data !== 'string' || !CODE_RE.test(res.data)) {
        throw new StoreError('create_invite_code_for', { message: 'unexpected response' });
      }
      return res.data;
    },
  };
}
