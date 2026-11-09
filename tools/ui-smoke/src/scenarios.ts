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

import { choose, clickButton, clickTab, clickText, fill, findField, scrollToText } from './actions';
import { BARCODES, IDS, USER } from './fixtures';
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

async function escape(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
}

export const SCENARIOS: Scenario[] = [
  // ------------------------------------------------------------------------------------------ auth
  {
    name: 'sign-in: wrong password, then success',
    route: '/sign-in',
    path: '/sign-in',
    auth: 'signed-out',
    expect: ['Sign in', 'Accounts are created by the app owner'],
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
    name: 'diary: menus, tabs and day navigation',
    route: '/diary',
    path: '/diary',
    auth: 'signed-in',
    expect: ['Breakfast'],
    async after(page, ctx) {
      await stepThen(ctx, 'open the meal options of Breakfast', () => clickButton(page, 'Breakfast options'), async () => {
        await ctx.expectText('Add food to Breakfast');
        await ctx.snapshot('meal-menu', { tall: false });
        await escape(page);
      });
      await stepThen(ctx, 'open the diary actions', () => clickButton(page, 'More diary actions'), async () => {
        await ctx.expectText('Copy a day from');
        await escape(page);
      });
      await stepThen(ctx, 'exercise tab', () => clickTab(page, /Exercise/), async () => {
        await ctx.expectText('Running, treadmill, general');
        await ctx.snapshot('exercise-tab');
      });
      await stepThen(ctx, 'biometric tab', () => clickTab(page, /Biometric/), async () => {
        await ctx.expectText('Add biometric');
        await ctx.snapshot('biometric-tab');
      });
      await stepThen(ctx, 'note tab', () => clickTab(page, /Note/), async () => {
        await ctx.expectText('Trening je išao odlično');
      });
      await ctx.step('back to the food tab', () => clickTab(page, /^Food/));
      await stepThen(ctx, 'previous day', () => clickButton(page, 'Previous day', { exact: true }), async () => {
        await ctx.expectText('Salmon, Atlantic, farmed, raw');
        await ctx.snapshot('yesterday');
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
      await stepThen(ctx, 'open the saved meal menu of Lunch', () => clickButton(page, 'Saved meals for Lunch'), async () => {
        await ctx.expectText('Add a saved meal to Lunch');
        await ctx.snapshot('saved-meal-menu', { tall: false });
        await stepThen(ctx, 'choose "Add a saved meal"', () => clickText(page, /Add a saved meal to Lunch/), async () => {
          await ctx.expectText('Moj doručak');
          await ctx.snapshot('saved-meals-sheet', { tall: false });
          await stepThen(ctx, 'add "Moj doručak"', () => openRow(page, /^Moj doručak, 3 foods/), () =>
            ctx.expectMutation('diary_entries', 'insert', (m) => rowsOf(m).length === 3 && rowsOf(m).every((r) => r.source === 'copy' && r.meal_group_id === IDS.mealGroup.lunch)).then(() => undefined),
          );
        });
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
    name: 'food detail: change amount and add to the diary',
    route: '/food/[id]',
    path: `/food/${F.chickenRaw}`,
    auth: 'signed-in',
    expect: ['Chicken breast, skinless, boneless, raw', 'Serving', 'Add to diary'],
    async after(page, ctx) {
      await stepThen(ctx, 'set the amount to 200 g', () => fill(page, 'Amount', '200'), async () => {
        await ctx.expectText('= 200 g');
        await ctx.snapshot('amount-200g');
      });
      await stepThen(ctx, 'add to the diary', () => clickButton(page, /Add to diary/), async () => {
        await ctx.expectMutation('diary_entries', 'insert', (m) => payloadOf(m).food_id === F.chickenRaw && payloadOf(m).grams === 200 && payloadOf(m).entry_date === ctx.fixtures.today);
        await ctx.expectText('Added');
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
      await stepThen(ctx, 'toggle the favorite star', () => clickButton(page, /favorites/i), () =>
        ctx.expectMutation('favorites', 'upsert', (m) => payloadOf(m).food_id === F.banana).then(() => undefined),
      );
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
    name: 'food detail: invalid id degrades gracefully',
    route: '/food/[id]',
    path: '/food/not-a-uuid',
    auth: 'signed-in',
    // PostgREST rejects the uuid (22P02): the screen must show an error card, not crash.
    expect: [/Could not load this food|Food not found/],
    allowBackendErrors: ['22P02'],
    allowText: [/Could not load/],
  },
  {
    name: 'food edit: rename without touching nutrients, then change nutrients (new version)',
    route: '/food/edit/[id]',
    path: `/food/edit/${F.cevapi}`,
    auth: 'signed-in',
    expect: ['Ćevapi', 'Save changes'],
    async after(page, ctx) {
      await stepThen(ctx, 'rename and save', async () => {
        await fill(page, 'Food name', 'Ćevapi (domaći)');
        await clickButton(page, 'Save changes', { exact: true });
      }, async () => {
        await ctx.expectMutation('foods', 'update', (m) => payloadOf(m).name === 'Ćevapi (domaći)');
      });
    },
  },
  {
    name: 'food edit: changed nutrients of a logged food create a new version',
    route: '/food/edit/[id]',
    path: `/food/edit/${F.cevapi}`,
    auth: 'signed-in',
    expect: ['Ćevapi', 'Save changes'],
    allowBackendErrors: ['23001'],
    async after(page, ctx) {
      await stepThen(ctx, 'change the energy and save', async () => {
        await fill(page, 'Energy', '270');
        await clickButton(page, 'Save changes', { exact: true });
      }, async () => {
        // The immutability trigger rejects the in-place update; the app then calls supersede_food.
        await ctx.expectMutation('rpc:supersede_food', 'rpc');
        await ctx.expectText('Ćevapi');
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
      await stepThen(ctx, 'add one serving to the diary', () => clickButton(page, /Add 1 serving to diary/), () =>
        ctx.expectMutation('diary_entries', 'insert', (m) => payloadOf(m).food_id === F.recipeChickenRice).then(() => undefined),
      );
    },
  },
  {
    name: 'recipe edit',
    route: '/recipe/edit/[id]',
    path: `/recipe/edit/${F.recipeChickenRice}`,
    auth: 'signed-in',
    expect: ['Piletina s rižom', 'Ingredients'],
    allowBackendErrors: ['23001'],
    async after(page, ctx) {
      await stepThen(ctx, 'change the servings and save', async () => {
        await fill(page, 'Number of servings', '3');
        await clickButton(page, /Save/);
      }, async () => {
        // The recipe is logged (yesterday): the DB trigger forces a new version.
        await ctx.expectMutation('rpc:supersede_food', 'rpc');
      });
    },
  },
  {
    name: 'saved meal: view and log all items',
    route: '/saved-meal/[id]',
    path: `/saved-meal/${IDS.savedMeal.breakfast}`,
    auth: 'signed-in',
    expect: ['Moj doručak', 'Oats, rolled, dry', 'Banana, raw'],
    async after(page, ctx) {
      await stepThen(ctx, 'add the meal to the diary', () => clickButton(page, /Add 3 foods to/), () =>
        ctx.expectMutation('diary_entries', 'insert', (m) => rowsOf(m).length === 3 && rowsOf(m).every((r) => r.source === 'copy')),
      );
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
        await stepThen(ctx, 'open the editor', () => clickButton(page, /^Magnesium, .*Edit target/), async () => {
          await ctx.snapshot('editor', { tall: false });
          await stepThen(ctx, 'set a minimum of 500 and save', async () => {
            await fill(page, 'Minimum (mg)', '500');
            await clickButton(page, 'Save', { exact: true });
          }, () => ctx.expectMutation('nutrient_targets', 'upsert', (m) => payloadOf(m).nutrient_code === 'MAGNESIUM_MG' && payloadOf(m).min_value === 500));
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
];
