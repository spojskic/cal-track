-- 20261110000007_coach.sql
-- AI coach conversations. NO API keys are ever stored server-side (the user's
-- OpenRouter key stays on the device). Messages are auto-purged after
-- app_settings.coach_retention_days (default 90) for users whose
-- profiles.coach_auto_delete is true. The cron schedule itself lives in the
-- Supabase-only migration 20261110000090_pg_cron_supabase_only.sql.

create table if not exists public.coach_threads (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  title       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint coach_threads_id_user_uk unique (id, user_id)
);

create index if not exists coach_threads_user_idx on public.coach_threads (user_id, updated_at desc);

drop trigger if exists coach_threads_set_updated_at on public.coach_threads;
create trigger coach_threads_set_updated_at
  before update on public.coach_threads
  for each row execute function public.set_updated_at();

create table if not exists public.coach_messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        text not null check (role in ('user', 'assistant')),
  content     text not null,
  created_at  timestamptz not null default now(),
  -- composite FK: a message can only live in a thread of the same user
  constraint coach_messages_thread_fk
    foreign key (thread_id, user_id) references public.coach_threads (id, user_id) on delete cascade
);

create index if not exists coach_messages_thread_idx on public.coach_messages (thread_id, created_at);
create index if not exists coach_messages_created_idx on public.coach_messages (created_at);

-- Retention purge. Intended for pg_cron (runs as the owner), never for clients.
-- Only users with profiles.coach_auto_delete = true are affected. Returns
-- {"messages": n, "threads": m}.
create or replace function public.purge_old_coach_messages()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_days      integer;
  v_cutoff    timestamptz;
  v_messages  bigint;
  v_threads   bigint;
begin
  select case when jsonb_typeof(s.value) = 'number' then (s.value #>> '{}')::numeric::integer end
    into v_days
  from public.app_settings s
  where s.key = 'coach_retention_days';

  v_days := greatest(coalesce(v_days, 90), 1);
  v_cutoff := now() - make_interval(days => v_days);

  with deleted as (
    delete from public.coach_messages m
    using public.profiles p
    where p.user_id = m.user_id
      and p.coach_auto_delete
      and m.created_at < v_cutoff
    returning 1
  )
  select count(*) into v_messages from deleted;

  -- Threads that are now empty and older than the cutoff. A just-created, still
  -- empty thread is left alone.
  with deleted as (
    delete from public.coach_threads t
    using public.profiles p
    where p.user_id = t.user_id
      and p.coach_auto_delete
      and t.updated_at < v_cutoff
      and not exists (select 1 from public.coach_messages m where m.thread_id = t.id)
    returning 1
  )
  select count(*) into v_threads from deleted;

  return jsonb_build_object('messages', v_messages, 'threads', v_threads);
end;
$$;

-- Client-callable "delete everything" switch (privacy). SECURITY INVOKER: RLS
-- guarantees only the caller's rows are visible/deletable; messages go with
-- their threads (FK cascade). Returns the number of threads deleted.
create or replace function public.delete_all_my_coach_data()
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_threads  bigint;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  with deleted as (
    delete from public.coach_threads t
    where t.user_id = v_uid
    returning 1
  )
  select count(*) into v_threads from deleted;

  return v_threads;
end;
$$;
