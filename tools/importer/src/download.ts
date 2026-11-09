/** Downloads FDC CSV archives into tools/importer/.cache (git-ignored). */
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { FdcDatasetId, FdcFormat } from './fdc';
import { openZipSource } from './source';
import type { Logger } from './types';

export interface DownloadTarget {
  url: string;
  /** Human readable size for the log. */
  approxSize: string;
}

const FDC_BASE = 'https://fdc.nal.usda.gov/fdc-datasets';

/**
 * Release URLs. JSON is the default (small and complete). The Foundation CSV
 * archive of the Oct 2026 release lacks food.csv / food_nutrient.csv /
 * food_portion.csv, so it is deliberately not offered. Newer releases appear at
 * https://fdc.nal.usda.gov/download-datasets - update here or pass --url.
 */
export const FDC_DOWNLOADS: Readonly<Record<FdcDatasetId, Partial<Record<FdcFormat, DownloadTarget>>>> = {
  foundation: {
    json: {
      url: `${FDC_BASE}/FoodData_Central_foundation_food_json_2026-10-29.zip`,
      approxSize: '~0.7 MB, 9 MB unzipped',
    },
  },
  sr_legacy: {
    json: { url: `${FDC_BASE}/FoodData_Central_sr_legacy_food_json_2018-04.zip`, approxSize: '~6 MB' },
    csv: { url: `${FDC_BASE}/FoodData_Central_sr_legacy_food_csv_2018-04.zip`, approxSize: '~6 MB, 40 MB unzipped' },
  },
  fndds: {
    json: {
      url: `${FDC_BASE}/FoodData_Central_survey_food_json_2024-10-31.zip`,
      approxSize: '~4 MB, 64 MB unzipped',
    },
    csv: {
      url: `${FDC_BASE}/FoodData_Central_survey_food_csv_2024-10-31.zip`,
      approxSize: 'large, ~200 MB (1.6 GB unzipped)',
    },
  },
};

/** The download target of a dataset/format; throws a helpful error for unsupported combinations. */
export function downloadTarget(dataset: FdcDatasetId, format: FdcFormat = 'json'): DownloadTarget {
  const target = FDC_DOWNLOADS[dataset][format];
  if (target === undefined) {
    throw new Error(
      dataset === 'foundation' && format === 'csv'
        ? 'The Foundation Foods CSV archive (Oct 2026) is incomplete - it has no food.csv / food_nutrient.csv / food_portion.csv. Use the JSON archive (the default).'
        : `No ${format} download is configured for ${dataset}`,
    );
  }
  return target;
}

/** `tools/importer/.cache` (git-ignored). */
export function defaultCacheDir(): string {
  return fileURLToPath(new URL('../.cache', import.meta.url));
}

/** Where the zip of a dataset lives in the cache. */
export function cachedZipPath(dataset: FdcDatasetId, cacheDir: string, format: FdcFormat = 'json', url?: string): string {
  return join(cacheDir, basename(new URL(url ?? downloadTarget(dataset, format).url).pathname));
}

/** The cached archive of a dataset: the JSON zip if present, else the CSV zip (SR Legacy / FNDDS); null if neither. */
export function findCachedArchive(dataset: FdcDatasetId, cacheDir: string): string | null {
  for (const format of ['json', 'csv'] as const) {
    if (FDC_DOWNLOADS[dataset][format] === undefined) continue;
    const path = cachedZipPath(dataset, cacheDir, format);
    if (existsSync(path)) return path;
  }
  return null;
}

/** True for `PK\x03\x04` (local file header) or `PK\x05\x06` (empty archive). */
export function hasZipMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))
  );
}

async function fileHasZipMagic(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buf, 0, 4, 0);
    return bytesRead === 4 && hasZipMagic(buf);
  } finally {
    await handle.close();
  }
}

/** Hint printed after a download: how to look for a newer release. */
export function newerReleaseHint(url: string): string {
  const release = /(\d{4}-\d{2}(?:-\d{2})?)\.zip$/.exec(url)?.[1] ?? 'unknown';
  return (
    `Release in the URL table: ${release}. A newer release may exist - check ` +
    'https://fdc.nal.usda.gov/download-datasets and update FDC_DOWNLOADS in src/download.ts (or pass --url).'
  );
}

export interface DownloadOptions {
  cacheDir?: string;
  /** `json` (default) or `csv` (sr_legacy / fndds only). */
  format?: FdcFormat;
  /** Overrides the URL of the dataset. */
  url?: string;
  /** Download again even if the file exists. */
  force?: boolean;
  fetchImpl?: typeof fetch;
  log?: Logger;
}

/** CSV files every usable FDC CSV archive must contain. */
const EXPECTED_CSV_FILES = ['food.csv', 'food_nutrient.csv', 'nutrient.csv'];

/** Checks that the file is a readable zip and warns when the expected data files are missing. */
export async function verifyFdcZip(path: string, format: FdcFormat = 'json'): Promise<string[]> {
  const source = await openZipSource(path);
  try {
    if (format === 'json') return source.jsonNames().length > 0 ? [] : ['no .json file found in the archive'];
    return EXPECTED_CSV_FILES.filter((f) => !source.has(f)).map((f) => `${f} not found in the archive`);
  } finally {
    await source.close();
  }
}

/** Downloads (or re-uses) the zip of a dataset and returns its path. */
export async function downloadFdc(dataset: FdcDatasetId, opts: DownloadOptions = {}): Promise<string> {
  const log: Logger = opts.log ?? (() => {});
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const format = opts.format ?? 'json';
  const target = downloadTarget(dataset, format);
  const url = opts.url ?? target.url;
  const dest = cachedZipPath(dataset, cacheDir, format, url);
  await mkdir(cacheDir, { recursive: true });

  try {
    const info = await stat(dest);
    if (!opts.force && info.size > 0 && (await fileHasZipMagic(dest))) {
      log(`Already downloaded: ${dest} (${(info.size / 1048576).toFixed(1)} MB). Use --force to download again.`);
      log(newerReleaseHint(url));
      return dest;
    }
  } catch {
    // not cached yet
  }

  log(`Downloading ${dataset} ${format.toUpperCase()} (${target.approxSize}) from ${url}`);
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok || res.body === null) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}. ${newerReleaseHint(url)}`);
  }
  const expected = Number(res.headers.get('content-length'));
  const part = `${dest}.part`;
  let received = 0;
  let nextLog = 0.1;
  const progress = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      if (Number.isFinite(expected) && expected > 0 && received / expected >= nextLog) {
        log(`  ${Math.round((received / expected) * 100)} % (${(received / 1048576).toFixed(1)} MB)`);
        nextLog += 0.1;
      }
      cb(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(res.body as never), progress, createWriteStream(part));
    if (received === 0) throw new Error('Downloaded file is empty');
    if (Number.isFinite(expected) && expected > 0 && received !== expected) {
      throw new Error(`Incomplete download: got ${received} of ${expected} bytes`);
    }
    if (!(await fileHasZipMagic(part))) {
      throw new Error('Downloaded file is not a zip archive (bad magic bytes) - the URL may have moved');
    }
    const problems = await verifyFdcZip(part, format);
    for (const p of problems) log(`  warning: ${p}`);
    await rename(part, dest);
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
  log(`Saved ${dest} (${(received / 1048576).toFixed(1)} MB)`);
  log(newerReleaseHint(url));
  return dest;
}
