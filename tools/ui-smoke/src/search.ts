/**
 * `search_foods(q, max_results, kinds)` emulation: accent-insensitive prefix + typo-tolerant search with the
 * personalised ranking described in supabase/migrations/20261110000008_search_functions.sql.
 * Approximation: Postgres FTS / pg_trgm are replaced by word-prefix matching and a small trigram similarity.
 */

/** unaccent + lower + collapse whitespace ("Ćevapi" -> "cevapi", "Đuveč" -> "duvec"). */
export function foldText(input: string): string {
  return input
    .replace(/[đĐ]/g, 'd')
    .replace(/[łŁ]/g, 'l')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Words as `to_tsvector('simple', ...)` would split them. */
export function words(folded: string): string[] {
  return folded.split(/[^a-z0-9]+/).filter(Boolean);
}

function trigrams(word: string): Set<string> {
  const padded = `  ${word} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
  return out;
}

/** pg_trgm similarity of two single words. */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  let common = 0;
  for (const t of ta) if (tb.has(t)) common += 1;
  const union = ta.size + tb.size - common;
  return union === 0 ? 0 : common / union;
}

/** Approximation of `word_similarity(query, text)`: best word match per query word, averaged. */
export function wordSimilarity(queryWords: readonly string[], textWords: readonly string[]): number {
  if (queryWords.length === 0 || textWords.length === 0) return 0;
  let total = 0;
  for (const q of queryWords) {
    let best = 0;
    for (const w of textWords) best = Math.max(best, trigramSimilarity(q, w));
    total += best;
  }
  return total / queryWords.length;
}

const SOURCE_QUALITY: Record<string, number> = {
  fdc_foundation: 1,
  fdc_sr_legacy: 0.85,
  cnf: 0.7,
  cofid: 0.55,
  fdc_fndds: 0.4,
  fdc_branded: 0.25,
  off: 0.1,
  ai_estimate: 0,
};

export const foodSourceQuality = (source: string): number => SOURCE_QUALITY[source] ?? 0.5;

type Row = Record<string, unknown>;

export interface SearchInput {
  foods: readonly Row[];
  usage: readonly Row[];
  favorites: readonly Row[];
  uid: string | null;
  nowMs: number;
}

export interface SearchArgs {
  q?: unknown;
  max_results?: unknown;
  kinds?: unknown;
}

export interface SearchRow {
  id: string;
  name: string;
  brand: string | null;
  kind: string;
  source: string;
  kcal_100g: number | null;
  protein_100g: number | null;
  carbs_100g: number | null;
  fat_100g: number | null;
  completeness: number | null;
  rank: number;
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The searchable text of a food, as the generated `search_text` column. */
export function searchTextOf(food: Row): string {
  return foldText(`${String(food.name ?? '')} ${String(food.brand ?? '')}`);
}

export function searchFoods(input: SearchInput, args: SearchArgs): SearchRow[] {
  const folded = foldText(String(args.q ?? '').slice(0, 100));
  if (folded === '') return [];
  const queryWords = words(folded);
  if (queryWords.length === 0) return [];
  const limit = Math.min(Math.max(Number(args.max_results ?? 25) || 25, 1), 100);
  const kinds = Array.isArray(args.kinds) && args.kinds.length > 0 ? (args.kinds as unknown[]).map(String) : null;
  const fuzzy = folded.length >= 3;

  const usageBy = new Map<string, Row>();
  for (const u of input.usage) if (u.user_id === input.uid) usageBy.set(String(u.food_id), u);
  const favs = new Set(input.favorites.filter((f) => f.user_id === input.uid).map((f) => String(f.food_id)));

  const scored: { row: SearchRow; score: number }[] = [];
  for (const food of input.foods) {
    if (food.archived === true) continue;
    if (food.owner_id !== null && food.owner_id !== input.uid) continue;
    if (kinds && !kinds.includes(String(food.kind))) continue;

    const text = searchTextOf(food);
    const textWords = words(text);
    const ftsHit = queryWords.every((qw) => textWords.some((tw) => tw.startsWith(qw)));
    const wordSim = wordSimilarity(queryWords, textWords);
    const fuzzyHit = fuzzy && wordSim >= 0.45;
    if (!ftsHit && !fuzzyHit) continue;

    const nutrients = (food.nutrients ?? {}) as Record<string, unknown>;
    const usage = usageBy.get(String(food.id));
    let score = 0;
    if (food.owner_id !== null) score += 0.6;
    if (usage) {
      const days = Math.max(0, (input.nowMs - Date.parse(String(usage.last_used_at))) / 86_400_000);
      score += 0.35 + Math.min(0.25, 0.06 * Math.log(1 + Number(usage.use_count ?? 0))) + 0.1 / (1 + days / 14);
    }
    if (favs.has(String(food.id))) score += 0.25;
    score += 0.2 * foodSourceQuality(String(food.source));
    if (ftsHit) score += 0.3;
    score += 0.4 * wordSim + 0.2 * trigramSimilarity(folded, text);
    if (text.startsWith(folded)) score += 0.1;
    score += 0.05 * (numOrNull(food.completeness) ?? 0);
    score += 0.03 * Math.min(1, Math.log(1 + Math.max(Number(food.popularity ?? 0), 0)) / 10);

    scored.push({
      score,
      row: {
        id: String(food.id),
        name: String(food.name),
        brand: (food.brand as string | null) ?? null,
        kind: String(food.kind),
        source: String(food.source),
        kcal_100g: numOrNull(nutrients.ENERGY_KCAL),
        protein_100g: numOrNull(nutrients.PROTEIN_G),
        carbs_100g: numOrNull(nutrients.CARBS_G),
        fat_100g: numOrNull(nutrients.FAT_G),
        completeness: numOrNull(food.completeness),
        rank: Math.round(score * 1e6) / 1e6,
      },
    });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.row.name.length - b.row.name.length ||
      (a.row.name < b.row.name ? -1 : a.row.name > b.row.name ? 1 : 0) ||
      (a.row.id < b.row.id ? -1 : 1),
  );
  return scored.slice(0, limit).map((s) => s.row);
}
