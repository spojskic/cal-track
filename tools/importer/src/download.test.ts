import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  FDC_DOWNLOADS,
  cachedZipPath,
  downloadFdc,
  downloadTarget,
  findCachedArchive,
  hasZipMagic,
  newerReleaseHint,
} from './download';
import { makeStoredZip } from './test-utils';

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'cal-importer-dl-'));
  dirs.push(d);
  return d;
};

const goodJsonZip = makeStoredZip({
  'FoodData_Central_foundation_food_json_2026-10-29.json': '{"FoundationFoods":[]}',
});

/** A complete CSV archive. */
const goodZip = makeStoredZip({
  'FoodData_Central_x/food.csv': 'fdc_id\n',
  'FoodData_Central_x/food_nutrient.csv': 'fdc_id\n',
  'FoodData_Central_x/nutrient.csv': 'id\n',
});

function fakeFetch(body: Buffer | string, init: { status?: number; contentLength?: number | null } = {}) {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    const buf = typeof body === 'string' ? Buffer.from(body) : body;
    const headers: Record<string, string> = {};
    const len = init.contentLength === undefined ? buf.length : init.contentLength;
    if (len !== null) headers['content-length'] = String(len);
    return new Response(buf, { status: init.status ?? 200, headers });
  }) as typeof fetch;
  return { impl, calls };
}

describe('download URL table', () => {
  const base = 'https://fdc.nal.usda.gov/fdc-datasets/';

  it('defaults to the JSON archives', () => {
    expect(downloadTarget('foundation').url).toBe(`${base}FoodData_Central_foundation_food_json_2026-10-29.zip`);
    expect(downloadTarget('sr_legacy').url).toBe(`${base}FoodData_Central_sr_legacy_food_json_2018-04.zip`);
    expect(downloadTarget('fndds').url).toBe(`${base}FoodData_Central_survey_food_json_2024-10-31.zip`);
  });

  it('keeps CSV archives for sr_legacy and fndds only', () => {
    expect(downloadTarget('sr_legacy', 'csv').url).toBe(`${base}FoodData_Central_sr_legacy_food_csv_2018-04.zip`);
    expect(downloadTarget('fndds', 'csv').url).toBe(`${base}FoodData_Central_survey_food_csv_2024-10-31.zip`);
    expect(FDC_DOWNLOADS.foundation.csv).toBeUndefined();
    expect(() => downloadTarget('foundation', 'csv')).toThrow(/incomplete.*JSON/);
  });

  it('caches under the file name of the URL', () => {
    expect(cachedZipPath('sr_legacy', '/c')).toBe('/c/FoodData_Central_sr_legacy_food_json_2018-04.zip');
    expect(cachedZipPath('sr_legacy', '/c', 'csv')).toBe('/c/FoodData_Central_sr_legacy_food_csv_2018-04.zip');
  });

  it('finds the cached archive, JSON first, then CSV', async () => {
    const dir = await tmp();
    expect(findCachedArchive('sr_legacy', dir)).toBeNull();
    await writeFile(cachedZipPath('sr_legacy', dir, 'csv'), 'x');
    expect(findCachedArchive('sr_legacy', dir)).toBe(cachedZipPath('sr_legacy', dir, 'csv'));
    await writeFile(cachedZipPath('sr_legacy', dir, 'json'), 'x');
    expect(findCachedArchive('sr_legacy', dir)).toBe(cachedZipPath('sr_legacy', dir, 'json'));
    expect(findCachedArchive('foundation', dir)).toBeNull(); // no CSV fallback for Foundation
  });

  it('prints a newer-release hint with the current release', () => {
    expect(newerReleaseHint(downloadTarget('fndds').url)).toContain('2024-10-31');
    expect(newerReleaseHint(downloadTarget('fndds').url)).toContain('https://fdc.nal.usda.gov/download-datasets');
  });

  it('recognises zip magic bytes', () => {
    expect(hasZipMagic(goodZip)).toBe(true);
    expect(hasZipMagic(Buffer.from('<!DOCTYPE html>'))).toBe(false);
    expect(hasZipMagic(Buffer.from([0x50, 0x4b]))).toBe(false);
  });
});

describe('downloadFdc', () => {
  it('downloads the JSON archive by default, verifies and caches it; a second call re-uses it', async () => {
    const cacheDir = await tmp();
    const { impl, calls } = fakeFetch(goodJsonZip);
    const logs: string[] = [];
    const path = await downloadFdc('sr_legacy', { cacheDir, fetchImpl: impl, log: (m) => logs.push(m) });
    expect(path).toBe(cachedZipPath('sr_legacy', cacheDir));
    expect((await stat(path)).size).toBe(goodJsonZip.length);
    expect(calls).toEqual([downloadTarget('sr_legacy').url]);
    expect(logs.join('\n')).toContain('newer release');
    expect(logs.join('\n')).not.toContain('warning');
    expect(await readdir(cacheDir)).toEqual(['FoodData_Central_sr_legacy_food_json_2018-04.zip']); // no .part left

    await downloadFdc('sr_legacy', { cacheDir, fetchImpl: impl, log: (m) => logs.push(m) });
    expect(calls).toHaveLength(1);
    expect(logs.join('\n')).toContain('Already downloaded');

    await downloadFdc('sr_legacy', { cacheDir, fetchImpl: impl, force: true });
    expect(calls).toHaveLength(2);
  });

  it('--format csv downloads the CSV archive of sr_legacy / fndds', async () => {
    const cacheDir = await tmp();
    const { impl, calls } = fakeFetch(goodZip);
    const logs: string[] = [];
    const path = await downloadFdc('fndds', { cacheDir, fetchImpl: impl, format: 'csv', log: (m) => logs.push(m) });
    expect(calls).toEqual([downloadTarget('fndds', 'csv').url]);
    expect(path.endsWith('FoodData_Central_survey_food_csv_2024-10-31.zip')).toBe(true);
    expect(logs.join('\n')).not.toContain('warning');
  });

  it('refuses the Foundation CSV archive without touching the network', async () => {
    const { impl, calls } = fakeFetch(goodZip);
    await expect(downloadFdc('foundation', { cacheDir: await tmp(), fetchImpl: impl, format: 'csv' })).rejects.toThrow(/incomplete/);
    expect(calls).toEqual([]);
  });

  it('rejects an HTML error page served with HTTP 200', async () => {
    const cacheDir = await tmp();
    const { impl } = fakeFetch('<!DOCTYPE html><html>maintenance</html>');
    await expect(downloadFdc('foundation', { cacheDir, fetchImpl: impl })).rejects.toThrow(/not a zip/);
    expect(await readdir(cacheDir)).toEqual([]);
  });

  it('rejects truncated downloads', async () => {
    const cacheDir = await tmp();
    const { impl } = fakeFetch(goodJsonZip, { contentLength: goodJsonZip.length + 1000 });
    await expect(downloadFdc('foundation', { cacheDir, fetchImpl: impl })).rejects.toThrow(/Incomplete download/);
    expect(await readdir(cacheDir)).toEqual([]);
  });

  it('reports HTTP errors with the release hint', async () => {
    const cacheDir = await tmp();
    const { impl } = fakeFetch('nope', { status: 404 });
    await expect(downloadFdc('fndds', { cacheDir, fetchImpl: impl })).rejects.toThrow(/HTTP 404.*newer release/s);
  });

  it('warns when the archive lacks the data files the importer needs', async () => {
    const cacheDir = await tmp();
    const logs: string[] = [];
    // JSON format but the zip only holds CSV tables
    await downloadFdc('foundation', { cacheDir, fetchImpl: fakeFetch(makeStoredZip({ 'x/nutrient.csv': 'id\n' })).impl, log: (m) => logs.push(m) });
    expect(logs.join('\n')).toMatch(/no \.json file found in the archive/);

    const csvLogs: string[] = [];
    await downloadFdc('sr_legacy', {
      cacheDir,
      format: 'csv',
      fetchImpl: fakeFetch(makeStoredZip({ 'x/nutrient.csv': 'id\n' })).impl,
      log: (m) => csvLogs.push(m),
    });
    expect(csvLogs.join('\n')).toMatch(/food\.csv not found in the archive/);
  });

  it('accepts a --url override', async () => {
    const cacheDir = await tmp();
    const { impl, calls } = fakeFetch(goodJsonZip);
    const url = 'https://example.test/FoodData_Central_foundation_food_json_2030-01-01.zip';
    const path = await downloadFdc('foundation', { cacheDir, fetchImpl: impl, url });
    expect(calls).toEqual([url]);
    expect(path.endsWith('FoodData_Central_foundation_food_json_2030-01-01.zip')).toBe(true);
  });
});

describe('cache location', () => {
  it('defaults to the git-ignored tools/importer/.cache', async () => {
    const { defaultCacheDir } = await import('./download');
    expect(defaultCacheDir().replace(/\\/g, '/')).toMatch(/tools\/importer\/\.cache$/);
    await writeFile(join(await tmp(), 'x'), ''); // keep tmp helper exercised
  });
});
