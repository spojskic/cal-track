// `public.integrations` access (one row per user and provider). Health data itself never leaves the user's own rows.
import { supabase } from '@/lib/supabase';

import type { HealthProviderId, LocalDate } from './types';

export interface IntegrationRow {
  id: string;
  user_id: string;
  provider: HealthProviderId;
  enabled: boolean;
  /** jsonb; parse with parseSettings(). */
  settings: unknown;
  backfill_date: LocalDate | null;
  last_sync_at: string | null;
}

export interface IntegrationPatch {
  enabled?: boolean;
  settings?: Record<string, unknown>;
  backfill_date?: LocalDate | null;
  last_sync_at?: string | null;
}

/** Signed-in user id from the locally stored session (no network round trip), or null when signed out. */
export async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
}

export async function fetchIntegration(provider: HealthProviderId, userId: string): Promise<IntegrationRow | null> {
  const { data, error } = await supabase
    .from('integrations')
    .select('id, user_id, provider, enabled, settings, backfill_date, last_sync_at')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle();
  if (error) throw error;
  return (data as IntegrationRow | null) ?? null;
}

/** Insert-or-update on the unique (user_id, provider). Only the columns in `patch` change. */
export async function saveIntegration(
  userId: string,
  provider: HealthProviderId,
  patch: IntegrationPatch,
): Promise<IntegrationRow> {
  const { data, error } = await supabase
    .from('integrations')
    .upsert({ user_id: userId, provider, ...patch }, { onConflict: 'user_id,provider' })
    .select('id, user_id, provider, enabled, settings, backfill_date, last_sync_at')
    .single();
  if (error) throw error;
  return data as IntegrationRow;
}
