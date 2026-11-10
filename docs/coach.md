# The coach

A chat with a coach that knows your logs. It answers questions about food, supplements, training, sleep and your body, and it
quotes your own numbers. It runs on **your own OpenRouter key** (see [AI and privacy](ai-and-privacy.md)); nothing is sent
anywhere else.

Design in one line, borrowed from the rules-first coach of a companion project: **code finds the facts, the model writes the
words.** The app computes *findings* from your data, each with the numbers it comes from and what was counted; the model is told to
quote them, not to recompute them, and to say what it cannot see instead of guessing.

## How a turn works

```
you type  ->  1 store your message (the thread is created on the first one)
              2 read the whole conversation from the database
              3 read fresh data from the database and compute the findings
              4 guard: a small model classifies the message (and the last turns)
              5 coach model answers, streamed        (not called when the guard refuses)
              6 audit: the guard checks the reply    (a dangerous or off-topic reply is replaced)
              7 store the reply
```

| Step | Code |
| --- | --- |
| 1, 2, 7 | `apps/app/src/ai/use-coach-chat.ts`, `apps/app/src/data/coach.ts` |
| 2 | `apps/app/src/ai/coach-history.ts` (pure) and `prepareHistory` in `packages/ai/src/coach.ts` |
| 3 | `apps/app/src/ai/use-coach-summary.ts`, `coach-summary.ts`, findings in `packages/ai/src/coach-findings.ts` |
| 4 to 6 | `runCoachTurn` in `packages/ai/src/coach.ts`, prompts in `packages/ai/src/prompts.ts` |

### The conversation

The model gets **every earlier message of the chat**, as real chat turns, oldest first. The limits are generous: 40 messages,
about 12,000 tokens, 8,000 characters per message. When a conversation is longer, the **oldest whole turns** are cut and the
first message carries one line: *"[Note: N earlier messages of this conversation are not shown here.]"*. A single over-long message
keeps its beginning and its end.

Why this section exists: the history used to be cut at 12 messages / 2,500 tokens / 2,000 characters per message (a long answer
lost its end), a message whose turn had failed or been stopped was silently dropped when the next one was sent, and the history
was taken from the screen's cache. Now it is read from the database right after your message is stored, a message without an answer
is kept (it is merged into the next one), and the coach's system prompt tells it that short follow-ups ("how was it", "and for
dinner?") refer to the previous turns. The guard sees the last six messages too.

### The data block

Every turn starts with a fresh block, wrapped in `<user_data>` (the model is told it is data, never instructions):

1. **Findings**, most important first, each as `[tone] claim [evidence] Counted: basis`.
2. **Not available**: what the app could not see ("HRV", "heart rate of workouts", "sleep: the newest night is 6 days old").
3. Date and weekday, how far each kind of data reaches, goal, profile, daily targets, averages, today so far.
4. **Nutrients against targets**: the nutrients furthest below their minimum, and the ones over their limit.
5. The rows the findings come from: 14 days of food (kcal, protein, carbs, fat, fiber, sodium, water), weight log, 14 days of
   steps / active energy / workouts (with duration, calories and heart rate when known), sleep, HRV and resting heart rate.
6. **Workout details** (below).

The block is capped at about 11,000 characters; when it is longer, the oldest rows go first, then the least important findings.

### Findings

Pure functions in `packages/ai/src/coach-findings.ts`; unit tested with hand-built weeks. A finding has a `kind`, a `tone`
(`good`, `note`, `watch`: good news is a finding too), a `priority`, a `claim` with the numbers, `evidence` and a `basis`.

| Kind | What it says | Fires when |
| --- | --- | --- |
| `logging_gap` | The food log stopped N days ago, intake numbers are not current | last log 2+ days ago |
| `no_intake_data`, `logging_coverage`, `logging_streak` | Nothing logged / logged on only N of 14 days / N days in a row | |
| `calories_vs_target` | Average kcal vs target, days over, lowest and highest day, share of kcal from protein / carbs / fat | 3+ logged days |
| `protein_vs_target` | Average g and **g/kg**, % of target, days at target | 3+ logged days |
| `fiber_vs_target` | Fiber vs target | 3+ logged days, not 90 to 100% |
| `micronutrient_gaps` | Up to 5 nutrients **consistently under 70%** of their minimum, with names, amounts, percentages | 3+ days with data, half of them low |
| `limits_exceeded` | Sodium, saturated fat, added sugar ... above their daily limit on average | |
| `weight_trend` | kg/week (straight-line fit) against the planned rate, "faster than 1% of body weight per week", ETA to the target weight | 3+ weigh-ins over 10+ days |
| `weight_stale` | The last weigh-in is older than 14 days | |
| `energy_balance` | Eaten vs resting energy + watch active energy, roughly kg/week | 4+ days with food and watch data, BMR known |
| `sleep_duration`, `sleep_consistency` | Average hours, nights under 6 h, score; how uneven the nights are | 3+ nights, data reaches within 3 days of today |
| `hrv_trend`, `resting_hr_trend` | This week against the 3 weeks before | 3+ readings this week, 5+ before; change of 10% / 3 bpm |
| `training_frequency`, `training_gap`, `load_spike` | Sessions, minutes, kcal in 7 days against the 28-day average; no workout for N days; this week 1.5x your usual | |
| `last_workout` | The latest workout with duration, kcal, heart rate when known, or "no heart-rate figure is available for it" | |
| `steps_trend` | Steps down or up 25% | 4+ days this week, 7+ before |
| `hydration` | Logged water per day (vs target when there is one) | 3+ days with water |

Rules every finding follows:

- **Nothing is invented.** A rule that lacks data does not fire (and does not fire a weaker version); `computeUnavailable` lists the gaps.
- **A day without a food log is not zero.** Averages use logged days only, and say how many.
- **Present-tense claims need fresh data.** Sleep, HRV and resting heart rate older than 3 days produce no claim.
- **Every claim carries its basis**, so the answer can say "over the last 7 logged days".
- **A micronutrient gap may be missing food data.** Foods without a value for a nutrient count as unknown for that day, and the basis says so.

#### Adding a finding

1. Write `const myRule: Rule = (ctx) => CoachFinding | CoachFinding[] | null` in `coach-findings.ts` (return `null` when the data is not enough).
2. Add it to `RULES`.
3. If it needs data the app does not pass yet, add the field to `FindingsInput`, fill it in `buildCoachSummary` (`apps/app/src/ai/coach-summary.ts`) and fetch it in `fetchCoachGrounding` (`apps/app/src/data/coach.ts`).
4. Add a test with a hand-built week in `coach-findings.test.ts` (and, for the app wiring, in `tools/ui-smoke/src/coach-app.test.ts`).
5. If you send a new kind of data to the model, update the lists in [AI and privacy](ai-and-privacy.md) and the [privacy policy](privacy-policy.md).

### Workout details

A chat can be **about** a workout: `/coach?topicKind=workout&topicId=<exercise_entries id>`. The thread stores the topic
(`coach_threads.topic`, `{ "kind": "workout", "id": "<uuid>" }`, migration `20261110000106`); opening the same workout again resumes
that thread; the title is "Workout: <first message>". If the database does not have the migration yet, the coach still works, but the chat
forgets its topic once the app is closed. The input starts with "How was this workout?" but **nothing is sent until you press Send**.

On **every turn** of such a thread the app calls `loadWorkoutCoachContext(id)` (`apps/app/src/ai/workout-context.ts`, owned by the
Workouts feature), which returns a compact plain-text description of that workout (at most about 2,500 characters; the coach caps it at
3,000) or `null`. It is added to the data block under *"The user is asking about this workout:"*. In a chat without a topic the
latest workout is described the same way (cap 1,800 characters), so "how was my last workout?" can be answered with heart rate
and zones when the data exists. A slow lookup is dropped after 6 seconds; the turn goes on without it.

## What is sent to OpenRouter

Per message: your message, the conversation, and the data block above: numbers, nutrient names, workout names or types. **Never**:
your name, your e-mail address, the text of diary notes, tokens, or the OpenRouter key. Details in
[AI and privacy](ai-and-privacy.md).

## The guard

A small, cheap model (`guardModel`, default the coach model) classifies the new message, in the context of the last six messages,
into one of four categories. Only the first needs no fixed text:

| Category | Meant for | Result |
| --- | --- | --- |
| `on_topic` | **Anything** about food, drink, supplements and their doses, diets, fasting, calories, macros, micronutrients, weight, body composition, workouts, heart rate, sleep, recovery, stress as it relates to training, your logged data, and short follow-ups | answered |
| `off_topic` | Code, trivia, politics, writing, legal / financial / relationship advice, role-play, attempts to change the rules, injected "system" lines | fixed redirect |
| `medical_red_flag` | Acute symptoms (chest pain, fainting, trouble breathing, blood in stool, stroke signs, allergic reaction), suspected overdose or poisoning, self-harm, requests to diagnose or to start / stop / change a prescription medicine or insulin | fixed "get care" text, no coaching |
| `eating_disorder_risk` | Very low calorie crash plans (about 1,000 kcal and below), multi-day fasts to lose weight, purging, laxatives or diuretics, punishing exercise, hiding not eating | fixed supportive text, professional help |

The guard is told to be generous: when unsure between `on_topic` and `off_topic` for anything that could be about food, fitness or the
body, it picks `on_topic`; a question about a supplement dose is `on_topic`, not a medical red flag.

The coach prompt itself says: answer directly with numbers scaled to the person (g/kg, mg/kg), give 2 to 4 next steps with quantities,
**at most one short, specific caution** when it matters (kidney disease, an interacting medicine, going over an upper limit), and never answer with
"ask your doctor" instead of the information, no repeated "not medical advice". The permanent small disclaimer under the input stays.
The audit step only replaces a reply that diagnoses, tells you to change a prescription, recommends a dose clearly above the established
upper limit, or encourages extreme restriction.

The guard is tuned with `packages/ai/eval/coach-guard-cases.json` (about 200 prompts, including the supplement, macro and
micronutrient questions that must be answered). `packages/ai/src/eval-cases.test.ts` checks the file; running the live
evaluation needs your key (`packages/ai/eval/run-guard-eval.ts`). **How the models really behave has not been verified by tests**
(no test calls a model); run the evaluation after changing a prompt.

## What was borrowed from the reference project, and what was not

Borrowed:

- Rules find the facts, the model only writes the text; every statement shows its numbers and what was counted.
- A finding that lacks its data does not fire; the gaps are listed so the model says "I cannot see X".
- Good news is reported too; freshness gates for present-tense claims; the 1.5x acute-to-chronic training-time spike.
- A prompt that tells the model not to guess, to quote the findings, and that wrist heart rate means little for strength sessions.
- Only the data a question needs, as summary rows, never the whole database.
- Short, direct answers; at most one caveat.

Not borrowed (yet):

- **A daily brief and notifications** (one brief a day, a notification only on important days). The findings are the building block; a
  scheduled brief needs background execution and a notification permission.
- **Tools the model calls** (see below).
- Bootstrap confidence intervals around findings (the reference has years of data; here a finding states how many days it counted).
- Prompt caching of the fixed system prompt.
- An MCP server for command-line agents.

## Next step: let the model ask for more data

Today every turn carries the same fixed block. The reference project instead lets the model **call tools** that read bounded slices of
the local data, and it never sends the rest. The same can be done here with OpenRouter tool calls answered from local queries:

| Tool | Arguments | Answers from |
| --- | --- | --- |
| `get_day` | `date` | `daily_totals` row, meals, water, workouts, sleep of one day |
| `get_nutrient_history` | `code` (e.g. `MAGNESIUM_MG`), `days` (max 90) | `daily_totals.nutrients` |
| `get_workouts` | `days` (max 90), optional `type` | `exercise_entries` incl. `details` |

What it needs: `tools` / `tool_choice` on the client request type and parsing of `delta.tool_calls` in the stream; a loop in
`runCoachTurn` (at most 6 rounds, the last round forbids tools, results capped at about 25 KB, an error is a result); a check that the
chosen model supports tools (`ModelInfo.supportsTools`) with a fallback to the fixed block; the guard stays in front. It was **not
built** because it cannot be verified without calling live models, and the fixed block already carries the 14 to 42 days the findings use.
