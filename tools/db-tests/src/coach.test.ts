import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  USER_A,
  USER_B,
  USER_C,
  asAnon,
  asService,
  asUser,
  createDb,
  createUsers,
  expectError,
} from './harness';

interface Counts {
  threads: number;
  messages: number;
}

describe('coach data retention', () => {
  let db: PGlite;

  const counts = async (uid: string): Promise<Counts> => {
    const r = await db.query<Counts>(
      `select (select count(*)::int from public.coach_threads where user_id = $1) as threads,
              (select count(*)::int from public.coach_messages where user_id = $1) as messages`,
      [uid],
    );
    return r.rows[0]!;
  };

  /** Insert a thread with messages at the given ages (days). Returns the thread id. */
  async function thread(
    uid: string,
    title: string,
    ageDays: number[],
    threadAgeDays?: number,
  ): Promise<string> {
    const newest = Math.min(...ageDays, threadAgeDays ?? Infinity);
    const t = await db.query<{ id: string }>(
      `insert into public.coach_threads (user_id, title, created_at, updated_at)
       values ($1, $2, now() - make_interval(days => $3), now() - make_interval(days => $4)) returning id`,
      [uid, title, threadAgeDays ?? Math.max(...ageDays, 0), newest],
    );
    for (const age of ageDays) {
      await db.query(
        `insert into public.coach_messages (thread_id, user_id, role, content, created_at)
         values ($1, $2, 'user', $3, now() - make_interval(days => $4))`,
        [t.rows[0]!.id, uid, `msg ${title} ${age}d`, age],
      );
    }
    return t.rows[0]!.id;
  }

  async function reset() {
    await db.exec(`delete from public.coach_messages; delete from public.coach_threads;`);
    await db.query(
      `update public.app_settings set value = '90'::jsonb where key = 'coach_retention_days'`,
    );
    await db.query(`update public.profiles set coach_auto_delete = (user_id <> $1)`, [USER_B]);
  }

  beforeAll(async () => {
    db = await createDb();
    await createUsers(db, [
      { id: USER_A, email: 'a@example.com' },
      { id: USER_B, email: 'b@example.com' }, // coach_auto_delete = false (set in reset())
      { id: USER_C, email: 'c@example.com' },
    ]);
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(reset);

  it('defaults: coach_auto_delete is on for new users and retention is 90 days', async () => {
    const p = await db.query<{ coach_auto_delete: boolean }>(
      `select coach_auto_delete from public.profiles where user_id = $1`,
      [USER_A],
    );
    expect(p.rows[0]!.coach_auto_delete).toBe(true);
    await db.query(`update public.profiles set coach_auto_delete = true`);
    const s = await db.query<{ value: number }>(
      `select value::int as value from public.app_settings where key = 'coach_retention_days'`,
    );
    expect(s.rows[0]!.value).toBe(90);
  });

  describe('purge_old_coach_messages', () => {
    it('deletes only messages older than the retention window', async () => {
      await thread(USER_A, 'mixed', [200, 91, 89, 30, 1]);
      const res = await db.query<{ r: { messages: number; threads: number } }>(
        `select public.purge_old_coach_messages() as r`,
      );
      expect(res.rows[0]!.r).toEqual({ messages: 2, threads: 0 });

      const left = await db.query<{ content: string }>(
        `select content from public.coach_messages where user_id = $1 order by created_at`,
        [USER_A],
      );
      expect(left.rows.map((r) => r.content)).toEqual([
        'msg mixed 89d',
        'msg mixed 30d',
        'msg mixed 1d',
      ]);
      expect((await counts(USER_A)).threads).toBe(1); // still has messages
    });

    it('respects the per-user switch: coach_auto_delete = false keeps everything', async () => {
      await thread(USER_A, 'a-old', [300, 120]);
      await thread(USER_B, 'b-old', [300, 120]);
      await thread(USER_C, 'c-old', [300, 120]);

      const res = await db.query<{ r: { messages: number; threads: number } }>(
        `select public.purge_old_coach_messages() as r`,
      );
      expect(res.rows[0]!.r).toEqual({ messages: 4, threads: 2 });

      expect(await counts(USER_A)).toEqual({ threads: 0, messages: 0 });
      expect(await counts(USER_C)).toEqual({ threads: 0, messages: 0 });
      expect(await counts(USER_B)).toEqual({ threads: 1, messages: 2 }); // untouched
    });

    it('picks up a user turning the switch on or off', async () => {
      await thread(USER_B, 'b-old', [200]);
      await db.query(`select public.purge_old_coach_messages()`);
      expect((await counts(USER_B)).messages).toBe(1);

      // the user enables auto-delete through the API (profiles RLS)
      await asUser(db, USER_B, () =>
        db.query(`update public.profiles set coach_auto_delete = true where user_id = $1`, [
          USER_B,
        ]),
      );
      await db.query(`select public.purge_old_coach_messages()`);
      expect(await counts(USER_B)).toEqual({ threads: 0, messages: 0 });

      await thread(USER_A, 'a-old', [200]);
      await asUser(db, USER_A, () =>
        db.query(`update public.profiles set coach_auto_delete = false where user_id = $1`, [
          USER_A,
        ]),
      );
      await db.query(`select public.purge_old_coach_messages()`);
      expect((await counts(USER_A)).messages).toBe(1);
    });

    it('deletes threads that became empty and are older than the cutoff, but keeps live ones', async () => {
      const emptied = await thread(USER_A, 'emptied', [150, 100]);
      const partly = await thread(USER_A, 'partly', [150, 5]);
      const freshEmpty = await thread(USER_A, 'fresh-empty', [], 0);
      const oldEmptyOptOut = await thread(USER_B, 'optout-empty', [], 400);
      const oldEmpty = await thread(USER_C, 'old-empty', [], 400);

      await db.query(`select public.purge_old_coach_messages()`);

      const ids = (await db.query<{ id: string }>(`select id from public.coach_threads`)).rows.map(
        (r) => r.id,
      );
      expect(ids).not.toContain(emptied);
      expect(ids).not.toContain(oldEmpty);
      expect(ids).toEqual(expect.arrayContaining([partly, freshEmpty, oldEmptyOptOut]));
      expect(ids).toHaveLength(3);
    });

    it('honours a changed retention setting', async () => {
      await thread(USER_A, 'x', [100, 45, 10]);
      await asService(db, () =>
        db.query(
          `update public.app_settings set value = '30'::jsonb where key = 'coach_retention_days'`,
        ),
      );
      await db.query(`select public.purge_old_coach_messages()`);
      expect((await counts(USER_A)).messages).toBe(1);

      await db.query(
        `update public.app_settings set value = '365'::jsonb where key = 'coach_retention_days'`,
      );
      await thread(USER_C, 'y', [300, 400]);
      await db.query(`select public.purge_old_coach_messages()`);
      expect((await counts(USER_C)).messages).toBe(1);
    });

    it('falls back to 90 days for a missing / invalid setting and never deletes everything for 0', async () => {
      await thread(USER_A, 'z', [100, 50, 0]);
      await db.query(
        `update public.app_settings set value = '"soon"'::jsonb where key = 'coach_retention_days'`,
      );
      await db.query(`select public.purge_old_coach_messages()`);
      expect((await counts(USER_A)).messages).toBe(2);

      await db.query(`delete from public.app_settings where key = 'coach_retention_days'`);
      await thread(USER_A, 'z2', [100]);
      await db.query(`select public.purge_old_coach_messages()`);
      expect((await counts(USER_A)).messages).toBe(2);

      await db.query(
        `insert into public.app_settings (key, value) values ('coach_retention_days', '0'::jsonb)`,
      );
      await db.query(`select public.purge_old_coach_messages()`);
      // 0 days is clamped to 1 day: only the fresh (0d) message survives, nothing is wiped wholesale
      const left = await db.query<{ content: string }>(
        `select content from public.coach_messages where user_id = $1`,
        [USER_A],
      );
      expect(left.rows.map((r) => r.content)).toEqual(['msg z 0d']);
    });

    it('is idempotent', async () => {
      await thread(USER_A, 'once', [200]);
      await db.query(`select public.purge_old_coach_messages()`);
      const again = await db.query<{ r: { messages: number; threads: number } }>(
        `select public.purge_old_coach_messages() as r`,
      );
      expect(again.rows[0]!.r).toEqual({ messages: 0, threads: 0 });
    });

    it('cannot be called by clients, only by service_role', async () => {
      const user = await asUser(db, USER_A, () =>
        expectError(db.query(`select public.purge_old_coach_messages()`)),
      );
      expect(user.message).toMatch(/permission denied/);
      const anon = await asAnon(db, () =>
        expectError(db.query(`select public.purge_old_coach_messages()`)),
      );
      expect(anon.message).toMatch(/permission denied/);
      await asService(db, () => db.query(`select public.purge_old_coach_messages()`));
    });
  });

  describe('delete_all_my_coach_data', () => {
    it('deletes only the caller’s threads and messages', async () => {
      await thread(USER_A, 'a1', [1, 2]);
      await thread(USER_A, 'a2', [3]);
      await thread(USER_B, 'b1', [1]);
      await thread(USER_C, 'c1', [1, 200]);

      const r = await asUser(
        db,
        USER_A,
        async () =>
          (await db.query<{ n: string }>(`select public.delete_all_my_coach_data() as n`)).rows[0]!
            .n,
      );
      expect(Number(r)).toBe(2);

      expect(await counts(USER_A)).toEqual({ threads: 0, messages: 0 });
      expect(await counts(USER_B)).toEqual({ threads: 1, messages: 1 });
      expect(await counts(USER_C)).toEqual({ threads: 1, messages: 2 });
    });

    it('is a no-op for a user without data', async () => {
      const r = await asUser(
        db,
        USER_A,
        async () =>
          (await db.query<{ n: string }>(`select public.delete_all_my_coach_data() as n`)).rows[0]!
            .n,
      );
      expect(Number(r)).toBe(0);
    });

    it('requires a signed-in user', async () => {
      const anon = await asAnon(db, () =>
        expectError(db.query(`select public.delete_all_my_coach_data()`)),
      );
      expect(anon.message).toMatch(/permission denied/);
      // authenticated role but no `sub` claim
      const noSub = await asUser(db, '', () =>
        expectError(db.query(`select public.delete_all_my_coach_data()`)),
      );
      expect(noSub.message).toMatch(/not authenticated/);
    });
  });

  describe('coach tables', () => {
    it('messages cascade with their thread and reject unknown roles', async () => {
      const t = await thread(USER_A, 'cascade', [1, 2, 3]);
      const bad = await expectError(
        db.query(
          `insert into public.coach_messages (thread_id, user_id, role, content) values ($1, $2, 'system', 'x')`,
          [t, USER_A],
        ),
      );
      expect(bad.message).toMatch(/violates check constraint/);
      await db.query(`delete from public.coach_threads where id = $1`, [t]);
      expect((await counts(USER_A)).messages).toBe(0);
    });

    it('stores no secrets: no api-key / token column anywhere in the coach tables', async () => {
      const cols = await db.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.columns
          where table_schema = 'public' and table_name in ('coach_threads', 'coach_messages')`,
      );
      const byTable = (t: string) =>
        cols.rows
          .filter((c) => c.table_name === t)
          .map((c) => c.column_name)
          .sort();
      expect(byTable('coach_threads')).toEqual([
        'created_at',
        'id',
        'title',
        'updated_at',
        'user_id',
      ]);
      expect(byTable('coach_messages')).toEqual([
        'content',
        'created_at',
        'id',
        'role',
        'thread_id',
        'user_id',
      ]);
    });
  });
});
