/**
 * Selective access to the data files of a dataset, from a .zip (streamed with
 * yauzl-promise, never extracted or loaded whole), an extracted directory or a
 * single .json file. Both `.csv` and `.json` entries are indexed.
 *
 * Files are addressed by a normalised key (basename, lower case, only [a-z0-9],
 * extension dropped) so `food_nutrient.csv`, `Food_Nutrient.CSV` and
 * `NUTRIENT AMOUNT.csv` (-> `nutrientamount`) all work regardless of case, nesting
 * or the release's top-level folder name.
 */
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import yauzl from 'yauzl-promise';
import type { Entry, Zip } from 'yauzl-promise';

export interface FileSource {
  readonly kind: 'zip' | 'dir' | 'file' | 'memory';
  /** True when the file exists (`name` may be `food.csv`, `FOOD NAME.csv`, ...). */
  has(name: string): boolean;
  /** Opens the file as a byte stream. Throws when it does not exist. */
  open(name: string): Promise<Readable>;
  /** Normalised keys of all CSV/JSON files found. */
  list(): string[];
  /** Original base names of the `.json` files found (e.g. FoodData_Central_foundation_food_json_2026-10-29.json). */
  jsonNames(): string[];
  close(): Promise<void>;
}

/** `Food_Nutrient.CSV` / `NUTRIENT AMOUNT.csv` -> `foodnutrient` / `nutrientamount`. */
export function fileKey(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? name;
  return base
    .replace(/\.(csv|json)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const DATA_FILE = /\.(csv|json)$/i;
const isJson = (name: string): boolean => /\.json$/i.test(name);

function isJunk(path: string): boolean {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts.some((p) => p === '__MACOSX' || p.startsWith('.'));
}

function missing(name: string, kind: string, available: string[]): Error {
  return new Error(
    `File "${name}" not found in ${kind} (available: ${available.slice(0, 40).join(', ') || 'none'})`,
  );
}

/** key -> { original base name, location } for one kind of container. */
type Index<T> = Map<string, { name: string; ref: T }>;

function addEntry<T>(index: Index<T>, name: string, ref: T): void {
  const key = fileKey(name);
  if (!index.has(key)) index.set(key, { name: basename(name), ref });
}

const namesOf = <T>(index: Index<T>): string[] =>
  [...index.values()].map((v) => v.name).filter(isJson);

class DirSource implements FileSource {
  constructor(
    readonly kind: 'dir' | 'file',
    private readonly files: Index<string>,
  ) {}
  has(name: string): boolean {
    return this.files.has(fileKey(name));
  }
  async open(name: string): Promise<Readable> {
    const found = this.files.get(fileKey(name));
    if (found === undefined) throw missing(name, 'directory', this.list());
    return createReadStream(found.ref);
  }
  list(): string[] {
    return [...this.files.keys()];
  }
  jsonNames(): string[] {
    return namesOf(this.files);
  }
  async close(): Promise<void> {}
}

class ZipSource implements FileSource {
  readonly kind = 'zip' as const;
  constructor(
    private readonly zip: Zip,
    private readonly entries: Index<Entry>,
  ) {}
  has(name: string): boolean {
    return this.entries.has(fileKey(name));
  }
  async open(name: string): Promise<Readable> {
    const found = this.entries.get(fileKey(name));
    if (found === undefined) throw missing(name, 'zip', this.list());
    return found.ref.openReadStream();
  }
  list(): string[] {
    return [...this.entries.keys()];
  }
  jsonNames(): string[] {
    return namesOf(this.entries);
  }
  async close(): Promise<void> {
    if (this.zip.isOpen) await this.zip.close();
  }
}

/** In-memory source for tests: `{ 'food.csv': 'fdc_id,...\n...' }`. */
export function memorySource(files: Record<string, string | Buffer>): FileSource {
  const map: Index<string | Buffer> = new Map();
  for (const [name, content] of Object.entries(files)) addEntry(map, name, content);
  return {
    kind: 'memory',
    has: (name) => map.has(fileKey(name)),
    async open(name) {
      const found = map.get(fileKey(name));
      if (found === undefined) throw missing(name, 'memory source', [...map.keys()]);
      // Several small chunks so streaming code paths are exercised.
      const content = found.ref;
      const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      const chunks: Buffer[] = [];
      for (let i = 0; i < buf.length; i += 7) chunks.push(buf.subarray(i, i + 7));
      return Readable.from(chunks, { objectMode: false });
    },
    list: () => [...map.keys()],
    jsonNames: () => namesOf(map),
    async close() {},
  };
}

/** Walks a directory (max depth 3, breadth first) and indexes its CSV/JSON files. */
export async function openDirSource(dir: string): Promise<FileSource> {
  const files: Index<string> = new Map();
  let level: string[] = [dir];
  for (let depth = 0; depth <= 3 && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const current of level) {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;
        const full = join(current, entry.name);
        if (entry.isDirectory()) next.push(full);
        else if (DATA_FILE.test(entry.name)) addEntry(files, entry.name, full); // shallowest wins
      }
    }
    level = next;
  }
  return new DirSource('dir', files);
}

/** Indexes the CSV/JSON entries of a zip. Entries are only read when opened. */
export async function openZipSource(path: string): Promise<FileSource> {
  const zip = await yauzl.open(path);
  try {
    const entries: Index<Entry> = new Map();
    for await (const entry of zip) {
      if (entry.filename.endsWith('/') || isJunk(entry.filename)) continue;
      if (!DATA_FILE.test(basename(entry.filename))) continue;
      addEntry(entries, entry.filename, entry);
    }
    return new ZipSource(zip, entries);
  } catch (err) {
    await zip.close();
    throw err;
  }
}

/** A single .json (or .csv) file as a source. */
export function openFileSource(path: string): FileSource {
  const files: Index<string> = new Map();
  addEntry(files, path, path);
  return new DirSource('file', files);
}

/** Opens a .zip file, an extracted directory or a single .json file. */
export async function openSource(path: string): Promise<FileSource> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`Path not found: ${path}`);
  }
  if (info.isDirectory()) return openDirSource(path);
  if (/\.zip$/i.test(path)) return openZipSource(path);
  if (isJson(path)) return openFileSource(path);
  throw new Error(`Expected a .zip file, a .json file or a directory with CSV files, got: ${path}`);
}

/** Runs `fn` with an opened source and always closes it. */
export async function withSource<T>(path: string, fn: (source: FileSource) => Promise<T>): Promise<T> {
  const source = await openSource(path);
  try {
    return await fn(source);
  } finally {
    await source.close();
  }
}
