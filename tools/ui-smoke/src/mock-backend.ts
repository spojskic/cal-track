/**
 * In-memory PostgREST + GoTrue emulator for the Ration smoke harness.
 *
 * `createMockBackend(seed).handle({ method, url, headers, body })` answers exactly like the Supabase REST API
 * would for the queries supabase-js v2 sends: select with embedding, filters, ordering, pagination, counts,
 * single-object responses, insert / upsert / update / delete with `Prefer` semantics, RPCs, a handful of
 * GoTrue endpoints and the Edge Functions gateway (404 `not_deployed`, except `sign-up`, which has its own mock in
 * signup-function.ts). Pure: no sockets, no timers.
 *
 * Fidelity beyond the happy path is deliberate: unknown columns (42703 / PGRST204), invalid uuids (22P02),
 * CHECK / NOT NULL / FK / unique violations, simplified RLS (`user_id = auth.uid()`, plus what friends may read: see
 * `visible()`), table grants (a client cannot insert into `friendships`), "UPDATE requires a WHERE
 * clause" (Supabase enables pg-safeupdate) and the foods immutability trigger behave like the real database,
 * so queries that cannot work against the real schema fail here too.
 */
import { ANON_KEY, FIXED_NOW_MS } from './constants';
import {
  PgError,
  coerceValue,
  findRelationship,
  formatTimestamp,
  applyEmbedParams,
  matches,
  parseFilters,
  parseOrder,
  parsePrefer,
  parseSelect,
  planSelect,
  sortRows,
  validateRow,
  type Filter,
  type PlanNode,
  type Prefer,
} from './postgrest';
import { SCHEMA, CLIENT_RPCS, SERVICE_ONLY_RPCS, starColumns, type ColumnDef, type FkDef, type TableDef } from './schema';
import { searchFoods, searchTextOf } from './search';
import { authUserJson, buildSession, decodeJwt, stableUuid, type MockUser } from './session';
import {
  INVITES_TABLE,
  InviteAdminError,
  createInvite,
  createInviteFor,
  listInvites,
  listInvitesWithEmail,
  pageInvites,
  revokeInvite,
  seedInvites,
} from './invite-admin';
import { SignUpFunctionMock } from './signup-function';
import { SendInviteFunctionMock } from './send-invite-function';
import { FriendRequestFunctionMock, type FriendRequestHost } from './friend-request-function';
import { classifyFriendRequestError } from '../../../supabase/functions/_shared/friend-request-store.ts';
import {
  FriendsError,
  friendIdsOf,
  listFriendships,
  pageRows,
  respondFriendRequest,
  sendFriendRequest,
  usedFoodIdsOf,
  type FriendsEnv,
} from './friends';

export type Row = Record<string, unknown>;

export interface MockSeed {
  users: MockUser[];
  /** Rows per table. Defaults, coercion and constraints apply; FK integrity is verified after seeding. */
  tables: Record<string, Row[]>;
  /** Milliseconds used as "now" for defaults (default FIXED_NOW_MS). */
  nowMs?: number;
}

export interface MockRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | null;
}

export interface MockResponse {
  status: number;
  headers: Record<string, string>;
  /** JSON text (or empty). */
  body: string;
}

export interface CallRecord {
  seq: number;
  method: string;
  path: string;
  query: string;
  status: number;
  kind: 'rest' | 'rpc' | 'auth' | 'function' | 'other';
  /** Table, rpc name, auth endpoint or function name. */
  target: string;
  error?: string;
}

export interface MutationRecord {
  seq: number;
  table: string;
  op: 'insert' | 'upsert' | 'update' | 'delete' | 'rpc' | 'function';
  payload: unknown;
  /** Raw query string of the request (filters). */
  filter: string;
  /** Rows affected (returned by the RPC for op 'rpc': 0). */
  rows: number;
  ok: boolean;
  status: number;
  error?: string;
}

export interface UnhandledRecord {
  seq: number;
  method: string;
  path: string;
  reason: string;
}

export interface MockBackend {
  handle(req: MockRequest): MockResponse;
  readonly calls: CallRecord[];
  readonly mutations: MutationRecord[];
  readonly unhandled: UnhandledRecord[];
  /** Features of the request that the mock does not emulate (extend postgrest.ts). */
  readonly warnings: string[];
  readonly userId: string;
  /** Current rows of a table (daily_totals is computed). Do not mutate. */
  rows(table: string): Row[];
  /** Committed (ok) mutations, optionally filtered. */
  mutationsOf(table: string, op?: MutationRecord['op']): MutationRecord[];
  /** FK / unique problems in the current data (empty = consistent). */
  integrityErrors(): string[];
  /** Slots used so far of an invite code of the `sign-up` function (see signup-function.ts). */
  inviteUses(code: string): number;
}

const CORS_ALLOW_HEADERS =
  'apikey, authorization, content-type, prefer, accept, accept-profile, content-profile, x-client-info, range, range-unit, x-supabase-api-version, x-retry-count';
const CORS_EXPOSE = 'Content-Range, Content-Location, Location, Preference-Applied, X-Total-Count, Retry-After, WWW-Authenticate';

const JSON_CT = 'application/json; charset=utf-8';
const OBJECT_CT = 'application/vnd.pgrst.object+json; charset=utf-8';

interface Ctx {
  uid: string | null;
  role: 'authenticated' | 'anon';
  tokenError?: PgError;
}

interface WriteResult {
  rows: Row[];
  /** Rows (post-image) to return with return=representation. */
  returned: Row[];
}

// ----------------------------------------------------------------------------- helpers

const clone = <T>(v: T): T => structuredClone(v);

const keyPart = (v: unknown): string => (typeof v === 'string' ? v.toLowerCase() : typeof v === 'number' ? String(v) : JSON.stringify(v));

function keyOf(row: Row, cols: readonly string[]): string | null {
  const parts: string[] = [];
  for (const c of cols) {
    const v = row[c];
    if (v === null || v === undefined) return null;
    parts.push(keyPart(v));
  }
  return parts.join('\u0001');
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}, contentType = JSON_CT): MockResponse {
  return { status, headers: { 'content-type': contentType, ...headers }, body: JSON.stringify(body) };
}

function emptyResponse(status: number, headers: Record<string, string> = {}): MockResponse {
  return { status, headers: { ...headers }, body: '' };
}

const rls = (table: string, anon: boolean): PgError =>
  anon
    ? new PgError(401, '42501', `permission denied for table ${table}`)
    : new PgError(403, '42501', `new row violates row-level security policy for table "${table}"`);

/** RPCs that change data: the successful and failed calls are recorded in `mutations` as table `rpc:<name>`, op 'rpc'. */
const MUTATING_RPCS: ReadonlySet<string> = new Set([
  'supersede_food',
  'delete_all_my_coach_data',
  'admin_create_invite_code',
  'admin_create_invite_code_for',
  'admin_revoke_invite_code',
  'send_friend_request',
  'respond_friend_request',
]);

// ----------------------------------------------------------------------------- implementation

class MockBackendImpl implements MockBackend {
  readonly calls: CallRecord[] = [];
  readonly mutations: MutationRecord[] = [];
  readonly unhandled: UnhandledRecord[] = [];
  readonly warnings: string[] = [];
  readonly userId: string;

  private tables = new Map<string, Row[]>();
  private readonly users = new Map<string, MockUser>();
  private readonly refreshTokens = new Map<string, string>();
  private readonly signUps = new SignUpFunctionMock();
  private readonly sendInvites = new SendInviteFunctionMock();
  private readonly friendRequests = new FriendRequestFunctionMock();
  private readonly nowBase: number;
  private tick = 0;
  private seq = 0;
  private uuidCounter = 0;
  private inviteSeq = 0;
  private serials = new Map<string, number>();
  private indexCache = new Map<string, Map<string, Row[]>>();
  /** public.my_friend_ids() / public.my_used_food() per user. Both are STABLE functions: one answer for the whole statement. */
  private accessCache = new Map<string, ReadonlySet<string>>();
  private txMs = 0;

  constructor(seed: MockSeed) {
    this.nowBase = seed.nowMs ?? FIXED_NOW_MS;
    this.txMs = this.nowBase;
    for (const u of seed.users) this.users.set(u.id, u);
    this.userId = seed.users[0]?.id ?? '';
    for (const name of Object.keys(SCHEMA)) this.tables.set(name, []);
    // private.invite_codes: not a public table, so it is not in SCHEMA; kept here so snapshot / restore cover it.
    this.tables.set(INVITES_TABLE, seedInvites(this.nowBase));

    for (const [name, rows] of Object.entries(seed.tables)) {
      const def = SCHEMA[name];
      if (!def) throw new Error(`Invalid seed: unknown table "${name}"`);
      if (def.virtual) throw new Error(`Invalid seed: "${name}" is computed and cannot be seeded`);
      for (const [i, input] of rows.entries()) {
        try {
          const row = this.buildRow(def, input, { missingDefault: true, ctx: null, seed: true });
          this.unique(def, row, null);
          this.table(name).push(row);
        } catch (e) {
          const msg = e instanceof PgError ? `${e.body.code} ${e.body.message} ${e.body.details ?? ''}` : String(e);
          throw new Error(`Invalid seed: ${name}[${i}]: ${msg}`);
        }
      }
    }
    const problems = this.integrityErrors();
    if (problems.length > 0) throw new Error(`Invalid seed: ${problems.slice(0, 12).join('; ')}${problems.length > 12 ? ` (+${problems.length - 12} more)` : ''}`);
  }

  // ------------------------------------------------------------------- public API

  rows(table: string): Row[] {
    return this.rowsOf(table);
  }

  mutationsOf(table: string, op?: MutationRecord['op']): MutationRecord[] {
    return this.mutations.filter((m) => m.ok && m.table === table && (op === undefined || m.op === op));
  }

  integrityErrors(): string[] {
    const problems: string[] = [];
    for (const def of Object.values(SCHEMA)) {
      if (def.virtual) continue;
      for (const row of this.table(def.name)) {
        for (const fk of def.fks) {
          if (!this.fkSatisfied(fk, row)) {
            problems.push(`${def.name}(${fk.cols.map((c) => `${c}=${String(row[c])}`).join(', ')}) -> ${fk.ref} missing (${fk.name})`);
          }
        }
      }
    }
    return problems;
  }

  handle(req: MockRequest): MockResponse {
    this.seq += 1;
    this.tick += 1;
    this.txMs = this.nowBase + this.tick;
    this.touch();
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return this.finish(req, null, jsonResponse(400, { message: `Invalid URL ${req.url}` }), 'other', req.url);
    }
    const method = req.method.toUpperCase();
    const origin = lowerHeaders(req.headers).origin;

    if (method === 'OPTIONS') {
      const requested = lowerHeaders(req.headers)['access-control-request-headers'];
      const res = emptyResponse(204, { 'access-control-max-age': '86400' });
      res.headers['access-control-allow-headers'] = requested ? `${CORS_ALLOW_HEADERS}, ${requested}` : CORS_ALLOW_HEADERS;
      return this.finish(req, url, this.withCors(res, origin), 'other', 'OPTIONS');
    }

    const headers = lowerHeaders(req.headers);
    const path = url.pathname;
    let kind: CallRecord['kind'] = 'other';
    let target = path;
    let response: MockResponse;
    try {
      if (path.startsWith('/auth/v1/')) {
        kind = 'auth';
        target = path.slice('/auth/v1'.length);
        response = this.auth(method, target, url, headers, req.body ?? null);
      } else if (path.startsWith('/rest/v1/')) {
        const rest = decodeURIComponent(path.slice('/rest/v1/'.length));
        if (rest.startsWith('rpc/')) {
          kind = 'rpc';
          target = rest.slice(4);
        } else {
          kind = 'rest';
          target = rest;
        }
        response = this.rest(method, rest, url, headers, req.body ?? null);
      } else if (path.startsWith('/functions/v1/')) {
        kind = 'function';
        target = path.slice('/functions/v1/'.length);
        response =
          target === 'sign-up'
            ? this.signUpFunction(method, req.body ?? null)
            : target === 'send-invite'
              ? this.sendInviteFunction(method, req.body ?? null, headers)
              : target === 'friend-request'
                ? this.friendRequestFunction(method, req.body ?? null, headers)
                : jsonResponse(404, { code: 'NOT_FOUND', message: 'Requested function was not found', error: 'not_deployed' });
        // The two e-mail functions change data (a code, a friendship row): recorded like a mutation, so the
        // scenarios can assert on them (and on the ABSENCE of them after a refused form).
        if (target === 'send-invite' || target === 'friend-request') {
          let payload: unknown = null;
          try {
            payload = req.body ? (JSON.parse(req.body) as unknown) : null;
          } catch {
            payload = null;
          }
          this.mutations.push({
            seq: this.seq,
            table: `function:${target}`,
            op: 'function',
            payload,
            filter: '',
            rows: response.status < 400 ? 1 : 0,
            ok: response.status < 400,
            status: response.status,
          });
        }
      } else {
        this.unhandled.push({ seq: this.seq, method, path, reason: 'endpoint not emulated' });
        response = jsonResponse(404, { message: `Mock backend has no handler for ${method} ${path}`, error: 'not_found' });
      }
    } catch (e) {
      response = this.errorResponse(e, method, path);
    }
    return this.finish(req, url, this.withCors(response, origin), kind, target);
  }

  // ------------------------------------------------------------------- bookkeeping

  private finish(req: MockRequest, url: URL | null, res: MockResponse, kind: CallRecord['kind'], target: string): MockResponse {
    let error: string | undefined;
    if (res.status >= 400 && res.body) {
      try {
        const parsed = JSON.parse(res.body) as Record<string, unknown>;
        error = String(parsed.code ?? parsed.error_code ?? parsed.error ?? '') + (parsed.message ?? parsed.msg ? `: ${String(parsed.message ?? parsed.msg)}` : '');
      } catch {
        error = res.body.slice(0, 200);
      }
    }
    this.calls.push({
      seq: this.seq,
      method: req.method.toUpperCase(),
      path: url?.pathname ?? req.url,
      query: url?.search ?? '',
      status: res.status,
      kind,
      target,
      ...(error ? { error } : {}),
    });
    return res;
  }

  private withCors(res: MockResponse, origin: string | undefined): MockResponse {
    const headers: Record<string, string> = {
      ...res.headers,
      'access-control-allow-origin': origin ?? '*',
      'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS, HEAD',
      'access-control-expose-headers': CORS_EXPOSE,
      vary: 'Origin',
    };
    if (!('access-control-allow-headers' in headers)) headers['access-control-allow-headers'] = CORS_ALLOW_HEADERS;
    if (origin) headers['access-control-allow-credentials'] = 'true';
    return { ...res, headers };
  }

  private errorResponse(e: unknown, method: string, path: string): MockResponse {
    if (e instanceof PgError) {
      if (e.unsupported) this.warnings.push(`${method} ${path}: ${e.body.message}`);
      return jsonResponse(e.status, e.body);
    }
    const message = e instanceof Error ? e.message : String(e);
    this.warnings.push(`${method} ${path}: internal mock error: ${message}`);
    return jsonResponse(500, { code: 'MOCK_INTERNAL', message, details: null, hint: 'Bug in tools/ui-smoke mock backend' });
  }

  // ------------------------------------------------------------------- storage helpers

  private table(name: string): Row[] {
    const rows = this.tables.get(name);
    if (!rows) throw new PgError(404, 'PGRST205', `Could not find the table 'public.${name}' in the schema cache`);
    return rows;
  }

  private touch(): void {
    this.indexCache.clear();
    this.accessCache.clear();
  }

  private now(): string {
    return formatTimestamp(this.txMs);
  }

  private today(): string {
    return new Date(this.txMs).toISOString().slice(0, 10);
  }

  private genUuid(): string {
    this.uuidCounter += 1;
    return stableUuid(`gen:${this.uuidCounter}`);
  }

  /** Rows of a table; `daily_totals` is a view over diary_entries (maintained by a trigger in the real DB). */
  private rowsOf(table: string): Row[] {
    if (table === 'daily_totals') return this.computeDailyTotals();
    return this.table(table);
  }

  private computeDailyTotals(): Row[] {
    const foodsById = new Map(this.table('foods').map((f) => [String(f.id), f] as const));
    const groups = new Map<string, { user: string; date: string; entries: Row[] }>();
    for (const e of this.table('diary_entries')) {
      const key = `${String(e.user_id)}|${String(e.entry_date)}`;
      const g = groups.get(key) ?? { user: String(e.user_id), date: String(e.entry_date), entries: [] };
      g.entries.push(e);
      groups.set(key, g);
    }
    const out: Row[] = [];
    for (const g of groups.values()) {
      const sums: Record<string, number> = {};
      for (const e of g.entries) {
        const nutrients = (foodsById.get(String(e.food_id))?.nutrients ?? {}) as Record<string, unknown>;
        for (const [code, value] of Object.entries(nutrients)) {
          if (typeof value === 'number') sums[code] = (sums[code] ?? 0) + (value * Number(e.grams)) / 100;
        }
      }
      for (const code of Object.keys(sums)) sums[code] = Math.round((sums[code] as number) * 1e4) / 1e4;
      out.push({
        user_id: g.user,
        entry_date: g.date,
        kcal: sums.ENERGY_KCAL ?? 0,
        protein_g: sums.PROTEIN_G ?? 0,
        carbs_g: sums.CARBS_G ?? 0,
        fat_g: sums.FAT_G ?? 0,
        fiber_g: sums.FIBER_G ?? 0,
        entry_count: g.entries.length,
        nutrients: sums,
        updated_at: this.now(),
      });
    }
    return out.sort((a, b) => (String(a.entry_date) < String(b.entry_date) ? -1 : 1));
  }

  private index(table: string, cols: readonly string[]): Map<string, Row[]> {
    const cacheKey = `${table}|${cols.join(',')}`;
    const cached = this.indexCache.get(cacheKey);
    if (cached) return cached;
    const map = new Map<string, Row[]>();
    for (const row of this.rowsOf(table)) {
      const k = keyOf(row, cols);
      if (k === null) continue;
      const list = map.get(k);
      if (list) list.push(row);
      else map.set(k, [row]);
    }
    this.indexCache.set(cacheKey, map);
    return map;
  }

  // ------------------------------------------------------------------- RLS

  private ctxOf(headers: Record<string, string>): Ctx {
    const auth = headers.authorization ?? '';
    const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    if (token === '' || token === ANON_KEY) return { uid: null, role: 'anon' };
    const claims = decodeJwt(token);
    if (!claims) {
      return { uid: null, role: 'anon', tokenError: new PgError(401, 'PGRST301', 'JWSError JWSInvalidSignature', null, null) };
    }
    if (typeof claims.exp === 'number' && claims.exp * 1000 < this.txMs) {
      return { uid: null, role: 'anon', tokenError: new PgError(401, 'PGRST303', 'JWT expired', null, null) };
    }
    if (claims.role === 'anon' || typeof claims.sub !== 'string') return { uid: null, role: 'anon' };
    if (!this.users.has(claims.sub)) {
      return { uid: null, role: 'anon', tokenError: new PgError(401, 'PGRST301', 'JWT is for an unknown user', null, null) };
    }
    return { uid: claims.sub, role: 'authenticated' };
  }

  private parentOf(def: TableDef, row: Row): { def: TableDef; row: Row } | null {
    if (def.scope.kind !== 'parent') return null;
    const scopeFk = def.scope.fk;
    const fk = def.fks.find((f) => f.name === scopeFk);
    if (!fk) return null;
    const parentDef = SCHEMA[fk.ref];
    if (!parentDef) return null;
    const k = keyOf(row, fk.cols);
    if (k === null) return null;
    const parent = this.index(fk.ref, fk.refCols).get(k)?.[0];
    return parent ? { def: parentDef, row: parent } : null;
  }

  /** public.my_friend_ids(): the accepted friends of `uid` (cached until the next change, like the STABLE function). */
  private friendIds(uid: string): ReadonlySet<string> {
    const key = `friends:${uid}`;
    let ids = this.accessCache.get(key);
    if (!ids) {
      ids = friendIdsOf(this.table('friendships'), uid);
      this.accessCache.set(key, ids);
    }
    return ids;
  }

  /** The foods `uid` uses (public.my_used_food()): a diary entry, a recipe ingredient, a saved meal item or a favourite. */
  private usedFoodIds(uid: string): ReadonlySet<string> {
    const key = `used:${uid}`;
    let ids = this.accessCache.get(key);
    if (!ids) {
      ids = usedFoodIdsOf((name) => this.table(name), uid);
      this.accessCache.set(key, ids);
    }
    return ids;
  }

  /** What the SELECT policies of the table let the signed-in user read. */
  private visible(def: TableDef, row: Row, ctx: Ctx): boolean {
    const uid = ctx.uid;
    if (uid === null) return false;
    const scope = def.scope;
    switch (scope.kind) {
      case 'reference':
        return true;
      case 'user':
        // recipes_friend_read: the rows of an accepted friend are readable too (never writable, see `writable`)
        return row[scope.column] === uid || (scope.friendRead === true && this.friendIds(uid).has(String(row[scope.column])));
      case 'participant':
        return scope.columns.some((c) => row[c] === uid);
      case 'owner': {
        const owner = row[scope.column];
        if (owner === null || owner === undefined || owner === uid) return true;
        // foods_read: a friend's custom foods and recipes (the archived ones too: the policy does not look at `archived`) ...
        if (scope.friendKinds?.includes(String(row.kind)) && this.friendIds(uid).has(String(owner))) return true;
        // ... and any food the caller uses, so ending a friendship never blanks a diary entry or a recipe
        return scope.usedRead === true && this.usedFoodIds(uid).has(String(row[def.pk[0] as string]));
      }
      case 'parent': {
        const parent = this.parentOf(def, row);
        return parent !== null && this.visible(parent.def, parent.row, ctx);
      }
    }
  }

  /** What the INSERT / UPDATE / DELETE policies allow: owner-only everywhere, including for what a friend may read. */
  private writable(def: TableDef, row: Row, ctx: Ctx): boolean {
    if (ctx.uid === null || def.virtual) return false;
    switch (def.scope.kind) {
      case 'reference':
        return false;
      case 'user':
        return row[def.scope.column] === ctx.uid;
      case 'participant':
        // friendships: the delete policy (either side). INSERT and UPDATE are refused earlier, for lack of a grant.
        return def.scope.columns.some((c) => row[c] === ctx.uid);
      case 'owner':
        return row[def.scope.column] === ctx.uid && (!def.scope.writeKinds || def.scope.writeKinds.includes(String(row.kind)));
      case 'parent': {
        const parent = this.parentOf(def, row);
        return parent !== null && this.writable(parent.def, parent.row, ctx);
      }
    }
  }

  /**
   * `with check (exists (select 1 from public.foods f where f.id = <row>.<col>))` of diary_entries, favorites, recipe_ingredients and
   * saved_meal_items: the referenced food has to be visible through the foods policy. A friend's food passes, a stranger's is refused
   * (42501, like every row level security violation). A food that does not exist at all still ends in the foreign key error (23503),
   * as before. `row` is the row as it will be written; the caller's own uses are read before the write, like the statement snapshot.
   */
  private checkFoodRefs(def: TableDef, row: Row, ctx: Ctx): void {
    if (!def.foodRefCols || ctx.uid === null) return;
    const foodsDef = SCHEMA.foods as TableDef;
    for (const col of def.foodRefCols) {
      const key = keyOf(row, [col]);
      if (key === null) continue;
      const food = this.index('foods', ['id']).get(key)?.[0];
      if (food && !this.visible(foodsDef, food, ctx)) throw rls(def.name, false);
    }
  }

  private visibleRows(table: string, ctx: Ctx): Row[] {
    const def = SCHEMA[table] as TableDef;
    if (ctx.uid === null) throw ctx.tokenError ?? new PgError(401, '42501', `permission denied for table ${table}`);
    return this.rowsOf(table).filter((r) => this.visible(def, r, ctx));
  }

  // ------------------------------------------------------------------- GoTrue

  private auth(method: string, endpoint: string, url: URL, headers: Record<string, string>, body: string | null): MockResponse {
    const parseBody = (): Record<string, unknown> => {
      if (!body) return {};
      try {
        const parsed: unknown = JSON.parse(body);
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    };

    if (endpoint === '/token' && method === 'POST') {
      const grant = url.searchParams.get('grant_type');
      const data = parseBody();
      if (grant === 'password') {
        const candidate = [...this.users.values()].find((u) => u.email.toLowerCase() === String(data.email ?? '').trim().toLowerCase());
        if (!candidate || candidate.password !== data.password) {
          return jsonResponse(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
        }
        return jsonResponse(200, this.issueSession(candidate));
      }
      if (grant === 'refresh_token') {
        const owner = this.refreshTokens.get(String(data.refresh_token ?? '')) ?? (String(data.refresh_token ?? '').startsWith('mock-refresh-') ? this.userId : undefined);
        const candidate = owner ? this.users.get(owner) : undefined;
        if (!candidate) return jsonResponse(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' });
        return jsonResponse(200, this.issueSession(candidate));
      }
      this.unhandled.push({ seq: this.seq, method, path: `/auth/v1${endpoint}?grant_type=${grant ?? ''}`, reason: 'grant type not emulated' });
      return jsonResponse(400, { code: 400, error_code: 'validation_failed', msg: `Unsupported grant_type ${grant ?? ''}` });
    }
    if (endpoint === '/user' && method === 'GET') {
      const ctx = this.ctxOf(headers);
      if (ctx.uid === null) {
        return jsonResponse(401, { code: 401, error_code: 'bad_jwt', msg: ctx.tokenError ? ctx.tokenError.body.message : 'invalid claim: missing sub claim' });
      }
      return jsonResponse(200, authUserJson(this.users.get(ctx.uid) as MockUser, this.txMs));
    }
    if (endpoint === '/logout' && method === 'POST') return emptyResponse(204);
    if (endpoint === '/settings' && method === 'GET') {
      return jsonResponse(200, {
        external: { email: true, phone: false },
        disable_signup: true,
        mailer_autoconfirm: false,
        phone_autoconfirm: false,
        sms_provider: '',
        saml_enabled: false,
      });
    }
    if (endpoint === '/.well-known/jwks.json' && method === 'GET') return jsonResponse(200, { keys: [] });
    this.unhandled.push({ seq: this.seq, method, path: `/auth/v1${endpoint}`, reason: 'auth endpoint not emulated' });
    return jsonResponse(404, { code: 404, error_code: 'not_found', msg: `Mock backend does not emulate ${method} /auth/v1${endpoint}` });
  }

  private issueSession(user: MockUser) {
    const refresh = `mock-refresh-${user.id.slice(0, 8)}-${this.seq}`;
    this.refreshTokens.set(refresh, user.id);
    return buildSession(user, { nowMs: this.txMs, ttlSeconds: 3600, refreshToken: refresh });
  }

  // ------------------------------------------------------------------- Edge Function `sign-up`

  /** Slots used so far of an invite code (any spelling). */
  inviteUses(code: string): number {
    return this.signUps.usesOf(code);
  }

  private signUpFunction(method: string, body: string | null): MockResponse {
    const answer = this.signUps.handle(method, body, {
      emailTaken: (email) => [...this.users.values()].some((u) => u.email.toLowerCase() === email.toLowerCase()),
      createUser: (email, password) => this.createSignedUpUser(email, password),
    });
    return jsonResponse(answer.status, answer.body, answer.headers ?? {});
  }

  /** What `auth.admin.createUser` does, plus the `handle_new_user` trigger (profile + the four default meal groups). */
  private createSignedUpUser(email: string, password: string): void {
    const user: MockUser = { id: stableUuid(`user:signup:${email.toLowerCase()}`), email: email.toLowerCase(), password, createdAt: this.now() };
    this.users.set(user.id, user);
    const seedRow = (table: string, input: Row) => {
      const def = SCHEMA[table] as TableDef;
      this.table(table).push(this.buildRow(def, input, { missingDefault: true, ctx: null, seed: true }));
    };
    seedRow('profiles', { user_id: user.id, display_name: user.email.split('@')[0] || null });
    ['Breakfast', 'Lunch', 'Dinner', 'Snacks'].forEach((name, i) => seedRow('meal_groups', { user_id: user.id, name, sort_order: i * 10 }));
    this.touch();
  }

  // ------------------------------------------------------------------- Edge Function `send-invite`

  private sendInviteFunction(method: string, body: string | null, headers: Record<string, string>): MockResponse {
    const ctx = this.ctxOf(headers);
    const answer = this.sendInvites.handle(method, body, {
      // the gateway verified the JWT; a missing / anon / expired one is refused exactly like the real function
      isAdmin: () => {
        if (ctx.uid === null) return false;
        const row = this.table('profiles').find((p) => p.user_id === ctx.uid);
        return row?.is_admin === true;
      },
      // public.create_invite_code_for with the service role: the same state the admin_create_invite_code_for RPC uses
      createInviteFor: (email, maxUses, validDays) =>
        createInviteFor(this.table(INVITES_TABLE), this.txMs, ++this.inviteSeq, { email, maxUses, validDays }),
    });
    return jsonResponse(answer.status, answer.body, answer.headers ?? {});
  }

  // ------------------------------------------------------------------- Edge Function `friend-request`

  private friendRequestFunction(method: string, body: string | null, headers: Record<string, string>): MockResponse {
    const ctx = this.ctxOf(headers);
    const answer = this.friendRequests.handle(method, body, {
      uid: ctx.uid ?? '',
      // public.send_friend_request_internal with the service role: the requester is the ARGUMENT here (the JWT
      // claim), the SQLSTATE refusals are classified the same way the real store maps them
      send: (requesterId, email) => {
        const before = this.table('friendships').length;
        try {
          const status = sendFriendRequest(this.friendsEnv(requesterId), email);
          return { kind: 'ok' as const, status, created: this.table('friendships').length > before };
        } catch (e) {
          if (!(e instanceof FriendsError)) throw e;
          return classifyFriendRequestError({ code: e.sqlstate, message: e.message });
        }
      },
      displayNameOf: (requesterId) => {
        const row = this.table('profiles').find((p) => p.user_id === requesterId);
        return row && typeof row.display_name === 'string' ? row.display_name : '';
      },
    } satisfies FriendRequestHost);
    return jsonResponse(answer.status, answer.body, answer.headers ?? {});
  }

  // ------------------------------------------------------------------- REST dispatch

  private rest(method: string, rest: string, url: URL, headers: Record<string, string>, body: string | null): MockResponse {
    if (rest === '') {
      this.unhandled.push({ seq: this.seq, method, path: url.pathname, reason: 'REST root / OpenAPI not emulated' });
      return jsonResponse(404, { message: 'Not emulated' });
    }
    const ctx = this.ctxOf(headers);
    if (rest.startsWith('rpc/')) return this.rpc(method, rest.slice(4), url, headers, body, ctx);

    const table = rest;
    const def = SCHEMA[table];
    if (!def) {
      this.unhandled.push({ seq: this.seq, method, path: url.pathname, reason: `unknown table "${table}"` });
      throw new PgError(404, 'PGRST205', `Could not find the table 'public.${table}' in the schema cache`, null, `Add "${table}" to tools/ui-smoke/src/schema.ts if it exists in supabase/migrations.`);
    }
    const prefer = parsePrefer(headers.prefer);
    const wantsObject = (headers.accept ?? '').includes('application/vnd.pgrst.object+json');

    switch (method) {
      case 'GET':
      case 'HEAD':
        return this.select(def, url, headers, ctx, prefer, wantsObject, method === 'HEAD');
      case 'POST':
        return this.write('insert', def, url, ctx, prefer, wantsObject, body);
      case 'PATCH':
        return this.write('update', def, url, ctx, prefer, wantsObject, body);
      case 'DELETE':
        return this.write('delete', def, url, ctx, prefer, wantsObject, body);
      default:
        throw new PgError(405, 'PGRST117', `Unsupported HTTP method: ${method}`);
    }
  }

  // ------------------------------------------------------------------- select

  private select(def: TableDef, url: URL, headers: Record<string, string>, ctx: Ctx, prefer: Prefer, wantsObject: boolean, head: boolean): MockResponse {
    const params = url.searchParams;
    const plan = planSelect(def.name, parseSelect(params.get('select')));
    applyEmbedParams(plan, params);
    const filters = parseFilters(def.name, params);
    const order = parseOrder(def.name, params.get('order'));

    let rows = this.visibleRows(def.name, ctx).filter((r) => matches(filters, r));
    rows = sortRows(rows, order);
    const projected = this.projectRows(rows, plan, ctx).filter((p) => p.keep);
    const total = projected.length;

    let offset = Number(params.get('offset') ?? 0) || 0;
    let limit = params.get('limit') !== null ? Number(params.get('limit')) : Infinity;
    const range = /^(?:items=)?(\d+)-(\d*)$/.exec((headers.range ?? '').trim());
    if (range) {
      offset = Number(range[1]);
      if (range[2] !== '') limit = Math.min(limit, Number(range[2]) - offset + 1);
    }
    if (!Number.isFinite(limit) && limit !== Infinity) limit = Infinity;
    const page = projected.slice(offset, limit === Infinity ? undefined : offset + Math.max(limit, 0));
    const data = page.map((p) => p.value);

    const resHeaders: Record<string, string> = {};
    const countKnown = prefer.count !== null;
    const rangeText = data.length === 0 ? '*' : `${offset}-${offset + data.length - 1}`;
    resHeaders['content-range'] = `${rangeText}/${countKnown ? total : '*'}`;
    const partial = countKnown && data.length < total;

    if (wantsObject) {
      if (data.length !== 1) {
        throw new PgError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned', `The result contains ${data.length} rows`);
      }
      return head ? emptyResponse(200, resHeaders) : jsonResponse(200, data[0], resHeaders, OBJECT_CT);
    }
    const status = partial || (range && countKnown && data.length < total) ? 206 : 200;
    return head ? emptyResponse(status, resHeaders) : jsonResponse(status, data, resHeaders);
  }

  /** Applies a select plan; `keep` is false for rows excluded by an `!inner` embed. */
  private projectRows(rows: readonly Row[], plan: readonly PlanNode[], ctx: Ctx): { value: Row; keep: boolean }[] {
    return rows.map((row) => {
      const out: Row = {};
      let keep = true;
      for (const node of plan) {
        if (node.kind === 'star') {
          for (const c of node.columns) out[c] = clone(row[c] ?? null);
        } else if (node.kind === 'col') {
          let v: unknown = row[node.column] ?? null;
          for (const step of node.path) {
            v = v !== null && typeof v === 'object' ? ((v as Row)[step.key] ?? null) : null;
          }
          if (node.path.length > 0 && node.path[node.path.length - 1]?.op === '->>' && v !== null && typeof v !== 'string') v = JSON.stringify(v);
          if (node.cast === 'text' && v !== null) v = String(v);
          else if (node.cast && ['numeric', 'int', 'integer', 'float', 'float8', 'int4', 'bigint'].includes(node.cast) && v !== null) v = Number(v);
          out[node.out] = clone(v);
        } else {
          const { rel } = node;
          const fromKey = keyOf(row, rel.fromCols);
          let related: Row[] = [];
          if (fromKey !== null) {
            const targetDef = SCHEMA[rel.target] as TableDef;
            related = (this.index(rel.target, rel.targetCols).get(fromKey) ?? []).filter((r) => this.visible(targetDef, r, ctx));
          }
          if (node.mods.order.length > 0) related = sortRows(related, node.mods.order);
          if (node.mods.offset) related = related.slice(node.mods.offset);
          if (node.mods.limit !== undefined && Number.isFinite(node.mods.limit)) related = related.slice(0, node.mods.limit);
          const children = this.projectRows(related, node.children, ctx).filter((c) => c.keep).map((c) => c.value);
          if (rel.kind === 'to-one') {
            out[node.out] = children[0] ?? null;
            if (node.inner && children.length === 0) keep = false;
          } else {
            out[node.out] = children;
            if (node.inner && children.length === 0) keep = false;
          }
        }
      }
      return { value: out, keep };
    });
  }

  // ------------------------------------------------------------------- writes

  private write(
    op: 'insert' | 'update' | 'delete',
    def: TableDef,
    url: URL,
    ctx: Ctx,
    prefer: Prefer,
    wantsObject: boolean,
    body: string | null,
  ): MockResponse {
    const params = url.searchParams;
    let payload: unknown = null;
    if (op !== 'delete') {
      try {
        payload = body ? (JSON.parse(body) as unknown) : null;
      } catch {
        throw new PgError(400, 'PGRST102', 'Empty or invalid json', 'Invalid JSON');
      }
      if (payload === null || typeof payload !== 'object') {
        throw new PgError(400, 'PGRST102', 'Empty or invalid json', 'Invalid JSON');
      }
    }
    const isUpsert = op === 'insert' && prefer.resolution !== null;
    const recordOp: MutationRecord['op'] = isUpsert ? 'upsert' : op;
    const record = (rows: number, ok: boolean, status: number, error?: string) => {
      this.mutations.push({
        seq: this.seq,
        table: def.name,
        op: recordOp,
        payload: payload === null ? null : clone(payload),
        filter: url.search,
        rows,
        ok,
        status,
        ...(error ? { error } : {}),
      });
    };

    const snapshot = this.snapshot();
    try {
      if (ctx.uid === null) throw ctx.tokenError ?? new PgError(401, '42501', `permission denied for table ${def.name}`);
      if (def.virtual || def.scope.kind === 'reference') throw new PgError(403, '42501', `permission denied for table ${def.name}`);
      // No GRANT for this write (friendships: `grant select, delete` only): refused before row level security is looked at.
      if (def.writeGrants && !def.writeGrants.includes(op)) throw new PgError(403, '42501', `permission denied for table ${def.name}`);

      let result: WriteResult;
      if (op === 'insert') result = this.doInsert(def, payload as Row | Row[], params, ctx, prefer);
      else if (op === 'update') result = this.doUpdate(def, payload as Row, params, ctx);
      else result = this.doDelete(def, params, ctx);

      if (wantsObject && prefer.return === 'representation' && result.returned.length !== 1) {
        throw new PgError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned', `The result contains ${result.returned.length} rows`);
      }
      this.touch();
      let response: MockResponse;
      const resHeaders: Record<string, string> = {};
      if (prefer.count) resHeaders['content-range'] = `*/${result.rows.length}`;
      if (prefer.return === 'representation') {
        const plan = planSelect(def.name, parseSelect(params.get('select')));
        applyEmbedParams(plan, params);
        const data = this.projectRows(result.returned, plan, ctx).map((p) => p.value);
        const status = op === 'insert' ? 201 : 200;
        response = wantsObject ? jsonResponse(status, data[0], resHeaders, OBJECT_CT) : jsonResponse(status, data, resHeaders);
      } else {
        response = emptyResponse(op === 'insert' ? 201 : 204, resHeaders);
      }
      if (prefer.rollback) this.restore(snapshot);
      record(result.rows.length, true, response.status);
      return response;
    } catch (e) {
      this.restore(snapshot);
      if (e instanceof PgError) record(0, false, e.status, `${e.body.code}: ${e.body.message}`);
      else record(0, false, 500, e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  private snapshot(): Map<string, Row[]> {
    return structuredClone(this.tables);
  }

  private restore(s: Map<string, Row[]>): void {
    this.tables = s;
    this.touch();
  }

  /** Builds a complete stored row from a payload object: unknown columns, defaults, coercion, RLS, checks, triggers. */
  private buildRow(
    def: TableDef,
    input: Row,
    opts: { missingDefault: boolean; ctx: Ctx | null; seed?: boolean; extraKeys?: ReadonlySet<string> },
  ): Row {
    for (const key of Object.keys(input)) {
      const c = def.columns[key];
      if (!c) {
        throw new PgError(400, 'PGRST204', `Could not find the '${key}' column of '${def.name}' in the schema cache`);
      }
      if (c.generated && !opts.seed) {
        throw new PgError(400, '428C9', `cannot insert a non-DEFAULT value into column "${key}"`, `Column "${key}" is a generated column.`);
      }
    }
    const row: Row = {};
    for (const [name, c] of Object.entries(def.columns)) {
      if (c.generated) continue;
      const provided = Object.prototype.hasOwnProperty.call(input, name);
      if (provided) {
        row[name] = coerceValue(c.type, input[name]);
      } else if (opts.extraKeys?.has(name) && !opts.missingDefault) {
        row[name] = null; // bulk insert: missing keys become NULL (supabase-js default `defaultToNull`)
      } else if (c.default) {
        row[name] = this.defaultValue(def, c.default);
      } else {
        row[name] = null;
      }
      if (row[name] === undefined) row[name] = null;
    }
    // explicit NULL into a NOT NULL column that has a default stays NULL (23502), like Postgres.
    if (opts.ctx && !this.writable(def, row, opts.ctx) && !opts.seed) {
      throw rls(def.name, opts.ctx.uid === null);
    }
    if (opts.ctx && !opts.seed) this.checkFoodRefs(def, row, opts.ctx);
    // private.guard_profile_admin_flag (BEFORE INSERT): a client cannot create a profile that is a super admin.
    if (def.name === 'profiles' && opts.ctx && !opts.seed && row.is_admin === true) {
      throw new PgError(403, '42501', 'is_admin can only be set by the app owner (SQL editor)');
    }
    this.beforeWrite(def, row, null); // BEFORE triggers run before CHECK constraints (e.g. GTIN padding)
    validateRow(def, row);
    return row;
  }

  private defaultValue(def: TableDef, d: NonNullable<TableDef['columns'][string]['default']>): unknown {
    if ('value' in d) return clone(d.value);
    switch (d.fn) {
      case 'uuid':
        return this.genUuid();
      case 'now':
        return this.now();
      case 'today':
        return this.today();
      case 'serial': {
        const used = this.table(def.name).map((r) => Number(r.id)).filter(Number.isFinite);
        const next = Math.max(this.serials.get(def.name) ?? 0, ...used) + 1;
        this.serials.set(def.name, next);
        return next;
      }
    }
  }

  /** BEFORE INSERT/UPDATE triggers. `old` is null on insert. */
  private beforeWrite(def: TableDef, row: Row, old: Row | null): void {
    if (def.name === 'foods') {
      const raw = row.gtin14;
      if (typeof raw === 'string') {
        const digits = raw.replace(/\D/g, '');
        row.gtin14 = digits === '' || /^0+$/.test(digits) || digits.length > 14 ? null : digits.padStart(14, '0');
      }
      const nutrients = row.nutrients;
      const numeric =
        nutrients !== null && typeof nutrients === 'object' && !Array.isArray(nutrients) && Object.values(nutrients as Row).every((v) => typeof v === 'number');
      if (!numeric) {
        throw new PgError(400, '23514', 'new row for relation "foods" violates check constraint "foods_nutrients_numeric_object"');
      }
      row.search_text = searchTextOf(row);
      row.search = row.search_text;
      if (old) row.updated_at = this.now();
    } else if (old && ['profiles', 'daily_energy', 'coach_threads'].includes(def.name)) {
      row.updated_at = this.now();
    }
  }

  private fkSatisfied(fk: FkDef, row: Row): boolean {
    const k = keyOf(row, fk.cols);
    if (k === null) return true; // MATCH SIMPLE: any NULL skips the check
    if (fk.ref === 'auth.users') return this.users.has(String(row[fk.cols[0] as string]));
    return this.index(fk.ref, fk.refCols).has(k);
  }

  private checkFks(def: TableDef, row: Row, onlyCols?: ReadonlySet<string>): void {
    for (const fk of def.fks) {
      if (onlyCols && !fk.cols.some((c) => onlyCols.has(c))) continue;
      if (!this.fkSatisfied(fk, row)) {
        throw new PgError(
          409,
          '23503',
          `insert or update on table "${def.name}" violates foreign key constraint "${fk.name}"`,
          `Key (${fk.cols.join(', ')})=(${fk.cols.map((c) => String(row[c])).join(', ')}) is not present in table "${fk.ref === 'auth.users' ? 'users' : fk.ref}".`,
        );
      }
    }
  }

  private uniqueSets(def: TableDef): { name: string; cols: string[] }[] {
    return [
      { name: `${def.name}_pkey`, cols: def.pk },
      ...def.unique.map((cols) => ({ name: `${def.name}_${cols.join('_')}_key`, cols })),
    ];
  }

  /** Throws 23505 when `row` collides with an existing row (other than `self`). */
  private unique(def: TableDef, row: Row, self: Row | null): void {
    for (const u of this.uniqueSets(def)) {
      const k = keyOf(row, u.cols);
      if (k === null) continue;
      const clash = this.table(def.name).find((r) => r !== self && keyOf(r, u.cols) === k);
      if (clash) {
        throw new PgError(
          409,
          '23505',
          `duplicate key value violates unique constraint "${u.name}"`,
          `Key (${u.cols.join(', ')})=(${u.cols.map((c) => String(row[c])).join(', ')}) already exists.`,
        );
      }
    }
    // friendships_pair_uk: one row per unordered pair, whoever asked first
    if (def.pairUnique) {
      const [a, b] = def.pairUnique.cols;
      const pair = (r: Row) => [String(r[a]), String(r[b])].sort();
      const mine = pair(row).join('\u0001');
      const clash = this.table(def.name).find((r) => r !== self && pair(r).join('\u0001') === mine);
      if (clash) {
        throw new PgError(
          409,
          '23505',
          `duplicate key value violates unique constraint "${def.pairUnique.name}"`,
          `Key (LEAST(${a}, ${b}), GREATEST(${a}, ${b}))=(${pair(row).join(', ')}) already exists.`,
        );
      }
    }
  }

  private doInsert(def: TableDef, payload: Row | Row[], params: URLSearchParams, ctx: Ctx, prefer: Prefer): WriteResult {
    const list = Array.isArray(payload) ? payload : [payload];
    const bulk = Array.isArray(payload);
    const extraKeys = new Set<string>();
    if (bulk) for (const r of list) for (const k of Object.keys(r)) extraKeys.add(k);

    let conflictCols: string[] | null = null;
    if (prefer.resolution) {
      const raw = params.get('on_conflict');
      conflictCols = raw ? raw.split(',').map((c) => c.trim().replace(/^"|"$/g, '')) : def.pk;
      for (const c of conflictCols) {
        if (!def.columns[c]) throw new PgError(400, '42703', `column "${c}" does not exist`);
      }
      const known = this.uniqueSets(def).some((u) => u.cols.length === conflictCols?.length && u.cols.every((c) => conflictCols?.includes(c)));
      if (!known) {
        throw new PgError(400, '42P10', 'there is no unique or exclusion constraint matching the ON CONFLICT specification');
      }
    }

    const written: Row[] = [];
    const returned: Row[] = [];
    for (const item of list) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw new PgError(400, 'PGRST102', 'Empty or invalid json', 'All object keys must match');
      }
      const row = this.buildRow(def, item, { missingDefault: prefer.missingDefault || !bulk, ctx, extraKeys: bulk ? extraKeys : undefined });
      const existing = conflictCols ? this.table(def.name).find((r) => keyOf(r, conflictCols as string[]) !== null && keyOf(r, conflictCols as string[]) === keyOf(row, conflictCols as string[])) : undefined;
      if (existing && prefer.resolution === 'ignore-duplicates') continue;
      if (existing) {
        // merge-duplicates: DO UPDATE SET <columns present in the payload>
        if (!this.writable(def, existing, ctx)) throw rls(def.name, false);
        const provided = bulk ? extraKeys : new Set(Object.keys(item));
        this.checkFoodRefs(def, { ...existing, ...Object.fromEntries([...provided].map((k) => [k, row[k]])) }, ctx);
        const old = clone(existing);
        for (const k of provided) {
          if (!def.columns[k]?.generated) existing[k] = row[k];
        }
        this.beforeWrite(def, existing, old);
        this.applyOldGuards(def, old, existing);
        validateRow(def, existing);
        this.checkFks(def, existing);
        this.unique(def, existing, existing);
        written.push(existing);
        returned.push(clone(existing));
        continue;
      }
      this.checkFks(def, row);
      this.unique(def, row, null);
      this.table(def.name).push(row);
      this.touch();
      this.afterInsert(def, row);
      written.push(row);
      returned.push(clone(row));
    }
    return { rows: written, returned };
  }

  private afterInsert(def: TableDef, row: Row): void {
    if (def.name === 'diary_entries') {
      const usage = this.table('food_usage');
      const key = keyOf(row, ['user_id', 'food_id']);
      const existing = usage.find((u) => keyOf(u, ['user_id', 'food_id']) === key);
      if (existing) {
        existing.use_count = Number(existing.use_count) + 1;
        existing.last_used_at = this.now();
      } else {
        usage.push({ user_id: row.user_id, food_id: row.food_id, use_count: 1, last_used_at: this.now() });
      }
    }
  }

  /** `foods_protect_referenced` (BEFORE UPDATE OF nutrients, carb_basis, density_g_per_ml). */
  private applyOldGuards(def: TableDef, old: Row, next: Row): void {
    if (def.name === 'profiles') {
      // private.guard_profile_admin_flag (BEFORE UPDATE): a client cannot change the super admin flag, in either direction.
      if (old.is_admin !== next.is_admin) throw new PgError(403, '42501', 'is_admin can only be changed by the app owner (SQL editor)');
      return;
    }
    if (def.name !== 'foods') return;
    const changed =
      canonicalJson(old.nutrients) !== canonicalJson(next.nutrients) ||
      old.carb_basis !== next.carb_basis ||
      old.density_g_per_ml !== next.density_g_per_ml;
    if (!changed) return;
    const id = old.id;
    const referenced =
      this.table('diary_entries').some((d) => d.food_id === id) || this.table('recipe_ingredients').some((r) => r.ingredient_food_id === id);
    if (referenced) {
      throw new PgError(
        400,
        '23001',
        `food ${String(id)} is referenced by diary entries or recipes: nutrients, carb_basis and density_g_per_ml are immutable`,
        null,
        'Create a new version with public.supersede_food() (sets supersedes) and update that row instead.',
      );
    }
  }

  private requireWhere(op: string, params: URLSearchParams): void {
    let hasFilter = false;
    for (const key of params.keys()) {
      if (!['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(key)) hasFilter = true;
    }
    if (!hasFilter) throw new PgError(400, '21000', `${op} requires a WHERE clause`);
  }

  private matching(def: TableDef, filters: readonly Filter[], ctx: Ctx, forWrite: boolean): Row[] {
    return this.table(def.name).filter((r) => this.visible(def, r, ctx) && (!forWrite || this.writable(def, r, ctx)) && matches(filters, r));
  }

  private doUpdate(def: TableDef, patch: Row, params: URLSearchParams, ctx: Ctx): WriteResult {
    if (Array.isArray(patch)) throw new PgError(400, 'PGRST102', 'Empty or invalid json', 'PATCH expects a JSON object');
    this.requireWhere('UPDATE', params);
    const filters = parseFilters(def.name, params);
    const patchCols = new Set(Object.keys(patch));
    for (const k of patchCols) {
      const c = def.columns[k];
      if (!c) throw new PgError(400, 'PGRST204', `Could not find the '${k}' column of '${def.name}' in the schema cache`);
      if (c.generated) throw new PgError(400, '428C9', `column "${k}" can only be updated to DEFAULT`);
    }
    const coerced: Row = {};
    for (const k of patchCols) coerced[k] = coerceValue((def.columns[k] as ColumnDef).type, patch[k]);

    const targets = this.matching(def, filters, ctx, true);
    const changed: Row[] = [];
    for (const row of targets) {
      this.checkFoodRefs(def, { ...row, ...coerced }, ctx); // the WITH CHECK sees the new row; "uses" are those before the statement
      const old = clone(row);
      Object.assign(row, coerced);
      this.beforeWrite(def, row, old);
      this.applyOldGuards(def, old, row);
      validateRow(def, row);
      if (!this.writable(def, row, ctx)) throw rls(def.name, false);
      this.checkFks(def, row, patchCols);
      this.unique(def, row, row);
      changed.push(row);
    }
    return { rows: changed, returned: changed.map((r) => clone(r)) };
  }

  private doDelete(def: TableDef, params: URLSearchParams, ctx: Ctx): WriteResult {
    this.requireWhere('DELETE', params);
    const filters = parseFilters(def.name, params);
    const victims = this.matching(def, filters, ctx, true);
    const returned = victims.map((r) => clone(r));
    const restricted: { fk: FkDef; table: string; children: Row[]; parent: Row }[] = [];
    this.cascade(def.name, victims, restricted);
    for (const r of restricted) {
      const alive = r.children.filter((c) => this.table(r.table).includes(c));
      if (alive.length > 0) {
        throw new PgError(
          409,
          '23503',
          `update or delete on table "${def.name}" violates foreign key constraint "${r.fk.name}" on table "${r.table}"`,
          `Key (${r.fk.refCols.join(', ')})=(${r.fk.refCols.map((c) => String(r.parent[c])).join(', ')}) is still referenced from table "${r.table}".`,
        );
      }
    }
    return { rows: victims, returned };
  }

  /** Removes `victims` from `table` and applies ON DELETE actions of every FK that points at it. */
  private cascade(table: string, victims: readonly Row[], restricted: { fk: FkDef; table: string; children: Row[]; parent: Row }[]): void {
    if (victims.length === 0) return;
    const gone = new Set(victims);
    this.tables.set(table, this.table(table).filter((r) => !gone.has(r)));
    this.touch();
    for (const childDef of Object.values(SCHEMA)) {
      if (childDef.virtual) continue;
      for (const fk of childDef.fks) {
        if (fk.ref !== table) continue;
        const victimKeys = new Map<string, Row>();
        for (const v of victims) {
          const k = keyOf(v, fk.refCols);
          if (k !== null) victimKeys.set(k, v);
        }
        const children = this.table(childDef.name).filter((c) => {
          const k = keyOf(c, fk.cols);
          return k !== null && victimKeys.has(k);
        });
        if (children.length === 0) continue;
        if (fk.onDelete === 'cascade') {
          this.cascade(childDef.name, children, restricted);
        } else if (fk.onDelete === 'set null') {
          for (const c of children) {
            for (const col of fk.setNullCols ?? fk.cols) c[col] = null;
            const colDef = childDef.columns;
            for (const col of fk.setNullCols ?? fk.cols) {
              if (colDef[col]?.notNull) throw new PgError(400, '23502', `null value in column "${col}" of relation "${childDef.name}" violates not-null constraint`);
            }
          }
        } else {
          for (const c of children) {
            const k = keyOf(c, fk.cols);
            restricted.push({ fk, table: childDef.name, children: [c], parent: victimKeys.get(k as string) as Row });
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------- RPC

  private rpc(method: string, name: string, url: URL, headers: Record<string, string>, body: string | null, ctx: Ctx): MockResponse {
    const spec = CLIENT_RPCS[name];
    if (!spec) {
      if (SERVICE_ONLY_RPCS.includes(name)) {
        this.unhandled.push({ seq: this.seq, method, path: url.pathname, reason: `rpc "${name}" is service_role only (not callable by the app)` });
        throw new PgError(ctx.uid === null ? 401 : 403, '42501', `permission denied for function ${name}`);
      }
      this.unhandled.push({ seq: this.seq, method, path: url.pathname, reason: `unknown rpc "${name}"` });
      throw new PgError(404, 'PGRST202', `Could not find the function public.${name} in the schema cache`, null, `Add "${name}" to tools/ui-smoke/src/mock-backend.ts if it exists in supabase/migrations.`);
    }
    let args: Row = {};
    if (method === 'GET') {
      for (const [k, v] of url.searchParams.entries()) args[k] = v;
    } else if (method === 'POST') {
      try {
        const parsed: unknown = body ? JSON.parse(body) : {};
        args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Row) : {};
      } catch {
        throw new PgError(400, 'PGRST102', 'Empty or invalid json', 'Invalid JSON');
      }
    } else {
      throw new PgError(405, 'PGRST117', `Unsupported HTTP method: ${method}`);
    }
    const given = Object.keys(args);
    const unknownArg = given.find((k) => !spec.args.includes(k));
    const missing = spec.required.find((k) => !given.includes(k));
    if (unknownArg !== undefined || missing !== undefined) {
      throw new PgError(
        404,
        'PGRST202',
        `Could not find the function public.${name}(${[...given].sort().join(', ')}) in the schema cache`,
        null,
        `Perhaps you meant to call the function public.${name}(${[...spec.args].sort().join(', ')})`,
      );
    }
    if (ctx.uid === null) throw ctx.tokenError ?? new PgError(401, '42501', `permission denied for function ${name}`);
    const uid = ctx.uid;

    const wantsObject = (headers.accept ?? '').includes('application/vnd.pgrst.object+json');
    const snapshot = this.snapshot();
    const mutating = MUTATING_RPCS.has(name);
    const extraHeaders: Record<string, string> = {};
    try {
      let result: unknown;
      switch (name) {
        case 'search_foods':
          result = searchFoods(
            {
              foods: this.table('foods'),
              usage: this.table('food_usage'),
              favorites: this.table('favorites'),
              uid,
              nowMs: this.txMs,
              friends: this.friendIds(uid),
            },
            args,
          );
          break;
        case 'get_food_by_gtin':
          result = this.getFoodByGtin(String(args.gtin ?? ''), ctx);
          break;
        case 'supersede_food':
          result = this.supersedeFood(coerceValue('uuid', args.p_food_id) as string, ctx);
          break;
        case 'delete_all_my_coach_data':
          result = this.deleteAllCoachData(ctx);
          break;
        case 'admin_create_invite_code':
          this.requireSuperAdmin(ctx, 'create invite codes');
          result = this.inviteAdmin(() =>
            createInvite(this.table(INVITES_TABLE), this.txMs, ++this.inviteSeq, {
              note: args.p_note ?? null,
              maxUses: args.p_max_uses === undefined ? 1 : args.p_max_uses,
              validDays: args.p_valid_days === undefined ? 14 : args.p_valid_days,
            }),
          );
          break;
        case 'admin_list_invite_codes':
          this.requireSuperAdmin(ctx, 'list invite codes');
          result = listInvites(this.table(INVITES_TABLE), this.txMs);
          break;
        case 'admin_create_invite_code_for':
          this.requireSuperAdmin(ctx, 'create invite codes');
          result = this.inviteAdmin(() =>
            createInviteFor(this.table(INVITES_TABLE), this.txMs, ++this.inviteSeq, {
              email: args.p_email,
              maxUses: args.p_max_uses === undefined ? 1 : args.p_max_uses,
              validDays: args.p_valid_days === undefined ? 14 : args.p_valid_days,
            }),
          );
          break;
        case 'admin_list_invites': {
          this.requireSuperAdmin(ctx, 'list invite codes');
          // A function that returns a table is paged and filtered by PostgREST: limit / offset / status=eq.x / Prefer: count=exact.
          const page = pageInvites(listInvitesWithEmail(this.table(INVITES_TABLE), this.txMs), url.searchParams);
          for (const u of page.unsupported) this.warnings.push(`rpc admin_list_invites: the query parameter "${u}" is not emulated`);
          result = page.rows;
          if (parsePrefer(headers.prefer).count !== null) {
            const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0);
            extraHeaders['content-range'] = page.rows.length === 0 ? `*/${page.total}` : `${offset}-${offset + page.rows.length - 1}/${page.total}`;
          }
          break;
        }
        case 'admin_revoke_invite_code':
          this.requireSuperAdmin(ctx, 'revoke invite codes');
          result = revokeInvite(this.table(INVITES_TABLE), this.txMs, args.p_code);
          break;
        case 'my_friend_ids':
          // setof uuid: PostgREST answers an array of scalars
          result = [...this.friendIds(uid)];
          break;
        case 'my_used_food': {
          const foodId = coerceValue('uuid', args.p_food_id);
          result = typeof foodId === 'string' && this.usedFoodIds(uid).has(foodId);
          break;
        }
        case 'send_friend_request':
          result = this.friendsRpc(() => sendFriendRequest(this.friendsEnv(uid), args.p_email));
          break;
        case 'respond_friend_request':
          // `if p_accept then ... else delete`: a NULL p_accept declines
          result = this.friendsRpc(() =>
            respondFriendRequest(this.friendsEnv(uid), coerceValue('uuid', args.p_id) as string | null, coerceValue('bool', args.p_accept) === true),
          );
          break;
        case 'list_friendships': {
          // A function that returns a table: PostgREST filters, orders and pages it from the query string.
          const page = pageRows(listFriendships(this.friendsEnv(uid)), url.searchParams, ['status', 'direction']);
          for (const u of page.unsupported) this.warnings.push(`rpc list_friendships: the query parameter "${u}" is not emulated`);
          result = page.rows;
          if (parsePrefer(headers.prefer).count !== null) {
            const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0);
            extraHeaders['content-range'] = page.rows.length === 0 ? `*/${page.total}` : `${offset}-${offset + page.rows.length - 1}/${page.total}`;
          }
          break;
        }
        default:
          throw new PgError(404, 'PGRST202', `Could not find the function public.${name} in the schema cache`);
      }
      this.touch();
      if (mutating) {
        this.mutations.push({ seq: this.seq, table: `rpc:${name}`, op: 'rpc', payload: clone(args), filter: '', rows: 0, ok: true, status: 200 });
      }
      if (wantsObject && Array.isArray(result)) {
        if (result.length !== 1) throw new PgError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned', `The result contains ${result.length} rows`);
        return jsonResponse(200, result[0], {}, OBJECT_CT);
      }
      return jsonResponse(200, result, extraHeaders);
    } catch (e) {
      this.restore(snapshot);
      if (mutating) {
        const err = e instanceof PgError ? `${e.body.code}: ${e.body.message}` : String(e);
        this.mutations.push({ seq: this.seq, table: `rpc:${name}`, op: 'rpc', payload: clone(args), filter: '', rows: 0, ok: false, status: e instanceof PgError ? e.status : 500, error: err });
      }
      throw e;
    }
  }

  private getFoodByGtin(gtin: string, ctx: Ctx): Row[] {
    const digits = gtin.replace(/\D/g, '');
    if (digits === '' || /^0+$/.test(digits) || digits.length > 14) return [];
    const gtin14 = digits.padStart(14, '0');
    const foodsDef = SCHEMA.foods as TableDef;
    const quality = (s: string): number => ({ fdc_foundation: 1, fdc_sr_legacy: 0.85, cnf: 0.7, cofid: 0.55, fdc_fndds: 0.4, fdc_branded: 0.25, off: 0.1, ai_estimate: 0 }[s] ?? 0.5);
    // The function itself only looks at global and own foods (`owner_id is null or owner_id = v_uid`); a friend's food or one the
    // caller merely uses is visible through RLS, but not a candidate here (20261110000109 leaves this function alone).
    const candidates = this.table('foods')
      .filter((f) => f.gtin14 === gtin14 && f.archived !== true && (f.owner_id === null || f.owner_id === ctx.uid))
      .sort(
        (a, b) =>
          Number(b.owner_id !== null) - Number(a.owner_id !== null) ||
          quality(String(b.source)) - quality(String(a.source)) ||
          (Number(b.completeness ?? -1) - Number(a.completeness ?? -1)) ||
          String(a.created_at).localeCompare(String(b.created_at)),
      );
    const best = candidates[0];
    if (!best) return [];
    const out: Row = {};
    for (const c of starColumns(foodsDef)) out[c] = clone(best[c] ?? null);
    return [out];
  }

  private supersedeFood(foodId: string, ctx: Ctx): string {
    const foodsDef = SCHEMA.foods as TableDef;
    const old = this.table('foods').find((f) => f.id === foodId && this.visible(foodsDef, f, ctx));
    if (!old) throw new PgError(400, 'P0002', `food ${foodId} not found or not accessible`);
    if (!this.writable(foodsDef, old, ctx)) {
      throw new PgError(403, '42501', `food ${foodId} may not be modified by the current role`);
    }
    const copy = clone(old);
    old.archived = true;
    if (old.owner_id === null && typeof old.source_id === 'string') old.source_id = `${old.source_id}#v${String(old.version)}`;
    const newRow: Row = {
      ...copy,
      id: this.genUuid(),
      version: Number(copy.version) + 1,
      supersedes: copy.id,
      archived: false,
      created_at: this.now(),
      updated_at: this.now(),
    };
    this.beforeWrite(foodsDef, newRow, null);
    this.table('foods').push(newRow);
    this.touch();
    for (const p of this.table('food_portions').filter((p) => p.food_id === foodId)) {
      this.table('food_portions').push({ ...clone(p), id: this.genUuid(), food_id: newRow.id });
    }
    return String(newRow.id);
  }

  /** private.is_super_admin(): the caller's profile has is_admin; anybody else gets 42501, like the real wrappers. */
  private requireSuperAdmin(ctx: Ctx, what: string): void {
    const profile = this.table('profiles').find((p) => p.user_id === ctx.uid);
    if (profile?.is_admin !== true) throw new PgError(403, '42501', `only the app owner can ${what}`);
  }

  /** Maps the SQL exceptions of the invite RPCs to the error PostgREST sends. */
  private inviteAdmin<T>(run: () => T): T {
    try {
      return run();
    } catch (e) {
      if (e instanceof InviteAdminError) throw new PgError(e.status, e.sqlstate, e.message);
      throw e;
    }
  }

  /** Maps the SQL exceptions of the friend RPCs to the error PostgREST sends. */
  private friendsRpc<T>(run: () => T): T {
    try {
      return run();
    } catch (e) {
      if (e instanceof FriendsError) throw new PgError(e.status, e.sqlstate, e.message);
      throw e;
    }
  }

  /** What the SECURITY DEFINER friend functions work on: the rows without RLS or table grants. */
  private friendsEnv(uid: string): FriendsEnv {
    return {
      uid,
      nowMs: this.txMs,
      rows: () => this.table('friendships'),
      users: () => [...this.users.values()],
      profiles: () => this.table('profiles'),
      insert: (requesterId, addresseeId) => {
        const def = SCHEMA.friendships as TableDef;
        const row = this.buildRow(def, { requester_id: requesterId, addressee_id: addresseeId }, { missingDefault: true, ctx: null, seed: true });
        this.checkFks(def, row);
        this.unique(def, row, null);
        this.table('friendships').push(row);
        this.touch();
      },
      remove: (row) => this.cascade('friendships', [row], []),
    };
  }

  private deleteAllCoachData(ctx: Ctx): number {
    const def = SCHEMA.coach_threads as TableDef;
    const victims = this.table('coach_threads').filter((t) => this.writable(def, t, ctx));
    this.cascade('coach_threads', victims, []);
    return victims.length;
  }
}

/** JSON text with sorted object keys: jsonb equality ignores key order, so must the immutability trigger. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function lowerHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

/** Creates an independent in-memory backend from a seed. Throws when the seed violates the schema. */
export function createMockBackend(seed: MockSeed): MockBackend {
  return new MockBackendImpl(seed);
}

// Re-exports so that consumers do not need to know the module split.
export { findRelationship };
