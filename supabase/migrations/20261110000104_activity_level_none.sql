-- 20261110000104_activity_level_none.sql
-- A fifth baseline activity level, 'none': nothing is added for everyday movement (baseline = 0 x BMR). It is for people who let a
-- watch dictate their activity: with the Device-adjusted energy mode the budget starts at the resting burn and grows with what
-- the watch records.
--
-- profiles.activity_level was created in 20261110000004 with an unnamed column check, which Postgres names
-- profiles_activity_level_check. Replace it with the same list plus 'none'. Idempotent: the constraint is dropped if it exists
-- and added again, so applying this twice (or on a database where it already ran) is a no-op; existing rows keep their level.

alter table public.profiles drop constraint if exists profiles_activity_level_check;
alter table public.profiles
  add constraint profiles_activity_level_check
  check (activity_level is null or activity_level in ('none', 'sedentary', 'light', 'moderate', 'very'));
