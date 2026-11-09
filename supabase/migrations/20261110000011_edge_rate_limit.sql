-- 20261110000011_edge_rate_limit.sql
-- Fixed-window rate limiter for Edge Functions (used by `online-search`).
--
-- Why in Postgres: Edge Function isolates are short-lived and run as many
-- instances, so an in-memory limiter cannot enforce "N per minute per user"
-- (and Open Food Facts allows only ~10 search requests per minute per IP).
--
-- Design:
--   * table private.edge_rate_limits (user_id, bucket, window_start, count): one row
--     per (user, bucket), updated atomically with INSERT .. ON CONFLICT DO UPDATE
--     (the row lock serialises concurrent requests). The table lives in the
--     `private` schema, which the Data API does not expose; RLS is enabled with NO
--     policies, so even a stray grant would not let clients read or write it.
--   * public.consume_rate_limit(p_user_id, p_bucket, p_max_per_window, p_window_seconds)
--     SECURITY DEFINER, executable by service_role ONLY. The Edge Function passes the
--     user id from the verified JWT and its own constants. (A client-callable variant
--     taking max/window as arguments would let a user reset or inflate their own
--     limit by passing a 1-second window or a huge max.)
--   * returns 0 when the request is allowed (and counted), otherwise the number of
--     seconds until the current window ends.
--   * user_id may also be a fixed sentinel UUID for limits shared by all users. There
--     is deliberately no FK to auth.users: counters are throw-away data, and the
--     table is bounded by users x buckets.

create table if not exists private.edge_rate_limits (
  user_id       uuid        not null,
  bucket        text        not null check (char_length(bucket) between 1 and 64),
  window_start  timestamptz not null default now(),
  count         int         not null default 0 check (count >= 0),
  primary key (user_id, bucket)
);

comment on table private.edge_rate_limits is
  'Fixed-window counters for Edge Function rate limiting. Written only by public.consume_rate_limit().';

alter table private.edge_rate_limits enable row level security;
revoke all on table private.edge_rate_limits from public, anon, authenticated;

create or replace function public.consume_rate_limit(
  p_user_id         uuid,
  p_bucket          text,
  p_max_per_window  int,
  p_window_seconds  int
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now    timestamptz := clock_timestamp();
  v_window interval;
  v_start  timestamptz;
  v_count  int;
begin
  if p_user_id is null
     or p_bucket is null or btrim(p_bucket) = '' or char_length(p_bucket) > 64
     or p_max_per_window is null or p_max_per_window < 1
     or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid rate limit arguments' using errcode = 'invalid_parameter_value';
  end if;

  v_window := make_interval(secs => p_window_seconds);

  -- In ON CONFLICT .. DO UPDATE every SET expression sees the OLD row, so both
  -- CASEs test the same "has the window expired?" condition. The counter is capped
  -- at max + 1 so rejected attempts cannot grow it without bound.
  insert into private.edge_rate_limits as r (user_id, bucket, window_start, count)
  values (p_user_id, p_bucket, v_now, 1)
  on conflict (user_id, bucket) do update
    set window_start = case when r.window_start + v_window <= v_now then v_now else r.window_start end,
        count        = case when r.window_start + v_window <= v_now then 1
                            else least(r.count + 1, p_max_per_window + 1) end
  returning r.window_start, r.count into v_start, v_count;

  if v_count <= p_max_per_window then
    return 0;
  end if;
  return greatest(1, ceil(extract(epoch from (v_start + v_window - v_now)))::int);
end;
$$;

comment on function public.consume_rate_limit(uuid, text, int, int) is
  'Counts one request for (user, bucket) in a fixed window. Returns 0 when allowed, else seconds to wait. service_role only.';

revoke all on function public.consume_rate_limit(uuid, text, int, int) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(uuid, text, int, int) to service_role;
