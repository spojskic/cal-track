/** Auto-detecting entry point: JSON or CSV FDC archive, whichever the input contains. */
import { field, readCsvFile } from './csv';
import {
  FDC_DATASETS,
  REQUIRED_CSV,
  incompleteArchiveMessage,
  loadFdc,
  type FdcDatasetId,
  type FdcFormat,
} from './fdc';
import { loadFdcJson } from './fdcJson';
import type { FileSource } from './source';
import type { LoadResult, Logger } from './types';

export interface LoadArchiveOptions {
  /** Required for CSV unless it can be inferred from food.csv; optional for JSON. */
  dataset?: FdcDatasetId;
  limit?: number;
  log?: Logger;
}

export interface LoadArchiveResult extends LoadResult {
  dataset: FdcDatasetId;
  format: FdcFormat;
}

/** `food.data_type` of the first row that belongs to one of our datasets. */
export async function inferCsvDataset(src: FileSource): Promise<FdcDatasetId | undefined> {
  const byType = new Map(
    (Object.entries(FDC_DATASETS) as Array<[FdcDatasetId, (typeof FDC_DATASETS)[FdcDatasetId]]>).map(([id, cfg]) => [
      cfg.dataType,
      id,
    ]),
  );
  for await (const row of readCsvFile(src, 'food.csv', { encoding: 'utf8' })) {
    const id = byType.get(field(row, 'datatype'));
    if (id) return id;
  }
  return undefined;
}

/**
 * Picks the format from the archive contents: a `.json` file means the JSON
 * loader; otherwise the CSV tables must all be present (else an actionable
 * "archive is incomplete" error).
 */
export async function loadFdcArchive(src: FileSource, opts: LoadArchiveOptions = {}): Promise<LoadArchiveResult> {
  const log = opts.log;
  const limit = opts.limit !== undefined ? { limit: opts.limit } : {};
  const logOpt = log ? { log } : {};

  if (src.jsonNames().length > 0) {
    const res = await loadFdcJson(src, { ...(opts.dataset ? { dataset: opts.dataset } : {}), ...limit, ...logOpt });
    return { ...res, format: 'json' };
  }

  const absent = REQUIRED_CSV.filter((f) => !src.has(f));
  if (absent.length > 0) {
    const label = opts.dataset ? FDC_DATASETS[opts.dataset].label : 'FoodData Central';
    if (src.list().length === 0) {
      throw new Error('No FDC data found: expected one .json file (JSON archive) or the CSV tables (food.csv, ...)');
    }
    throw new Error(incompleteArchiveMessage(src, label, absent));
  }

  const dataset = opts.dataset ?? (await inferCsvDataset(src));
  if (dataset === undefined) {
    throw new Error('Cannot tell which dataset food.csv belongs to - pass --dataset <foundation|sr_legacy|fndds>');
  }
  const res = await loadFdc(src, { dataset, ...limit, ...logOpt });
  return { ...res, dataset, format: 'csv', label: FDC_DATASETS[dataset].label };
}
