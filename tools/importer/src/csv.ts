/**
 * Streaming CSV helpers: byte stream -> decoded text -> csv-parse rows.
 *
 * Header names are "compacted" (lower case, only [a-z0-9]) so `fdc_id`, `FDC ID`,
 * `FoodID` and `foodid` all resolve to the same key. Use `field()` to read a
 * value by one or more aliases.
 */
import { Readable } from 'node:stream';
import { parse } from 'csv-parse';
import type { FileSource } from './source';

/** One CSV record keyed by compacted header name. */
export type Row = Record<string, string | undefined>;

/** `Food ID` / `food_id` / `\uFEFF"FoodID"` -> `foodid`. */
export function compactKey(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** First non-empty trimmed value among the (already compact) aliases, else ''. */
export function field(row: Row, ...aliases: string[]): string {
  for (const alias of aliases) {
    const v = row[alias];
    if (v !== undefined) {
      const t = v.trim();
      if (t !== '') return t;
    }
  }
  return '';
}

/**
 * Parses a decimal number. Accepts `1.5` and (when there is no dot) `1,5`.
 * Returns null for empty / non-numeric / non-finite input.
 */
export function parseDecimal(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  let s = raw.trim();
  if (s === '') return null;
  if (!s.includes('.') && /^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------------ encoding

export type TextEncoding = 'utf-8' | 'windows-1252' | 'utf-16le';

/** Maps a user supplied `--encoding` value to a TextDecoder label, or 'auto'. */
export function resolveEncodingFlag(flag: string | undefined): TextEncoding | 'auto' {
  const f = (flag ?? 'auto').trim().toLowerCase();
  switch (f) {
    case 'auto':
      return 'auto';
    case 'utf8':
    case 'utf-8':
      return 'utf-8';
    case 'latin1':
    case 'latin-1':
    case 'iso-8859-1':
    case 'iso8859-1':
    case 'cp1252':
    case 'windows-1252':
      return 'windows-1252';
    case 'utf16le':
    case 'utf-16le':
      return 'utf-16le';
    default:
      throw new Error(`Unsupported --encoding "${flag}" (use auto, utf8 or latin1)`);
  }
}

/**
 * Detects the encoding of a byte stream: a UTF-8 BOM or valid UTF-8 -> utf-8,
 * UTF-16LE BOM -> utf-16le, otherwise (invalid UTF-8 somewhere) windows-1252
 * (a superset of ISO-8859-1 as browsers and Health Canada's files use it).
 * Streams through the whole input once without keeping it in memory.
 */
export async function detectEncoding(
  bytes: AsyncIterable<Buffer | string> | Iterable<Buffer | string>,
): Promise<TextEncoding> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let first = true;
  try {
    for await (const chunk of bytes) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      if (first && buf.length >= 2) {
        if (buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
        if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
          return 'utf-8';
        }
      }
      first = false;
      decoder.decode(buf, { stream: true });
    }
    decoder.decode();
    return 'utf-8';
  } catch {
    return 'windows-1252';
  }
}

/** Decodes a byte stream to text chunks; a leading BOM is removed. */
export async function* decodeBytes(
  bytes: AsyncIterable<Buffer | string> | Iterable<Buffer | string>,
  encoding: TextEncoding,
): AsyncGenerator<string> {
  const decoder = new TextDecoder(encoding);
  let first = true;
  for await (const chunk of bytes) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    let text = decoder.decode(buf, { stream: true });
    if (first && text.length > 0) {
      text = text.replace(/^\uFEFF/, '');
      first = false;
    }
    if (text !== '') yield text;
  }
  const tail = decoder.decode();
  if (tail !== '') yield tail;
}

// ----------------------------------------------------------------- delimiter

/** Picks the delimiter (`,` `;` tab or `|`) that occurs most outside quotes in a header line. */
export function sniffDelimiter(headerLine: string): string {
  const candidates = [',', ';', '\t', '|'];
  const counts = new Map<string, number>(candidates.map((c) => [c, 0]));
  let quoted = false;
  for (const ch of headerLine) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && counts.has(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let best = ',';
  let bestCount = 0;
  for (const [c, n] of counts) {
    if (n > bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

// ----------------------------------------------------------------- parsing

export interface ReadCsvOptions {
  /** `,` `;` tab `|` or 'auto' (sniffed from the header line; default `,`). */
  delimiter?: string;
}

/**
 * Streams records out of decoded text chunks. Memory use is independent of the
 * file size. Breaking out of the iteration releases the underlying streams.
 */
export async function* readCsv(
  text: AsyncIterable<string>,
  opts: ReadCsvOptions = {},
): AsyncGenerator<Row> {
  const iterator = text[Symbol.asyncIterator]();
  const head: string[] = [];
  let delimiter = opts.delimiter && opts.delimiter !== 'auto' ? opts.delimiter : undefined;

  // Peek until the first line break so the delimiter can be sniffed.
  if (delimiter === undefined) {
    let buffered = '';
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      head.push(next.value);
      buffered += next.value;
      if (/[\r\n]/.test(buffered) || buffered.length > 65536) break;
    }
    delimiter = sniffDelimiter(buffered.split(/\r?\n/, 1)[0] ?? '');
  }

  async function* chained(): AsyncGenerator<string> {
    try {
      for (const h of head) yield h;
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      await iterator.return?.();
    }
  }

  const parser = parse({
    columns: (header: string[]) => header.map((h) => compactKey(h) || false),
    delimiter,
    relax_quotes: true,
    relax_column_count: true,
    skip_empty_lines: true,
    bom: false,
  });
  const source = Readable.from(chained(), { objectMode: false });
  source.on('error', (err) => parser.destroy(err));
  source.pipe(parser);
  try {
    for await (const record of parser) yield record as Row;
  } finally {
    parser.destroy();
    source.destroy();
  }
}

export interface ReadCsvFileOptions extends ReadCsvOptions {
  /** 'auto' (default for CNF) detects BOM / UTF-8 / latin1; FDC passes 'utf8'. */
  encoding?: string;
}

/**
 * Streams the rows of one CSV entry of a {@link FileSource}.
 * With `encoding: 'auto'` the entry is read twice (detection pass, parse pass).
 */
export async function* readCsvFile(
  source: FileSource,
  name: string,
  opts: ReadCsvFileOptions = {},
): AsyncGenerator<Row> {
  let encoding = resolveEncodingFlag(opts.encoding ?? 'utf8');
  if (encoding === 'auto') {
    const probe = await source.open(name);
    try {
      encoding = await detectEncoding(probe);
    } finally {
      probe.destroy();
    }
  }
  const bytes = await source.open(name);
  try {
    yield* readCsv(decodeBytes(bytes, encoding), opts);
  } finally {
    bytes.destroy();
  }
}
