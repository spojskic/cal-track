-- 20261110000109_friends.sql
-- Friends: you send a request to somebody's e-mail address, they accept or decline, and while you are friends each of you sees the
-- other's CUSTOM FOODS and RECIPES (read-only) in the lists and the search, and can log them or use them in a recipe. Nothing else is
-- shared: no diary, no weight, no targets, no profile, no AI estimates, no saved meals.
--
-- Model
--   * public.friendships: one row per pair (unique on the unordered pair), status 'pending' (requester -> addressee) or 'accepted'.
--     Clients can only READ their own rows and DELETE them (cancel a request, decline, remove a friend: all one delete). They cannot
--     insert or update: sending and accepting go through the SECURITY DEFINER functions below, because the address book is auth.users.
--   * public.send_friend_request(email): finds the account by e-mail. An unknown e-mail gets the same ANSWER as a known one ('sent') and
--     the screen never claims the person got it. (A request to a real account does show up under "waiting for an answer" and one to an
--     unknown address does not, so the list still tells them apart: accepted in a small invite-only app where the people know each
--     other.) Asking somebody who already asked you accepts it. At most 20 requests a day.
--   * public.respond_friend_request(id, accept): only the addressee; accept makes it 'accepted', decline deletes the row.
--   * public.list_friendships(): both kinds of rows with the other person's name and e-mail (clients cannot read auth.users).
--   * public.my_friend_ids(): the user ids of the caller's accepted friends. SECURITY DEFINER, so RLS policies can use it without
--     recursing into friendships' own policies, and the planner evaluates it once per statement.
--
-- Visibility (RLS)
--   * foods: the caller's friends' foods of kind custom / recipe are readable, plus any food the caller has USED (a diary entry, a recipe
--     ingredient, a saved meal item, a favourite): so ending a friendship never blanks the diary or a recipe that already uses a
--     friend's food. A use needs the food to be visible when it is made (the existing insert checks), so this cannot be used to reach
--     a food one never saw. public.my_used_food() is SECURITY DEFINER: the policies of diary_entries & co. read foods, and a policy on
--     foods that read them back would recurse.
--   * food_portions follow their food (existing policy). recipes and recipe_ingredients of friends are readable (new select policies);
--     writes stay owner-only everywhere, so a friend can neither change nor delete a shared food.
--   * search: private.search_foods_ranked() applies the same rule explicitly (friends' custom foods and recipes rank below your own).
--
-- Deleting a food that a friend has logged: the owner cannot see the friend's diary, so the delete fails on the foreign key. The app
-- archives it instead (archived foods are hidden from search and lists but keep working in entries that already use them).
-- The same holds for deleting the whole ACCOUNT of somebody whose foods or recipes a friend (or former friend) still uses: the cascade
-- from auth.users to foods fails on those foreign keys. Such an account needs its shared foods re-pointed (or those entries removed)
-- first. Copying a food into the user's own foods on first use would remove this; it is not done because it duplicates foods.
-- Known limits, accepted for a small invite-only app: the 20 requests a day count the rows that still exist, so cancelling and asking
-- again gets around it; and an outgoing request to a real account shows that account's name until it is answered.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table if not exists public.friendships (
  id            uuid        primary key default gen_random_uuid(),
  requester_id  uuid        not null references auth.users (id) on delete cascade,
  addressee_id  uuid        not null references auth.users (id) on delete cascade,
  status        text        not null default 'pending' check (status in ('pending', 'accepted')),
  created_at    timestamptz not null default now(),
  responded_at  timestamptz,
  constraint friendships_not_self check (requester_id <> addressee_id)
);

-- One row per PAIR, whoever asked first.
create unique index if not exists friendships_pair_uk
  on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));
create index if not exists friendships_requester_idx on public.friendships (requester_id, status);
create index if not exists friendships_addressee_idx on public.friendships (addressee_id, status);

comment on table public.friendships is
  'Friend requests (pending) and friendships (accepted), one row per pair. Written only through send_friend_request / respond_friend_request.';

alter table public.friendships enable row level security;

drop policy if exists friendships_read on public.friendships;
create policy friendships_read on public.friendships
  for select to authenticated
  using (requester_id = (select auth.uid()) or addressee_id = (select auth.uid()));

-- Cancel a request, decline one, remove a friend: either side may delete the row.
drop policy if exists friendships_delete on public.friendships;
create policy friendships_delete on public.friendships
  for delete to authenticated
  using (requester_id = (select auth.uid()) or addressee_id = (select auth.uid()));

revoke all on public.friendships from public, anon, authenticated;
grant select, delete on public.friendships to authenticated;
grant all on public.friendships to service_role;

-- ---------------------------------------------------------------------------
-- Who is my friend, what have I used
-- ---------------------------------------------------------------------------

create or replace function public.my_friend_ids()
returns setof uuid
language sql
stable
rows 10
security definer
set search_path = ''
as $$
  select case when f.requester_id = (select auth.uid()) then f.addressee_id else f.requester_id end
    from public.friendships f
   where f.status = 'accepted'
     and (select auth.uid()) in (f.requester_id, f.addressee_id)
$$;

comment on function public.my_friend_ids() is
  'The user ids of the caller''s accepted friends. Used by the row level security policies of foods, recipes and recipe_ingredients.';

-- True when the caller already uses the food somewhere: a diary entry, an ingredient of one of their recipes, a saved meal, a favourite.
create or replace function public.my_used_food(p_food_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.diary_entries d where d.food_id = p_food_id and d.user_id = (select auth.uid()))
      or exists (
        select 1
          from public.recipe_ingredients ri
          join public.recipes r on r.food_id = ri.recipe_food_id
         where ri.ingredient_food_id = p_food_id and r.user_id = (select auth.uid())
      )
      or exists (
        select 1
          from public.saved_meal_items i
          join public.saved_meals m on m.id = i.saved_meal_id
         where i.food_id = p_food_id and m.user_id = (select auth.uid())
      )
      or exists (select 1 from public.favorites v where v.food_id = p_food_id and v.user_id = (select auth.uid()))
$$;

comment on function public.my_used_food(uuid) is
  'True when the caller has a diary entry, recipe ingredient, saved meal item or favourite that uses the food (keeps it visible after a friendship ends).';

-- ---------------------------------------------------------------------------
-- Requests
-- ---------------------------------------------------------------------------

-- Returns 'sent' | 'accepted' (the other person had already asked you) | 'already_friends' | 'already_requested'.
-- An e-mail without an account also answers 'sent'. Raises 22023 for a malformed address or your own, 54000 after 20 requests in a day.
create or replace function public.send_friend_request(p_email text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_other  uuid;
  v_row    public.friendships%rowtype;
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
    return 'sent';   -- the same answer as for an account that exists (the request just never appears in anybody's list)
  end if;

  select f.* into v_row
    from public.friendships f
   where least(f.requester_id, f.addressee_id) = least(v_uid, v_other)
     and greatest(f.requester_id, f.addressee_id) = greatest(v_uid, v_other);
  if found then
    if v_row.status = 'accepted' then
      return 'already_friends';
    end if;
    if v_row.requester_id = v_uid then
      return 'already_requested';
    end if;
    update public.friendships f set status = 'accepted', responded_at = now() where f.id = v_row.id;
    return 'accepted';
  end if;

  if (select count(*) from public.friendships f where f.requester_id = v_uid and f.created_at > now() - interval '1 day') >= 20 then
    raise exception 'too many friend requests today, try again tomorrow' using errcode = '54000';
  end if;

  insert into public.friendships (requester_id, addressee_id) values (v_uid, v_other)
  on conflict do nothing;
  return 'sent';
end;
$$;

comment on function public.send_friend_request(text) is
  'Sends a friend request to an e-mail address. Answers sent | accepted | already_friends | already_requested; an unknown e-mail answers sent too (and creates nothing).';

-- Accept (true) or decline (false) a request that was sent to the caller. Returns whether there was such a request.
create or replace function public.respond_friend_request(p_id uuid, p_accept boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_accept is null then
    raise exception 'accept or decline' using errcode = '22004';
  end if;
  if p_accept then
    update public.friendships f set status = 'accepted', responded_at = now()
     where f.id = p_id and f.addressee_id = v_uid and f.status = 'pending';
  else
    delete from public.friendships f
     where f.id = p_id and f.addressee_id = v_uid and f.status = 'pending';
  end if;
  return found;
end;
$$;

comment on function public.respond_friend_request(uuid, boolean) is
  'Accepts or declines a pending friend request addressed to the caller (a decline deletes it). Returns whether there was one.';

-- The caller's friendships and requests with the other person's name and e-mail, newest first.
-- direction: 'incoming' (they asked you) or 'outgoing' (you asked them); status: 'pending' | 'accepted'.
create or replace function public.list_friendships()
returns table (
  id            uuid,
  status        text,
  direction     text,
  user_id       uuid,
  display_name  text,
  email         text,
  created_at    timestamptz,
  responded_at  timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select f.id,
         f.status,
         case when f.requester_id = (select auth.uid()) then 'outgoing' else 'incoming' end,
         o.id,
         coalesce(nullif(btrim(p.display_name), ''), split_part(o.email, '@', 1)),
         o.email,
         f.created_at,
         f.responded_at
    from public.friendships f
    join auth.users o on o.id = case when f.requester_id = (select auth.uid()) then f.addressee_id else f.requester_id end
    left join public.profiles p on p.user_id = o.id
   where (select auth.uid()) in (f.requester_id, f.addressee_id)
   order by f.created_at desc, f.id
$$;

comment on function public.list_friendships() is
  'The caller''s friends and pending requests (both directions) with name and e-mail of the other person.';

-- ---------------------------------------------------------------------------
-- Visibility: friends' custom foods and recipes
-- ---------------------------------------------------------------------------

drop policy if exists foods_read on public.foods;
create policy foods_read on public.foods
  for select to authenticated
  using (
    owner_id is null
    or owner_id = (select auth.uid())
    or (kind in ('custom', 'recipe') and owner_id in (select public.my_friend_ids()))
    or public.my_used_food(id)
  );

-- A friend's recipe: the recipe row and its ingredients can be read (writes stay owner-only, see recipes_owner).
drop policy if exists recipes_friend_read on public.recipes;
create policy recipes_friend_read on public.recipes
  for select to authenticated
  using (user_id in (select public.my_friend_ids()));

drop policy if exists recipe_ingredients_friend_read on public.recipe_ingredients;
create policy recipe_ingredients_friend_read on public.recipe_ingredients
  for select to authenticated
  using (exists (
    select 1 from public.recipes r
    where r.food_id = recipe_ingredients.recipe_food_id and r.user_id in (select public.my_friend_ids())
  ));

-- ---------------------------------------------------------------------------
-- Search: the same rule, applied explicitly (the function is SECURITY DEFINER, so RLS does not filter inside it)
-- ---------------------------------------------------------------------------

-- A function that carries `SET pg_trgm.word_similarity_threshold` can only be created by a role that is not a superuser when the pg_trgm
-- library is already LOADED in the session: otherwise the setting is an unknown "placeholder" variable and only superusers may set one
-- (SQLSTATE 42501, "permission denied to set parameter"). Migration 8 got away with it because earlier statements of its session had used
-- pg_trgm; this migration runs on its own, so it loads the library first by calling one of its functions.
select extensions.similarity('a', 'a');

create or replace function private.search_foods_ranked(
  q            text,
  max_results  int default 25,
  kinds        text[] default null
)
returns table (
  id             uuid,
  name           text,
  brand          text,
  kind           text,
  source         text,
  kcal_100g      numeric,
  protein_100g   numeric,
  carbs_100g     numeric,
  fat_100g       numeric,
  completeness   real,
  rank           real
)
language plpgsql
stable
rows 25   -- planner hint: without it (default 1000) the wrapper's RLS re-check becomes a seq scan + hash semi join
security definer
set search_path = ''
set pg_trgm.word_similarity_threshold = '0.45'
as $$
#variable_conflict use_column
declare
  v_uid      uuid := (select auth.uid());
  v_qn       text;
  v_tsq      tsquery;
  v_fuzzy_q  text;
  v_limit    int := least(greatest(coalesce(max_results, 25), 1), 100);
  v_kinds    text[] := case when coalesce(cardinality(kinds), 0) = 0 then null else kinds end;
begin
  -- normalise: unaccent + lower + collapse whitespace, cap length
  v_qn := btrim(regexp_replace(lower(public.immutable_unaccent(left(coalesce(q, ''), 100))), '\s+', ' ', 'g'));
  if v_qn = '' then
    return;
  end if;

  -- AND of prefix terms, built from parser-produced lexemes (injection-safe)
  select to_tsquery('simple'::regconfig,
                    string_agg('''' || replace(t.lexeme, '''', '''''') || ''':*', ' & '))
    into v_tsq
  from unnest(to_tsvector('simple'::regconfig, v_qn)) as t;

  if v_tsq is null then   -- punctuation only
    return;
  end if;

  -- NULL disables the (noisy for 1-2 chars) trigram branch; `NULL <% x` matches nothing
  v_fuzzy_q := case when char_length(v_qn) >= 3 then v_qn else null end;

  return query
  select s.id, s.name, s.brand, s.kind, s.source,
         s.kcal_100g, s.protein_100g, s.carbs_100g, s.fat_100g,
         s.completeness, s.score::real
  from (
    select
      f.id, f.name, f.brand, f.kind, f.source,
      (f.nutrients ->> 'ENERGY_KCAL')::numeric as kcal_100g,
      (f.nutrients ->> 'PROTEIN_G')::numeric   as protein_100g,
      (f.nutrients ->> 'CARBS_G')::numeric     as carbs_100g,
      (f.nutrients ->> 'FAT_G')::numeric       as fat_100g,
      f.completeness,
      (
        -- 1. personal
        case when f.owner_id = v_uid then 0.60 when f.owner_id is not null then 0.30 else 0 end
        + case when u.food_id is not null then
            0.35
            + least(0.25, 0.06 * ln(1 + u.use_count)::float8)
            + 0.10 / (1 + (extract(epoch from (now() - u.last_used_at)) / 86400.0 / 14.0))::float8
          else 0 end
        + case when fav.food_id is not null then 0.25 else 0 end
        -- 2. source quality
        + 0.20 * public.food_source_quality(f.source)::float8
        -- 3. text relevance
        + case when f.search @@ v_tsq then 0.30 else 0 end
        + 0.40 * extensions.word_similarity(v_qn, f.search_text)::float8
        + 0.20 * extensions.similarity(v_qn, f.search_text)::float8
        + case when starts_with(f.search_text, v_qn) then 0.10 else 0 end
        -- 4. completeness, popularity
        + 0.05 * coalesce(f.completeness, 0)::float8
        + 0.03 * least(1.0, ln(1 + greatest(f.popularity, 0))::float8 / 10.0)
      ) as score
    from public.foods f
    left join public.food_usage u on u.food_id = f.id and u.user_id = v_uid
    left join public.favorites fav on fav.food_id = f.id and fav.user_id = v_uid
    where not f.archived
      and (
        f.owner_id is null
        or f.owner_id = v_uid
        or (f.kind in ('custom', 'recipe') and f.owner_id in (select public.my_friend_ids()))
      )
      and (v_kinds is null or f.kind = any (v_kinds))
      and (f.search @@ v_tsq or v_fuzzy_q operator(extensions.<%) f.search_text)
  ) s
  order by s.score desc, char_length(s.name), s.name, s.id
  limit v_limit;
end;
$$;


-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.my_friend_ids() from public, anon, authenticated;
revoke all on function public.my_used_food(uuid) from public, anon, authenticated;
revoke all on function public.send_friend_request(text) from public, anon, authenticated;
revoke all on function public.respond_friend_request(uuid, boolean) from public, anon, authenticated;
revoke all on function public.list_friendships() from public, anon, authenticated;

-- my_friend_ids / my_used_food run inside the policies, as the caller.
grant execute on function public.my_friend_ids() to authenticated, service_role;
grant execute on function public.my_used_food(uuid) to authenticated, service_role;
grant execute on function public.send_friend_request(text) to authenticated, service_role;
grant execute on function public.respond_friend_request(uuid, boolean) to authenticated, service_role;
grant execute on function public.list_friendships() to authenticated, service_role;
