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
- **Macros**: ratios (e.g. 30/40/30), fixed grams, protein per kg, or a keto mode with fixed net carbs. Net carbs are optional
  and respect each food's label convention (US labels include fibre in carbs, EU labels do not).
- **Nutrient targets**: vitamins, minerals, fibre and more, chosen by age, sex and pregnancy/lactation from published intake
  tables (RDA/AI, with upper limits). Every value can be overridden or reset in **More > Nutrient targets**.
  The tables were written from memory and have not been cross-checked against the official sources yet.
- **Thermic effect of food** (10% of intake) can be switched on or off. It counts in the Expenditure circle and in the Balance
  view, but is never added to your Target budget.
- **Energy mode** (Profile & targets): *Static* (baseline activity only, ignores your watch), *Device-adjusted (like
  Cronometer)* (your watch activity replaces the baseline during the day and workouts are added) and *Device total* (your
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
  potassium) and every nutrient grouped as in Cronometer. Bars are grey below target, green in range and red above an upper
  limit. A dash means "unknown", never zero.
- **Also on the page**: exercise, water, notes, and a *Devices* group for data imported from your watch.

The **+** button opens one sheet for everything you can add: search food, scan barcode, photo log, describe meal and scan nutrition label
(when AI is on), custom food, exercise, biometric, note, water.

## Foods

- **Search** is accent-insensitive and typo-tolerant, so "cevapi" finds "Ćevapi". Tabs: All, Recent, Favorites, My foods.
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

## Apple Health and Health Connect (needs a device)

Imports daily active and resting calories, steps, workouts, weight, body fat, resting heart rate, HRV, SpO2, respiration, blood
pressure and sleep, each behind its own switch, with a backfill date. Daily totals use the platform's own de-duplicating
queries so an iPhone, a watch and Garmin are not counted twice. Watch workouts are shown for information and cancel any
overlapping manual exercise. Setup: [install on devices](install-on-devices.md#turning-on-health-sync).

## Garmin (read-only, from the phone)

Settings > Connected Apps & Devices > **Garmin** > **Connect Garmin**: you sign in on Garmin's own page inside the app (Cal Track
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
