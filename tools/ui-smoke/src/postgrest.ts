/**
 * PostgREST request parsing / evaluation helpers used by the mock backend: errors, `select=` parsing and
 * planning (columns + resource embedding), filters (`eq`, `in`, `or(...)`, `not.*`, ...), ordering, `Prefer`
 * parsing and value coercion for writes. Pure functions, no I/O.
 */
import { SCHEMA, starColumns, type ColType, type ColumnDef, type FkDef, type TableDef } from './schema';

// ----------------------------------------------------------------------------- errors

export interface PgErrorBody {
  code: string;
  message: string;
  details: string | null;
  hint: string | null;
}

/** An error that PostgREST would answer with `status` and a `{code, message, details, hint}` body. */
export class PgError extends Error {
  readonly status: number;
  readonly body: PgErrorBody;
  /** True when the mock itself lacks support (not an app bug): reported as a harness warning. */
  readonly unsupported: boolean;

  constructor(status: number, code: string, message: string, details: string | null = null, hint: string | null = null, unsupported = false) {
    super(message);
    this.status = status;
    this.body = { code, message, details, hint };
    this.unsupported = unsupported;
  }
}

export const unsupported = (what: string): PgError =>
  new PgError(400, 'MOCK_UNSUPPORTED', `Mock backend does not support ${what}`, null, 'Extend tools/ui-smoke/src/postgrest.ts', true);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ----------------------------------------------------------------------------- generic splitting

/** Splits on `sep` at parenthesis depth 0 and outside double quotes. */
export function splitTopLevel(s: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (!quoted) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (ch === sep && depth === 0) {
        out.push(cur);
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (cur !== '' || out.length > 0) out.push(cur);
  return out;
}

const unquote = (s: string): string => (s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\(.)/g, '$1') : s);

// ----------------------------------------------------------------------------- select parsing

export interface PathStep {
  op: '->' | '->>';
  key: string;
}

export type SelectNode =
  | { kind: 'star' }
  | { kind: 'col'; name: string; alias?: string; path: PathStep[]; cast?: string }
  | { kind: 'embed'; rel: string; alias?: string; hint?: string; inner: boolean; children: SelectNode[] };

function parseColumnExpr(raw: string): { name: string; path: PathStep[] } {
  const parts = raw.split(/(->>|->)/);
  const name = unquote((parts[0] ?? '').trim());
  const path: PathStep[] = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    path.push({ op: parts[i] === '->>' ? '->>' : '->', key: unquote((parts[i + 1] ?? '').trim()) });
  }
  return { name, path };
}

/** Parses a PostgREST `select=` string (whitespace already stripped by supabase-js). */
export function parseSelect(select: string | null | undefined): SelectNode[] {
  const s = (select ?? '').trim();
  if (s === '') return [{ kind: 'star' }];
  const nodes: SelectNode[] = [];
  for (const item of splitTopLevel(s)) {
    const text = item.trim();
    if (text === '') continue;
    const open = text.indexOf('(');
    if (open > -1 && text.endsWith(')')) {
      const head = text.slice(0, open);
      const inner = text.slice(open + 1, -1);
      const colon = head.indexOf(':');
      const alias = colon > -1 ? head.slice(0, colon) : undefined;
      const relPart = colon > -1 ? head.slice(colon + 1) : head;
      const [rel = '', ...mods] = relPart.split('!');
      let hint: string | undefined;
      let inner_ = false;
      for (const m of mods) {
        if (m === 'inner') inner_ = true;
        else if (m === 'left') inner_ = false;
        else if (m !== '') hint = m;
      }
      nodes.push({
        kind: 'embed',
        rel: unquote(rel.trim()),
        ...(alias ? { alias: unquote(alias.trim()) } : {}),
        ...(hint ? { hint } : {}),
        inner: inner_,
        children: parseSelect(inner),
      });
      continue;
    }
    let expr = text;
    let cast: string | undefined;
    const castAt = expr.lastIndexOf('::');
    if (castAt > -1) {
      cast = expr.slice(castAt + 2);
      expr = expr.slice(0, castAt);
    }
    let alias: string | undefined;
    const colon = expr.indexOf(':');
    if (colon > -1) {
      alias = unquote(expr.slice(0, colon).trim());
      expr = expr.slice(colon + 1);
    }
    if (expr.trim() === '*') {
      nodes.push({ kind: 'star' });
      continue;
    }
    const { name, path } = parseColumnExpr(expr);
    nodes.push({ kind: 'col', name, ...(alias ? { alias } : {}), path, ...(cast ? { cast } : {}) });
  }
  return nodes.length > 0 ? nodes : [{ kind: 'star' }];
}

// ----------------------------------------------------------------------------- relationships

export interface Relationship {
  kind: 'to-one' | 'to-many';
  from: string;
  target: string;
  fromCols: string[];
  targetCols: string[];
  fk: FkDef;
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** True when `cols` are exactly the primary key or a unique key of the table (=> one-to-one). */
function isUnique(def: TableDef, cols: readonly string[]): boolean {
  return sameSet(def.pk, cols) || def.unique.some((u) => sameSet(u, cols));
}

/**
 * Resolves `from -> rel` like PostgREST: by foreign key in either direction, optionally disambiguated by a hint
 * (FK column name or constraint name). Throws PGRST200 (none) / PGRST201 (ambiguous).
 */
export function findRelationship(from: string, rel: string, hint?: string): Relationship {
  const fromDef = SCHEMA[from];
  const relDef = SCHEMA[rel];
  if (!fromDef) throw new PgError(404, 'PGRST205', `Could not find the table 'public.${from}' in the schema cache`);
  const candidates: Relationship[] = [];
  if (relDef) {
    for (const fk of fromDef.fks) {
      if (fk.ref === rel) {
        candidates.push({ kind: 'to-one', from, target: rel, fromCols: fk.cols, targetCols: fk.refCols, fk });
      }
    }
    for (const fk of relDef.fks) {
      if (fk.ref === from) {
        candidates.push({
          kind: isUnique(relDef, fk.cols) ? 'to-one' : 'to-many',
          from,
          target: rel,
          fromCols: fk.refCols,
          targetCols: fk.cols,
          fk,
        });
      }
    }
  }
  const filtered = hint
    ? candidates.filter((c) => c.fk.cols.includes(hint) || c.fk.name === hint || c.fk.refCols.includes(hint))
    : candidates;
  if (filtered.length === 0) {
    throw new PgError(
      400,
      'PGRST200',
      `Could not find a relationship between '${from}' and '${rel}' in the schema cache`,
      `Searched for a foreign key relationship between '${from}' and '${rel}'${hint ? ` using the hint '${hint}'` : ''} in the schema 'public', but no matches were found.`,
    );
  }
  if (filtered.length > 1) {
    throw new PgError(
      300,
      'PGRST201',
      `Could not embed because more than one relationship was found for '${from}' and '${rel}'`,
      JSON.stringify(filtered.map((c) => ({ cardinality: c.kind, relationship: c.fk.name }))),
      `Try changing '${rel}' to one of the following: ${filtered.map((c) => `'${rel}!${c.fk.cols[0]}'`).join(', ')}. Find the desired relationship in the 'details' key.`,
    );
  }
  return filtered[0] as Relationship;
}

// ----------------------------------------------------------------------------- select planning

export interface EmbedModifiers {
  /** `<embed>.order=...` */
  order: OrderTerm[];
  /** `<embed>.limit=n` */
  limit?: number;
  /** `<embed>.offset=n` */
  offset?: number;
}

export type PlanNode =
  | { kind: 'star'; columns: string[] }
  | { kind: 'col'; column: string; out: string; path: PathStep[]; cast?: string }
  | { kind: 'embed'; out: string; rel: Relationship; inner: boolean; children: PlanNode[]; mods: EmbedModifiers };

function missingColumn(table: string, column: string): PgError {
  return new PgError(400, '42703', `column ${table}.${column} does not exist`);
}

/** Validates a parsed select against the schema (columns, relationships). Throws like PostgREST. */
export function planSelect(table: string, nodes: readonly SelectNode[]): PlanNode[] {
  const def = SCHEMA[table];
  if (!def) throw new PgError(404, 'PGRST205', `Could not find the table 'public.${table}' in the schema cache`);
  const plan: PlanNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'star') {
      plan.push({ kind: 'star', columns: starColumns(def) });
    } else if (node.kind === 'col') {
      if (!def.columns[node.name]) throw missingColumn(table, node.name);
      plan.push({
        kind: 'col',
        column: node.name,
        out: node.alias ?? (node.path.length > 0 ? (node.path[node.path.length - 1] as PathStep).key : node.name),
        path: node.path,
        ...(node.cast ? { cast: node.cast } : {}),
      });
    } else {
      const rel = findRelationship(table, node.rel, node.hint);
      plan.push({
        kind: 'embed',
        out: node.alias ?? node.rel,
        rel,
        inner: node.inner,
        children: planSelect(rel.target, node.children),
        mods: { order: [] },
      });
    }
  }
  return plan;
}

const EMBED_PARAM = /^(.+)\.(order|limit|offset)$/;

/**
 * Applies `<embed>.order|limit|offset` query parameters (supabase-js `referencedTable` option) to the embeds of
 * a plan. Nested embeds are addressed with a dotted path (`a.b.limit`).
 */
export function applyEmbedParams(plan: readonly PlanNode[], params: URLSearchParams): void {
  for (const [key, value] of params.entries()) {
    const m = EMBED_PARAM.exec(key);
    if (!m || key.includes('->')) continue;
    let nodes: readonly PlanNode[] = plan;
    let target: Extract<PlanNode, { kind: 'embed' }> | undefined;
    for (const segment of (m[1] as string).split('.')) {
      target = nodes.find((n): n is Extract<PlanNode, { kind: 'embed' }> => n.kind === 'embed' && n.out === segment);
      if (!target) throw new PgError(400, 'PGRST108', `'${segment}' is not an embedded resource in this request`);
      nodes = target.children;
    }
    const mods = (target as Extract<PlanNode, { kind: 'embed' }>).mods;
    const rel = (target as Extract<PlanNode, { kind: 'embed' }>).rel;
    if (m[2] === 'order') mods.order = parseOrder(rel.target, value);
    else if (m[2] === 'limit') mods.limit = Number(value);
    else mods.offset = Number(value);
  }
}

// ----------------------------------------------------------------------------- value coercion

function pgTimestamp(ms: number): string {
  const iso = new Date(ms).toISOString(); // 2026-11-10T11:00:00.000Z
  return iso.replace(/\.000Z$/, '+00:00').replace(/Z$/, '+00:00');
}

export const formatTimestamp = pgTimestamp;

function isRealDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

const invalidInput = (type: string, value: unknown): PgError =>
  new PgError(400, type === 'date' || type.startsWith('timestamp') ? '22007' : '22P02', `invalid input syntax for type ${type}: "${String(value)}"`);

/**
 * Coerces a JSON / query-string value to the stored representation of a column type, or throws the
 * Postgres error (22P02 / 22007). `null` stays `null`.
 */
export function coerceValue(type: ColType, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'uuid': {
      if (typeof value !== 'string' || !UUID_RE.test(value)) throw invalidInput('uuid', value);
      return value.toLowerCase();
    }
    case 'text': {
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      throw invalidInput('text', JSON.stringify(value));
    }
    case 'int': {
      const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
      if (!Number.isInteger(n)) throw invalidInput('integer', value);
      return n;
    }
    case 'numeric': {
      const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
      if (!Number.isFinite(n)) throw invalidInput('numeric', value);
      return n;
    }
    case 'bool': {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 't') return true;
      if (value === 'false' || value === 'f') return false;
      throw invalidInput('boolean', value);
    }
    case 'date': {
      if (typeof value !== 'string') throw invalidInput('date', value);
      const day = value.slice(0, 10);
      if (!isRealDate(day) || (value.length > 10 && !/^\d{4}-\d{2}-\d{2}[T ]/.test(value))) throw invalidInput('date', value);
      return day;
    }
    case 'timestamptz': {
      const ms = typeof value === 'string' ? Date.parse(value.includes(' ') && !value.includes('T') ? value.replace(' ', 'T') : value) : NaN;
      if (!Number.isFinite(ms)) throw invalidInput('timestamp with time zone', value);
      return pgTimestamp(ms);
    }
    case 'jsonb':
      return value;
    case 'array': {
      if (!Array.isArray(value)) throw invalidInput('array', JSON.stringify(value));
      return value;
    }
  }
}

/** Query-string argument (always text) coerced for comparison with a column. */
function coerceArg(type: ColType, raw: string): unknown {
  switch (type) {
    case 'timestamptz': {
      const ms = Date.parse(raw.includes(' ') && !raw.includes('T') ? raw.replace(' ', 'T') : raw);
      if (!Number.isFinite(ms)) throw invalidInput('timestamp with time zone', raw);
      return ms;
    }
    case 'date':
      if (!isRealDate(raw.slice(0, 10))) throw invalidInput('date', raw);
      return raw.slice(0, 10);
    case 'jsonb':
    case 'array':
      return raw;
    default:
      return coerceValue(type, raw);
  }
}

// ----------------------------------------------------------------------------- filters

export interface ColRef {
  column: string;
  path: PathStep[];
  type: ColType;
}

export type Filter =
  | { kind: 'cond'; col: ColRef; op: string; negate: boolean; arg: unknown }
  | { kind: 'group'; logic: 'and' | 'or'; negate: boolean; items: Filter[] };

export const RESERVED_PARAMS: ReadonlySet<string> = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);

const SIMPLE_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'match', 'imatch', 'is', 'in', 'cs', 'cd', 'ov', 'isdistinct']);

function resolveColRef(def: TableDef, raw: string): ColRef {
  const { name, path } = parseColumnExpr(raw);
  const column = def.columns[name];
  if (!column) throw missingColumn(def.name, name);
  return { column: name, path, type: path.length > 0 ? 'text' : column.type };
}

function parseArray(raw: string): string[] {
  const inner = raw.trim().replace(/^[({]/, '').replace(/[)}]$/, '');
  return splitTopLevel(inner).map((v) => unquote(v.trim()));
}

function buildCond(def: TableDef, colRaw: string, negate: boolean, op: string, rawArg: string): Filter {
  const col = resolveColRef(def, colRaw);
  if (!SIMPLE_OPS.has(op)) throw unsupported(`filter operator "${op}" (column ${def.name}.${col.column})`);
  let arg: unknown;
  switch (op) {
    case 'in':
      arg = parseArray(rawArg).map((v) => coerceArg(col.type, v));
      break;
    case 'is': {
      const v = rawArg.toLowerCase();
      if (!['null', 'true', 'false', 'unknown'].includes(v)) {
        throw new PgError(400, '22P02', `invalid input syntax for type boolean: "${rawArg}"`);
      }
      arg = v;
      break;
    }
    case 'like':
    case 'ilike':
    case 'match':
    case 'imatch':
      arg = rawArg;
      break;
    case 'cs':
    case 'cd':
    case 'ov':
      if (col.type !== 'array') throw unsupported(`operator "${op}" on a ${col.type} column (${def.name}.${col.column})`);
      arg = parseArray(rawArg);
      break;
    default:
      arg = coerceArg(col.type, unquote(rawArg));
  }
  return { kind: 'cond', col, op, negate, arg };
}

function parseGroupItems(def: TableDef, body: string): Filter[] {
  const items: Filter[] = [];
  for (const raw of splitTopLevel(body)) {
    const item = raw.trim();
    if (item === '') continue;
    const grp = /^(not\.)?(and|or)\((.*)\)$/s.exec(item);
    if (grp) {
      items.push({ kind: 'group', logic: grp[2] as 'and' | 'or', negate: grp[1] !== undefined, items: parseGroupItems(def, grp[3] ?? '') });
      continue;
    }
    // column.[not.]op.value
    const firstDot = item.indexOf('.');
    if (firstDot < 1) throw new PgError(400, 'PGRST100', `"failed to parse logic tree ((${body}))"`, `unexpected "${item}" expecting field name`);
    const colRaw = item.slice(0, firstDot);
    const m = /^(not\.)?([a-z]+)(?:\([a-z]+\))?\.(.*)$/s.exec(item.slice(firstDot + 1));
    if (!m) throw new PgError(400, 'PGRST100', `"failed to parse logic tree ((${body}))"`, `unexpected "${item}"`);
    items.push(buildCond(def, colRaw, m[1] !== undefined, m[2] as string, m[3] ?? ''));
  }
  return items;
}

/** Parses all filter query parameters (everything that is not select/order/limit/offset/on_conflict/columns). */
export function parseFilters(table: string, params: URLSearchParams): Filter[] {
  const def = SCHEMA[table];
  if (!def) throw new PgError(404, 'PGRST205', `Could not find the table 'public.${table}' in the schema cache`);
  const filters: Filter[] = [];
  for (const [key, value] of params.entries()) {
    if (RESERVED_PARAMS.has(key)) continue;
    const grp = /^(not\.)?(and|or)$/.exec(key);
    if (grp) {
      const body = value.trim().replace(/^\(/, '').replace(/\)$/, '');
      filters.push({ kind: 'group', logic: grp[2] as 'and' | 'or', negate: grp[1] !== undefined, items: parseGroupItems(def, body) });
      continue;
    }
    if (key.includes('.') && !key.includes('->')) {
      if (EMBED_PARAM.test(key)) continue; // handled by applyEmbedParams
      // `<embedded>.<column>=op.value`: filters on embedded resources.
      throw unsupported(`filters on embedded resources ("${key}")`);
    }
    const m = /^(not\.)?([a-z]+)(?:\([a-z]+\))?\.(.*)$/s.exec(value);
    if (!m) throw new PgError(400, 'PGRST100', `"failed to parse filter (${value})"`, `unexpected "${value}" expecting operator`);
    filters.push(buildCond(def, key, m[1] !== undefined, m[2] as string, m[3] ?? ''));
  }
  return filters;
}

type Tri = boolean | null;

function readCell(row: Record<string, unknown>, ref: ColRef): unknown {
  let v: unknown = row[ref.column];
  for (const step of ref.path) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') v = (v as Record<string, unknown>)[step.key] ?? null;
    else return null;
  }
  if (ref.path.length > 0 && v !== null && typeof v === 'object') return JSON.stringify(v);
  if (ref.path.length > 0 && v !== null) return String(v);
  return v;
}

function cmpCell(type: ColType, cell: unknown, arg: unknown): number | null {
  if (cell === null || cell === undefined) return null;
  switch (type) {
    case 'numeric':
    case 'int':
      return Number(cell) - (arg as number);
    case 'timestamptz': {
      const ms = Date.parse(String(cell));
      return Number.isFinite(ms) ? ms - (arg as number) : null;
    }
    case 'bool':
      return Number(Boolean(cell)) - Number(Boolean(arg));
    default: {
      const a = type === 'uuid' ? String(cell).toLowerCase() : String(cell);
      const b = String(arg);
      return a < b ? -1 : a > b ? 1 : 0;
    }
  }
}

function likeRegex(pattern: string, flags: string): RegExp {
  let out = '^';
  for (const ch of pattern) {
    if (ch === '%' || ch === '*') out += '.*';
    else if (ch === '_') out += '.';
    else out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`, `s${flags}`);
}

function evalCond(f: Extract<Filter, { kind: 'cond' }>, row: Record<string, unknown>): Tri {
  const cell = readCell(row, f.col);
  const type = f.col.type;
  let result: Tri;
  switch (f.op) {
    case 'is': {
      const a = f.arg as string;
      if (a === 'null') result = cell === null || cell === undefined;
      else if (a === 'unknown') result = cell === null || cell === undefined;
      else result = cell === null || cell === undefined ? false : Boolean(cell) === (a === 'true');
      return f.negate ? !result : result; // IS [NOT] never yields NULL
    }
    case 'isdistinct': {
      const c = cmpCell(type, cell, f.arg);
      result = cell === null || cell === undefined ? f.arg !== null : c !== 0;
      break;
    }
    case 'eq': {
      const c = cmpCell(type, cell, f.arg);
      result = c === null ? null : c === 0;
      break;
    }
    case 'neq': {
      const c = cmpCell(type, cell, f.arg);
      result = c === null ? null : c !== 0;
      break;
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const c = cmpCell(type, cell, f.arg);
      result = c === null ? null : f.op === 'gt' ? c > 0 : f.op === 'gte' ? c >= 0 : f.op === 'lt' ? c < 0 : c <= 0;
      break;
    }
    case 'in': {
      if (cell === null || cell === undefined) {
        result = null;
        break;
      }
      result = (f.arg as unknown[]).some((a) => cmpCell(type, cell, a) === 0);
      break;
    }
    case 'like':
    case 'ilike':
      result = cell === null || cell === undefined ? null : likeRegex(f.arg as string, f.op === 'ilike' ? 'i' : '').test(String(cell));
      break;
    case 'match':
    case 'imatch':
      result = cell === null || cell === undefined ? null : new RegExp(f.arg as string, f.op === 'imatch' ? 'i' : '').test(String(cell));
      break;
    case 'cs':
    case 'cd':
    case 'ov': {
      if (!Array.isArray(cell)) {
        result = null;
        break;
      }
      const have = cell.map(String);
      const want = f.arg as string[];
      result = f.op === 'cs' ? want.every((w) => have.includes(w)) : f.op === 'cd' ? have.every((h) => want.includes(h)) : want.some((w) => have.includes(w));
      break;
    }
    default:
      throw unsupported(`operator "${f.op}"`);
  }
  if (result === null) return null;
  return f.negate ? !result : result;
}

function evalFilter(f: Filter, row: Record<string, unknown>): Tri {
  if (f.kind === 'cond') return evalCond(f, row);
  let acc: Tri;
  if (f.logic === 'and') {
    acc = true;
    for (const item of f.items) {
      const v = evalFilter(item, row);
      if (v === false) {
        acc = false;
        break;
      }
      if (v === null) acc = null;
    }
  } else {
    acc = false;
    for (const item of f.items) {
      const v = evalFilter(item, row);
      if (v === true) {
        acc = true;
        break;
      }
      if (v === null) acc = null;
    }
  }
  if (acc === null) return null;
  return f.negate ? !acc : acc;
}

/** True when the row satisfies every (AND-ed) filter. NULL counts as "no match". */
export function matches(filters: readonly Filter[], row: Record<string, unknown>): boolean {
  return filters.every((f) => evalFilter(f, row) === true);
}

// ----------------------------------------------------------------------------- order

export interface OrderTerm {
  col: ColRef;
  desc: boolean;
  nullsFirst: boolean;
}

export function parseOrder(table: string, order: string | null): OrderTerm[] {
  const def = SCHEMA[table];
  if (!def || !order) return [];
  const terms: OrderTerm[] = [];
  for (const raw of splitTopLevel(order)) {
    const parts = raw.trim().split('.');
    const colRaw = parts[0] ?? '';
    if (colRaw === '') continue;
    const mods = parts.slice(1);
    const desc = mods.includes('desc');
    const nullsFirst = mods.includes('nullsfirst') ? true : mods.includes('nullslast') ? false : desc; // PG: NULLs sort as largest
    terms.push({ col: resolveColRef(def, colRaw), desc, nullsFirst });
  }
  return terms;
}

/** Stable sort. */
export function sortRows<T extends Record<string, unknown>>(rows: readonly T[], terms: readonly OrderTerm[]): T[] {
  if (terms.length === 0) return [...rows];
  return rows
    .map((row, index) => ({ row, index }))
    .sort((x, y) => {
      for (const t of terms) {
        const a = readCell(x.row, t.col);
        const b = readCell(y.row, t.col);
        const an = a === null || a === undefined;
        const bn = b === null || b === undefined;
        if (an && bn) continue;
        if (an) return t.nullsFirst ? -1 : 1;
        if (bn) return t.nullsFirst ? 1 : -1;
        const c = cmpCell(t.col.type, a, t.col.type === 'timestamptz' ? Date.parse(String(b)) : t.col.type === 'numeric' || t.col.type === 'int' ? Number(b) : t.col.type === 'bool' ? Boolean(b) : String(b));
        if (c === null || c === 0) continue;
        return t.desc ? -c : c;
      }
      return x.index - y.index;
    })
    .map((x) => x.row);
}

// ----------------------------------------------------------------------------- Prefer header

export interface Prefer {
  return: 'minimal' | 'representation' | 'headers-only';
  count: 'exact' | 'planned' | 'estimated' | null;
  resolution: 'merge-duplicates' | 'ignore-duplicates' | null;
  missingDefault: boolean;
  rollback: boolean;
}

export function parsePrefer(header: string | undefined | null): Prefer {
  const prefer: Prefer = { return: 'minimal', count: null, resolution: null, missingDefault: false, rollback: false };
  if (!header) return prefer;
  for (const token of header.split(',').map((t) => t.trim()).filter(Boolean)) {
    const [k, v] = token.split('=');
    if (k === 'return' && (v === 'minimal' || v === 'representation' || v === 'headers-only')) prefer.return = v;
    else if (k === 'count' && (v === 'exact' || v === 'planned' || v === 'estimated')) prefer.count = v;
    else if (k === 'resolution' && (v === 'merge-duplicates' || v === 'ignore-duplicates')) prefer.resolution = v;
    else if (k === 'missing' && v === 'default') prefer.missingDefault = true;
    else if (k === 'tx' && v === 'rollback') prefer.rollback = true;
  }
  return prefer;
}

// ----------------------------------------------------------------------------- write validation

const fmtRow = (row: Record<string, unknown>) => `(${Object.values(row).map((v) => (v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ')})`;

/** CHECK / NOT NULL validation of one fully-populated row. Throws Postgres-style errors. */
export function validateRow(def: TableDef, row: Record<string, unknown>): void {
  for (const [name, c] of Object.entries(def.columns)) {
    const v = row[name];
    if (c.notNull && (v === null || v === undefined)) {
      throw new PgError(400, '23502', `null value in column "${name}" of relation "${def.name}" violates not-null constraint`, `Failing row contains ${fmtRow(row)}.`);
    }
    if (v === null || v === undefined) continue;
    const check = (cond: boolean, suffix: string) => {
      if (!cond) {
        throw new PgError(
          400,
          '23514',
          `new row for relation "${def.name}" violates check constraint "${def.name}_${name}_${suffix}"`,
          `Failing row contains ${fmtRow(row)}.`,
        );
      }
    };
    const col: ColumnDef = c;
    if (col.oneOf) check(col.oneOf.includes(String(v)), 'check');
    if (col.min !== undefined) check(Number(v) >= col.min, 'check');
    if (col.gt !== undefined) check(Number(v) > col.gt, 'check');
    if (col.max !== undefined) check(Number(v) <= col.max, 'check');
    if (col.nonBlank) check(String(v).trim().length > 0, 'check');
    if (col.pattern) check(col.pattern.test(String(v)), 'format');
  }
}
