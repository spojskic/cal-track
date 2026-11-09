import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { main } from './cli';
import { cachedZipPath } from './download';
import { loadFdc } from './fdc';
import { FNDDS_FIXTURE, SR_FIXTURE, cnfFilesLatin1 } from './fixtures';
import { DB_SOFT_LIMIT_MB, estimateFoodBytes, formatReport, storageHint, summarize } from './report';
import { runJobs } from './run';
import { memorySource } from './source';
import { FakePg, makeStoredZip } from './test-utils';
import type { ImportFood } from './types';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function srDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cal-importer-cli-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(SR_FIXTURE)) await writeFile(join(dir, name), content);
  return dir;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { log: (m: string) => out.push(m), error: (m: string) => err.push(m), env: {} as NodeJS.ProcessEnv },
  };
}

function prefixed(prefix: string, files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [prefix + k, v]));
}

describe('cli', () => {
  it('fdc --dry-run parses and reports without touching a database (and accepts pnpm\'s leading "--")', async () => {
    const dir = await srDir();
    const c = capture();
    const code = await main(['--', 'fdc', '--dataset', 'sr_legacy', '--path', dir, '--dry-run'], c.io);
    expect(code).toBe(0);
    const text = c.out.join('\n');
    expect(text).toContain('DRY RUN');
    expect(text).toContain('[fdc_sr_legacy]');
    expect(text).toMatch(/foods found 9, kept 7, dropped 2/);
    expect(text).toContain('no_energy 1');
    expect(text).toContain('impossible_macros 1');
    expect(text).toContain('avg nutrients/food');
    expect(text).toContain('estimated storage');
    expect(c.err).toEqual([]);
  });

  it('resolves relative paths against the directory pnpm was started in (INIT_CWD)', async () => {
    const dir = await srDir();
    const c = capture();
    const io = { ...c.io, env: { INIT_CWD: dirname(dir) } as NodeJS.ProcessEnv };
    expect(await main(['fdc', '--dataset', 'sr_legacy', '--path', basename(dir), '--dry-run'], io)).toBe(0);
    expect(c.out.join('\n')).toContain('kept 7');
  });

  it('--limit restricts the foods', async () => {
    const dir = await srDir();
    const c = capture();
    expect(await main(['fdc', '--dataset', 'sr_legacy', '--path', dir, '--dry-run', '--limit', '2'], c.io)).toBe(0);
    expect(c.out.join('\n')).toMatch(/foods found 2, kept 2/);
  });

  it('prints help', async () => {
    const c = capture();
    expect(await main(['help'], c.io)).toBe(0);
    expect(c.out.join('\n')).toContain('download <foundation|sr_legacy|fndds>');
    expect(c.out.join('\n')).toContain('--dry-run');
  });

  it('reports usage errors with exit code 2', async () => {
    for (const args of [
      [],
      ['bogus'],
      ['fdc'],
      ['fdc', '--dataset', 'bogus', '--path', '/x'],
      ['fdc', '--dataset', 'sr_legacy'],
      ['fdc', '--dataset', 'sr_legacy', '--path', '/x', '--limit', '0'],
      ['fdc', '--unknown-flag'],
      ['cnf'],
      ['download'],
      ['download', 'branded'],
      ['all', '--only', 'nope'],
    ]) {
      const c = capture();
      expect(await main(args, c.io), args.join(' ')).toBe(2);
    }
  });

  it('refuses to write without a database URL', async () => {
    const dir = await srDir();
    const c = capture();
    expect(await main(['fdc', '--dataset', 'sr_legacy', '--path', dir], c.io)).toBe(1);
    expect(c.err.join('\n')).toMatch(/SUPABASE_DB_URL/);
  });

  it('never prints the database URL or password, even inside error messages', async () => {
    const c = capture();
    const url = 'postgresql://postgres:topsecret@db.example.supabase.co:5432/postgres';
    const code = await main(['fdc', '--dataset', 'sr_legacy', '--path', '/tmp/topsecret-missing.zip', '--db-url', url], c.io);
    expect(code).toBe(1);
    const text = [...c.out, ...c.err].join('\n');
    expect(text).not.toContain('topsecret');
    expect(text).not.toContain(url);
  });

  it('cofid is a clearly marked TODO stub', async () => {
    const c = capture();
    expect(await main(['cofid'], c.io)).toBe(2);
    expect(c.err.join('\n')).toMatch(/CoFID.*not implemented/i);
  });

  it('all: imports foundation, sr_legacy, fndds and cnf from the cache directory in order', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'cal-importer-all-ok-'));
    dirs.push(cache);
    const foundation = { ...SR_FIXTURE, 'food.csv': SR_FIXTURE['food.csv']!.replaceAll('sr_legacy_food', 'foundation_food') };
    await writeFile(cachedZipPath('foundation', cache), makeStoredZip({ 'rel/': '', ...prefixed('rel/', foundation) }));
    await writeFile(cachedZipPath('sr_legacy', cache), makeStoredZip(prefixed('rel/', SR_FIXTURE)));
    await writeFile(cachedZipPath('fndds', cache), makeStoredZip(prefixed('rel/', FNDDS_FIXTURE)));
    await mkdir(join(cache, 'cnf'));
    for (const [name, content] of Object.entries(cnfFilesLatin1())) await writeFile(join(cache, 'cnf', name), content);

    const c = capture();
    expect(await main(['all', '--cache-dir', cache, '--dry-run'], c.io)).toBe(0);
    const text = c.out.join('\n');
    const order = ['[fdc_foundation]', '[fdc_sr_legacy]', '[fdc_fndds]', '[cnf]'].map((tag) => text.indexOf(tag));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text).toContain('Total: 19 foods'); // 7 + 7 + 3 + 2

    const only = capture();
    expect(await main(['all', '--cache-dir', cache, '--dry-run', '--only', 'cnf'], only.io)).toBe(0);
    expect(only.out.join('\n')).not.toContain('[fdc_sr_legacy]');
  });

  it('all: skips the CNF with a note when no CNF files are present', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'cal-importer-all-nocnf-'));
    dirs.push(cache);
    await writeFile(cachedZipPath('sr_legacy', cache), makeStoredZip(prefixed('rel/', SR_FIXTURE)));
    const c = capture();
    expect(await main(['all', '--cache-dir', cache, '--dry-run', '--only', 'sr_legacy,cnf'], c.io)).toBe(0);
    expect(c.out.join('\n')).toContain('CNF skipped');
  });

  it('all: tells how to get missing archives', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'cal-importer-all-'));
    dirs.push(cache);
    const c = capture();
    expect(await main(['all', '--cache-dir', cache, '--dry-run'], c.io)).toBe(2);
    expect(c.err.join('\n')).toMatch(/Run "download foundation" first/);
  });
});

describe('runJobs', () => {
  const job = (label = 'SR Legacy') => ({
    label,
    load: () => loadFdc(memorySource(SR_FIXTURE), { dataset: 'sr_legacy' }),
  });

  it('dry run never connects', async () => {
    let connected = false;
    const { summaries } = await runJobs([job()], {
      dryRun: true,
      log: () => {},
      connect: async () => {
        connected = true;
        throw new Error('should not connect');
      },
    });
    expect(connected).toBe(false);
    expect(summaries[0]?.kept).toBe(7);
    expect(summaries[0]?.write).toBeUndefined();
  });

  it('writes through the injected connection, reports counts and database size, and closes it', async () => {
    const db = new FakePg();
    let ended = false;
    const opts = {
      dryRun: false,
      dbUrl: 'postgresql://u:p@h/db',
      log: () => {},
      connect: async () => ({ client: db, end: async () => void (ended = true), secrets: [] }),
    };
    const first = await runJobs([job()], opts);
    expect(ended).toBe(true);
    expect(first.summaries[0]?.write).toMatchObject({ inserted: 7, updated: 0, unchanged: 0 });
    expect(first.report).toContain('db: inserted 7, updated 0, unchanged 0');
    expect(first.report).toContain('Database size before: 50 MB');

    const second = await runJobs([job()], opts);
    expect(second.summaries[0]?.write).toMatchObject({ inserted: 0, updated: 0, unchanged: 7 });
    expect(db.foods.size).toBe(7);
  });

  it('requires a database URL unless dry-run', async () => {
    await expect(runJobs([job()], { dryRun: false, log: () => {} })).rejects.toThrow(/SUPABASE_DB_URL/);
  });
});

describe('report', () => {
  const food = (nutrientCount: number, name = 'Apple'): ImportFood => ({
    source: 'fdc_sr_legacy',
    sourceId: '1',
    kind: 'generic',
    name,
    category: 'Fruit',
    nutrients: Object.fromEntries(Array.from({ length: nutrientCount }, (_, i) => [`N${i}`, 1.234])),
    completeness: 0.5,
    carbBasis: 'includes_fiber',
    portions: [{ label: '100 g', amount: 100, unit: 'g', grams: 100, sortOrder: 0 }],
  });

  it('estimates more bytes for richer foods', () => {
    expect(estimateFoodBytes(food(60))).toBeGreaterThan(estimateFoodBytes(food(10)));
    expect(estimateFoodBytes(food(10))).toBeGreaterThan(300);
  });

  it('warns once the projected database passes the soft limit', () => {
    expect(storageHint(50, 40)).toBeNull();
    expect(storageHint(DB_SOFT_LIMIT_MB - 1, null)).toBeNull();
    expect(storageHint(250, 100)).toMatch(/WARNING.*350 MB.*300 MB/);
    expect(storageHint(400, null)).toMatch(/WARNING.*estimate alone/);
  });

  it('formats a multi-dataset report with totals', async () => {
    const { foods, stats } = await loadFdc(memorySource(SR_FIXTURE), { dataset: 'sr_legacy' });
    const s = summarize('SR Legacy', foods, stats);
    const text = formatReport([s, s], { dryRun: true });
    expect(text).toContain('Total: 14 foods');
    expect(s.avgNutrients).toBeGreaterThan(3);
    expect(text).toContain('energy from:');
  });
});
