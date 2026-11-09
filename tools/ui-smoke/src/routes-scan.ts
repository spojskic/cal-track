/**
 * Derives the expo-router route patterns from the file tree of `apps/app/src/app`, so the smoke run can warn
 * about screens that no scenario visits.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface FsRoute {
  /** e.g. `/food/[id]`, `/` for the index route. */
  pattern: string;
  /** File relative to the app dir, e.g. `food/[id].tsx`. */
  file: string;
}

const ROUTE_FILE = /\.(tsx|ts|jsx|js)$/;
const PLATFORM_SUFFIX = /\.(web|native|ios|android)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** `(app)/index.tsx` -> `/`, `food/[id].tsx` -> `/food/[id]`, `(auth)/sign-in.tsx` -> `/sign-in`. */
export function routePatternOf(relativeFile: string): string | null {
  const parts = relativeFile.split(sep).join('/').split('/');
  const fileName = parts.pop() as string;
  if (!ROUTE_FILE.test(fileName)) return null;
  const base = fileName.replace(ROUTE_FILE, '').replace(PLATFORM_SUFFIX, '');
  if (base.startsWith('_layout') || base.startsWith('+') || /\.(test|spec)$/.test(base)) return null;
  const segments = [...parts, base].filter((s) => !(s.startsWith('(') && s.endsWith(')'))).filter((s) => s !== 'index');
  return `/${segments.join('/')}`;
}

export function scanRoutes(appDir: string): FsRoute[] {
  const routes = new Map<string, FsRoute>();
  for (const full of walk(appDir)) {
    const file = relative(appDir, full);
    const pattern = routePatternOf(file);
    if (pattern !== null && !routes.has(pattern)) routes.set(pattern, { pattern, file: file.split(sep).join('/') });
  }
  return [...routes.values()].sort((a, b) => (a.pattern < b.pattern ? -1 : 1));
}

export interface RouteCoverage {
  /** Routes in the file tree that no scenario declares. */
  uncovered: FsRoute[];
  /** Scenario routes that do not exist in the file tree (stale scenarios). */
  unknown: string[];
}

export function compareRoutes(fsRoutes: readonly FsRoute[], scenarioRoutes: Iterable<string>): RouteCoverage {
  const declared = new Set(scenarioRoutes);
  const existing = new Set(fsRoutes.map((r) => r.pattern));
  return {
    uncovered: fsRoutes.filter((r) => !declared.has(r.pattern)),
    unknown: [...declared].filter((r) => !existing.has(r)).sort(),
  };
}
