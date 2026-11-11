# @cal/importer

Imports **generic** food data (no branded, no Open Food Facts bulk) into the
Supabase tables `public.foods` and `public.food_portions`:

| Source (`foods.source`) | Dataset | Input (primary format first) |
| --- | --- | --- |
| `fdc_foundation` | USDA FoodData Central - Foundation Foods | **JSON** zip (auto-download) |
| `fdc_sr_legacy` | USDA FDC - SR Legacy (2018) | **JSON** zip (auto-download); CSV zip also works |
| `fdc_fndds` | USDA FDC - FNDDS Survey (WWEIA) | **JSON** zip (auto-download); CSV zip also works |
| `cnf` | Health Canada - Canadian Nutrient File 2015 | CSV files (manual download) |

**JSON is the primary FDC format**: the FNDDS JSON download is ~4 MB zipped (64 MB of JSON) versus
~200 MB zipped (1.6 GB unzipped) for the CSV tables, and the **Foundation Foods CSV archive of the
Oct 2026 release is incomplete** (it has no `food.csv`, `food_nutrient.csv` or `food_portion.csv`),
so Foundation can only be imported from JSON.

UK CoFID (Excel) is **not implemented yet** (`cofid` command is a marked TODO stub).

Everything is nutrients **per 100 g**, stored as jsonb keyed by the catalog codes of
`@cal/core` (`ENERGY_KCAL`, `PROTEIN_G`, ...), in catalog units. A nutrient the
source does not report is **absent** from the jsonb (unknown is not zero).

## Prerequisites

* Node >= 22.13 (`nvm use`), dependencies installed (`pnpm install` at the repo root).
* The migrations applied to the target database (`supabase db push` /
  `supabase db reset` locally) - the importer needs `public.foods` and
  `public.food_portions` (and `diary_entries` / `recipe_ingredients`, see
  "Idempotent re-runs").
* A Postgres URL with write access (the `postgres` role; RLS is bypassed):

  ```sh
  # Session pooler string (dashboard -> Connect -> Session pooler): works over IPv4
  export SUPABASE_DB_URL='postgresql://postgres.PROJECT-REF:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres'
  ```

  Use the **session pooler** (port 5432, user `postgres.PROJECT-REF`). The *direct* host
  `db.PROJECT-REF.supabase.co` is IPv6-only on the free plan and fails with `ENOTFOUND` on most
  home networks. Do not use the transaction pooler (6543). Special characters in the password
  must be URL-encoded (`@` becomes `%40`). The URL may also be passed as `--db-url`, or put in
  `tools/importer/.env` / the repo `.env` as `SUPABASE_DB_URL=...` (git-ignored; real
  environment variables win). **The URL and password are never printed.**
  TLS is used for every host except localhost (`--no-ssl` to disable).

## Run it

`pnpm import` is a built-in pnpm command (npm-lockfile converter), so the script must
be started with **`run import`**. Relative `--path`/`--cache-dir` values are resolved
against the directory you started pnpm in (the repo root).

```sh
cd /path/to/ration
source ~/.nvm/nvm.sh && nvm use 22

# 1. fetch the USDA JSON archives into tools/importer/.cache (git-ignored)
pnpm --filter @cal/importer run import -- download foundation   # ~0.7 MB (9 MB JSON)
pnpm --filter @cal/importer run import -- download sr_legacy    # ~6 MB
pnpm --filter @cal/importer run import -- download fndds        # ~4 MB (64 MB JSON)
#    (CSV archives are still available for sr_legacy / fndds with: download <name> --format csv)

# 2. CNF: manual download (see below) into tools/importer/.cache/cnf/

# 3. look before you write: parse + report only, no database connection.
#    JSON vs CSV is detected from the archive contents; --dataset is optional for JSON.
pnpm --filter @cal/importer run import -- fdc \
  --path tools/importer/.cache/FoodData_Central_foundation_food_json_2026-10-29.zip --dry-run

# 4. smoke test on the real database with a few foods
pnpm --filter @cal/importer run import -- fdc --path <zip> --limit 20

# 5. the real thing, in this order: foundation, sr_legacy, fndds, cnf
pnpm --filter @cal/importer run import -- fdc --path <foundation zip>
pnpm --filter @cal/importer run import -- fdc --path <sr_legacy zip>
pnpm --filter @cal/importer run import -- fdc --path <fndds zip>
pnpm --filter @cal/importer run import -- cnf --path tools/importer/.cache/cnf

# or all four from the cache directory in one go (add --download to fetch missing USDA zips)
pnpm --filter @cal/importer run import -- all --dry-run
pnpm --filter @cal/importer run import -- all
```

`--path` accepts a `.zip` (read entry by entry, never extracted), a plain `.json` file or an
already extracted directory. Order is a recommendation (highest quality first, so you
can stop when the size report says so); sources never overwrite each other, they are
separate rows keyed `(source, source_id)`.

### Commands and flags

| Command | Purpose |
| --- | --- |
| `download <foundation\|sr_legacy\|fndds> [--format json\|csv] [--cache-dir D] [--force] [--url U]` | Fetch a zip with Node `fetch` (JSON by default; `csv` for sr_legacy / fndds only), verify size and zip magic, warn when the expected files are missing, print a newer-release hint. |
| `fdc --path <zip\|dir\|.json> [--dataset <foundation\|sr_legacy\|fndds>]` | Import one USDA dataset. A `.json` file means the JSON loader (dataset from `FoundationFoods` / `SRLegacyFoods` / `SurveyFoods`); otherwise the CSV tables are used (dataset inferred from `food.csv` unless given). An incomplete CSV archive stops with an actionable message pointing to the JSON archive. |
| `cnf --path <dir\|zip> [--encoding auto\|utf8\|latin1] [--cnf-factor-mode auto\|multiplier\|grams]` | Import the Canadian Nutrient File. |
| `all [--cache-dir D] [--cnf-path P] [--only a,b] [--download]` | foundation -> sr_legacy -> fndds -> cnf from the cache (`<cache>/cnf` or `<cache>/cnf.zip`; CNF is skipped with a note if absent). |
| `cofid` | **TODO** (UK CoFID is Excel only); prints a message, exit code 2. |

Common flags: `--dry-run` (no DB connection), `--limit N` (first N foods per dataset),
`--db-url URL`, `--batch-size N` (default 500 foods per transaction), `--no-ssl`.
Exit codes: 0 ok, 1 runtime error, 2 usage error.

### CNF download (manual)

Health Canada does not offer a stable direct link. Search for **"Canadian Nutrient File
2015 download files"** on canada.ca (Health Canada > Food and nutrition > Healthy
eating > Nutrient data), download the **CSV** package (`cnf-fcen-csv.zip`) and unzip
it, or keep the zip, in `tools/importer/.cache/cnf/`. The importer needs
`FOOD NAME.csv`, `NUTRIENT AMOUNT.csv`, `NUTRIENT NAME.csv` and optionally
`CONVERSION FACTOR.csv`, `MEASURE NAME.csv`, `FOOD GROUP.csv`. The files are usually
ISO-8859-1; the encoding is auto-detected per file (UTF-8 BOM / valid UTF-8 / latin1)
or forced with `--encoding`. The parser follows the published data dictionary; if a
download has a different layout, `--dry-run` will say so (missing files, 0 foods,
unit mismatches) - nothing is written.

## What it does to the data

* **Streaming.** CSV: only the needed entries are opened (`food.csv`, `food_nutrient.csv`,
  `nutrient.csv`, `food_portion.csv`, `measure_unit.csv`, `food_category.csv`,
  `wweia_food_category.csv`, `survey_fndds_food.csv`); `food_nutrient.csv` is read row by row and
  grouped per `fdc_id`, keeping only foods of the right `food.data_type` and tracked nutrient ids.
  JSON: the single `.json` file is cut into one text per food while streaming (a small bracket /
  string state machine, `splitJsonArray`) and each food is parsed on its own, so memory is bounded
  by one food, not by the 64 MB FNDDS file. Both paths feed the same mapping, portion, quality and
  database code.
* **JSON details.** Nutrients are matched by `nutrient.id`, the unit comes from `nutrient.unitName`
  (`µg`/`UG`/`mcg` -> ug, `kJ`, `IU`, case-insensitive); entries without `amount` are skipped. If the
  same nutrient id appears twice in a food (it does not in the Oct 2026 file) the first entry with a
  usable amount wins - `nutrient.rank` belongs to the nutrient, not the entry, so it cannot rank
  duplicates; different ids of one catalog nutrient follow the fixed priority below. Category =
  `foodCategory.description` or `wweiaFoodCategory.wweiaFoodCategoryDescription`; `source_id` =
  `fdcId`.
* **Mapping** uses core's `NUTRIENT_BY_FDC_ID` (incl. alternate ids). Extra FDC ids that the catalog
  does not list are used only as fallbacks (`SUPPLEMENTAL_FDC_RULES`, all checked against the real
  Oct 2026 files): carbs by summation 1050, fibre AOAC 2033, soluble/insoluble fibre 2035/2034,
  **Total fat (NLEA) 1085** (the only fat entry of cooking oils in Foundation), **Folate, total 1177**
  (Foundation has no DFE 1190 at all; DFE equals total folate for unfortified foods), all-cis EPA /
  DPA / DHA / arachidonic 2023 / 2024 / 2025 / 2022 (identical to 1278 / 1280 / 1272 / 1271 wherever
  both exist, twice the coverage), sugar alcohols 1086, biotin 1176, chromium 1096, molybdenum 1102.
  Frequent ids that are deliberately **not** mapped because they are not the same quantity: 1002
  Nitrogen, 2016 / 2018 (PUFA 18:2 c / 18:3 c, up to 30 % off linoleic / ALA), 2068 "Vitamin E"
  (not alpha-tocopherol), 1104 Vitamin A in IU, 1187 food folate, the individual SFA / MUFA / PUFA /
  TFA fatty acids and tocopherol / tocotrienol isomers. The report lists the most frequent unmapped
  source nutrients per dataset. For CSV, `nutrient.csv` is checked against the catalog at import
  time; unconvertible units and missing ids are warnings.
* **Units** come from `nutrient.csv` `unit_name` and are converted to the catalog unit
  (g/mg/ug, kJ -> kcal). Anything that cannot be converted is skipped and counted.
  Vitamin D IU (1110) -> ug at 40 IU = 1 ug **only if** D in ug (1114) is missing.
* **Energy** fallback: 1008 kcal -> 2048 Atwater specific -> 2047 Atwater general ->
  1062 kJ / 4.184 -> computed from the macros (`estimateEnergyKcal` from core; needs
  at least two of protein/fat/carbs, or a single one >= 90 g per 100 g - a pure oil). The report shows which step supplied how many foods.
* Negative or non-numeric amounts are dropped, with one exception: **carbohydrate by difference**
  between -1 g and 0 (raw chicken, pork, tuna in Foundation: -0.06 .. -0.7 g, because it is
  100 - water - protein - fat - ash) is stored as 0 and counted in the report. Values are rounded
  to **4 significant digits**. An explicit 0 stays 0.
* **Computed nutrients are not stored** (`NET_CARBS_G`, `OMEGA3_G`, `OMEGA6_G`): core
  marks them `computed` and derives them at read time with `deriveNutrients()`, because
  net carbs depend on the user's setting. `carb_basis` is `includes_fiber` for all rows
  (FDC and CNF carbohydrate "by difference"). `completeness` is core's `completeness()`.
* **Portions**: one row per `food_portion` (`label` like `1 cup, chopped`, `amount`,
  `unit`, `grams`, `sort_order` by `seq_num`). `grams` is the mass of one serving *as
  labelled* (`8 fl oz` -> 244 g; FDC `gram_weight` semantics), not per single unit. Unit
  "undetermined", numeric FNDDS modifier codes, "Quantity not specified" style rows and
  `grams <= 0` are dropped; Foundation's `portionDescription` ("shredded") is used as the qualifier
  of a real unit ("1 cup, shredded"); the regulatory unit `RACC` is shown as "1 serving (RACC)";
  a `100 g` portion is always appended last.
  CNF: label = `MEASURE NAME.MeasureDescription`, grams = `ConversionFactorValue x 100`
  (the data dictionary defines it as a multiplier of 100 g; `auto` also detects files
  that store grams directly).
* **Names and categories**: description trimmed, whitespace collapsed, control chars
  removed. Category from `food_category` (Foundation/SR), the WWEIA category (FNDDS) or
  the CNF food group. `source_id` is `fdc_id` (FDC) or `FoodID` (CNF), as text.
* **Quality filters** (counted per reason in the report): no name, no energy after the
  fallback chain, protein+fat+carbs > 110 g per 100 g (or one macro > 101 g), energy
  > 1000 kcal per 100 g, category "Quality Control Materials".

## Idempotent re-runs

Writes are `INSERT ... ON CONFLICT (source, source_id) WHERE source_id IS NOT NULL AND
owner_id IS NULL DO UPDATE` - the partial unique index `foods_global_source_uidx` of the
foods migration (a unit test compares the text with the migration). One transaction per
500 foods; a failing batch is rolled back and reported.

* Re-running changes nothing and writes nothing: unchanged rows are skipped by a
  `WHERE ... IS DISTINCT FROM EXCLUDED` (no dead tuples on the 500 MB plan); portions are
  replaced (delete + insert) only for foods whose portions differ.
* Foods already used by a diary entry or recipe keep their `nutrients`, `completeness` and
  `carb_basis` (the trigger `foods_protect_referenced` would reject the update); name and
  category are still refreshed. To correct such a food on purpose, use
  `public.supersede_food()` from SQL.
* Foods that disappear from a newer release are **not** deleted.

## Size and licences

The final report sums JSON sizes into an estimate (heap + search columns + GIN indexes +
portions). Measured on the real files in a Postgres with the project migrations (PGlite): the 8,192
Foundation + SR Legacy foods and 23,007 portions occupy **19.4 MB** including all indexes; the
report's estimate for the same data is 20.9 MB. Expect about **2.4 KB per food**: Foundation (399
foods) 0.6 MB, SR Legacy (7,793) ~19 MB, FNDDS (~5.4k) ~13-16 MB, CNF (~5.7k) ~12-15 MB -
**about 45-55 MB for all four**, on top of the ~50 MB an empty Supabase project already uses. The
report prints a WARNING when the projected database passes ~300 MB (free tier limit is 500 MB). Use
`--dry-run` for the numbers; with a connection it also prints `pg_database_size` before and after.

Attribution (show in the app's **About / Data sources** screen):

* **USDA FoodData Central** - public domain (CC0 1.0). Cite: *U.S. Department of
  Agriculture, Agricultural Research Service. FoodData Central. fdc.nal.usda.gov.*
* **Canadian Nutrient File** - *Contains information licensed under the Open Government
  Licence - Canada* (https://open.canada.ca/en/open-government-licence-canada), source:
  Health Canada, Canadian Nutrient File, 2015.

## Development

```sh
pnpm --filter @cal/importer test        # vitest, no network, no database
pnpm --filter @cal/importer typecheck
```

Tests use tiny inline fixtures (`src/fixtures.ts`), a hand-built zip and a fake `pg`
client (`src/test-utils.ts`), plus trimmed REAL excerpts in `src/fixtures/real/` (3 Foundation foods
from the JSON release, 3 SR Legacy foods in the CSV layout; ~100 KB). Layout: `csv.ts`
(streaming/encodings), `source.ts` (zip / dir / .json), `mapping.ts` (rules, units, energy),
`portions.ts`, `quality.ts`, `fdc.ts` (CSV), `fdcJson.ts` (JSON + streaming splitter), `load.ts`
(format auto-detection), `cnf.ts`, `db.ts` (SQL + writer), `report.ts`, `download.ts`, `run.ts`,
`cli.ts`.

Known gaps: UK CoFID; Foundation records without any energy / macro data (about 6 % of the file:
raw grapefruit, blackberries, raisins, salt, ...) are dropped - SR Legacy covers most of them;
foods removed upstream are not archived; `density_g_per_ml` is not
derived from volume portions; the CNF column layout is implemented from the published
data dictionary and has not been run against the real download.
