-- 20261110000105_workout_details.sql
-- What a device knows about a workout beyond its name, duration and calories: heart rate, time in heart-rate zones, distance, pace,
-- training effect, strength sets, laps. One nullable jsonb column on the existing table, written by the phone (the Garmin link reads
-- the details of a workout from Garmin and saves them here) and read by the Workouts screens and by the coach.
--
--   public.exercise_entries.details jsonb   null = nothing known (manual entries, Apple Health / Health Connect rows, Garmin
--                                           workouts that were not opened or synced since)
--
-- The shape is documented and validated in code (packages/garmin/src/workout-details.ts, `v: 1`, tolerant parsing); the database
-- only guarantees that the value is a JSON object and that it stays small (a long strength session is a few kilobytes).
--
-- Access: nothing to add. exercise_entries already has the owner-only policy `exercise_entries_owner` (20261110000009, for all
-- commands, user_id = auth.uid()) and a TABLE-level grant to `authenticated` (20261110000010), which covers a column added later.
-- `anon` has no access to the table. The Garmin sync fills `details` with the activity list's heart rate and zones (level 'summary')
-- for new workouts and for workouts that have none or only a summary; it never replaces details that were read from the
-- per-activity endpoints (level 'full'), and a sync of a workout that carries no details never clears them.
--
-- Idempotent: the column is `add column if not exists`, the two constraints are dropped if present and added again, so applying
-- this twice (or on a database where it already ran) changes nothing. Existing rows keep details = null.

alter table public.exercise_entries add column if not exists details jsonb;

alter table public.exercise_entries drop constraint if exists exercise_entries_details_object_check;
alter table public.exercise_entries
  add constraint exercise_entries_details_object_check
  check (details is null or jsonb_typeof(details) = 'object');

alter table public.exercise_entries drop constraint if exists exercise_entries_details_size_check;
alter table public.exercise_entries
  add constraint exercise_entries_details_size_check
  check (details is null or octet_length(details::text) <= 100000);

comment on column public.exercise_entries.details is
  'Device details of the workout (heart rate, zones, distance, pace, training effect, strength sets, laps). jsonb object, shape v1 documented in packages/garmin/src/workout-details.ts. null = not known.';
