/** Summaries, storage estimates and the final console report. */
import type { WriteStats } from './db';
import { DROP_REASONS, type DatasetStats, type ImportFood, type ImportSource } from './types';

/** Supabase free tier is 500 MB; warn well before that. */
export const DB_SOFT_LIMIT_MB = 300;

/**
 * Rough on-disk size of one food incl. its search columns, indexes and
 * portions, derived from JSON sizes:
 *  - heap: ~130 B tuple/uuid/short text columns + the jsonb (JSON text x1.5)
 *  - name appears in name, search_text, tsvector and two GIN indexes (~x11)
 *  - each portion row ~140 B + label
 * Order-of-magnitude (+-30 %) only.
 */
export function estimateFoodBytes(food: ImportFood): number {
  const json = Buffer.byteLength(JSON.stringify(food.nutrients), 'utf8');
  const name = Buffer.byteLength(food.name, 'utf8');
  const category = food.category ? Buffer.byteLength(food.category, 'utf8') : 0;
  let bytes = 130 + category + Math.round(json * 1.5) + name * 11;
  for (const p of food.portions) bytes += 140 + Buffer.byteLength(p.label, 'utf8');
  return bytes;
}

export interface DatasetSummary {
  source: ImportSource;
  label: string;
  stats: DatasetStats;
  kept: number;
  avgNutrients: number;
  avgCompleteness: number;
  avgPortions: number;
  estimatedBytes: number;
  write?: WriteStats;
}

export function summarize(label: string, foods: readonly ImportFood[], stats: DatasetStats, write?: WriteStats): DatasetSummary {
  const n = foods.length;
  let nutrients = 0;
  let completeness = 0;
  let portions = 0;
  let bytes = 0;
  for (const f of foods) {
    nutrients += Object.keys(f.nutrients).length;
    completeness += f.completeness;
    portions += f.portions.length;
    bytes += estimateFoodBytes(f);
  }
  return {
    source: stats.source,
    label,
    stats,
    kept: n,
    avgNutrients: n === 0 ? 0 : nutrients / n,
    avgCompleteness: n === 0 ? 0 : completeness / n,
    avgPortions: n === 0 ? 0 : portions / n,
    estimatedBytes: bytes,
    ...(write ? { write } : {}),
  };
}

const MB = 1024 * 1024;
export const toMb = (bytes: number): number => bytes / MB;

/** Warning text when the projected database size would pass the soft limit, else null. */
export function storageHint(estimatedMb: number, currentDbMb: number | null): string | null {
  const projected = (currentDbMb ?? 0) + estimatedMb;
  if (projected <= DB_SOFT_LIMIT_MB) return null;
  const base =
    currentDbMb === null
      ? `the estimate alone is ${estimatedMb.toFixed(0)} MB`
      : `current ${currentDbMb.toFixed(0)} MB + ${estimatedMb.toFixed(0)} MB estimate = ${projected.toFixed(0)} MB`;
  return (
    `WARNING: ${base}, above the ${DB_SOFT_LIMIT_MB} MB soft limit (Supabase free tier is 500 MB). ` +
    'Skip FNDDS or the CNF, or import fewer datasets.'
  );
}

const fmt = (n: number, digits = 1): string => n.toLocaleString('en-US', { maximumFractionDigits: digits });
/** MB with 2 decimals below 10 MB so tiny test runs do not show "0 MB". */
const fmtMb = (mb: number): string => (mb < 10 ? mb.toFixed(2) : fmt(mb));

/** Multi-line report for one or more datasets. */
export function formatReport(
  summaries: readonly DatasetSummary[],
  opts: { dryRun: boolean; dbSizeMbBefore?: number | null; dbSizeMbAfter?: number | null },
): string {
  const lines: string[] = [];
  lines.push(`=== Import report${opts.dryRun ? ' (DRY RUN - nothing written)' : ''} ===`);
  let totalBytes = 0;
  let totalKept = 0;
  for (const s of summaries) {
    totalBytes += s.estimatedBytes;
    totalKept += s.kept;
    const droppedTotal = DROP_REASONS.reduce((a, r) => a + s.stats.dropped[r], 0);
    const dropDetail = DROP_REASONS.filter((r) => s.stats.dropped[r] > 0)
      .map((r) => `${r} ${s.stats.dropped[r]}`)
      .join(', ');
    lines.push('');
    lines.push(`[${s.source}] ${s.label}`);
    lines.push(`  foods found ${fmt(s.stats.foodsFound, 0)}, kept ${fmt(s.kept, 0)}, dropped ${fmt(droppedTotal, 0)}${dropDetail ? ` (${dropDetail})` : ''}`);
    lines.push(
      `  avg nutrients/food ${fmt(s.avgNutrients)}, avg completeness ${fmt(s.avgCompleteness * 100)} %, avg portions/food ${fmt(s.avgPortions)}`,
    );
    const energy = Object.entries(s.stats.energySources)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} ${n}`)
      .join(', ');
    if (energy) lines.push(`  energy from: ${energy}`);
    if (s.stats.unitMismatches > 0 || s.stats.invalidAmounts > 0) {
      lines.push(`  skipped amounts: ${s.stats.unitMismatches} unit mismatch, ${s.stats.invalidAmounts} negative/non-numeric`);
    }
    if (s.stats.clampedAmounts > 0) {
      lines.push(`  negative carbohydrate-by-difference (> -1 g) stored as 0: ${s.stats.clampedAmounts}`);
    }
    if (s.stats.portionsDropped > 0) lines.push(`  portions dropped (grams <= 0, duplicate, no label): ${s.stats.portionsDropped}`);
    lines.push(`  estimated storage ${fmtMb(toMb(s.estimatedBytes))} MB`);
    if (s.write) {
      const w = s.write;
      lines.push(
        `  db: inserted ${w.inserted}, updated ${w.updated}, unchanged ${w.unchanged}; portions rewritten for ${w.portionsReplacedFor} food(s) (${w.portionRowsInserted} rows)` +
          (w.duplicatesInInput > 0 ? `; ${w.duplicatesInInput} duplicate input row(s) ignored` : ''),
      );
    }
    if (s.stats.unmapped.size > 0) {
      const top = [...s.stats.unmapped.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[0] - b[0])
        .slice(0, 5)
        .map(([id, u]) => `${u.name || '?'} (${id}) x${u.count}`)
        .join('; ');
      lines.push(`  source nutrients not in the catalog: ${s.stats.unmapped.size} distinct; most frequent: ${top}`);
    }
    for (const w of s.stats.warnings.slice(0, 10)) lines.push(`  ! ${w}`);
    if (s.stats.warnings.length > 10) lines.push(`  ! ... ${s.stats.warnings.length - 10} more warning(s)`);
  }
  lines.push('');
  lines.push(`Total: ${fmt(totalKept, 0)} foods, estimated storage ${fmtMb(toMb(totalBytes))} MB (order of magnitude, +-30 %)`);
  if (opts.dbSizeMbBefore != null) lines.push(`Database size before: ${fmt(opts.dbSizeMbBefore)} MB`);
  if (opts.dbSizeMbAfter != null) lines.push(`Database size after:  ${fmt(opts.dbSizeMbAfter)} MB`);
  const hint = storageHint(toMb(totalBytes), opts.dbSizeMbBefore ?? null);
  if (hint) lines.push(hint);
  return lines.join('\n');
}
