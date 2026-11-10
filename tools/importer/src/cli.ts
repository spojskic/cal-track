#!/usr/bin/env tsx
/**
 * @cal/importer CLI.
 *
 *   pnpm --filter @cal/importer import -- <command> [options]
 *
 * Commands: download, fdc, cnf, cofid (TODO), all, help. See README.md.
 */
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadCnf, type CnfFactorMode } from './cnf';
import { redactSecrets, urlSecrets } from './db';
import { FDC_DATASETS, isFdcDatasetId, type FdcDatasetId, type FdcFormat } from './fdc';
import { FDC_DOWNLOADS, defaultCacheDir, downloadFdc, findCachedArchive } from './download';
import { loadFdcArchive } from './load';
import { runJobs, type ImportJob } from './run';
import { withSource } from './source';
import type { Logger } from './types';

const HELP = `Usage: pnpm --filter @cal/importer run import -- <command> [options]

Commands
  download <foundation|sr_legacy|fndds>   Download an FDC archive into tools/importer/.cache
        [--format json|csv] [--cache-dir DIR] [--force] [--url URL]
        JSON (default) is small and complete; csv exists for sr_legacy / fndds only
  fdc --path <zip|dir|.json> [--dataset <foundation|sr_legacy|fndds>]
                                          Import one FDC dataset. JSON vs CSV is detected from the
                                          archive contents; --dataset is optional for JSON
  cnf --path <dir|zip>                    Import the Canadian Nutrient File 2015 CSV files
        [--encoding auto|utf8|latin1] [--cnf-factor-mode auto|multiplier|grams]
  cofid                                   UK CoFID (Excel) - NOT IMPLEMENTED YET
  all [--cache-dir DIR] [--cnf-path P] [--only a,b] [--download]
                                          foundation -> sr_legacy -> fndds -> cnf from the cache
  help

Common options (fdc, cnf, all)
  --dry-run          Parse and report only; never connect to the database
  --limit N          Only the first N foods of each dataset (testing)
  --db-url URL       Postgres URL (default: env SUPABASE_DB_URL). Never printed.
  --batch-size N     Foods per transaction (default 500)
  --no-ssl           Disable TLS to the database (default: TLS unless localhost)

Importing order: foundation, sr_legacy, fndds, cnf.`;

interface Io {
  log: Logger;
  error: Logger;
  env: NodeJS.ProcessEnv;
}

const consoleIo: Io = {
  log: (m) => console.log(m),
  error: (m) => console.error(m),
  env: process.env,
};

/** Loads KEY=VALUE files without overriding variables that are already set. */
function loadEnvFiles(): void {
  const here = fileURLToPath(new URL('..', import.meta.url));
  for (const file of [join(here, '.env'), join(here, '..', '..', '.env')]) {
    if (existsSync(file)) {
      try {
        process.loadEnvFile(file);
      } catch {
        // unreadable .env: ignore, flags / real env still work
      }
    }
  }
}

class UsageError extends Error {}

const OPTIONS = {
  dataset: { type: 'string' },
  path: { type: 'string' },
  'cnf-path': { type: 'string' },
  'cache-dir': { type: 'string' },
  'db-url': { type: 'string' },
  'batch-size': { type: 'string' },
  limit: { type: 'string' },
  encoding: { type: 'string' },
  'cnf-factor-mode': { type: 'string' },
  url: { type: 'string' },
  format: { type: 'string' },
  only: { type: 'string' },
  'dry-run': { type: 'boolean' },
  force: { type: 'boolean' },
  download: { type: 'boolean' },
  'no-ssl': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

function positiveInt(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new UsageError(`--${name} must be a positive integer`);
  return Number(value);
}

function requireString(name: string, value: string | undefined): string {
  if (value === undefined || value === '') throw new UsageError(`--${name} is required`);
  return value;
}

/** Runs the CLI. Returns the process exit code (0 ok, 1 failure, 2 usage error). */
export async function main(rawArgs: string[], io: Io = consoleIo): Promise<number> {
  // `pnpm run import -- fdc ...` forwards the literal "--"; drop it.
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  let dbUrl: string | undefined;
  try {
    const { values, positionals } = parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
    const [command, ...rest] = positionals;
    if (command === undefined || command === 'help' || values.help) {
      io.log(HELP);
      return command === undefined && !values.help ? 2 : 0;
    }

    const log = io.log;
    const limit = positiveInt('limit', values.limit);
    const batchSize = positiveInt('batch-size', values['batch-size']);
    const dryRun = values['dry-run'] === true;
    dbUrl = values['db-url'] ?? io.env.SUPABASE_DB_URL;
    // `pnpm --filter` runs in tools/importer; paths typed by the user are relative to where pnpm was started.
    const base = io.env.INIT_CWD ?? process.cwd();
    const userPath = (p: string): string => resolve(base, p);
    const cacheDir = values['cache-dir'] ? userPath(values['cache-dir']) : defaultCacheDir();

    const runOptions = {
      dryRun,
      log,
      ...(dbUrl ? { dbUrl } : {}),
      ...(batchSize !== undefined ? { batchSize } : {}),
      ...(values['no-ssl'] ? { ssl: false } : {}),
    };

    const fdcJob = (dataset: FdcDatasetId | undefined, path: string): ImportJob => ({
      label: dataset ? FDC_DATASETS[dataset].label : 'FoodData Central',
      load: () =>
        withSource(userPath(path), (src) =>
          loadFdcArchive(src, { log, ...(dataset ? { dataset } : {}), ...(limit !== undefined ? { limit } : {}) }),
        ),
    });
    const cnfJob = (path: string): ImportJob => ({
      label: 'Canadian Nutrient File 2015',
      load: () =>
        withSource(userPath(path), (src) =>
          loadCnf(src, {
            log,
            ...(values.encoding ? { encoding: values.encoding } : {}),
            ...(values['cnf-factor-mode'] ? { factorMode: parseFactorMode(values['cnf-factor-mode']) } : {}),
            ...(limit !== undefined ? { limit } : {}),
          }),
        ),
    });

    switch (command) {
      case 'download': {
        const dataset = rest[0] ?? '';
        if (!isFdcDatasetId(dataset)) {
          throw new UsageError(`download needs one of: ${Object.keys(FDC_DOWNLOADS).join(', ')}`);
        }
        const format = parseFormat(values.format);
        if (format === 'csv' && !FDC_DOWNLOADS[dataset].csv) {
          throw new UsageError(
            `${dataset} has no usable CSV archive (the Foundation CSV zip of Oct 2026 is incomplete) - use the JSON archive`,
          );
        }
        await downloadFdc(dataset, {
          cacheDir,
          log,
          format,
          ...(values.force ? { force: true } : {}),
          ...(values.url ? { url: values.url } : {}),
        });
        return 0;
      }

      case 'fdc': {
        let dataset: FdcDatasetId | undefined;
        if (values.dataset !== undefined) {
          if (!isFdcDatasetId(values.dataset)) {
            throw new UsageError(`--dataset must be one of: ${Object.keys(FDC_DATASETS).join(', ')}`);
          }
          dataset = values.dataset;
        }
        const { report } = await runJobs([fdcJob(dataset, requireString('path', values.path))], runOptions);
        log(`\n${report}`);
        return 0;
      }

      case 'cnf': {
        const { report } = await runJobs([cnfJob(requireString('path', values.path))], runOptions);
        log(`\n${report}`);
        return 0;
      }

      case 'cofid': {
        // TODO(cofid): UK CoFID 2021 ships as Excel (.xlsx) only. Implement an
        // xlsx reader (e.g. exceljs), map the proximates/vitamins/inorganics
        // sheets to catalog codes (carb_basis 'excludes_fiber' - CoFID carbohydrate is
        // available carbohydrate, expressed as monosaccharide equivalents),
        // and import with source 'cofid'. Out of scope for now.
        io.error(
          'UK CoFID (Excel) import is not implemented yet (TODO in src/cli.ts). ' +
            'Use the foundation, sr_legacy, fndds and cnf commands.',
        );
        return 2;
      }

      case 'all': {
        const order: Array<FdcDatasetId | 'cnf'> = ['foundation', 'sr_legacy', 'fndds', 'cnf'];
        const only = values.only ? new Set(values.only.split(',').map((s) => s.trim())) : null;
        for (const name of only ?? []) {
          if (!(order as string[]).includes(name)) throw new UsageError(`--only: unknown dataset "${name}"`);
        }
        const jobs: ImportJob[] = [];
        for (const name of order.filter((n) => !only || only.has(n))) {
          if (name === 'cnf') {
            const cnfPath = values['cnf-path'] ? userPath(values['cnf-path']) : findCnf(cacheDir);
            if (cnfPath === null) {
              log(`CNF skipped: no CNF files found (put the CSV files in ${join(cacheDir, 'cnf')} or pass --cnf-path; see README).`);
              continue;
            }
            jobs.push(cnfJob(cnfPath));
            continue;
          }
          let zip = findCachedArchive(name, cacheDir);
          if (zip === null) {
            if (!values.download) {
              throw new UsageError(
                `No archive for ${name} in ${cacheDir}. Run "download ${name}" first or pass --download to fetch missing archives.`,
              );
            }
            zip = await downloadFdc(name, { cacheDir, log });
          }
          jobs.push(fdcJob(name, zip));
        }
        if (jobs.length === 0) throw new UsageError('nothing to import');
        const { report } = await runJobs(jobs, runOptions);
        log(`\n${report}`);
        return 0;
      }

      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (err) {
    if (err instanceof UsageError || (err instanceof TypeError && (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS'))) {
      io.error(`Error: ${(err as Error).message}\n\n${HELP}`);
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    io.error(`Error: ${dbUrl ? redactSecrets(message, urlSecrets(dbUrl)) : message}`);
    if (dbUrl && /ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT/.test(message) && /@db\.[a-z0-9]+\.supabase\.co[:/]/i.test(dbUrl)) {
      io.error(
        '\nHint: that is the DIRECT database host, which is IPv6-only on the free plan, so most home networks cannot reach it.\n' +
          'Use the SESSION POOLER string instead (Supabase dashboard -> Connect -> Session pooler): the host looks like\n' +
          'aws-0-<region>.pooler.supabase.com, the user is postgres.<project-ref>, the port is 5432.',
      );
    }
    return 1;
  }
}

function parseFormat(value: string | undefined): FdcFormat {
  if (value === undefined || value === 'json') return 'json';
  if (value === 'csv') return 'csv';
  throw new UsageError('--format must be json or csv');
}

function parseFactorMode(value: string): CnfFactorMode {
  if (value === 'auto' || value === 'multiplier' || value === 'grams') return value;
  throw new UsageError('--cnf-factor-mode must be auto, multiplier or grams');
}

/** `<cache>/cnf` directory or `<cache>/cnf.zip` or any `<cache>/*nutrient*file*.zip`. */
function findCnf(cacheDir: string): string | null {
  for (const candidate of [join(cacheDir, 'cnf'), join(cacheDir, 'cnf.zip')]) {
    if (existsSync(candidate) && (statSync(candidate).isDirectory() || candidate.endsWith('.zip'))) return candidate;
  }
  return null;
}

const entry = process.argv[1];
if (entry && resolve(entry) === fileURLToPath(import.meta.url)) {
  loadEnvFiles();
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
