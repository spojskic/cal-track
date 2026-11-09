/** Small, pure formatting helpers for the coach screens. */

/** "Just now", "5 min ago", "3 h ago", "Yesterday", "Mon" (this week) or "Nov 3". */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const ms = then.getTime();
  if (!Number.isFinite(ms)) return '';
  const diff = now.getTime() - ms;
  if (diff < 45_000) return 'Just now';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  const hours = Math.round(diff / 3_600_000);
  if (hours < 24 && then.getDate() === now.getDate()) return `${hours} h ago`;

  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayGap = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
  if (dayGap === 1) return 'Yesterday';
  if (dayGap > 1 && dayGap < 7) return then.toLocaleDateString(undefined, { weekday: 'short' });
  const sameYear = then.getFullYear() === now.getFullYear();
  return then.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** One-line preview of a message: markdown marks and line breaks removed. */
export function previewOf(content: string, max = 90): string {
  const flat = content
    .replace(/^\s*(?:[-*\u2022+]|\d{1,3}[.)])\s+/gm, '')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}\u2026` : flat;
}
