/**
 * Supabase adapters for the Garmin Edge Functions: thin wrappers over the service-role-only RPCs of migration
 * 20261110000013_garmin_integration.sql. Only the tiny {@link SupabaseLike} surface is needed, so unit tests pass fakes
 * (or a PGlite-backed object) and the function entry points pass the real service-role client.
 */
import { asRecord } from './http.ts';
import { StoreError, type SupabaseLike } from './food-store.ts';
import type { MappedHealth } from './garmin-push.ts';
import type { ReturnKind } from './garmin-oauth.ts';

export interface GarminConnectionRecord {
  userId: string;
  garminUserId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  refreshExpiresAt: string | null;
}

export interface SaveConnectionInput {
  userId: string;
  garminUserId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  refreshExpiresAt: string | null;
  scopes: string[];
}

export interface ConsumedOAuthState {
  userId: string;
  codeVerifier: string;
  returnKind: ReturnKind;
}

export interface DeleteSummary {
  connection: number;
  oauth_states: number;
  push_events: number;
  daily_energy: number;
  exercise_entries: number;
  biometrics: number;
}

export interface ApplyCounts {
  energy: number;
  exercises: number;
  biometrics: number;
}

/** Another Cal Track user already linked this Garmin account (unique garmin_user_id). */
export class GarminAccountInUseError extends Error {
  constructor() {
    super('garmin account already linked to another user');
    this.name = 'GarminAccountInUseError';
  }
}

export interface GarminStore {
  createOAuthState(input: {
    state: string;
    userId: string;
    codeVerifier: string;
    returnKind: ReturnKind;
    ttlSeconds: number;
  }): Promise<void>;
  /** Single use: the state is deleted whether or not it is still fresh; null when unknown / expired. */
  consumeOAuthState(state: string, ttlSeconds: number): Promise<ConsumedOAuthState | null>;
  saveConnection(input: SaveConnectionInput): Promise<void>;
  getConnection(query: {
    userId?: string;
    garminUserId?: string;
    accessToken?: string;
  }): Promise<GarminConnectionRecord | null>;
  touchConnection(userId: string, ok: boolean, error?: string): Promise<void>;
  deleteConnection(userId: string, deleteData: boolean): Promise<DeleteSummary>;
  recordPushEvents(
    userId: string,
    garminUserId: string,
    events: ReadonlyArray<{ kind: string; payload: unknown }>,
  ): Promise<number[]>;
  finishPushEvents(ids: readonly number[], error: string | null): Promise<void>;
  applyHealth(
    userId: string,
    mapped: Pick<MappedHealth, 'energy' | 'exercises' | 'biometrics'>,
  ): Promise<ApplyCounts>;
  purge(): Promise<void>;
}

const asString = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const asCount = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function makeGarminStore(admin: SupabaseLike): GarminStore {
  const call = async (fn: string, args: Record<string, unknown>): Promise<unknown> => {
    const res = await admin.rpc(fn, args);
    if (res.error) throw new StoreError(fn, res.error);
    return res.data;
  };

  return {
    async createOAuthState(i) {
      await call('garmin_oauth_state_create', {
        p_state: i.state,
        p_user_id: i.userId,
        p_code_verifier: i.codeVerifier,
        p_return_kind: i.returnKind,
        p_ttl_seconds: i.ttlSeconds,
      });
    },

    async consumeOAuthState(state, ttlSeconds) {
      const data = await call('garmin_oauth_state_consume', {
        p_state: state,
        p_ttl_seconds: ttlSeconds,
      });
      const row = asRecord(Array.isArray(data) ? data[0] : data);
      const userId = asString(row?.user_id);
      const codeVerifier = asString(row?.code_verifier);
      if (!row || !userId || !codeVerifier) return null;
      return { userId, codeVerifier, returnKind: row.return_kind === 'web' ? 'web' : 'native' };
    },

    async saveConnection(i) {
      try {
        await call('garmin_connection_save', {
          p_user_id: i.userId,
          p_garmin_user_id: i.garminUserId,
          p_access_token: i.accessToken,
          p_refresh_token: i.refreshToken,
          p_expires_at: i.expiresAt,
          p_refresh_expires_at: i.refreshExpiresAt,
          p_scopes: i.scopes,
        });
      } catch (err) {
        if (err instanceof StoreError && err.code === '23505') throw new GarminAccountInUseError();
        throw err;
      }
    },

    async getConnection(query) {
      const data = await call('garmin_connection_get', {
        p_user_id: query.userId ?? null,
        p_garmin_user_id: query.garminUserId ?? null,
        p_access_token: query.accessToken ?? null,
      });
      const row = asRecord(Array.isArray(data) ? data[0] : data);
      const userId = asString(row?.user_id);
      const garminUserId = asString(row?.garmin_user_id);
      const accessToken = asString(row?.access_token);
      if (!row || !userId || !garminUserId || !accessToken) return null;
      return {
        userId,
        garminUserId,
        accessToken,
        refreshToken: asString(row.refresh_token),
        expiresAt: asString(row.expires_at),
        refreshExpiresAt: asString(row.refresh_expires_at),
      };
    },

    async touchConnection(userId, ok, error) {
      await call('garmin_connection_touch', {
        p_user_id: userId,
        p_ok: ok,
        p_error: error ?? null,
      });
    },

    async deleteConnection(userId, deleteData) {
      const data = asRecord(
        await call('garmin_connection_delete', { p_user_id: userId, p_delete_data: deleteData }),
      );
      return {
        connection: asCount(data?.connection),
        oauth_states: asCount(data?.oauth_states),
        push_events: asCount(data?.push_events),
        daily_energy: asCount(data?.daily_energy),
        exercise_entries: asCount(data?.exercise_entries),
        biometrics: asCount(data?.biometrics),
      };
    },

    async recordPushEvents(userId, garminUserId, events) {
      const data = await call('garmin_push_events_record', {
        p_user_id: userId,
        p_garmin_user_id: garminUserId,
        p_events: events,
      });
      return Array.isArray(data) ? data.map(Number).filter(Number.isFinite) : [];
    },

    async finishPushEvents(ids, error) {
      if (ids.length === 0) return;
      await call('garmin_push_events_finish', { p_ids: [...ids], p_error: error });
    },

    async applyHealth(userId, mapped) {
      const data = asRecord(
        await call('apply_garmin_health', {
          p_user_id: userId,
          p_energy: mapped.energy,
          p_exercises: mapped.exercises,
          p_biometrics: mapped.biometrics,
        }),
      );
      return {
        energy: asCount(data?.energy),
        exercises: asCount(data?.exercises),
        biometrics: asCount(data?.biometrics),
      };
    },

    async purge() {
      await call('purge_garmin_data', {});
    },
  };
}
