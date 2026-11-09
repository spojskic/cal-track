/**
 * Device-only storage for the user's OpenRouter API key.
 * The key is NEVER sent to our backend, logged, or synced.
 *  - iOS/Android: Keychain / Keystore via expo-secure-store (this device only, not in backups).
 *  - Web: AES-GCM ciphertext in IndexedDB with a NON-EXTRACTABLE WebCrypto key (also in IndexedDB),
 *    or memory-only when the user opts out of "remember on this device".
 */
export interface KeyStore {
  readonly kind: 'secure-store' | 'webcrypto-idb';
  /** Returns the stored key, or null. */
  load(): Promise<string | null>;
  /** Saves the key. `persist: false` keeps it in memory only (web "session only" mode). */
  save(key: string, options?: { persist?: boolean }): Promise<void>;
  /** Removes the key everywhere. */
  clear(): Promise<void>;
}
