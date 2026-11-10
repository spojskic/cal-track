import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MIGRATIONS_DIR,
  USER_A,
  asAnon,
  asService,
  asUser,
  createDb,
  createUsers,
  expectError,
} from './harness';

const DENIED = /permission denied/;
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const GROUPED = /^[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/;

const normalised = (code: string) => code.replace(/-/g, '');

describe('invite codes (migration 20261110000100)', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createDb();
    await createUsers(db);
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec('delete from private.invite_codes');
  });

  // The owner runs these in the SQL editor (role postgres); the Edge Function calls them as service_role.
  const create = async (note: string | null = null, maxUses = 1, validDays: number | null = 14) =>
    (
      await db.query<{ code: string }>('select public.create_invite_code($1, $2, $3) as code', [
        note,
        maxUses,
        validDays,
      ])
    ).rows[0]!.code;

  const consume = async (code: string | null) =>
    asService(
      db,
      async () =>
        (await db.query<{ r: string }>('select public.consume_invite_code($1) as r', [code]))
          .rows[0]!.r,
    );

  // PGlite is a single connection, so queries are queued instead of running in parallel; the race test below therefore
  // proves the "one winner" logic of the guarded UPDATE, not Postgres' row locking. Role switching (asService) is
  // session state and must not be interleaved, which is why the concurrent tests use this role-less variant.
  const consumeQueued = async (code: string) =>
    (await db.query<{ r: string }>('select public.consume_invite_code($1) as r', [code])).rows[0]!
      .r;

  const row = async (code: string) =>
    (
      await db.query<{
        code: string;
        note: string | null;
        max_uses: number;
        uses: number;
        expires_at: string | null;
        revoked_at: string | null;
        last_used_at: string | null;
      }>(
        `select code, note, max_uses, uses, expires_at::text, revoked_at::text, last_used_at::text
           from private.invite_codes where code = $1`,
        [normalised(code)],
      )
    ).rows[0];

  describe('access control', () => {
    it('keeps the table in the private schema with RLS enabled and NO policies, and no public copy', async () => {
      const rls = await db.query<{ relrowsecurity: boolean }>(
        `select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'private' and c.relname = 'invite_codes'`,
      );
      expect(rls.rows).toEqual([{ relrowsecurity: true }]);
      expect(
        (
          await db.query(
            `select 1 from pg_policies where schemaname = 'private' and tablename = 'invite_codes'`,
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await db.query(
            `select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relname = 'invite_codes'`,
          )
        ).rows,
      ).toEqual([]);
    });

    it.each([['anon'], ['authenticated']])('%s cannot touch the table', async (role) => {
      await db.exec(`insert into private.invite_codes (code) values ('ABCDEFGH2345')`);
      const run = (fn: () => Promise<unknown>) =>
        role === 'anon' ? asAnon(db, fn) : asUser(db, USER_A, fn);
      await run(async () => {
        for (const sql of [
          `select * from private.invite_codes`,
          `insert into private.invite_codes (code) values ('ZZZZZZZZ2345')`,
          `update private.invite_codes set uses = 0`,
          `delete from private.invite_codes`,
        ]) {
          expect((await expectError(db.query(sql))).message, sql).toMatch(DENIED);
        }
      });
    });

    it('the table is not reachable through the public schema or the Data API', async () => {
      await asUser(db, USER_A, async () => {
        const err = await expectError(db.query(`select * from public.invite_codes`));
        expect(err.message).toMatch(/does not exist/);
      });
    });

    it('the five RPCs are closed to anon and authenticated (execute revoked, public included)', async () => {
      const calls = [
        `select public.create_invite_code('x', 1, 1)`,
        `select * from public.list_invite_codes()`,
        `select public.revoke_invite_code('ABCDEFGH2345')`,
        `select public.consume_invite_code('ABCDEFGH2345')`,
        `select public.release_invite_code('ABCDEFGH2345')`,
      ];
      for (const run of [
        (fn: () => Promise<unknown>) => asAnon(db, fn),
        (fn: () => Promise<unknown>) => asUser(db, USER_A, fn),
      ]) {
        await run(async () => {
          for (const sql of calls)
            expect((await expectError(db.query(sql))).message, sql).toMatch(DENIED);
        });
      }
    });

    it('the private helpers are closed to clients too', async () => {
      await asUser(db, USER_A, async () => {
        for (const sql of [
          `select private.normalize_invite_code('abc')`,
          `select private.format_invite_code('ABCDEFGH2345')`,
          `select private.invite_random_bytes(8)`,
        ]) {
          expect((await expectError(db.query(sql))).message, sql).toMatch(DENIED);
        }
      });
    });

    it('service_role and postgres (the SQL editor) can execute every RPC', async () => {
      const privilege = await db.query<{ fn: string; role: string; ok: boolean }>(
        `select p.proname as fn, r.rolname as role, has_function_privilege(r.rolname, p.oid, 'execute') as ok
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
           cross join (values ('service_role'), ('postgres'), ('anon'), ('authenticated')) as r(rolname)
          where p.proname in ('create_invite_code', 'list_invite_codes', 'revoke_invite_code',
                              'consume_invite_code', 'release_invite_code')
          order by 1, 2`,
      );
      expect(privilege.rows).toHaveLength(20);
      for (const r of privilege.rows) {
        const allowed = r.role === 'service_role' || r.role === 'postgres';
        expect(r.ok, `${r.fn} for ${r.role}`).toBe(allowed);
      }
    });

    it('is SECURITY DEFINER with a fixed search_path (the migration-wide invariant, checked for these functions)', async () => {
      const r = await db.query<{ proname: string; prosecdef: boolean; fixed: boolean }>(
        `select p.proname, p.prosecdef,
                exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') as fixed
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where p.proname in ('create_invite_code', 'list_invite_codes', 'revoke_invite_code',
                              'consume_invite_code', 'release_invite_code',
                              'normalize_invite_code', 'format_invite_code', 'invite_random_bytes')
          order by 1`,
      );
      expect(r.rows).toHaveLength(8);
      for (const f of r.rows) {
        expect(f.fixed, f.proname).toBe(true);
        expect(f.prosecdef, f.proname).toBe(
          !['normalize_invite_code', 'format_invite_code', 'invite_random_bytes'].includes(
            f.proname,
          ),
        );
      }
    });
  });

  describe('create_invite_code', () => {
    it('returns XXXX-XXXX-XXXX from the unambiguous alphabet and stores the normalised code', async () => {
      const code = await create('for Anna', 1, 14);
      expect(code).toMatch(GROUPED);
      const stored = await row(code);
      expect(stored).toMatchObject({
        code: normalised(code),
        note: 'for Anna',
        max_uses: 1,
        uses: 0,
        revoked_at: null,
        last_used_at: null,
      });
      expect(stored!.code).toMatch(/^[A-Z0-9]{12}$/);
    });

    it('defaults to one use and 14 days; stores a trimmed note; null days never expires', async () => {
      const defaults = (
        await db.query<{ code: string }>('select public.create_invite_code() as code')
      ).rows[0]!.code;
      const d = await db.query<{ max_uses: number; note: string | null; days: number }>(
        `select max_uses, note, extract(epoch from (expires_at - now())) / 86400 as days
           from private.invite_codes where code = $1`,
        [normalised(defaults)],
      );
      expect(d.rows[0]).toMatchObject({ max_uses: 1, note: null });
      expect(Number(d.rows[0]!.days)).toBeGreaterThan(13.99);
      expect(Number(d.rows[0]!.days)).toBeLessThanOrEqual(14);

      const forever = await create('  spaced note  ', 5, null);
      expect(await row(forever)).toMatchObject({
        note: 'spaced note',
        max_uses: 5,
        expires_at: null,
      });
      expect((await row(await create('   ')))!.note).toBeNull();
    });

    it.each([
      ['max uses 0', `select public.create_invite_code('x', 0, 14)`],
      ['max uses null', `select public.create_invite_code('x', null, 14)`],
      ['max uses above 1000', `select public.create_invite_code('x', 1001, 14)`],
      ['0 valid days', `select public.create_invite_code('x', 1, 0)`],
      ['negative valid days', `select public.create_invite_code('x', 1, -3)`],
      ['more than ten years', `select public.create_invite_code('x', 1, 3651)`],
      ['a 201 character note', `select public.create_invite_code('${'n'.repeat(201)}', 1, 1)`],
    ])('rejects %s', async (_label, sql) => {
      const err = await expectError(db.query(sql));
      expect(err.message).toMatch(/must be|limited/);
      expect((await db.query('select count(*)::int as n from private.invite_codes')).rows).toEqual([
        { n: 0 },
      ]);
    });

    it('generates distinct codes that use the whole alphabet roughly uniformly (no modulo bias, no look-alikes)', async () => {
      const codes = new Set<string>();
      const counts = new Map<string, number>();
      for (let i = 0; i < 250; i++) {
        const code = await create(null, 1, 1);
        expect(code).toMatch(GROUPED);
        codes.add(code);
        for (const ch of normalised(code)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
      expect(codes.size).toBe(250);
      expect([...counts.keys()].sort().join('')).toBe([...ALPHABET].sort().join(''));
      // 3000 characters over 30 symbols: mean 100, standard deviation ~9.8. The window of +-5 sigma never flakes, yet a
      // sampler that wraps 30 and 31 around (`% 30`) puts two symbols at about 190 and is caught.
      for (const [ch, n] of counts) {
        expect(n, `count of ${ch}`).toBeGreaterThan(50);
        expect(n, `count of ${ch}`).toBeLessThan(150);
      }
      expect(ALPHABET).toHaveLength(30);
      for (const ambiguous of 'ILOU01') expect(ALPHABET).not.toContain(ambiguous);
    });

    it('draws its random bytes from the strong generator, without the fixed UUID version and variant bytes', async () => {
      const r = await db.query<{ n: number; a: string; b: string }>(
        `select octet_length(private.invite_random_bytes(40)) as n,
                encode(private.invite_random_bytes(32), 'hex') as a,
                encode(private.invite_random_bytes(32), 'hex') as b`,
      );
      expect(r.rows[0]!.n).toBe(40);
      expect(r.rows[0]!.a).not.toBe(r.rows[0]!.b);
      const spread = await db.query<{ distinct: number }>(
        `select count(distinct get_byte(b, i))::int as distinct
           from (select private.invite_random_bytes(1024) as b) s, generate_series(0, 1023) as i`,
      );
      expect(spread.rows[0]!.distinct).toBeGreaterThan(200);
      const err = await expectError(db.query('select private.invite_random_bytes(0)'));
      expect(err.message).toMatch(/invalid byte count/);
    });
  });

  describe('consume_invite_code', () => {
    it('uses one slot of a valid code and stamps last_used_at', async () => {
      const code = await create('x', 1, 14);
      expect(await consume(code)).toBe('ok');
      const stored = await row(code);
      expect(stored!.uses).toBe(1);
      expect(stored!.last_used_at).not.toBeNull();
    });

    it('normalises the input: case, dashes, spaces and stray punctuation do not matter', async () => {
      for (const variant of [
        (c: string) => c,
        (c: string) => normalised(c),
        (c: string) => c.toLowerCase(),
        (c: string) => ` ${c.toLowerCase().replace(/-/g, ' ')} `,
        (c: string) => c.replace(/-/g, '\u2013'), // en dash from rich text
        (c: string) => `${c.slice(0, 4)}\u00a0${c.slice(5, 9)}\u00a0${c.slice(10)}`, // non-breaking spaces
        (c: string) => `${normalised(c).slice(0, 6)}.${normalised(c).slice(6)}`,
      ]) {
        const code = await create(null, 1, 14);
        expect(await consume(variant(code))).toBe('ok');
        expect((await row(code))!.uses).toBe(1);
      }
    });

    it.each([
      ['unknown', 'ABCD-EFGH-2345'],
      ['too short', 'ABCD'],
      ['empty', ''],
      ['only separators', '--- ---'],
      ['too long', 'A'.repeat(33)],
      ['null', null],
    ])('answers invalid for %s', async (_label, input) => {
      await create(null, 1, 14); // another valid code must not matter
      expect(await consume(input)).toBe('invalid');
    });

    it('counts uses up to max_uses, then answers used_up', async () => {
      const code = await create('multi', 3, 14);
      expect([await consume(code), await consume(code), await consume(code)]).toEqual([
        'ok',
        'ok',
        'ok',
      ]);
      expect(await consume(code)).toBe('used_up');
      expect((await row(code))!.uses).toBe(3);
    });

    it('lets exactly one of many racing consumers use a single-use code', async () => {
      const code = await create(null, 1, 14);
      const results = await Promise.all(Array.from({ length: 8 }, () => consumeQueued(code)));
      expect(results.filter((r) => r === 'ok')).toHaveLength(1);
      expect(results.filter((r) => r === 'used_up')).toHaveLength(7);
      expect((await row(code))!.uses).toBe(1);
    });

    it('answers expired after expires_at (and never consumes a slot then)', async () => {
      const code = await create(null, 2, 1);
      await db.query(
        `update private.invite_codes set expires_at = now() - interval '1 second' where code = $1`,
        [normalised(code)],
      );
      expect(await consume(code)).toBe('expired');
      expect((await row(code))!.uses).toBe(0);
    });

    it('answers revoked, and revoked wins over expired and used_up', async () => {
      const code = await create(null, 1, 1);
      expect(await consume(code)).toBe('ok'); // used up
      await db.query(
        `update private.invite_codes set expires_at = now() - interval '1 day' where code = $1`,
        [normalised(code)],
      );
      expect(await consume(code)).toBe('expired'); // expired wins over used_up
      await asService(db, () => db.query('select public.revoke_invite_code($1)', [code]));
      expect(await consume(code)).toBe('revoked');
    });

    it('does not count refused attempts', async () => {
      const code = await create(null, 1, 14);
      await consume('ZZZZ-ZZZZ-ZZZZ');
      await consume('nope');
      expect((await row(code))!.uses).toBe(0);
      expect(await consume(code)).toBe('ok');
    });
  });

  describe('release_invite_code', () => {
    const release = (code: string) =>
      asService(db, () => db.query('select public.release_invite_code($1)', [code]));

    it('gives a slot back so the code can be used again', async () => {
      const code = await create(null, 1, 14);
      expect(await consume(code)).toBe('ok');
      expect(await consume(code)).toBe('used_up');
      await release(code.toLowerCase());
      expect((await row(code))!.uses).toBe(0);
      expect(await consume(code)).toBe('ok');
    });

    it('never goes below zero and ignores unknown codes', async () => {
      const code = await create(null, 2, 14);
      await release(code);
      await release(code);
      expect((await row(code))!.uses).toBe(0);
      await release('ABCD-EFGH-2345');
      await release('');
      expect((await db.query('select count(*)::int as n from private.invite_codes')).rows).toEqual([
        { n: 1 },
      ]);
    });
  });

  describe('revoke_invite_code', () => {
    const revoke = async (code: string) =>
      (
        await asService(db, () =>
          db.query<{ r: boolean }>('select public.revoke_invite_code($1) as r', [code]),
        )
      ).rows[0]!.r;

    it('revokes a code, reports whether it exists, and keeps the first revocation time', async () => {
      const code = await create(null, 1, 14);
      expect(await revoke(code.toLowerCase())).toBe(true);
      const first = (await row(code))!.revoked_at;
      expect(first).not.toBeNull();
      await db.query(`select pg_sleep(0.01)`);
      expect(await revoke(code)).toBe(true);
      expect((await row(code))!.revoked_at).toBe(first);
      expect(await revoke('ABCD-EFGH-2345')).toBe(false);
      expect(await revoke('')).toBe(false);
    });
  });

  describe('list_invite_codes', () => {
    it('shows grouped codes newest first with a status', async () => {
      const active = await create('active', 2, 14);
      const usedUp = await create('used up', 1, 14);
      const expired = await create('expired', 1, 14);
      const revoked = await create('revoked', 1, 14);
      await consume(usedUp);
      await db.query(
        `update private.invite_codes set expires_at = now() - interval '1 hour' where code = $1`,
        [normalised(expired)],
      );
      await db.query('select public.revoke_invite_code($1)', [revoked]);
      // distinct creation times for a stable order
      let i = 0;
      for (const code of [active, usedUp, expired, revoked]) {
        await db.query(
          `update private.invite_codes set created_at = now() + $1 * interval '1 minute' where code = $2`,
          [i++, normalised(code)],
        );
      }

      const rows = (
        await db.query<{
          code: string;
          note: string;
          uses: number;
          max_uses: number;
          status: string;
        }>('select code, note, uses, max_uses, status from public.list_invite_codes()')
      ).rows;
      expect(rows).toEqual([
        { code: revoked, note: 'revoked', uses: 0, max_uses: 1, status: 'revoked' },
        { code: expired, note: 'expired', uses: 0, max_uses: 1, status: 'expired' },
        { code: usedUp, note: 'used up', uses: 1, max_uses: 1, status: 'used_up' },
        { code: active, note: 'active', uses: 0, max_uses: 2, status: 'active' },
      ]);
      for (const r of rows) expect(r.code).toMatch(GROUPED);
    });

    it('lists nothing for an empty table and works for service_role', async () => {
      const rows = await asService(db, () => db.query('select * from public.list_invite_codes()'));
      expect(rows.rows).toEqual([]);
    });
  });

  describe('migration', () => {
    it('is idempotent: running it again keeps the codes and their usage', async () => {
      const code = await create('keep me', 2, 14);
      expect(await consume(code)).toBe('ok');
      const sql = readFileSync(join(MIGRATIONS_DIR, '20261110000100_invite_codes.sql'), 'utf8');
      await db.exec(sql);
      await db.exec(sql);
      expect(await row(code)).toMatchObject({ note: 'keep me', max_uses: 2, uses: 1 });
      expect(await consume(code)).toBe('ok');
      expect(await consume(code)).toBe('used_up');
    });

    it('enforces its own invariants on direct inserts (normalised codes, positive limits)', async () => {
      for (const sql of [
        `insert into private.invite_codes (code) values ('lowercase1234')`,
        `insert into private.invite_codes (code) values ('ABCD-EFGH-2345')`,
        `insert into private.invite_codes (code) values ('SHORT')`,
        `insert into private.invite_codes (code, max_uses) values ('ABCDEFGH2345', 0)`,
        `insert into private.invite_codes (code, uses) values ('ABCDEFGH2345', -1)`,
      ]) {
        expect((await expectError(db.query(sql))).message, sql).toMatch(
          /violates check constraint/,
        );
      }
      await db.exec(`insert into private.invite_codes (code) values ('ABCDEFGH2345')`);
      expect(
        (
          await expectError(
            db.query(`insert into private.invite_codes (code) values ('ABCDEFGH2345')`),
          )
        ).message,
      ).toMatch(/unique/);
    });
  });
});
