// Where the Garmin tokens are kept, as logic over an injected secret store (the phone's Keychain / Keystore in the app, a Map in
// tests). Pure: imports nothing from react-native / expo.
//
// Four small items instead of one JSON blob (an access token alone is over a kilobyte, and some platforms refuse large values):
// the access token, the refresh token, the client id the tokens were issued for, and the Ration user they belong to.
// Tokens of another Ration user on the same phone are never handed out.
import { isGarminTokens, type GarminTokens } from '@ration/garmin';

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const TOKEN_KEYS = {
  access: 'ration.garmin.di-token',
  refresh: 'ration.garmin.di-refresh-token',
  client: 'ration.garmin.di-client-id',
  user: 'ration.garmin.user-id',
} as const;

/** The same items under the names used before the app was renamed. */
export const LEGACY_TOKEN_KEYS = {
  access: 'cal-track.garmin.di-token',
  refresh: 'cal-track.garmin.di-refresh-token',
  client: 'cal-track.garmin.di-client-id',
  user: 'cal-track.garmin.user-id',
} as const;

/**
 * Moves a Garmin link saved before the rename to the current keys. Best effort and idempotent: an existing new value wins, and
 * a failed move leaves the old value for the next attempt.
 */
export async function migrateLegacyTokens(store: SecretStore): Promise<void> {
  for (const field of ['user', 'access', 'refresh', 'client'] as const) {
    try {
      if ((await store.get(TOKEN_KEYS[field])) !== null) continue;
      const value = await store.get(LEGACY_TOKEN_KEYS[field]);
      if (value === null) continue;
      await store.set(TOKEN_KEYS[field], value);
      await store.delete(LEGACY_TOKEN_KEYS[field]);
    } catch {
      // the token store reports failures to the caller; a missing link just asks the user to connect again
    }
  }
}

export interface GarminTokenStore {
  /** The tokens of `userId` on this phone, or null (none stored, or they belong to another user, or they are unreadable). */
  load(userId: string): Promise<GarminTokens | null>;
  has(userId: string): Promise<boolean>;
  /** Saves a (new or rotated) pair. Throws when the platform refuses: the caller must treat that as a failure. */
  save(userId: string, tokens: GarminTokens): Promise<void>;
  clear(): Promise<void>;
}

export function createTokenStore(store: SecretStore): GarminTokenStore {
  const load = async (userId: string): Promise<GarminTokens | null> => {
    const [owner, diToken, diRefreshToken, diClientId] = await Promise.all([
      store.get(TOKEN_KEYS.user),
      store.get(TOKEN_KEYS.access),
      store.get(TOKEN_KEYS.refresh),
      store.get(TOKEN_KEYS.client),
    ]);
    if (owner !== userId) return null;
    const tokens = { diToken, diRefreshToken, diClientId };
    return isGarminTokens(tokens) ? tokens : null;
  };
  return {
    load,
    has: async (userId) => (await load(userId)) !== null,
    async save(userId, tokens) {
      // The refresh token first: if a later write fails, the pair that can still renew itself is already stored.
      await store.set(TOKEN_KEYS.refresh, tokens.diRefreshToken);
      await store.set(TOKEN_KEYS.client, tokens.diClientId);
      await store.set(TOKEN_KEYS.access, tokens.diToken);
      await store.set(TOKEN_KEYS.user, userId);
    },
    async clear() {
      await Promise.all(Object.values(TOKEN_KEYS).map((key) => store.delete(key)));
    },
  };
}
