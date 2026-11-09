/**
 * Postgres writer: batched, transactional, idempotent upserts into
 * `public.foods` + `public.food_portions`.
 *
 * - Conflict target is the partial unique index of the migration
 *   (`foods_global_source_uidx`): `(source, source_id) WHERE source_id IS NOT NULL AND owner_id IS NULL`.
 * - Unchanged foods are not rewritten (`DO UPDATE ... WHERE row IS DISTINCT FROM`),
 *   so re-runs create no dead tuples / index churn on the 500 MB free tier.
 * - Foods already referenced by diary entries or recipe ingredients keep their
 *   nutrients / completeness / carb_basis (the migration's trigger
 *   `foods_protect_referenced` forbids changing them); name and category are
 *   still refreshed. Use `public.supersede_food()` for deliberate nutrient fixes.
 * - Portions are replaced (DELETE + INSERT) only for foods whose portions differ.
 */
import pg from 'pg';
import type { ImportFood, ImportPortion, Logger } from './types';

export interface QueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount?: number | null;
}

/** The subset of `pg.Client` the writer needs (fakeable in tests). */
export interface DbClient {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}

export interface SqlQuery {
  text: string;
  values: unknown[];
}

/** Columns written for a food, in parameter order (8 parameters per row). */
export const FOOD_COLUMNS = [
  'source',
  'source_id',
  'kind',
  'name',
  'category',
  'nutrients',
  'completeness',
  'carb_basis',
] as const;
const FOOD_CASTS = ['text', 'text', 'text', 'text', 'text', 'jsonb', 'real', 'text'] as const;

/** Columns written for a portion, in parameter order (6 parameters per row). */
export const PORTION_COLUMNS = ['food_id', 'label', 'amount', 'unit', 'grams', 'sort_order'] as const;
const PORTION_CASTS = ['uuid', 'text', 'numeric', 'text', 'numeric', 'int'] as const;

/** Must match `foods_global_source_uidx` in supabase/migrations/*_foods.sql exactly. */
export const FOODS_CONFLICT_TARGET = '(source, source_id) WHERE source_id IS NOT NULL AND owner_id IS NULL';

const REFERENCED_BY_USER_DATA =
  '(EXISTS (SELECT 1 FROM public.diary_entries d WHERE d.food_id = f.id) ' +
  'OR EXISTS (SELECT 1 FROM public.recipe_ingredients r WHERE r.ingredient_food_id = f.id))';

export const SELECT_FOOD_IDS_SQL =
  'SELECT f.id, f.source, f.source_id FROM public.foods f ' +
  'JOIN unnest($1::text[], $2::text[]) AS k(source, source_id) ' +
  'ON k.source = f.source AND k.source_id = f.source_id ' +
  'WHERE f.owner_id IS NULL';

export const SELECT_PORTIONS_SQL =
  'SELECT food_id, label, amount, unit, grams, sort_order FROM public.food_portions ' +
  'WHERE food_id = ANY($1::uuid[]) ORDER BY food_id, sort_order, label';

export const DELETE_PORTIONS_SQL = 'DELETE FROM public.food_portions WHERE food_id = ANY($1::uuid[])';

function placeholders(rows: number, casts: readonly string[]): string {
  const width = casts.length;
  const out: string[] = [];
  for (let r = 0; r < rows; r += 1) {
    out.push(`(${casts.map((cast, c) => `$${r * width + c + 1}::${cast}`).join(', ')})`);
  }
  return out.join(',\n  ');
}

/** Multi-row `INSERT ... ON CONFLICT ... DO UPDATE` for global foods. */
export function buildFoodsUpsert(foods: readonly ImportFood[]): SqlQuery {
  if (foods.length === 0) throw new Error('buildFoodsUpsert: no foods');
  const values: unknown[] = [];
  for (const f of foods) {
    values.push(
      f.source,
      f.sourceId,
      f.kind,
      f.name,
      f.category,
      JSON.stringify(f.nutrients),
      f.completeness,
      f.carbBasis,
    );
  }
  const keep = (column: string): string =>
    `${column} = CASE WHEN ${REFERENCED_BY_USER_DATA} THEN f.${column} ELSE EXCLUDED.${column} END`;
  const text = [
    `INSERT INTO public.foods AS f (${FOOD_COLUMNS.join(', ')})`,
    `VALUES ${placeholders(foods.length, FOOD_CASTS)}`,
    `ON CONFLICT ${FOODS_CONFLICT_TARGET}`,
    'DO UPDATE SET',
    '  kind = EXCLUDED.kind,',
    '  name = EXCLUDED.name,',
    '  category = EXCLUDED.category,',
    `  ${keep('nutrients')},`,
    `  ${keep('completeness')},`,
    `  ${keep('carb_basis')}`,
    'WHERE (f.kind, f.name, f.category) IS DISTINCT FROM (EXCLUDED.kind, EXCLUDED.name, EXCLUDED.category)',
    '  OR ((f.nutrients, f.completeness, f.carb_basis)',
    '      IS DISTINCT FROM (EXCLUDED.nutrients, EXCLUDED.completeness, EXCLUDED.carb_basis)',
    `      AND NOT ${REFERENCED_BY_USER_DATA})`,
    'RETURNING f.id, f.source, f.source_id, (f.xmax = 0) AS inserted',
  ].join('\n');
  return { text, values };
}

/** Multi-row insert of portions (`foodId` is the foods.id uuid). */
export function buildPortionsInsert(rows: ReadonlyArray<{ foodId: string; portion: ImportPortion }>): SqlQuery {
  if (rows.length === 0) throw new Error('buildPortionsInsert: no portions');
  const values: unknown[] = [];
  for (const { foodId, portion: p } of rows) {
    values.push(foodId, p.label, p.amount, p.unit, p.grams, p.sortOrder);
  }
  const text =
    `INSERT INTO public.food_portions (${PORTION_COLUMNS.join(', ')})\n` +
    `VALUES ${placeholders(rows.length, PORTION_CASTS)}`;
  return { text, values };
}

const foodKey = (source: string, sourceId: string): string => `${source}\u0000${sourceId}`;

const asNumber = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function portionSignature(p: { label: string; amount: unknown; unit: unknown; grams: unknown; sortOrder: unknown }): string {
  return JSON.stringify([p.label, asNumber(p.amount), p.unit ?? null, asNumber(p.grams), Number(p.sortOrder)]);
}

export interface WriteOptions {
  /** Foods per transaction (default 500). */
  batchSize?: number;
  log?: Logger;
}

export interface WriteStats {
  /** Distinct foods processed. */
  foods: number;
  inserted: number;
  /** Rows whose data changed and were updated. */
  updated: number;
  /** Rows that already matched and were left untouched. */
  unchanged: number;
  /** Foods whose portions were replaced. */
  portionsReplacedFor: number;
  portionRowsInserted: number;
  /** Input foods ignored because the same (source, source_id) appeared twice. */
  duplicatesInInput: number;
  batches: number;
}

const PORTION_INSERT_CHUNK = 2000;

/** Writes foods + portions in batches of `batchSize`, one transaction per batch. */
export async function writeFoods(
  client: DbClient,
  input: readonly ImportFood[],
  opts: WriteOptions = {},
): Promise<WriteStats> {
  const batchSize = Math.max(1, opts.batchSize ?? 500);
  const log: Logger = opts.log ?? (() => {});

  const unique = new Map<string, ImportFood>();
  for (const food of input) unique.set(foodKey(food.source, food.sourceId), food);
  const foods = [...unique.values()];

  const stats: WriteStats = {
    foods: foods.length,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    portionsReplacedFor: 0,
    portionRowsInserted: 0,
    duplicatesInInput: input.length - foods.length,
    batches: 0,
  };

  for (let start = 0; start < foods.length; start += batchSize) {
    const batch = foods.slice(start, start + batchSize);
    stats.batches += 1;
    await client.query('BEGIN');
    try {
      const upsert = buildFoodsUpsert(batch);
      const upserted = await client.query(upsert.text, upsert.values);
      for (const row of upserted.rows) {
        if (row.inserted === true) stats.inserted += 1;
        else stats.updated += 1;
      }
      stats.unchanged += batch.length - upserted.rows.length;

      const idRows = await client.query(SELECT_FOOD_IDS_SQL, [
        batch.map((f) => f.source),
        batch.map((f) => f.sourceId),
      ]);
      const idByKey = new Map<string, string>();
      for (const row of idRows.rows) idByKey.set(foodKey(String(row.source), String(row.source_id)), String(row.id));
      const ids = batch.map((f) => {
        const id = idByKey.get(foodKey(f.source, f.sourceId));
        if (id === undefined) throw new Error(`food ${f.source}/${f.sourceId} missing after upsert`);
        return id;
      });

      const existing = await client.query(SELECT_PORTIONS_SQL, [ids]);
      const existingByFood = new Map<string, string[]>();
      for (const row of existing.rows) {
        const list = existingByFood.get(String(row.food_id)) ?? [];
        list.push(
          portionSignature({
            label: String(row.label),
            amount: row.amount,
            unit: row.unit,
            grams: row.grams,
            sortOrder: row.sort_order,
          }),
        );
        existingByFood.set(String(row.food_id), list);
      }

      const changedIds: string[] = [];
      const toInsert: Array<{ foodId: string; portion: ImportPortion }> = [];
      batch.forEach((food, i) => {
        const id = ids[i] as string;
        const wanted = food.portions.map((p) => portionSignature(p));
        const have = existingByFood.get(id) ?? [];
        if (wanted.length === have.length && wanted.every((sig, k) => sig === have[k])) return;
        changedIds.push(id);
        for (const portion of food.portions) toInsert.push({ foodId: id, portion });
      });

      if (changedIds.length > 0) {
        await client.query(DELETE_PORTIONS_SQL, [changedIds]);
        for (let i = 0; i < toInsert.length; i += PORTION_INSERT_CHUNK) {
          const q = buildPortionsInsert(toInsert.slice(i, i + PORTION_INSERT_CHUNK));
          await client.query(q.text, q.values);
        }
        stats.portionsReplacedFor += changedIds.length;
        stats.portionRowsInserted += toInsert.length;
      }
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // connection already broken; the original error is what matters
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`batch ${stats.batches} (foods ${start + 1}-${start + batch.length}) failed: ${reason}`, {
        cause: err,
      });
    }
    log(`  wrote ${Math.min(start + batch.length, foods.length).toLocaleString('en-US')} / ${foods.length.toLocaleString('en-US')} foods`);
  }
  return stats;
}

// ------------------------------------------------------------- connection

export interface PgConnection {
  client: DbClient;
  end(): Promise<void>;
  /** Secrets to scrub from any message before logging. */
  secrets: string[];
}

/** Connection settings derived from a Postgres URL; the password never appears in logs. */
export function buildPgConfig(
  dbUrl: string,
  sslOverride?: boolean,
): { connectionString: string; ssl: false | { rejectUnauthorized: boolean } } {
  const url = new URL(dbUrl);
  const mode = url.searchParams.get('sslmode');
  url.searchParams.delete('sslmode');
  const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  const useSsl = sslOverride ?? (mode !== null ? mode !== 'disable' : !isLocal);
  // Supabase's pooler / direct host present a certificate chain that is not in Node's trust store.
  return { connectionString: url.toString(), ssl: useSsl ? { rejectUnauthorized: false } : false };
}

/** Removes the URL and its password from text. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s !== '') out = out.split(s).join('***');
  return out;
}

/** Strings that must never be printed: the URL, its sanitised form and the password. */
export function urlSecrets(dbUrl: string): string[] {
  const secrets = [dbUrl];
  try {
    const parsed = new URL(dbUrl);
    secrets.push(parsed.password);
    try {
      secrets.push(decodeURIComponent(parsed.password));
    } catch {
      // keep the raw form only
    }
    secrets.push(buildPgConfig(dbUrl).connectionString);
  } catch {
    // not a parseable URL: only the raw string is known
  }
  return [...new Set(secrets)].filter((s) => s !== '');
}

/** Opens a `pg` connection. Never logs the URL. */
export async function connectDb(dbUrl: string, sslOverride?: boolean): Promise<PgConnection> {
  const config = buildPgConfig(dbUrl, sslOverride);
  const client = new pg.Client({ ...config, application_name: 'cal-importer' });
  await client.connect();
  const secrets = urlSecrets(dbUrl);
  return {
    client: {
      query: async (text, values) => {
        const res = await client.query(text, values as unknown[] | undefined);
        return { rows: res.rows as Array<Record<string, unknown>>, rowCount: res.rowCount };
      },
    },
    end: () => client.end(),
    secrets,
  };
}

/** Current database size in MB (pg_database_size). */
export async function getDatabaseSizeMb(client: DbClient): Promise<number | null> {
  try {
    const res = await client.query('SELECT pg_database_size(current_database()) AS bytes');
    const bytes = Number(res.rows[0]?.bytes);
    return Number.isFinite(bytes) ? bytes / (1024 * 1024) : null;
  } catch {
    return null;
  }
}
