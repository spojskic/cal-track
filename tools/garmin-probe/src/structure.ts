// Turns a JSON value into a shareable description of its STRUCTURE: key paths, types, array lengths. Values are
// replaced by placeholders such as "<string:date>" or "<int:5d>" (digit counts keep magnitude information, e.g. grams
// vs kilograms or seconds vs epoch milliseconds, without revealing the numbers).

export type Structure = null | string | { [key: string]: unknown };

const MAX_DEPTH = 14;
const MAX_ARRAY_SAMPLE = 300;
const MAX_POSITIONS = 8;

export function numberPlaceholder(n: number): string {
  if (!Number.isFinite(n)) return '<number:nonfinite>';
  const abs = Math.abs(n);
  const digits = abs < 1 ? 1 : Math.floor(Math.log10(abs)) + 1;
  return `<${Number.isInteger(n) ? 'int' : 'float'}:${n < 0 ? '-' : ''}${digits}d>`;
}

export function stringPlaceholder(s: string): string {
  if (s === '') return '<string:empty>';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return '<string:date>';
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) return '<string:datetime-space>';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) return '<string:datetime-T>';
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return '<string:datetime-tz>';
  if (/^-?\d+(\.\d+)?$/.test(s)) return '<string:numeric>';
  return '<string>';
}

function isPrimitiveNode(n: unknown): n is string | null {
  return n === null || typeof n === 'string';
}
const isArrayNode = (n: unknown): n is { $array: string; item?: unknown; positions?: unknown[] } =>
  typeof n === 'object' && n !== null && '$array' in n;
const isOneOf = (n: unknown): n is { $oneOf: unknown[] } => typeof n === 'object' && n !== null && '$oneOf' in n;

function kindOf(n: unknown): 'prim' | 'arr' | 'oneOf' | 'obj' {
  if (isPrimitiveNode(n)) return 'prim';
  if (isArrayNode(n)) return 'arr';
  if (isOneOf(n)) return 'oneOf';
  return 'obj';
}

/** Describes `value`. Never throws (cycles, huge arrays, exotic objects are handled). */
export function summarizeStructure(value: unknown): Structure {
  return summarize(value, 0, new Set());
}

function summarize(value: unknown, depth: number, seen: Set<object>): Structure {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'boolean':
      return '<boolean>';
    case 'number':
      return numberPlaceholder(value);
    case 'bigint':
      return '<int>';
    case 'string':
      return stringPlaceholder(value);
    case 'object':
      break;
    default:
      return '<unsupported>';
  }
  const obj = value as object;
  if (depth >= MAX_DEPTH) return '<max-depth>';
  if (seen.has(obj)) return '<circular>';
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return summarizeArray(obj, depth, seen);
    const proto = Object.getPrototypeOf(obj) as unknown;
    if (proto !== Object.prototype && proto !== null) return '<object>';
    const out: { [key: string]: unknown } = {};
    for (const [k, v] of Object.entries(obj)) out[k] = summarize(v, depth + 1, seen);
    return out;
  } finally {
    seen.delete(obj);
  }
}

function summarizeArray(arr: unknown[], depth: number, seen: Set<object>): Structure {
  const length = String(arr.length);
  if (arr.length === 0) return { $array: length };
  const nodes = arr.slice(0, MAX_ARRAY_SAMPLE).map((el) => summarize(el, depth + 1, seen));
  if (arr.length <= MAX_POSITIONS && nodes.every(isPrimitiveNode)) return { $array: length, positions: nodes };
  return { $array: length, item: mergeStructures(nodes) };
}

function lengthRange(lengths: string[]): string {
  const nums = lengths.flatMap((l) => l.split('-').map(Number)).filter((n) => Number.isFinite(n));
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return min === max ? String(min) : `${min}-${max}`;
}

/** Merges several descriptions of "the same kind of thing" (array elements) into one. */
export function mergeStructures(nodes: readonly unknown[]): Structure {
  if (nodes.length === 0) return null;
  if (nodes.length === 1) return nodes[0] as Structure;
  const groups = new Map<string, unknown[]>();
  for (const n of nodes) {
    const k = kindOf(n);
    const g = groups.get(k);
    if (g) g.push(n);
    else groups.set(k, [n]);
  }
  const merged: Structure[] = [];
  for (const [kind, group] of groups) {
    if (kind === 'prim') {
      const set = [...new Set(group.map((g) => (g === null ? 'null' : (g as string))))].sort();
      merged.push(set.length === 1 && set[0] === 'null' ? null : set.join(' | '));
    } else if (kind === 'obj') {
      const objs = group as Array<{ [key: string]: unknown }>;
      const keys: string[] = [];
      for (const o of objs) for (const k of Object.keys(o)) if (!keys.includes(k)) keys.push(k);
      const out: { [key: string]: unknown } = {};
      const optional: string[] = [];
      for (const k of keys) {
        const vals = objs.filter((o) => k in o).map((o) => o[k]);
        if (vals.length < objs.length) optional.push(k);
        out[k] = mergeStructures(vals);
      }
      if (optional.length) out.$optional = optional.sort();
      merged.push(out);
    } else if (kind === 'arr') {
      const arrs = group as Array<{ $array: string; item?: unknown; positions?: unknown[] }>;
      const out: { [key: string]: unknown } = { $array: lengthRange(arrs.map((a) => a.$array)) };
      const withPositions = arrs.filter((a) => a.positions);
      const samePositions =
        withPositions.length === arrs.filter((a) => a.$array !== '0').length &&
        withPositions.length > 0 &&
        new Set(withPositions.map((a) => (a.positions as unknown[]).length)).size === 1;
      if (samePositions) {
        const len = (withPositions[0]!.positions as unknown[]).length;
        out.positions = Array.from({ length: len }, (_, i) => mergeStructures(withPositions.map((a) => (a.positions as unknown[])[i])));
      } else {
        const items = arrs.flatMap((a) => (a.item !== undefined ? [a.item] : a.positions ? [mergeStructures(a.positions)] : []));
        if (items.length) out.item = mergeStructures(items);
      }
      merged.push(out);
    } else {
      merged.push(...(group as Array<{ $oneOf: unknown[] }>).flatMap((g) => g.$oneOf as Structure[]));
    }
  }
  return merged.length === 1 ? (merged[0] as Structure) : { $oneOf: merged };
}

/** One line per key path: `data[].calendarDate: <string:date>`; optional keys end with `?`. */
export function listKeyPaths(structure: unknown, prefix = ''): string[] {
  if (isPrimitiveNode(structure)) return [`${prefix || '$'}: ${structure === null ? 'null' : structure}`];
  if (isArrayNode(structure)) {
    const head = `${prefix || '$'}[] (length ${structure.$array})`;
    if (structure.positions) {
      return [head, ...structure.positions.flatMap((p, i) => listKeyPaths(p, `${prefix}[${i}]`))];
    }
    if (structure.item !== undefined) return [head, ...listKeyPaths(structure.item, `${prefix}[]`)];
    return [head];
  }
  if (isOneOf(structure)) return structure.$oneOf.flatMap((s, i) => listKeyPaths(s, `${prefix}<${i}>`));
  const obj = structure as { [key: string]: unknown };
  const optional = new Set(Array.isArray(obj.$optional) ? (obj.$optional as string[]) : []);
  const keys = Object.keys(obj).filter((k) => k !== '$optional');
  if (!keys.length) return [`${prefix || '$'}: {}`];
  return keys.flatMap((k) => listKeyPaths(obj[k], `${prefix ? `${prefix}.` : ''}${k}${optional.has(k) ? '?' : ''}`));
}
