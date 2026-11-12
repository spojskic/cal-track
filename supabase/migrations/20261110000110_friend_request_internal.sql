-- 20261110000110_friend_request_internal.sql
-- Friend requests by e-mail, part 2: the `friend-request` Edge Function sends an e-mail when a request was actually created
-- (supabase/functions/friend-request). Two changes, no behaviour change for the app:
--
--   * public.send_friend_request_internal(requester, email): the body of send_friend_request, with the requester as an ARGUMENT
--     instead of auth.uid() (the function runs with the service key, where auth.uid() is null) and the answer as
--     (status, created). `created` is true only when a pending row was inserted: that is the one case where the addressee has an
--     account and a new request appeared, so the only case where an e-mail should go out. An unknown e-mail still answers
--     'sent' with created = false (nothing exists to tell the caller apart), and accepting a mutual request, asking twice and
--     asking a friend answer created = false too. Executable by service_role and postgres only: the client keeps the wrapper.
--   * public.send_friend_request(email): now a thin wrapper that passes auth.uid() and returns just the status, exactly as
--     before (20261110000109_friends.sql). Same grants, same answers, same 20-a-day limit and refusals - verified by the
--     unchanged tests in tools/db-tests/src/friends.test.ts.
--
-- The e-mail the function sends never reveals whether an address has an account either: the client-side answer keeps saying
-- 'sent' either way, and the mail only goes out when created is true.

create or replace function public.send_friend_request_internal(p_requester uuid, p_email text)
returns table (status text, created boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := p_requester;
  v_email    text := lower(btrim(coalesce(p_email, '')));
  v_other    uuid;
  v_row      public.friendships%rowtype;
  v_made     uuid;
  v_status   text;
  v_created  boolean := false;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if char_length(v_email) > 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' then
    raise exception 'that is not a valid e-mail address' using errcode = 'invalid_parameter_value';
  end if;

  select u.id into v_other from auth.users u where lower(u.email) = v_email limit 1;
  if v_other = v_uid then
    raise exception 'that is your own e-mail address' using errcode = 'invalid_parameter_value';
  end if;

  if v_other is null then
    -- the same answer as for an account that exists (the request just never appears in anybody's list)
    v_status := 'sent';
  else
    select f.* into v_row
      from public.friendships f
     where least(f.requester_id, f.addressee_id) = least(v_uid, v_other)
       and greatest(f.requester_id, f.addressee_id) = greatest(v_uid, v_other);
    if found then
      if v_row.status = 'accepted' then
        v_status := 'already_friends';
      elsif v_row.requester_id = v_uid then
        v_status := 'already_requested';
      else
        update public.friendships f set status = 'accepted', responded_at = now() where f.id = v_row.id;
        v_status := 'accepted';
      end if;
    else
      if (select count(*) from public.friendships f where f.requester_id = v_uid and f.created_at > now() - interval '1 day') >= 20 then
        raise exception 'too many friend requests today, try again tomorrow' using errcode = '54000';
      end if;

      insert into public.friendships (requester_id, addressee_id) values (v_uid, v_other)
      on conflict do nothing
      returning id into v_made;   -- no row on conflict, so no double insert on a race counts as created
      v_created := v_made is not null;
      v_status := 'sent';
    end if;
  end if;

  return query select v_status, v_created;
end;
$$;

comment on function public.send_friend_request_internal(uuid, text) is
  'Service-role variant of send_friend_request with the requester as an argument. Answers (status, created); created is true only when a pending request row was inserted, which is when the friend-request Edge Function sends the e-mail.';

-- The client-facing function: unchanged behaviour, one implementation (the internal one above).
create or replace function public.send_friend_request(p_email text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select s.status into v_status
    from public.send_friend_request_internal((select auth.uid()), p_email) s;
  return v_status;
end;
$$;

comment on function public.send_friend_request(text) is
  'Sends a friend request to an e-mail address. Answers sent | accepted | already_friends | already_requested; an unknown e-mail answers sent too (and creates nothing).';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.send_friend_request_internal(uuid, text) from public, anon, authenticated;
grant execute on function public.send_friend_request_internal(uuid, text) to service_role;

-- The wrapper keeps its grants (create or replace does not touch them); restated so the migration stays safe to re-run.
revoke all on function public.send_friend_request(text) from public, anon;
grant execute on function public.send_friend_request(text) to authenticated, service_role;
