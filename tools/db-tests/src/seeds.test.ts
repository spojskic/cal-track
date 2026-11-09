import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DRI_TABLE, MET_ACTIVITIES, NUTRIENTS } from '../../../packages/core/src';
import { USER_A, asUser, createDb, createUsers } from './harness';

const SCRIPT = resolve(__dirname, '../../../packages/core/scripts/generate-seed-sql.ts');

let db: PGlite;
let seedDir: string;

async function loadSeeds(): Promise<void> {
  for (const file of readdirSync(seedDir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(seedDir, file), 'utf8'));
  }
}

async function count(table: string): Promise<number> {
  const r = await db.query<{ n: number }>(`select count(*)::int as n from public.${table}`);
  return r.rows[0]!.n;
}

describe('core-generated seeds load into the real schema', () => {
  beforeAll(async () => {
    seedDir = mkdtempSync(join(tmpdir(), 'cal-seed-'));
    // `node --import tsx` (not the tsx CLI) so this also works in sandboxes that forbid unix sockets.
    execFileSync(process.execPath, ['--import', 'tsx', SCRIPT, '--out', seedDir], { stdio: 'pipe' });
    db = await createDb();
    await loadSeeds();
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('inserts every catalog nutrient, DRI row and exercise activity', async () => {
    expect(await count('nutrients')).toBe(NUTRIENTS.length);
    expect(await count('dri_values')).toBe(DRI_TABLE.length);
    expect(await count('exercise_activities')).toBe(MET_ACTIVITIES.length);
  });

  it('is idempotent: running the seeds twice does not duplicate anything', async () => {
    await loadSeeds();
    expect(await count('nutrients')).toBe(NUTRIENTS.length);
    expect(await count('dri_values')).toBe(DRI_TABLE.length);
    expect(await count('exercise_activities')).toBe(MET_ACTIVITIES.length);
  });

  it('keeps FDC ids for lookup (energy = 1008)', async () => {
    const r = await db.query<{ code: string }>(`select code from public.nutrients where fdc_id = 1008`);
    expect(r.rows.map((x) => x.code)).toEqual(['ENERGY_KCAL']);
  });

  it('exposes reference data to signed-in users', async () => {
    await createUsers(db, [{ id: USER_A, email: 'a@example.com' }]);
    const rows = await asUser(db, USER_A, async (d) =>
      (await d.query<{ n: number }>(`select count(*)::int as n from public.nutrients`)).rows[0]!.n,
    );
    expect(rows).toBe(NUTRIENTS.length);
  });
});
