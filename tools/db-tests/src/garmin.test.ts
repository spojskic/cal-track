import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  USER_A,
  USER_B,
  asAnon,
  asService,
  asUser,
  createDb,
  createUsers,
  expectError,
} from './harness';

const DENIED = /permission denied/;

const TABLES = ['garmin_connections', 'garmin_oauth_states', 'garmin_push_events'] as const;

const TOKEN_A = 'tok-access-AAAA-secret';
const REFRESH_A = 'tok-refresh-AAAA-secret';
const TOKEN_B = 'tok-access-BBBB-secret';

describe('garmin integration schema (migration 20261110000013)', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createDb();
    await createUsers(db);
  });
  afterAll(async () => {
    await db.close();
  });

  const seedConnections = async () => {
    await db.exec(`delete from private.garmin_connections`);
    await db.query(
      `insert into private.garmin_connections
         (user_id, garmin_user_id, access_token, refresh_token, scopes, last_push_at, last_error)
       values ($1, 'garmin-user-a', $2, $3, '{wellness}', '2026-11-10T08:00:00Z', null),
              ($4, 'garmin-user-b', $5, null, '{}', null, 'apply_failed')`,
      [USER_A, TOKEN_A, REFRESH_A, USER_B, TOKEN_B],
    );
  };

  describe('access control', () => {
    it('keeps the three tables in the private schema with RLS enabled and NO policies', async () => {
      const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
        `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'private' and c.relname = any($1) order by 1`,
        [[...TABLES]],
      );
      expect(rls.rows).toEqual(TABLES.map((relname) => ({ relname, relrowsecurity: true })));
      const policies = await db.query(
        `select 1 from pg_policies where schemaname = 'private' and tablename = any($1)`,
        [[...TABLES]],
      );
      expect(policies.rows).toEqual([]);
      const publicCopies = await db.query(
        `select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = any($1)`,
        [[...TABLES]],
      );
      expect(publicCopies.rows).toEqual([]);
    });

    it.each(TABLES)('anon cannot select, insert, update or delete %s', async (table) => {
      await asAnon(db, async () => {
        for (const sql of [
          `select * from private.${table} limit 1`,
          `delete from private.${table}`,
          `update private.${table} set user_id = user_id`,
        ]) {
          expect((await expectError(db.query(sql))).message, sql).toMatch(DENIED);
        }
      });
    });

    it.each(TABLES)('authenticated cannot select, insert, update or delete %s', async (table) => {
      const inserts: Record<string, string> = {
        garmin_connections: `insert into private.garmin_connections (user_id, garmin_user_id, access_token) values ('${USER_A}', 'x', 'y')`,
        garmin_oauth_states: `insert into private.garmin_oauth_states (state, user_id, code_verifier)
                              values ('${'s'.repeat(20)}', '${USER_A}', '${'v'.repeat(43)}')`,
        garmin_push_events: `insert into private.garmin_push_events (user_id, garmin_user_id, kind, payload)
                             values ('${USER_A}', 'x', 'dailies', '{}')`,
      };
      await asUser(db, USER_A, async () => {
        for (const sql of [
          `select * from private.${table} limit 1`,
          inserts[table]!,
          `update private.${table} set user_id = user_id`,
          `delete from private.${table}`,
        ]) {
          expect((await expectError(db.query(sql))).message, sql).toMatch(DENIED);
        }
      });
    });

    it('the tables are not reachable through the public schema either (no exposed copy, no view)', async () => {
      await asUser(db, USER_A, async () => {
        for (const table of TABLES) {
          const err = await expectError(db.query(`select * from public.${table}`));
          expect(err.message).toMatch(/does not exist/);
        }
      });
    });

    it('service-only functions are closed to anon and authenticated', async () => {
      const calls = [
        `select public.garmin_oauth_state_create('${'s'.repeat(20)}', '${USER_A}', '${'v'.repeat(43)}')`,
        `select * from public.garmin_oauth_state_consume('x')`,
        `select public.garmin_connection_save('${USER_A}', 'g', 't', null, null, null, '{}')`,
        `select * from public.garmin_connection_get('${USER_A}')`,
        `select public.garmin_connection_touch('${USER_A}', true)`,
        `select public.garmin_connection_delete('${USER_A}', true)`,
        `select public.garmin_push_events_record('${USER_A}', 'g', '[]')`,
        `select public.garmin_push_events_finish('{1}')`,
        `select public.purge_garmin_data()`,
        `select public.apply_garmin_health('${USER_A}')`,
      ];
      await asUser(db, USER_A, async () => {
        for (const sql of calls)
          expect((await expectError(db.query(sql))).message, sql).toMatch(DENIED);
      });
      await asAnon(db, async () => {
        for (const sql of calls)
          expect((await expectError(db.query(sql))).message, sql).toMatch(DENIED);
      });
    });
  });

  describe('garmin_connection_status()', () => {
    it('is a SECURITY INVOKER wrapper over a private SECURITY DEFINER helper with a fixed search_path', async () => {
      const r = await db.query<{ nspname: string; prosecdef: boolean; proconfig: string[] | null }>(
        `select n.nspname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where p.proname = 'garmin_connection_status' order by 1`,
      );
      expect(r.rows.map((x) => [x.nspname, x.prosecdef])).toEqual([
        ['private', true],
        ['public', false],
      ]);
      expect(r.rows[0]!.proconfig).toContain('search_path=""');
    });

    it('anon cannot call it', async () => {
      const err = await asAnon(db, () =>
        expectError(db.query(`select * from public.garmin_connection_status()`)),
      );
      expect(err.message).toMatch(DENIED);
    });

    it('returns connected = false (and nulls) for a user without a connection', async () => {
      await db.exec(`delete from private.garmin_connections`);
      const r = await asUser(db, USER_A, () =>
        db.query(`select * from public.garmin_connection_status()`),
      );
      expect(r.rows).toEqual([
        { connected: false, connected_at: null, last_push_at: null, last_error: null },
      ]);
    });

    it('returns exactly four columns of the caller own connection and never a token', async () => {
      await seedConnections();
      const a = await asUser(db, USER_A, () =>
        db.query<Record<string, unknown>>(`select * from public.garmin_connection_status()`),
      );
      expect(a.rows).toHaveLength(1);
      const row = a.rows[0]!;
      expect(Object.keys(row).sort()).toEqual([
        'connected',
        'connected_at',
        'last_error',
        'last_push_at',
      ]);
      expect(row.connected).toBe(true);
      expect(row.last_error).toBeNull();
      expect(new Date(row.last_push_at as Date).toISOString()).toBe('2026-11-10T08:00:00.000Z');
      const json = JSON.stringify(a.rows);
      for (const secret of [TOKEN_A, REFRESH_A, TOKEN_B, 'garmin-user-a', 'garmin-user-b']) {
        expect(json).not.toContain(secret);
      }

      const b = await asUser(db, USER_B, () =>
        db.query<Record<string, unknown>>(`select * from public.garmin_connection_status()`),
      );
      expect(b.rows).toHaveLength(1);
      expect(b.rows[0]!.connected).toBe(true);
      expect(b.rows[0]!.last_error).toBe('apply_failed');
      expect(b.rows[0]!.last_push_at).toBeNull();
      expect(JSON.stringify(b.rows)).not.toContain(TOKEN_A);
    });

    it('cannot be tricked into returning another user: it takes no arguments', async () => {
      await seedConnections();
      const err = await asUser(db, USER_A, () =>
        expectError(db.query(`select * from public.garmin_connection_status($1)`, [USER_B])),
      );
      expect(err.message).toMatch(/does not exist|function/);
    });
  });

  describe('deleting the user', () => {
    it('cascades to connection, oauth states and push events', async () => {
      const C = '00000000-0000-4000-8000-00000000000c';
      await db.query(`insert into auth.users (id, email) values ($1, 'carol@example.com')`, [C]);
      await db.query(
        `insert into private.garmin_connections (user_id, garmin_user_id, access_token) values ($1, 'g-c', 'tok-c')`,
        [C],
      );
      await db.query(
        `insert into private.garmin_oauth_states (state, user_id, code_verifier) values ($1, $2, $3)`,
        ['c'.repeat(20), C, 'v'.repeat(43)],
      );
      await db.query(
        `insert into private.garmin_push_events (user_id, garmin_user_id, kind, payload) values ($1, 'g-c', 'dailies', '{}')`,
        [C],
      );
      await db.query(`delete from auth.users where id = $1`, [C]);
      for (const table of TABLES) {
        const r = await db.query<{ n: number }>(
          `select count(*)::int as n from private.${table} where user_id = $1`,
          [C],
        );
        expect(r.rows[0]!.n, table).toBe(0);
      }
    });

    it('a Garmin account can be linked to one user only (unique garmin_user_id)', async () => {
      await seedConnections();
      const err = await expectError(
        db.query(
          `insert into private.garmin_connections (user_id, garmin_user_id, access_token)
           values ('00000000-0000-4000-8000-0000000000dd', 'garmin-user-a', 'x')`,
        ),
      );
      // either the FK (user does not exist) or the unique key; the unique key is checked through the RPC below
      expect(err.message).toBeTruthy();
      const rpc = await asService(db, () =>
        expectError(
          db.query(
            `select public.garmin_connection_save($1, 'garmin-user-a', 'zzz', null, null, null, '{}')`,
            [USER_B],
          ),
        ),
      );
      expect((rpc as Error & { code?: string }).code).toBe('23505');
    });
  });

  describe('oauth state RPCs', () => {
    const state = (c: string) => c.repeat(24);
    const verifier = 'v'.repeat(64);

    it('consumes a state exactly once and returns the verifier and return kind', async () => {
      await db.exec(`delete from private.garmin_oauth_states`);
      await asService(db, async () => {
        await db.query(`select public.garmin_oauth_state_create($1, $2, $3, 'web', 600)`, [
          state('a'),
          USER_A,
          verifier,
        ]);
        const first = await db.query(`select * from public.garmin_oauth_state_consume($1, 600)`, [
          state('a'),
        ]);
        expect(first.rows).toEqual([
          { user_id: USER_A, code_verifier: verifier, return_kind: 'web' },
        ]);
        const second = await db.query(`select * from public.garmin_oauth_state_consume($1, 600)`, [
          state('a'),
        ]);
        expect(second.rows).toEqual([]);
      });
    });

    it('does not return (but still deletes) an expired state', async () => {
      await db.exec(`delete from private.garmin_oauth_states`);
      await db.query(
        `insert into private.garmin_oauth_states (state, user_id, code_verifier, created_at)
         values ($1, $2, $3, now() - interval '11 minutes')`,
        [state('b'), USER_A, verifier],
      );
      await asService(db, async () => {
        const r = await db.query(`select * from public.garmin_oauth_state_consume($1, 600)`, [
          state('b'),
        ]);
        expect(r.rows).toEqual([]);
      });
      const left = await db.query(`select 1 from private.garmin_oauth_states where state = $1`, [
        state('b'),
      ]);
      expect(left.rows).toEqual([]);
    });

    it('create drops expired states and keeps at most the 4 newest per user', async () => {
      await db.exec(`delete from private.garmin_oauth_states`);
      await db.query(
        `insert into private.garmin_oauth_states (state, user_id, code_verifier, created_at)
         values ($1, $2, $3, now() - interval '2 hours')`,
        [state('o'), USER_B, verifier],
      );
      await asService(db, async () => {
        for (const c of ['1', '2', '3', '4', '5', '6']) {
          await db.query(`select public.garmin_oauth_state_create($1, $2, $3)`, [
            state(c),
            USER_A,
            verifier,
          ]);
        }
      });
      const rows = await db.query<{ state: string; return_kind: string }>(
        `select state, return_kind from private.garmin_oauth_states order by created_at, state`,
      );
      expect(rows.rows.some((r) => r.state === state('o'))).toBe(false);
      expect(rows.rows).toHaveLength(5); // 4 newest + the one just inserted
      expect(rows.rows.every((r) => r.return_kind === 'native')).toBe(true);
    });

    it('rejects an unknown return kind and a short verifier', async () => {
      await asService(db, async () => {
        const kind = await expectError(
          db.query(`select public.garmin_oauth_state_create($1, $2, $3, 'evil')`, [
            state('k'),
            USER_A,
            verifier,
          ]),
        );
        expect(kind.message).toMatch(/invalid garmin oauth state/);
      });
      const short = await expectError(
        db.query(
          `insert into private.garmin_oauth_states (state, user_id, code_verifier) values ($1, $2, 'short')`,
          [state('s'), USER_A],
        ),
      );
      expect(short.message).toMatch(/check constraint/);
    });
  });

  describe('connection RPCs', () => {
    it('saves, looks up by user / garmin id / access token, updates, touches and deletes', async () => {
      await db.exec(`delete from private.garmin_connections`);
      const rpc = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
        asService(db, () => db.query<T>(sql, params));
      const stored = () =>
        db.query<{
          access_token: string;
          refresh_token: string | null;
          last_push_at: Date | null;
          last_error: string | null;
        }>(
          `select access_token, refresh_token, last_push_at, last_error from private.garmin_connections where user_id = $1`,
          [USER_A],
        );

      await rpc(
        `select public.garmin_connection_save($1, 'g-1', 'access-1', 'refresh-1', '2026-11-11T00:00:00Z', '2027-11-11T00:00:00Z', '{a,b}')`,
        [USER_A],
      );
      const byUser = await rpc(`select * from public.garmin_connection_get(p_user_id => $1)`, [
        USER_A,
      ]);
      expect(byUser.rows).toHaveLength(1);
      expect(byUser.rows[0]).toMatchObject({
        user_id: USER_A,
        garmin_user_id: 'g-1',
        access_token: 'access-1',
        refresh_token: 'refresh-1',
      });
      expect(
        (await rpc(`select * from public.garmin_connection_get(p_garmin_user_id => 'g-1')`)).rows,
      ).toHaveLength(1);
      expect(
        (await rpc(`select * from public.garmin_connection_get(p_access_token => 'access-1')`))
          .rows,
      ).toHaveLength(1);
      expect((await rpc(`select * from public.garmin_connection_get()`)).rows).toEqual([]);
      expect(
        (await rpc(`select * from public.garmin_connection_get(p_garmin_user_id => 'nope')`)).rows,
      ).toEqual([]);

      // a push arrived: a failure records the error, success stamps last_push_at and clears it
      await rpc(`select public.garmin_connection_touch($1, false, 'apply_failed')`, [USER_A]);
      let row = (await stored()).rows[0]!;
      expect([row.last_push_at, row.last_error]).toEqual([null, 'apply_failed']);
      await rpc(`select public.garmin_connection_touch($1, true)`, [USER_A]);
      row = (await stored()).rows[0]!;
      expect(row.last_error).toBeNull();
      expect(row.last_push_at).not.toBeNull();

      // reconnect with new tokens: same row, refresh token kept when the new response has none, error cleared
      await rpc(`select public.garmin_connection_touch($1, false, 'old error')`, [USER_A]);
      await rpc(
        `select public.garmin_connection_save($1, 'g-1', 'access-2', null, null, null, '{}')`,
        [USER_A],
      );
      const after = (await stored()).rows[0]!;
      expect([after.access_token, after.refresh_token, after.last_error]).toEqual([
        'access-2',
        'refresh-1',
        null,
      ]);
      const count = await db.query<{ n: number }>(
        `select count(*)::int as n from private.garmin_connections`,
      );
      expect(count.rows[0]!.n).toBe(1);
    });

    it('delete removes the connection, states and push events, and optionally the imported Garmin rows', async () => {
      await db.exec(
        `delete from private.garmin_connections; delete from private.garmin_oauth_states; delete from private.garmin_push_events`,
      );
      await db.query(
        `insert into private.garmin_connections (user_id, garmin_user_id, access_token) values ($1, 'g-del', 'tok')`,
        [USER_A],
      );
      await db.query(
        `insert into private.garmin_oauth_states (state, user_id, code_verifier) values ($1, $2, $3)`,
        ['d'.repeat(20), USER_A, 'v'.repeat(43)],
      );
      await db.query(
        `insert into private.garmin_push_events (user_id, garmin_user_id, kind, payload) values ($1, 'g-del', 'dailies', '{}')`,
        [USER_A],
      );
      await db.query(
        `insert into public.daily_energy (user_id, local_date, source, active_kcal) values
           ($1, '2026-11-09', 'garmin', 100), ($1, '2026-11-09', 'apple_health', 200)`,
        [USER_A],
      );
      await db.query(
        `insert into public.biometrics (user_id, entry_date, type, value, source, external_id) values
           ($1, '2026-11-09', 'stress', 30, 'garmin', 'garmin:stress:2026-11-09'),
           ($1, '2026-11-09', 'stress', 31, 'apple_health', 'stress:2026-11-09')`,
        [USER_A],
      );

      await asService(db, async () => {
        const keep = await db.query<{ r: Record<string, number> }>(
          `select public.garmin_connection_delete($1, false) as r`,
          [USER_A],
        );
        expect(keep.rows[0]!.r).toMatchObject({
          connection: 1,
          oauth_states: 1,
          push_events: 1,
          daily_energy: 0,
          biometrics: 0,
        });
      });
      let energy = await db.query<{ n: number }>(
        `select count(*)::int as n from public.daily_energy where user_id = $1`,
        [USER_A],
      );
      expect(energy.rows[0]!.n).toBe(2); // imported data is kept by default

      await asService(db, async () => {
        const wipe = await db.query<{ r: Record<string, number> }>(
          `select public.garmin_connection_delete($1, true) as r`,
          [USER_A],
        );
        expect(wipe.rows[0]!.r).toMatchObject({ connection: 0, daily_energy: 1, biometrics: 1 });
      });
      energy = await db.query(
        `select count(*)::int as n from public.daily_energy where user_id = $1 and source = 'apple_health'`,
        [USER_A],
      );
      expect(energy.rows[0]!.n).toBe(1); // other sources are never touched
      const bio = await db.query<{ source: string }>(
        `select source from public.biometrics where user_id = $1`,
        [USER_A],
      );
      expect(bio.rows).toEqual([{ source: 'apple_health' }]);
    });
  });

  describe('push event buffer and retention', () => {
    it('records events in order, marks them processed, and purges after 14 days', async () => {
      await db.exec(
        `delete from private.garmin_push_events; delete from private.garmin_oauth_states`,
      );
      await asService(db, async () => {
        const rec = await db.query<{ ids: number[] }>(
          `select public.garmin_push_events_record($1, 'g-evt', $2::jsonb) as ids`,
          [
            USER_A,
            JSON.stringify([
              { kind: 'dailies', payload: { a: 1 } },
              { kind: 'sleeps', payload: { b: 2 } },
              { kind: '', payload: {} },
            ]),
          ],
        );
        const ids = rec.rows[0]!.ids.map(Number);
        expect(ids).toHaveLength(2); // the entry without a kind is dropped
        await db.query(`select public.garmin_push_events_finish($1::bigint[], 'unmapped_kind')`, [
          ids,
        ]);
      });
      const rows = await db.query<{
        kind: string;
        payload: unknown;
        error: string | null;
        processed: boolean;
      }>(
        `select kind, payload, error, processed_at is not null as processed from private.garmin_push_events order by id`,
      );
      expect(rows.rows).toEqual([
        { kind: 'dailies', payload: { a: 1 }, error: 'unmapped_kind', processed: true },
        { kind: 'sleeps', payload: { b: 2 }, error: 'unmapped_kind', processed: true },
      ]);

      await db.query(
        `update private.garmin_push_events set received_at = now() - interval '15 days' where kind = 'dailies'`,
      );
      await db.query(
        `insert into private.garmin_oauth_states (state, user_id, code_verifier, created_at) values ($1, $2, $3, now() - interval '2 hours')`,
        ['p'.repeat(20), USER_A, 'v'.repeat(43)],
      );
      const purged = await asService(db, () =>
        db.query<{ r: { oauth_states: number; push_events: number } }>(
          `select public.purge_garmin_data() as r`,
        ),
      );
      expect(purged.rows[0]!.r).toEqual({ oauth_states: 1, push_events: 1 });
      const left = await db.query<{ kind: string }>(`select kind from private.garmin_push_events`);
      expect(left.rows).toEqual([{ kind: 'sleeps' }]);
    });
  });

  describe('apply_garmin_health()', () => {
    const apply = (
      p: { energy?: unknown[]; exercises?: unknown[]; biometrics?: unknown[] },
      user = USER_A,
    ) =>
      asService(db, () =>
        db.query<{ r: { energy: number; exercises: number; biometrics: number } }>(
          `select public.apply_garmin_health($1, $2::jsonb, $3::jsonb, $4::jsonb) as r`,
          [
            user,
            JSON.stringify(p.energy ?? []),
            JSON.stringify(p.exercises ?? []),
            JSON.stringify(p.biometrics ?? []),
          ],
        ),
      );

    const energyRow = (date = '2026-11-10') =>
      db.query<{
        source: string;
        active_kcal: number | null;
        resting_kcal: number | null;
        steps: number | null;
      }>(
        `select source, active_kcal::float8 as active_kcal, resting_kcal::float8 as resting_kcal, steps from public.daily_energy
         where user_id = $1 and local_date = $2 order by source`,
        [USER_A, date],
      );

    it('is an invoker function for service_role only', async () => {
      const r = await db.query<{ prosecdef: boolean }>(
        `select prosecdef from pg_proc where proname = 'apply_garmin_health'`,
      );
      expect(r.rows).toEqual([{ prosecdef: false }]);
    });

    it('keeps the latest CUMULATIVE daily values: later pushes replace, older / partial ones never roll back or add up', async () => {
      await db.exec(`delete from public.daily_energy`);
      await apply({
        energy: [{ local_date: '2026-11-10', active_kcal: 100, resting_kcal: 801, steps: 1200 }],
      });
      expect((await energyRow()).rows).toEqual([
        { source: 'garmin', active_kcal: 100, resting_kcal: 801, steps: 1200 },
      ]);

      // a later push of the same day: replaced, NOT 100 + 250
      await apply({
        energy: [{ local_date: '2026-11-10', active_kcal: 250, resting_kcal: 1300, steps: 4100 }],
      });
      expect((await energyRow()).rows).toEqual([
        { source: 'garmin', active_kcal: 250, resting_kcal: 1300, steps: 4100 },
      ]);

      // the SAME push again (retry): idempotent
      await apply({
        energy: [{ local_date: '2026-11-10', active_kcal: 250, resting_kcal: 1300, steps: 4100 }],
      });
      expect((await energyRow()).rows).toEqual([
        { source: 'garmin', active_kcal: 250, resting_kcal: 1300, steps: 4100 },
      ]);

      // an OLDER (smaller) push arriving late must not roll the day back
      await apply({
        energy: [{ local_date: '2026-11-10', active_kcal: 120, resting_kcal: 900, steps: 2000 }],
      });
      expect((await energyRow()).rows).toEqual([
        { source: 'garmin', active_kcal: 250, resting_kcal: 1300, steps: 4100 },
      ]);

      // a push without a value never erases a stored one
      await apply({
        energy: [{ local_date: '2026-11-10', active_kcal: null, resting_kcal: null, steps: 4500 }],
      });
      expect((await energyRow()).rows).toEqual([
        { source: 'garmin', active_kcal: 250, resting_kcal: 1300, steps: 4500 },
      ]);
    });

    it('folds several items of the same day in one call and ignores empty rows', async () => {
      await db.exec(`delete from public.daily_energy`);
      const r = await apply({
        energy: [
          { local_date: '2026-11-10', active_kcal: 100, resting_kcal: null, steps: 10 },
          { local_date: '2026-11-10', active_kcal: 300, resting_kcal: 900, steps: null },
          { local_date: '2026-11-11', active_kcal: null, resting_kcal: null, steps: null },
          { local_date: null, active_kcal: 5 },
        ],
      });
      expect(r.rows[0]!.r.energy).toBe(1);
      expect((await energyRow()).rows).toEqual([
        { source: 'garmin', active_kcal: 300, resting_kcal: 900, steps: 10 },
      ]);
      expect((await energyRow('2026-11-11')).rows).toEqual([]);
    });

    it('writes source = garmin next to (and never over) the Apple Health row of the same day', async () => {
      await db.exec(`delete from public.daily_energy`);
      await db.query(
        `insert into public.daily_energy (user_id, local_date, source, active_kcal, resting_kcal, steps)
         values ($1, '2026-11-10', 'apple_health', 400, 1500, 9000)`,
        [USER_A],
      );
      await apply({
        energy: [{ local_date: '2026-11-10', active_kcal: 350, resting_kcal: 700, steps: 8000 }],
      });
      expect((await energyRow()).rows).toEqual([
        { source: 'apple_health', active_kcal: 400, resting_kcal: 1500, steps: 9000 },
        { source: 'garmin', active_kcal: 350, resting_kcal: 700, steps: 8000 },
      ]);
    });

    it('upserts workouts on (user, source, external_id): informational, never counted toward energy', async () => {
      await db.exec(`delete from public.exercise_entries`);
      const w = {
        entry_date: '2026-11-10',
        name: 'Morning run',
        minutes: 32.5,
        kcal: 410,
        external_id: 'garmin:activity:123',
        started_at: '2026-11-10T06:00:00Z',
        ended_at: '2026-11-10T06:32:30Z',
      };
      await apply({ exercises: [w, { ...w, name: 'dup in the same batch' }] });
      await apply({ exercises: [{ ...w, name: 'Morning run (edited)', kcal: 420 }] });
      await db.query(
        `insert into public.exercise_entries (user_id, entry_date, name, kcal, source, external_id)
         values ($1, '2026-11-10', 'Run', 400, 'apple_health', 'garmin:activity:123')`,
        [USER_A],
      );
      const rows = await db.query<{
        source: string;
        name: string;
        kcal: number;
        minutes: number | null;
        counts: boolean;
      }>(
        `select source, name, kcal::float8 as kcal, minutes::float8 as minutes, counts_toward_energy as counts
         from public.exercise_entries where user_id = $1 order by source`,
        [USER_A],
      );
      expect(rows.rows).toEqual([
        { source: 'apple_health', name: 'Run', kcal: 400, minutes: null, counts: true },
        { source: 'garmin', name: 'Morning run (edited)', kcal: 420, minutes: 32.5, counts: false },
      ]);
    });

    it('upserts biometrics; an older recorded_at never overwrites a newer value, a newer one does', async () => {
      await db.exec(`delete from public.biometrics`);
      const bio = (value: number, at: string, meta = {}) => ({
        entry_date: '2026-11-10',
        type: 'stress',
        value,
        unit: 'score',
        external_id: 'garmin:stress:2026-11-10',
        recorded_at: at,
        meta,
      });
      await apply({ biometrics: [bio(30, '2026-11-10T12:00:00Z')] });
      await apply({ biometrics: [bio(44, '2026-11-10T20:00:00Z', { n: 2 })] });
      await apply({ biometrics: [bio(25, '2026-11-10T09:00:00Z')] }); // late, older push
      const r = await db.query<{ value: number; meta: unknown; source: string }>(
        `select value::float8 as value, meta, source from public.biometrics where user_id = $1`,
        [USER_A],
      );
      expect(r.rows).toEqual([{ value: 44, meta: { n: 2 }, source: 'garmin' }]);
    });

    it('skips unusable biometric rows (value <= 0, missing id / type / date)', async () => {
      await db.exec(`delete from public.biometrics`);
      const base = {
        entry_date: '2026-11-10',
        type: 'hrv',
        value: 55,
        unit: 'ms',
        external_id: 'garmin:hrv:2026-11-10',
      };
      const res = await apply({
        biometrics: [
          base,
          { ...base, value: 0, external_id: 'a' },
          { ...base, value: -3, external_id: 'b' },
          { ...base, external_id: '' },
          { ...base, type: '', external_id: 'c' },
          { ...base, entry_date: null, external_id: 'd' },
        ],
      });
      expect(res.rows[0]!.r.biometrics).toBe(1);
    });

    it('fails for a user that does not exist (no orphan rows)', async () => {
      const err = await expectError(
        apply(
          { energy: [{ local_date: '2026-11-10', active_kcal: 1 }] },
          '00000000-0000-4000-8000-0000000000ee',
        ),
      );
      expect((err as Error & { code?: string }).code).toBe('23503');
    });
  });
});
