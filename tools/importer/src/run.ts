/** Load -> (optionally) write -> report pipeline shared by all CLI commands. */
import { connectDb, getDatabaseSizeMb, writeFoods, type PgConnection, type WriteStats } from './db';
import { formatReport, summarize, type DatasetSummary } from './report';
import type { LoadResult, Logger } from './types';

export interface ImportJob {
  label: string;
  load(): Promise<LoadResult>;
}

export interface RunOptions {
  dryRun: boolean;
  dbUrl?: string;
  /** `false` disables SSL, `true` forces it; default depends on the host. */
  ssl?: boolean;
  batchSize?: number;
  log: Logger;
  /** Injected in tests. */
  connect?: (dbUrl: string, ssl?: boolean) => Promise<PgConnection>;
}

export interface RunResult {
  summaries: DatasetSummary[];
  report: string;
}

/** Runs the jobs one after another; connects to the database only when not a dry run. */
export async function runJobs(jobs: readonly ImportJob[], opts: RunOptions): Promise<RunResult> {
  if (!opts.dryRun && !opts.dbUrl) {
    throw new Error('No database URL: set SUPABASE_DB_URL or pass --db-url (or use --dry-run)');
  }
  const connect = opts.connect ?? connectDb;
  let conn: PgConnection | null = null;
  let dbBefore: number | null = null;
  const summaries: DatasetSummary[] = [];
  try {
    for (const job of jobs) {
      opts.log(`\n--- ${job.label} ---`);
      const loaded = await job.load();
      const { foods, stats } = loaded;
      const label = loaded.label ?? job.label;
      let write: WriteStats | undefined;
      if (!opts.dryRun) {
        if (conn === null) {
          conn = await connect(opts.dbUrl as string, opts.ssl);
          dbBefore = await getDatabaseSizeMb(conn.client);
        }
        opts.log(`Writing ${foods.length.toLocaleString('en-US')} foods ...`);
        write = await writeFoods(conn.client, foods, {
          log: opts.log,
          ...(opts.batchSize !== undefined ? { batchSize: opts.batchSize } : {}),
        });
      }
      summaries.push(summarize(label, foods, stats, write));
    }
    const dbAfter = conn ? await getDatabaseSizeMb(conn.client) : null;
    const report = formatReport(summaries, { dryRun: opts.dryRun, dbSizeMbBefore: dbBefore, dbSizeMbAfter: dbAfter });
    return { summaries, report };
  } finally {
    if (conn) await conn.end();
  }
}
