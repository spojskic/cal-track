// Invite-code registration: the app asks the Edge Function `sign-up` (supabase/functions/sign-up) to create the account,
// then signs in with the same credentials (useAuth().signIn) and the normal first-run redirect leads to onboarding.
import { readFunctionFailure, toFiniteNumber } from '@/lib/function-error';
import {
  GENERIC_FAILURE_MESSAGE,
  OFFLINE_MESSAGE,
  describeSignUpFailure,
  type SignUpFailure,
} from '@/lib/signup';
import { supabase } from '@/lib/supabase';

export type CreateAccountResult = { ok: true } | ({ ok: false } & SignUpFailure);

export interface CreateAccountInput {
  email: string;
  password: string;
  /** As typed: the server ignores case, dashes and spaces. */
  inviteCode: string;
}

/** Calls `sign-up`. Never throws: every failure comes back as a friendly message. */
export async function createAccount(input: CreateAccountInput): Promise<CreateAccountResult> {
  let res: Awaited<ReturnType<typeof supabase.functions.invoke>>;
  try {
    res = await supabase.functions.invoke('sign-up', {
      body: { email: input.email.trim(), password: input.password, inviteCode: input.inviteCode },
    });
  } catch {
    return { ok: false, message: OFFLINE_MESSAGE };
  }

  if (res.error) {
    const failure = await readFunctionFailure(res.error);
    const code = typeof failure.body?.error === 'string' ? failure.body.error : null;
    const retry = toFiniteNumber(failure.body?.retryAfterSeconds) ?? failure.retryAfter;
    return { ok: false, ...describeSignUpFailure({ status: failure.status, code, retryAfterSeconds: retry }) };
  }

  const body = res.data as { ok?: unknown } | null;
  if (body && typeof body === 'object' && body.ok === true) return { ok: true };
  return { ok: false, message: GENERIC_FAILURE_MESSAGE };
}
