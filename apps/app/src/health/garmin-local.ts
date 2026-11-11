// State of the Garmin sync that belongs to THIS phone only: when Garmin asked us to slow down, the last sync report and the
// last problem. Not secret (the report has no values and no tokens) and not worth a database column.
import AsyncStorage from '@react-native-async-storage/async-storage';

import { migrateAsyncKey } from '@/lib/migrate-key';

import { EMPTY_LOCAL_STATE, parseLocalState, serializeLocalState, type GarminLocalState } from './garmin';

const KEY = 'ration.garmin.local-state';
/** The key from before the app was renamed, moved on first read. */
const LEGACY_KEY = 'cal-track.garmin.local-state';

export async function loadLocalState(): Promise<GarminLocalState> {
  try {
    await migrateAsyncKey(LEGACY_KEY, KEY);
    return parseLocalState(await AsyncStorage.getItem(KEY));
  } catch {
    return EMPTY_LOCAL_STATE;
  }
}

/** Merges `patch` over the stored state. */
export async function saveLocalState(patch: Partial<GarminLocalState>): Promise<void> {
  const current = await loadLocalState();
  await AsyncStorage.setItem(KEY, serializeLocalState({ ...current, ...patch }));
}

export async function clearLocalState(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}
