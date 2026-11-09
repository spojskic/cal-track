/** Locating a Chrome / Chromium binary for playwright-core (which downloads none). */
import { existsSync } from 'node:fs';

export const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export interface ChromeResolveInput {
  /** `--chrome=<path>` */
  flag?: string | undefined;
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
  /** Playwright's own browser cache (chromium.executablePath()). */
  playwrightPath?: () => string | undefined;
}

export type ChromeResolution =
  | { ok: true; path: string; source: 'flag' | 'env' | 'default' | 'playwright' }
  | { ok: false; error: string; tried: string[] };

/** Order: --chrome flag, CHROME_PATH, the macOS application, Playwright's own cache. */
export function resolveChrome(input: ChromeResolveInput = {}): ChromeResolution {
  const exists = input.exists ?? existsSync;
  const env = input.env ?? process.env;
  const tried: string[] = [];

  if (input.flag) {
    tried.push(`--chrome=${input.flag}`);
    return exists(input.flag)
      ? { ok: true, path: input.flag, source: 'flag' }
      : { ok: false, error: `--chrome path does not exist: ${input.flag}`, tried };
  }
  const fromEnv = env.CHROME_PATH;
  if (fromEnv) {
    tried.push(`CHROME_PATH=${fromEnv}`);
    if (exists(fromEnv)) return { ok: true, path: fromEnv, source: 'env' };
  }
  tried.push(MAC_CHROME);
  if (exists(MAC_CHROME)) return { ok: true, path: MAC_CHROME, source: 'default' };

  let cached: string | undefined;
  try {
    cached = input.playwrightPath?.();
  } catch {
    cached = undefined;
  }
  if (cached) {
    tried.push(`playwright cache: ${cached}`);
    if (exists(cached)) return { ok: true, path: cached, source: 'playwright' };
  }
  return {
    ok: false,
    error: 'No Chrome found. Pass --chrome=<path>, set CHROME_PATH, install Google Chrome, or run `npx playwright-core install chromium`.',
    tried,
  };
}
