/** Command line parsing for `pnpm --filter @cal/ui-smoke smoke [-- flags]`. */

export interface CliOptions {
  skipBuild: boolean;
  only?: string;
  out: string;
  chrome?: string;
  dist: string;
  viewports?: string[];
  headed: boolean;
  list: boolean;
  help: boolean;
  /** How console.error counts: fail (default) or warn. */
  consoleErrors: 'fail' | 'warn';
  /** Per scenario run, milliseconds. */
  timeoutMs: number;
  /** Scenario runs in parallel (each in its own browser context). */
  workers: number;
  /** Keep the Metro cache for the export (default: cleared so env values cannot be stale). */
  keepCache: boolean;
}

export const DEFAULT_OUT = '/tmp/cal-ui-smoke';
export const DEFAULT_DIST = '/tmp/cal-ui-smoke-dist';

export const USAGE = `Usage: pnpm --filter @cal/ui-smoke smoke [-- options]

  --skip-build          reuse the existing web export (--dist)
  --keep-cache          do not pass --clear to expo export (faster rebuilds; EXPO_PUBLIC_* may be stale)
  --only=<substring>    only scenarios whose name or path contains the text (case-insensitive)
  --out=<dir>           screenshots + report.json/report.md (default ${DEFAULT_OUT})
  --dist=<dir>          web export directory (default ${DEFAULT_DIST})
  --chrome=<path>       Chrome executable (default: $CHROME_PATH, macOS Google Chrome, Playwright cache)
  --viewports=a,b       phone, desktop, phone-dark, desktop-dark (default phone,desktop)
  --console-errors=warn treat console.error as WARN instead of FAIL
  --timeout=<seconds>   limit per scenario run (default 120)
  --workers=<n>         scenario runs in parallel (default 2)
  --headed              show the browser
  --list                print the scenarios and the route coverage, then exit (needs no Chrome)
  --help
`;

export function parseArgs(argv: readonly string[]): { options: CliOptions; errors: string[] } {
  const options: CliOptions = {
    skipBuild: false,
    out: DEFAULT_OUT,
    dist: DEFAULT_DIST,
    headed: false,
    list: false,
    help: false,
    consoleErrors: 'fail',
    timeoutMs: 120_000,
    workers: 2,
    keepCache: false,
  };
  const errors: string[] = [];
  const args = [...argv];
  const take = (name: string, inline: string | undefined): string | undefined => {
    if (inline !== undefined) return inline;
    const next = args[0];
    if (next !== undefined && !next.startsWith('--')) {
      args.shift();
      return next;
    }
    errors.push(`--${name} needs a value`);
    return undefined;
  };

  while (args.length > 0) {
    const arg = args.shift() as string;
    if (arg === '--') continue;
    const m = /^--([a-z-]+)(?:=(.*))?$/s.exec(arg);
    if (!m) {
      errors.push(`unexpected argument "${arg}"`);
      continue;
    }
    const name = m[1] as string;
    const inline = m[2];
    switch (name) {
      case 'skip-build':
        options.skipBuild = true;
        break;
      case 'keep-cache':
        options.keepCache = true;
        break;
      case 'headed':
        options.headed = true;
        break;
      case 'list':
        options.list = true;
        break;
      case 'help':
        options.help = true;
        break;
      case 'only': {
        const v = take(name, inline);
        if (v !== undefined) options.only = v;
        break;
      }
      case 'out': {
        const v = take(name, inline);
        if (v) options.out = v;
        break;
      }
      case 'dist': {
        const v = take(name, inline);
        if (v) options.dist = v;
        break;
      }
      case 'chrome': {
        const v = take(name, inline);
        if (v) options.chrome = v;
        break;
      }
      case 'viewports': {
        const v = take(name, inline);
        if (v) options.viewports = v.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      }
      case 'console-errors': {
        const v = take(name, inline);
        if (v === 'warn' || v === 'fail') options.consoleErrors = v;
        else if (v !== undefined) errors.push('--console-errors must be "warn" or "fail"');
        break;
      }
      case 'timeout': {
        const v = take(name, inline);
        const n = Number(v);
        if (v !== undefined && Number.isFinite(n) && n > 0) options.timeoutMs = n * 1000;
        else if (v !== undefined) errors.push('--timeout must be a number of seconds');
        break;
      }
      case 'workers': {
        const v = take(name, inline);
        const n = Number(v);
        if (v !== undefined && Number.isInteger(n) && n >= 1 && n <= 8) options.workers = n;
        else if (v !== undefined) errors.push('--workers must be an integer between 1 and 8');
        break;
      }
      default:
        errors.push(`unknown option --${name}`);
    }
  }
  return { options, errors };
}
