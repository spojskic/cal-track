/**
 * Text normalisation and similarity used by the food matcher.
 * Pure functions, no platform APIs. Works for Bosnian/Croatian/Serbian input
 * with or without diacritics.
 */

const EXTRA_FOLDS: Array<[RegExp, string]> = [
  [/đ/g, 'dj'],
  [/ø/g, 'o'],
  [/ł/g, 'l'],
  [/ß/g, 'ss'],
  [/æ/g, 'ae'],
  [/œ/g, 'oe'],
];

const STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'with', 'in', 'on', 'for', 'w', 'i', 'sa', 'od', 'na', 'u', 'z', 'or', 'to', 'style',
]);

const UNIT_TOKENS = new Set([
  'g', 'gr', 'gram', 'grams', 'grama', 'kg', 'mg', 'ml', 'l', 'dl', 'cl', 'oz', 'lb', 'lbs', 'kom', 'komad', 'komada',
  'x', 'cup', 'cups', 'tbsp', 'tsp', 'tablespoon', 'teaspoon', 'kasika', 'kasike', 'kasicica', 'zlica', 'zlice',
  'solja', 'solje', 'salica', 'salice', 'casa', 'case', 'piece', 'pieces', 'slice', 'slices', 'kriska', 'kriske',
  'snita', 'snite', 'portion', 'portions', 'porcija', 'porcije', 'tanjir',
]);

/** Lowercase, strip diacritics (NFD + extra folds), keep letters/digits, collapse whitespace. */
export function normalizeText(input: string): string {
  let s = input.toLowerCase();
  for (const [re, rep] of EXTRA_FOLDS) s = s.replace(re, rep);
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/[^a-z0-9]+/g, ' ');
  return s.trim().replace(/\s+/g, ' ');
}

function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith('es') && /(ch|sh|x|s|z|o)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

/** Normalised, de-stopworded, lightly stemmed tokens. */
export function tokenize(input: string): string[] {
  return normalizeText(input)
    .split(' ')
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
    .map(stem);
}

function isQuantityToken(raw: string): boolean {
  const t = normalizeText(raw);
  if (!t) return true; // pure punctuation
  if (/^\d+$/.test(t)) return true;
  if (UNIT_TOKENS.has(t)) return true;
  // glued number+unit such as "200g", "2kom", "1,5dl" (normalised to "1 5dl")
  return /^\d+[a-z]{1,3}$/.test(t);
}

/**
 * Removes quantities and units ("200 g", "2 kom", "1 cup of") but keeps the
 * remaining words exactly as written (diacritics and case preserved).
 */
export function stripQuantitiesPreserve(input: string): string {
  return input
    .split(/\s+/)
    .filter((tok) => tok.length > 0 && !isQuantityToken(tok))
    .join(' ')
    .replace(/^(of|od)\s+/i, '')
    .trim();
}

/** Same as stripQuantitiesPreserve but normalised (lowercase, no diacritics). */
export function stripQuantities(input: string): string {
  return normalizeText(stripQuantitiesPreserve(input));
}

export function levenshtein(a: string, b: string, maxDistance = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0] as number;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j] as number;
  }
  return prev[b.length] as number;
}

function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const minLen = Math.min(a.length, b.length);
  if (minLen >= 5) {
    const d = levenshtein(a, b, 2);
    if (d <= 1) return 0.85;
    if (d <= 2 && minLen >= 8) return 0.7;
  }
  // prefix match for longer tokens ("chick" ~ "chicken")
  if (minLen >= 5 && (a.startsWith(b) || b.startsWith(a))) return 0.6;
  return 0;
}

/**
 * Similarity in [0,1] between a query and a candidate name.
 * Blend of query coverage (how much of the query the candidate explains) and
 * Dice overlap (penalises candidates with lots of extra words).
 */
export function textSimilarity(query: string, candidate: string): number {
  const nq = normalizeText(query);
  const nc = normalizeText(candidate);
  if (!nq || !nc) return 0;
  if (nq === nc) return 1;

  const q = tokenize(query);
  const c = tokenize(candidate);
  if (q.length === 0 || c.length === 0) return 0;

  const used = new Set<number>();
  let matched = 0;
  for (const qt of q) {
    let bestScore = 0;
    let bestIdx = -1;
    for (let i = 0; i < c.length; i++) {
      if (used.has(i)) continue;
      const s = tokenSimilarity(qt, c[i] as string);
      if (s > bestScore) {
        bestScore = s;
        bestIdx = i;
      }
    }
    if (bestIdx !== -1) {
      used.add(bestIdx);
      matched += bestScore;
    }
  }
  const coverage = matched / q.length;
  const dice = (2 * matched) / (q.length + c.length);
  return Math.min(1, 0.5 * coverage + 0.5 * dice);
}
