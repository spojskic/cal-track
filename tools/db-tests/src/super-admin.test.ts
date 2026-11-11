import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  USER_A,
  USER_B,
  asAnon,
  asService,
  asUser,
  createDb,
  createUsers,
  expectError,
  withRole,
} from './harness';

const DENIED = /permission denied/;
const GROUPED = /^[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/;

const KNOWN_CLIENT_DEFINER_FUNCTIONS: string[] = [
  'private.search_foods_ranked(q text, max_results integer, kinds text[])',
  'public.admin_create_invite_code(p_note text, p_max_uses integer, p_valid_days integer)',
  'public.admin_create_invite_code_for(p_email text, p_max_uses integer, p_valid_days integer)',
  'public.admin_list_invite_codes()',
  'public.admin_list_invites()',
  'public.admin_revoke_invite_code(p_code text)',
];

interface CodeRow {
  code: string;
  note: string | null;
  uses: number;
  max_uses: number;
  status: string;
  expires_at: string | null;
}

// USER_A is the super admin, USER_B an ordinary user.
describe('super admin and the in-app invite codes (migration 20261110000107)', () => {
  let db: PGlite;

  const isAdmin = async (userId: string) =>
    (
      await db.query<{ is_admin: boolean }>('select is_admin from public.profiles where user_id = $1', [
        userId,
      ])
    ).rows[0]!.is_admin;

  const setAdmin = (userId: string, value: boolean) =>
    db.query('update public.profiles set is_admin = $2 where user_id = $1', [userId, value]);

  beforeAll(async () => {
    db = await createDb();
    await createUsers(db);
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec('delete from private.invite_codes');
    // a test may delete the profile row of an ordinary user: bring it back
    await db.query('insert into public.profiles (user_id) values ($1) on conflict (user_id) do nothing', [USER_B]);
    await setAdmin(USER_A, true); // postgres: allowed
    await setAdmin(USER_B, false);
  });

  const create = (userId: string, note: string | null = null, maxUses = 1, validDays: number | null = 14) =>
    asUser(
      db,
      userId,
      async () =>
        (
          await db.query<{ code: string }>('select public.admin_create_invite_code($1, $2, $3) as code', [
            note,
            maxUses,
            validDays,
          ])
        ).rows[0]!.code,
    );

  const list = (userId: string) =>
    asUser(
      db,
      userId,
      async () => (await db.query<CodeRow>('select * from public.admin_list_invite_codes()')).rows,
    );

  describe('the flag', () => {
    it('defaults to false for every new account', async () => {
      const col = await db.query<{ column_default: string; is_nullable: string; data_type: string }>(
        `select column_default, is_nullable, data_type from information_schema.columns
          where table_schema = 'public' and table_name = 'profiles' and column_name = 'is_admin'`,
      );
      expect(col.rows).toEqual([{ column_default: 'false', is_nullable: 'NO', data_type: 'boolean' }]);
      await db.query(`insert into auth.users (id, email) values ($1, 'carol@example.com')`, [
        '00000000-0000-4000-8000-00000000000c',
      ]);
      expect(await isAdmin('00000000-0000-4000-8000-00000000000c')).toBe(false);
    });

    it('is readable on the own profile only (the app shows the admin screen from it)', async () => {
      await asUser(db, USER_A, async () => {
        const r = await db.query<{ user_id: string; is_admin: boolean }>(
          'select user_id, is_admin from public.profiles',
        );
        expect(r.rows).toEqual([{ user_id: USER_A, is_admin: true }]);
      });
    });

    it('an ordinary user cannot make themselves super admin by updating their profile', async () => {
      await asUser(db, USER_B, async () => {
        const err = await expectError(
          db.query('update public.profiles set is_admin = true where user_id = $1', [USER_B]),
        );
        expect(err.message).toMatch(/is_admin can only be changed by the app owner/);
        expect(err.code).toBe('42501');
      });
      expect(await isAdmin(USER_B)).toBe(false);
    });

    it('...nor with an upsert (insert .. on conflict do update), nor by deleting the profile and inserting one with the flag', async () => {
      await asUser(db, USER_B, async () => {
        const upsert = await expectError(
          db.query(
            `insert into public.profiles (user_id, is_admin) values ($1, true)
             on conflict (user_id) do update set is_admin = excluded.is_admin`,
            [USER_B],
          ),
        );
        expect(upsert.message).toMatch(/is_admin can only be set by the app owner/);
        await db.query('delete from public.profiles where user_id = $1', [USER_B]);
        const insert = await expectError(
          db.query('insert into public.profiles (user_id, is_admin) values ($1, true)', [USER_B]),
        );
        expect(insert.message).toMatch(/is_admin can only be set by the app owner/);
        // without the flag the insert is fine, and the flag stays false
        await db.query('insert into public.profiles (user_id) values ($1)', [USER_B]);
      });
      expect(await isAdmin(USER_B)).toBe(false);
    });

    it('...the UPDATE branch of an upsert (insert .. on conflict do update set is_admin = true) is guarded too', async () => {
      await asUser(db, USER_B, async () => {
        const err = await expectError(
          db.query(
            `insert into public.profiles (user_id) values ($1)
             on conflict (user_id) do update set is_admin = true`,
            [USER_B],
          ),
        );
        expect(err.code).toBe('42501');
      });
      expect(await isAdmin(USER_B)).toBe(false);
    });

    it('the super admin can upsert their profile the way the app does (without is_admin) and keeps the flag', async () => {
      await asUser(db, USER_A, async () => {
        await db.query(
          `insert into public.profiles (user_id, display_name) values ($1, 'Owner')
           on conflict (user_id) do update set display_name = excluded.display_name`,
          [USER_A],
        );
      });
      expect(await isAdmin(USER_A)).toBe(true);
    });

    it("nobody can touch another user's profile: B changes nothing of A's row, so A stays super admin", async () => {
      await asUser(db, USER_B, async () => {
        const r = await db.query(`update public.profiles set is_admin = false where user_id = $1`, [USER_A]);
        expect(r.affectedRows).toBe(0);
        const r2 = await db.query(`update public.profiles set display_name = 'x' where user_id = $1`, [USER_A]);
        expect(r2.affectedRows).toBe(0);
        const del = await db.query(`delete from public.profiles where user_id = $1`, [USER_A]);
        expect(del.affectedRows).toBe(0);
      });
      expect(await isAdmin(USER_A)).toBe(true);
    });

    it('the guard trigger is enabled and fires BEFORE INSERT and UPDATE for each row, without a WHEN clause', async () => {
      const r = await db.query<{ tgname: string; tgenabled: string; tgtype: number; no_when: boolean }>(
        `select t.tgname, t.tgenabled, t.tgtype::int as tgtype, t.tgqual is null as no_when
           from pg_trigger t
          where t.tgrelid = 'public.profiles'::regclass and not t.tgisinternal
          order by t.tgname`,
      );
      const guard = r.rows.find((t) => t.tgname === 'profiles_guard_admin_flag');
      // tgtype bits: ROW 1 + BEFORE 2 + INSERT 4 + UPDATE 16
      expect(guard).toEqual({ tgname: 'profiles_guard_admin_flag', tgenabled: 'O', tgtype: 23, no_when: true });
    });

    it('the super admin cannot switch the flag off through the API either, but edits the rest of the profile freely', async () => {
      await asUser(db, USER_A, async () => {
        const err = await expectError(
          db.query('update public.profiles set is_admin = false where user_id = $1', [USER_A]),
        );
        expect(err.code).toBe('42501');
        // an unchanged flag (e.g. a client that writes the whole row back) and other columns are fine
        await db.query(
          `update public.profiles set is_admin = true, display_name = 'Owner' where user_id = $1`,
          [USER_A],
        );
      });
      expect(await isAdmin(USER_A)).toBe(true);
    });

    it('anon cannot write profiles at all', async () => {
      await asAnon(db, async () => {
        const err = await expectError(db.query('update public.profiles set is_admin = true'));
        expect(err.message).toMatch(DENIED);
      });
    });

    it('postgres (SQL editor / Table Editor) and service_role can change it', async () => {
      await setAdmin(USER_B, true);
      expect(await isAdmin(USER_B)).toBe(true);
      await asService(db, async () => {
        await db.query('update public.profiles set is_admin = false where user_id = $1', [USER_B]);
      });
      expect(await isAdmin(USER_B)).toBe(false);
    });

    it('the guard is SECURITY INVOKER (a SECURITY DEFINER guard would see its owner, not the request role)', async () => {
      const r = await db.query<{ prosecdef: boolean; fixed: boolean }>(
        `select p.prosecdef,
                exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') as fixed
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'private' and p.proname = 'guard_profile_admin_flag'`,
      );
      expect(r.rows).toEqual([{ prosecdef: false, fixed: true }]);
    });

    it('the client-callable SECURITY DEFINER functions are exactly the known list, and none of the others touches profiles', async () => {
      const r = await db.query<{ fn: string; src: string }>(
        `select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn, p.prosrc as src
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where p.prosecdef and n.nspname in ('public', 'private')
            and has_function_privilege('authenticated', p.oid, 'execute')
          order by 1`,
      );
      // A new client-callable SECURITY DEFINER function runs with its owner's rights: add it here only after checking that it cannot
      // be used to write profiles.is_admin (the trigger lets the owner role through).
      expect(r.rows.map((x) => x.fn).sort()).toEqual([...KNOWN_CLIENT_DEFINER_FUNCTIONS].sort());
      const touching = r.rows.filter((x) => !x.fn.startsWith('public.admin_') && /\bprofiles\b/i.test(x.src)).map((x) => x.fn);
      expect(touching).toEqual([]);
    });

    it('the helpers in the private schema are closed to clients', async () => {
      await asUser(db, USER_A, async () => {
        for (const sql of [`select private.is_super_admin()`, `select private.guard_profile_admin_flag()`]) {
          expect((await expectError(db.query(sql))).message, sql).toMatch(DENIED);
        }
      });
    });
  });

  describe('the admin RPCs', () => {
    it('execute: authenticated, service_role and postgres yes; anon and public no', async () => {
      const privilege = await db.query<{ fn: string; role: string; ok: boolean }>(
        `select p.proname as fn, r.rolname as role, has_function_privilege(r.rolname, p.oid, 'execute') as ok
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
           cross join (values ('service_role'), ('postgres'), ('anon'), ('authenticated')) as r(rolname)
          where p.proname in ('admin_create_invite_code', 'admin_list_invite_codes', 'admin_revoke_invite_code')
          order by 1, 2`,
      );
      expect(privilege.rows).toHaveLength(12);
      for (const r of privilege.rows) {
        expect(r.ok, `${r.fn} for ${r.role}`).toBe(r.role !== 'anon');
      }
    });

    it('service_role and the SQL editor may execute the wrappers but are nobody\'s profile (no auth.uid()), so they get 42501', async () => {
      const sql = `select * from public.admin_list_invite_codes()`;
      await asService(db, async () => {
        expect((await expectError(db.query(sql))).code).toBe('42501');
      });
      expect((await expectError(db.query(sql))).code).toBe('42501');
    });

    it('anon is refused even with a JWT sub that belongs to the super admin, and a signed-in caller without a sub is refused too', async () => {
      await withRole(db, 'anon', USER_A, async () => {
        expect((await expectError(db.query(`select * from public.admin_list_invite_codes()`))).message).toMatch(DENIED);
      });
      await withRole(db, 'authenticated', null, async () => {
        expect((await expectError(db.query(`select * from public.admin_list_invite_codes()`))).code).toBe('42501');
      });
    });

    it('the owner RPCs of migration 100 stay closed to signed-in users (the wrappers are the only way in)', async () => {
      await asUser(db, USER_A, async () => {
        for (const sql of [
          `select public.create_invite_code('x', 1, 1)`,
          `select * from public.list_invite_codes()`,
          `select public.revoke_invite_code('ABCDEFGH2345')`,
        ]) {
          expect((await expectError(db.query(sql))).message, sql).toMatch(DENIED);
        }
      });
    });

    it('are SECURITY DEFINER with a fixed search_path', async () => {
      const r = await db.query<{ proname: string; prosecdef: boolean; fixed: boolean }>(
        `select p.proname, p.prosecdef,
                exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') as fixed
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where p.proname in ('admin_create_invite_code', 'admin_list_invite_codes', 'admin_revoke_invite_code',
                              'is_super_admin')
          order by 1`,
      );
      expect(r.rows).toHaveLength(4);
      for (const f of r.rows) {
        expect(f.fixed, f.proname).toBe(true);
        expect(f.prosecdef, f.proname).toBe(true);
      }
    });

    it('anon is refused', async () => {
      await asAnon(db, async () => {
        for (const sql of [
          `select public.admin_create_invite_code('x', 1, 1)`,
          `select * from public.admin_list_invite_codes()`,
          `select public.admin_revoke_invite_code('ABCDEFGH2345')`,
        ]) {
          expect((await expectError(db.query(sql))).message, sql).toMatch(DENIED);
        }
      });
    });

    it('an ordinary signed-in user gets 42501 from every one of them, and nothing is created or revoked', async () => {
      const code = await db.query<{ c: string }>(`select public.create_invite_code('owner made', 1, 14) as c`);
      await asUser(db, USER_B, async () => {
        for (const sql of [
          `select public.admin_create_invite_code('x', 1, 1)`,
          `select * from public.admin_list_invite_codes()`,
          `select public.admin_revoke_invite_code('${code.rows[0]!.c}')`,
        ]) {
          const err = await expectError(db.query(sql));
          expect(err.code, sql).toBe('42501');
          expect(err.message, sql).toMatch(/only the app owner/);
        }
      });
      const rows = await db.query<{ n: number; revoked: number }>(
        'select count(*)::int as n, count(revoked_at)::int as revoked from private.invite_codes',
      );
      expect(rows.rows).toEqual([{ n: 1, revoked: 0 }]);
    });

    it('a user without a profile row (or with a profile that never was admin) is not an admin', async () => {
      await asUser(db, USER_B, async () => {
        await db.query('delete from public.profiles where user_id = $1', [USER_B]);
        const err = await expectError(db.query(`select * from public.admin_list_invite_codes()`));
        expect(err.code).toBe('42501');
      });
    });

    it('the super admin creates a code: XXXX-XXXX-XXXX, with the note, the uses and the expiry given', async () => {
      const code = await create(USER_A, 'for Anna (anna@example.com)', 3, 7);
      expect(code).toMatch(GROUPED);
      const rows = await list(USER_A);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        code,
        note: 'for Anna (anna@example.com)',
        uses: 0,
        max_uses: 3,
        status: 'active',
      });
      expect(rows[0]!.expires_at).not.toBeNull();
      const never = await create(USER_A, null, 1, null);
      expect((await list(USER_A)).find((r) => r.code === never)!.expires_at).toBeNull();
    });

    it('keeps the argument checks of the owner RPC (max uses 1..1000, valid days 1..3650 or null, note up to 200)', async () => {
      await asUser(db, USER_A, async () => {
        for (const sql of [
          `select public.admin_create_invite_code('x', 0, 14)`,
          `select public.admin_create_invite_code('x', 1001, 14)`,
          `select public.admin_create_invite_code('x', 1, 0)`,
          `select public.admin_create_invite_code('x', 1, 3651)`,
          `select public.admin_create_invite_code('${'n'.repeat(201)}', 1, 14)`,
        ]) {
          expect((await expectError(db.query(sql))).code, sql).toBe('22023');
        }
      });
    });

    it('lists the newest first with every status', async () => {
      const used = await create(USER_A, 'used up', 1, 14);
      const old = await create(USER_A, 'expired', 1, 14);
      const revoked = await create(USER_A, 'revoked', 1, 14);
      const fresh = await create(USER_A, 'fresh', 2, 14);
      await db.query(`select public.consume_invite_code($1)`, [used]);
      await db.query(
        `update private.invite_codes set expires_at = now() - interval '1 day' where code = $1`,
        [old.replaceAll('-', '')],
      );
      await asUser(db, USER_A, async () => {
        expect(
          (await db.query<{ ok: boolean }>('select public.admin_revoke_invite_code($1) as ok', [revoked]))
            .rows[0]!.ok,
        ).toBe(true);
      });
      const rows = await list(USER_A);
      expect(Object.fromEntries(rows.map((r) => [r.note, r.status]))).toEqual({
        'used up': 'used_up',
        expired: 'expired',
        revoked: 'revoked',
        fresh: 'active',
      });
      expect(rows.map((r) => r.code)).toContain(fresh);
    });

    it('revoking returns false for a code that does not exist, and a revoked code cannot be used to sign up', async () => {
      const code = await create(USER_A, 'x');
      await asUser(db, USER_A, async () => {
        expect(
          (await db.query<{ ok: boolean }>(`select public.admin_revoke_invite_code('ZZZZZZZZZZZZ') as ok`))
            .rows[0]!.ok,
        ).toBe(false);
        expect(
          (await db.query<{ ok: boolean }>('select public.admin_revoke_invite_code($1) as ok', [code]))
            .rows[0]!.ok,
        ).toBe(true);
      });
      const consumed = await asService(
        db,
        async () =>
          (await db.query<{ r: string }>('select public.consume_invite_code($1) as r', [code])).rows[0]!.r,
      );
      expect(consumed).toBe('revoked');
    });

    it('a code made in the app is accepted by the sign-up function and then counts as used', async () => {
      const code = await create(USER_A, 'for Ben', 1, 14);
      const first = await asService(
        db,
        async () =>
          (await db.query<{ r: string }>('select public.consume_invite_code($1) as r', [code])).rows[0]!.r,
      );
      expect(first).toBe('ok');
      expect((await list(USER_A)).find((r) => r.code === code)).toMatchObject({ uses: 1, status: 'used_up' });
    });

    it('stops working the moment the flag is taken away', async () => {
      await create(USER_A, 'x');
      await setAdmin(USER_A, false);
      const err = await asUser(db, USER_A, () =>
        expectError(db.query('select * from public.admin_list_invite_codes()')),
      );
      expect(err.code).toBe('42501');
    });
  });
});
