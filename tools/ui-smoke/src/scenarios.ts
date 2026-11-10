/**
 * THE scenario list of the UI smoke run. Add a scenario by appending one object to SCENARIOS.
 *
 *   name       unique and descriptive (it becomes the screenshot file name and `--only` matches it)
 *   route      the expo-router pattern from apps/app/src/app (`/food/[id]`): every route file must be covered by at
 *              least one scenario, otherwise the run prints a warning (see routes-scan.ts)
 *   path       concrete URL to open (string, or a function of the fixtures)
 *   auth       'signed-in' pre-seeds the supabase session in localStorage; 'signed-out' leaves storage empty
 *   fixtures   'default' | 'imperial' | 'not-onboarded' | 'empty-diary' (src/fixtures.ts)
 *   expect     texts that must be visible after load
 *   setup      runs BEFORE navigation (page.route tweaks, init scripts, backend data)
 *   after      runs AFTER load + settle: interactions and assertions through `ctx`
 *
 * Interactions go through `ctx.step` (a failure is a WARN: usually a selector that needs adjusting) and
 * assertions through `ctx.expect*` / `ctx.check` (a failure is a FAIL). Use `stepThen` to assert only when the
 * interaction itself worked, so a bad selector is reported once.
 */
import type { Page } from 'playwright-core';

import { choose, clickButton, clickTab, clickText, closeSheet, fill, scrollToText } from './actions';
import { truncatedTextScript } from './browser-scripts';
import { BARCODES, IDS, USER, addDays } from './fixtures';
import { SIGNUP_EXPIRED_CODE, SIGNUP_VALID_CODE } from './signup-function';
import type { Scenario, ScenarioContext } from './types';

const F = IDS.food;
const payloadOf = (m: { payload: unknown }): Record<string, unknown> => (m.payload ?? {}) as Record<string, unknown>;
const rowsOf = (m: { payload: unknown }): Record<string, unknown>[] => (Array.isArray(m.payload) ? m.payload : [m.payload]) as Record<string, unknown>[];

/** Runs an interaction; runs the follow-up assertions only when the interaction worked. */
async function stepThen(ctx: ScenarioContext, label: string, act: () => Promise<unknown>, then: () => Promise<unknown>): Promise<void> {
  if (await ctx.step(label, act)) await then();
}

async function openRow(page: Page, name: RegExp): Promise<void> {
  await page.getByRole('button', { name }).first().click({ timeout: 6000 });
}

// ------------------------------------------------------------------------------------------ create account helpers

/** A new person's data for the sign-up form (the e-mail is not in the fixtures). */
const NEW_FRIEND = { email: 'new.friend@example.com', password: 'a-good-password' };

/** Fills the "Create account" form (the invite code the way a person pastes it: lower case, spaces instead of dashes). */
async function fillCreateAccount(page: Page, form: { email?: string; password?: string; confirm?: string; code?: string } = {}): Promise<void> {
  await fill(page, 'Email', form.email ?? NEW_FRIEND.email);
  await fill(page, 'Password', form.password ?? NEW_FRIEND.password);
  await fill(page, 'Confirm password', form.confirm ?? NEW_FRIEND.password);
  await fill(page, 'Invite code', form.code ?? SIGNUP_VALID_CODE.toLowerCase().replace(/-/g, ' '));
}

/** Calls of the sign-up function so far, as "<status>". */
const signUpCalls = (ctx: ScenarioContext): number[] => ctx.backend.calls.filter((c) => c.kind === 'function' && c.target === 'sign-up').map((c) => c.status);

// ------------------------------------------------------------------------------------------ diary copy / paste helpers

const MG = IDS.mealGroup;

/** Number of buttons with this accessible name (a string is an exact name). Toasts and sheets are text, menus are buttons. */
const buttonCount = (page: Page, name: string | RegExp): Promise<number> => page.getByRole('button', { name, exact: typeof name === 'string' }).count();

/** Opens a meal group's "..." menu and picks an action (the menu items are buttons named exactly like their label). */
async function pickGroupAction(page: Page, group: string, action: string | RegExp): Promise<void> {
  await clickButton(page, `${group} options`, { exact: true });
  await clickButton(page, action, typeof action === 'string' ? { exact: true } : {});
}

/** Opens the date bar's "..." menu and picks an action. */
async function pickDateAction(page: Page, action: string): Promise<void> {
  await clickButton(page, 'More diary actions', { exact: true });
  await clickButton(page, action, { exact: true });
}

type MockRow = Record<string, unknown>;

/** diary_entries of one day (optionally one meal group), as the mock database holds them right now. */
const entriesOn = (ctx: ScenarioContext, date: string, group?: string): MockRow[] =>
  ctx.backend.rows('diary_entries').filter((e) => e.entry_date === date && (group === undefined || e.meal_group_id === group));

/** Every diary row ordered by id, as JSON: two snapshots are equal when no entry was added, removed or changed. */
const diarySnapshot = (ctx: ScenarioContext): string =>
  JSON.stringify(ctx.backend.rows('diary_entries').slice().sort((a, b) => String(a.id).localeCompare(String(b.id))));

/** Committed writes to diary_entries so far ("insert diary_entries", ...). */
const diaryWrites = (ctx: ScenarioContext): string[] => ctx.backend.mutations.filter((m) => m.table === 'diary_entries').map((m) => `${m.op} ${m.table}`);

/** Polls a condition on the mock backend (writes are async); throws when it does not become true. */
async function waitUntil(page: Page, label: string, condition: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Not true after ${timeoutMs} ms: ${label}`);
    await page.waitForTimeout(100);
  }
}

/** Top edge of the first button with this accessible name (to compare the order of rows on screen). */
async function rowTop(page: Page, name: RegExp): Promise<number> {
  const box = await page.getByRole('button', { name }).first().boundingBox({ timeout: 6000 });
  if (!box) throw new Error(`${String(name)} is not visible`);
  return box.y;
}

/** 1234 -> "1,234" (what formatNumber prints). */
const thousands = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Energy of the entries as the app computes it: kcal per 100 g of each food times the eaten grams. */
function kcalOf(ctx: ScenarioContext, entries: MockRow[]): number {
  const foods = ctx.backend.rows('foods');
  return entries.reduce((sum, e) => {
    const nutrients = (foods.find((f) => f.id === e.food_id)?.nutrients ?? {}) as Record<string, number>;
    return sum + ((nutrients.ENERGY_KCAL ?? 0) * Number(e.grams)) / 100;
  }, 0);
}

export const SCENARIOS: Scenario[] = [
  // ------------------------------------------------------------------------------------------ auth
  {
    name: 'sign-in: wrong password, then success',
    route: '/sign-in',
    path: '/sign-in',
    auth: 'signed-out',
    expect: ['Sign in', 'New here? Ask the app owner for an invite code', 'Create account'],
    allowBackendErrors: ['/auth/v1/token'],
    async after(page, ctx) {
      await stepThen(
        ctx,
        'submit a wrong password',
        async () => {
          await fill(page, 'Email', USER.email);
          await fill(page, 'Password', 'wrong-password');
          await clickButton(page, 'Sign in', { exact: true });
        },
        async () => {
          await ctx.expectText('Invalid login credentials');
          await ctx.snapshot('wrong-password', { tall: false });
        },
      );
      await stepThen(
        ctx,
        'sign in with the right password',
        async () => {
          await fill(page, 'Password', USER.password);
          await clickButton(page, 'Sign in', { exact: true });
        },
        async () => {
          await ctx.expectText('Dashboard', { timeout: 15_000 });
          await ctx.expectUrl(/^https:\/\/app\.test\/?(\?.*)?$/);
          await ctx.check('the password grant was called with the typed credentials', () => {
            if (!ctx.backend.calls.some((c) => c.kind === 'auth' && c.target === '/token' && c.status === 200)) throw new Error('no successful /auth/v1/token call');
          });
        },
      );
    },
  },
  {
    name: 'sign-in: create account with an invite code, then the onboarding wizard',
    route: '/sign-in',
    path: '/sign-in',
    auth: 'signed-out',
    expect: ['Sign in'],
    async after(page, ctx) {
      await stepThen(
        ctx,
        'open the Create account form',
        () => clickButton(page, 'Create account', { exact: true }),
        async () => {
          await ctx.expectText('You need an invite code from the app owner');
          await ctx.expectText('Confirm password');
          await ctx.expectText('Already have an account?');
        },
      );
      await stepThen(
        ctx,
        'fill the form and submit it',
        async () => {
          await fillCreateAccount(page);
          await clickButton(page, 'Create account', { exact: true });
        },
        async () => {
          await ctx.expectText('About you', { timeout: 15_000 });
          await ctx.expectText('Step 1 of 6');
          await ctx.expectUrl(/\/onboarding/);
          await ctx.check('the function created exactly one account and spent the code', () => {
            if (JSON.stringify(signUpCalls(ctx)) !== '[201]') throw new Error(`sign-up calls: ${JSON.stringify(signUpCalls(ctx))}`);
            if (ctx.backend.inviteUses(SIGNUP_VALID_CODE) !== 1) throw new Error('the invite code was not consumed');
            const profile = ctx.backend.rows('profiles').find((p) => p.display_name === 'new.friend');
            if (!profile || profile.onboarded !== false) throw new Error('no fresh (not onboarded) profile for the new user');
          });
          await ctx.check('the new user signed in with the password they chose', () => {
            if (!ctx.backend.calls.some((c) => c.kind === 'auth' && c.target === '/token' && c.status === 200)) throw new Error('no successful /auth/v1/token call');
          });
        },
      );
    },
  },
  {
    name: 'sign-in: create account shows the code as typed and refuses a wrong or expired invite code',
    route: '/sign-in',
    path: '/sign-in',
    auth: 'signed-out',
    expect: ['Sign in'],
    async after(page, ctx) {
      await stepThen(
        ctx,
        'type an unknown invite code',
        async () => {
          await clickButton(page, 'Create account', { exact: true });
          await fillCreateAccount(page, { code: 'zzzz zzzz zzzz' });
        },
        async () => {
          await ctx.expectInputValue('Invite code', 'ZZZZ-ZZZZ-ZZZZ'); // upper-cased and grouped as typed
          await clickButton(page, 'Create account', { exact: true });
          await ctx.expectText('That invite code is not valid.');
          await ctx.snapshot('wrong-invite-code', { tall: false });
        },
      );
      await stepThen(
        ctx,
        'try an expired invite code',
        async () => {
          await fill(page, 'Invite code', SIGNUP_EXPIRED_CODE);
          await clickButton(page, 'Create account', { exact: true });
        },
        async () => {
          await ctx.expectText('That code has expired.');
          await ctx.expectNoText('That invite code is not valid.');
        },
      );
      await ctx.check('no account was created and the screen stays on sign-in', () => {
        if (ctx.backend.rows('profiles').length !== 1) throw new Error('a profile was created');
        if (JSON.stringify(signUpCalls(ctx)) !== '[403,403]') throw new Error(`sign-up calls: ${JSON.stringify(signUpCalls(ctx))}`);
        if (!/sign-in/.test(page.url())) throw new Error(`left the sign-in page: ${page.url()}`);
      });
    },
  },
  {
    name: 'sign-in: create account with an e-mail that already has an account',
    route: '/sign-in',
    path: '/sign-in',
    auth: 'signed-out',
    expect: ['Sign in'],
    async after(page, ctx) {
      await stepThen(
        ctx,
        'submit the e-mail of the existing user',
        async () => {
          await clickButton(page, 'Create account', { exact: true });
          await fillCreateAccount(page, { email: USER.email });
          await clickButton(page, 'Create account', { exact: true });
        },
        async () => {
          await ctx.expectText('An account with this e-mail already exists. Try signing in.');
          await ctx.check('the code was given back', () => {
            if (ctx.backend.inviteUses(SIGNUP_VALID_CODE) !== 0) throw new Error('the invite code stayed consumed');
          });
        },
      );
    },
  },
  {
    name: 'sign-in: create account with mismatched passwords is refused before anything is sent',
    route: '/sign-in',
    path: '/sign-in',
    auth: 'signed-out',
    expect: ['Sign in'],
    async after(page, ctx) {
      await stepThen(
        ctx,
        'submit two different passwords',
        async () => {
          await clickButton(page, 'Create account', { exact: true });
          await fillCreateAccount(page, { confirm: 'another-password' });
          await clickButton(page, 'Create account', { exact: true });
        },
        async () => {
          await ctx.expectText('The passwords do not match.');
          await ctx.snapshot('mismatch', { tall: false });
          await ctx.check('nothing was sent to the server', () => {
            if (signUpCalls(ctx).length !== 0) throw new Error(`sign-up calls: ${JSON.stringify(signUpCalls(ctx))}`);
          });
        },
      );
      await stepThen(
        ctx,
        'a short password is refused too',
        async () => {
          await fill(page, 'Password', 'short');
          await fill(page, 'Confirm password', 'short');
          await clickButton(page, 'Create account', { exact: true });
        },
        async () => {
          await ctx.expectText('Use at least 8 characters.');
          await ctx.expectNoText('The passwords do not match.');
        },
      );
    },
  },
  {
    name: 'sign-in: switch between Create account and Sign in, then sign in',
    route: '/sign-in',
    path: '/sign-in',
    auth: 'signed-out',
    expect: ['Sign in'],
    async after(page, ctx) {
      await stepThen(
        ctx,
        'open Create account and come back',
        async () => {
          await fill(page, 'Email', USER.email);
          await clickButton(page, 'Create account', { exact: true });
        },
        async () => {
          await ctx.expectText('Confirm password');
          await ctx.expectInputValue('Email', USER.email); // the e-mail carries over
          await clickButton(page, 'Sign in', { exact: true });
          await ctx.expectNoText('Confirm password');
          await ctx.expectNoText('Invite code', { exact: true }); // the field label (the subtitle also mentions an "invite code")
          await ctx.expectText('New here? Ask the app owner for an invite code');
          await ctx.expectInputValue('Email', USER.email);
        },
      );
      await stepThen(
        ctx,
        'sign in after switching back',
        async () => {
          await fill(page, 'Password', USER.password);
          await clickButton(page, 'Sign in', { exact: true });
        },
        async () => {
          await ctx.expectText('Dashboard', { timeout: 15_000 });
          await ctx.check('no account was created on the way', () => {
            if (signUpCalls(ctx).length !== 0) throw new Error(`sign-up calls: ${JSON.stringify(signUpCalls(ctx))}`);
          });
        },
      );
    },
  },
  {
    name: 'signed-out visit of the dashboard redirects to sign-in',
    route: '/',
    path: '/',
    auth: 'signed-out',
    expect: ['Sign in'],
    async after(_page, ctx) {
      await ctx.expectUrl(/\/sign-in/);
    },
  },
  {
    name: 'signed-in visit of sign-in redirects to the dashboard',
    route: '/sign-in',
    path: '/sign-in',
    auth: 'signed-in',
    expect: ['Dashboard'],
    async after(page, ctx) {
      await ctx.check('left the sign-in page', () => {
        if (/sign-in/.test(page.url())) throw new Error(`still on ${page.url()}`);
      });
    },
  },

  // ------------------------------------------------------------------------------------------ onboarding
  {
    name: 'first run: signed-in user without onboarding lands on the wizard',
    route: '/onboarding',
    path: '/',
    auth: 'signed-in',
    fixtures: 'not-onboarded',
    expect: ['About you', 'Step 1 of 6'],
    async after(_page, ctx) {
      await ctx.expectUrl(/\/onboarding/);
    },
  },
  {
    name: 'onboarding wizard: fill all six steps and finish',
    route: '/onboarding',
    path: '/onboarding',
    auth: 'signed-in',
    fixtures: 'not-onboarded',
    expect: ['About you', 'Step 1 of 6'],
    async after(page, ctx) {
      const next = async (nextStep: number) => {
        await clickButton(page, 'Next', { exact: true });
        await ctx.expectText(`Step ${nextStep} of 6`);
      };
      await ctx.step('step 1: sex, birthdate, height', async () => {
        await choose(page, 'Male', { exact: true });
        await fill(page, 'Birthdate', '1992-03-15');
        await fill(page, 'Height (cm)', '182');
      });
      await ctx.step('go to step 2', () => next(2));
      await ctx.step('step 2: weight and body fat', async () => {
        await fill(page, 'Current weight (kg)', '82');
        await fill(page, 'Body fat (optional) (%)', '19.5');
      });
      await ctx.step('go to step 3', () => next(3));
      await ctx.step('step 3: activity level', () => choose(page, 'Lightly active'));
      await ctx.step('go to step 4', () => next(4));
      await ctx.step('step 4: lose 0.5 kg per week towards 77 kg', async () => {
        await choose(page, 'Lose', { exact: true });
        await fill(page, 'Weight to lose per week (kg/week)', '0.5');
        await fill(page, 'Target weight (optional) (kg)', '77');
      });
      await ctx.step('go to step 5', () => next(5));
      await ctx.step('step 5: balanced macros', () => choose(page, 'Balanced'));
      await ctx.step('go to step 6', () => next(6));
      await ctx.expectText('Your plan');
      await ctx.snapshot('summary');
      await stepThen(
        ctx,
        'finish setup',
        () => clickButton(page, 'Finish setup', { exact: true }),
        async () => {
          await ctx.expectMutation('biometrics', 'insert', (m) => rowsOf(m).some((r) => r.type === 'weight' && r.value === 82));
          await ctx.expectMutation('weight_goals', 'insert', (m) => payloadOf(m).start_weight_kg === 82 && payloadOf(m).rate_kg_per_week === -0.5);
          await ctx.expectMutation('macro_targets', 'insert', (m) => payloadOf(m).mode === 'ratios');
          await ctx.expectMutation('profiles', 'upsert', (m) => payloadOf(m).onboarded === true && payloadOf(m).sex === 'male' && payloadOf(m).birthdate === '1992-03-15');
          await ctx.expectText('Dashboard', { timeout: 15_000 });
        },
      );
    },
  },

  // ------------------------------------------------------------------------------------------ main tabs
  {
    name: 'dashboard',
    route: '/',
    path: '/',
    auth: 'signed-in',
    expect: ['Dashboard', 'Today'],
    async after(page, ctx) {
      await stepThen(ctx, 'open the diary from the dashboard', () => clickButton(page, 'Open diary'), () => ctx.expectUrl(/\/diary/));
    },
  },
  { name: 'dashboard: imperial units', route: '/', path: '/', auth: 'signed-in', fixtures: 'imperial', expect: ['Dashboard'] },
  { name: 'dashboard: empty diary', route: '/', path: '/', auth: 'signed-in', fixtures: 'empty-diary', expect: ['Dashboard'] },
  {
    name: 'diary: entries, entry sheet, edit and delete',
    route: '/diary',
    path: '/diary',
    auth: 'signed-in',
    expect: ['Breakfast', 'Lunch', 'Dinner', 'Snacks', 'Oats, rolled, dry', 'Ćevapi'],
    async after(page, ctx) {
      await stepThen(
        ctx,
        'open the oats entry',
        () => openRow(page, /Oats, rolled, dry/),
        async () => {
          await ctx.expectText('Delete entry');
          await ctx.snapshot('entry-sheet', { tall: false });
          await stepThen(
            ctx,
            'change the amount to 80 g and save',
            async () => {
              await fill(page, 'Amount (g)', '80');
              await clickButton(page, 'Save', { exact: true });
            },
            () => ctx.expectMutation('diary_entries', 'update', (m) => payloadOf(m).grams === 80),
          );
        },
      );
      await stepThen(
        ctx,
        'delete the apple entry',
        async () => {
          await openRow(page, /Apple, raw, with skin/);
          await clickText(page, 'Delete entry', { exact: true });
          await clickButton(page, 'Confirm delete');
        },
        () => ctx.expectMutation('diary_entries', 'delete'),
      );
      await ctx.step('scroll to the nutrient targets', () => scrollToText(page, 'Nutrient Targets'));
      await ctx.snapshot('nutrient-targets');
    },
  },
  {
    name: 'diary: an absurd amount in the entry sheet warns and offers grams',
    route: '/diary',
    path: '/diary',
    auth: 'signed-in',
    expect: ['Breakfast', 'Banana, raw'],
    async after(page, ctx) {
      await stepThen(
        ctx,
        'open the banana entry (1 x medium) and wait for its units',
        async () => {
          await openRow(page, /Banana, raw/);
          await ctx.expectText('Delete entry');
          await page.getByText('Unit', { exact: true }).first().waitFor({ state: 'visible', timeout: 6000 }); // portions loaded
        },
        async () => {
          // 100 x "medium" (118 g) = 11.8 kg
          await stepThen(ctx, 'type 100', () => fill(page, /^Amount/, '100'), async () => {
            await ctx.expectText('That is 11.8 kg - did you mean grams?');
            await ctx.snapshot('warning', { tall: false });
            await stepThen(ctx, 'tap "Use 100 g"', () => clickButton(page, 'Use 100 g', { exact: true }), async () => {
              await ctx.expectNoText('did you mean grams');
              await ctx.step('save', () => clickButton(page, 'Save', { exact: true }));
              await ctx.expectMutation('diary_entries', 'update', (m) => payloadOf(m).grams === 100);
            });
          });
        },
      );
    },
  },
  {
    name: 'diary: menus, tabs and day navigation',
    route: '/diary',
    path: '/diary',
    auth: 'signed-in',
    expect: ['Breakfast'],
    async after(page, ctx) {
      // Escape closes a sheet right away (the sheet does not animate on the web, see components/diary/Sheet.tsx).
      await stepThen(ctx, 'open the meal options of Breakfast', () => clickButton(page, 'Breakfast options'), async () => {
        await ctx.expectText('Add food to Breakfast');
        await ctx.snapshot('meal-menu', { tall: false });
        await ctx.step('press Escape', () => page.keyboard.press('Escape'));
        await ctx.expectNoText('Add food to Breakfast', { timeout: 3000 });
        // Whatever happened, leave no open scrim behind: it would swallow the clicks of the next steps.
        await ctx.step('make sure the menu is closed', async () => {
          if (await page.getByText('Add food to Breakfast').first().isVisible()) await closeSheet(page, 'Add food to Breakfast');
        });
      });
      // The scrim ("Close") works at any moment and does not depend on keyboard focus.
      await stepThen(ctx, 'open the diary actions', () => clickButton(page, 'More diary actions'), async () => {
        await ctx.expectText('Copy a day from');
        await ctx.step('close the diary actions', () => closeSheet(page, 'Copy a day from'));
      });
      // The tab names are "Exercise, 2" / "Body (biometric), 2" (phone) or "Biometric, 2" (wide): the visible text is
      // upper-case through CSS, the accessible name is not, hence role + name with a case-insensitive pattern.
      await stepThen(ctx, 'exercise tab', () => clickTab(page, /^exercise/i), async () => {
        await ctx.expectText('Running, treadmill, general');
        await ctx.snapshot('exercise-tab');
      });
      await stepThen(ctx, 'biometric tab', () => clickTab(page, /biometric/i), async () => {
        await ctx.expectText('Add biometric');
        await ctx.snapshot('biometric-tab');
      });
      await stepThen(ctx, 'note tab', () => clickTab(page, /^note/i), async () => {
        await ctx.expectText('Trening je išao odlično');
      });
      await ctx.step('back to the food tab', () => clickTab(page, /^food/i));
      await ctx.check('no tab label is truncated with an ellipsis', async () => {
        const truncated = await page.evaluate(truncatedTextScript('[role="tab"]'));
        if (Array.isArray(truncated) && truncated.length > 0) throw new Error(`truncated tab labels: ${truncated.join(', ')}`);
      });
      await stepThen(ctx, 'previous day', () => clickButton(page, 'Previous day', { exact: true }), async () => {
        await ctx.expectText('Salmon, Atlantic, farmed, raw');
        await ctx.snapshot('yesterday');
      });
    },
  },
  {
    name: 'diary: flat layout - one + and one ... per meal, full-width rows, collapse',
    route: '/diary',
    path: '/diary',
    auth: 'signed-in',
    expect: ['Breakfast', 'Oats, rolled, dry'],
    async after(page, ctx) {
      await ctx.check('every meal header has exactly one "+" and one "..." button', async () => {
        for (const group of ['Breakfast', 'Lunch', 'Dinner', 'Snacks']) {
          const adds = await buttonCount(page, `Add food to ${group}`);
          const menus = await buttonCount(page, `${group} options`);
          if (adds !== 1 || menus !== 1) throw new Error(`${group}: ${adds} "+" and ${menus} "..." buttons, expected one of each`);
        }
      });
      await ctx.check('entries run the full width of the list, like the tab strip (no card or box around them)', async () => {
        const first = await page.getByRole('tab', { name: /^food/i }).first().boundingBox({ timeout: 6000 });
        const last = await page.getByRole('tab', { name: /^note/i }).first().boundingBox({ timeout: 6000 });
        const row = await page.getByRole('button', { name: /^Oats, rolled, dry, / }).first().boundingBox({ timeout: 6000 });
        if (!first || !last || !row) throw new Error('the tab strip or the oats row is not visible');
        const strip = { x: first.x, width: last.x + last.width - first.x };
        if (Math.abs(row.x - strip.x) > 1 || Math.abs(row.width - strip.width) > 1) {
          throw new Error(`the row is ${row.width}px wide at x=${row.x}, the list is ${strip.width}px wide at x=${strip.x}`);
        }
      });
      await ctx.check('no swipe actions exist on the web (rows are deleted from the entry sheet there)', async () => {
        if ((await buttonCount(page, /^Delete /)) > 0) throw new Error('a "Delete <name>" swipe button is rendered on the web');
      });
      await ctx.snapshot('flat-diary');
      await stepThen(ctx, 'collapse Breakfast with its header', () => clickButton(page, /^Breakfast, .*Collapse/), async () => {
        await ctx.expectNoText('Oats, rolled, dry');
        await ctx.expectText('Lunch');
        await stepThen(ctx, 'expand Breakfast again', () => clickButton(page, /^Breakfast, .*Expand/), () => ctx.expectText('Oats, rolled, dry'));
      });
    },
  },
  {
    name: 'diary: add a saved meal to Lunch',
    route: '/diary',
    path: '/diary',
    auth: 'signed-in',
    expect: ['Breakfast'],
    async after(page, ctx) {
      // The saved meals action lives in the one "..." menu of the group (the header has no extra button for it).
      await ctx.check('the group header has no separate saved meals button', async () => {
        if ((await buttonCount(page, /^Saved meals for /)) > 0) throw new Error('a "Saved meals for ..." button is back in the header');
      });
      await stepThen(ctx, 'open the Lunch menu', () => clickButton(page, 'Lunch options', { exact: true }), async () => {
        await ctx.expectText('Add a saved meal to Lunch');
        await ctx.snapshot('saved-meal-menu', { tall: false });
        await stepThen(ctx, 'choose "Add a saved meal"', () => clickButton(page, 'Add a saved meal to Lunch...', { exact: true }), async () => {
          await ctx.expectText('Moj doručak');
          await ctx.snapshot('saved-meals-sheet', { tall: false });
          await stepThen(ctx, 'add "Moj doručak"', () => openRow(page, /^Moj doručak, 3 foods/), () =>
            ctx.expectMutation('diary_entries', 'insert', (m) => rowsOf(m).length === 3 && rowsOf(m).every((r) => r.source === 'copy' && r.meal_group_id === IDS.mealGroup.lunch)).then(() => undefined),
          );
        });
      });
    },
  },
  // ------------------------------------------------------------------------------------------ diary: copy / paste menus
  {
    name: "diary: Copy Yesterday's Group adds it to today, Undo removes it",
    route: '/diary',
    path: '/diary',
    auth: 'signed-in',
    expect: ['Breakfast', 'Oats, rolled, dry'],
    async after(page, ctx) {
      const today = ctx.fixtures.today;
      const before = diarySnapshot(ctx);
      await stepThen(ctx, 'open the Breakfast menu', () => clickButton(page, 'Breakfast options', { exact: true }), async () => {
        await ctx.expectText("Copy Yesterday's Group");
        await ctx.check('today offers no "Copy to Today" and, with an empty clipboard, no "Paste"', async () => {
          if ((await buttonCount(page, 'Copy to Today')) > 0) throw new Error('"Copy to Today" is offered on today');
          if ((await buttonCount(page, /^Paste /)) > 0) throw new Error('"Paste" is offered with an empty clipboard');
        });
        await ctx.snapshot('group-menu', { tall: false });
        await stepThen(ctx, "choose Copy Yesterday's Group", () => clickButton(page, "Copy Yesterday's Group", { exact: true }), async () => {
          // yesterday's breakfast: egg, bread, coffee -> three NEW entries in today's Breakfast
          await ctx.expectMutation(
            'diary_entries',
            'insert',
            (m) => rowsOf(m).length === 3 && rowsOf(m).every((r) => r.entry_date === today && r.meal_group_id === MG.breakfast && r.source === 'copy' && r.user_id === USER.id),
          );
          await ctx.expectText('Copied 3 items to Breakfast');
          await ctx.expectText('Egg, whole, raw');
          await stepThen(ctx, 'tap Undo', () => clickButton(page, 'Undo', { exact: true }), async () => {
            await ctx.expectMutation('diary_entries', 'delete');
            await ctx.expectText('Undone');
            await ctx.expectNoText('Egg, whole, raw');
            await ctx.check('the diary is exactly as before', () => waitUntil(page, 'rows restored', () => diarySnapshot(ctx) === before));
          });
        });
      });
    },
  },
  {
    name: 'diary: Copy Group, then Paste Group into other meals',
    route: '/diary',
    path: '/diary',
    auth: 'signed-in',
    expect: ['Breakfast', 'Chicken breast, roasted, skinless'],
    async after(page, ctx) {
      const today = ctx.fixtures.today;
      const lunch = entriesOn(ctx, today, MG.lunch);
      await stepThen(ctx, 'open the Snacks menu while the clipboard is empty', () => clickButton(page, 'Snacks options', { exact: true }), async () => {
        await ctx.expectText('Add food to Snacks');
        await ctx.check('there is no Paste action yet', async () => {
          if ((await buttonCount(page, /^Paste /)) > 0) throw new Error('"Paste" is offered with an empty clipboard');
        });
        await ctx.step('close the menu', () => closeSheet(page, 'Add food to Snacks'));
      });
      await stepThen(ctx, 'Copy Group on Lunch', () => pickGroupAction(page, 'Lunch', 'Copy Group'), async () => {
        await ctx.expectText(/Lunch copied to clipboard \(4 items\)/);
        await ctx.check('copying to the clipboard writes no diary entries', () => {
          if (diaryWrites(ctx).length > 0) throw new Error(`unexpected writes: ${diaryWrites(ctx).join(', ')}`);
        });
        await stepThen(ctx, 'Paste Group into Snacks', () => pickGroupAction(page, 'Snacks', 'Paste Group'), async () => {
          await ctx.expectMutation(
            'diary_entries',
            'insert',
            (m) => {
              const rows = rowsOf(m);
              return (
                rows.length === 4 &&
                rows.every((r) => r.entry_date === today && r.meal_group_id === MG.snacks && r.source === 'copy') &&
                lunch.every((l) => rows.some((r) => r.food_id === l.food_id && r.grams === l.grams && r.amount === l.amount && r.portion_label === l.portion_label))
              );
            },
          );
          await ctx.expectText('Pasted 4 items to Snacks');
          await ctx.snapshot('pasted', { tall: false });
          await ctx.check('Lunch itself is unchanged', () => {
            if (entriesOn(ctx, today, MG.lunch).length !== 4) throw new Error('the copied group lost entries');
          });
        });
        // the clipboard stays: it can be pasted again, into another meal
        await stepThen(ctx, 'Paste Group into Dinner', () => pickGroupAction(page, 'Dinner', 'Paste Group'), () =>
          ctx.expectMutation('diary_entries', 'insert', (m) => rowsOf(m).length === 4 && rowsOf(m).every((r) => r.meal_group_id === MG.dinner)).then(() => undefined),
        );
      });
    },
  },
  {
    name: 'diary: Copy Entry, then Paste Entry from a meal menu and from the entry sheet',
    route: '/diary',
    path: '/diary',
    auth: 'signed-in',
    expect: ['Breakfast', 'Oats, rolled, dry', 'Apple, raw, with skin'],
    async after(page, ctx) {
      const today = ctx.fixtures.today;
      const oatsInSnacks = () => entriesOn(ctx, today, MG.snacks).filter((e) => e.food_id === F.oats).length;
      await stepThen(ctx, 'open the oats entry', () => openRow(page, /Oats, rolled, dry/), async () => {
        await ctx.expectText('Delete entry');
        await ctx.check('with an empty clipboard on today: Copy Entry only', async () => {
          if ((await buttonCount(page, 'Copy Entry')) === 0) throw new Error('"Copy Entry" is missing');
          if ((await buttonCount(page, /^Paste /)) > 0) throw new Error('"Paste" is offered with an empty clipboard');
          if ((await buttonCount(page, 'Copy to Today')) > 0) throw new Error('"Copy to Today" is offered on today');
        });
        await ctx.snapshot('entry-sheet', { tall: false });
        await stepThen(ctx, 'Copy Entry', () => clickButton(page, 'Copy Entry', { exact: true }), async () => {
          await ctx.expectText(/Oats, rolled, dry copied to clipboard \(1 item\)/);
          await stepThen(ctx, 'Paste Entry from the Snacks menu', () => pickGroupAction(page, 'Snacks', 'Paste Entry'), async () => {
            await ctx.expectMutation(
              'diary_entries',
              'insert',
              (m) =>
                rowsOf(m).length === 1 &&
                rowsOf(m).every((r) => r.food_id === F.oats && r.grams === 60 && r.entry_date === today && r.meal_group_id === MG.snacks && r.source === 'copy'),
            );
            await ctx.expectText('Pasted 1 item to Snacks');
          });
        });
      });
      // The same clipboard is offered by the entry sheet of another entry and lands in THAT entry's meal group.
      await stepThen(ctx, 'open the apple entry', () => openRow(page, /Apple, raw, with skin/), async () => {
        await ctx.expectText('Delete entry');
        await stepThen(ctx, 'Paste Entry', () => clickButton(page, 'Paste Entry', { exact: true }), async () => {
          await ctx.check('the oats were pasted into Snacks (the apple\'s meal) a second time', () => waitUntil(page, 'second paste', () => oatsInSnacks() === 2));
        });
      });
    },
  },
  {
    name: 'diary: Copy to Today on a past day (group and entry)',
    route: '/diary',
    path: '/diary',
    auth: 'signed-in',
    expect: ['Breakfast'],
    async after(page, ctx) {
      const today = ctx.fixtures.today;
      const yesterday = addDays(today, -1);
      const dinnerToday = () => entriesOn(ctx, today, MG.dinner).length;
      const dinnerYesterday = entriesOn(ctx, yesterday, MG.dinner);
      const before = dinnerToday();
      await stepThen(ctx, 'go to yesterday', () => clickButton(page, 'Previous day', { exact: true }), async () => {
        await ctx.expectText('Salmon, Atlantic, farmed, raw');
        await stepThen(ctx, 'Dinner menu: Copy to Today', () => pickGroupAction(page, 'Dinner', 'Copy to Today'), async () => {
          await ctx.expectMutation(
            'diary_entries',
            'insert',
            (m) =>
              rowsOf(m).length === dinnerYesterday.length &&
              rowsOf(m).every((r) => r.entry_date === today && r.meal_group_id === MG.dinner && r.source === 'copy') &&
              dinnerYesterday.every((y) => rowsOf(m).some((r) => r.food_id === y.food_id && r.grams === y.grams)),
          );
          await ctx.expectText('Copied 4 items to Dinner on Today');
          await ctx.check('yesterday is untouched, today\'s Dinner has 4 more entries', () =>
            waitUntil(page, 'dinner copied', () => dinnerToday() === before + 4 && entriesOn(ctx, yesterday, MG.dinner).length === 4),
          );
        });
        await stepThen(ctx, 'open the salmon entry', () => openRow(page, /Salmon, Atlantic/), async () => {
          await ctx.expectText('Delete entry');
          await ctx.snapshot('entry-sheet-past-day', { tall: false });
          await stepThen(ctx, 'Copy to Today', () => clickButton(page, 'Copy to Today', { exact: true }), async () => {
            await ctx.expectMutation(
              'diary_entries',
              'insert',
              (m) => rowsOf(m).length === 1 && rowsOf(m).every((r) => r.food_id === F.salmon && r.entry_date === today && r.meal_group_id === MG.dinner && r.grams === 178 && r.source === 'copy'),
            );
            await ctx.expectText('Copied 1 item to Dinner on Today');
            await ctx.check('today\'s Dinner has one more entry', () => waitUntil(page, 'entry copied', () => dinnerToday() === before + 5));
          });
        });
      });
      await stepThen(ctx, 'back to today', () => clickButton(page, 'Next day', { exact: true }), () => ctx.expectText('Today'));
    },
  },
  {
    name: 'diary: Delete group entries asks first, Undo puts the same rows back',
    route: '/diary',
    path: '/diary',
    auth: 'signed-in',
    expect: ['Snacks', 'Almonds, raw'],
    async after(page, ctx) {
      const today = ctx.fixtures.today;
      const before = diarySnapshot(ctx);
      const snackIds = entriesOn(ctx, today, MG.snacks).map((e) => String(e.id));
      await stepThen(ctx, 'Delete group entries on Snacks', () => pickGroupAction(page, 'Snacks', 'Delete group entries'), async () => {
        await ctx.expectText('Delete Snacks entries?');
        await ctx.expectText('You can undo it right after');
        await ctx.snapshot('confirm', { tall: false });
        await stepThen(ctx, 'Keep', () => clickButton(page, 'Keep', { exact: true }), async () => {
          await ctx.expectNoText('Delete Snacks entries?');
          await ctx.check('nothing was deleted', () => {
            if (ctx.backend.mutationsOf('diary_entries', 'delete').length > 0) throw new Error('"Keep" still deleted');
          });
        });
      });
      await stepThen(
        ctx,
        'ask again and confirm',
        async () => {
          await pickGroupAction(page, 'Snacks', 'Delete group entries');
          await clickButton(page, `Delete ${snackIds.length} items`, { exact: true });
        },
        async () => {
          await ctx.expectMutation('diary_entries', 'delete', (m) => m.rows === snackIds.length);
          await ctx.expectText('Deleted 3 items from Snacks');
          await ctx.expectNoText('Almonds, raw');
          await ctx.check('the Snacks rows are gone and the other meals are not', () => {
            if (entriesOn(ctx, today, MG.snacks).length !== 0) throw new Error('Snacks still has rows');
            if (entriesOn(ctx, today).length !== 12) throw new Error(`${entriesOn(ctx, today).length} rows left today, expected 12`);
          });
          await stepThen(ctx, 'tap Undo', () => clickButton(page, 'Undo', { exact: true }), async () => {
            await ctx.expectMutation('diary_entries', 'insert', (m) => rowsOf(m).length === snackIds.length && rowsOf(m).every((r) => snackIds.includes(String(r.id))));
            await ctx.expectText('Restored 3 items');
            await ctx.expectText('Almonds, raw');
            await ctx.check('the rows are back with identical values', () => waitUntil(page, 'rows restored', () => diarySnapshot(ctx) === before));
          });
        },
      );
    },
  },
  {
    name: 'diary: deleting an entry from its sheet shows Undo, Undo puts it back',
    route: '/diary',
    path: '/diary',
    auth: 'signed-in',
    expect: ['Snacks', 'Apple, raw, with skin'],
    async after(page, ctx) {
      const before = diarySnapshot(ctx);
      await stepThen(
        ctx,
        'delete the apple entry from its sheet',
        async () => {
          await openRow(page, /Apple, raw, with skin/);
          await clickText(page, 'Delete entry', { exact: true });
          await clickButton(page, 'Confirm delete');
        },
        async () => {
          await ctx.expectMutation('diary_entries', 'delete', (m) => m.rows === 1);
          await ctx.expectText('Deleted Apple, raw, with skin');
          await ctx.check('the entry is gone from the list', async () => {
            if ((await buttonCount(page, /^Apple, raw, with skin, /)) > 0) throw new Error('the deleted entry is still listed');
          });
          await stepThen(ctx, 'tap Undo', () => clickButton(page, 'Undo', { exact: true }), async () => {
            await ctx.expectMutation('diary_entries', 'insert', (m) => rowsOf(m).length === 1);
            await ctx.expectText('Restored 1 item');
            await ctx.check('the diary is exactly as before', () => waitUntil(page, 'rows restored', () => diarySnapshot(ctx) === before));
          });
        },
      );
    },
  },
  {
    name: 'diary: Show Nutrition Summary of a meal',
    route: '/diary',
    path: '/diary',
    auth: 'signed-in',
    expect: ['Breakfast', 'Oats, rolled, dry'],
    async after(page, ctx) {
      const today = ctx.fixtures.today;
      const breakfast = entriesOn(ctx, today, MG.breakfast);
      const kcal = Math.round(kcalOf(ctx, breakfast));
      const accepted = [kcal - 1, kcal, kcal + 1].map(thousands).join('|');
      await stepThen(ctx, 'Show Nutrition Summary on Breakfast', () => pickGroupAction(page, 'Breakfast', 'Show Nutrition Summary'), async () => {
        await ctx.expectText('Breakfast nutrition summary');
        await ctx.expectText('4 foods');
        // the headline stats and the rows carry their value in the accessible name ("Energy 483 kcal", "Sodium 40 mg")
        await ctx.check(`the energy of the meal is ${kcal} kcal`, () => page.getByLabel(new RegExp(`^Energy (${accepted}) kcal`)).first().waitFor({ state: 'visible', timeout: 6000 }));
        for (const label of ['Protein', 'Net Carbs', 'Fat']) {
          await ctx.check(`${label} is part of the headline`, () => page.getByLabel(new RegExp(`^${label} [\\d.,]+ g`)).first().waitFor({ state: 'visible', timeout: 6000 }));
        }
        for (const row of ['Fiber', 'Sodium', 'Calcium', 'Vitamin C']) {
          await ctx.check(`${row} is listed`, () => page.getByLabel(new RegExp(`^${row} [\\d.,]+ `)).first().waitFor({ state: 'visible', timeout: 6000 }));
        }
        await ctx.snapshot('summary', { tall: false });
        await ctx.step('close the summary', () => closeSheet(page, 'Breakfast nutrition summary'));
      });
    },
  },
  {
    name: "diary: copy yesterday's entire diary asks first when the day has food, Undo removes it",
    route: '/diary',
    path: '/diary',
    auth: 'signed-in',
    expect: ['Breakfast', 'Oats, rolled, dry'],
    async after(page, ctx) {
      const today = ctx.fixtures.today;
      const before = diarySnapshot(ctx);
      await stepThen(ctx, 'diary actions: Copy yesterday\'s entire diary', () => pickDateAction(page, "Copy yesterday's entire diary"), async () => {
        await ctx.expectText("Copy yesterday's entire diary?");
        await ctx.expectText('already has 15 items');
        await ctx.snapshot('confirm', { tall: false });
        await stepThen(ctx, 'Cancel', () => clickButton(page, 'Cancel', { exact: true }), async () => {
          await ctx.expectNoText("Copy yesterday's entire diary?");
          await ctx.check('nothing was copied', () => {
            if (ctx.backend.mutationsOf('diary_entries', 'insert').length > 0) throw new Error('"Cancel" still copied');
          });
        });
      });
      await stepThen(
        ctx,
        'ask again and confirm',
        async () => {
          await pickDateAction(page, "Copy yesterday's entire diary");
          await clickButton(page, 'Copy 12 items', { exact: true });
        },
        async () => {
          await ctx.expectMutation('diary_entries', 'insert', (m) => {
            const rows = rowsOf(m);
            const inGroup = (id: string) => rows.filter((r) => r.meal_group_id === id).length;
            return (
              rows.length === 12 &&
              rows.every((r) => r.entry_date === today && r.source === 'copy' && r.user_id === USER.id) &&
              inGroup(MG.breakfast) === 3 &&
              inGroup(MG.lunch) === 1 &&
              inGroup(MG.dinner) === 4 &&
              inGroup(MG.snacks) === 4
            );
          });
          await ctx.expectText('Copied 12 items to Today');
          await ctx.expectText('Salmon, Atlantic, farmed, raw');
          await stepThen(ctx, 'tap Undo', () => clickButton(page, 'Undo', { exact: true }), async () => {
            await ctx.expectMutation('diary_entries', 'delete', (m) => m.rows === 12);
            await ctx.expectText('Undone');
            await ctx.expectNoText('Salmon, Atlantic, farmed, raw');
            await ctx.check('the diary is exactly as before', () => waitUntil(page, 'rows restored', () => diarySnapshot(ctx) === before));
          });
        },
      );
    },
  },
  {
    name: "diary: copy yesterday's entire diary into an empty day needs no confirmation",
    route: '/diary',
    path: '/diary',
    auth: 'signed-in',
    expect: ['Breakfast'],
    async after(page, ctx) {
      const tomorrow = addDays(ctx.fixtures.today, 1);
      const todayCount = entriesOn(ctx, ctx.fixtures.today).length;
      await stepThen(ctx, 'go to tomorrow (nothing logged)', () => clickButton(page, 'Next day', { exact: true }), async () => {
        await ctx.expectText('Nothing logged yet');
        await stepThen(ctx, "diary actions: Copy yesterday's entire diary", () => pickDateAction(page, "Copy yesterday's entire diary"), async () => {
          await ctx.expectMutation(
            'diary_entries',
            'insert',
            (m) => rowsOf(m).length === todayCount && rowsOf(m).every((r) => r.entry_date === tomorrow && r.source === 'copy'),
          );
          await ctx.expectNoText("Copy yesterday's entire diary?", { timeout: 1500 });
          await ctx.expectText(`Copied ${todayCount} items to Tomorrow`);
          await ctx.expectText('Oats, rolled, dry');
          await ctx.snapshot('copied', { tall: false });
        });
      });
    },
  },
  {
    name: 'diary: Copy a day from... announces the copy and can undo it',
    route: '/diary',
    path: '/diary',
    auth: 'signed-in',
    expect: ['Breakfast'],
    async after(page, ctx) {
      const before = diarySnapshot(ctx);
      await stepThen(ctx, 'diary actions: Copy a day from...', () => pickDateAction(page, 'Copy a day from...'), async () => {
        await ctx.expectText(/12 items, [\d,]+ kcal/);
        await stepThen(ctx, 'copy the 12 items', () => clickButton(page, /^Copy 12 items to /), async () => {
          await ctx.expectMutation('diary_entries', 'insert', (m) => rowsOf(m).length === 12 && rowsOf(m).every((r) => r.source === 'copy'));
          await ctx.expectText('Copied 12 items to Today');
          await stepThen(ctx, 'tap Undo', () => clickButton(page, 'Undo', { exact: true }), async () => {
            await ctx.expectText('Undone');
            await ctx.check('the diary is exactly as before', () => waitUntil(page, 'rows restored', () => diarySnapshot(ctx) === before));
          });
        });
      });
    },
  },
  {
    name: 'diary: Create Recipe from Group opens the recipe editor with the foods',
    route: '/diary',
    path: '/diary',
    auth: 'signed-in',
    expect: ['Breakfast', 'Oats, rolled, dry'],
    async after(page, ctx) {
      const breakfast = entriesOn(ctx, ctx.fixtures.today, MG.breakfast);
      await stepThen(ctx, 'Create Recipe from Group on Breakfast', () => pickGroupAction(page, 'Breakfast', 'Create Recipe from Group'), async () => {
        await ctx.expectUrl(/\/recipe\/new/);
        await ctx.expectInputValue('Recipe name', 'Breakfast recipe');
        // every ingredient line is a button "<food>. <amount> g = <grams> g ..." (the diary rows read "<food>, <amount> g, ...")
        for (const [name, grams] of [
          ['Oats, rolled, dry', 60],
          ['Banana, raw', 118],
          ['Milk, whole, 3.25% fat', 244],
          ['Coffee, brewed', 237],
        ] as const) {
          await ctx.check(`ingredient ${name} (${grams} g)`, () =>
            page.getByRole('button', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. ${grams} g = ${grams} g`) }).first().waitFor({ state: 'visible', timeout: 8000 }),
          );
        }
        await ctx.snapshot('prefilled');
        await stepThen(ctx, 'save the recipe', () => page.getByRole('button', { name: /^Save recipe.*kcal per serving/ }).first().click({ timeout: 10_000 }), async () => {
          await ctx.expectMutation('foods', 'insert', (m) => payloadOf(m).kind === 'recipe' && payloadOf(m).name === 'Breakfast recipe');
          await ctx.expectMutation(
            'recipe_ingredients',
            'insert',
            (m) => rowsOf(m).length === 4 && breakfast.every((e) => rowsOf(m).some((r) => r.ingredient_food_id === e.food_id && r.grams === e.grams)),
          );
        });
      });
    },
  },
  {
    name: 'diary: Create Meal from Group saves the foods as a saved meal',
    route: '/diary',
    path: '/diary',
    auth: 'signed-in',
    expect: ['Dinner', 'Ćevapi'],
    async after(page, ctx) {
      const dinner = entriesOn(ctx, ctx.fixtures.today, MG.dinner);
      await stepThen(ctx, 'Create Meal from Group on Dinner', () => pickGroupAction(page, 'Dinner', 'Create Meal from Group'), async () => {
        await ctx.expectText('Save as meal');
        await ctx.expectInputValue('Saved meal name', 'Dinner');
        await ctx.snapshot('save-meal', { tall: false });
        await stepThen(
          ctx,
          'name it and save',
          async () => {
            await fill(page, 'Saved meal name', 'Večera');
            await clickButton(page, 'Save meal', { exact: true });
          },
          async () => {
            await ctx.expectMutation('saved_meals', 'insert', (m) => payloadOf(m).name === 'Večera');
            await ctx.expectMutation(
              'saved_meal_items',
              'insert',
              (m) => rowsOf(m).length === dinner.length && dinner.every((e) => rowsOf(m).some((r) => r.food_id === e.food_id && r.grams === e.grams)),
            );
            await ctx.expectText('Saved as');
          },
        );
      });
    },
  },
  {
    name: 'diary: Sort by Time flips the order of a meal (view only)',
    route: '/diary',
    path: '/diary',
    auth: 'signed-in',
    expect: ['Breakfast', 'Oats, rolled, dry', 'Coffee, brewed'],
    async after(page, ctx) {
      const oats = /^Oats, rolled, dry, /;
      const coffee = /^Coffee, brewed, /;
      await ctx.check('oldest first by default: oats above coffee', async () => {
        if ((await rowTop(page, oats)) >= (await rowTop(page, coffee))) throw new Error('oats are not above the coffee');
      });
      await stepThen(ctx, 'Sort by Time: newest first', () => pickGroupAction(page, 'Breakfast', 'Sort by Time: newest first'), async () => {
        await ctx.check('newest first: coffee above oats', async () => {
          if ((await rowTop(page, coffee)) >= (await rowTop(page, oats))) throw new Error('coffee is not above the oats');
        });
        await ctx.snapshot('newest-first', { tall: false });
        await ctx.check('sorting writes no diary entries', () => {
          if (diaryWrites(ctx).length > 0) throw new Error(`unexpected writes: ${diaryWrites(ctx).join(', ')}`);
        });
        await stepThen(ctx, 'Sort by Time: oldest first', () => pickGroupAction(page, 'Breakfast', 'Sort by Time: oldest first'), async () => {
          await ctx.check('oldest first again: oats above coffee', async () => {
            if ((await rowTop(page, oats)) >= (await rowTop(page, coffee))) throw new Error('oats are not above the coffee');
          });
        });
      });
    },
  },
  {
    name: 'diary: an empty day offers no copy, summary or delete actions',
    route: '/diary',
    path: '/diary',
    auth: 'signed-in',
    fixtures: 'empty-diary',
    expect: ['Breakfast', 'Nothing logged yet'],
    async after(page, ctx) {
      await stepThen(ctx, 'open the Breakfast menu', () => clickButton(page, 'Breakfast options', { exact: true }), async () => {
        await ctx.expectText('Add food to Breakfast');
        await ctx.check('only the actions that make sense for an empty meal', async () => {
          for (const name of ["Copy Yesterday's Group", 'Copy Group', 'Copy to Today', 'Create Recipe from Group', 'Create Meal from Group', 'Show Nutrition Summary', 'Delete group entries', /^Paste /, /^Sort by Time/]) {
            if ((await buttonCount(page, name)) > 0) throw new Error(`${String(name)} is offered for an empty meal`);
          }
          if ((await buttonCount(page, 'Copy Breakfast from another day...')) === 0) throw new Error('"Copy Breakfast from another day..." is missing');
        });
        await ctx.snapshot('empty-group-menu', { tall: false });
        await ctx.step('close the menu', () => closeSheet(page, 'Add food to Breakfast'));
      });
      await stepThen(ctx, 'open the diary actions', () => clickButton(page, 'More diary actions', { exact: true }), async () => {
        await ctx.expectText('Copy a day from');
        await ctx.check("no 'Copy yesterday's entire diary' when yesterday is empty", async () => {
          if ((await buttonCount(page, "Copy yesterday's entire diary")) > 0) throw new Error('offered although yesterday has nothing');
        });
        await ctx.step('close the diary actions', () => closeSheet(page, 'Copy a day from'));
      });
    },
  },
  {
    name: 'foods tab: favorites, recent, my foods, recipes, saved meals',
    route: '/foods',
    path: '/foods',
    auth: 'signed-in',
    expect: ['Foods', 'Favorites'],
    async after(page, ctx) {
      const tabs: [string, string][] = [
        ['Favorites', 'Chicken breast, skinless, boneless, raw'],
        ['Recent', 'Oats, rolled, dry'],
        ['My foods', 'Ćevapi'],
        ['Recipes', 'Piletina s rižom'],
        ['Saved meals', 'Moj doručak'],
      ];
      for (const [tab, expected] of tabs) {
        await stepThen(ctx, `open the ${tab} tab`, () => clickText(page, tab, { exact: true }), async () => {
          await ctx.expectText(expected);
          await ctx.snapshot(`tab-${tab}`, { tall: false });
        });
      }
    },
  },
  {
    name: 'foods tab: the scan button opens the scanner',
    route: '/foods',
    path: '/foods',
    auth: 'signed-in',
    expect: ['Foods', 'Favorites'],
    async after(page, ctx) {
      await stepThen(ctx, 'tap the Scan barcode button', () => clickButton(page, 'Scan barcode', { exact: true }), async () => {
        await ctx.expectUrl(/\/scan/);
        await ctx.expectText('Enter barcode');
      });
    },
  },
  {
    name: 'foods tab: empty states of a new account',
    route: '/foods',
    path: '/foods',
    auth: 'signed-in',
    fixtures: 'fresh-account',
    expect: ['Foods', 'No favorites yet'],
    async after(page, ctx) {
      const tabs: [string, string][] = [
        ['Recent', 'Foods you log will show up here'],
        ['My foods', 'You have not created any foods yet'],
        ['Recipes', 'No recipes yet'],
        ['Saved meals', 'No saved meals yet'],
      ];
      for (const [tab, expected] of tabs) {
        await stepThen(ctx, `open the ${tab} tab`, () => clickText(page, tab, { exact: true }), async () => {
          await ctx.expectText(expected);
          await ctx.snapshot(`empty-${tab}`, { tall: false });
        });
      }
    },
  },
  {
    name: 'more',
    route: '/more',
    path: '/more',
    auth: 'signed-in',
    expect: ['More', 'Profile & targets', 'Nutrient targets', 'Display & units', 'About', 'Sign out', USER.email],
  },
  {
    name: 'more: sign out',
    route: '/more',
    path: '/more',
    auth: 'signed-in',
    expect: ['Sign out'],
    async after(page, ctx) {
      await stepThen(ctx, 'tap Sign out', () => clickButton(page, 'Sign out', { exact: true }), async () => {
        await ctx.expectUrl(/\/sign-in/, 15_000);
        await ctx.expectText('Sign in');
      });
    },
  },

  // ------------------------------------------------------------------------------------------ add sheet and food logging
  {
    name: 'add sheet',
    route: '/add',
    path: '/add',
    auth: 'signed-in',
    expect: ['Adding to', 'Search food', 'Scan barcode', 'Create custom food', 'Add exercise', 'Add biometric', 'Add note', 'Add water'],
    async after(page, ctx) {
      await ctx.check('AI actions are hidden without a connected key', async () => {
        if (await page.getByText('Photo log').count()) throw new Error('"Photo log" is visible although AI is not connected');
      });
      await stepThen(ctx, 'tap Search food', () => clickButton(page, /Search food/), () => ctx.expectUrl(/\/search/));
    },
  },
  {
    name: 'add sheet: Scan barcode opens the scanner',
    route: '/add',
    path: '/add',
    auth: 'signed-in',
    expect: ['Scan barcode'],
    async after(page, ctx) {
      await stepThen(ctx, 'tap Scan barcode', () => clickButton(page, /^Scan barcode/), async () => {
        await ctx.expectUrl(/\/scan/);
        // The harness browser has no camera: the scanner shows why, and the typed entry is right there.
        await ctx.expectText('Enter barcode');
      });
    },
  },
  {
    name: 'search: chicken, ćevapi, online fallback',
    route: '/search',
    path: '/search',
    auth: 'signed-in',
    expect: ['Adding to', 'Recently used'],
    async after(page, ctx) {
      await stepThen(ctx, 'search for chicken', () => fill(page, 'Search foods', 'chicken'), async () => {
        await ctx.expectText('Chicken breast, roasted, skinless');
        await ctx.expectText('Chicken breast, skinless, boneless, raw');
        await ctx.snapshot('chicken');
      });
      await stepThen(ctx, 'search for cevapi (without the accent)', () => fill(page, 'Search foods', 'cevapi'), async () => {
        await ctx.expectText('Ćevapi');
        await ctx.check('the search RPC was called with the typed query', () => {
          if (!ctx.backend.calls.some((c) => c.kind === 'rpc' && c.target === 'search_foods' && c.status === 200)) throw new Error('no search_foods call');
        });
        await ctx.snapshot('cevapi');
      });
      await stepThen(ctx, 'ask for online results', () => clickButton(page, /Search online/), async () => {
        // Edge functions are not deployed in the mock: the screen must say so instead of crashing.
        await ctx.step('online search shows a friendly message', () => ctx.page.getByText(/not available|Try again later/i).first().waitFor({ state: 'visible', timeout: 8000 }));
        await ctx.snapshot('online-unavailable');
      });
      await stepThen(ctx, 'search for something that does not exist', () => fill(page, 'Search foods', 'zzzzzzzz'), async () => {
        await ctx.expectText('No foods found');
      });
    },
  },
  {
    name: 'search: tabs and quick add',
    route: '/search',
    path: '/search',
    auth: 'signed-in',
    expect: ['Recently used'],
    async after(page, ctx) {
      for (const [tab, expected] of [
        ['Favorites', 'Chicken breast, skinless, boneless, raw'],
        ['My foods', 'Ćevapi'],
      ] as const) {
        await stepThen(ctx, `open the ${tab} tab`, () => clickButton(page, tab, { exact: true }), () => ctx.expectText(expected));
      }
      await stepThen(
        ctx,
        'quick add Ćevapi with its +',
        () => page.getByRole('button', { name: /Quick add one serving of Ćevapi/ }).first().click({ timeout: 6000 }),
        async () => {
          await ctx.expectMutation('diary_entries', 'insert', (m) => payloadOf(m).food_id === F.cevapi);
        },
      );
    },
  },
  {
    name: 'search: the scan button next to the field opens the scanner and X comes back',
    route: '/search',
    path: '/search',
    auth: 'signed-in',
    expect: ['Adding to', 'Recently used'],
    async after(page, ctx) {
      await stepThen(ctx, 'tap the Scan barcode button', () => clickButton(page, 'Scan barcode', { exact: true }), async () => {
        await ctx.expectUrl(/\/scan\?(?=.*from=search)/);
        // No camera in the harness: the permission / fallback UI and the typed entry are shown.
        await ctx.expectText('Enter barcode');
        await ctx.expectText(/Camera (access needed|not available|access is blocked|could not start)/);
        await ctx.snapshot('scanner-fallback', { tall: false });
        await stepThen(ctx, 'close the scanner with the X', () => clickButton(page, 'Close', { exact: true }), async () => {
          await ctx.expectUrl(/\/search/);
          await ctx.expectText('Recently used');
        });
      });
    },
  },
  {
    name: 'search: in pick mode (adding an ingredient) the scan button stays and passes the pick context',
    route: '/search',
    path: '/search?mode=pick',
    auth: 'signed-in',
    expect: ['Choose a food to add'],
    async after(page, ctx) {
      await stepThen(ctx, 'tap the Scan barcode button', () => clickButton(page, 'Scan barcode', { exact: true }), async () => {
        await ctx.expectUrl(/\/scan\?(?=.*from=search)(?=.*mode=pick)/);
        await ctx.expectText('Enter barcode');
      });
    },
  },
  {
    name: 'food detail: change amount and add to the diary',
    route: '/food/[id]',
    path: `/food/${F.chickenRaw}`,
    auth: 'signed-in',
    expect: ['Chicken breast, skinless, boneless, raw', 'Serving', 'Add to diary'],
    async after(page, ctx) {
      // The amount is multiplied by the selected unit: the default is the "breast, boneless (174 g)" portion, so
      // grams have to be chosen first (typing 200 with the portion selected means 200 breasts, see the next scenario).
      await stepThen(
        ctx,
        'choose the g unit and set the amount to 200',
        async () => {
          await choose(page, /^g, 1 grams each$/);
          await fill(page, 'Amount', '200');
        },
        async () => {
          await ctx.expectText('= 200 g');
          await ctx.expectNoText('did you mean grams');
          await ctx.snapshot('amount-200g');
        },
      );
      await stepThen(ctx, 'add to the diary', () => clickButton(page, /^Add to diary/), async () => {
        // The confirmation only appears after the insert succeeded; it stays for under a second, so wait for it first.
        await ctx.expectText(/Added to /);
        await ctx.expectMutation('diary_entries', 'insert', (m) => payloadOf(m).food_id === F.chickenRaw && payloadOf(m).grams === 200 && payloadOf(m).entry_date === ctx.fixtures.today);
      });
    },
  },
  {
    name: 'food detail: an absurd amount warns and offers a one-tap switch to grams',
    route: '/food/[id]',
    path: `/food/${F.chickenRaw}`,
    auth: 'signed-in',
    expect: ['Chicken breast, skinless, boneless, raw', 'Serving', 'Add to diary'],
    async after(page, ctx) {
      // 200 x "breast, boneless (174 g)" = 34.8 kg: the app warns but does not block.
      await stepThen(ctx, 'type 200 with the portion unit selected', () => fill(page, 'Amount', '200'), async () => {
        await ctx.expectText('= 34800 g');
        await ctx.expectText('That is 34.8 kg - did you mean grams?');
        await ctx.snapshot('warning');
        await ctx.check('the warning does not block adding', async () => {
          if (!(await page.getByRole('button', { name: /^Add to diary/ }).first().isEnabled({ timeout: 3000 }))) throw new Error('"Add to diary" is disabled');
        });
        await stepThen(ctx, 'tap "Use 200 g"', () => clickButton(page, 'Use 200 g', { exact: true }), async () => {
          await ctx.expectText('= 200 g');
          await ctx.expectNoText('did you mean grams');
          await stepThen(ctx, 'add to the diary', () => clickButton(page, /^Add to diary/), async () => {
            await ctx.expectText(/Added to /);
            await ctx.expectMutation('diary_entries', 'insert', (m) => payloadOf(m).food_id === F.chickenRaw && payloadOf(m).grams === 200);
          });
        });
      });
    },
  },
  {
    name: 'food detail: portion units and favorite',
    route: '/food/[id]',
    path: `/food/${F.banana}`,
    auth: 'signed-in',
    expect: ['Banana, raw', 'Serving'],
    async after(page, ctx) {
      await stepThen(ctx, 'pick the "medium" unit', () => page.getByRole('radio', { name: /medium/ }).first().click({ timeout: 6000 }), async () => {
        await ctx.expectText('= 118 g');
      });
      // Banana is a favorite in the fixtures: the first tap removes it, the second adds it back.
      await stepThen(ctx, 'remove banana from the favorites', () => clickButton(page, 'Remove from favorites', { exact: true }), async () => {
        await ctx.expectMutation('favorites', 'delete', (m) => m.filter.includes(F.banana));
        await stepThen(ctx, 'add it back', () => clickButton(page, 'Add to favorites', { exact: true }), () =>
          ctx.expectMutation('favorites', 'upsert', (m) => payloadOf(m).food_id === F.banana).then(() => undefined),
        );
      });
    },
  },
  { name: 'food detail: rich micronutrients (salmon)', route: '/food/[id]', path: `/food/${F.salmon}`, auth: 'signed-in', expect: ['Salmon, Atlantic, farmed, raw', 'Vitamin D'] },
  { name: 'food detail: label-only branded food (Nutella)', route: '/food/[id]', path: `/food/${F.nutella}`, auth: 'signed-in', expect: ['Nutella hazelnut spread', 'Ferrero'] },
  { name: 'food detail: own custom food (Ćevapi)', route: '/food/[id]', path: `/food/${F.cevapi}`, auth: 'signed-in', expect: ['Ćevapi', 'Edit food'] },
  { name: 'food detail: AI estimate', route: '/food/[id]', path: `/food/${F.burekAi}`, auth: 'signed-in', expect: ['Burek sa sirom'] },
  { name: 'food detail: recipe food', route: '/food/[id]', path: `/food/${F.recipeChickenRice}`, auth: 'signed-in', expect: ['Piletina s rižom'] },
  { name: 'food detail: imperial units', route: '/food/[id]', path: `/food/${F.oats}`, auth: 'signed-in', fixtures: 'imperial', expect: ['Oats, rolled, dry'] },
  {
    name: 'food detail: unknown id shows "not found"',
    route: '/food/[id]',
    path: `/food/${IDS.missing}`,
    auth: 'signed-in',
    expect: ['Food not found'],
    allowText: [/Food not found/],
  },
  {
    name: 'food detail: invalid id shows "not found" without asking the database',
    route: '/food/[id]',
    path: '/food/not-a-uuid',
    auth: 'signed-in',
    // PostgREST rejects the uuid (22P02): the screen must show an error card, not crash.
    // The id is checked before it is queried: Postgres would answer "invalid input syntax for type uuid" (22P02),
    // which must never reach the user. The screen shows the same card as for an unknown id.
    expect: ['Food not found'],
    allowText: [/Food not found/],
    async after(_page, ctx) {
      await ctx.check('the invalid id never reached the backend', () => {
        const sent = ctx.backend.calls.filter((c) => c.query.includes('not-a-uuid') || c.path.includes('not-a-uuid'));
        if (sent.length > 0) throw new Error(`sent to the backend: ${sent.map((c) => `${c.method} ${c.target}`).join(', ')}`);
      });
      await ctx.expectNoText('invalid input syntax');
    },
  },
  {
    name: 'food edit: rename without touching nutrients (updated in place)',
    route: '/food/edit/[id]',
    path: `/food/edit/${F.cevapi}`,
    auth: 'signed-in',
    expect: ['Save changes'],
    // The name of the food is the VALUE of the name field, not page text.
    expectInputs: [{ field: 'Food name', value: 'Ćevapi' }],
    async after(page, ctx) {
      await stepThen(ctx, 'rename and save', async () => {
        await fill(page, 'Food name', 'Ćevapi (domaći)');
        await clickButton(page, 'Save changes', { exact: true });
      }, async () => {
        await ctx.expectMutation('foods', 'update', (m) => payloadOf(m).name === 'Ćevapi (domaći)');
        await ctx.check('the nutrients did not change, so no new version was needed', () => {
          if (ctx.backend.mutationsOf('rpc:supersede_food', 'rpc').length > 0) throw new Error('supersede_food was called for a rename');
        });
      });
    },
  },
  {
    name: 'food edit: changed nutrients of a logged food create a new version',
    route: '/food/edit/[id]',
    path: `/food/edit/${F.cevapi}`,
    auth: 'signed-in',
    expect: ['Save changes'],
    expectInputs: [{ field: 'Food name', value: 'Ćevapi' }],
    // The mock enforces the immutability trigger like the database does: the in-place update is rejected (23001).
    allowBackendErrors: ['23001'],
    async after(page, ctx) {
      await stepThen(ctx, 'change the energy and save', async () => {
        await fill(page, 'Energy', '270');
        await clickButton(page, 'Save changes', { exact: true });
      }, async () => {
        await ctx.expectMutation('rpc:supersede_food', 'rpc');
        await ctx.expectUrl(/\/food\/(?!edit)[0-9a-f-]{36}/); // replaced by the detail page of the new version
        await ctx.expectText('Ćevapi');
        await ctx.check('the logged version is archived and a new version holds the new energy', () => {
          const foods = ctx.backend.rows('foods');
          const old = foods.find((f) => f.id === F.cevapi);
          const next = foods.find((f) => f.supersedes === F.cevapi);
          if (old?.archived !== true) throw new Error('the logged version was not archived');
          if (!next || next.version !== 2 || (next.nutrients as Record<string, number>).ENERGY_KCAL !== 270) throw new Error(`unexpected new version: ${JSON.stringify(next?.nutrients ?? null)}`);
          if ((old.nutrients as Record<string, number>).ENERGY_KCAL !== 258) throw new Error('the logged version changed');
          if (!ctx.backend.rows('diary_entries').some((e) => e.food_id === F.cevapi)) throw new Error('the diary entries lost their food');
        });
      });
    },
  },
  {
    name: 'food new: create a custom food',
    route: '/food/new',
    path: '/food/new',
    auth: 'signed-in',
    expect: ['Food', 'Save food'],
    async after(page, ctx) {
      await stepThen(ctx, 'fill the form', async () => {
        await fill(page, 'Food name', 'Domaći hljeb');
        await fill(page, 'Energy', '250');
        await fill(page, 'Protein', '8');
        await fill(page, 'Carbohydrates', '48');
        await fill(page, 'Fat', '2');
        await fill(page, 'Serving name', 'kriška');
        await fill(page, 'Grams', '40');
      }, async () => {
        await ctx.snapshot('filled');
        await stepThen(ctx, 'save the food', () => clickButton(page, 'Save food', { exact: true }), async () => {
          await ctx.expectMutation('foods', 'insert', (m) => payloadOf(m).name === 'Domaći hljeb' && payloadOf(m).kind === 'custom' && payloadOf(m).owner_id === USER.id);
          await ctx.expectMutation('food_portions', 'insert', (m) => rowsOf(m).some((r) => r.unit === 'kriška' && r.grams === 40));
          await ctx.expectText('Saved');
        });
      });
    },
  },
  {
    name: 'food new: validation errors',
    route: '/food/new',
    path: '/food/new?name=Test&gtin=123',
    auth: 'signed-in',
    expect: ['Save food'],
    async after(page, ctx) {
      await stepThen(ctx, 'save the empty form', () => clickButton(page, 'Save food', { exact: true }), async () => {
        await ctx.expectText('Some fields need attention');
        await ctx.check('nothing was written', () => {
          if (ctx.backend.mutationsOf('foods', 'insert').length > 0) throw new Error('an invalid food was inserted');
        });
      });
    },
  },
  {
    name: 'scan: manual barcode entry works without camera access',
    route: '/scan',
    path: '/scan',
    auth: 'signed-in',
    expect: ['Enter barcode', 'Look up'],
    async after(page, ctx) {
      await ctx.snapshot('permission-denied', { tall: false });
      await stepThen(ctx, 'look up the Nutella barcode', async () => {
        await fill(page, 'Barcode digits', BARCODES.nutella);
        await clickButton(page, 'Look up', { exact: true });
      }, async () => {
        await ctx.expectUrl(new RegExp(`/food/${F.nutella}`), 12_000);
        await ctx.expectText('Nutella hazelnut spread');
      });
    },
  },
  {
    name: 'scan: unknown barcode degrades gracefully (lookup function not deployed)',
    route: '/scan',
    path: '/scan',
    auth: 'signed-in',
    expect: ['Enter barcode'],
    async after(page, ctx) {
      await stepThen(ctx, 'look up an unknown barcode', async () => {
        await fill(page, 'Barcode digits', BARCODES.unknown);
        await clickButton(page, 'Look up', { exact: true });
      }, async () => {
        await ctx.expectText(/Barcode lookup unavailable|Product not found/, { timeout: 12_000 });
        await ctx.snapshot('not-found');
      });
    },
  },
  {
    name: 'scan: invalid barcode is rejected',
    route: '/scan',
    path: '/scan',
    auth: 'signed-in',
    expect: ['Enter barcode'],
    async after(page, ctx) {
      await stepThen(ctx, 'look up "123"', async () => {
        await fill(page, 'Barcode digits', '123');
        await clickButton(page, 'Look up', { exact: true });
      }, () => ctx.expectText('A barcode has 8, 12, 13 or 14 digits'));
    },
  },

  // ------------------------------------------------------------------------------------------ activity forms
  {
    name: 'exercise: add a custom workout',
    route: '/exercise/new',
    path: '/exercise/new',
    auth: 'signed-in',
    expect: ['Logging to', 'Calories burned', 'Save exercise'],
    async after(page, ctx) {
      await stepThen(ctx, 'switch to a custom exercise and fill it', async () => {
        await choose(page, 'Custom exercise', { exact: true });
        await fill(page, 'Exercise name', 'Padel');
        await fill(page, 'Duration (minutes)', '45');
        await fill(page, 'Calories (kcal)', '300');
      }, async () => {
        await ctx.step('save', () => clickButton(page, 'Save exercise', { exact: true }));
        await ctx.expectMutation('exercise_entries', 'insert', (m) => payloadOf(m).name === 'Padel' && payloadOf(m).kcal === 300 && payloadOf(m).minutes === 45);
      });
    },
  },
  {
    name: 'exercise: pick a MET activity and save',
    route: '/exercise/new',
    path: '/exercise/new',
    auth: 'signed-in',
    expect: ['Calories burned'],
    async after(page, ctx) {
      await ctx.snapshot('activity-mode', { tall: false });
      await stepThen(ctx, 'search for running and pick the treadmill', async () => {
        await fill(page, /Search, e\.g\. running/, 'treadmill');
        await openRow(page, /^Running, treadmill, general/);
      }, async () => {
        await ctx.step('duration 30 minutes', () => fill(page, 'Duration (minutes)', '30'));
        await ctx.snapshot('picked');
        await stepThen(ctx, 'save', () => clickButton(page, 'Save exercise', { exact: true }), () =>
          ctx.expectMutation('exercise_entries', 'insert', (m) => payloadOf(m).activity_code === 'RUN_TREADMILL' && payloadOf(m).minutes === 30 && Number(payloadOf(m).kcal) > 0).then(() => undefined),
        );
      });
    },
  },
  {
    name: 'biometric: log weight',
    route: '/biometric/new',
    path: '/biometric/new',
    auth: 'signed-in',
    expect: ['Logging to', 'Previous:'],
    async after(page, ctx) {
      await stepThen(ctx, 'enter 79.6 kg and save', async () => {
        await fill(page, 'Weight (kg)', '79.6');
        await clickButton(page, 'Save', { exact: true });
      }, () => ctx.expectMutation('biometrics', 'insert', (m) => rowsOf(m).some((r) => r.type === 'weight' && r.value === 79.6 && r.unit === 'kg')));
    },
  },
  {
    name: 'biometric: blood pressure',
    route: '/biometric/new',
    path: '/biometric/new',
    auth: 'signed-in',
    expect: ['Logging to'],
    async after(page, ctx) {
      await stepThen(ctx, 'switch to blood pressure and fill it', async () => {
        await choose(page, /Blood pressure/);
        await fill(page, 'Systolic (top) (mmHg)', '121');
        await fill(page, 'Diastolic (bottom) (mmHg)', '79');
      }, async () => {
        await ctx.step('save', () => clickButton(page, 'Save', { exact: true }));
        await ctx.expectMutation('biometrics', 'insert', (m) => rowsOf(m).length === 2 && rowsOf(m).some((r) => r.type === 'bp_systolic' && r.value === 121));
      });
    },
  },
  {
    name: 'note: add a note',
    route: '/note/new',
    path: '/note/new',
    auth: 'signed-in',
    expect: ['Logging to', 'Save note'],
    async after(page, ctx) {
      await stepThen(ctx, 'write and save a note', async () => {
        await fill(page, /How did you feel/, 'Danas sam jeo manje slatkiša.');
        await clickButton(page, 'Save note', { exact: true });
      }, () => ctx.expectMutation('notes', 'insert', (m) => payloadOf(m).body === 'Danas sam jeo manje slatkiša.'));
    },
  },
  {
    name: 'water: quick amounts, custom amount, undo',
    route: '/water/new',
    path: '/water/new',
    auth: 'signed-in',
    expect: ["Today's total", 'Custom amount'],
    async after(page, ctx) {
      await stepThen(ctx, 'tap 500 mL', () => clickButton(page, /500 mL/), () => ctx.expectMutation('water_entries', 'insert', (m) => payloadOf(m).ml === 500));
      await stepThen(ctx, 'add a custom 400 mL', async () => {
        await fill(page, 'Custom amount (mL)', '400');
        await clickButton(page, 'Add custom amount', { exact: true });
      }, () => ctx.expectMutation('water_entries', 'insert', (m) => payloadOf(m).ml === 400));
      await stepThen(ctx, 'remove the last entry', () => clickButton(page, 'Remove last', { exact: true }), () => ctx.expectMutation('water_entries', 'delete'));
    },
  },

  // ------------------------------------------------------------------------------------------ recipes and saved meals
  {
    name: 'recipe new: pick an ingredient and save',
    route: '/recipe/new',
    path: '/recipe/new',
    auth: 'signed-in',
    expect: ['Ingredients', 'Add ingredient'],
    async after(page, ctx) {
      await ctx.step('name and servings', async () => {
        await fill(page, 'Recipe name', 'Zobena kaša s bananom');
        await fill(page, 'Number of servings', '2');
      });
      await stepThen(ctx, 'add the oats ingredient', async () => {
        await clickButton(page, 'Add ingredient', { exact: true });
        await ctx.expectUrl(/\/search\?.*mode=pick|mode=pick/);
        await fill(page, 'Search foods', 'oats');
        await page.getByText('Oats, rolled, dry').first().click({ timeout: 8000 });
      }, async () => {
        await ctx.expectUrl(/\/recipe\/new/);
        await ctx.expectText('Oats, rolled, dry');
        await ctx.snapshot('with-ingredient');
        await stepThen(ctx, 'save the recipe', () => clickButton(page, /Save recipe/), async () => {
          await ctx.expectMutation('foods', 'insert', (m) => payloadOf(m).kind === 'recipe' && payloadOf(m).name === 'Zobena kaša s bananom');
          await ctx.expectMutation('recipes', 'insert', (m) => payloadOf(m).servings === 2);
          await ctx.expectMutation('recipe_ingredients', 'insert', (m) => rowsOf(m).some((r) => r.ingredient_food_id === F.oats));
        });
      });
    },
  },
  {
    name: 'recipe detail',
    route: '/recipe/[id]',
    path: `/recipe/${F.recipeChickenRice}`,
    auth: 'signed-in',
    expect: ['Piletina s rižom', 'Edit recipe', 'Servings'],
    async after(page, ctx) {
      await stepThen(ctx, 'switch to per 100 g', () => clickButton(page, 'Per 100 g', { exact: true }), () => ctx.snapshot('per-100g'));
      // "Add 1 serving to diary" opens the food screen of the recipe, where the entry is confirmed.
      await stepThen(ctx, 'open "Add 1 serving to diary"', () => clickButton(page, /^Add 1 serving to diary/), async () => {
        await ctx.expectUrl(new RegExp(`/food/${F.recipeChickenRice}`));
        await ctx.expectText('Serving');
        await stepThen(ctx, 'confirm on the food screen', () => clickButton(page, /^Add to diary/), async () => {
          await ctx.expectText(/Added to /);
          await ctx.expectMutation('diary_entries', 'insert', (m) => payloadOf(m).food_id === F.recipeChickenRice && payloadOf(m).grams === 450);
        });
      });
    },
  },
  {
    name: 'recipe detail: invalid id shows "not found" without asking the database',
    route: '/recipe/[id]',
    path: '/recipe/not-a-uuid',
    auth: 'signed-in',
    expect: ['Recipe not found'],
    allowText: [/not found/i],
    async after(_page, ctx) {
      await ctx.check('the invalid id never reached the backend', () => {
        const sent = ctx.backend.calls.filter((c) => c.query.includes('not-a-uuid') || c.path.includes('not-a-uuid'));
        if (sent.length > 0) throw new Error(`sent to the backend: ${sent.map((c) => `${c.method} ${c.target}`).join(', ')}`);
      });
    },
  },
  {
    name: 'recipe edit',
    route: '/recipe/edit/[id]',
    path: `/recipe/edit/${F.recipeChickenRice}`,
    auth: 'signed-in',
    expect: ['Ingredients'],
    // The name of the recipe is the VALUE of the name field, not page text.
    expectInputs: [{ field: 'Recipe name', value: 'Piletina s rižom' }],
    // The recipe is logged (yesterday): changing what is in it changes its nutrients, the immutability trigger
    // rejects that in place (23001) and the app creates the next version with supersede_food.
    allowBackendErrors: ['23001'],
    async after(page, ctx) {
      await stepThen(ctx, 'change the chicken from 300 g to 250 g and save', async () => {
        await openRow(page, /^Chicken breast, skinless, boneless, raw\./);
        await fill(page, 'Amount', '250');
        await clickButton(page, /^Save changes/);
      }, async () => {
        await ctx.expectMutation('rpc:supersede_food', 'rpc');
        await ctx.expectUrl(new RegExp(`/recipe/(?!edit)(?!${F.recipeChickenRice})[0-9a-f-]{36}`)); // the NEW version
        await ctx.expectText('Saved as a new version');
        await ctx.check('the logged version is archived and the new one has the new amount', () => {
          const foods = ctx.backend.rows('foods');
          const next = foods.find((f) => f.supersedes === F.recipeChickenRice);
          if (foods.find((f) => f.id === F.recipeChickenRice)?.archived !== true) throw new Error('the logged recipe version was not archived');
          if (!next || next.version !== 2) throw new Error('no version 2 of the recipe');
          const chicken = ctx.backend.rows('recipe_ingredients').find((r) => r.recipe_food_id === next.id && r.ingredient_food_id === F.chickenRaw);
          if (chicken?.grams !== 250) throw new Error(`chicken in the new version: ${String(chicken?.grams)} g`);
          const old = ctx.backend.rows('recipe_ingredients').find((r) => r.recipe_food_id === F.recipeChickenRice && r.ingredient_food_id === F.chickenRaw);
          if (old?.grams !== 300) throw new Error('the logged version lost its ingredients');
        });
      });
    },
  },
  {
    name: 'recipe edit: a change that keeps the nutrients is saved in place',
    route: '/recipe/edit/[id]',
    path: `/recipe/edit/${F.recipeChickenRice}`,
    auth: 'signed-in',
    expect: ['Ingredients'],
    expectInputs: [{ field: 'Recipe name', value: 'Piletina s rižom' }],
    async after(page, ctx) {
      // Servings do not change the per-100 g nutrients, so the immutability trigger does not fire.
      await stepThen(ctx, 'change the servings to 3 and save', async () => {
        await fill(page, 'Number of servings', '3');
        await clickButton(page, /^Save changes/);
      }, async () => {
        await ctx.expectMutation('recipes', 'update', (m) => payloadOf(m).servings === 3);
        await ctx.check('no new version was created', () => {
          if (ctx.backend.mutationsOf('rpc:supersede_food', 'rpc').length > 0) throw new Error('supersede_food was called');
          if (ctx.backend.rows('foods').some((f) => f.supersedes === F.recipeChickenRice)) throw new Error('a new version exists');
        });
        await ctx.expectUrl(new RegExp(`/recipe/${F.recipeChickenRice}`));
      });
    },
  },
  {
    name: 'saved meal: view and log all items',
    route: '/saved-meal/[id]',
    path: `/saved-meal/${IDS.savedMeal.breakfast}`,
    auth: 'signed-in',
    expect: ['Oats, rolled, dry', 'Banana, raw'],
    // The name of the saved meal is the VALUE of the name field, not page text.
    expectInputs: [{ field: 'Saved meal name', value: 'Moj doručak' }],
    async after(page, ctx) {
      await stepThen(ctx, 'add the meal to the diary', () => clickButton(page, /Add 3 foods to/), () =>
        ctx.expectMutation('diary_entries', 'insert', (m) => rowsOf(m).length === 3 && rowsOf(m).every((r) => r.source === 'copy')),
      );
    },
  },
  {
    name: 'saved meal: invalid id shows "not found" without asking the database',
    route: '/saved-meal/[id]',
    path: '/saved-meal/not-a-uuid',
    auth: 'signed-in',
    expect: ['Saved meal not found'],
    allowText: [/not found/i],
    async after(_page, ctx) {
      await ctx.check('the invalid id never reached the backend', () => {
        const sent = ctx.backend.calls.filter((c) => c.query.includes('not-a-uuid') || c.path.includes('not-a-uuid'));
        if (sent.length > 0) throw new Error(`sent to the backend: ${sent.map((c) => `${c.method} ${c.target}`).join(', ')}`);
      });
    },
  },
  {
    name: 'saved meal: unknown id',
    route: '/saved-meal/[id]',
    path: `/saved-meal/${IDS.missing}`,
    auth: 'signed-in',
    expect: ['Saved meal not found'],
    allowText: [/not found/i],
  },
  {
    name: 'saved meal new: build from scratch',
    route: '/saved-meal/new',
    path: '/saved-meal/new',
    auth: 'signed-in',
    expect: ['Add food'],
    async after(page, ctx) {
      await ctx.step('name it', () => fill(page, 'Saved meal name', 'Užina'));
      await stepThen(ctx, 'add a food', async () => {
        await clickButton(page, 'Add food', { exact: true });
        await fill(page, 'Search foods', 'almonds');
        await page.getByText('Almonds, raw').first().click({ timeout: 8000 });
      }, async () => {
        await ctx.expectText('Almonds, raw');
        await stepThen(ctx, 'save the meal', () => clickButton(page, 'Save meal', { exact: true }), async () => {
          await ctx.expectMutation('saved_meals', 'insert', (m) => payloadOf(m).name === 'Užina');
          await ctx.expectMutation('saved_meal_items', 'insert', (m) => rowsOf(m).some((r) => r.food_id === F.almonds));
        });
      });
    },
  },

  // ------------------------------------------------------------------------------------------ settings
  {
    name: 'settings: profile & targets',
    route: '/settings/targets',
    path: '/settings/targets',
    auth: 'signed-in',
    expect: ['Macro & Energy Targets', 'Weight Goal', 'Energy calculation'],
    async after(page, ctx) {
      await ctx.step('scroll to the weight goal', () => scrollToText(page, 'Weight Goal'));
      await ctx.snapshot('weight-goal');
      await stepThen(ctx, 'switch the goal to maintain and save', async () => {
        await choose(page, 'Maintain', { exact: true });
        await clickButton(page, 'Save weight goal', { exact: true });
      }, () => ctx.expectMutation('weight_goals', 'update', (m) => payloadOf(m).rate_kg_per_week === 0));
    },
  },
  {
    name: 'settings: targets for a user without onboarding',
    route: '/settings/targets',
    path: '/settings/targets',
    auth: 'signed-in',
    fixtures: 'not-onboarded',
    // The root layout sends this user to the wizard.
    expect: ['About you'],
  },
  {
    name: 'settings: personal details and weight log',
    route: '/settings/profile',
    path: '/settings/profile',
    auth: 'signed-in',
    expect: ['Personal details', 'Log weight'],
    async after(page, ctx) {
      await stepThen(ctx, 'log a weight', async () => {
        await fill(page, 'Weight', '79.8');
        await clickButton(page, /Log weight for/);
      }, () => ctx.expectMutation('biometrics', 'insert', (m) => rowsOf(m).some((r) => r.type === 'weight' && r.value === 79.8)));
      await stepThen(ctx, 'change the display name and save', async () => {
        await fill(page, 'Display name', 'Demo Korisnik');
        await clickButton(page, 'Save details', { exact: true });
      }, () => ctx.expectMutation('profiles', 'update', (m) => payloadOf(m).display_name === 'Demo Korisnik'));
    },
  },
  {
    name: 'settings: nutrient targets, override a minimum',
    route: '/settings/nutrients',
    path: '/settings/nutrients',
    auth: 'signed-in',
    expect: ['Search nutrients'],
    async after(page, ctx) {
      await stepThen(ctx, 'search for magnesium', () => fill(page, 'Search nutrients', 'magnesium'), async () => {
        await ctx.expectText('Magnesium');
        // The 350 mg upper limit of magnesium covers supplements only: it is shown as information, never as a maximum.
        await ctx.expectText('At least 420 mg');
        await ctx.expectText('Upper limit 350 mg applies to supplements only');
        await ctx.expectNoText('420 to 350');
        await stepThen(ctx, 'open the editor', () => clickButton(page, /^Magnesium, .*Edit target/), async () => {
          await ctx.snapshot('editor', { tall: false });
          await ctx.expectInputValue('Minimum (mg)', '420');
          await ctx.expectInputValue('Maximum (mg)', '');
          await ctx.check('an untouched editor can be saved (no "minimum above maximum")', async () => {
            if (!(await page.getByRole('button', { name: 'Save', exact: true }).first().isEnabled({ timeout: 3000 }))) throw new Error('"Save" is disabled');
          });
          await stepThen(ctx, 'set a minimum of 500 and save', async () => {
            await fill(page, 'Minimum (mg)', '500');
            await clickButton(page, 'Save', { exact: true });
          }, async () => {
            await ctx.expectMutation(
              'nutrient_targets',
              'upsert',
              (m) => payloadOf(m).nutrient_code === 'MAGNESIUM_MG' && payloadOf(m).min_value === 500 && (payloadOf(m).max_value ?? null) === null,
            );
            await ctx.expectText('At least 500 mg');
          });
        });
      });
    },
  },
  {
    name: 'settings: display & units',
    route: '/settings/display',
    path: '/settings/display',
    auth: 'signed-in',
    expect: ['Units', 'Measurement system', 'Appearance'],
    async after(page, ctx) {
      await stepThen(ctx, 'switch to imperial units', () => choose(page, /Imperial/), async () => {
        await ctx.expectMutation('profiles', 'update', (m) => payloadOf(m).unit_system === 'imperial');
        await ctx.expectText('lb');
        await ctx.snapshot('imperial', { tall: false });
      });
    },
  },
  { name: 'settings: about', route: '/settings/about', path: '/settings/about', auth: 'signed-in', expect: ['Food data sources', 'Reference intakes'] },
  {
    name: 'settings: AI (not connected)',
    route: '/settings/ai',
    path: '/settings/ai',
    auth: 'signed-in',
    expect: ['OpenRouter', 'Connect'],
    async after(page, ctx) {
      await ctx.step('scroll to the privacy card', () => page.mouse.wheel(0, 2000));
      await ctx.snapshot('scrolled', { tall: false });
    },
  },

  {
    name: 'settings: connected apps & devices (web)',
    route: '/settings/integrations',
    path: '/settings/integrations',
    auth: 'signed-in',
    expect: ['Connected Apps & Devices', 'Energy mode'],
  },

  // ------------------------------------------------------------------------------------------ coach and AI screens (no key: gated)
  {
    name: 'coach: gated without an OpenRouter key',
    route: '/coach',
    path: '/coach',
    auth: 'signed-in',
    expect: [/The coach needs OpenRouter|Checking your AI connection/],
    async after(page, ctx) {
      await ctx.expectText('The coach needs OpenRouter');
      await ctx.check('no coach data was loaded behind the closed gate', () => {
        const touched = ctx.backend.calls.filter((c) => c.target === 'coach_threads' || c.target === 'coach_messages');
        if (touched.length > 0) throw new Error(`the coach queried ${touched.map((c) => c.target).join(', ')}`);
      });
      await stepThen(ctx, 'open Settings > AI from the panel', () => clickButton(page, /Open Settings > AI/), () => ctx.expectUrl(/\/settings\/ai/));
    },
  },
  {
    name: 'coach: history (gated)',
    route: '/coach/history',
    path: '/coach/history',
    auth: 'signed-in',
    expect: [/The coach needs OpenRouter|Checking your AI connection/],
  },
  {
    name: 'coach: thread (gated)',
    route: '/coach/[threadId]',
    path: `/coach/${IDS.thread['1']}`,
    auth: 'signed-in',
    expect: [/The coach needs OpenRouter|Checking your AI connection/],
  },
  {
    name: 'coach: an id that is not a thread falls back to a new chat',
    route: '/coach/[threadId]',
    path: '/coach/not-a-thread',
    auth: 'signed-in',
    expect: [/The coach needs OpenRouter|Checking your AI connection/],
    async after(_page, ctx) {
      await ctx.expectUrl(/\/coach\/?(\?.*)?$/);
    },
  },

  // ------------------------------------------------------------------------------------------ AI screens (no key: gated)
  { name: 'ai: describe a meal (AI not set up)', route: '/ai/describe', path: '/ai/describe', auth: 'signed-in', expect: ['AI is not set up'] },
  { name: 'ai: photo log (AI not set up)', route: '/ai/photo', path: '/ai/photo', auth: 'signed-in', expect: [/AI is not set up|Checking your AI connection/] },
  { name: 'ai: recipe from a description (AI not set up)', route: '/ai/recipe', path: '/ai/recipe', auth: 'signed-in', expect: [/AI is not set up|Checking your AI connection/] },

  // ------------------------------------------------------------------------------------------ app shell navigation
  {
    // Regression: the sidebar (wide) and the bottom bar (phone) rendered but did nothing when pressed, because the
    // expo-router/ui <TabTrigger>s were hidden inside custom components and never registered. Every other scenario
    // opens its page by URL, so this is the one place that clicks the real navigation.
    name: 'shell: main navigation (sidebar on desktop, tab bar on phone)',
    route: '/',
    path: '/',
    auth: 'signed-in',
    expect: ['Dashboard'],
    async after(page, ctx) {
      const navLink = (name: string) => page.getByRole('link', { name, exact: true }).first();
      // Each entry: the nav item, the URL it must lead to and a text that only that screen shows (so the screen
      // really switched, not just the address bar).
      const pages: { name: string; url: RegExp; text: string | RegExp }[] = [
        { name: 'Diary', url: /\/diary/, text: 'Breakfast' },
        { name: 'Foods', url: /\/foods/, text: 'Favorites' },
        { name: 'More', url: /\/more/, text: 'Sign out' },
        { name: 'Dashboard', url: /^https?:\/\/[^/]+\/?(\?.*)?$/, text: 'Logging streak' },
      ];
      for (const target of pages) {
        await stepThen(ctx, `open ${target.name} from the navigation`, () => navLink(target.name).click({ timeout: 6000 }), async () => {
          await ctx.expectUrl(target.url);
          await ctx.expectText(target.text);
        });
      }
      await stepThen(ctx, 'open the add sheet from the navigation', () => clickButton(page, 'Add to diary'), () => ctx.expectUrl(/\/add/));
    },
  },
];
