# AI and privacy

All AI features are **optional** and use **your own [OpenRouter](https://openrouter.ai) account**. With no key, the app has
no AI screens at all: they are hidden, not greyed out.

The full privacy policy of the app (what is stored, which third parties, Garmin) is in [privacy-policy.md](privacy-policy.md).

## When AI is on

AI turns on only when all three are true: a key exists on this device, the key was checked with OpenRouter (`GET /key`), and
the selected model **accepts images**. If the check fails because you are offline, AI stays hidden and retries when you come back
to the app.

## Connecting

Open **More > AI (optional)**.

- **Connect with OpenRouter**: on the web this opens OpenRouter's sign-in and returns a key for this app. On phones it shows a
  code that you copy and paste back. OpenRouter documents redirects only for `https` addresses on specific ports, so the
  web button may be refused on a local dev server (port 8081); hosted over HTTPS it should work. This has not been tested yet.
- **Paste an API key**: always works. Create a key at [openrouter.ai/keys](https://openrouter.ai/keys) and **give it a spend
  limit**; you pay for usage with your own OpenRouter credits.
- **Model**: pick from the list of image-capable models (price per million tokens, structured-output badge, free badge). A
  sensible default is chosen for you. Models with strict structured output give the most reliable results.

## Where things are stored

| Data | Where | Notes |
| --- | --- | --- |
| OpenRouter key | **Only on your device**: iOS Keychain / Android Keystore, or on the web an encrypted entry in the browser (switch off *Remember on this device* to keep it in memory only) | Never sent to our database, never logged. Disconnect removes it. |
| Meal and label photos | Nowhere | Resized on the phone (about 1024 px for meals, 1600 px for labels, whose print is small), sent to OpenRouter for the one request, then discarded. Not uploaded to Supabase. |
| Coach chats | Your Supabase project | Deleted automatically after **90 days**. Turn that off or press *Delete all coach chats now* in **More > AI**. |
| Food logged from AI | Your diary | Entries are marked as AI-sourced with a confidence value. |

Everything the AI does goes **directly from your device to OpenRouter**, and from there to the model provider you chose; read
their privacy terms. OpenRouter lets you restrict providers in your account settings.

## What is sent

- **Photo log**: the resized photo and a short instruction, plus your optional note.
- **Scan nutrition label**: the resized photo of the label and a short instruction, like the photo log. Nothing else is sent.
- **Describe a meal / AI recipe**: the text you typed.
- **Coach**: your message, **the whole conversation so far** (as many of the earlier messages as fit, about 40 messages), and a
  compact summary of your data, rebuilt on every message. The summary starts with *findings* the app computed from your logs
  (for example "protein averages 92 g/day, 1.1 g/kg, 61% of your target") and then lists the numbers behind them:
  - **About you**: sex, age, height, activity level, targets and goal (target weight, planned rate).
  - **Food**: calories, protein, carbs, fat, fiber, sodium and logged water per day for the last 14 days, the nutrients that are
    furthest below their target or above their limit (names, average amounts, percentages), and today so far.
  - **Body**: weigh-ins of the last 6 weeks and the weight trend.
  - **Activity**: steps, active calories and workouts (name or type, duration, calories, average and maximum heart rate when
    known) of the last 4 weeks, from any connected source, including Garmin when it is connected (what your phone read from Garmin
    and saved to your account).
  - **Recovery**: sleep duration and sleep score, overnight HRV and resting heart rate of the last 2 to 4 weeks.
  - **One workout in detail**: when you ask the coach about a workout (from the Workouts screens), and for "how was my last
    workout?", a description of that workout: heart rate and time in heart-rate zones, distance, pace, training effect, strength
    sets, and your previous workouts of the same type. In this description a Garmin workout is named by its type, not by the
    title Garmin gave it.

  **Not sent**: your name, your e-mail address, the text of your diary notes, stress, body battery, blood oxygen, breathing rate,
  blood pressure, passwords, tokens and your OpenRouter key. How this is built and how to change it: [The coach](coach.md).

## How meals are estimated

The AI only **names foods and guesses weights**. The nutrients come from this app's food database, so the numbers are as good
as the match. The review screen shows each match, lets you swap it, edit grams and see a confidence label before anything is
saved. Foods the database cannot match get a model estimate, saved as an **AI estimate** and badged as such everywhere.
Portion sizes are the main source of error, so always check them.

## Scan nutrition label

Photograph (or pick a photo of) the Nutrition Facts panel of a packaged product. A vision model reads the numbers printed on it
through your own OpenRouter key, and the normal **New food** form opens with everything it read. You check and edit the values
and press **Save food**; nothing is saved automatically, and the photo is not kept.

Where it is: the top of the **New food** form, the **+** sheet, and the "product not found" card of the barcode scanner (the barcode
you scanned is carried into the new food). Like every AI feature it is hidden when the AI gate is closed.

- The model only **transcribes** what is printed. It must not estimate or fill in anything that is missing, so a missing line stays
  empty ("unknown"), never 0. Percent daily values are ignored.
- The app converts what the label prints into the units it stores: kJ to kcal (divided by 4.184) when kcal is missing, salt to sodium
  (salt divided by 2.5) when there is no sodium line, g / mg / µg into the catalog unit, vitamin D from IU. A per-serving label
  stays per serving (with the serving's grams) in the form, which works out the values per 100 g itself. A label per 100 ml is stored
  per 100 g with a density of 1 g/ml. Whatever the app converted or assumed is listed in the banner above the form.
- Values the model was unsure about, and values that do not add up (sugars above carbohydrate, energy that does not fit protein,
  carbohydrate and fat, ...), get an orange **?** marker until you edit them. The carbohydrate switch ("Total carbs include fiber")
  is set from the label layout and an energy check; if neither can tell, it keeps the app default and is marked.

## The coach

A personal coach for **food and nutrition, supplements, training, recovery and sleep, body composition and your own logged data**.
It answers diet questions directly and with numbers: macros and calories, deficits and surpluses, micronutrients, supplements and
their usual doses (for example magnesium bisglycinate vs oxide, creatine, vitamin D, caffeine), meal ideas, hydration. It scales
amounts to your weight and targets, quotes your own data, ends with a few concrete next steps, and says what it cannot see instead of
guessing. At most one short caution when it really matters (kidney disease, an interacting medicine, going over an upper limit);
no "ask your doctor" instead of an answer. It will not help with anything unrelated (code, trivia, politics, writing and so on),
cannot be talked out of that by instructions in your messages or in your diary notes, and does not diagnose or tell you to
change a prescription.

Before the coach model sees a message, a quick classifier sorts it (it also sees the last few messages, so "how was it?" is understood):

- *On topic*: answered, then the answer is checked for danger and drift.
- *Off topic*: a polite redirect, without calling the coach model.
- *Medical red flag* (urgent symptoms, a suspected overdose, self-harm, requests to diagnose or to change a prescription or insulin dose):
  a short "please get care" message.
- *Possible eating-disorder risk* (crash diets of about 1,000 kcal and below, long fasts to lose weight, purging, laxatives): a supportive
  message that points to professional help.

If the classifier call itself fails, the message is not answered (it fails closed). The permanent note under the input box says
the coach is not a substitute for a professional; the answers do not repeat it. A set of about 200 test prompts for tuning this
lives in `packages/ai/eval`; running it needs your key:

```bash
OPENROUTER_API_KEY=... node --import tsx packages/ai/eval/run-guard-eval.ts
```

Chats are stored in your Supabase project and deleted after 90 days (see above). A chat about a workout stores only the kind and id
of that workout next to the chat.

## Troubleshooting

| You see | Meaning |
| --- | --- |
| No AI rows in the **+** sheet | The gate is closed: no key, invalid key, or the model does not accept images. Open **More > AI**. |
| "Credits exhausted" | Add credits at openrouter.ai/credits, or choose a cheaper or free model. |
| "Key invalid" | The key was revoked or mistyped. Reconnect. |
| Rate limited | Free models have strict daily limits. Wait, or switch model. |
| Request blocked (moderation) | The provider refused the content. Try another model. |
| Result looks wrong | Check the matched food and the grams on the review screen; AI estimates can be wrong. |
| "No nutrition label was found" | The photo did not show a readable nutrition table. Take it straight on, close, in good light, with the whole table in view. |
