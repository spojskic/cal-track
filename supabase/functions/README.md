# supabase/functions/

Edge Functions (Deno) that fetch branded foods from outside the app. Everything runs
on the Supabase **free** plan.

| function         | purpose                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `barcode-lookup` | barcode -> food. Local DB first, then USDA FDC Branded, then Open Food Facts; remote hits are saved globally. |
| `online-search`  | text search in FDC Branded + Open Food Facts. Returns summaries only (nothing is saved).                      |

```
functions/
  _shared/                       pure TypeScript, NO Deno globals, unit-tested in Vitest
    gtin.ts                      normalise / validate GTIN (GS1 check digit)
    fdc-branded.ts               FDC Branded JSON -> product (per 100 g)
    off-product.ts               Open Food Facts JSON -> product (per 100 g)
    food-row.ts                  product -> foods row + portions (rounding, completeness)
    barcode-lookup.ts            orchestration of barcode-lookup (all I/O injected)
    online-search.ts             orchestration of online-search (all I/O injected)
    food-store.ts                tiny Supabase adapters (local lookup, upsert RPC)
    rate-limit.ts                client of public.consume_rate_limit()
    http.ts                      CORS, JSON helpers, JWT claims, upstream fetch
    nutrient-map.generated.ts    GENERATED from packages/core (see below)
  barcode-lookup/index.ts        thin Deno.serve wiring
  online-search/index.ts         thin Deno.serve wiring
```

Edge code cannot import workspace packages (`@cal/core`), hence the generated nutrient map.
Imports inside `_shared/` use relative paths **with** the `.ts` extension (Deno requires it).

## Database objects they need

Apply the migrations first (`npx supabase db push`):

- `20261110000011_edge_rate_limit.sql`: `private.edge_rate_limits` + `public.consume_rate_limit()` (used by `online-search`).
- `20261110000012_upsert_branded_food.sql`: `public.upsert_branded_food()` (used by `barcode-lookup`).

Both functions are executable by `service_role` only.

## Secrets

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase.
Set the rest:

```bash
npx supabase secrets set FDC_API_KEY=<key from https://fdc.nal.usda.gov/api-key-signup> \
                         OFF_USER_AGENT="cal-track/0.1 (you@example.com)"
# optional overrides of the online-search throttle (defaults: 5 per user / 8 global per minute)
npx supabase secrets set ONLINE_SEARCH_USER_PER_MINUTE=5 ONLINE_SEARCH_GLOBAL_PER_MINUTE=8
```

- `FDC_API_KEY`: without it FDC is skipped and only Open Food Facts is used. FDC allows 1000 requests/hour per key.
- `OFF_USER_AGENT`: Open Food Facts **requires** an identifying User-Agent (`AppName/version (contact)`).
  Default `cal-track/0.1 (contact not configured)`; set a real contact before relying on it.
- Never commit secrets. For local runs put them in an untracked env file:
  `npx supabase functions serve --env-file supabase/functions/.env`.

## Deploy

```bash
npx supabase functions deploy barcode-lookup online-search
```

`verify_jwt = true` is set for both in `config.toml`. **Do not deploy with `--no-verify-jwt`**: the
functions read the caller from the JWT claims and rely on the gateway to have verified the signature
(they additionally refuse the project's anon key, which is also a valid JWT). If the project moves to
asymmetric JWT signing keys and the gateway check starts failing, verify in the function instead
(`supabase.auth.getClaims()`), do not just switch the check off.

## Contract

All requests are `POST` with `Authorization: Bearer <user access token>` and a JSON body, e.g. with
supabase-js `supabase.functions.invoke('barcode-lookup', { body: { gtin } })`. CORS is open (`*`) and
`OPTIONS` preflight is answered. Every error has the shape
`{ "error": "<code>", "message": "<human text>", ...extra }`.

### `barcode-lookup`

Request: `{ "gtin": "4006381333931" }`. The GTIN is a string of 1-14 digits (UPC-A, EAN-13, EAN-8,
GTIN-14, ...); it is left-padded to GTIN-14 (`foods.gtin14`). A wrong GS1 check digit is accepted but
flagged in `warning`.

Response `200`:

```jsonc
{
  "source": "local" | "fdc_branded" | "off",   // where THIS answer came from; "local" = already in our DB
  "warning": "invalid_check_digit",            // optional; also "nonstandard_length"
  "food": {                                    // the public.foods row (without search columns)
    "id": "uuid", "source": "off", "source_id": "4006381333931", "kind": "branded", "owner_id": null,
    "name": "Dark chocolate", "brand": "Choco", "gtin14": "04006381333931", "category": "Chocolate",
    "nutrients": { "ENERGY_KCAL": 560, "PROTEIN_G": 7, "SODIUM_MG": 20 },   // per 100 g, catalog units
    "completeness": 0.0645, "carb_basis": "excludes_fiber", "density_g_per_ml": null,
    "popularity": 0, "version": 1, "supersedes": null, "archived": false,
    "created_at": "...", "updated_at": "..."
  },
  "portions": [
    { "id": "uuid", "label": "100 g", "amount": 100, "unit": "g", "grams": 100, "sort_order": 0 },
    { "id": "uuid", "label": "1 serving (25 g)", "amount": 1, "unit": "serving", "grams": 25, "sort_order": 1 }
  ]
}
```

Errors:

| status  | `error`                                    | meaning / extra fields                                                                   |
| ------- | ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 400     | `invalid_json`                             | body is not JSON                                                                         |
| 400     | `invalid_gtin`                             | missing / non-string / non-digit / > 14 digits / all zeros                               |
| 401     | `unauthorized`                             | no signed-in user token                                                                  |
| 404     | `not_found`                                | `gtin14`, optional `warning`; neither FDC nor OFF knows the barcode                      |
| 405/413 | `method_not_allowed` / `payload_too_large` |                                                                                          |
| 422     | `unusable_product`                         | found, but no usable nutrition data after cleaning (rare)                                |
| 429     | `rate_limited`                             | `retryAfterSeconds`, `upstream: "off" \| "fdc"`; also sent as `Retry-After` header       |
| 500     | `save_failed` / `internal_error`           | the product was found but could not be stored / unexpected error                         |
| 502     | `upstream_error`                           | `upstream: "off" \| "fdc"`; the source was unreachable, so "not found" cannot be claimed |

Order of work: user-scoped `get_food_by_gtin` (RLS) -> FDC Branded search (accepted only when the
item's `gtinUpc` normalises to the same GTIN-14; newest `modifiedDate`/`publishedDate` wins) -> Open
Food Facts (at most **one** request per call). A remote hit is saved as a global `branded` food
(`source` `fdc_branded` / `off`, `source_id` = FDC id / OFF code) with the service role through
`upsert_branded_food`, so the next lookup (by anyone) is a local hit. If a food is already stored and
referenced by diary entries or recipes, changed nutrients create a new version (`supersede_food`)
instead of rewriting history.

### `online-search`

Request: `{ "query": "greek yogurt", "limit": 10 }`; `query` 2-100 chars, `limit` optional (default
10, max 20, larger values are clamped).

Response `200`:

```jsonc
{
  "query": "greek yogurt",
  "results": [
    {
      "gtin14": "00036000291452",
      "name": "Greek Yogurt",
      "brand": "Fage",
      "source": "fdc_branded",
      "kcal100g": 59,
      "protein100g": 10,
      "carbs100g": 4,
      "fat100g": 0.4,
      "completeness": 0.0645,
    },
  ],
  "warnings": [{ "source": "off", "error": "rate_limited" }], // only when one source failed
}
```

Results of both sources are interleaved and de-duplicated by `gtin14` (the more complete record wins);
items without a barcode or without nutrition data are dropped. **Nothing is saved**: when the user
picks a result, call `barcode-lookup` with its `gtin14`.

Errors: `400 invalid_json | invalid_request | invalid_query`, `401 unauthorized`,
`429 rate_limited` (`retryAfterSeconds`, `scope: "user" | "global"` for our own throttle; without
`scope` when both upstreams are rate limiting), `502 upstream_error` (both sources failed), `500 internal_error`.

#### Throttle

Open Food Facts allows roughly 10 search requests per minute **per IP**, and every user shares the
function's egress IP. `online-search` therefore consumes two Postgres-backed counters before calling
upstream: 5 searches/minute per user and 8/minute across all users (override with the secrets above).
The counter is `private.edge_rate_limits` (fixed window), consumed by `public.consume_rate_limit()`, which only
`service_role` can call. An in-memory limiter was rejected: isolates are short-lived and run as many instances.
The limiter fails closed (a database error is a 500).

## Free plan notes

- 500,000 function invocations/month; per request roughly 2 s CPU time (waiting on `fetch` is not CPU
  time), 150 s wall clock and 256 MB memory (limits as documented by Supabase at the time of writing;
  check the current numbers). A personal app is nowhere near these.
- Each upstream request has an 8 s timeout. `barcode-lookup` does 1 DB read + up to 2 outbound
  requests (FDC, OFF) + 1 DB write on a miss, and only 1 DB read + 1 portions read on a hit.
- Cold starts add a few hundred ms; the app should show a spinner and let the user retry on 429/502.

## Attribution (must be shown in the app)

- **Open Food Facts** data is licensed under the Open Database Licence (ODbL), with individual contents
  under the Database Contents Licence. Wherever OFF-sourced data is shown (`source: "off"`, search results
  from OFF) display **"Data from Open Food Facts"** with a link to <https://world.openfoodfacts.org> and the
  licence (<https://opendatacommons.org/licenses/odbl/1-0/>). Foods saved from OFF form a derived
  database; keep that in mind before ever publishing a dump of `foods` (share-alike).
- **USDA FoodData Central** is public domain (CC0), but please cite it: _U.S. Department of Agriculture,
  Agricultural Research Service. FoodData Central, 2019. https://fdc.nal.usda.gov._
- Branded values are label data supplied by manufacturers; show them as such.

## Mapping notes

- Nutrients are stored per 100 g in catalog units (`kcal`, `g`, `mg`, `ug`); an absent key means unknown.
- FDC: ids from the catalog (`fdcId`, `fdcAltIds`), energy order 1008 -> 2048 -> 2047 -> kJ 1062 / 4.184,
  vitamin D IU (1110) / 40; `carb_basis` is always `includes_fiber` (US labels).
- OFF: `*_100g` values are grams (mg x1000, ug x1e6); energy-kcal, else kJ / 4.184; sodium, else salt / 2.5;
  `nutrition_data_per: "serving"` is rescaled with `serving_quantity` or skipped without it;
  `carb_basis` is `includes_fiber` only when the product is sold in the US or Canada, otherwise
  `excludes_fiber` (EU labels exclude fibre from "carbohydrate"). It is a heuristic and can be wrong for imports.
- Implausible values are dropped (negative, > 100 g per 100 g, > 1000 kcal per 100 g). Values are rounded to
  4 significant digits. `ml` servings are treated as 1 g/ml (`density_g_per_ml = 1`), because both sources
  publish their per-100 values without a density.

## Regenerate the nutrient map

After changing `packages/core/src/nutrients.ts`:

```bash
node --import tsx packages/core/scripts/generate-edge-nutrient-map.ts          # rewrite
node --import tsx packages/core/scripts/generate-edge-nutrient-map.ts --check  # exit 1 when stale
```

A db-tests test fails when the committed file is stale.

## Tests

```bash
source ~/.nvm/nvm.sh && nvm use 22
pnpm --filter @cal/db-tests test          # includes tools/db-tests/src/edge-*.test.ts
```

The `_shared` modules are tested in Vitest with injected fakes (`fetch`, Supabase clients); the
`upsert_branded_food` and `consume_rate_limit` functions are tested against the real migrations in PGlite.
Not covered: the Deno runtime itself, the two `index.ts` files, and real FDC / OFF responses.
