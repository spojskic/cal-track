import type { KeyStore } from './key-store.types';

const DB_NAME = 'ration-secure';
/** The database from before the app was renamed; its two entries are copied once. */
const LEGACY_DB_NAME = 'cal-track-secure';
const STORE = 'kv';
const WRAP_KEY_ID = 'wrap-key';
const CIPHER_ID = 'openrouter-key';

interface Cipher {
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

let memoryKey: string | null = null;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let legacyCopy: Promise<void> | null = null;

/** Copies the wrap key and the encrypted API key out of the pre-rename database, then drops it. */
function ensureLegacyCopied(): Promise<void> {
  legacyCopy ??= (async () => {
    try {
      const legacy = await new Promise<IDBDatabase | null>((resolve) => {
        const req = indexedDB.open(LEGACY_DB_NAME);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      });
      if (!legacy) return;
      if (!legacy.objectStoreNames.contains(STORE)) {
        legacy.close();
        return;
      }
      const read = (id: string) =>
        new Promise<unknown>((resolve) => {
          const req = legacy.transaction(STORE, 'readonly').objectStore(STORE).get(id);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(undefined);
        });
      const wrap = await read(WRAP_KEY_ID);
      const cipher = await read(CIPHER_ID);
      legacy.close();
      if (wrap === undefined && cipher === undefined) return;
      const db = await openDb();
      if (wrap !== undefined) await idbPut(db, WRAP_KEY_ID, wrap);
      if (cipher !== undefined) await idbPut(db, CIPHER_ID, cipher);
      indexedDB.deleteDatabase(LEGACY_DB_NAME);
    } catch {
      // leaving the old database alone is harmless: the user can reconnect the key
    }
  })();
  return legacyCopy;
}

function idbGet<T>(db: IDBDatabase, id: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, id: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbDelete(db: IDBDatabase, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Non-extractable AES-GCM key: scripts can use it but cannot read its raw bytes. */
async function getWrapKey(db: IDBDatabase, create: boolean): Promise<CryptoKey | null> {
  const existing = await idbGet<CryptoKey>(db, WRAP_KEY_ID);
  if (existing) return existing;
  if (!create) return null;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  await idbPut(db, WRAP_KEY_ID, key);
  return key;
}

/**
 * Web implementation. This protects against casual disclosure (copying storage, backups) but not
 * against XSS on our own origin; keep a strict Content-Security-Policy and suggest a spend-limited key.
 */
export const keyStore: KeyStore = {
  kind: 'webcrypto-idb',

  async load() {
    if (memoryKey) return memoryKey;
    try {
      await ensureLegacyCopied();
      const db = await openDb();
      const wrapKey = await getWrapKey(db, false);
      const cipher = await idbGet<Cipher>(db, CIPHER_ID);
      if (!wrapKey || !cipher) return null;
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: cipher.iv }, wrapKey, cipher.data);
      memoryKey = new TextDecoder().decode(plain);
      return memoryKey;
    } catch {
      return null;
    }
  },

  async save(key, options) {
    memoryKey = key;
    if (options?.persist === false) {
      await this.clear().catch(() => undefined);
      memoryKey = key;
      return;
    }
    await ensureLegacyCopied();
    const db = await openDb();
    const wrapKey = await getWrapKey(db, true);
    if (!wrapKey) throw new Error('Could not create encryption key');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, new TextEncoder().encode(key));
    await idbPut(db, CIPHER_ID, { iv, data } satisfies Cipher);
  },

  async clear() {
    memoryKey = null;
    const db = await openDb();
    await idbDelete(db, CIPHER_ID);
    await idbDelete(db, WRAP_KEY_ID);
  },
};
