import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ActivityLevel, BmrFormula, EnergyMode, EnergySummaryMode, Sex, UnitSystem } from '@cal/core';

import { useAuth } from '@/lib/auth';
import { requireUserId } from '@/lib/auth-user';
import { supabase } from '@/lib/supabase';

import { keys } from './keys';

/** Row of public.profiles. */
export interface Profile {
  user_id: string;
  display_name: string | null;
  sex: Sex | null;
  birthdate: string | null; // YYYY-MM-DD
  height_cm: number | null;
  unit_system: UnitSystem;
  timezone: string;
  activity_level: ActivityLevel | null;
  bmr_formula: BmrFormula;
  bmr_override: number | null;
  tef_enabled: boolean;
  energy_mode: EnergyMode;
  /** What the third circle of the energy summary shows: Target (Remaining / Over) or Balance (Deficit / Surplus). */
  energy_summary_mode: EnergySummaryMode;
  /** Set when the app itself moved energy_mode from 'static' to 'device_adjusted' (see data/energy-mode.ts). */
  energy_mode_auto_switched_at: string | null;
  net_carbs: boolean;
  pregnant: boolean;
  lactating: boolean;
  coach_auto_delete: boolean;
  onboarded: boolean;
}

/** Writable profile columns. */
export type ProfilePatch = Partial<Omit<Profile, 'user_id'>>;

/** The signed-in user's id, or undefined while signed out. */
export function useUserId(): string | undefined {
  return useAuth().session?.user.id;
}

/** Query key of the profile. Includes the user id so a cached profile never leaks across accounts. */
export const profileKey = (userId: string | undefined) => [...keys.profile, userId ?? 'anon'] as const;

/** The signed-in user's profile row (RLS limits the table to it), or null when there is none yet. */
export async function fetchProfileRow(): Promise<Profile | null> {
  const { data, error } = await supabase.from('profiles').select('*').maybeSingle();
  if (error) throw error;
  return (data as Profile | null) ?? null;
}

export function useProfile() {
  const userId = useUserId();
  return useQuery({
    queryKey: profileKey(userId),
    enabled: Boolean(userId),
    queryFn: fetchProfileRow,
  });
}

/** The user's preferred unit system (defaults to metric until the profile loads). */
export function useUnitSystem(): UnitSystem {
  return useProfile().data?.unit_system ?? 'metric';
}

/** The device IANA time zone, falling back to UTC. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Refreshes everything derived from the profile (the profile itself and the resolved targets). */
export function invalidateProfileData(qc: QueryClient): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: keys.profile }),
    qc.invalidateQueries({ queryKey: keys.targets }),
  ]);
}

/** Upserts the profile row (insert when missing, merge otherwise). Does not touch caches. */
export async function upsertProfileRow(patch: ProfilePatch): Promise<Profile> {
  const userId = await requireUserId();
  const { data, error } = await supabase
    .from('profiles')
    .upsert({ user_id: userId, ...patch }, { onConflict: 'user_id' })
    .select('*')
    .single();
  if (error) throw error;
  return data as Profile;
}

/** Partial update of the profile row (one PATCH). Does not touch caches. */
export async function updateProfileRow(patch: ProfilePatch): Promise<Profile> {
  const userId = await requireUserId();
  const { data, error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('user_id', userId)
    .select('*')
    .single();
  if (error) throw error;
  return data as Profile;
}

/** Partial update of the profile row. */
export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: updateProfileRow,
    onSuccess: async (row) => {
      qc.setQueryData(profileKey(row.user_id), row);
      await invalidateProfileData(qc);
    },
  });
}

/** Insert-or-merge variant of {@link useUpdateProfile} (safe when the row does not exist yet). */
export function useUpsertProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: ProfilePatch) => upsertProfileRow(patch),
    onSuccess: async (row) => {
      qc.setQueryData(profileKey(row.user_id), row);
      await invalidateProfileData(qc);
    },
  });
}
