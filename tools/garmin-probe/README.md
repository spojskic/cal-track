# @cal/garmin-probe

A small CLI that calls every Garmin Personal API endpoint used by `@cal/garmin` for the last few days, saves what came back, and reports which fields the mappers could and could not find. Its purpose is to confirm the (currently unverified) response field names.

## 1. Create a key

Open https://connect.garmin.com/app/settings/personalApiToken, create a Personal API key (all read scopes: fitness, wellness, user, connect) and copy it. Keys start with `GCDC_`. The key is personal: do not share it and never paste it into a chat or a commit.

## 2. Run

```sh
export GARMIN_PERSONAL_API_KEY=GCDC_...      # environment only; the CLI refuses keys in arguments
pnpm --filter @cal/garmin-probe run probe -- --days 3
```

Options: `--days N` (default 3), `--out DIR` (default `tools/garmin-probe/out`, git-ignored), `--endpoints sleep,hrv,...`, `--mapped` (print the normalized output; contains your values, console only), `--cn` (China host), `--raw`, `--help`.

By default only the **structure** is written: key paths, types, array lengths and number sizes (`<int:5d>` = a 5 digit integer), with every value replaced by a placeholder. `--raw` also writes the real values: that is personal health data, a loud warning is printed, and those files must not be shared or committed.

Per-day endpoints (`sleepDay`, `hrvDay`, `heartRateDay`, `spo2Day`) are probed for the last 7 days at most. It makes about one request per endpoint plus the per-day ones; Garmin's limit is roughly 100 requests per minute and the client throttles itself.

## 3. What to share back

Send these files from the output directory (they contain no values in the default mode):

- `report.txt`: per endpoint, which fields were found (and by which JSON key) and which were not
- `structure-paths.txt` and the `*.structure.json` files: the shape of every response

Look at `report.txt` yourself first. A field marked `NOT FOUND` means none of the guessed names exists in your data; the matching `structure-paths.txt` shows what the real names are.
