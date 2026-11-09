/**
 * Supabase adapters for the Edge Functions. They only need the tiny client
 * surface declared in {@link SupabaseLike}, so unit tests can pass fakes and
 * `index.ts` passes the real `@supabase/supabase-js` client (cast).
 */
import type { BuiltFood } from './food-row.ts';
import { asRecord } from './http.ts';

export interface SupabaseError {
  message: string;
  code?: string;
}

export interface SupabaseResult<T> {
  data: T | null;
  error: SupabaseError | null;
}

/** Thenable query builder (`from(...).select(...).eq(...).order(...)`). */
export interface QueryLike extends PromiseLike<SupabaseResult<unknown[]>> {
  select(columns: string): QueryLike;
  eq(column: string, value: unknown): QueryLike;
  order(column: string, options?: { ascending?: boolean }): QueryLike;
}

export interface SupabaseLike {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<SupabaseResult<unknown>>;
  from(table: string): QueryLike;
}

export type FoodRecord = Record<string, unknown> & { id: string };
export type PortionRecord = Record<string, unknown>;

export interface StoredFood {
  food: FoodRecord;
  portions: PortionRecord[];
}

export interface UpsertResult extends StoredFood {
  /** inserted | unchanged | updated | superseded (see migration 12) */
  action?: string;
}

/** A failed database call; the message is for logs, never shown to clients. */
export class StoreError extends Error {
  readonly code?: string;
  constructor(operation: string, error: SupabaseError) {
    super(`${operation} failed: ${error.message}`);
    this.name = 'StoreError';
    this.code = error.code;
  }
}

/** Drops the generated search columns (tsvector noise) from a foods row. */
export function stripSearchColumns(row: Record<string, unknown>): FoodRecord {
  const { search: _search, search_text: _searchText, ...rest } = row;
  return rest as FoodRecord;
}

const PORTION_COLUMNS = 'id,label,amount,unit,grams,sort_order';

/**
 * Local lookup as the SIGNED-IN USER (RLS applies): `get_food_by_gtin` returns
 * the best visible food for a barcode, then its portions are read.
 */
export function makeLocalLookup(userClient: SupabaseLike) {
  return async (gtin14: string): Promise<StoredFood | null> => {
    const found = await userClient.rpc('get_food_by_gtin', { gtin: gtin14 });
    if (found.error) throw new StoreError('get_food_by_gtin', found.error);
    const row = Array.isArray(found.data) ? found.data[0] : found.data;
    const record = asRecord(row);
    if (!record || typeof record.id !== 'string') return null;

    const portions = await userClient
      .from('food_portions')
      .select(PORTION_COLUMNS)
      .eq('food_id', record.id)
      .order('sort_order', { ascending: true });
    if (portions.error) throw new StoreError('food_portions select', portions.error);
    return {
      food: stripSearchColumns(record),
      portions: (portions.data ?? []) as PortionRecord[],
    };
  };
}

/**
 * Saves a built food with the SERVICE ROLE client through the
 * `upsert_branded_food` RPC (migration 20261110000012), which performs the
 * `insert ... on conflict (source, source_id) where source_id is not null and
 * owner_id is null` upsert, the referenced-food handling and the portion
 * replacement in one transaction. (PostgREST's `upsert` cannot be used: the
 * unique index is partial and `on_conflict` cannot carry its predicate.)
 */
export function makeUpsertFood(adminClient: SupabaseLike) {
  return async (built: BuiltFood): Promise<UpsertResult> => {
    const res = await adminClient.rpc('upsert_branded_food', {
      p_food: built.food,
      p_portions: built.portions,
    });
    if (res.error) throw new StoreError('upsert_branded_food', res.error);
    const out = asRecord(res.data);
    const food = asRecord(out?.food);
    if (!out || !food || typeof food.id !== 'string') {
      throw new StoreError('upsert_branded_food', { message: 'unexpected response shape' });
    }
    return {
      action: typeof out.action === 'string' ? out.action : undefined,
      food: stripSearchColumns(food),
      portions: Array.isArray(out.portions) ? (out.portions as PortionRecord[]) : [],
    };
  };
}
