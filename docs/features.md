# Features

A tour of the app by area, followed by what is **not** built yet. "Needs a device" means the code is written but has not
been run on real hardware.

## Onboarding and targets

A short wizard on first sign-in: units, sex, birthdate, height, weight (optional body fat), activity level, goal, and macro
style. It ends with a live breakdown of your numbers.

- **Energy target** = BMR + baseline activity, adjusted for your weight goal (about 7,700 kcal per kg of body weight).
  The activity level can be *None (watch only)*: nothing is added for everyday movement, so with a watch connected and the
  Device-adjusted mode, everything the watch records counts and your budget starts at the resting burn (a lower floor on days
  without watch data).
  BMR formulas: Mifflin-St Jeor (default), Katch-McArdle and Cunningham (need body fat), Harris-Benedict, or a number you type.
  Goals show a warning above a safe rate (about 1% of body weight per week) and a calorie floor (1,500 men / 1,200 women).
  The floor is a minimum for the day, not a bonus: when your plan is below it (for example BMR 1,835, no baseline, losing 0.5 kg per
  week = 1,285) the target is 1,500, and what you burn above your baseline first fills that 215 kcal gap before it widens the day's
  budget. The energy bars show what you ate against that budget (the target plus what burning added), so they move through the day.
- **Macros**: ratios (e.g. 30/40/30), fixed grams, protein per kg, or a keto mode with fixed net carbs. Net carbs are optional
  and respect each food's label convention (US labels include fibre in carbs, EU labels do not).
- **Nutrient targets**: vitamins, minerals, fibre and more, chosen by age, sex and pregnancy/lactation from published intake
  tables (RDA/AI, with upper limits). Every value can be overridden or reset in **More > Nutrient targets**.
  The tables were written from memory and have not been cross-checked against the official sources yet.
- **Thermic effect of food** (10% of intake) can be switched on or off. It counts in the Expenditure circle and in the Balance
  view, and your energy target allows for it (the plan is divided by 0.9), so eating the target leaves exactly the deficit
  you chose instead of a larger one.
- **Energy mode** (Profile & targets): *Static* (baseline activity only, ignores your watch), *Device-adjusted*
  (your watch activity replaces the baseline during the day and workouts are added) and *Device total* (your
  watch's active + resting calories only). The baseline is your starting allowance for the day: tracker activity replaces it
  one for one, and every hour of exercise, logged by hand or recorded by a watch, takes one sixteenth of it. Connecting a
  watch or health app moves a Static profile to Device-adjusted once.
- **Energy summary 3rd circle**: *Target* or *Balance*, also switched by tapping the label under the circle (see Diary).

## Diary

One page per day with prev/next navigation.

- **Meal groups** (Breakfast, Lunch, Dinner, Snacks) with calorie totals. Tap an entry to change the amount or portion, move
  it to another meal, or delete it. Copy a meal or whole day from another date.
- **Summary**: macro bars, an energy summary with *Consumed / Expenditure / third* rings, and a target card you can swipe on
  phones. The third circle is *Remaining* or *Over* in the **Target** view (your target plus what you burned above your
  baseline, minus what you ate) and *Deficit* or *Surplus* in the **Balance** view (burned minus eaten, whatever your goal).
  Tap its label to switch; the choice is remembered. Tap the Expenditure circle to see its parts: BMR, adjusted baseline
  activity, tracker activity (with a watch), exercise and thermic effect of food.
- **Nutrient targets** section: a nutrition score, highlighted nutrients (fibre, iron, calcium, vitamins A/C/B12, folate,
  potassium) and every nutrient grouped by type (vitamins, minerals, amino acids, ...). Bars are grey below target, green in range and red above an upper
  limit. A dash means "unknown", never zero.
- **Also on the page**: exercise, water, notes, and a *Devices* group for data imported from your watch.

The **+** button opens one sheet for everything you can add: search food, scan barcode, photo log, describe meal and scan nutrition label
(when AI is on), custom food, exercise, biometric, note, water.

## Foods

- **Search** is accent-insensitive and typo-tolerant, so "cevapi" finds "Ćevapi". It works **in place on the Foods tab**: the search
  field at the top of the tab is a real input (phone and desktop). Type two characters or more and the results appear right below
  it, in the place of the library list (the Favorites / Recent / ... chips step aside); clear the field with its **x** (or Escape on
  a keyboard) and the library comes back. Tap a result to open the food, or its **+** to add one serving to the default meal of the
  selected day (a line above the results says which). *Search online (branded products)* and *Create custom food* are under the
  results. On an empty Favorites or Recent list the *Search foods* button puts the cursor in the field.
  The **Add food** screen (the *Add to diary* button, the **+** buttons, the dashboard quick actions) is the dedicated flow for
  adding: the same search, plus the meal chips ("Adding to Snacks · Today"), the tabs All, Recent, Favorites, My foods and the **...**
  menu for the other ways to add.
  Results are a flat list: name, brand and kcal per 100 g, with the source (Custom Food, Custom Recipe, USDA, ...) at the right.
  Results are ranked by your own history first, then by data quality (USDA Foundation and SR Legacy first, then survey foods,
  then branded products).
- **Food page**: choose an amount and unit (household portions from the data, grams, ounces), see the full nutrient panel for
  that serving with progress against your targets, and add it to the day. A completeness note tells you how many nutrients the
  food actually has data for.
- **Custom foods**: any name (Bosnian and English both work), serving sizes, a full nutrient form, optional barcode.
- **Barcode scan** and **Search online**: look in your database first, then USDA branded foods and Open Food Facts through the
  edge functions, and cache what you use. Needs the functions deployed; the camera needs a device or HTTPS. The scanner opens
  from the barcode button next to the search field (also when you add an ingredient to a recipe), from the Foods tab and from
  the **+** sheet; *Flash* switches the torch on and *Type barcode* lets you enter the digits. A QR code that holds a product
  number (or a GS1 link) is looked up too; any other QR code only shows "That QR code is not a food barcode".
- **Recipes**: ingredients with grams, number of servings and a *final cooked weight* (cooked dishes weigh less than their raw
  ingredients). Logged as "1 serving", "full recipe" or by grams. Editing a recipe you already logged creates a new version, so
  old days keep their numbers.
- **Saved meals**: save a meal group as a template and add it to any day in one tap.

## Activity and body

- **Exercise**: pick from more than 100 activities (calories from MET values and your weight, always editable) or enter a custom one.
- **Biometrics**: weight, body fat, blood pressure, heart rate, glucose, ketones, waist, or your own type. Weight feeds your targets.
- **Water** quick buttons, **notes**, and a **dashboard** with today's summary, a 7-day average, your logging streak and a
  30-day weight trend.

## Desktop navigation (the sidebar and the status bar)

On a window of 900 px or more the bottom tab bar is replaced by a **sidebar** at the left and a thin **status bar** at the bottom. They stay
on every screen (settings, workouts, the coach, search, a food or recipe page, the add sheet), so you never have to go back to a menu. The
sign-in screen, the first-run wizard and the barcode camera are drawn without them. Phones are unchanged: bottom tab bar, the raised **+**
button and the More tab.

- **Sidebar**, top to bottom: the **Ration** mark; the **Add to diary** button (opens the add sheet); then small labelled groups, each
  with a chevron that collapses it (the groups you close stay closed the next time you open the app on this device):
  **Daily** (Dashboard, Diary, Foods), **Training** (Workouts), **Coach** (Coach when AI is on; AI Coach & keys, or AI (optional),
  with a small *On* / *Off* at the right), **Profile** (Profile & targets, Personal details, Nutrient targets, Friends), **Connections** (Connected
  apps & devices) and **App** (Display & units, About), plus **Admin** (Invite people) for the super admin only. These are the rows of the
  phone's More tab; there is no *More* item. The row of
  the page you are on is highlighted (for a workout's page that is Workouts; for a food's page, Foods).
- **Calendar** (last group, closed at first): a month with Monday first, today ringed and the diary date filled in. The arrows page between
  months, **Today** jumps back, and a day makes it the diary date and opens the diary.
- **Account** (pinned at the bottom of the sidebar, always visible): the e-mail you are signed in with and **Sign out**.
- **Status bar**: at the left when your data last synced (*Syncing...*, *Synced 12 min ago*, *Synced today at 14:32*, *Synced on Oct 20*,
  or *Not synced* when no connected app or watch has synced); at the right *AI: on* or *AI: off*, the name of the colour theme and
  the app version.
- **Page header**: a page that is not a tab (settings, workouts, ...) shows a slim strip with the title, the name of its parent in
  muted type ("Settings > Display & units"), a small back button when there is somewhere to go back to, and its actions at the right.

## Desktop layouts (Dashboard, Diary, Foods on a window of 900 px or more)

Beside the sidebar the three tab pages use the whole window instead of a narrow centred column (content up to 1440 px wide, 20 px
around it, 12 px between panels). Each page starts with a slim header strip (title, a muted subtitle or date, actions at the right) and
fills the rest with bordered **panels**: a small title strip (title at the left, a muted note or a link at the right) over the content.
Phones keep their single column; nothing on the phone changes.

- **Dashboard**: the header shows today's date and the quick-add buttons *Food*, *Exercise*, *Biometric* and *Note* (same names as the
  phone tiles: "Add food", ...). A **KPI strip** of six cells follows: *Consumed* (with a 14-day sparkline), *Remaining* / *Over* /
  *Deficit* / *Surplus* (follows the Target / Balance switch), *Protein*, *Carbs* (or *Net Carbs*), *Fat* (each with "of target" and
  a thin progress strip) and *Logging streak* (the last seven days as markers). Under it the panels sit in 3 columns from a content
  width of ~1120 px (a 1440 px window), 2 from ~760 px, 1 below: **Today** (the three energy rings, the macro bars as label / bar /
  value columns, *Open diary*), **Consumed average** (7d / 14d / 30d, the daily bars and the protein / carbs / fat shares), **Weight
  trend** (latest weight, the 30-day change, the chart and start / lowest / highest / weigh-ins, *Log weight*), **Recent workouts**
  (the latest five, *All workouts*), **Nutrition score** and **Highlighted nutrients**. With a working AI key a slim **Coach** panel
  with *Open coach* closes the page. Panels of one row have the same height and the last row always fills the width.
- **Diary**: the header carries the date controls (previous / next day, the date with *Today*, **+** and **...**). Two panes: the
  **Entries** panel at the left (about 58 %, at least 520 px) with the Food / Exercise / Biometric / Note tabs, the device activity
  group, the meals and water, rows exactly as on the phone; at the right **Targets** (macro bars, *Edit* opens the target settings),
  **Energy summary** (rings, the Target / Balance label, macro split) and **Nutrient targets** (score and highlighted nutrients).
  Below both panes the nutrient tables (General, Carbohydrates, Lipids, Protein, Vitamins, Minerals) are panels in a grid; click a
  title strip to collapse a group. Under 900 px of content the panes stack.
- **Foods**: the **Food library** panel (search field, scan button, the chips Favorites / Recent / My foods / Recipes / Saved meals and
  the list, which scrolls inside the panel) with a narrow column at the right: **Create** (*Create food*, *Create recipe*, *New saved
  meal*) and a few lines of help. On a narrower window the create actions move to the page header. Typing two characters or more in the
  search field puts the results in the same list area (the chips step aside, the panel says "N results"); clearing the field brings
  the library back.

## More (the menu tab)

Everything that is not a daily screen, in small labelled groups (a muted label above a card of rows, each row with an icon, its name
and a one-line description, and a chevron):

| Group | Rows |
|---|---|
| **Training** | Workouts |
| **Coach** | Coach (only with a working AI key), AI Coach & keys / AI (optional), with a small *On* / *Off* at the right |
| **Profile** | Profile & targets, Personal details, Nutrient targets, Friends (with the number of requests waiting) |
| **Connections** | Connected apps & devices |
| **App** | Display & units (colour theme, light or dark mode, rounded or boxy corners, units), About |
| **Admin** | Invite people (only for the super admin, see below) |
| **Account** | The e-mail you are signed in with and **Sign out** |

On a phone the groups follow one another in that order. A desktop window (900 px or more) has **no More page**: the same groups
(Training, Coach, Profile, Connections, App, and Admin for the super admin) are in the sidebar and the account sits at its bottom (see [Desktop navigation](#desktop-navigation-the-sidebar-and-the-status-bar)),
so an old link to `/more` just opens the dashboard. The paths in this documentation (for example **More > Profile & targets**) name the
row, not the group; on a desktop it is the row of that name in the sidebar.

## Friends (More > Friends)

Simple on purpose: friends share their **custom foods and recipes**, and nothing else.

- **Add a friend**: type the e-mail address of somebody who uses Ration and tap *Send request*. The screen says "If ... uses Ration, they
  will see it": an address without an account gets the same answer (the request just never appears for anybody; it is not listed under
  *Waiting for an answer*). A request to a real account also arrives by **e-mail** ("... wants to be your friend on Ration"; through
  Resend, see [supabase/functions/README.md](../supabase/functions/README.md)). Asking somebody who already asked you makes you friends at
  once. At most 20 requests a day.
- **Requests**: the person you asked sees a count on the **More** tab of the phone (a red number), on the **Friends** row (*2 requests*) and in
  the desktop sidebar; open Friends and tap **Accept** or **Decline** (a decline just removes the request). There is no push message: the
  count appears when the app is opened or comes back to the foreground, and once a minute while it is open.
- **Waiting for an answer** lists your own requests with **Cancel**. **Friends** lists everybody with the day you became friends and **Remove**
  (it asks first). Either side can end a friendship.
- **What is shared**: while you are friends each of you sees the other's custom foods and recipes. They are in **Foods > My foods** and
  **Foods > Recipes** after your own (marked "from Anna"), in the search results and on the Add food screen, and you can log them, favourite
  them, save them in a meal or use them as an ingredient. They are read-only: only the owner can change or delete them. Your diary, weight,
  targets, saved meals, AI estimates and profile are never shared.
- **Ending a friendship** hides the foods you did not use. Anything you already used stays: a food you logged, favourited, saved in a meal or
  put in one of your recipes remains visible to you, so your diary never shows holes. A friend's recipe you logged shows its nutrition but
  not its ingredient list any more.

## Invite people (More > Admin, super admin only)

Accounts are invite-only. One person, the app owner, is the **super admin**: a single yes/no flag (`is_admin`) on their profile that only
the SQL editor can set (see [Getting started](getting-started.md#invite-people-from-the-app-super-admin)). Only that account has the
**Admin** group in More (a phone) or the sidebar (a wide window), with **Invite people**:

- **Create an invite code**: the person's **E-mail** (required and checked; the code is stored with it), *Number of uses* (how many
  accounts it can create, usually 1) and how long it is valid (7, 14, 30 days or no expiry). The code is created AND sent: the person
  gets an **e-mail with the code and the link** (through Resend; see [supabase/functions/README.md](../supabase/functions/README.md)). The
  new code is also shown large with **Copy code** and **Copy message** (a sentence that tells the person to tap Create account and enter
  the code) — the fallback for an e-mail that did not go out, and the screen says which of the two happened.
- **Active codes**: the codes that can still be used, each with the e-mail it was made for, *Not used yet* or *1 of 3 used*, when it
  expires and the day it was made; **Copy** and **Revoke** (after a confirmation; people who already signed up with it keep their
  account). Codes made before the e-mail field existed show their old note instead.
- **Closed codes** (used up, expired, revoked) behind a Show button, with their status.
- **Paging**: each list shows 20 codes a page, newest first, with **Previous** / **Next** and "1-20 of 137"; the server cuts the pages, so
  thousands of codes load as fast as a few.

Everybody else does not see the group, and if they open the page by its address it says that only the app owner can invite people.
The database enforces this, not the screen: the three functions behind it answer *permission denied* to anyone without the flag, and a
client cannot set the flag on its own profile. **Not built yet:** sending the invitation by e-mail from the app (see below).

## Workouts (More > Workouts)

Every exercise entry in one list, newest first, grouped by this week, last week and month; manual or imported from Garmin, Apple Health
or Health Connect. Rows show type, date and time, duration, calories, source and (when a device recorded it) the average heart rate;
filter by source and type, 50 load at a time, pull to refresh. The More entry needs no AI key.

Open one for the details, only what exists: distance, pace or speed, climb, average / max / lowest heart rate, **time in each heart-rate
zone** (a bar with minutes per zone), Garmin's training effect and, for strength sessions, the **sets** per exercise ("Bench press: 4 x 8
@ 60 kg, 4 x 6 @ 70 kg"; Garmin guesses the exercise, a weight shows only if you typed it into Garmin Connect). Device workouts are
read-only; a manual one can be deleted. With an AI key, **Discuss with coach** opens the coach on that workout, together with these
details, your previous workouts of the same type and what is not known.

The details are saved on the workout (`exercise_entries.details`), so they open instantly and offline: a Garmin sync stores the heart
rate, zones and training effect the activity list already carries; opening a Garmin workout reads the rest (zone limits, sets, laps)
when it has none yet or they are over a day old on a workout under a week old; after a sync the 3 newest are read quietly. Garmin is
only read with GET, one request at a time, never together with a sync, and "slow down" pauses everything. **Copy sync report** lists
these detail calls too (no values).

## Apple Health and Health Connect (needs a device)

Imports daily active and resting calories, steps, workouts, weight, body fat, resting heart rate, HRV, SpO2, respiration, blood
pressure and sleep, each behind its own switch, with a backfill date. Daily totals use the platform's own de-duplicating
queries so an iPhone, a watch and Garmin are not counted twice. Watch workouts are shown for information and cancel any
overlapping manual exercise. Setup: [install on devices](install-on-devices.md#turning-on-health-sync).

## Garmin (read-only, from the phone)

Settings > Connected Apps & Devices > **Garmin** > **Connect Garmin**: you sign in on Garmin's own page inside the app (Ration
never sees your password; the token Garmin issues stays in the phone's secure storage), and the phone then reads your Garmin data
and saves it to your account. Nothing is written to Garmin.

- **Imported:** daily active and resting calories, steps, resting heart rate, stress, body battery, sleep (hours, stages, score),
  HRV, weight, body fat and workouts. Connecting reads the last 14 days; later syncs (on opening the app, in the background, **Sync
  now**) re-read the last few days, and a day's totals are replaced, never added up. With Apple Health / Health Connect also on, the
  Garmin numbers of a day win and a workout or night is listed once.
- **iPhone and Android app only** (a browser cannot read Garmin); it needs a build that contains the web view.
- **Unofficial.** It uses the same undocumented interface as Garmin's own mobile app, so it can stop working when Garmin changes it;
  an expired session asks you to sign in again.
- **Copy sync report** (on the Garmin card): plain text of the last sync (which requests worked, how many days came back, which fields
  were found or missing; no values, no tokens) to paste back when a number is missing. **Sign out** keeps or deletes the imported data.

## Themes (Settings > Display & units > Appearance)

Colour themes you switch in the app.

- **Mode**: *Match system* follows the light or dark setting of your device (it switches by itself when the device does), *Light*
  and *Dark* pin the app to that side.
- **Corners**: *Boxy* (the default) or *Rounded* (the original look). Boxy gives the whole app sharp, small corners:
  cards and sheets 6 px, buttons, fields, chips and segmented controls 4 px, small badges and highlights 3 px, bars 2 px, and the round
  buttons (back, "+", the tab bar button) become rounded squares. Nothing is pill-shaped. Tiny status dots (the legend dots of the
  charts) and radio buttons stay round, because a square one would read as a checkbox. It applies at once to every screen, and the
  palette previews below follow it.
- **Light palette** and **Dark palette**: one pick for each side, shown as small previews (the card with the check mark is the one in
  use). Mode decides which side is on screen; both picks are remembered. **Reset to default** shows up when your choice differs from the
  defaults (also when only the corners differ) and brings back Match system, Kanagawa Lotus (light), Kanagawa Wave (dark) and Boxy
  corners.
- **Light:** Kanagawa Lotus (default), Catppuccin Latte, Solarized Light, Gruvbox Light, GitHub Light, Rosé Pine Dawn, Tokyo Night Day,
  One Light, Paper, Ration Day.
  **Dark:** Kanagawa Wave (default), Kanagawa Dragon, Tokyo Night, Catppuccin Mocha, Dracula, Nord, Gruvbox Dark, Rosé Pine, One Dark,
  GitHub Dark, Solarized Dark, Ration Night. *Ration Day* and *Night* are the original navy and orange look.
- **Saved on this device only**, not in your account, so your phone and your browser can use different themes (and corners). Nothing to
  set up in Supabase. A theme saved before the Boxy switch existed simply opens with the default (Boxy) corners; pick Rounded to keep the old look.
- **Readable by construction:** every palette is checked in the tests for text, muted text, button labels and the red, green and amber
  status colours against the page, cards and sidebar (WCAG contrast). A few theme colours were nudged a little darker or lighter to pass;
  they are marked `nudged` in `apps/app/src/theme/palettes-light.ts` and `palettes-dark.ts`.
- **Limits:** the splash screen and the app icon background are drawn by the phone before the app starts, so they stay the Kanagawa
  Wave page colour whatever you pick. Needs a device: how the themes and the Boxy corners look on real iOS and Android screens has not
  been checked.

## AI (optional, your own key)

Appears only after you connect an OpenRouter key *and* pick a model that accepts images. Photo log, describe-a-meal, scan nutrition
label (photograph a label and review a pre-filled New food form), AI recipe drafts and the coach are covered in
[AI and privacy](ai-and-privacy.md).

## Not built yet

- Trends and reports page, CSV export
- Fasting timer
- "Mark day complete" and swiping between days
- UK CoFID food import
- Writing your nutrition back to Apple Health / Health Connect
- Over-the-air app updates
