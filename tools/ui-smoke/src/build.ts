/** Builds the web export of the app with the env of the mocked backend (child process, no sockets of ours). */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { BUILD_ENV } from './constants';

export interface BuildResult {
  ok: boolean;
  durationMs: number;
  /** Last lines of the build output. */
  tail: string;
  logFile: string;
}

/** True when `dir` looks like an Expo web export (index.html + a JS bundle). */
export function isValidExport(dir: string): { ok: boolean; reason?: string } {
  if (!existsSync(join(dir, 'index.html'))) return { ok: false, reason: `${dir}/index.html is missing` };
  const jsDir = join(dir, '_expo', 'static', 'js', 'web');
  if (!existsSync(jsDir) || !readdirSync(jsDir).some((f) => f.endsWith('.js'))) {
    return { ok: false, reason: `${jsDir}/*.js is missing` };
  }
  return { ok: true };
}

/** Only ever delete a directory that is empty, absent or clearly an export of ours. */
function safeToClear(dir: string): boolean {
  if (!existsSync(dir)) return true;
  if (!statSync(dir).isDirectory()) return false;
  const entries = readdirSync(dir);
  return entries.length === 0 || entries.includes('index.html');
}

export async function buildWebExport(opts: {
  appDir: string;
  distDir: string;
  logFile: string;
  /** Clear the Metro cache first (default): EXPO_PUBLIC_* values are inlined at transform time, a stale cache would bake in other values. */
  clearCache?: boolean;
  onLine?: (line: string) => void;
}): Promise<BuildResult> {
  const distDir = resolve(opts.distDir);
  if (!safeToClear(distDir)) {
    return { ok: false, durationMs: 0, tail: `Refusing to overwrite ${distDir}: it is not empty and not a previous export. Choose another --dist.`, logFile: opts.logFile };
  }
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(dirname(opts.logFile), { recursive: true });
  const log = createWriteStream(opts.logFile);
  const started = Date.now();
  const tail: string[] = [];
  const push = (chunk: Buffer) => {
    log.write(chunk);
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim() === '') continue;
      tail.push(line);
      if (tail.length > 60) tail.shift();
      opts.onLine?.(line);
    }
  };
  const code = await new Promise<number>((resolveExit) => {
    const args = ['expo', 'export', '--platform', 'web', '--output-dir', distDir, ...(opts.clearCache === false ? [] : ['--clear'])];
    const child = spawn('npx', args, {
      cwd: opts.appDir,
      env: { ...process.env, ...BUILD_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (e) => {
      tail.push(`spawn failed: ${e.message}`);
      resolveExit(1);
    });
    child.on('close', (c) => resolveExit(c ?? 1));
  });
  await new Promise<void>((r) => log.end(r));
  const valid = code === 0 ? isValidExport(distDir) : { ok: false, reason: `expo export exited with code ${code}` };
  if (!valid.ok) tail.push(valid.reason ?? 'invalid export');
  return { ok: valid.ok, durationMs: Date.now() - started, tail: tail.slice(-40).join('\n'), logFile: opts.logFile };
}
