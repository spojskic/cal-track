// Command line parsing for the probe. The API key is NEVER read from argv (it would end up in shell history and
// process listings): it comes from the GARMIN_PERSONAL_API_KEY environment variable only.

import { isAbsolute, resolve } from 'node:path';
import { ENDPOINT_IDS, isEndpointId, type EndpointId } from '@cal/garmin';

export interface ProbeArgs {
  /** Number of days ending today (1-365). */
  days: number;
  /** Absolute output directory. */
  outDir: string;
  /** Write real values (personal health data). Default: structure only. */
  raw: boolean;
  /** Print the normalized output (values!) to the console. */
  mapped: boolean;
  /** Endpoints to call. */
  endpoints: EndpointId[];
  /** Use the China host. */
  cn: boolean;
  help: boolean;
}

export type ParseResult = { ok: true; args: ProbeArgs } | { ok: false; error: string };

export const DEFAULT_DAYS = 3;
export const MAX_DAYS_ARG = 365;

export const USAGE = `Usage: pnpm --filter @cal/garmin-probe run probe -- [options]

Reads the key from the GARMIN_PERSONAL_API_KEY environment variable (never from arguments).

Options
  --days N            Days to fetch, ending today (default ${DEFAULT_DAYS}, max ${MAX_DAYS_ARG})
  --out DIR           Output directory (default: tools/garmin-probe/out, git-ignored)
  --structure-only    Write only key paths + types (default; safe to share)
  --raw               Write REAL values. Contains personal health data. Never share or commit.
  --endpoints a,b     Only these endpoints (default: all). Ids: ${ENDPOINT_IDS.join(', ')}
  --mapped            Print what the mappers produce (contains your values, console only)
  --cn                Use the China host (personal.connectapi.garmin.cn)
  --help              Show this help
`;

const KEY_FLAGS = new Set(['--key', '--api-key', '--apikey', '--token', '--garmin-key', '--personal-api-key']);

export function parseProbeArgs(argv: readonly string[], ctx: { defaultOutDir: string; baseDir: string }): ParseResult {
  const args: ProbeArgs = { days: DEFAULT_DAYS, outDir: ctx.defaultOutDir, raw: false, mapped: false, endpoints: [...ENDPOINT_IDS], cn: false, help: false };
  let structureOnly = false;
  const list = [...argv];
  // Checked up front so that a key can never be swallowed as the value of another option.
  if (list.some((arg) => /GCDC_/i.test(arg))) {
    return { ok: false, error: 'Do not pass the key on the command line. Set GARMIN_PERSONAL_API_KEY in the environment instead.' };
  }
  for (let i = 0; i < list.length; i++) {
    const arg = list[i] as string;
    if (arg === '--') continue;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    if (KEY_FLAGS.has(name)) {
      return { ok: false, error: 'Never pass the key as an argument. Set GARMIN_PERSONAL_API_KEY in the environment instead.' };
    }
    const value = (): string | undefined => {
      if (inline !== undefined) return inline;
      const next = list[i + 1];
      if (next === undefined || next.startsWith('--')) return undefined;
      i += 1;
      return next;
    };
    switch (name) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--raw':
        args.raw = true;
        break;
      case '--structure-only':
        structureOnly = true;
        break;
      case '--mapped':
        args.mapped = true;
        break;
      case '--cn':
        args.cn = true;
        break;
      case '--days': {
        const v = value();
        const n = v !== undefined && /^\d+$/.test(v) ? Number(v) : NaN;
        if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS_ARG) return { ok: false, error: `--days needs a whole number between 1 and ${MAX_DAYS_ARG}.` };
        args.days = n;
        break;
      }
      case '--out': {
        const v = value();
        if (!v) return { ok: false, error: '--out needs a directory.' };
        args.outDir = isAbsolute(v) ? v : resolve(ctx.baseDir, v);
        break;
      }
      case '--endpoints': {
        const v = value();
        if (!v) return { ok: false, error: '--endpoints needs a comma-separated list.' };
        const ids = v.split(',').map((s) => s.trim()).filter(Boolean);
        const bad = ids.filter((s) => !isEndpointId(s));
        if (bad.length) return { ok: false, error: `Unknown endpoint(s): ${bad.join(', ')}. Valid: ${ENDPOINT_IDS.join(', ')}.` };
        if (!ids.length) return { ok: false, error: '--endpoints needs at least one id.' };
        args.endpoints = [...new Set(ids)] as EndpointId[];
        break;
      }
      default:
        return { ok: false, error: `Unknown option: ${name}. Use --help.` };
    }
  }
  if (structureOnly && args.raw) return { ok: false, error: '--raw and --structure-only contradict each other.' };
  return { ok: true, args };
}
