# Garmin application: ready-to-paste answers

For Garmin's **Starter / Startup access request** (free tier of the Garmin Connect Developer Program, OAuth2 + push):
<https://www.garmin.com/en-US/forms/StarterGarminConnectDeveloperAccess/>

How to use this page: open the form, copy the answer that matches each field, and replace everything in square brackets
(`[YOUR NAME]`, `[YOUR EMAIL]`, `[APP URL]`, `[PRIVACY POLICY URL]`, `[COUNTRY]`). The field names on the form may differ a little;
every section below stands on its own. Everything stated here is true of the code in this repository, nothing is promised that
does not exist. Do not paste this first block.

Before you submit:

- Publish the privacy policy ([privacy-policy.md](privacy-policy.md), hosting tips at the top of that file) and use its address as
  `[PRIVACY POLICY URL]`. `[APP URL]` is any public page that describes the app: the same GitHub/Netlify page works if you add a
  short "About Cal Track" paragraph.
- Garmin may also ask for screenshots or a short walkthrough. The screen they care about is **Settings > Connected Apps & Devices >
  Garmin Connect** (build the app with `EXPO_PUBLIC_GARMIN_ENABLED=true` locally to take screenshots; the button says "Connect
  Garmin" and a note says data arrives from the moment of connecting).
- The retention answer mentions encrypted nightly backups kept for 30 days: that is true only while you run the backup workflow
  (`.github/workflows/db-backup.yml`); delete the sentence if you do not.
- One point you must decide (see "Data sharing"): the optional AI coach can include Garmin-sourced steps, active calories,
  workouts and sleep duration in what it sends to **your own** OpenRouter account. The answer below discloses this. If you would
  rather answer "no Garmin data ever leaves our servers", the Garmin rows have to be excluded from the coach summary first
  (a small change in `apps/app/src/data/coach.ts`).

---

## Contact

| Field | Answer |
| --- | --- |
| Name | [YOUR NAME] |
| Email | [YOUR EMAIL] |
| Organisation | Individual developer (no company) |
| Country | [COUNTRY] |
| Website / app page | [APP URL] |
| Privacy policy URL | [PRIVACY POLICY URL] |

## Application name

Cal Track

## Short description (one paragraph)

Cal Track is a private nutrition tracker for web, iOS and Android, similar in spirit to Cronometer. It logs what a person eats,
works out calorie and nutrient targets, and can show how much energy they burned. With the user's consent, it receives their
Garmin daily summaries, workouts, sleep and body measurements so that a user can compare energy in (food) with energy out
(calories burned, steps, heart rate, sleep, stress, body battery) in one place. It is a non-commercial, invitation-only project for
the developer and a small circle of friends.

## Short description (about 300 characters, if the field is small)

Cal Track is a private, non-commercial nutrition tracker. With consent it shows a user's Garmin calories burned, steps, heart
rate, sleep, stress and body battery next to what they eat, so they can compare energy in and energy out. Invitation-only,
under 20 users, no ads, no data sharing.

## Use case (long answer)

Cal Track lets a person log meals (food database, barcode scanning, recipes) and see calories, macronutrients and about 90
nutrients against personal targets. A person's daily calorie budget can optionally be based on what their watch measured.

A Garmin user connects their account once with a single "Connect Garmin" button (OAuth2 authorization code with PKCE). From then
on, whenever the watch syncs with Garmin Connect, Garmin pushes that user's data to our HTTPS webhook and Cal Track shows it in the
user's diary next to their food log:

- **Energy out:** active and resting calories and steps of the day, and workouts. With the user's setting "device energy", the
  day's calorie budget is adjusted by the calories actually burned instead of an estimate.
- **Context for eating:** sleep duration and score, resting heart rate, average stress and body battery (and overnight HRV),
  displayed read-only so the person can see how recovery and intake relate.
- **Body measurements:** weight and body fat, which feed the person's calorie target.

Cal Track does not give medical advice, does not provide social features, does not rank or compare users, and does not publish any
Garmin data. The data is shown only to the user it belongs to.

## Platforms and distribution

Web app, iOS app and Android app (one Expo / React Native code base). Distribution is private (invitation-only accounts; the apps
are installed directly by the invited users, not through public app stores). There is no public sign-up.

## Number of users

Fewer than 20 users initially (the developer and invited friends). The service is designed for at most a few dozen and will stay
far below the Starter tier limits.

## Which APIs and data types we need

Garmin Connect Developer Program: **Health API** (push) and **Activity API** (push). Minimal on purpose: we do not request
activity details, FIT/GPX files, epochs, GPS tracks, blood pressure, menstrual cycle, skin temperature, VO2 max or any training /
course API.

| Data type | Fields we use | What for | Needed? |
| --- | --- | --- | --- |
| Daily summaries (Health API) | steps, active kilocalories, resting (BMR) kilocalories, resting heart rate, average stress level, body battery (charged / drained / high) | calories burned vs eaten, steps, recovery context | **Required** (energy in vs out) |
| Activity summaries (Activity API) | activity id, type, name, start time, duration, calories | list workouts in the diary, avoid double counting with manually logged exercise | **Required** |
| Sleep (Health API) | sleep duration, deep / light / REM / awake time, sleep score, average overnight blood oxygen and respiration | sleep next to nutrition | **Required** |
| Body composition (Health API) | weight, body fat %, BMI, muscle / bone mass, body water if provided | weight feeds the calorie target | Optional |
| HRV summary (Health API) | last night's average (and 5-minute high) | recovery context | Optional, display only |
| Stress details (Health API) | body battery levels during the day (high, low, latest) | body battery display | Optional, display only |

All values are used for display in the user's own diary; only the energy figures and weight enter a calculation (the calorie
budget). If Garmin prefers a smaller scope, the app works with daily summaries, activity summaries and sleep only; HRV, stress
details and body composition can be switched off.

We also ask for **deregistration notifications** (and permission-change notifications if offered), so a user who removes
Cal Track in their Garmin account is disconnected and their data is deleted.

## How the integration works (technical summary)

- Authorization: OAuth2 authorization code flow with PKCE (S256) and a single-use `state`. The user signs in and consents on
  Garmin's page. Redirect URL: `<SUPABASE_URL>/functions/v1/garmin-oauth-callback` (HTTPS).
- Data delivery: **push** over HTTPS to one webhook per data type (`<SUPABASE_URL>/functions/v1/garmin-webhook`), authenticated with
  a long random shared secret. We acknowledge each push with HTTP 200 within a second or two. Pushes are matched to our user by the Garmin
  user id; pushes for unknown ids are discarded.
- Idempotent processing: repeated or out-of-order pushes for the same day cannot create duplicates or add values twice.
- No history is requested or imported: only data pushed after the user connects.
- Deregistration: handled through Garmin's deregistration notification and through the in-app "Disconnect" button (which also
  asks Garmin to remove the registration).
- Hosting: Supabase (PostgreSQL, serverless functions), TLS everywhere.

## Data storage and retention

- Garmin data is stored in the user's own account (a PostgreSQL database hosted by Supabase), keyed by user, in the same tables
  as other health data the user logs themselves.
- Retention: until the user deletes it. When a user disconnects, Cal Track deletes the link and the Garmin tokens
  immediately and offers to delete the imported Garmin data at the same time. When Garmin reports a deregistration, the link, the
  tokens, the raw messages and the imported Garmin data are deleted.
- The raw push messages (kept only so a failed import can be replayed) are deleted after 14 days. Encrypted nightly backups of
  the database are kept 30 days (they never contain Garmin tokens).
- A user can ask for complete account deletion at any time by email; it is carried out within 30 days.

## Security measures

- OAuth tokens are stored only on the server, in a database schema that is not exposed through any API and with no access for
  app users (service role only). They are never sent to the app and never logged.
- All traffic uses TLS. The webhook requires a long random secret compared in constant time; wrong secrets are rejected and
  rate limited.
- Every user can read only their own rows (row-level security), enforced and tested in the database.
- Accounts are invitation-only with password sign-in; secrets (client secret, webhook secret) live only in server-side secret
  storage, never in the app or the repository.
- Garmin data is not sold, not shared with other users, not used for advertising, profiling or research, and not used to train
  models.
- Users can disconnect at any time and delete their Garmin data in the app.

## Data sharing and use limits

Garmin data is used only to show it to the user it belongs to and to compute that user's calorie budget. It is not given to any
third party. One optional feature must be disclosed: the app has an AI "coach" that works only if the user connects **their own**
OpenRouter account. When that user chats with it, a compact summary of their recent data (including, if they have connected
Garmin, their Garmin-sourced steps, active calories, workouts and sleep duration; not heart rate, stress, body battery, HRV or
blood oxygen) is sent directly from their device to that account's model provider. Nothing is sent unless the user starts a chat;
the user can switch the AI features off by never connecting a key or by disconnecting it. [If you exclude Garmin from the coach
summary before submitting, delete this paragraph's second half and say that Garmin data never leaves the account.]

## Business model

Non-commercial hobby project. No payments, no subscriptions, no advertising, no data sales.

## Why a direct Garmin connection (if asked)

Apple Health and Health Connect only receive a subset of what Garmin records. A direct connection gives the user their Garmin
sleep score, body battery, stress and the day's exact calories, and it works the same on web, iOS and Android.

## Anything else (if asked)

Privacy policy: [PRIVACY POLICY URL]. Support and data requests: [YOUR EMAIL]. The app clearly states that Garmin only sends data
from the moment of connection and that nothing is imported for earlier days.

---

## After you submit: what to expect and what to do

Nothing below happens automatically; the technical details are in [garmin-integration.md](garmin-integration.md).

1. **Wait for Garmin's reply** (the Starter tier is described as quick, but timing is not guaranteed). They may ask for
   screenshots, the privacy policy or more detail about the data you request. Answer with the text above.
2. **On approval** you get access to the developer portal: documentation (Health API, Activity API, OAuth2), a **client id** and
   **client secret**, and the place to register endpoints.
3. **Read the specs against the assumptions** listed in "TO CONFIRM AGAINST GARMIN'S DOCS AFTER APPROVAL" in
   [garmin-integration.md](garmin-integration.md) (authorize/token/user-id/deregistration URLs, how pushes name the user, field names,
   how pushes are authenticated). Most items are a function secret or a one-line change.
4. **Deploy** (if not done already): `npx supabase db push` and `npx supabase functions deploy garmin-oauth-start
   garmin-oauth-callback garmin-webhook garmin-disconnect`.
5. **Set the secrets**: `GARMIN_CLIENT_ID`, `GARMIN_CLIENT_SECRET`, `GARMIN_WEBHOOK_SECRET` (a random string of at least 16
   characters), `APP_URL` (for the web app).
6. **Fill in the portal**: redirect URL `<SUPABASE_URL>/functions/v1/garmin-oauth-callback`; the push endpoint
   `<SUPABASE_URL>/functions/v1/garmin-webhook?secret=<GARMIN_WEBHOOK_SECRET>` for every data type you enabled; the same URL for
   deregistration; delivery mode **push**.
7. **Try it yourself first**: build with `EXPO_PUBLIC_GARMIN_ENABLED=true`, tap Connect Garmin, sync your watch, then check
   `private.garmin_push_events` in the Supabase SQL editor (queries in the technical doc). Fix field names if rows are missing.
8. **Add Garmin's required branding** (logo / attribution) if their brand guidelines ask for it; the card has none yet.
9. **Invite your friends** to connect; keep an eye on `last_error` in the card and on the push events table for the first days.
10. If Garmin asks you to re-confirm the privacy policy or data practices later, keep [privacy-policy.md](privacy-policy.md) in
    sync with the code.
