// Entry point: node --import tsx src/probe.ts [options]   (see README.md)

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSecrets } from '@cal/garmin';
import { parseProbeArgs, USAGE } from './args';
import { runProbe } from './run';

const here = dirname(fileURLToPath(import.meta.url));
// pnpm runs scripts inside the package directory but remembers where it was invoked from.
const baseDir = process.env.INIT_CWD ?? process.cwd();

async function main(): Promise<number> {
  const parsed = parseProbeArgs(process.argv.slice(2), { defaultOutDir: resolve(here, '..', 'out'), baseDir });
  if (!parsed.ok) {
    console.error(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.args.help) {
    console.log(USAGE);
    return 0;
  }
  return runProbe({
    args: parsed.args,
    apiKey: process.env.GARMIN_PERSONAL_API_KEY,
    io: {
      log: (line) => console.log(line),
      mkdir: async (dir) => void (await mkdir(dir, { recursive: true })),
      writeFile: (path, content) => writeFile(path, content, 'utf8'),
    },
  });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const text = err instanceof Error ? err.message : String(err);
    console.error(`Probe crashed: ${redactSecrets(text, [process.env.GARMIN_PERSONAL_API_KEY ?? ''])}`);
    process.exitCode = 1;
  },
);
