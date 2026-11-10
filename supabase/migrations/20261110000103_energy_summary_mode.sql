-- 20261110000103_energy_summary_mode.sql
-- Two small display / behaviour preferences on the profile (the same table that already holds unit_system, energy_mode,
-- net_carbs, ...). Both are plain columns, so the owner-only RLS policies and the table-level grants of
-- 20261110000009 / 20261110000010 already cover them.
--
--   energy_summary_mode            what the THIRD circle of the energy summary shows (Cronometer: "Energy Summary 3rd
--                                  Circle Display"):
--                                    'target'  = target (+ energy burned above the baseline) - consumed: Remaining / Over
--                                    'balance' = expenditure - consumed, whatever the weight goal: Deficit / Surplus
--                                  It is toggled by tapping the label under the circle, or in the energy settings.
--   energy_mode_auto_switched_at   set when the app itself moved energy_mode from 'static' to 'device_adjusted' after the
--                                  user connected a watch / health app. A user who then picks 'static' again on purpose is
--                                  not switched a second time (the flag is still set, so the app leaves the mode alone).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS skips the whole clause (check constraint included) when the column exists, so
-- applying this twice, or on a database where it already ran, is a no-op. Existing rows get the defaults ('target', null).

alter table public.profiles
  add column if not exists energy_summary_mode text not null default 'target'
    check (energy_summary_mode in ('target', 'balance'));

alter table public.profiles
  add column if not exists energy_mode_auto_switched_at timestamptz;
