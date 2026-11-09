// OWNER: profile/targets agent (replace this stub with the real implementation; keep the exports).
import { useQuery } from '@tanstack/react-query';
import type { ActivityLevel, BmrFormula, EnergyMode, Sex, UnitSystem } from '@cal/core';

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
  net_carbs: boolean;
  pregnant: boolean;
  lactating: boolean;
  coach_auto_delete: boolean;
  onboarded: boolean;
}

export function useProfile() {
  return useQuery({
    queryKey: keys.profile,
    queryFn: async (): Promise<Profile | null> => {
      const { data, error } = await supabase.from('profiles').select('*').maybeSingle();
      if (error) throw error;
      return (data as Profile | null) ?? null;
    },
  });
}

/** The user's preferred unit system (defaults to metric until the profile loads). */
export function useUnitSystem(): UnitSystem {
  return useProfile().data?.unit_system ?? 'metric';
}
