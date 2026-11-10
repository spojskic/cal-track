# Cal Track privacy policy

Last updated: 10 November 2026

## Who this is for

Cal Track is a private nutrition and activity tracker (web, iOS and Android). It is run by [YOUR NAME] as a personal,
non-commercial project for the operator and a small number of invited friends. There is no public sign-up: accounts are created
by invitation. Questions, requests and complaints go to [YOUR EMAIL].

In short: your data is used to run the app for you and for nothing else. It is not sold, not shared for advertising, and the app
contains no advertising, analytics or tracking tools.

## What Cal Track stores about you

Everything below is stored in your own account in a database hosted by Supabase and can only be read by
you (each account is separated by row-level security) and by the operator, who administers the service.

- **Account:** your email address and a password (stored only as a hash by Supabase's sign-in service), plus the usual sign-in
  records that service keeps (times and technical logs).
- **Profile and goals:** name or nickname, sex, birth date, height, units, time zone, activity level, calorie and nutrient
  targets, weight goal and preferences.
- **Food diary:** what you eat and when, meal groups, water, notes, your own foods, recipes, saved meals and favourites.
- **Body and activity data:** weight and other measurements you enter, exercise you log, and the data imported from your devices
  if you connect them (Apple Health, Health Connect or Garmin, see below).
- **AI coach chats**, if you use the coach: the conversation text. These are deleted automatically after 90 days unless you switch
  that off, and you can delete all of them at any time in the app.

Meal photos you take for the optional photo log, and photos of a nutrition label you take for "Scan nutrition label", are **not** stored by Cal Track.

## What stays on your device

- Your **OpenRouter key** (only if you use the optional AI features). It is kept in the iOS Keychain or Android Keystore, or in an
  encrypted entry of your browser on the web. It is never sent to Cal Track's database or servers and never logged.
- Your **Garmin token** (only if you connect Garmin). It is kept in the iOS Keychain or Android Keystore, this device only, and is
  never sent to Cal Track's database or servers.
- A **cached copy** of recently used diary data, so the app opens quickly and offline, and your sign-in session.
- On the web these live in your browser's local storage. Cal Track does not use advertising or tracking cookies.

## Optional AI features (your own OpenRouter key)

AI features exist only if you connect your own [OpenRouter](https://openrouter.ai) account. Requests go **directly from your
device to OpenRouter** (and from there to the model provider you picked); Cal Track's servers do not see them. Read OpenRouter's
and the provider's terms; you can restrict providers in your OpenRouter settings. What is sent, and only when you use that feature:

- **Photo log:** the meal photo, resized on your phone, and a short instruction (and your optional note).
- **Scan nutrition label:** the photo of the label, resized on your phone, and a short instruction. What the AI reads from it only
  fills in the "New food" form on your phone; you check and edit it, and nothing is saved until you press Save food.
- **Describe a meal / AI recipe:** the text you typed.
- **Coach:** your message, the conversation so far, and a compact summary of your data, rebuilt on every message: sex, age, height,
  activity level, your targets and goal; calories, macros, fiber, sodium and logged water per day of the last 14 days, and the
  vitamins and minerals that are furthest below or above their targets; your weigh-ins and weight trend; steps, active calories and
  workouts of the last 4 weeks (with duration, calories and heart rate when known); sleep duration and score, overnight HRV and
  resting heart rate; and, when you ask about a workout, a description of that workout (heart rate and zones, distance, pace,
  training effect, sets). **If you have connected Garmin, the steps, active calories, workouts and their details, sleep, HRV and
  resting heart rate that came from Garmin can be part of this summary.** Stress, body battery, blood oxygen, breathing rate, blood
  pressure, your email address, your name and the text of your diary notes are **not** included.

Nothing is sent to OpenRouter unless you use one of these features.

## Barcode scans and online food search

When you scan a barcode or choose "search online", the app sends the barcode number or the words you typed to a Cal Track
server function (signed in as you). That function asks **Open Food Facts** and, where configured, **USDA FoodData Central**
for the product. They receive the barcode or search words and the server's network address; they do **not** receive your
name, email, account id or your own network address. A product found this way is saved in the shared food list (product data
only, not linked to you), so the next lookup does not need to ask again. Data from Open Food Facts is under the Open Database
Licence.

## Garmin (optional, read by your phone)

Cal Track can read your Garmin data if you choose **Connect Garmin** in Settings > Connected Apps & Devices (iPhone and Android app
only). It does this in your phone: there is no Cal Track server in between, and Garmin sends nothing to Cal Track's servers.

- **You sign in on Garmin's own page.** The sign-in page of Garmin opens inside the app. Cal Track **never sees your Garmin
  password**. Garmin hands the app a token, and only that token is kept.
- **The token stays in your phone's secure storage** (the iOS Keychain or the Android Keystore, this device only). It is never sent
  to Cal Track's database or servers, never logged, and not part of a backup.
- **Your phone reads your Garmin data directly from Garmin** and then saves it to your Cal Track account, like the rest of
  your data. It uses the same private interface that Garmin's own mobile app uses; Cal Track is not an official Garmin
  integration. Garmin sees the requests as coming from your phone and your Garmin account.
- **Nothing is ever written to Garmin.** The app only reads.
- **What is read:** daily summaries (steps, active and resting calories, resting heart rate, average stress, body battery),
  workouts (type, start, duration, calories), sleep (duration, stages, sleep score, and overnight blood oxygen and breathing rate when
  available), weight and body fat measurements, and the overnight heart rate variability average. Connecting reads the last 14 days;
  afterwards the app re-reads the last few days when you open it, in the background from time to time, and when you tap Sync now.
- **What it is used for:** showing your Garmin numbers in your diary and, if you choose a device energy mode, working out your
  daily calorie budget. Nothing else.
- **Where the data is stored:** in your account, visible only to you (and the operator, who administers the service).
- **Never** sold, shared, used for advertising or used to profile you. The one optional exception is described under
  "Optional AI features": if **you** use the AI coach, the Garmin-sourced numbers listed there can be sent to your own OpenRouter
  account.
- **Signing out (Disconnect):** Cal Track deletes the Garmin token from your phone and stops reading. You can choose to delete the
  Garmin data already imported as well; otherwise it stays in your diary until you delete it. Signing out does not end the
  session on Garmin's side; you can do that in your Garmin account settings. If Garmin ends the session itself, the app asks you to sign in again.

## Apple Health and Health Connect (optional)

If you switch it on, the app reads the data types you select (for example calories, steps, workouts, weight, sleep) from Apple
Health or Health Connect on your phone and stores them in your account. It reads only what you allow in the system permission
dialog, and does not write to your health data. Disconnecting stops the import; what was already imported stays until you delete it.

## Who else handles data

| Who | What and why |
| --- | --- |
| **Supabase** | hosts the database, sign-in and the server functions |
| **Open Food Facts, USDA FoodData Central** | product lookups, as described above |
| **Garmin** | only if you connect it: your phone reads your own Garmin data from Garmin (you sign in on Garmin's page); Garmin sends nothing to Cal Track's servers |
| **OpenRouter and the model provider you choose** | only if you use AI features, as described above |

No other third party receives your data, and Cal Track does not sell or rent it.

## How long data is kept

- Your data stays until you delete it or ask for your account to be deleted.
- AI coach chats: 90 days (automatic, can be switched off), or sooner when you delete them.
- Garmin token: on your phone only, until you sign out of Garmin in the app, Garmin ends the session, or you uninstall the app
  (on an iPhone the Keychain can keep an item after an uninstall: sign out in the app first if you want it gone).

## Security

Connections use TLS. Each account can only reach its own rows. Your Garmin token and your OpenRouter key stay in the secure
storage of your device and are never stored on Cal Track's servers. No system is
perfectly secure, but the app is built to collect as little as possible and to keep it separated.

## Your choices and rights

- **See and correct** your data in the app: diary, profile, measurements and exercise can be viewed and edited.
- **Delete** single entries in the app; delete all coach chats and switch off their automatic deletion in More > AI; disconnect
  Garmin (optionally with its imported data) or the health sync.
- **Delete your whole account** with everything linked to it (diary, health and Garmin data, coach chats): email [YOUR EMAIL]
  and it will be done within 30 days. There is no button for it in the app yet.
- **Get a copy** of your data: email [YOUR EMAIL]. There is no export button in the app yet.
- Depending on where you live you may have further rights (for example to object or to complain to a data protection authority).
  Ask and they will be respected.

## Children

Cal Track is not meant for people under 16 and is not offered to them.

## Changes

If this policy changes in a way that matters, the "Last updated" date changes, and users of the app are told before a new kind of
data is collected.

## Contact

[YOUR NAME], [YOUR EMAIL]
