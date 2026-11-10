-- 20261110000106_coach_thread_topic.sql
-- A coach conversation can be ABOUT something. One nullable jsonb column on the existing table:
--
--   public.coach_threads.topic jsonb   null = an ordinary chat
--                                      {"kind": "workout", "id": "<exercise_entries.id>"} = a chat about one workout
--
-- The app opens such a chat from a workout ("ask the coach about this"), resumes the existing thread for the same topic
-- instead of starting a second one, and describes that workout to the coach on every turn. The topic holds only a kind and an
-- id: no workout data, no text. Deleting the workout does not touch the thread (there is no foreign key on purpose: the chat
-- stays readable, the coach is simply no longer given the workout's details).
--
-- Access: nothing to add. coach_threads already has the owner-only policy `coach_threads_owner` (20261110000009, for all
-- commands, user_id = auth.uid()) and a TABLE-level grant to `authenticated` (20261110000010), which covers a column added
-- later. `anon` has no access to the table. The composite foreign key of coach_messages (thread_id, user_id) and the
-- retention purge / delete-all functions of 20261110000007 do not mention the column, so they keep working unchanged.
--
-- The check keeps the value small and well shaped (an object with a short lowercase `kind` and a string `id`); which kinds
-- exist is decided by the app, so a new kind needs no migration.
--
-- Idempotent: the column is `add column if not exists`, the constraint is dropped if present and added again, the index is
-- `if not exists`. Applying this twice (or on a database where it already ran) changes nothing. Existing rows keep topic = null.

alter table public.coach_threads add column if not exists topic jsonb;

alter table public.coach_threads drop constraint if exists coach_threads_topic_shape_check;
alter table public.coach_threads
  add constraint coach_threads_topic_shape_check
  check (
    topic is null
    -- coalesce: a CHECK passes on NULL, and a missing key makes the comparisons NULL, so they must count as false
    or coalesce(
      jsonb_typeof(topic) = 'object'
      and jsonb_typeof(topic -> 'kind') = 'string'
      and (topic ->> 'kind') ~ '^[a-z_]{1,32}$'
      and jsonb_typeof(topic -> 'id') = 'string'
      and char_length(topic ->> 'id') between 1 and 64
      and octet_length(topic::text) <= 1000,
      false
    )
  );

-- "the thread for this workout": looked up by (user, kind, id)
create index if not exists coach_threads_topic_idx
  on public.coach_threads (user_id, (topic ->> 'kind'), (topic ->> 'id'))
  where topic is not null;

comment on column public.coach_threads.topic is
  'What the conversation is about: {"kind":"workout","id":"<exercise_entries.id>"}. null = ordinary chat.';
