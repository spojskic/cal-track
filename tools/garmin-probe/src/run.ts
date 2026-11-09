// The probe's logic, separated from process/fs so it can be tested with a fake fetch and an in-memory writer.

import { join } from 'node:path';
import {
  addDays,
  createGarminClient,
  fetchEndpointRange,
  formatYmd,
  GARMIN_BASE_URL_CN,
  GARMIN_ENDPOINTS,
  isFatalAuthError,
  mergeCoverage,
  mergeDiagnostics,
  redactSecrets,
  toGarminError,
  type EndpointMapped,
  type FetchLike,
  type GarminDiagnostic,
  type GarminFieldCoverage,
  type GarminSyncError,
} from '@cal/garmin';
import type { ProbeArgs } from './args';
import { formatEndpointReport } from './report';
import { listKeyPaths, summarizeStructure } from './structure';

export interface ProbeIO {
  log(line: string): void;
  mkdir(dir: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
}

export interface RunProbeOptions {
  args: ProbeArgs;
  /** Value of GARMIN_PERSONAL_API_KEY. */
  apiKey: string | undefined;
  io: ProbeIO;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/** Per-day endpoints (one request per date) are probed for at most this many recent days. */
export const PER_DAY_WINDOW = 7;

export const RAW_WARNING =
  'WARNING: --raw writes your REAL values (weight, heart rate, sleep, activities ...). This is personal health data. Do not share these files and do not commit them.';

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '_');

/** Returns the process exit code: 0 ok, 1 failed, 2 usage. */
export async function runProbe(o: RunProbeOptions): Promise<number> {
  const { args, io } = o;
  const key = o.apiKey?.trim();
  if (!key) {
    io.log('GARMIN_PERSONAL_API_KEY is not set. Create a key at https://connect.garmin.com/app/settings/personalApiToken and export it:');
    io.log('  export GARMIN_PERSONAL_API_KEY=GCDC_...');
    return 2;
  }
  const scrub = (s: string): string => redactSecrets(s, [key]);
  const say = (line: string): void => io.log(scrub(line));

  if (args.raw) say(RAW_WARNING);

  const client = createGarminClient({
    apiKey: key,
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
    ...(args.cn ? { baseUrl: GARMIN_BASE_URL_CN } : {}),
  });

  const check = await client.validate();
  if (!check.ok) {
    say(`Key check failed (${check.error.kind}${check.error.status !== undefined ? `, HTTP ${check.error.status}` : ''}): ${check.error.userMessage}`);
    return 1;
  }
  say(`Key accepted. Account: ${check.displayName ?? '(name not available)'}. Token valid until ${new Date(check.tokenExpiresAtMs).toISOString()}.`);
  if (check.profileError) say(`Note: the profile read failed (${check.profileError.kind}): ${check.profileError.userMessage}`);

  const now = o.now?.() ?? new Date();
  const to = formatYmd({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() });
  const from = addDays(to, -(args.days - 1));
  say(`Range: ${from} .. ${to} (${args.days} day${args.days === 1 ? '' : 's'}). Mode: ${args.raw ? 'RAW VALUES' : 'structure only'}.`);

  await io.mkdir(args.outDir);
  const reports: string[] = [];
  const pathsDump: string[] = [];
  const filesWritten: string[] = [];
  const mappedOut: Record<string, EndpointMapped> = {};
  let requests = 0;

  for (const id of args.endpoints) {
    const spec = GARMIN_ENDPOINTS[id];
    const epFrom = spec.kind === 'perDay' ? (args.days > PER_DAY_WINDOW ? addDays(to, -(PER_DAY_WINDOW - 1)) : from) : from;
    let result;
    try {
      result = await fetchEndpointRange(client, id, epFrom, to);
    } catch (e) {
      const err = toGarminError(e, [key]);
      if (isFatalAuthError(err)) {
        say(`Stopped: ${err.userMessage} (${err.kind})`);
        return 1;
      }
      result = { chunks: [], errors: [{ endpoint: id, kind: err.kind, retryable: err.retryable, message: err.userMessage } as GarminSyncError], requests: 1 };
    }
    requests += result.requests;

    const coverageParts: GarminFieldCoverage[][] = [];
    const diagParts: GarminDiagnostic[][] = [];
    let responses = 0;
    const combined: EndpointMapped = { diagnostics: [], coverage: [] };
    for (const chunk of result.chunks) {
      const req = spec.request({ start: chunk.start, end: chunk.end }, chunk.page !== undefined ? { start: chunk.page * 100, limit: 100 } : undefined);
      const base = `${safeName(id)}__${chunk.start}_${chunk.end}${chunk.page !== undefined ? `__p${chunk.page}` : ''}`;
      const structure = chunk.raw === null ? null : summarizeStructure(chunk.raw);
      if (chunk.raw !== null) responses += 1;
      const doc = { endpoint: id, request: { path: req.path, params: req.params ?? {} }, empty: chunk.raw === null, structure };
      await io.writeFile(join(args.outDir, `${base}.structure.json`), `${JSON.stringify(doc, null, 2)}\n`);
      filesWritten.push(`${base}.structure.json`);
      pathsDump.push(`# ${base}`, ...listKeyPaths(structure), '');
      if (args.raw) {
        await io.writeFile(join(args.outDir, `${base}.raw.json`), `${JSON.stringify(chunk.raw, null, 2)}\n`);
        filesWritten.push(`${base}.raw.json`);
      }
      if (spec.map && chunk.raw !== null) {
        const m = spec.map(chunk.raw, { date: chunk.start });
        coverageParts.push(m.coverage);
        diagParts.push(m.diagnostics);
        if (m.energy) (combined.energy ??= []).push(...m.energy);
        if (m.biometrics) (combined.biometrics ??= []).push(...m.biometrics);
        if (m.workouts) (combined.workouts ??= []).push(...m.workouts);
      }
    }
    const coverage = mergeCoverage(...coverageParts);
    const diagnostics = mergeDiagnostics(...diagParts);
    if (spec.map) mappedOut[id] = { ...combined, diagnostics, coverage };

    const report = formatEndpointReport({
      endpoint: id,
      title: spec.title,
      requests: result.requests,
      responses,
      coverage,
      diagnostics,
      errors: result.errors,
      unmapped: !spec.map,
      redactValues: !args.raw,
    });
    reports.push(report);
    say(report);
  }

  await io.writeFile(join(args.outDir, 'report.txt'), `${reports.join('\n\n')}\n`);
  await io.writeFile(join(args.outDir, 'structure-paths.txt'), `${pathsDump.join('\n')}\n`);
  filesWritten.push('report.txt', 'structure-paths.txt');

  if (args.mapped) {
    say('');
    say('Mapped output (contains your values, shown here only):');
    for (const [id, m] of Object.entries(mappedOut)) {
      const { diagnostics: _d, coverage: _c, ...data } = m;
      void _d;
      void _c;
      say(`-- ${id}`);
      say(JSON.stringify(data, null, 2));
    }
  }

  say('');
  say(`Done: ${requests} request(s), ${filesWritten.length} file(s) in ${args.outDir}`);
  if (args.raw) {
    say(RAW_WARNING);
  } else {
    say('To help fix the field mapping, share report.txt, structure-paths.txt and the *.structure.json files. They contain key names, types and number sizes, but no values.');
  }
  return 0;
}
