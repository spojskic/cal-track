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
- **Coach**: your message, the recent conversation, and a compact summary of your data: sex, age, height, activity level,
  targets and goals, calorie and macro totals for the last 14 days, weight trend, and steps, active calories, workouts and sleep
  duration of the last 14 days (from any connected source, including Garmin when it is connected). Heart rate, stress, body battery,
  HRV and the text of diary notes are not sent. No name or email address.

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

A personal coach for **nutrition, training, recovery and sleep, body composition and your own logged data**. It will not help
with anything else (code, trivia, politics, writing and so on), cannot be talked out of that by instructions in your messages or
in your diary notes, and does not diagnose or prescribe.

Before the coach model sees a message, a quick classifier sorts it:

- *On topic*: answered, then the answer is checked against the same rules.
- *Off topic*: a polite redirect, without calling the coach model.
- *Medical red flag*: a short "please see a doctor or emergency services" message.
- *Possible eating-disorder risk*: a supportive message that points to professional help.

If the classifier call itself fails, the message is not answered (it fails closed). The coach is not medical advice. A set of
more than 150 test prompts for tuning this lives in `packages/ai/eval`; running it needs your key:

```bash
OPENROUTER_API_KEY=... node --import tsx packages/ai/eval/run-guard-eval.ts
```

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
