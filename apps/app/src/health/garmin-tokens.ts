// Garmin tokens live in THIS phone's secure storage (Keychain / Android Keystore via expo-secure-store) and nowhere else:
// never in Supabase, never in AsyncStorage, never in a log. Metro uses garmin-tokens.web.ts on the web, where nothing is stored.
// The logic (user binding, item layout) is in garmin-token-store.ts.
import type { GarminTokens } from '@cal/garmin';
import * as SecureStore from 'expo-secure-store';

import { createTokenStore, migrateLegacyTokens } from './garmin-token-store';

// "After first unlock, this device only": the periodic background sync must be able to read the tokens while the phone is
// locked, and a backup or a new phone must never get them (same policy as the reference app on iOS).
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

const secretStore = {
  get: (key: string) => SecureStore.getItemAsync(key, OPTIONS),
  set: (key: string, value: string) => SecureStore.setItemAsync(key, value, OPTIONS),
  delete: (key: string) => SecureStore.deleteItemAsync(key, OPTIONS),
};

const tokenStore = createTokenStore(secretStore);

let migration: Promise<void> | null = null;
/** Runs once: a link saved under the pre-rename key names is moved before it is read or overwritten. */
const migrated = (): Promise<void> => (migration ??= migrateLegacyTokens(secretStore));

export const loadGarminTokens = async (userId: string): Promise<GarminTokens | null> => {
  await migrated();
  return tokenStore.load(userId);
};
export const hasGarminTokens = async (userId: string): Promise<boolean> => {
  await migrated();
  return tokenStore.has(userId);
};
export const saveGarminTokens = async (userId: string, tokens: GarminTokens): Promise<void> => {
  await migrated();
  return tokenStore.save(userId, tokens);
};
export const clearGarminTokens = async (): Promise<void> => {
  await migrated();
  return tokenStore.clear();
};
