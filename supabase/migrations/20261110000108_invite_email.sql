-- 20261110000108_invite_email.sql
-- Follow-up of 20261110000107 (already applied on the real project, so it is not edited): an invite code is now FOR an e-mail address.
--
-- `private.invite_codes.invited_email` holds it: lower-case and checked like the sign-up e-mail. The free text `note` stays for the codes
-- made before and for the SQL editor, but the app's form asks for the e-mail only. NOTHING IS SENT: the owner copies the code and sends
-- it. The column is the groundwork for inviting by e-mail later (an Edge Function would call public.create_invite_code_for with the
-- service key and send the mail).
--
-- Owner cheat sheet (SQL editor, role postgres):
--   select public.create_invite_code_for('anna@example.com', 1, 14);   -- e-mail, max uses, valid days  -> 'K7M2-9QXA-F3TW'
--   select code, invited_email, note, uses, max_uses, expires_at from private.invite_codes order by created_at desc;
--
-- NEW FUNCTIONS, none replaced: migrations are applied again in order by the test harness (every migration must be idempotent), and
-- Postgres cannot change the result type or the parameter names of a function in place. So the functions of 100 and 107 stay exactly
-- as they were (app builds made before this migration keep working with them) and the e-mail versions have their own names:
--   public.create_invite_code_for(p_invited_email, p_max_uses, p_valid_days)       owner / service role: a code for an e-mail
--   public.admin_create_invite_code_for(p_email, p_max_uses, p_valid_days)         the app: same, for the super admin
--   public.admin_list_invites()                                                    the app: all codes with invited_email
-- (admin_create_invite_code(note, ...) and admin_list_invite_codes() of 107 are superseded; drop them in a later migration once no
-- installed app calls them.) public.admin_revoke_invite_code(code) is unchanged and used by both.
--
-- The list is NOT paged in SQL: PostgREST pages the result of a function that returns a table (limit / offset / filters on its
-- columns / Prefer: count=exact), which is what the app uses.
--
-- Grants as in 100 / 107: the owner function to service_role (and postgres); the admin functions to authenticated and service_role
-- (and postgres); never anon.

-- ---------------------------------------------------------------------------
-- The invited e-mail
-- ---------------------------------------------------------------------------

alter table private.invite_codes add column if not exists invited_email text;

-- Same rule as the app (apps/app/src/lib/signup.ts isPlausibleEmail) and the sign-up function: one @, no spaces, a dot in the domain.
alter table private.invite_codes drop constraint if exists invite_codes_invited_email_check;
alter table private.invite_codes
  add constraint invite_codes_invited_email_check
  check (
    invited_email is null
    or (
      char_length(invited_email) <= 254
      and invited_email = lower(invited_email)
      and invited_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'
    )
  );

create index if not exists invite_codes_invited_email_idx
  on private.invite_codes (invited_email)
  where invited_email is not null;

comment on column private.invite_codes.invited_email is
  'The e-mail address the code was made for (lower-case). Informational today: the code works for any e-mail at sign-up.';

-- Codes whose note IS an e-mail address (what was typed into the old "Who is it for" field) get it as their invited e-mail. The note is
-- left alone, so app builds that still read it show what they showed before.
update private.invite_codes c
   set invited_email = lower(btrim(c.note))
 where c.invited_email is null
   and c.note is not null
   and char_length(btrim(c.note)) <= 254
   and lower(btrim(c.note)) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$';

-- ---------------------------------------------------------------------------
-- Owner: a code for an e-mail
-- ---------------------------------------------------------------------------

-- Creates a code for an e-mail address (lower-cased and checked) and returns it as XXXX-XXXX-XXXX. The admin function below calls it; a
-- later "invite by e-mail" function would call it with the service key.
create or replace function public.create_invite_code_for(
  p_invited_email  text,
  p_max_uses       int default 1,
  p_valid_days     int default 14
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text := nullif(lower(btrim(coalesce(p_invited_email, ''))), '');
  v_code  text;
begin
  if v_email is null then
    raise exception 'an e-mail address is required' using errcode = 'invalid_parameter_value';
  end if;
  if char_length(v_email) > 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' then
    raise exception 'that is not a valid e-mail address' using errcode = 'invalid_parameter_value';
  end if;

  v_code := public.create_invite_code(null, p_max_uses, p_valid_days);

  update private.invite_codes c
     set invited_email = v_email
   where c.code = private.normalize_invite_code(v_code);
  return v_code;
end;
$$;

comment on function public.create_invite_code_for(text, int, int) is
  'Owner (SQL editor) / service role: creates an invite code for an e-mail address. Args: e-mail, max uses (default 1), valid days (default 14, NULL = never expires).';

-- ---------------------------------------------------------------------------
-- Super admin (the app)
-- ---------------------------------------------------------------------------

create or replace function public.admin_create_invite_code_for(
  p_email       text,
  p_max_uses    int default 1,
  p_valid_days  int default 14
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
  return public.create_invite_code_for(p_email, p_max_uses, p_valid_days);
end;
$$;

comment on function public.admin_create_invite_code_for(text, int, int) is
  'Super admin (profiles.is_admin): creates an invite code for an e-mail address, see create_invite_code_for. Everybody else gets 42501.';

-- All codes, newest first, with the e-mail they were made for and status active | used_up | expired | revoked (same precedence as
-- list_invite_codes). The app pages and filters it with PostgREST (limit, offset, status=eq.active, Prefer: count=exact).
create or replace function public.admin_list_invites()
returns table (
  code           text,
  note           text,
  invited_email  text,
  uses           int,
  max_uses       int,
  status         text,
  expires_at     timestamptz,
  revoked_at     timestamptz,
  created_at     timestamptz,
  last_used_at   timestamptz
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
    select private.format_invite_code(c.code),
           c.note,
           c.invited_email,
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
     order by c.created_at desc, c.id;
end;
$$;

comment on function public.admin_list_invites() is
  'Super admin (profiles.is_admin): all invite codes with the e-mail and status, newest first. Everybody else gets 42501.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.create_invite_code_for(text, int, int) from public, anon, authenticated;
revoke all on function public.admin_create_invite_code_for(text, int, int) from public, anon, authenticated;
revoke all on function public.admin_list_invites() from public, anon, authenticated;

grant execute on function public.create_invite_code_for(text, int, int) to service_role;
grant execute on function public.admin_create_invite_code_for(text, int, int) to authenticated, service_role;
grant execute on function public.admin_list_invites() to authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'postgres') then
    grant execute on function public.create_invite_code_for(text, int, int) to postgres;
    grant execute on function public.admin_create_invite_code_for(text, int, int) to postgres;
    grant execute on function public.admin_list_invites() to postgres;
  end if;
end $$;
