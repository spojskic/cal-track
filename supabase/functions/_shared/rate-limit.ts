/**
 * Postgres-backed rate limiting (see migration 20261110000011_edge_rate_limit.sql).
 *
 * Edge Function isolates are short-lived and spread over many instances, so an
 * in-memory limiter would not hold. The counter lives in Postgres instead
 * (`private.edge_rate_limits`, fixed window per user and bucket) and is
 * consumed through `public.consume_rate_limit`, which only `service_role` may
 * call. The user id is passed by the function (taken from the verified JWT),
 * never by the client, so clients cannot reset or inflate their own limit.
 */
import { StoreError, type SupabaseLike } from './food-store.ts';

/** Sentinel "user" for limits shared by every caller (e.g. OFF search is limited per server IP). */
export const GLOBAL_RATE_LIMIT_USER = '00000000-0000-0000-0000-000000000000';

/** Seconds the caller must wait; 0 means the request is allowed (and has been counted). */
export type ConsumeRateLimit = (
  userId: string,
  bucket: string,
  maxPerWindow: number,
  windowSeconds: number,
) => Promise<number>;

export function makeConsumeRateLimit(adminClient: SupabaseLike): ConsumeRateLimit {
  return async (userId, bucket, maxPerWindow, windowSeconds) => {
    const res = await adminClient.rpc('consume_rate_limit', {
      p_user_id: userId,
      p_bucket: bucket,
      p_max_per_window: maxPerWindow,
      p_window_seconds: windowSeconds,
    });
    if (res.error) throw new StoreError('consume_rate_limit', res.error);
    const wait = Number(res.data);
    if (!Number.isFinite(wait) || wait < 0) {
      throw new StoreError('consume_rate_limit', { message: 'unexpected response' });
    }
    return Math.ceil(wait);
  };
}
