/**
 * Keeps the harness in sync with the app: every `supabase.from('<table>')`, `.rpc('<fn>')` and
 * `functions.invoke('<fn>')` found in apps/app/src must be known to the mock backend. When this test fails,
 * add the table to schema.ts / the rpc to mock-backend.ts (or fix the app if it queries something that does
 * not exist in supabase/migrations).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CLIENT_RPCS, KNOWN_RPCS, KNOWN_TABLES, SCHEMA, SERVICE_ONLY_RPCS } from './schema';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const appSrc = join(repoRoot, 'apps', 'app', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

interface Hit {
  name: string;
  file: string;
  line: number;
}

function scan(re: RegExp, group = 1): Hit[] {
  const hits: Hit[] = [];
  for (const file of walk(appSrc)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(re)) {
      const index = m.index ?? 0;
      hits.push({ name: m[group] as string, file: relative(repoRoot, file), line: text.slice(0, index).split('\n').length });
    }
  }
  return hits;
}

const fmt = (hits: Hit[]) => hits.map((h) => `${h.name} (${h.file}:${h.line})`);

describe('app <-> mock backend sync', () => {
  it('finds table / rpc references at all (guards against a broken regex)', () => {
    expect(scan(/\.from\(\s*['"`]([a-z_]+)['"`]\s*\)/g).length).toBeGreaterThan(20);
    expect(scan(/\.rpc\(\s*['"`]([a-z_]+)['"`]/g).length).toBeGreaterThan(3);
  });

  it('every table used with supabase.from(...) is known to the mock', () => {
    const literal = scan(/\.from\(\s*['"`]([a-z_]+)['"`]\s*\)/g);
    // data/activity.ts passes the table name through its dayQuery(date, part, table) helper
    const viaHelper = scan(/dayQuery(?:<[^>]*>)?\(\s*[^,()]+,\s*['"`][a-z_]+['"`]\s*,\s*['"`]([a-z_]+)['"`]/g);
    const unknown = [...literal, ...viaHelper].filter((h) => !KNOWN_TABLES.includes(h.name));
    expect(fmt(unknown), 'tables missing from tools/ui-smoke/src/schema.ts').toEqual([]);
  });

  it('every rpc called by the app exists and is callable by the authenticated role', () => {
    const calls = scan(/\.rpc\(\s*['"`]([a-z_]+)['"`]/g);
    expect(fmt(calls.filter((h) => !KNOWN_RPCS.includes(h.name))), 'rpcs missing from the mock').toEqual([]);
    expect(fmt(calls.filter((h) => SERVICE_ONLY_RPCS.includes(h.name))), 'rpcs that only service_role may call').toEqual([]);
  });

  it('every rpc argument name the app passes matches the SQL signature', () => {
    // supabase.rpc('search_foods', { q, max_results: 40 }) - literal keys only
    const bad: string[] = [];
    for (const file of walk(appSrc)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\.rpc\(\s*['"`]([a-z_]+)['"`]\s*,\s*\{([^}]*)\}/g)) {
        const spec = CLIENT_RPCS[m[1] as string];
        if (!spec) continue;
        for (const key of (m[2] as string).split(',').map((k) => k.trim().split(':')[0]?.trim() ?? '').filter(Boolean)) {
          if (!spec.args.includes(key)) bad.push(`${m[1]}(${key}) in ${relative(repoRoot, file)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('every Edge Function the app invokes exists in supabase/functions (the mock answers 404 not_deployed)', () => {
    const functionsDir = join(repoRoot, 'supabase', 'functions');
    const existing = readdirSync(functionsDir).filter((n) => !n.startsWith('_') && statSync(join(functionsDir, n)).isDirectory());
    const invoked = scan(/functions\s*\.invoke\(\s*['"`]([a-z0-9_-]+)['"`]/g);
    expect(invoked.length).toBeGreaterThan(0);
    expect(fmt(invoked.filter((h) => !existing.includes(h.name))), 'functions invoked by the app but missing in supabase/functions').toEqual([]);
  });

  it('select() column lists only name columns that exist (static check of literal select strings)', () => {
    // Only simple, literal selects of the form .from('t').select('a,b,c') are checked here; embeds and
    // multi-line template strings are verified at run time by the mock (42703 / PGRST200).
    const problems: string[] = [];
    for (const file of walk(appSrc)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\.from\(\s*['"`]([a-z_]+)['"`]\s*\)\s*\.select\(\s*['"`]([a-z_,\s*]+)['"`]/g)) {
        const def = SCHEMA[m[1] as string];
        if (!def) continue;
        for (const col of (m[2] as string).split(',').map((c) => c.trim()).filter((c) => c && c !== '*')) {
          if (!def.columns[col]) problems.push(`${m[1]}.${col} in ${relative(repoRoot, file)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
