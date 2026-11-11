/**
 * The friends feature of supabase/migrations/20261110000109_friends.sql as the smoke harness's mock backend answers it:
 * public.my_friend_ids(), public.my_used_food(), public.send_friend_request(), public.respond_friend_request() and
 * public.list_friendships(). The row level security that uses the first two lives in mock-backend.ts (`visible()`), the table
 * (`friendships`) in schema.ts, the ranking change of private.search_foods_ranked() in search.ts.
 *
 * The functions are SECURITY DEFINER in the real database: they read auth.users and write public.friendships without RLS or table
 * grants (a client can neither insert nor update that table). Here they work on the backend's rows through a small `FriendsEnv`, so
 * the checks, answers and messages are the ones of the SQL and a failed request rolls back with everything else.
 * Pure: no sockets, no timers, no clock (the caller passes `nowMs`).
 */
import { formatTimestamp } from './postgrest';
import type { Row } from './mock-backend';

/** A SQL exception of one of the functions: the SQLSTATE and the HTTP status PostgREST maps it to. */
export class FriendsError extends Error {
  constructor(
    readonly sqlstate: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** At most this many requests per day (send_friend_request counts the caller's rows created in the last 24 hours). */
export const DAILY_REQUEST_LIMIT = 20;

const DAY_MS = 86_400_000;

/** SQLSTATE 22023 (invalid_parameter_value): class 22 is one of PostgREST's "everything else" 400s. */
const invalid = (message: string): FriendsError => new FriendsError('22023', message, 400);

/**
 * SQLSTATE 54000 (program_limit_exceeded). PostgREST maps the whole class 54 to HTTP 500 ("too complex"), NOT to 400: only P0001
 * (a plain `raise exception`) and the class 22 / 23 / 42 codes are 400 (PostgREST docs, Errors > HTTP Status Codes). The error body is
 * still `{code: '54000', message, details: null, hint: null}`, which is what supabase-js hands to the app, so the app has to
 * recognise it by `error.code`, not by the status.
 */
const TOO_MANY_STATUS = 500;
const tooMany = (): FriendsError => new FriendsError('54000', 'too many friend requests today, try again tomorrow', TOO_MANY_STATUS);

/** The regex of the SQL: `^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$`. */
const EMAIL_RULE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** btrim(): strips spaces only (not tabs or line breaks), unlike String.trim(). */
const btrim = (text: string): string => text.replace(/^ +| +$/g, '');

export interface FriendsEnv {
  /** auth.uid() */
  uid: string;
  /** now(): the time of the request, in ms. */
  nowMs: number;
  /** The current rows of public.friendships (ask again after a `remove`: the backend replaces its array). */
  rows(): Row[];
  /** auth.users: id and e-mail. */
  users(): readonly { id: string; email: string }[];
  /** public.profiles */
  profiles(): readonly Row[];
  /** INSERT as the function owner (no grants, no RLS; column defaults and constraints apply). */
  insert(requesterId: string, addresseeId: string): void;
  /** DELETE as the function owner. */
  remove(row: Row): void;
}

export type SendAnswer = 'sent' | 'accepted' | 'already_friends' | 'already_requested';

const pairOf = (a: unknown, b: unknown): string => [String(a), String(b)].sort().join('|');

/** public.my_friend_ids(): the user ids of the accepted friends of `uid`. */
export function friendIdsOf(friendships: readonly Row[], uid: string): Set<string> {
  const out = new Set<string>();
  for (const f of friendships) {
    if (f.status !== 'accepted') continue;
    if (f.requester_id === uid) out.add(String(f.addressee_id));
    else if (f.addressee_id === uid) out.add(String(f.requester_id));
  }
  return out;
}

/**
 * public.my_used_food(): the ids of the foods `uid` already uses: a diary entry, an ingredient of one of their recipes, an item of one
 * of their saved meals, a favourite. `table` gives the current rows of a table.
 */
export function usedFoodIdsOf(table: (name: string) => readonly Row[], uid: string): Set<string> {
  const used = new Set<string>();
  for (const d of table('diary_entries')) if (d.user_id === uid) used.add(String(d.food_id));
  const myRecipes = new Set(table('recipes').filter((r) => r.user_id === uid).map((r) => String(r.food_id)));
  for (const i of table('recipe_ingredients')) if (myRecipes.has(String(i.recipe_food_id))) used.add(String(i.ingredient_food_id));
  const myMeals = new Set(table('saved_meals').filter((m) => m.user_id === uid).map((m) => String(m.id)));
  for (const i of table('saved_meal_items')) if (myMeals.has(String(i.saved_meal_id))) used.add(String(i.food_id));
  for (const f of table('favorites')) if (f.user_id === uid) used.add(String(f.food_id));
  return used;
}

/** public.send_friend_request(p_email) */
export function sendFriendRequest(env: FriendsEnv, rawEmail: unknown): SendAnswer {
  const email = btrim(typeof rawEmail === 'string' ? rawEmail : rawEmail === null || rawEmail === undefined ? '' : String(rawEmail)).toLowerCase();
  if ([...email].length > 254 || !EMAIL_RULE.test(email)) throw invalid('that is not a valid e-mail address');

  const other = env.users().find((u) => u.email.toLowerCase() === email)?.id ?? null;
  if (other === env.uid) throw invalid('that is your own e-mail address');
  // The same answer as for an account that exists: this cannot be used to look up who is here. (It leaves no row behind, which
  // list_friendships and a REST read of friendships do show for an existing account.)
  if (other === null) return 'sent';

  const pair = pairOf(env.uid, other);
  const row = env.rows().find((f) => pairOf(f.requester_id, f.addressee_id) === pair);
  if (row) {
    if (row.status === 'accepted') return 'already_friends';
    if (row.requester_id === env.uid) return 'already_requested';
    // They had already asked you: asking back accepts.
    row.status = 'accepted';
    row.responded_at = formatTimestamp(env.nowMs);
    return 'accepted';
  }

  // Counts the rows that still exist: a request that was cancelled or declined (deleted) no longer counts.
  const recent = env.rows().filter((f) => f.requester_id === env.uid && Date.parse(String(f.created_at)) > env.nowMs - DAY_MS).length;
  if (recent >= DAILY_REQUEST_LIMIT) throw tooMany();

  env.insert(env.uid, other);
  return 'sent';
}

/** public.respond_friend_request(p_id, p_accept): true when there was a pending request addressed to the caller. A NULL p_accept declines. */
export function respondFriendRequest(env: FriendsEnv, id: string | null, accept: boolean): boolean {
  const row = env.rows().find((f) => f.id === id && f.addressee_id === env.uid && f.status === 'pending');
  if (!row) return false;
  if (accept) {
    row.status = 'accepted';
    row.responded_at = formatTimestamp(env.nowMs);
  } else {
    env.remove(row);
  }
  return true;
}

/** public.list_friendships(): both kinds of rows with the other person's name and e-mail, newest first. */
export function listFriendships(env: FriendsEnv): Row[] {
  const users = new Map(env.users().map((u) => [u.id, u] as const));
  const names = new Map(env.profiles().map((p) => [String(p.user_id), typeof p.display_name === 'string' ? btrim(p.display_name) : ''] as const));
  return env
    .rows()
    .filter((f) => f.requester_id === env.uid || f.addressee_id === env.uid)
    .sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))
    .flatMap((f): Row[] => {
      const outgoing = f.requester_id === env.uid;
      const other = users.get(String(outgoing ? f.addressee_id : f.requester_id));
      if (!other) return []; // the join with auth.users
      return [
        {
          id: f.id,
          status: f.status,
          direction: outgoing ? 'outgoing' : 'incoming',
          user_id: other.id,
          display_name: names.get(other.id) || (other.email.split('@')[0] ?? ''),
          email: other.email,
          created_at: f.created_at,
          responded_at: f.responded_at,
        },
      ];
    });
}

export interface RowsPage {
  rows: Row[];
  /** Rows that matched the filters, before limit / offset (what `Prefer: count=exact` reports). */
  total: number;
  /** Query parameters the mock does not emulate (reported as harness warnings). */
  unsupported: string[];
}

/**
 * What PostgREST does with the query string of a call to a function that returns a table: `<column>=eq.<v>` / `neq.<v>` filters on
 * `filterable` columns, `order`, `limit` and `offset`. The rest is reported.
 */
export function pageRows(all: readonly Row[], params: URLSearchParams, filterable: readonly string[]): RowsPage {
  const unsupported: string[] = [];
  let rows = [...all];
  let order: { column: string; desc: boolean }[] = [];
  let limit = Number.POSITIVE_INFINITY;
  let offset = 0;
  for (const [key, value] of params.entries()) {
    if (key === 'order') {
      order = value.split(',').map((term) => {
        const [column = '', direction = 'asc'] = term.split('.');
        return { column, desc: direction === 'desc' };
      });
    } else if (key === 'limit') {
      limit = Number(value);
    } else if (key === 'offset') {
      offset = Number(value);
    } else if (filterable.includes(key)) {
      const m = /^(eq|neq)\.(.*)$/.exec(value);
      if (m) rows = rows.filter((r) => (String(r[key]) === m[2]) === (m[1] === 'eq'));
      else unsupported.push(`${key}=${value}`);
    } else {
      unsupported.push(`${key}=${value}`);
    }
  }
  if (order.length > 0) {
    rows.sort((a, b) => {
      for (const { column, desc } of order) {
        const x = String(a[column] ?? '');
        const y = String(b[column] ?? '');
        if (x !== y) return (x < y ? -1 : 1) * (desc ? -1 : 1);
      }
      return 0;
    });
  }
  const total = rows.length;
  const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const end = Number.isFinite(limit) ? start + Math.max(0, limit) : undefined;
  return { rows: rows.slice(start, end), total, unsupported };
}
