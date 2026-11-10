// Pure (no React Native imports): the texts of the thin status bar at the bottom of the desktop window. components/desktop/StatusBar.tsx
// reads the live values (sync state, AI gate, palette, version) and only draws what these functions return.

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** Between the items of the status bar. */
export const STATUS_SEPARATOR = '\u00B7';

export const NOT_SYNCED_TEXT = 'Not synced';
export const SYNCING_TEXT = 'Syncing\u2026';

const pad = (n: number): string => String(n).padStart(2, '0');

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime();
}

/** Whole calendar days from `a` to `b` (local dates; a daylight-saving change does not make a day 23 or 25 hours). */
function calendarDaysBetween(a: Date, b: Date): number {
  return Math.round((startOfDay(b) - startOfDay(a)) / 86_400_000);
}

/**
 * The left side of the status bar: when the last sync finished, in the words of a status line.
 *  - "Syncing..." while one runs,
 *  - "Not synced" when no connected source has ever synced,
 *  - "Synced just now" / "Synced 12 min ago" within the hour, "Synced today at 14:32", "Synced yesterday at 14:32",
 *  - "Synced on Oct 20" (with the year when it is not this year) for anything older.
 * `now` is a parameter so the text is a pure function of its input.
 */
export function formatSyncStatus({ syncing, lastSyncAt, now }: { syncing: boolean; lastSyncAt: Date | null; now: Date }): string {
  if (syncing) return SYNCING_TEXT;
  if (!lastSyncAt || Number.isNaN(lastSyncAt.getTime())) return NOT_SYNCED_TEXT;
  const seconds = Math.round((now.getTime() - lastSyncAt.getTime()) / 1000);
  // A clock a little ahead of the server's counts as "just now" too.
  if (seconds < 45) return 'Synced just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Synced ${minutes} min ago`;
  const clock = `${pad(lastSyncAt.getHours())}:${pad(lastSyncAt.getMinutes())}`;
  const days = calendarDaysBetween(lastSyncAt, now);
  if (days <= 0) return `Synced today at ${clock}`;
  if (days === 1) return `Synced yesterday at ${clock}`;
  const date = `${MONTHS_SHORT[lastSyncAt.getMonth()]} ${lastSyncAt.getDate()}`;
  return lastSyncAt.getFullYear() === now.getFullYear() ? `Synced on ${date}` : `Synced on ${date}, ${lastSyncAt.getFullYear()}`;
}

/** The newest of some dates; null when there is none. */
export function newestDate(dates: readonly (Date | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const d of dates) {
    if (!d || Number.isNaN(d.getTime())) continue;
    if (best === null || d.getTime() > best.getTime()) best = d;
  }
  return best;
}

export function aiStatusText(enabled: boolean): string {
  return enabled ? 'AI: on' : 'AI: off';
}

/** "v1.0.7" for "1.0.7" (also for "v1.0.7"); empty when the version is unknown. */
export function versionText(version: string | null | undefined): string {
  const v = (version ?? '').trim();
  if (v === '') return '';
  return /^v/i.test(v) ? v : `v${v}`;
}

/** The right side of the status bar, left to right: AI status, the colour theme and the app version (an unknown one is left out). */
export function buildStatusRight({
  aiEnabled,
  paletteName,
  version,
}: {
  aiEnabled: boolean;
  paletteName: string | null | undefined;
  version: string | null | undefined;
}): string[] {
  return [aiStatusText(aiEnabled), (paletteName ?? '').trim(), versionText(version)].filter((item) => item !== '');
}
