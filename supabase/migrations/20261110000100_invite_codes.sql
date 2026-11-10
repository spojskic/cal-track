-- 20261110000100_invite_codes.sql
-- Invite codes for self-service registration (Edge Function `sign-up`).
--
-- Why this file sorts AFTER 20261110000090_pg_cron_supabase_only.sql: that migration is already applied on the real
-- project. A migration with an older version than the last applied one would make `supabase db push` ask for
-- --include-all. (The Supabase-only migration is skipped by the PGlite test harness; this one is plain Postgres and runs there.)
--
-- Model: sign-up stays DISABLED in the Supabase auth settings (config.toml [auth] enable_signup = false). The owner
-- generates a code in the SQL editor; a friend enters it in the app; the Edge Function `sign-up` consumes the code and
-- creates the account server-side with the admin API (auth.admin.createUser, e-mail pre-confirmed). No dashboard setting
-- changes and no e-mail is sent.
--
-- Owner cheat sheet (SQL editor, runs as the `postgres` role):
--   select public.create_invite_code('for Anna', 1, 14);   -- note, max uses, valid days  -> 'K7M2-9QXA-F3TW'
--   select * from public.list_invite_codes();              -- code, note, uses/max, status, expiry, ...
--   select public.revoke_invite_code('K7M2-9QXA-F3TW');    -- true when the code exists; dashes/spaces/case do not matter
--
-- Design (mirrors migration 13, the Garmin tables, and 11, the rate limiter):
--   * The table lives in the `private` schema, which the Data API does not expose (config.toml [api] schemas = ["public"]).
--     RLS is enabled with NO policies and every privilege is revoked from public / anon / authenticated, so clients can
--     neither read nor guess codes.
--   * The Edge Function reaches it only through narrow `public.*` RPCs: SECURITY DEFINER, fixed search_path, EXECUTE for
--     service_role (the function's key) and postgres (the SQL editor) ONLY.
--   * Codes are stored NORMALISED: upper-case letters and digits, no dashes or spaces. They are SHOWN in groups of four.
--     Every RPC normalises its input the same way, so 'k7m2 9qxa-f3tw' and 'K7M29QXAF3TW' are the same code.
--   * A code is 12 characters from a 30-character alphabet without look-alikes (no I, L, O, U, 0, 1):
--     30^12 ~ 5.3e17 (~58.9 bits). Brute force is made impossible by the Edge Function's rate limits, not by secrecy of
--     the table alone: at most 20 attempts per 10 minutes over ALL callers.
--   * Consuming a code is ONE atomic UPDATE .. WHERE (not revoked, not expired, uses < max_uses) RETURNING, so two
--     parallel sign-ups can never use a single-use code twice.

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table if not exists private.invite_codes (
  id            uuid        primary key default gen_random_uuid(),
  -- Normalised: upper-case, letters and digits only (see private.normalize_invite_code()).
  code          text        not null unique check (code ~ '^[A-Z0-9]{8,32}$'),
  note          text        check (note is null or char_length(note) <= 200),
  max_uses      int         not null default 1 check (max_uses >= 1),
  uses          int         not null default 0 check (uses >= 0),
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

comment on table private.invite_codes is
  'Sign-up invite codes (normalised, secret). Service role / postgres only, reached through public.*_invite_code RPCs.';

alter table private.invite_codes enable row level security;

-- No policies on purpose: nobody but the table owner can touch these rows directly.
revoke all on table private.invite_codes from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers (private; only called from the SECURITY DEFINER functions below)
-- ---------------------------------------------------------------------------

-- 'k7m2 9qxa-f3tw' -> 'K7M29QXAF3TW'. Everything that is not a letter or digit is dropped (dashes, spaces, the
-- non-breaking spaces and en dashes that copy and paste can produce).
create or replace function private.normalize_invite_code(p_code text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

-- 'K7M29QXAF3TW' -> 'K7M2-9QXA-F3TW' (groups of four).
create or replace function private.format_invite_code(p_code text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select regexp_replace(coalesce(p_code, ''), '(.{4})(?=.)', '\1-', 'g')
$$;

-- Cryptographically strong random bytes without any extension: gen_random_uuid() is built into Postgres (13+) and is
-- backed by the same pg_strong_random() source as pgcrypto's gen_random_bytes(). pgcrypto is avoided on purpose: it
-- would have to be installed in a known schema (and be loaded into the PGlite test database). A UUID v4 carries 122
-- random bits and 6 fixed ones, so the version byte (7th) and the variant byte (9th) are dropped, which leaves 14 fully
-- random bytes per call.
create or replace function private.invite_random_bytes(p_n int)
returns bytea
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_out bytea := ''::bytea;
  v_uuid bytea;
begin
  if p_n is null or p_n < 1 or p_n > 1024 then
    raise exception 'invalid byte count' using errcode = 'invalid_parameter_value';
  end if;
  while octet_length(v_out) < p_n loop
    v_uuid := uuid_send(gen_random_uuid());
    v_out := v_out
      || substring(v_uuid from 1 for 6)    -- bytes 0-5
      || substring(v_uuid from 8 for 1)    -- byte 7 (byte 6 holds the version nibble)
      || substring(v_uuid from 10 for 7);  -- bytes 9-15 (byte 8 holds the variant bits)
  end loop;
  return substring(v_out from 1 for p_n);
end;
$$;

revoke all on function private.normalize_invite_code(text) from public, anon, authenticated;
revoke all on function private.format_invite_code(text) from public, anon, authenticated;
revoke all on function private.invite_random_bytes(int) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Owner RPCs: create / list / revoke
-- ---------------------------------------------------------------------------

-- Creates a code and returns it in groups of four. p_valid_days = NULL means "never expires".
create or replace function public.create_invite_code(
  p_note        text default null,
  p_max_uses    int  default 1,
  p_valid_days  int  default 14
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  -- 30 characters (no I, L, O, U, 0, 1). One random byte yields 5 bits; the values 30 and 31 are REJECTED instead of
  -- wrapped around, so every character is exactly equally likely (no modulo bias).
  c_alphabet  constant text := 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  c_length    constant int  := 12;
  v_code      text;
  v_bytes     bytea;
  v_index     int;
  v_attempt   int := 0;
  v_expires   timestamptz;
  v_note      text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_max_uses is null or p_max_uses < 1 or p_max_uses > 1000 then
    raise exception 'max uses must be between 1 and 1000' using errcode = 'invalid_parameter_value';
  end if;
  if p_valid_days is not null and (p_valid_days < 1 or p_valid_days > 3650) then
    raise exception 'valid days must be between 1 and 3650 (or null for no expiry)' using errcode = 'invalid_parameter_value';
  end if;
  if v_note is not null and char_length(v_note) > 200 then
    raise exception 'note is limited to 200 characters' using errcode = 'invalid_parameter_value';
  end if;
  if p_valid_days is not null then
    v_expires := now() + make_interval(days => p_valid_days);
  end if;

  loop
    v_attempt := v_attempt + 1;
    if v_attempt > 20 then
      raise exception 'could not generate a unique invite code';
    end if;

    v_code := '';
    while char_length(v_code) < c_length loop
      v_bytes := private.invite_random_bytes(32);
      for i in 0 .. octet_length(v_bytes) - 1 loop
        v_index := get_byte(v_bytes, i) & 31;
        if v_index < 30 then
          v_code := v_code || substr(c_alphabet, v_index + 1, 1);
          exit when char_length(v_code) = c_length;
        end if;
      end loop;
    end loop;

    begin
      insert into private.invite_codes (code, note, max_uses, expires_at)
      values (v_code, v_note, p_max_uses, v_expires);
      exit;
    exception when unique_violation then
      null; -- astronomically unlikely; draw again
    end;
  end loop;

  return private.format_invite_code(v_code);
end;
$$;

comment on function public.create_invite_code(text, int, int) is
  'Owner (SQL editor): creates an invite code and returns it as XXXX-XXXX-XXXX. Args: note, max uses (default 1), valid days (default 14, NULL = never expires).';

-- Owner overview. status: active | used_up | expired | revoked (same precedence as consume_invite_code).
create or replace function public.list_invite_codes()
returns table (
  code          text,
  note          text,
  uses          int,
  max_uses      int,
  status        text,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz,
  last_used_at  timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select private.format_invite_code(c.code),
         c.note,
         c.uses,
         c.max_uses,
         case
           when c.revoked_at is not null then 'revoked'
           when c.expires_at is not null and c.expires_at <= now() then 'expired'
           when c.uses >= c.max_uses then 'used_up'
           else 'active'
         end,
         c.expires_at,
         c.revoked_at,
         c.created_at,
         c.last_used_at
    from private.invite_codes c
   order by c.created_at desc, c.id
$$;

comment on function public.list_invite_codes() is
  'Owner (SQL editor): all invite codes, newest first, with status active | used_up | expired | revoked.';

-- Revokes a code (it can no longer be consumed). Returns true when the code exists. Revoking twice keeps the first time.
create or replace function public.revoke_invite_code(p_code text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_code text := private.normalize_invite_code(p_code);
begin
  update private.invite_codes c
     set revoked_at = coalesce(c.revoked_at, now())
   where c.code = v_code;
  return found;
end;
$$;

comment on function public.revoke_invite_code(text) is
  'Owner (SQL editor): revokes an invite code. Returns true when the code exists.';

-- ---------------------------------------------------------------------------
-- Edge Function RPCs: consume / release
-- ---------------------------------------------------------------------------

-- Atomically uses one slot of a code. Returns 'ok', or why it was refused: 'invalid' (unknown / malformed),
-- 'revoked', 'expired', 'used_up'. The refusal reason is looked up only AFTER the guarded UPDATE matched nothing.
create or replace function public.consume_invite_code(p_code text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_code text := private.normalize_invite_code(p_code);
  v_row  private.invite_codes%rowtype;
begin
  if char_length(v_code) < 8 or char_length(v_code) > 32 then
    return 'invalid';
  end if;

  update private.invite_codes c
     set uses = c.uses + 1,
         last_used_at = now()
   where c.code = v_code
     and c.revoked_at is null
     and (c.expires_at is null or c.expires_at > now())
     and c.uses < c.max_uses
  returning c.* into v_row;
  if found then
    return 'ok';
  end if;

  select c.* into v_row from private.invite_codes c where c.code = v_code;
  if not found then
    return 'invalid';
  end if;
  if v_row.revoked_at is not null then
    return 'revoked';
  end if;
  if v_row.expires_at is not null and v_row.expires_at <= now() then
    return 'expired';
  end if;
  return 'used_up';
end;
$$;

comment on function public.consume_invite_code(text) is
  'Edge Function sign-up: atomically uses one slot of an invite code. Returns ok | invalid | expired | used_up | revoked. service_role only.';

-- Gives a slot back when the account could not be created after the code was consumed. Never goes below 0.
create or replace function public.release_invite_code(p_code text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_code text := private.normalize_invite_code(p_code);
begin
  update private.invite_codes c
     set uses = greatest(c.uses - 1, 0)
   where c.code = v_code;
end;
$$;

comment on function public.release_invite_code(text) is
  'Edge Function sign-up: gives back one slot after a failed account creation (never below 0). service_role only.';

-- ---------------------------------------------------------------------------
-- Grants: service_role (Edge Functions) and postgres (the SQL editor) ONLY.
-- ---------------------------------------------------------------------------

revoke all on function public.create_invite_code(text, int, int) from public, anon, authenticated;
revoke all on function public.list_invite_codes() from public, anon, authenticated;
revoke all on function public.revoke_invite_code(text) from public, anon, authenticated;
revoke all on function public.consume_invite_code(text) from public, anon, authenticated;
revoke all on function public.release_invite_code(text) from public, anon, authenticated;

grant execute on function public.create_invite_code(text, int, int) to service_role;
grant execute on function public.list_invite_codes() to service_role;
grant execute on function public.revoke_invite_code(text) to service_role;
grant execute on function public.consume_invite_code(text) to service_role;
grant execute on function public.release_invite_code(text) to service_role;

-- The SQL editor connects as `postgres`. It owns these functions when this migration runs as postgres (the usual case),
-- but the grant keeps working if the objects are ever owned by another role.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'postgres') then
    grant execute on function public.create_invite_code(text, int, int) to postgres;
    grant execute on function public.list_invite_codes() to postgres;
    grant execute on function public.revoke_invite_code(text) to postgres;
    grant execute on function public.consume_invite_code(text) to postgres;
    grant execute on function public.release_invite_code(text) to postgres;
  end if;
end $$;
