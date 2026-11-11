import * as SecureStore from 'expo-secure-store';

import type { KeyStore } from './key-store.types';

const KEY_NAME = 'ration.openrouter-key';
/** The key name from before the app was renamed, moved on first read. */
const LEGACY_KEY_NAME = 'cal-track.openrouter-key';
// Available only while unlocked and never migrated to another device or backup.
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

async function migrateLegacyKey(): Promise<string | null> {
  try {
    const legacy = await SecureStore.getItemAsync(LEGACY_KEY_NAME);
    if (legacy === null) return null;
    await SecureStore.setItemAsync(KEY_NAME, legacy, OPTIONS);
    await SecureStore.deleteItemAsync(LEGACY_KEY_NAME);
    return legacy;
  } catch {
    return null;
  }
}

/** Native (iOS/Android) implementation. Metro uses key-store.web.ts on web. */
export const keyStore: KeyStore = {
  kind: 'secure-store',
  async load() {
    const current = await SecureStore.getItemAsync(KEY_NAME);
    if (current !== null) return current;
    return migrateLegacyKey();
  },
  async save(key) {
    await SecureStore.setItemAsync(KEY_NAME, key, OPTIONS);
  },
  async clear() {
    await SecureStore.deleteItemAsync(KEY_NAME);
  },
};
