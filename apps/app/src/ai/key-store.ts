import * as SecureStore from 'expo-secure-store';

import type { KeyStore } from './key-store.types';

const KEY_NAME = 'cal-track.openrouter-key';

/** Native (iOS/Android) implementation. Metro uses key-store.web.ts on web. */
export const keyStore: KeyStore = {
  kind: 'secure-store',
  async load() {
    return SecureStore.getItemAsync(KEY_NAME);
  },
  async save(key) {
    await SecureStore.setItemAsync(KEY_NAME, key, {
      // Available only while unlocked and never migrated to another device or backup.
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
  async clear() {
    await SecureStore.deleteItemAsync(KEY_NAME);
  },
};
