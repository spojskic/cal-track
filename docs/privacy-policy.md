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

Meal photos you take for the optional photo log are **not** stored by Cal Track.

## What stays on your device

- Your **OpenRouter key** (only if you use the optional AI features). It is kept in the iOS Keychain or Android Keystore, or in an
  encrypted entry of your browser on the web. It is never sent to Cal Track's database or servers and never logged.
- A **cached copy** of recently used diary data, so the app opens quickly and offline, and your sign-in session.
- On the web these live in your browser's local storage. Cal Track does not use advertising or tracking cookies.

## Optional AI features (your own OpenRouter key)

AI features exist only if you connect your own [OpenRouter](https://openrouter.ai) account. Requests go **directly from your
device to OpenRouter** (and from there to the model provider you picked); Cal Track's servers do not see them. Read OpenRouter's
and the provider's terms; you can restrict providers in your OpenRouter settings. What is sent, and only when you use that feature:

- **Photo log:** the meal photo, resized on your phone, and a short instruction (and your optional note).
- **Describe a meal / AI recipe:** the text you typed.
- **Coach:** your message, the recent conversation, and a compact summary of your data: sex, age, height, activity level, your
  targets and goal, calorie and macro totals of the last 14 days, weight trend, steps, active calories and workouts of the last
  14 days, and sleep duration. **If you have connected Garmin, the steps, active calories, workouts and sleep duration that
  came from Garmin can be part of this summary.** Heart rate, stress, body battery, HRV, blood oxygen, breathing rate, your
  email address, your name and the text of your diary notes are **not** included.

Nothing is sent to OpenRouter unless you use one of these features.

## Garmin Connect (optional)

Cal Track can receive your data from Garmin if you choose **Connect Garmin** in Settings > Connected Apps & Devices.

- **Consent first.** Nothing is requested from Garmin until you sign in on Garmin's own page and allow Cal Track. You can take that
  permission back at any time, in Cal Track (Disconnect) or in your Garmin account settings.
- **What Cal Track receives:** daily summaries (steps, active and resting calories, resting heart rate, average stress, body
  battery), workouts (type, start, duration, calories), sleep (duration, stages, sleep score, and overnight blood oxygen and breathing rate when
  available), weight and body fat measurements, and the overnight heart rate variability average. Garmin pushes this to Cal Track
  when your watch syncs, starting from the moment you connect; earlier days are not imported.
- **What it is used for:** showing your Garmin numbers in your diary and, if you choose a device energy mode, working out your
  daily calorie budget. Nothing else.
- **Where it is stored:** in your account, like the rest of your data, and visible only to you. Garmin's access tokens and the raw
  messages Garmin sends are kept in a protected part of the database that the app and the internet cannot read; the raw messages
  are deleted after 14 days.
- **Never** sold, shared, used for advertising or used to profile you. The one optional exception is described under
  "Optional AI features": if **you** use the AI coach, the Garmin-sourced numbers listed there can be sent to your own OpenRouter
  account.
- **Disconnecting:** Cal Track tells Garmin to end the connection and deletes the link, the tokens and the raw messages
  immediately. You can choose to delete the Garmin data already imported as well; otherwise it stays in your diary until you delete it.
  If you remove Cal Track in your Garmin account, Garmin notifies Cal Track and the link, the tokens, the raw messages and
  the imported Garmin data are deleted.

## Apple Health and Health Connect (optional)

If you switch it on, the app reads the data types you select (for example calories, steps, workouts, weight, sleep) from Apple
Health or Health Connect on your phone and stores them in your account. It reads only what you allow in the system permission
dialog, and does not write to your health data. Disconnecting stops the import; what was already imported stays until you delete it.

## Who else handles data

| Who | What and why |
| --- | --- |
| **Supabase** | hosts the database, sign-in and the server functions |
| **Garmin** | only if you connect it: sends your Garmin data to Cal Track |
| **OpenRouter and the model provider you choose** | only if you use AI features, as described above |

No other third party receives your data, and Cal Track does not sell or rent it.

## How long data is kept

- Your data stays until you delete it or ask for your account to be deleted.
- AI coach chats: 90 days (automatic, can be switched off), or sooner when you delete them.
- Raw Garmin messages: 14 days. Garmin tokens: until you disconnect or Garmin reports that you removed the app.

## Security

Connections use TLS. Each account can only reach its own rows. Garmin tokens and raw Garmin messages are not reachable from
the app at all, only by the server functions. Your OpenRouter key stays in the secure storage of your device. No system is
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
