/** Test helpers (no network, no database): a stored-zip builder and a fake pg client. */
import type { DbClient, QueryResult } from './db';

/** JSON with sorted keys (jsonb equality ignores key order). */
function canonicalJson(value: Record<string, number>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}

// ------------------------------------------------------------------ zip

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Builds a zip with STORED (uncompressed) entries. Names ending in "/" become directory entries. */
export function makeStoredZip(files: Record<string, string | Buffer>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  const count = Object.keys(files).length;
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cd, eocd]);
}

// ------------------------------------------------------------- fake pg

interface FakeFood {
  id: string;
  source: string;
  source_id: string;
  kind: string;
  name: string;
  category: string | null;
  nutrients: Record<string, number>;
  completeness: number;
  carb_basis: string;
}

interface FakePortion {
  food_id: string;
  label: string;
  amount: number | null;
  unit: string | null;
  grams: number;
  sort_order: number;
}

interface FakeState {
  foods: Array<[string, FakeFood]>;
  portions: FakePortion[];
}

/**
 * In-memory stand-in for the importer's Postgres statements. It understands
 * exactly the statements `db.ts` issues (matched by their leading SQL) and
 * emulates ON CONFLICT DO UPDATE ... WHERE (row changed), the "referenced foods
 * keep their nutrients" rule, transactions and the id/portion lookups.
 */
export class FakePg implements DbClient {
  readonly queries: Array<{ text: string; values: unknown[] | undefined }> = [];
  foods = new Map<string, FakeFood>();
  portions: FakePortion[] = [];
  /** Food ids that are referenced by diary entries / recipes. */
  referencedIds = new Set<string>();
  commits = 0;
  rollbacks = 0;
  /** Throw when this returns true for a statement. */
  failWhen: ((text: string) => boolean) | null = null;
  private seq = 0;
  private snapshot: FakeState | null = null;

  private static key(source: string, sourceId: string): string {
    return `${source}\u0000${sourceId}`;
  }

  /** Statements with the given leading SQL. */
  count(prefix: string): number {
    return this.queries.filter((q) => q.text.startsWith(prefix)).length;
  }

  portionsOf(source: string, sourceId: string): FakePortion[] {
    const food = this.foods.get(FakePg.key(source, sourceId));
    if (!food) return [];
    return this.portions.filter((p) => p.food_id === food.id).sort((a, b) => a.sort_order - b.sort_order);
  }

  async query(text: string, values?: unknown[]): Promise<QueryResult> {
    this.queries.push({ text, values });
    if (this.failWhen?.(text)) throw new Error('simulated failure');

    if (text === 'BEGIN') {
      this.snapshot = structuredClone({ foods: [...this.foods.entries()], portions: this.portions });
      return { rows: [] };
    }
    if (text === 'COMMIT') {
      this.snapshot = null;
      this.commits += 1;
      return { rows: [] };
    }
    if (text === 'ROLLBACK') {
      if (this.snapshot) {
        this.foods = new Map(this.snapshot.foods);
        this.portions = this.snapshot.portions;
      }
      this.snapshot = null;
      this.rollbacks += 1;
      return { rows: [] };
    }
    if (text.startsWith('INSERT INTO public.foods')) return this.upsertFoods(values ?? []);
    if (text.startsWith('SELECT f.id, f.source, f.source_id')) {
      const [sources, sourceIds] = values as [string[], string[]];
      const rows = sources.flatMap((s, i) => {
        const f = this.foods.get(FakePg.key(s, sourceIds[i] as string));
        return f ? [{ id: f.id, source: f.source, source_id: f.source_id }] : [];
      });
      return { rows };
    }
    if (text.startsWith('SELECT food_id, label, amount')) {
      const [ids] = values as [string[]];
      const rows = this.portions
        .filter((p) => ids.includes(p.food_id))
        .sort((a, b) => a.food_id.localeCompare(b.food_id) || a.sort_order - b.sort_order || a.label.localeCompare(b.label))
        // pg returns numeric columns as strings
        .map((p) => ({ ...p, amount: p.amount === null ? null : String(p.amount), grams: String(p.grams) }));
      return { rows };
    }
    if (text.startsWith('DELETE FROM public.food_portions')) {
      const [ids] = values as [string[]];
      this.portions = this.portions.filter((p) => !ids.includes(p.food_id));
      return { rows: [] };
    }
    if (text.startsWith('INSERT INTO public.food_portions')) {
      const v = values ?? [];
      for (let i = 0; i < v.length; i += 6) {
        this.portions.push({
          food_id: v[i] as string,
          label: v[i + 1] as string,
          amount: v[i + 2] as number | null,
          unit: v[i + 3] as string | null,
          grams: v[i + 4] as number,
          sort_order: v[i + 5] as number,
        });
      }
      return { rows: [] };
    }
    if (text.startsWith('SELECT pg_database_size')) return { rows: [{ bytes: 50 * 1024 * 1024 }] };
    throw new Error(`FakePg: unexpected statement: ${text.slice(0, 80)}`);
  }

  private upsertFoods(v: unknown[]): QueryResult {
    const rows: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (let i = 0; i < v.length; i += 8) {
      const incoming = {
        source: v[i] as string,
        source_id: v[i + 1] as string,
        kind: v[i + 2] as string,
        name: v[i + 3] as string,
        category: v[i + 4] as string | null,
        nutrients: JSON.parse(v[i + 5] as string) as Record<string, number>,
        completeness: v[i + 6] as number,
        carb_basis: v[i + 7] as string,
      };
      const key = FakePg.key(incoming.source, incoming.source_id);
      if (seen.has(key)) throw new Error('ON CONFLICT DO UPDATE command cannot affect row a second time');
      seen.add(key);
      const existing = this.foods.get(key);
      if (!existing) {
        const id = `00000000-0000-0000-0000-${String(++this.seq).padStart(12, '0')}`;
        this.foods.set(key, { id, ...incoming });
        rows.push({ id, source: incoming.source, source_id: incoming.source_id, inserted: true });
        continue;
      }
      const protectedRow = this.referencedIds.has(existing.id);
      const next: FakeFood = {
        ...existing,
        kind: incoming.kind,
        name: incoming.name,
        category: incoming.category,
        nutrients: protectedRow ? existing.nutrients : incoming.nutrients,
        completeness: protectedRow ? existing.completeness : incoming.completeness,
        carb_basis: protectedRow ? existing.carb_basis : incoming.carb_basis,
      };
      // WHERE (kind, name, category) IS DISTINCT FROM (...)
      //    OR ((nutrients, completeness, carb_basis) IS DISTINCT FROM (...) AND NOT referenced)
      const descriptiveDiffers =
        existing.kind !== incoming.kind || existing.name !== incoming.name || existing.category !== incoming.category;
      const nutritionDiffers =
        canonicalJson(existing.nutrients) !== canonicalJson(incoming.nutrients) ||
        existing.completeness !== incoming.completeness ||
        existing.carb_basis !== incoming.carb_basis;
      const differs = descriptiveDiffers || (nutritionDiffers && !protectedRow);
      if (!differs) continue;
      this.foods.set(key, next);
      rows.push({ id: existing.id, source: existing.source, source_id: existing.source_id, inserted: false });
    }
    return { rows, rowCount: rows.length };
  }
}
