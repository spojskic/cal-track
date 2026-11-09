import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  USER_A,
  USER_B,
  asAnon,
  asUser,
  createDb,
  createUsers,
  expectError,
  insertFood,
} from './harness';

describe('GTIN handling', () => {
  let db: PGlite;
  const ids: Record<string, string> = {};

  const byGtin = (uid: string, gtin: string | null) =>
    asUser(
      db,
      uid,
      async () =>
        (
          await db.query<{ id: string; name: string; gtin14: string }>(
            'select id, name, gtin14 from public.get_food_by_gtin($1)',
            [gtin],
          )
        ).rows,
    );

  beforeAll(async () => {
    db = await createDb();
    await createUsers(db);

    // UPC-A (12 digits) as an importer would write it
    ids.upc = await insertFood(db, {
      name: 'Cola Classic',
      source: 'fdc_branded',
      source_id: 'cola',
      kind: 'branded',
      gtin14: '737628064502',
    });
    // EAN-13
    ids.ean13 = await insertFood(db, {
      name: 'Dark chocolate',
      source: 'off',
      source_id: 'choc',
      kind: 'branded',
      gtin14: '4006381333931',
    });
    // EAN-8
    ids.ean8 = await insertFood(db, {
      name: 'Mints',
      source: 'off',
      source_id: 'mints',
      kind: 'branded',
      gtin14: '96385074',
    });
    // already GTIN-14
    ids.gtin14 = await insertFood(db, {
      name: 'Case of water',
      source: 'off',
      source_id: 'water',
      kind: 'branded',
      gtin14: '10012345678902',
    });
  });

  afterAll(async () => {
    await db.close();
  });

  describe('normalisation on write (trigger)', () => {
    it('left-pads any GTIN length to 14 digits', async () => {
      const r = await db.query<{ name: string; gtin14: string }>(
        `select name, gtin14 from public.foods where gtin14 is not null order by name`,
      );
      expect(r.rows).toEqual([
        { name: 'Case of water', gtin14: '10012345678902' },
        { name: 'Cola Classic', gtin14: '00737628064502' },
        { name: 'Dark chocolate', gtin14: '04006381333931' },
        { name: 'Mints', gtin14: '00000096385074' },
      ]);
    });

    it('strips separators and drops unusable codes instead of failing', async () => {
      const cases: Array<[string, string | null]> = [
        ['7-37628-06450-2', '00737628064502'],
        [' 4006381333931 ', '04006381333931'],
        ['', null],
        ['no digits', null],
        ['0', null],
        ['00000000', null],
        ['123456789012345', null], // 15 digits: not a GTIN
      ];
      const created: string[] = [];
      for (const [raw, expected] of cases) {
        const id = await insertFood(db, {
          name: `gtin case ${raw}`,
          source: 'custom',
          kind: 'custom',
          owner_id: USER_A,
          gtin14: raw,
        });
        created.push(id);
        const r = await db.query<{ gtin14: string | null }>(
          'select gtin14 from public.foods where id = $1',
          [id],
        );
        expect(r.rows[0]!.gtin14, JSON.stringify(raw)).toBe(expected);
      }
      // scratch rows must not shadow the fixtures in the lookup tests below
      await db.query('delete from public.foods where id = any($1::uuid[])', [created]);
    });

    it('normalises on update too', async () => {
      await db.query(`update public.foods set gtin14 = '12345670' where id = $1`, [ids.ean8]);
      const r = await db.query<{ gtin14: string }>(
        'select gtin14 from public.foods where id = $1',
        [ids.ean8],
      );
      expect(r.rows[0]!.gtin14).toBe('00000012345670');
      await db.query(`update public.foods set gtin14 = '96385074' where id = $1`, [ids.ean8]);
    });

    it('is not unique: two global sources may carry the same barcode', async () => {
      await insertFood(db, {
        name: 'Dup 1',
        source: 'off',
        source_id: 'dup-1',
        kind: 'branded',
        gtin14: '5000000000017',
      });
      await insertFood(db, {
        name: 'Dup 2',
        source: 'fdc_branded',
        source_id: 'dup-2',
        kind: 'branded',
        gtin14: '5000000000017',
      });
      const n = await db.query<{ n: number }>(
        `select count(*)::int as n from public.foods where gtin14 = '05000000000017'`,
      );
      expect(n.rows[0]!.n).toBe(2);
    });
  });

  describe('get_food_by_gtin', () => {
    it('finds a food whatever length the scanned code has', async () => {
      for (const code of [
        '737628064502',
        '0737628064502',
        '00737628064502',
        '7 37628 06450 2',
        '0-0737628-064502',
      ]) {
        const rows = await byGtin(USER_A, code);
        expect(
          rows.map((r) => r.id),
          code,
        ).toEqual([ids.upc]);
      }
      expect((await byGtin(USER_A, '4006381333931')).map((r) => r.id)).toEqual([ids.ean13]);
      expect((await byGtin(USER_A, '04006381333931')).map((r) => r.id)).toEqual([ids.ean13]);
      expect((await byGtin(USER_A, '96385074')).map((r) => r.id)).toEqual([ids.ean8]);
      expect((await byGtin(USER_A, '10012345678902')).map((r) => r.id)).toEqual([ids.gtin14]);
    });

    it('returns an empty set (not an error) for unknown or unusable input', async () => {
      for (const code of [
        '9999999999999',
        '',
        '   ',
        'abc',
        '0',
        '000000',
        '123456789012345',
        null,
      ]) {
        expect(await byGtin(USER_A, code), String(code)).toEqual([]);
      }
    });

    it('returns the full foods row', async () => {
      const r = await asUser(db, USER_A, () =>
        db.query<Record<string, unknown>>('select * from public.get_food_by_gtin($1)', [
          '737628064502',
        ]),
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({
        name: 'Cola Classic',
        gtin14: '00737628064502',
        source: 'fdc_branded',
        kind: 'branded',
      });
      expect(r.rows[0]).toHaveProperty('nutrients');
    });

    it('prefers the better source when several global rows share a GTIN', async () => {
      const rows = await byGtin(USER_A, '5000000000017');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.name).toBe('Dup 2'); // fdc_branded outranks off
    });

    it('prefers higher completeness within the same source', async () => {
      await insertFood(db, {
        name: 'Tie low',
        source: 'off',
        source_id: 'tie-1',
        kind: 'branded',
        gtin14: '5000000000024',
        completeness: 0.3,
      });
      const high = await insertFood(db, {
        name: 'Tie high',
        source: 'off',
        source_id: 'tie-2',
        kind: 'branded',
        gtin14: '5000000000024',
        completeness: 0.9,
      });
      expect((await byGtin(USER_A, '5000000000024')).map((r) => r.id)).toEqual([high]);
    });

    it('prefers the caller’s own food, and never shows another user’s', async () => {
      const mine = await insertFood(db, {
        name: 'My cola',
        source: 'custom',
        kind: 'custom',
        owner_id: USER_A,
        gtin14: '737628064502',
      });
      const bobs = await insertFood(db, {
        name: 'Bobs cola',
        source: 'custom',
        kind: 'custom',
        owner_id: USER_B,
        gtin14: '737628064502',
      });

      expect((await byGtin(USER_A, '737628064502')).map((r) => r.id)).toEqual([mine]);
      expect((await byGtin(USER_B, '737628064502')).map((r) => r.id)).toEqual([bobs]);
      const carol = await asUser(
        db,
        '00000000-0000-4000-8000-0000000000cc',
        async () =>
          (
            await db.query<{ id: string }>('select id from public.get_food_by_gtin($1)', [
              '737628064502',
            ])
          ).rows,
      );
      expect(carol.map((r) => r.id)).toEqual([ids.upc]);
    });

    it('ignores archived foods', async () => {
      await insertFood(db, {
        name: 'Old',
        source: 'off',
        source_id: 'old-1',
        kind: 'branded',
        gtin14: '5000000000031',
        archived: true,
      });
      expect(await byGtin(USER_A, '5000000000031')).toEqual([]);
    });

    it('is permission-denied for anon', async () => {
      const err = await asAnon(db, () =>
        expectError(db.query(`select * from public.get_food_by_gtin('737628064502')`)),
      );
      expect(err.message).toMatch(/permission denied/);
    });
  });
});
