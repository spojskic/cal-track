/**
 * Smoke scenarios of the Workouts section (More > Workouts on a phone, the Workouts row of the sidebar on a desktop). Appended to the
 * main list by scenarios.ts.
 *
 * Fixtures (src/fixtures.ts, default variant): two manual workouts, one Apple Health strength session, and three Garmin workouts -
 * a strength session with full details (heart rate, zones, training effect, sets), a run with only the list summary and a ride
 * without any details. The web build never reads Garmin (no tokens in a browser), so the details screens show what is stored.
 * No AI key is set up, so "Discuss with coach" must not be offered anywhere.
 */
import type { Page } from 'playwright-core';

import { clickButton } from './actions';
import { IDS } from './fixtures';
import type { Scenario, ScenarioContext } from './types';

const W = IDS.workout;

/** Runs an interaction; runs the follow-up assertions only when the interaction worked. */
async function stepThen(ctx: ScenarioContext, label: string, act: () => Promise<unknown>, then: () => Promise<unknown>): Promise<void> {
  if (await ctx.step(label, act)) await then();
}

/** Number of buttons with this accessible name (a string is an exact name). */
const buttonCount = (page: Page, name: string | RegExp): Promise<number> => page.getByRole('button', { name, exact: typeof name === 'string' }).count();

/** FAIL when any of the buttons exists. */
async function expectNoButton(ctx: ScenarioContext, page: Page, name: string | RegExp, why: string): Promise<void> {
  await ctx.check(why, async () => {
    if ((await buttonCount(page, name)) > 0) throw new Error(`a "${String(name)}" button is visible`);
  });
}

/** REST requests to exercise_entries so far. */
const workoutQueries = (ctx: ScenarioContext): string[] =>
  ctx.backend.calls.filter((c) => c.kind === 'rest' && c.target === 'exercise_entries').map((c) => decodeURIComponent(c.query));

export const WORKOUT_SCENARIOS: Scenario[] = [
  {
    name: 'more: Workouts is always listed (no AI key needed) and opens the list',
    route: '/more',
    path: '/more',
    auth: 'signed-in',
    viewports: ['phone', 'phone-dark'],
    expect: ['Workouts', 'Every workout with heart rate'],
    async after(page, ctx) {
      await ctx.expectNoText('Chat about your nutrition', { timeout: 1500 }); // the Coach entry stays hidden without a key
      await stepThen(ctx, 'open Workouts', () => clickButton(page, /^Workouts\./), async () => {
        await ctx.expectUrl(/\/workouts\/?(\?.*)?$/);
        await ctx.expectText('This week');
      });
    },
  },
  {
    // The desktop sidebar lists Workouts whatever the AI setting; the Coach row is the one that needs a key.
    name: 'sidebar: Workouts is always listed (no AI key needed) and opens the list',
    route: '/',
    path: '/',
    auth: 'signed-in',
    viewports: ['desktop', 'desktop-dark'],
    expect: ['Workouts'],
    async after(page, ctx) {
      await ctx.check('there is no Coach row without a key', async () => {
        if ((await page.getByRole('link', { name: 'Coach', exact: true }).count()) > 0) throw new Error('a Coach row is shown');
      });
      await stepThen(ctx, 'open Workouts', () => page.getByRole('link', { name: 'Workouts', exact: true }).first().click({ timeout: 6000 }), async () => {
        await ctx.expectUrl(/\/workouts\/?(\?.*)?$/);
        await ctx.expectText('This week');
      });
    },
  },
  {
    name: 'workouts: list grouped by week and month, with heart-rate hint, source filter and type filter',
    route: '/workouts',
    path: '/workouts',
    auth: 'signed-in',
    expect: [
      'Workouts',
      'This week',
      'Last week',
      'October 2026',
      'Traditional Strength Training',
      'Running, treadmill, general',
      'Strength training',
      'Morning run',
      'Evening ride',
      'avg 118 bpm',
      'avg 150 bpm',
      'All types',
    ],
    async after(page, ctx) {
      await ctx.snapshot('list');
      await ctx.check('only the two keys of the details are loaded for the list, not the whole object', () => {
        const first = workoutQueries(ctx)[0] ?? '';
        if (!first.includes('details->avgHr')) throw new Error(`the list query is "${first}"`);
      });

      await stepThen(ctx, 'filter: Garmin', () => clickButton(page, 'Garmin', { exact: true }), async () => {
        await ctx.expectText('Morning run');
        await ctx.expectText('Evening ride');
        await ctx.expectNoText('Running, treadmill, general', { timeout: 2500 });
        await ctx.expectNoText('Traditional Strength Training', { timeout: 500 });
        await ctx.check('the source filter is asked of the database', () => {
          if (!workoutQueries(ctx).some((q) => /source=in\.\(garmin\)/.test(q))) throw new Error('no query filtered by source = garmin');
        });
        await ctx.snapshot('garmin', { tall: false });
      });
      await stepThen(ctx, 'filter: Manual', () => clickButton(page, 'Manual', { exact: true }), async () => {
        await ctx.expectText('Running, treadmill, general');
        await ctx.expectText('Walking, brisk');
        await ctx.expectNoText('Morning run', { timeout: 2500 });
      });
      await stepThen(ctx, 'filter: Apple Health', () => clickButton(page, 'Apple Health', { exact: true }), async () => {
        await ctx.expectText('Traditional Strength Training');
        await ctx.expectNoText('Running, treadmill, general', { timeout: 2500 });
      });
      await stepThen(ctx, 'filter: All again', () => clickButton(page, 'All', { exact: true }), () => ctx.expectText('Evening ride'));

      await stepThen(ctx, 'type filter: Strength', () => clickButton(page, 'Strength', { exact: true }), async () => {
        await ctx.expectText('Traditional Strength Training');
        await ctx.expectText('Strength training');
        await ctx.expectNoText('Morning run', { timeout: 2500 });
        await ctx.expectNoText('Walking, brisk', { timeout: 500 });
      });
      await stepThen(ctx, 'type filter: All types', () => clickButton(page, 'All types', { exact: true }), () => ctx.expectText('Morning run'));

      await stepThen(ctx, 'open the Garmin strength session', () => clickButton(page, /^Strength training, /), async () => {
        await ctx.expectUrl(new RegExp(`/workouts/${W.garminStrength}`));
        await ctx.expectText('Time in heart-rate zones');
      });
    },
  },
  {
    name: 'workouts: empty state offers to log a workout or connect Garmin',
    route: '/workouts',
    path: '/workouts',
    auth: 'signed-in',
    fixtures: 'empty-diary',
    expect: ['No workouts yet. Log one or connect Garmin.', 'Log a workout', 'Connect Garmin'],
    async after(page, ctx) {
      await expectNoButton(ctx, page, 'Load more', 'no "Load more" on an empty list');
      await stepThen(ctx, 'tap Log a workout', () => clickButton(page, 'Log a workout', { exact: true }), () => ctx.expectUrl(/\/exercise\/new/));
    },
  },
  {
    name: 'workouts: empty state - Connect Garmin leads to Connected apps',
    route: '/workouts',
    path: '/workouts',
    auth: 'signed-in',
    fixtures: 'empty-diary',
    expect: ['No workouts yet'],
    async after(page, ctx) {
      await stepThen(ctx, 'tap Connect Garmin', () => clickButton(page, 'Connect Garmin', { exact: true }), () => ctx.expectUrl(/\/settings\/integrations/));
    },
  },
  {
    name: 'workout detail: Garmin strength session with heart rate, zones, training effect and sets',
    route: '/workouts/[id]',
    path: `/workouts/${W.garminStrength}`,
    auth: 'signed-in',
    expect: [
      'Strength training',
      'Summary',
      'Sunday, 8 November 2026',
      '17:30',
      '50 min',
      '245 kcal',
      '190 kcal active',
      'Garmin',
      'Heart rate',
      'Average heart rate',
      '118 bpm',
      'Max heart rate',
      '162 bpm',
      'Lowest heart rate',
      'Training effect',
      'Aerobic effect',
      'Maintaining',
      'Time in heart-rate zones',
      'Z2 Easy',
      '21 min',
      '114+ bpm',
      'Sets',
      '11 sets, 86 reps',
      'Bench press: 4 x 8 @ 60 kg, 4 x 6 @ 70 kg',
      'Squat: 3 x 10',
      "Exercise names are the watch's guess",
      'cannot be edited here',
    ],
    async after(page, ctx) {
      await ctx.snapshot('detail');
      await expectNoButton(ctx, page, /Discuss with coach/, 'no "Discuss with coach" without an AI key');
      await expectNoButton(ctx, page, /Delete workout/, 'a device workout cannot be deleted here');
      await ctx.check('the zone bar is one image with the minutes of every zone', async () => {
        const bar = page.getByRole('img', { name: /Time in heart-rate zones: Z1 7 min, Z2 21 min, Z3 15 min, Z4 6 min, Z5 1 min/ });
        if ((await bar.count()) !== 1) throw new Error(`found ${await bar.count()} zone bars`);
      });
      await ctx.check('opening a workout writes nothing', () => {
        if (ctx.backend.mutations.some((m) => m.table === 'exercise_entries')) throw new Error('exercise_entries was written');
      });
      await ctx.check('a browser never asks Garmin for anything', () => {
        // The friend request count in the shell asks for list_friendships on every page; that is not Garmin.
        const other = ctx.backend.calls.filter((c) => (c.kind === 'function' || c.kind === 'rpc') && c.target !== 'list_friendships');
        if (other.length > 0) throw new Error(`unexpected calls: ${other.map((c) => c.target).join(', ')}`);
      });
    },
  },
  {
    name: 'workout detail: Garmin strength session in imperial units',
    route: '/workouts/[id]',
    path: `/workouts/${W.garminStrength}`,
    auth: 'signed-in',
    fixtures: 'imperial',
    expect: ['Bench press: 4 x 8 @ 132.3 lb, 4 x 6 @ 154.3 lb', 'Squat: 3 x 10'],
  },
  {
    name: 'workout detail: Garmin run with distance, pace and climb (list summary only)',
    route: '/workouts/[id]',
    path: `/workouts/${W.garminRun}`,
    auth: 'signed-in',
    expect: ['Morning run', 'Distance', '5.01 km', 'Average pace', '6:00 /km', 'Elevation gain', '38 m', 'Average heart rate', '150 bpm', 'Z3 Aerobic', '13 min', 'Aerobic effect', 'Improving'],
    async after(page, ctx) {
      await ctx.expectNoText('Sets', { timeout: 1000, exact: true });
      await expectNoButton(ctx, page, /Discuss with coach/, 'no "Discuss with coach" without an AI key');
    },
  },
  {
    name: 'workout detail: Garmin workout without any details shows only what exists',
    route: '/workouts/[id]',
    path: `/workouts/${W.garminOld}`,
    auth: 'signed-in',
    expect: ['Evening ride', 'Summary', '520 kcal', 'Garmin', '1 h 15 min'],
    async after(_page, ctx) {
      for (const absent of ['Average heart rate', 'Time in heart-rate zones', 'Training effect', 'Distance']) {
        await ctx.expectNoText(absent, { timeout: 600 });
      }
    },
  },
  {
    name: 'workout detail: manual workout without details, note about the energy budget, delete',
    route: '/workouts/[id]',
    path: `/workouts/${W.run}`,
    auth: 'signed-in',
    expect: ['Running, treadmill, general', 'Summary', 'Calories', '320 kcal', 'Counts toward your energy budget', 'Manual', 'Delete workout'],
    async after(page, ctx) {
      for (const absent of ['Average heart rate', 'Heart rate', 'Time in heart-rate zones', 'Training effect', 'Discuss with coach']) {
        await ctx.expectNoText(absent, { timeout: 600 });
      }
      await stepThen(ctx, 'ask to delete', () => clickButton(page, 'Delete workout', { exact: true }), async () => {
        await ctx.expectText('Delete this workout from your diary?');
        await ctx.check('nothing is deleted before the second tap', () => {
          if (ctx.backend.mutationsOf('exercise_entries', 'delete').length > 0) throw new Error('deleted already');
        });
        await stepThen(ctx, 'confirm', () => clickButton(page, 'Yes, delete it', { exact: true }), async () => {
          await ctx.expectMutation('exercise_entries', 'delete', (m) => m.filter.includes(W.run));
          await ctx.expectUrl(/\/workouts\/?(\?.*)?$/);
          await ctx.expectNoText('Running, treadmill, general', { timeout: 3000 });
        });
      });
    },
  },
  {
    name: 'workout detail: Apple Health workout is read-only',
    route: '/workouts/[id]',
    path: `/workouts/${W.strength}`,
    auth: 'signed-in',
    expect: ['Traditional Strength Training', 'Apple Health', '210 kcal', 'cannot be edited here'],
    async after(page, ctx) {
      await expectNoButton(ctx, page, /Delete workout/, 'a device workout cannot be deleted here');
      await ctx.expectNoText('Counts toward your energy budget', { timeout: 600 });
    },
  },
  {
    name: 'workout detail: unknown id shows "not found"',
    route: '/workouts/[id]',
    path: `/workouts/${IDS.missing}`,
    auth: 'signed-in',
    expect: ['Workout not found'],
    allowText: [/Workout not found/],
    async after(page, ctx) {
      await stepThen(ctx, 'back to the list', () => clickButton(page, 'Back to workouts', { exact: true }), () => ctx.expectUrl(/\/workouts\/?(\?.*)?$/));
    },
  },
  {
    name: 'workout detail: invalid id shows "not found" without asking the database',
    route: '/workouts/[id]',
    path: '/workouts/not-an-id',
    auth: 'signed-in',
    expect: ['Workout not found'],
    allowText: [/Workout not found/],
    async after(_page, ctx) {
      await ctx.check('no query was sent for it', () => {
        const asked = workoutQueries(ctx);
        if (asked.length > 0) throw new Error(`exercise_entries was queried: ${asked.join(' | ')}`);
      });
    },
  },
];
