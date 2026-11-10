# Garmin: everything you have to do

Your personal checklist for the one-tap **Connect Garmin** button. The code is finished and ships switched off; what is left is
paperwork with Garmin and a few settings. Background: [garmin-integration.md](garmin-integration.md) (how it works, secrets, the
18 assumptions to confirm), [garmin-application.md](garmin-application.md) (answers for Garmin's form),
[privacy-policy.md](privacy-policy.md) (text to publish).

Your project reference `<PROJECT-REF>` is the first part of `EXPO_PUBLIC_SUPABASE_URL` in `apps/app/.env`
(`https://<PROJECT-REF>.supabase.co`). Never paste secret values into a chat or commit them.

## A. Before you apply (about 30 minutes)

1. **Fill in the privacy policy.** In [privacy-policy.md](privacy-policy.md) replace `[YOUR NAME]` and `[YOUR EMAIL]` (they appear
   in "Who this is for", "Your choices and rights" and "Contact"). Nothing else needs editing. If you later turn on the nightly
   backups workflow, or online food search, or host the web app publicly, add the matching sentences back (see the bottom of this file).
2. **Fill in the application answers.** In [garmin-application.md](garmin-application.md) replace `[YOUR NAME]`, `[YOUR EMAIL]`,
   `[APP URL]`, `[PRIVACY POLICY URL]` and `[COUNTRY]`.
3. **Publish the privacy policy at a public web address.** You do not need your own domain.
   - **GitHub Pages (free):** create a small **public** repository, for example `cal-track-privacy`. Add the text of
     `privacy-policy.md` as `index.md`, with these three lines at the very top (Jekyll only renders Markdown that starts with them):

     ```
     ---
     title: Cal Track privacy policy
     ---
     ```

     Optionally add a short "About Cal Track" paragraph: you can use the same page as `[APP URL]`.
     Then **Settings > Pages > Deploy from a branch > main > / (root)**. The address will be
     `https://<your-github-name>.github.io/cal-track-privacy/`. Use it for `[PRIVACY POLICY URL]` (and `[APP URL]`).
   - **Netlify Drop:** `npx marked -i docs/privacy-policy.md -o index.html`, drag `index.html` onto app.netlify.com/drop, rename the
     site. Cloudflare Pages or any static host works the same.
4. **Take two screenshots**, because Garmin may ask for them. Set `EXPO_PUBLIC_GARMIN_ENABLED=true` in `apps/app/.env`, run
   `pnpm web`, open **Settings > Connected Apps & Devices** and capture the Garmin card. Set the flag back to `false` afterwards:
   the button must not appear (or must not work) before Garmin has approved the app.
5. **Submit Garmin's form:** <https://www.garmin.com/en-US/forms/StarterGarminConnectDeveloperAccess/>. Paste the answers from
   `garmin-application.md` field by field. Only you, the account holder, can submit it.
6. **Wait for the approval email.** Reported to be quick for the free Starter tier, but not confirmed.

## B. After Garmin approves

7. **Create the app** in Garmin's developer portal. Write down the **client ID** and **client secret** and keep them private.
8. **Enable the data types:** daily summaries, activities, sleep, HRV, stress details, body composition. Choose **push** delivery, not ping.
9. **Download Garmin's Health API specification** (and the OAuth page) from the portal and give it to me (paste the relevant
   parts into the chat or save it into the repo). I will check my 18 assumptions against it (the token address and the field
   names of the pushed data are guesses until then) and adjust the functions. Do not skip this step.
10. **Set the secrets** (never commit them; the `$(...)` creates a random webhook secret, write it down for step 12):

    ```bash
    npx supabase secrets set GARMIN_CLIENT_ID=... GARMIN_CLIENT_SECRET=... \
      GARMIN_WEBHOOK_SECRET="$(openssl rand -hex 24)" \
      APP_URL=<address of your hosted web app, or http://localhost:8081 while testing>
    ```

11. **Deploy the four functions:**

    ```bash
    npx supabase functions deploy garmin-oauth-start garmin-oauth-callback garmin-webhook garmin-disconnect --use-api
    ```

12. **Fill in the portal URLs:**

    | Portal field | Value |
    | --- | --- |
    | OAuth redirect / callback URL | `https://<PROJECT-REF>.supabase.co/functions/v1/garmin-oauth-callback` |
    | Push endpoint, for **every** enabled data type | `https://<PROJECT-REF>.supabase.co/functions/v1/garmin-webhook?secret=<your GARMIN_WEBHOOK_SECRET>` |
    | Deregistration endpoint | the same webhook address |

13. **Turn the button on:** set `EXPO_PUBLIC_GARMIN_ENABLED=true` in `apps/app/.env` and restart `pnpm web` (rebuild phone apps: the
    flag is baked in at build time).
14. **Connect once yourself:** Settings > Connected Apps & Devices > **Connect Garmin**, sign in at Garmin, allow.
15. **Sync your watch** with the Garmin Connect app. Data arrives from the moment you connected; there is no history import.
16. **Check it arrived** (Supabase **SQL Editor**):

    ```sql
    select kind, count(*), max(received_at) as last, count(*) filter (where error is not null) as with_error
    from private.garmin_push_events group by kind order by last desc;

    select local_date, active_kcal, resting_kcal, steps from public.daily_energy
    where source = 'garmin' order by local_date desc limit 7;
    ```

    If a row has an `error`, send me the message and `select jsonb_pretty(payload) from private.garmin_push_events order by id desc limit 3;`.
    A different field name than I assumed is a quick fix.

## C. Decisions already made

- The AI coach **may** include Garmin steps, active calories, workouts and sleep duration (sent to your own OpenRouter account).
  The privacy policy and the application text say so. To change it later, exclude `source = 'garmin'` rows in
  `apps/app/src/data/coach.ts` and edit those two documents.
- When Garmin reports that a user removed the app, their imported Garmin data is deleted (`GARMIN_DELETE_DATA_ON_DEREGISTER=false`
  keeps it). The in-app **Disconnect** lets the user choose.

## D. Add back to the privacy policy if you later switch these on

- **Nightly backups** (`.github/workflows/db-backup.yml`): "a nightly encrypted backup is kept for 30 days; a deletion leaves the
  backups after at most 30 more days", and GitHub as a handler in the table.
- **Online food search / barcode lookup** (`EXPO_PUBLIC_ONLINE_LOOKUP_ENABLED=true`): a section saying the barcode number or search
  words go to a Cal Track function, which asks USDA FoodData Central and Open Food Facts (they get the words and the server's
  address, not your name, email or account), and that found products are saved in the shared food list without any link to you.
- **A public web app:** the hosting provider as a handler (standard access logs).
