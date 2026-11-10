// Garmin tokens live in THIS phone's secure storage (Keychain / Android Keystore via expo-secure-store) and nowhere else:
// never in Supabase, never in AsyncStorage, never in a log. Metro uses garmin-tokens.web.ts on the web, where nothing is stored.
// The logic (user binding, item layout) is in garmin-token-store.ts.
import type { GarminTokens } from '@cal/garmin';
import * as SecureStore from 'expo-secure-store';

import { createTokenStore } from './garmin-token-store';

// "After first unlock, this device only": the periodic background sync must be able to read the tokens while the phone is
// locked, and a backup or a new phone must never get them (same policy as the reference app on iOS).
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

const tokenStore = createTokenStore({
  get: (key) => SecureStore.getItemAsync(key, OPTIONS),
  set: (key, value) => SecureStore.setItemAsync(key, value, OPTIONS),
  delete: (key) => SecureStore.deleteItemAsync(key, OPTIONS),
});

export const loadGarminTokens = (userId: string): Promise<GarminTokens | null> => tokenStore.load(userId);
export const hasGarminTokens = (userId: string): Promise<boolean> => tokenStore.has(userId);
export const saveGarminTokens = (userId: string, tokens: GarminTokens): Promise<void> => tokenStore.save(userId, tokens);
export const clearGarminTokens = (): Promise<void> => tokenStore.clear();
