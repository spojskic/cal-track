import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MIGRATIONS_DIR,
  USER_A,
  USER_B,
  asAnon,
  asService,
  asUser,
  createDb,
  createUsers,
  expectError,
} from './harness';

const FILE = '20261110000108_invite_email.sql';
const DENIED = /permission denied/;
const GROUPED = /^[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/;
const EMAIL_RULE = `'^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]{2,}$'`;

interface Row {
  code: string;
  note: string | null;
  invited_email: string | null;
  uses: number;
  max_uses: number;
  status: string;
}

// USER_A is the super admin, USER_B an ordinary user.
describe(`invite codes are made for an e-mail address (migration ${FILE})`, () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createDb();
    await createUsers(db);
    await db.query('update public.profiles set is_admin = true where user_id = $1', [USER_A]);
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec('delete from private.invite_codes');
  });

  const createFor = async (email: string | null, maxUses = 1, validDays: number | null = 14) =>
    (
      await db.query<{ code: string }>('select public.create_invite_code_for($1, $2, $3) as code', [
        email,
        maxUses,
        validDays,
      ])
    ).rows[0]!.code;

  const stored = async (code: string) =>
    (
      await db.query<{ invited_email: string | null; note: string | null; max_uses: number }>(
        `select invited_email, note, max_uses from private.invite_codes where code = $1`,
        [code.replaceAll('-', '')],
      )
    ).rows[0];

  const adminCreate = (email: string | null, maxUses = 1, validDays: number | null = 14) =>
    asUser(
      db,
      USER_A,
      async () =>
        (
          await db.query<{ code: string }>('select public.admin_create_invite_code_for($1, $2, $3) as code', [
            email,
            maxUses,
            validDays,
          ])
        ).rows[0]!.code,
    );

  const adminList = () =>
    asUser(db, USER_A, async () => (await db.query<Row>('select * from public.admin_list_invites()')).rows);

  describe('the column', () => {
    it('is a nullable text column of the private table, with an index on the filled values', async () => {
      const col = await db.query(
        `select data_type, is_nullable from information_schema.columns
          where table_schema = 'private' and table_name = 'invite_codes' and column_name = 'invited_email'`,
      );
      expect(col.rows).toEqual([{ data_type: 'text', is_nullable: 'YES' }]);
      const idx = await db.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where schemaname = 'private' and indexname = 'invite_codes_invited_email_idx'`,
      );
      expect(idx.rows).toHaveLength(1);
      expect(idx.rows[0]!.indexdef).toMatch(/WHERE \(invited_email IS NOT NULL\)/);
    });

    it('refuses an invalid, upper-case or over-long value, whoever writes it', async () => {
      for (const bad of ['Anna@Example.com', 'anna', 'anna@', '@example.com', 'a b@example.com', 'a@b', 'a@@example.com', `${'a'.repeat(250)}@example.com`]) {
        const err = await expectError(
          db.query(`insert into private.invite_codes (code, invited_email) values ('ABCDEFGH2345', $1)`, [bad]),
        );
        expect(err.code, bad).toBe('23514');
      }
      await db.query(`insert into private.invite_codes (code, invited_email) values ('ABCDEFGH2345', 'anna+rations@example.co.uk')`);
      await db.query(`insert into private.invite_codes (code, invited_email) values ('ABCDEFGH2346', null)`);
    });

    it('stays unreachable for clients (the table is closed, the Data API does not expose it)', async () => {
      await asUser(db, USER_A, async () => {
        const err = await expectError(db.query(`select invited_email from private.invite_codes`));
        expect(err.message).toMatch(DENIED);
      });
    });

    it('uses the same e-mail rule as the sign-up form of the app (the SQL regex accepts what isPlausibleEmail accepts)', async () => {
      const good = ['a@b.co', 'first.last+tag@sub.example.org'];
      const bad = ['a@b', 'a@b.c', 'a b@c.de', '@x.de', 'a@.de', 'a@@x.de'];
      for (const email of [...good, ...bad]) {
        const sql = (await db.query<{ ok: boolean }>(`select $1::text ~ ${EMAIL_RULE} as ok`, [email])).rows[0]!.ok;
        const app = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
        expect(sql, email).toBe(app);
      }
    });
  });

  describe('the old notes', () => {
    it('a note that is exactly an e-mail also becomes the invited e-mail (the note stays); any other note does not', async () => {
      await db.exec(`
        insert into private.invite_codes (code, note) values
          ('AAAAAAAA2222', '  Dora@Example.com '),
          ('AAAAAAAA3333', 'for Anna'),
          ('AAAAAAAA4444', 'Dora (dora@example.com)'),
          ('AAAAAAAA5555', null);
        insert into private.invite_codes (code, note, invited_email) values ('AAAAAAAA6666', 'keep@example.com', 'other@example.com');
      `);
      // the migration's own statement, run on rows that were made before it (it is idempotent)
      const sql = readFileSync(join(MIGRATIONS_DIR, FILE), 'utf8');
      const update = /update private\.invite_codes c[\s\S]*?;/.exec(sql)![0];
      await db.exec(update);
      await db.exec(update);
      const rows = await db.query<{ code: string; note: string | null; invited_email: string | null }>(
        'select code, note, invited_email from private.invite_codes order by code',
      );
      expect(rows.rows).toEqual([
        { code: 'AAAAAAAA2222', note: '  Dora@Example.com ', invited_email: 'dora@example.com' },
        { code: 'AAAAAAAA3333', note: 'for Anna', invited_email: null },
        { code: 'AAAAAAAA4444', note: 'Dora (dora@example.com)', invited_email: null },
        { code: 'AAAAAAAA5555', note: null, invited_email: null },
        { code: 'AAAAAAAA6666', note: 'keep@example.com', invited_email: 'other@example.com' },
      ]);
    });

    it('the whole migration can be applied again without an error and keeps working', async () => {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, FILE), 'utf8'));
      expect(await createFor('again@example.com')).toMatch(GROUPED);
    });
  });

  describe('create_invite_code_for (owner / service role)', () => {
    it('makes XXXX-XXXX-XXXX for an e-mail that is trimmed and lower-cased, with the uses and expiry given', async () => {
      const code = await createFor('  Anna@Example.COM ', 3, 7);
      expect(code).toMatch(GROUPED);
      expect(await stored(code)).toEqual({ invited_email: 'anna@example.com', note: null, max_uses: 3 });
      const expiry = await db.query<{ days: number }>(
        `select round(extract(epoch from (expires_at - created_at)) / 86400)::int as days
           from private.invite_codes where code = $1`,
        [code.replaceAll('-', '')],
      );
      expect(expiry.rows[0]!.days).toBe(7);
      const never = await createFor('ben@example.com', 1, null);
      expect(
        (await db.query('select 1 from private.invite_codes where code = $1 and expires_at is null', [never.replaceAll('-', '')])).rows,
      ).toHaveLength(1);
    });

    it('needs an e-mail: missing, blank, malformed or longer than 254 characters is refused with invalid_parameter_value, and no code is left', async () => {
      for (const email of [null, '', '   ', 'anna', 'anna@', 'a@b', 'a b@example.com', `${'a'.repeat(250)}@example.com`]) {
        const err = await expectError(db.query('select public.create_invite_code_for($1)', [email]));
        expect(err.code, String(email)).toBe('22023');
      }
      expect((await db.query('select 1 from private.invite_codes')).rows).toEqual([]);
    });

    it('keeps the checks of create_invite_code for the uses and the days, and rolls the whole call back', async () => {
      for (const [uses, days] of [[0, 14], [1001, 14], [1, 0], [1, 3651]] as const) {
        const err = await expectError(db.query('select public.create_invite_code_for($1, $2, $3)', ['a@example.com', uses, days]));
        expect(err.code, `${uses}/${days}`).toBe('22023');
      }
      expect((await db.query('select 1 from private.invite_codes')).rows).toEqual([]);
    });

    it('is executable by service_role and postgres only', async () => {
      const privilege = await db.query<{ role: string; ok: boolean }>(
        `select r.rolname as role, has_function_privilege(r.rolname, p.oid, 'execute') as ok
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
           cross join (values ('service_role'), ('postgres'), ('anon'), ('authenticated')) as r(rolname)
          where p.proname = 'create_invite_code_for'
          order by 1`,
      );
      expect(privilege.rows).toEqual([
        { role: 'anon', ok: false },
        { role: 'authenticated', ok: false },
        { role: 'postgres', ok: true },
        { role: 'service_role', ok: true },
      ]);
      await asService(db, async () => {
        const r = await db.query<{ code: string }>(`select public.create_invite_code_for('svc@example.com') as code`);
        expect(r.rows[0]!.code).toMatch(GROUPED);
      });
      await asUser(db, USER_A, async () => {
        expect((await expectError(db.query(`select public.create_invite_code_for('a@example.com')`))).message).toMatch(DENIED);
      });
      await asAnon(db, async () => {
        expect((await expectError(db.query(`select public.create_invite_code_for('a@example.com')`))).message).toMatch(DENIED);
      });
    });

    it('the old create_invite_code (note) still works and leaves the e-mail empty', async () => {
      const code = (await db.query<{ c: string }>(`select public.create_invite_code('for Anna', 1, 14) as c`)).rows[0]!.c;
      expect(await stored(code)).toEqual({ invited_email: null, note: 'for Anna', max_uses: 1 });
    });
  });

  describe('the admin functions of the app', () => {
    it('are SECURITY DEFINER with a fixed search_path, and executable by signed-in users and service_role but never anon', async () => {
      const r = await db.query<{ proname: string; prosecdef: boolean; fixed: boolean; roles: string }>(
        `select p.proname, p.prosecdef,
                exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') as fixed,
                (select string_agg(x.rolname, ',' order by x.rolname)
                   from (values ('anon'), ('authenticated'), ('service_role'), ('postgres')) as x(rolname)
                  where has_function_privilege(x.rolname, p.oid, 'execute')) as roles
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
          where p.proname in ('admin_create_invite_code_for', 'admin_list_invites')
          order by 1`,
      );
      expect(r.rows).toEqual([
        { proname: 'admin_create_invite_code_for', prosecdef: true, fixed: true, roles: 'authenticated,postgres,service_role' },
        { proname: 'admin_list_invites', prosecdef: true, fixed: true, roles: 'authenticated,postgres,service_role' },
      ]);
    });

    it('the super admin creates a code for an e-mail and lists it, with the e-mail next to the (empty) note', async () => {
      const code = await adminCreate('  Dora@Example.com', 2, 30);
      expect(code).toMatch(GROUPED);
      const rows = await adminList();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ code, invited_email: 'dora@example.com', note: null, max_uses: 2, uses: 0, status: 'active' });
      expect(Object.keys(rows[0]!)).toEqual(['code', 'note', 'invited_email', 'uses', 'max_uses', 'status', 'expires_at', 'revoked_at', 'created_at', 'last_used_at']);
    });

    it('an e-mail is required and checked; nothing is created for a refused call', async () => {
      for (const bad of [null, '', 'not an e-mail']) {
        const err = await asUser(db, USER_A, () => expectError(db.query('select public.admin_create_invite_code_for($1, 1, 14)', [bad])));
        expect(err.code, String(bad)).toBe('22023');
      }
      expect(await adminList()).toEqual([]);
    });

    it('the arguments can be named the way PostgREST names them (p_email, p_max_uses, p_valid_days)', async () => {
      const code = await asUser(
        db,
        USER_A,
        async () =>
          (
            await db.query<{ c: string }>(
              `select public.admin_create_invite_code_for(p_email => 'named@example.com', p_max_uses => 2, p_valid_days => null) as c`,
            )
          ).rows[0]!.c,
      );
      expect((await adminList()).find((r) => r.code === code)).toMatchObject({ invited_email: 'named@example.com', max_uses: 2 });
    });

    it('lists the status of every kind of code', async () => {
      const used = await adminCreate('used@example.com');
      const old = await adminCreate('expired@example.com');
      const revoked = await adminCreate('revoked@example.com');
      await adminCreate('fresh@example.com', 2);
      await db.query(`select public.consume_invite_code($1)`, [used]);
      await db.query(`update private.invite_codes set expires_at = now() - interval '1 day' where code = $1`, [old.replaceAll('-', '')]);
      await asUser(db, USER_A, () => db.query('select public.admin_revoke_invite_code($1)', [revoked]));
      expect(Object.fromEntries((await adminList()).map((r) => [r.invited_email, r.status]))).toEqual({
        'used@example.com': 'used_up',
        'expired@example.com': 'expired',
        'revoked@example.com': 'revoked',
        'fresh@example.com': 'active',
      });
    });

    it('a non-admin gets 42501 from both, before anything about the e-mail is looked at; anon is refused', async () => {
      for (const sql of [`select public.admin_create_invite_code_for('not an e-mail')`, `select * from public.admin_list_invites()`]) {
        const err = await asUser(db, USER_B, () => expectError(db.query(sql)));
        expect(err.code, sql).toBe('42501');
        await asAnon(db, async () => {
          expect((await expectError(db.query(sql))).message, sql).toMatch(DENIED);
        });
      }
      expect((await db.query('select 1 from private.invite_codes')).rows).toEqual([]);
    });

    it('the functions of 107 are unchanged and keep working for app builds made before (note based, 9 columns)', async () => {
      const code = await asUser(
        db,
        USER_A,
        async () => (await db.query<{ c: string }>(`select public.admin_create_invite_code('for Old App', 1, 14) as c`)).rows[0]!.c,
      );
      const rows = await asUser(db, USER_A, async () => (await db.query<Row>('select * from public.admin_list_invite_codes()')).rows);
      expect(rows.find((r) => r.code === code)).toMatchObject({ note: 'for Old App' });
      expect(Object.keys(rows[0]!)).toEqual(['code', 'note', 'uses', 'max_uses', 'status', 'expires_at', 'revoked_at', 'created_at', 'last_used_at']);
    });

    it('the list is a set-returning function PostgREST can page: filter on status, order, limit / offset, count', async () => {
      for (let i = 0; i < 5; i++) await adminCreate(`p${i}@example.com`);
      await db.exec(`update private.invite_codes set revoked_at = now() where invited_email in ('p1@example.com', 'p3@example.com')`);
      await asUser(db, USER_A, async () => {
        // what PostgREST runs for  ?status=eq.active&order=created_at.desc,code.asc&limit=2&offset=1
        const page = await db.query<Row>(
          `select * from public.admin_list_invites() where status = 'active' order by created_at desc, code asc limit 2 offset 1`,
        );
        expect(page.rows).toHaveLength(2);
        expect(page.rows.every((r) => r.status === 'active')).toBe(true);
        // ?status=neq.active  with Prefer: count=exact
        const closed = await db.query<{ n: number }>(
          `select count(*)::int as n from public.admin_list_invites() where status <> 'active'`,
        );
        expect(closed.rows[0]!.n).toBe(2);
        const active = await db.query<{ n: number }>(
          `select count(*)::int as n from public.admin_list_invites() where status = 'active'`,
        );
        expect(active.rows[0]!.n).toBe(3);
      });
    });
  });
});
