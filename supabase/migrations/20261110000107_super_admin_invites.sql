-- 20261110000107_super_admin_invites.sql
-- A super admin: one boolean on the profile. Only that person sees the "Invite people" screen of the app (More > Admin) and can
-- create, list and revoke invite codes from there instead of the SQL editor.
--
-- Why this file sorts after 20261110000106: that migration is already applied on the real project (a migration with an older version
-- than the last applied one would make `supabase db push` ask for --include-all).
--
-- Making yourself the super admin (SQL editor, or Table Editor > profiles > tick is_admin on your row):
--   update public.profiles set is_admin = true where user_id = (select id from auth.users where email = 'you@example.com');
--
-- Design:
--   * `profiles.is_admin` is a plain boolean, default false. The profile row is owner-writable through the Data API (RLS lets a user
--     update their own row), so the flag is PROTECTED by a trigger: a request that runs as an API role (anon / authenticated) can
--     neither set it on insert nor change it on update. The SQL editor and the dashboard (role postgres) and the service key
--     (role service_role) can. The trigger function is SECURITY INVOKER on purpose: `current_user` is the role of the request;
--     a SECURITY DEFINER function would see its owner instead and the check would never fire.
--   * The existing owner RPCs (create / list / revoke_invite_code, migration 100) stay closed to clients. Three thin wrappers are
--     opened to `authenticated`; each one checks private.is_super_admin() first and raises 42501 (insufficient privilege) for anybody
--     else. They are SECURITY DEFINER with a fixed search_path, like every other function that touches the private schema.
--   * Sending the code by e-mail is deliberately NOT part of this. A later "invite by e-mail" (an Edge Function that calls
--     public.create_invite_code with the service key and sends the mail, e.g. through Cloudflare) can reuse these RPCs and this flag
--     as its permission check.

-- ---------------------------------------------------------------------------
-- The flag and its guard
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists is_admin boolean not null default false;

comment on column public.profiles.is_admin is
  'Super admin: may create, list and revoke invite codes in the app. Only the SQL editor / dashboard (postgres) and service_role can change it.';

create schema if not exists private;

-- SECURITY INVOKER: current_user must be the role that runs the statement (authenticated for a signed-in client).
create or replace function private.guard_profile_admin_flag()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated', 'authenticator') then
    if tg_op = 'INSERT' then
      if new.is_admin then
        raise exception 'is_admin can only be set by the app owner (SQL editor)' using errcode = '42501';
      end if;
    elsif new.is_admin is distinct from old.is_admin then
      raise exception 'is_admin can only be changed by the app owner (SQL editor)' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.guard_profile_admin_flag() from public, anon, authenticated;

drop trigger if exists profiles_guard_admin_flag on public.profiles;
create trigger profiles_guard_admin_flag
  before insert or update on public.profiles
  for each row execute function private.guard_profile_admin_flag();

-- True when the caller (auth.uid()) has is_admin set. Reads the profile with the owner's rights, so the answer does not depend on
-- the caller's RLS; only the SECURITY DEFINER wrappers below call it.
create or replace function private.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select p.is_admin from public.profiles p where p.user_id = (select auth.uid())), false)
$$;

revoke all on function private.is_super_admin() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Admin wrappers around the owner RPCs of migration 100
-- ---------------------------------------------------------------------------

-- Creates a code: note (who it is for: a name or an e-mail), max uses, valid days (NULL = never expires). Returns XXXX-XXXX-XXXX.
create or replace function public.admin_create_invite_code(
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
begin
  if not private.is_super_admin() then
    raise exception 'only the app owner can create invite codes' using errcode = '42501';
  end if;
  return public.create_invite_code(p_note, p_max_uses, p_valid_days);
end;
$$;

comment on function public.admin_create_invite_code(text, int, int) is
  'Super admin (profiles.is_admin): creates an invite code, see create_invite_code. Everybody else gets 42501.';

-- All codes, newest first, with status active | used_up | expired | revoked (see list_invite_codes).
create or replace function public.admin_list_invite_codes()
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
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_super_admin() then
    raise exception 'only the app owner can list invite codes' using errcode = '42501';
  end if;
  return query
    select l.code, l.note, l.uses, l.max_uses, l.status, l.expires_at, l.revoked_at, l.created_at, l.last_used_at
      from public.list_invite_codes() l;
end;
$$;

comment on function public.admin_list_invite_codes() is
  'Super admin (profiles.is_admin): all invite codes with their status, see list_invite_codes. Everybody else gets 42501.';

-- Revokes a code; true when it exists (see revoke_invite_code).
create or replace function public.admin_revoke_invite_code(p_code text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not private.is_super_admin() then
    raise exception 'only the app owner can revoke invite codes' using errcode = '42501';
  end if;
  return public.revoke_invite_code(p_code);
end;
$$;

comment on function public.admin_revoke_invite_code(text) is
  'Super admin (profiles.is_admin): revokes an invite code, see revoke_invite_code. Everybody else gets 42501.';

-- ---------------------------------------------------------------------------
-- Grants: signed-in clients and service_role; never anon. (The function default privileges of a Supabase project would hand
-- EXECUTE to anon, hence the explicit revoke.)
-- ---------------------------------------------------------------------------

revoke all on function public.admin_create_invite_code(text, int, int) from public, anon, authenticated;
revoke all on function public.admin_list_invite_codes() from public, anon, authenticated;
revoke all on function public.admin_revoke_invite_code(text) from public, anon, authenticated;

grant execute on function public.admin_create_invite_code(text, int, int) to authenticated, service_role;
grant execute on function public.admin_list_invite_codes() to authenticated, service_role;
grant execute on function public.admin_revoke_invite_code(text) to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'postgres') then
    grant execute on function public.admin_create_invite_code(text, int, int) to postgres;
    grant execute on function public.admin_list_invite_codes() to postgres;
    grant execute on function public.admin_revoke_invite_code(text) to postgres;
  end if;
end $$;
