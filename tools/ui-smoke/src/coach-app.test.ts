/**
 * The coach in the app, run through the app's own modules via the `@/` alias (no React, no network, no model):
 *  - ai/coach-history.ts   what the model is told about the conversation (the "no context of the last message" complaint)
 *  - ai/coach-topic.ts     chats ABOUT a workout: route params, titles, the pre-filled question
 *  - ai/coach-summary.ts   the data block: findings first, then the rows they come from
 *  - data/coach.ts         threads with a topic, messages (newest 500), the grounding queries - against the mock backend
 * and, with a fake model client, whole conversations end to end (database -> history -> request).
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { ANON_KEY, BACKEND_ORIGIN, FIXED_NOW_MS, STORAGE_KEY, TODAY } from './constants';
import { USER, buildFixtures } from './fixtures';
import { createMockBackend } from './mock-backend';
import { SEED_SESSION_TTL_SECONDS, buildSession } from './session';

const holder = vi.hoisted(() => ({ client: null as any }));

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: true,
  supabase: new Proxy({}, { get: (_target, prop) => holder.client[prop] }),
}));

const here = dirname(fileURLToPath(import.meta.url));
const appRequire = createRequire(join(here, '..', '..', '..', 'apps', 'app', 'package.json'));

async function loadSupabase(): Promise<{ createClient: (url: string, key: string, options: unknown) => any } | null> {
  try {
    return (await import(pathToFileURL(appRequire.resolve('@supabase/supabase-js')).href)) as never;
  } catch {
    return null;
  }
}

const lib = await loadSupabase();

/** Imports an app module through the `@/` alias at run time (untyped: this package knows nothing about the app). */
const load = (specifier: string): Promise<any> => import(/* @vite-ignore */ specifier);

type Rec = Record<string, any>;

function connect(mutate?: (tables: Record<string, Rec[]>) => void) {
  const fx = buildFixtures('default');
  mutate?.(fx.seed.tables as Record<string, Rec[]>);
  const backend = createMockBackend(fx.seed);
  const session = buildSession(USER, { nowMs: FIXED_NOW_MS, ttlSeconds: SEED_SESSION_TTL_SECONDS });
  const store = new Map<string, string>([[STORAGE_KEY, JSON.stringify(session)]]);
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const res = backend.handle({ method: req.method, url: req.url, headers, body: init?.body == null ? null : String(init.body) });
    return new Response(res.body === '' || res.status === 204 ? null : res.body, { status: res.status, headers: res.headers });
  };
  holder.client = (lib as NonNullable<typeof lib>).createClient(BACKEND_ORIGIN, ANON_KEY, {
    auth: {
      storage: { getItem: async (k: string) => store.get(k) ?? null, setItem: async (k: string, v: string) => void store.set(k, v), removeItem: async (k: string) => void store.delete(k) },
      autoRefreshToken: false,
      persistSession: true,
      detectSessionInUrl: false,
    },
    global: { fetch: fetchImpl },
  });
  return { backend, fx };
}

const ai = await load(pathToFileURL(appRequire.resolve('@cal/ai')).href);
const history = await load('@/ai/coach-history');
const topics = await load('@/ai/coach-topic');
const summaryLib = await load('@/ai/coach-summary');

const WORKOUT = '3f0b8d0e-6a53-4c1f-9d57-0a1b2c3d4e5f';

const row = (id: string, role: 'user' | 'assistant', content: string) => ({ id, role, content });

describe('coach history (what the model is told about the conversation)', () => {
  it('keeps every stored message, in order, in full', () => {
    const long = `Start ${'Strength training, 40 min. '.repeat(120)} End`;
    const rows = [row('1', 'user', 'What was my last workout like?'), row('2', 'assistant', long), row('3', 'user', 'How was it')];
    expect(history.toCoachHistory(rows)).toEqual([
      { role: 'user', content: 'What was my last workout like?' },
      { role: 'assistant', content: long },
      { role: 'user', content: 'How was it' },
    ]);
  });

  it('a user message that never got an answer is NOT dropped any more', () => {
    // [u1 (failed, no reply), u2]: the old code dropped u1
    const out = history.toCoachHistory([row('1', 'user', 'Based on my heartrate how did it feel?'), row('2', 'user', 'hello?')]);
    expect(out.map((m: Rec) => m.content)).toEqual(['Based on my heartrate how did it feel?', 'hello?']);
  });

  it('a fixed refusal becomes one short marker; a normal reply that merely mentions the same words stays', () => {
    const out = history.toCoachHistory([
      row('1', 'user', 'write python'),
      row('2', 'assistant', ai.DEFAULT_REFUSALS.off_topic),
      row('3', 'user', 'ok, protein?'),
      row('4', 'assistant', 'I can only help with food. Just kidding: aim for 140 g.'),
    ]);
    expect(out[1].content).toBe(history.REFUSAL_MARKERS.off_topic);
    expect(out[1].content.length).toBeLessThan(150);
    expect(out[3].content).toBe('I can only help with food. Just kidding: aim for 140 g.');
    expect(history.detectRefusal(ai.DEFAULT_REFUSALS.medical_red_flag)).toBe('medical_red_flag');
    expect(history.detectRefusal(`  ${ai.DEFAULT_REFUSALS.eating_disorder_risk} \n`)).toBe('eating_disorder_risk');
    expect(history.detectRefusal('Aim for 140 g.')).toBeNull();
  });

  it('historyBefore: everything before the message being sent', () => {
    const rows = [row('1', 'user', 'a'), row('2', 'assistant', 'b'), row('3', 'user', 'c'), row('4', 'assistant', 'd'), row('5', 'user', 'e')];
    expect(history.historyBefore(rows, '5').map((r: Rec) => r.id)).toEqual(['1', '2', '3', '4']);
    expect(history.historyBefore(rows, '3').map((r: Rec) => r.id)).toEqual(['1', '2']);
    expect(history.historyBefore(rows, '1')).toEqual([]);
  });

  it('historyBefore: when the message is not in the list (optimistic local id, list loaded earlier) it is never sent twice, and nothing else is lost', () => {
    const rows = [row('1', 'user', 'a'), row('2', 'assistant', 'b'), row('3', 'user', 'How was it')];
    expect(history.historyBefore(rows, 'local-123', 'How was it').map((r: Rec) => r.id)).toEqual(['1', '2']);
    expect(history.historyBefore(rows, undefined, ' How was it ').map((r: Rec) => r.id)).toEqual(['1', '2']);
    // not in the list and not a copy: the whole list is history (the new message simply is not stored yet)
    expect(history.historyBefore(rows.slice(0, 2), 'local-123', 'How was it').map((r: Rec) => r.id)).toEqual(['1', '2']);
    // an earlier message with the same text that DID get an answer stays
    const repeat = [row('1', 'user', 'How was it'), row('2', 'assistant', 'fine'), row('3', 'user', 'How was it')];
    expect(history.historyBefore(repeat, '3', 'How was it').map((r: Rec) => r.id)).toEqual(['1', '2']);
    expect(history.historyBefore(repeat.slice(0, 2), 'local-9', 'How was it').map((r: Rec) => r.id)).toEqual(['1', '2']);
  });

  it('loadTurnHistory reads the database, not the stale cache', async () => {
    const stored = [row('1', 'user', 'q1'), row('2', 'assistant', 'a1'), row('3', 'user', 'q2'), row('4', 'assistant', 'a2'), row('5', 'user', 'q3')];
    const staleCache = stored.slice(0, 2); // a screen that was loaded before turns 2 and 3 (thread opened from History, app resumed)
    const fetchRows = vi.fn(async () => stored);
    const r = await history.loadTurnHistory({ threadId: 't', userMessageId: '5', text: 'q3', fetchRows, cached: staleCache });
    expect(fetchRows).toHaveBeenCalledWith('t');
    expect(r.fromDatabase).toBe(true);
    expect(r.history.map((m: Rec) => m.content)).toEqual(['q1', 'a1', 'q2', 'a2']);
    expect(r.rows).toBe(stored);
  });

  it('loadTurnHistory falls back to the cache when the read fails, and an empty cache gives an empty history', async () => {
    const cached = [row('1', 'user', 'q1'), row('2', 'assistant', 'a1'), row('3', 'user', 'q2')];
    const failing = async () => {
      throw new Error('offline');
    };
    const r = await history.loadTurnHistory({ threadId: 't', userMessageId: '3', text: 'q2', fetchRows: failing, cached });
    expect(r.fromDatabase).toBe(false);
    expect(r.history.map((m: Rec) => m.content)).toEqual(['q1', 'a1']);
    const first = await history.loadTurnHistory({ threadId: 't', userMessageId: 'local-1', text: 'hi', fetchRows: async () => [], cached: [] });
    expect(first.history).toEqual([]);
  });
});

describe('coach topics', () => {
  it('parses the route params of /coach?topicKind=workout&topicId=<uuid>; anything else is no topic', () => {
    expect(topics.parseCoachTopic({ topicKind: 'workout', topicId: WORKOUT })).toEqual({ kind: 'workout', id: WORKOUT });
    expect(topics.parseCoachTopic({ topicKind: ['workout'], topicId: [WORKOUT.toUpperCase()] })).toEqual({ kind: 'workout', id: WORKOUT });
    expect(topics.parseCoachTopic({ topicKind: 'workout', topicId: 'not-a-uuid' })).toBeNull();
    expect(topics.parseCoachTopic({ topicKind: 'meal', topicId: WORKOUT })).toBeNull();
    expect(topics.parseCoachTopic({ topicId: WORKOUT })).toBeNull();
    expect(topics.parseCoachTopic({})).toBeNull();
  });

  it('validates the jsonb read from the database', () => {
    expect(topics.topicFromJson({ kind: 'workout', id: WORKOUT })).toEqual({ kind: 'workout', id: WORKOUT });
    for (const bad of [null, undefined, 'workout', 5, [], {}, { kind: 'workout' }, { kind: 'workout', id: 'x' }, { kind: 'future', id: WORKOUT }]) {
      expect(topics.topicFromJson(bad)).toBeNull();
    }
    expect(topics.sameTopic({ kind: 'workout', id: WORKOUT }, { kind: 'workout', id: WORKOUT.toUpperCase() })).toBe(true);
    expect(topics.sameTopic({ kind: 'workout', id: WORKOUT }, null)).toBe(false);
  });

  it('title: "Workout: <first message>", cut like a normal title', () => {
    const t = { kind: 'workout', id: WORKOUT };
    expect(topics.topicThreadTitle(t, 'How was this workout?')).toBe('Workout: How was this workout?');
    expect(topics.topicThreadTitle(t, 'How hard was this workout for my heart rate and recovery tomorrow?')).toMatch(/^Workout: .{10,41}\u2026$/);
    expect(topics.topicThreadTitle(t, '   ')).toBe('Workout');
    expect(topics.topicThreadTitle(null, 'Plain question')).toBe('Plain question');
    expect(topics.coachThreadTitle('')).toBe('New chat');
  });

  it('pre-filled question and starters; the prefill is a suggestion, not a message', () => {
    const t = { kind: 'workout', id: WORKOUT };
    expect(topics.topicPrefill(t)).toBe('How was this workout?');
    expect(topics.topicPrompts(t)).toContain('How was this workout?');
    expect(topics.topicKey(t)).toBe(`workout:${WORKOUT}`);
    expect(topics.topicKey(null)).toBe('none');
  });

  it('workout text becomes the data-block section: the topic one wins, capped; the latest workout is only for chats without a topic', () => {
    const both = topics.workoutDetailSections({ topicText: ' Run 5 km, avg HR 150 ', latestText: 'Yesterday: yoga' });
    expect(both).toEqual([{ heading: 'The user is asking about this workout:', text: 'Run 5 km, avg HR 150', maxChars: 3000 }]);
    expect(topics.workoutDetailSections({ latestText: 'Yesterday: yoga' })).toEqual([
      { heading: "The user's most recent workout, in detail:", text: 'Yesterday: yoga', maxChars: 1800 },
    ]);
    expect(topics.workoutDetailSections({ topicText: null, latestText: '  ' })).toEqual([]);
    // and the data block caps it
    const ctx = ai.buildCoachContext({ workoutDetails: topics.workoutDetailSections({ topicText: 'x'.repeat(9000) }) });
    expect(ctx).toContain('The user is asking about this workout:');
    expect(ctx.length).toBeLessThan(3400);
  });
});

describe('coach summary: findings first, then the rows they come from', () => {
  const day = (n: number) => new Date(Date.UTC(2026, 10, 10) - n * 86_400_000).toISOString().slice(0, 10);
  const totals = Array.from({ length: 10 }, (_, k) => ({
    date: day(k + 1),
    kcal: 2300,
    proteinG: 95,
    carbsG: 250,
    fatG: 80,
    fiberG: 18,
    entryCount: 5,
    nutrients: { MAGNESIUM_MG: 210, VITAMIN_D_UG: 4, SODIUM_MG: 3200, CALCIUM_MG: 900 },
  }));
  const input = {
    today: TODAY,
    targets: { kcal: 2100, proteinG: 150, fiberG: 30 },
    nutrientTargets: { MAGNESIUM_MG: { min: 400 }, VITAMIN_D_UG: { min: 15 }, SODIUM_MG: { max: 2300 }, CALCIUM_MG: { min: 1000 } },
    bmrKcal: 1850,
    rateKgPerWeek: -0.5,
    targetWeightKg: 80,
    latestWeightKg: 84.2,
    dailyTotals: [...totals, { date: TODAY, kcal: 700, proteinG: 30, carbsG: 80, fatG: 20, fiberG: 5, entryCount: 2, nutrients: {} }],
    weight: [28, 21, 14, 7, 0].map((n, i) => ({ date: day(n), kg: 85.4 - i * 0.3 })),
    exercise: [{ id: 'w-new', date: TODAY, name: 'Strength training', minutes: 40, kcal: 210, avgHr: 118, maxHr: 151, source: 'garmin', startedAt: `${TODAY}T07:00:00Z`, endedAt: `${TODAY}T07:40:00Z` }],
    deviceEnergy: [{ date: TODAY, source: 'garmin', activeKcal: 310, steps: 4200 }],
    biometrics: [
      { date: day(0), type: 'sleep', value: 6.2, unit: 'hr', source: 'garmin' },
      { date: day(1), type: 'sleep', value: 5.8, unit: 'hr', source: 'garmin' },
      { date: day(2), type: 'sleep', value: 6.4, unit: 'hr', source: 'garmin' },
      { date: day(0), type: 'hrv', value: 48, unit: 'ms', source: 'garmin' },
    ],
    water: [{ date: day(1), ml: 1500 }, { date: day(2), ml: 900 }, { date: day(2), ml: 600 }],
    lastLoggedDate: TODAY,
  };

  it('computes findings with the numbers, keeps the evidence rows and the unfinished day apart', () => {
    const s = summaryLib.buildCoachSummary(input);
    const kinds = s.findings.map((f: Rec) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(['protein_vs_target', 'calories_vs_target', 'micronutrient_gaps', 'limits_exceeded', 'weight_trend', 'sleep_duration', 'last_workout']));
    const protein = s.findings.find((f: Rec) => f.kind === 'protein_vs_target');
    expect(protein.claim).toBe('Protein averages 95 g/day against a 150 g target (63%).');
    expect(protein.evidence).toContain('1.13 g/kg at 84.2 kg');
    expect(s.findings.find((f: Rec) => f.kind === 'micronutrient_gaps').claim).toContain('Vitamin D 27% (4 of 15 ug), Magnesium 53% (210 of 400 mg)');
    expect(s.findings.find((f: Rec) => f.kind === 'last_workout').claim).toBe('Last workout today: Strength training, 40 min, 210 kcal, avg HR 118, max HR 151.');
    // rows: the unfinished day is NOT in the averages and has its own line
    expect(s.intake).toHaveLength(10);
    expect(s.intake.every((d: Rec) => d.date < TODAY)).toBe(true);
    expect(s.today).toMatchObject({ date: TODAY, kcal: 700 });
    expect(s.notes).toBeUndefined();
    // water per day is summed; sodium comes from the nutrients map
    expect(s.intake.find((d: Rec) => d.date === day(2))).toMatchObject({ waterMl: 1500, sodiumMg: 3200 });
    expect(s.activity.at(-1)).toEqual({ date: TODAY, steps: 4200, activeKcal: 310, workouts: [{ type: 'Strength training', minutes: 40, kcal: 210, avgHr: 118, maxHr: 151 }] });
    expect(s.recovery).toEqual([{ date: TODAY, hrv: 48 }]);
    expect(s.freshness).toMatchObject({ food: TODAY, sleep: TODAY, workout: TODAY, recovery: TODAY, weight: TODAY });
    expect(s.nutrients.map((n: Rec) => n.name)).toEqual(['Vitamin D', 'Magnesium', 'Calcium', 'Sodium']);
    expect(s.unavailable).toContain('resting heart rate');
  });

  it('the rendered block starts with the findings and tells the model what it cannot see', () => {
    const ctx = ai.buildCoachContext(summaryLib.buildCoachSummary(input));
    expect(ctx.indexOf('Findings (computed by the app')).toBeGreaterThan(0);
    expect(ctx.indexOf('Findings (computed by the app')).toBeLessThan(ctx.indexOf('as_of (today): 2026-11-10 (Tuesday)'));
    expect(ctx).toContain('1. [watch]');
    expect(ctx).toContain('not_available (the app cannot see this; say so instead of guessing): resting heart rate');
    expect(ctx).toContain('today_so_far (day not finished, do not treat as a full day): 700 kcal');
    expect(ctx).toContain('nutrients_vs_targets');
    expect(ctx).toContain('Vitamin D | 4 ug | 15 | - | 27% | 7');
    expect(ctx.length).toBeLessThan(11_000);
    // no free text of the user and nothing personal beyond numbers
    expect(ctx).not.toMatch(/user_notes|@|password|api[_ ]?key/i);
  });

  it('only a topic or the latest workout adds the workout text', () => {
    const s = summaryLib.buildCoachSummary({ ...input, workoutDetails: topics.workoutDetailSections({ topicText: 'Heart rate zones: Z2 22 min, Z3 10 min' }) });
    expect(s.workoutDetails).toHaveLength(1);
    expect(s.findings.find((f: Rec) => f.kind === 'last_workout').evidence).toEqual([]); // avg/max HR are in the claim already
    const without = summaryLib.buildCoachSummary({ today: TODAY, exercise: [{ id: 'x', date: TODAY, name: 'Run', minutes: 30, kcal: 300 }], workoutDetails: [] });
    expect(without.workoutDetails).toBeUndefined();
    expect(without.findings.find((f: Rec) => f.kind === 'last_workout').evidence).toEqual(['no heart-rate figure is available for it']);
    const detailed = summaryLib.buildCoachSummary({ today: TODAY, exercise: [{ id: 'x', date: TODAY, name: 'Run', minutes: 30, kcal: 300 }], workoutDetails: topics.workoutDetailSections({ latestText: 'Run 5 km' }) });
    expect(detailed.findings.find((f: Rec) => f.kind === 'last_workout').evidence).toEqual(['more detail (heart rate etc.) is in the workout section below']);
  });

  it('an empty account gives no findings and a list of what is missing - never invented numbers', () => {
    const s = summaryLib.buildCoachSummary({ today: TODAY });
    expect(s.findings.map((f: Rec) => f.kind)).toEqual(['no_intake_data']);
    expect(s.nutrients).toBeUndefined();
    expect(s.unavailable).toEqual(expect.arrayContaining(['food intake (nothing logged on the last 14 completed days)', 'weight (no weigh-ins in the last 6 weeks)']));
  });

  it('latestWorkoutId: the newest workout after de-duplication', () => {
    const rows = [
      { id: 'old', date: day(3), name: 'Run', minutes: 30, kcal: 300 },
      { id: 'a', date: day(1), name: 'Run', minutes: 30, kcal: 300, startedAt: `${day(1)}T06:00:00Z` },
      { id: 'b', date: day(1), name: 'Yoga', minutes: 30, kcal: 100, startedAt: `${day(1)}T18:00:00Z` },
      { id: 'nodate', name: 'x' },
    ];
    expect(summaryLib.latestWorkoutId(rows)).toBe('b');
    expect(summaryLib.latestWorkoutId([])).toBeUndefined();
    expect(summaryLib.latestWorkoutId(null)).toBeUndefined();
  });
});

const suite = lib ? describe : describe.skip;

suite('data/coach.ts against the mock backend', () => {
  it('createCoachThread with a topic stores it; the thread comes back with its topic and title', async () => {
    const coach = await load('@/data/coach');
    const { backend } = connect();
    const thread = await coach.createCoachThread('How was this workout?', { kind: 'workout', id: WORKOUT });
    expect(thread).toMatchObject({ title: 'Workout: How was this workout?', topic: { kind: 'workout', id: WORKOUT } });
    expect(backend.rows('coach_threads').find((t) => t.id === thread.id)?.topic).toEqual({ kind: 'workout', id: WORKOUT });
    const read = await coach.fetchCoachThread(thread.id);
    expect(read.topic).toEqual({ kind: 'workout', id: WORKOUT });
    const plain = await coach.createCoachThread('Protein?');
    expect(plain).toMatchObject({ title: 'Protein?', topic: null });
    expect((await coach.fetchCoachThread(plain.id)).topic).toBeNull();
    expect(await coach.fetchCoachThread('11111111-1111-4111-8111-111111111111')).toBeNull();
    expect(backend.unhandled).toEqual([]);
    expect(backend.calls.filter((c) => c.status >= 400)).toEqual([]);
  });

  it('opening the same workout again finds the existing thread (newest first); another workout or no topic finds nothing', async () => {
    const coach = await load('@/data/coach');
    const { backend } = connect();
    const first = await coach.createCoachThread('How was this workout?', { kind: 'workout', id: WORKOUT });
    await coach.createCoachThread('Another one', { kind: 'workout', id: '11111111-1111-4111-8111-111111111111' });
    await coach.createCoachThread('Plain');
    const found = await coach.findCoachThreadForTopic({ kind: 'workout', id: WORKOUT });
    expect(found?.id).toBe(first.id);
    expect(await coach.findCoachThreadForTopic({ kind: 'workout', id: '22222222-2222-4222-8222-222222222222' })).toBeNull();
    // a second thread for the same workout (made by hand): the newest wins
    const second = await coach.createCoachThread('Again', { kind: 'workout', id: WORKOUT });
    await coach.appendCoachMessage(second.id, 'user', 'again', { touch: true });
    expect((await coach.findCoachThreadForTopic({ kind: 'workout', id: WORKOUT }))?.id).toBe(second.id);
    expect(backend.calls.filter((c) => c.status >= 400)).toEqual([]);
  });

  it('messages: oldest first, and a very long thread keeps its NEWEST 500 (not its oldest)', async () => {
    const coach = await load('@/data/coach');
    const threadId = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';
    connect((tables) => {
      tables.coach_threads!.push({ id: threadId, user_id: USER.id, title: 'long', created_at: '2026-10-01T10:00:00+00:00', updated_at: '2026-10-01T10:00:00+00:00' });
      for (let i = 0; i < 520; i++) {
        tables.coach_messages!.push({
          id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          thread_id: threadId,
          user_id: USER.id,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `message ${i}`,
          created_at: new Date(Date.UTC(2026, 9, 1, 10, 0, 0) + i * 1000).toISOString(),
        });
      }
    });
    const rows = await coach.fetchCoachMessages(threadId);
    expect(rows).toHaveLength(500);
    expect(rows[0].content).toBe('message 20');
    expect(rows.at(-1).content).toBe('message 519');
    expect(rows.map((r: Rec) => r.createdAt)).toEqual([...rows.map((r: Rec) => r.createdAt)].sort());
  });

  it('the grounding queries return nutrients, water, recovery types, workout ids and the newest logged day', async () => {
    const coach = await load('@/data/coach');
    const { backend } = connect();
    const g = await coach.fetchCoachGrounding(TODAY);
    expect(g.dailyTotals.length).toBeGreaterThan(5);
    expect(g.dailyTotals.some((d: Rec) => d.nutrients && Object.keys(d.nutrients).length > 0)).toBe(true);
    expect(g.exercise.every((e: Rec) => typeof e.id === 'string')).toBe(true);
    expect(g.water).not.toBeNull();
    expect(g.lastLoggedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(g.lastLoggedDate <= TODAY).toBe(true);
    expect(backend.unhandled).toEqual([]);
    expect(backend.calls.filter((c) => c.status >= 400)).toEqual([]);
  });

  it('isMissingColumnError recognises the two ways a database without migration …106 answers', async () => {
    const { isMissingColumnError } = await load('@/data/coach');
    expect(isMissingColumnError({ code: '42703', message: 'column coach_threads.topic does not exist' }, 'topic')).toBe(true);
    expect(isMissingColumnError({ code: 'PGRST204', message: "Could not find the 'topic' column of 'coach_threads' in the schema cache" }, 'topic')).toBe(true);
    expect(isMissingColumnError({ code: '42703', message: 'column coach_threads.other does not exist' }, 'topic')).toBe(false);
    expect(isMissingColumnError({ code: '42501', message: 'permission denied' }, 'topic')).toBe(false);
    expect(isMissingColumnError(null)).toBe(false);
    expect(isMissingColumnError({ message: 'Could not find the details column of exercise_entries in the schema cache' }, 'details')).toBe(true);
  });

  it('end to end: three turns read from the database reach the model whole, even when the screen cache is empty', async () => {
    const coach = await load('@/data/coach');
    connect();
    const answers = ['You logged 40 minutes of strength training today.', `I only see duration and calories for it. ${'x'.repeat(2600)} END-OF-ANSWER-2`, 'Heart rate is not in your log, so I cannot say how hard it felt.'];
    const questions = ['What was my last workout like?', 'How was it', 'Based on info from it how it felt for me based on heartrate and everything'];
    const requests: Rec[] = [];
    const guardCalls: Rec[] = [];
    let turn = 0;
    const client = {
      chatJson: vi.fn(async (req: Rec) => {
        if (req.jsonSchemaName === 'coach_guard') guardCalls.push(req);
        return { category: 'on_topic', reason: 'ok' };
      }),
      chatStream: vi.fn(async function* (req: Rec) {
        requests.push(req);
        yield { type: 'delta', text: answers[turn++] };
        yield { type: 'done' };
      }),
    };

    const thread = await coach.createCoachThread(questions[0]);
    for (let n = 0; n < 3; n++) {
      const user = await coach.appendCoachMessage(thread.id, 'user', questions[n]);
      // the screen's cache is EMPTY / stale here on purpose: the history must come from the database
      const loaded = await history.loadTurnHistory({ threadId: thread.id, userMessageId: user.id, text: questions[n], fetchRows: coach.fetchCoachMessages, cached: [] });
      const result = await ai.runCoachTurn({ client, model: 'm', history: loaded.history, userMessage: questions[n], summary: {}, checkOutput: false });
      await coach.appendCoachMessage(thread.id, 'assistant', result.text, { touch: true });

      const sent = requests[n]!.messages.slice(1, -1).map((m: Rec) => m.content);
      const expected = [] as string[];
      for (let k = 0; k < n; k++) expected.push(questions[k]!, answers[k]!);
      expect(sent).toEqual(expected);
    }
    // the guard of turn 3 saw the previous question and the start of the previous answer
    const g3 = guardCalls[2]!.messages[1].content as string;
    expect(g3).toContain('user: How was it');
    expect(g3).toContain('assistant: I only see duration and calories for it.');
    expect(requests[2]!.messages.slice(1, -1).map((m: Rec) => m.content).join('\n')).toContain('END-OF-ANSWER-2');
  });
});
