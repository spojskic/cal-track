// Energy preferences that live on the profile: the Target / Balance view of the energy summary's third circle, and the
// one-time switch of the energy mode to "Device-adjusted" once the user connected a watch or health app.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  nextEnergySummaryMode,
  normalizeEnergySummaryMode,
  type EnergyMode,
  type EnergySummaryMode,
} from '@cal/core';

import { queryClient } from '@/lib/query';

import {
  fetchProfileRow,
  invalidateProfileData,
  profileKey,
  updateProfileRow,
  useProfile,
  useUserId,
  type Profile,
  type ProfilePatch,
} from './profile';

// ----------------------------------------------------------------------------------------- Target / Balance view

export const ENERGY_SUMMARY_MODE_OPTIONS: readonly { value: EnergySummaryMode; label: string }[] = [
  { value: 'target', label: 'Target' },
  { value: 'balance', label: 'Balance' },
];

export const ENERGY_SUMMARY_MODE_NOTE =
  'Target shows what is left of your energy target (plus what you burned above your baseline): Remaining or Over. Balance shows energy burned minus energy eaten, whatever your weight goal: Deficit or Surplus. Your macro targets do not change. You can also tap the label under the third circle to switch.';

/** The saved view of the third circle (Target until the profile loads). */
export function useEnergySummaryModeValue(): EnergySummaryMode {
  return normalizeEnergySummaryMode(useProfile().data?.energy_summary_mode);
}

/**
 * The view of the energy summary's third circle and how to change it. The change is shown at once (the cached profile
 * is updated before the request returns) and persisted with ONE update of the profile row; a failure puts the old value
 * back. It does not refetch anything else: no other number depends on this preference.
 */
export function useEnergySummaryMode() {
  const qc = useQueryClient();
  const userId = useUserId();
  const mode = useEnergySummaryModeValue();
  const mutation = useMutation({
    mutationFn: (next: EnergySummaryMode) => updateProfileRow({ energy_summary_mode: next }),
    onMutate: async (next) => {
      const key = profileKey(userId);
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData(key) as Profile | null | undefined;
      if (previous) qc.setQueryData(key, { ...previous, energy_summary_mode: next });
      return { previous };
    },
    onError: (_error, _next, context) => {
      if (context?.previous) qc.setQueryData(profileKey(userId), context.previous);
    },
    onSuccess: (row) => {
      qc.setQueryData(profileKey(row.user_id), row);
    },
  });
  return {
    mode,
    setMode: (next: EnergySummaryMode) => mutation.mutate(next),
    toggle: () => mutation.mutate(nextEnergySummaryMode(mode)),
    isPending: mutation.isPending,
    error: mutation.error,
  };
}

// ------------------------------------------------------------------------- switch to Device-adjusted after connecting

/** Shown to the user (once) when {@link enableDeviceEnergyMode} switched the mode. */
export const DEVICE_ENERGY_MODE_NOTICE =
  'Energy mode is now Device-adjusted: your budget follows your watch, like Cronometer. You can change it in Profile & targets.';

/**
 * - `switched`: the mode was Static and is now Device-adjusted (show {@link DEVICE_ENERGY_MODE_NOTICE}).
 * - `already`: the mode already uses the device (Device-adjusted or Device total); nothing changed.
 * - `kept`: nothing changed because the user went back to Static on purpose after an earlier automatic switch (or there
 *   is no profile row to change).
 */
export type EnableDeviceEnergyModeResult = 'switched' | 'already' | 'kept';

export interface EnableDeviceEnergyModeDeps {
  readProfile: () => Promise<Pick<Profile, 'energy_mode' | 'energy_mode_auto_switched_at'> | null>;
  writeProfile: (patch: ProfilePatch) => Promise<Profile>;
  /** Called after the profile changed (refresh the caches). */
  onSwitched?: (row: Profile) => void | Promise<unknown>;
  now?: () => Date;
}

const DEVICE_MODES: readonly EnergyMode[] = ['device_adjusted', 'device_total'];

/**
 * The decision of {@link enableDeviceEnergyMode}, with its dependencies injected:
 * Static and never switched automatically -> Device-adjusted (and remember when in `energy_mode_auto_switched_at`);
 * already a device mode -> nothing; Static after an automatic switch -> nothing (the user chose it).
 */
export async function enableDeviceEnergyModeWith(deps: EnableDeviceEnergyModeDeps): Promise<EnableDeviceEnergyModeResult> {
  const profile = await deps.readProfile();
  if (!profile) return 'kept';
  if (DEVICE_MODES.includes(profile.energy_mode)) return 'already';
  if (profile.energy_mode_auto_switched_at) return 'kept';
  const row = await deps.writeProfile({
    energy_mode: 'device_adjusted',
    energy_mode_auto_switched_at: (deps.now?.() ?? new Date()).toISOString(),
  });
  await deps.onSwitched?.(row);
  return 'switched';
}

/**
 * Call after the user connected Apple Health, Health Connect or Garmin: a budget that follows the watch is what they
 * expect, and Static ignores it. Switches Static -> Device-adjusted ONCE (see {@link enableDeviceEnergyModeWith}); a user
 * who goes back to Static later keeps it.
 *
 * Throws when signed out or offline (the profile could not be read or written): a connect flow should catch that and
 * carry on, the mode can still be changed under Profile & targets.
 */
export function enableDeviceEnergyMode(): Promise<EnableDeviceEnergyModeResult> {
  return enableDeviceEnergyModeWith({
    readProfile: fetchProfileRow,
    writeProfile: updateProfileRow,
    onSwitched: async (row) => {
      queryClient.setQueryData(profileKey(row.user_id), row);
      await invalidateProfileData(queryClient);
    },
  });
}
