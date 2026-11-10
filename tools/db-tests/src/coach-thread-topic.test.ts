// Migration 20261110000106_coach_thread_topic.sql: coach_threads.topic (jsonb, nullable)
//   null = ordinary chat, {"kind":"workout","id":"<exercise_entries.id>"} = a chat about one workout.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MIGRATIONS_DIR,
  USER_A,
  USER_B,
  applicableMigrationFiles,
  asAnon,
  asService,
  asUser,
  createDb,
  createUsers,
  expectError,
} from './harness';

const FILE = '20261110000106_coach_thread_topic.sql';
const sql = readFileSync(join(MIGRATIONS_DIR, FILE), 'utf8');

const WORKOUT = '3f0b8d0e-6a53-4c1f-9d57-0a1b2c3d4e5f';
const topic = (id = WORKOUT, kind = 'workout') => JSON.stringify({ kind, id });

describe('coach thread topic (migration 20261110000106)', () => {
  describe('on a database that had coach threads before the migration', () => {
    let db: PGlite;
    let oldThread = '';

    beforeAll(async () => {
      db = await createDb({ migrate: false });
      for (const file of applicableMigrationFiles().filter((f) => f < FILE)) {
        await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      }
      await createUsers(db);
      const r = await db.query<{ id: string }>(
        `insert into public.coach_threads (user_id, title) values ($1, 'Old chat') returning id`,
        [USER_A],
      );
      oldThread = r.rows[0]!.id;
      await db.query(`insert into public.coach_messages (thread_id, user_id, role, content) values ($1, $2, 'user', 'hello')`, [oldThread, USER_A]);
      await db.exec(sql);
    });
    afterAll(async () => {
      await db.close();
    });

    it('existing threads keep their data and get topic = null; their messages are untouched', async () => {
      const t = await db.query(`select title, topic from public.coach_threads where id = $1`, [oldThread]);
      expect(t.rows).toEqual([{ title: 'Old chat', topic: null }]);
      const m = await db.query<{ n: number }>(`select count(*)::int as n from public.coach_messages where thread_id = $1`, [oldThread]);
      expect(m.rows[0]!.n).toBe(1);
    });

    it('is idempotent: applying it again changes nothing, the topic of a thread survives', async () => {
      await db.query(`update public.coach_threads set topic = $2::jsonb where id = $1`, [oldThread, topic()]);
      await db.exec(sql);
      await db.exec(sql);
      const t = await db.query<{ topic: { kind: string; id: string } }>(`select topic from public.coach_threads where id = $1`, [oldThread]);
      expect(t.rows[0]!.topic).toEqual({ kind: 'workout', id: WORKOUT });

      const cols = await db.query<{ column_name: string; is_nullable: string; column_default: string | null; data_type: string }>(
        `select column_name, is_nullable, column_default, data_type from information_schema.columns
          where table_schema = 'public' and table_name = 'coach_threads' and column_name = 'topic'`,
      );
      expect(cols.rows).toEqual([{ column_name: 'topic', is_nullable: 'YES', column_default: null, data_type: 'jsonb' }]);
      const checks = await db.query<{ conname: string }>(
        `select conname from pg_constraint where conrelid = 'public.coach_threads'::regclass and contype = 'c' and conname = 'coach_threads_topic_shape_check'`,
      );
      expect(checks.rows).toHaveLength(1);
      const idx = await db.query<{ n: number }>(`select count(*)::int as n from pg_indexes where tablename = 'coach_threads' and indexname = 'coach_threads_topic_idx'`);
      expect(idx.rows[0]!.n).toBe(1);
    });
  });

  describe('with all migrations applied', () => {
    let db: PGlite;
    let threadA = '';

    beforeAll(async () => {
      db = await createDb();
      await createUsers(db);
    });
    afterAll(async () => {
      await db.close();
    });

    it('the owner creates a thread with a topic through RLS, and a thread without one', async () => {
      await asUser(db, USER_A, async () => {
        const withTopic = await db.query<{ id: string; topic: unknown }>(
          `insert into public.coach_threads (user_id, title, topic) values ($1, 'Workout: How was it', $2::jsonb) returning id, topic`,
          [USER_A, topic()],
        );
        threadA = withTopic.rows[0]!.id;
        expect(withTopic.rows[0]!.topic).toEqual({ kind: 'workout', id: WORKOUT });
        const plain = await db.query<{ topic: unknown }>(
          `insert into public.coach_threads (user_id, title) values ($1, 'Plain') returning topic`,
          [USER_A],
        );
        expect(plain.rows[0]!.topic).toBeNull();
      });
    });

    it('finds the thread for a topic the way the app does (->> filters), newest first', async () => {
      await asUser(db, USER_A, async () => {
        await db.query(`insert into public.coach_threads (user_id, title, topic, updated_at) values ($1, 'Workout: newer', $2::jsonb, now() + interval '1 minute')`, [USER_A, topic()]);
        await db.query(`insert into public.coach_threads (user_id, title, topic) values ($1, 'Other workout', $2::jsonb)`, [USER_A, topic('11111111-1111-4111-8111-111111111111')]);
        const found = await db.query<{ title: string }>(
          `select title from public.coach_threads where topic->>'kind' = 'workout' and topic->>'id' = $1 order by updated_at desc limit 1`,
          [WORKOUT],
        );
        expect(found.rows).toEqual([{ title: 'Workout: newer' }]);
        const none = await db.query(`select 1 from public.coach_threads where topic->>'kind' = 'workout' and topic->>'id' = $1`, ['22222222-2222-4222-8222-222222222222']);
        expect(none.rows).toHaveLength(0);
      });
    });

    it('the owner can change and clear a topic; messages keep working in a topic thread', async () => {
      await asUser(db, USER_A, async () => {
        const msg = await db.query<{ role: string }>(
          `insert into public.coach_messages (thread_id, user_id, role, content) values ($1, $2, 'user', 'How was this workout?') returning role`,
          [threadA, USER_A],
        );
        expect(msg.rows[0]!.role).toBe('user');
        const cleared = await db.query<{ topic: unknown }>(`update public.coach_threads set topic = null where id = $1 returning topic`, [threadA]);
        expect(cleared.rows).toEqual([{ topic: null }]);
        const set = await db.query<{ topic: unknown }>(`update public.coach_threads set topic = $2::jsonb where id = $1 returning topic`, [threadA, topic()]);
        expect(set.rows[0]!.topic).toEqual({ kind: 'workout', id: WORKOUT });
      });
    });

    it('rejects a malformed topic', async () => {
      const bad: Array<[string, string]> = [
        ['an array', `'[1,2]'`],
        ['a string', `'"workout"'`],
        ['no id', `'{"kind":"workout"}'`],
        ['no kind', `'{"id":"abc"}'`],
        ['a numeric id', `'{"kind":"workout","id":5}'`],
        ['an empty id', `'{"kind":"workout","id":""}'`],
        ['an upper case kind', `'{"kind":"Workout","id":"abc"}'`],
        ['a kind with spaces', `'{"kind":"my workout","id":"abc"}'`],
        ['a huge value', `jsonb_build_object('kind','workout','id','x','blob',repeat('y', 2000))`],
      ];
      for (const [label, value] of bad) {
        const err = await expectError(
          db.query(`insert into public.coach_threads (user_id, title, topic) values ($1, 'bad', ${value}::jsonb)`, [USER_A]),
        );
        expect(err.message, label).toMatch(/violates check constraint/);
      }
      // a future kind needs no migration
      const ok = await db.query(`insert into public.coach_threads (user_id, title, topic) values ($1, 'future', '{"kind":"meal_plan","id":"week-46"}'::jsonb) returning 1`, [USER_A]);
      expect(ok.rows).toHaveLength(1);
    });

    it("cannot be read or written across users, and anon has no access", async () => {
      await asUser(db, USER_B, async () => {
        const other = await db.query(`select topic from public.coach_threads where id = $1`, [threadA]);
        expect(other.rows).toHaveLength(0);
        const write = await db.query(`update public.coach_threads set topic = null where id = $1 returning 1`, [threadA]);
        expect(write.rows).toHaveLength(0);
        const err = await expectError(
          db.query(`insert into public.coach_threads (user_id, title, topic) values ($1, 'x', $2::jsonb)`, [USER_A, topic()]),
        );
        expect(err.message).toMatch(/row-level security/);
        // user B sees only their own (none) when filtering by A's topic
        const mine = await db.query(`select 1 from public.coach_threads where topic->>'id' = $1`, [WORKOUT]);
        expect(mine.rows).toHaveLength(0);
      });
      const a = await db.query<{ topic: unknown }>(`select topic from public.coach_threads where id = $1`, [threadA]);
      expect(a.rows[0]!.topic).toEqual({ kind: 'workout', id: WORKOUT });
      const anon = await asAnon(db, () => expectError(db.query(`select topic from public.coach_threads`)));
      expect(anon.message).toMatch(/permission denied/);
    });

    it('deleting a thread removes its topic and messages; the delete-all function and the retention purge are unaffected', async () => {
      const del = await asUser(db, USER_A, () => db.query<{ n: number }>(`select public.delete_all_my_coach_data()::int as n`));
      expect(del.rows[0]!.n).toBeGreaterThanOrEqual(3);
      const left = await db.query<{ n: number }>(`select count(*)::int as n from public.coach_threads where user_id = $1`, [USER_A]);
      expect(left.rows[0]!.n).toBe(0);
      const purge = await asService(db, () => db.query<{ r: { messages: number; threads: number } }>(`select public.purge_old_coach_messages() as r`));
      expect(purge.rows[0]!.r).toEqual({ messages: 0, threads: 0 });
    });
  });
});
