# AI and privacy

All AI features are **optional** and use **your own [OpenRouter](https://openrouter.ai) account**. With no key, the app has
no AI screens at all: they are hidden, not greyed out.

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
| Meal photos | Nowhere | Resized on the phone (about 1024 px), sent to OpenRouter for the one request, then discarded. Not uploaded to Supabase. |
| Coach chats | Your Supabase project | Deleted automatically after **90 days**. Turn that off or press *Delete all coach chats now* in **More > AI**. |
| Food logged from AI | Your diary | Entries are marked as AI-sourced with a confidence value. |

Everything the AI does goes **directly from your device to OpenRouter**, and from there to the model provider you chose; read
their privacy terms. OpenRouter lets you restrict providers in your account settings.

## What is sent

- **Photo log**: the resized photo and a short instruction, plus your optional note.
- **Describe a meal / AI recipe**: the text you typed.
- **Coach**: your message, the recent conversation, and a compact summary of your data: sex, age, height, activity level,
  targets and goals, calorie and macro totals for the last 14 days, weight trend, activity, sleep, and any diary notes you wrote.
  No name or email address.

## How meals are estimated

The AI only **names foods and guesses weights**. The nutrients come from this app's food database, so the numbers are as good
as the match. The review screen shows each match, lets you swap it, edit grams and see a confidence label before anything is
saved. Foods the database cannot match get a model estimate, saved as an **AI estimate** and badged as such everywhere.
Portion sizes are the main source of error, so always check them.

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
