import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  USER_A,
  USER_B,
  USER_C,
  asService,
  asUser,
  createDb,
  createUsers,
  expectError,
  withRole,
} from './harness';

const DENIED = /permission denied/;

// The service-role variant the `friend-request` Edge Function calls: the same rules as
// public.send_friend_request (see tools/db-tests/src/friends.test.ts), but the requester comes
// as an ARGUMENT (the function runs with the service key, where auth.uid() is null) and the
// answer says whether a request was actually created (only then is an e-mail sent).
describe('send_friend_request_internal', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createDb();
    await createUsers(db);
    await db.query('insert into auth.users (id, email) values ($1, $2)', [USER_C, 'carol@example.com']);
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec('delete from public.friendships');
  });

  const send = (
    requester: string | null,
    email: string,
  ): Promise<{ status: string; created: boolean }> =>
    db
      .query<{ status: string; created: boolean }>(
        'select status, created from public.send_friend_request_internal($1, $2)',
        [requester, email],
      )
      .then((r) => r.rows[0]!);

  const sendAsService = (requester: string, email: string) =>
    asService(db, () => send(requester, email));

  it('creates a pending request from the requester given as an argument (service role, no JWT) and answers sent / created', async () => {
    expect(await sendAsService(USER_A, '  BOB@example.com ')).toEqual({ status: 'sent', created: true });
    const r = await db.query<{ requester_id: string; addressee_id: string; status: string }>(
      'select requester_id, addressee_id, status from public.friendships',
    );
    expect(r.rows).toEqual([{ requester_id: USER_A, addressee_id: USER_B, status: 'pending' }]);
  });

  it('answers sent / not created for an e-mail without an account, and creates nothing', async () => {
    expect(await sendAsService(USER_A, 'nobody@example.com')).toEqual({ status: 'sent', created: false });
    expect((await db.query('select 1 from public.friendships')).rows).toEqual([]);
  });

  it('accepting a mutual request, asking twice and asking a friend all answer created = false', async () => {
    expect(await sendAsService(USER_B, 'alice@example.com')).toEqual({ status: 'sent', created: true });
    expect(await sendAsService(USER_A, 'bob@example.com')).toEqual({ status: 'accepted', created: false });
    const r = await db.query<{ status: string }>('select status from public.friendships');
    expect(r.rows).toEqual([{ status: 'accepted' }]);
    expect(await sendAsService(USER_A, 'bob@example.com')).toEqual({ status: 'already_friends', created: false });
    // a repeat request from the same requester: already_requested, and nothing new is written
    expect(await sendAsService(USER_C, 'alice@example.com')).toEqual({ status: 'sent', created: true });
    expect(await sendAsService(USER_C, 'alice@example.com')).toEqual({ status: 'already_requested', created: false });
    expect(
      (await db.query<{ requester_id: string; addressee_id: string; status: string }>(
        'select requester_id, addressee_id, status from public.friendships order by requester_id',
      )).rows,
    ).toEqual([
      { requester_id: USER_B, addressee_id: USER_A, status: 'accepted' },
      { requester_id: USER_C, addressee_id: USER_A, status: 'pending' },
    ]);
  });

  it("refuses the requester's own address and a malformed one (22023), and a missing requester (42501)", async () => {
    for (const email of ['alice@example.com', 'ALICE@example.com', '', 'alice', 'a@b', 'a b@example.com']) {
      const err = await expectError(sendAsService(USER_A, email));
      expect(err.code, email).toBe('22023');
    }
    const noRequester = await expectError(send(null, 'bob@example.com'));
    expect(noRequester.code).toBe('42501');
    expect((await db.query('select 1 from public.friendships')).rows).toEqual([]);
  });

  it('still allows 20 requests a day and refuses the 21st with 54000', async () => {
    const others: string[] = [];
    for (let i = 0; i < 21; i++) {
      const id = `00000000-0000-4000-8000-0000000002${String(i).padStart(2, '0')}`;
      await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `bulk${i}@example.com`]);
      others.push(`bulk${i}@example.com`);
    }
    for (let i = 0; i < 20; i++) expect((await sendAsService(USER_A, others[i]!)).created).toBe(true);
    const err = await expectError(sendAsService(USER_A, others[20]!));
    expect(err.code).toBe('54000');
    await db.query(`delete from auth.users where email like 'bulk%@example.com'`);
  });

  it('is executable by service_role and postgres only; the client-facing function keeps its grants and answers the bare status', async () => {
    const privilege = await db.query<{ role: string; ok: boolean }>(
      `select r.rolname as role, has_function_privilege(r.rolname, p.oid, 'execute') as ok
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
         cross join (values ('service_role'), ('postgres'), ('anon'), ('authenticated')) as r(rolname)
        where p.proname = 'send_friend_request_internal'
        order by 1`,
    );
    expect(privilege.rows).toEqual([
      { role: 'anon', ok: false },
      { role: 'authenticated', ok: false },
      { role: 'postgres', ok: true },
      { role: 'service_role', ok: true },
    ]);
    await asUser(db, USER_A, async () => {
      expect(
        (await expectError(db.query(`select public.send_friend_request_internal($1, 'bob@example.com')`, [USER_A]))).message,
      ).toMatch(DENIED);
      // the client-facing wrapper still answers for a signed-in user
      expect((await db.query<{ r: string }>('select public.send_friend_request($1) as r', ['bob@example.com'])).rows[0]!.r).toBe('sent');
    });
    await withRole(db, 'authenticated', null, async () => {
      expect((await expectError(db.query(`select public.send_friend_request('bob@example.com')`))).code).toBe('42501');
    });
  });
});
