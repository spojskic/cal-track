import { supabase } from './supabase';

/** Shown to the user when a write is attempted without a session. */
export const SIGNED_OUT_MESSAGE = 'You are signed out. Please sign in again.';

/**
 * Id of the signed-in user for a write, read from the locally stored session (no network round trip, unlike
 * `supabase.auth.getUser()`, which asks the auth server on EVERY call). Throws {@link SIGNED_OUT_MESSAGE} when there
 * is no session.
 *
 * This is the single implementation: do not call `supabase.auth.getUser()` for the user id elsewhere.
 */
export async function requireUserId(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user.id;
  if (!userId) throw new Error(SIGNED_OUT_MESSAGE);
  return userId;
}
