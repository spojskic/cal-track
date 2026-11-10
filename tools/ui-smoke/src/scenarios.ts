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
import type { Locator, Page } from 'playwright-core';

import { dayLabel } from '../../../apps/app/src/components/desktop/month-grid';
import { DESKTOP_CONTENT_MAX_WIDTH, SIDEBAR_WIDTH } from '../../../apps/app/src/theme/desktop';
import { PALETTES } from '../../../apps/app/src/theme/palettes';
import { choose, clickButton, clickTab, clickText, closeSheet, fill, findField, scrollToText } from './actions';
import { truncatedTextScript } from './browser-scripts';
import { BARCODES, IDS, USER, addDays } from './fixtures';
import { THEME_SCENARIOS } from './scenarios-theme';
import { WORKOUT_SCENARIOS } from './scenarios-workouts';
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


/** The dashboard must exist ONCE in the page: a second (hidden) copy of a tab screen would run every query twice. */
async function checkOneStreakLabel(page: Page, ctx: ScenarioContext): Promise<void> {
  const info = await page.evaluate(`(() => {
    const out = [];
    for (const e of document.querySelectorAll('div, span')) {
      if (e.children.length > 0 || (e.textContent || '').trim() !== 'Logging streak') continue;
      let hidden = false;
      for (let n = e; n; n = n.parentElement) if (getComputedStyle(n).display === 'none') hidden = true;
      const r = e.getBoundingClientRect();
      out.push((hidden ? 'hidden ' : 'shown ') + Math.round(r.width) + 'x' + Math.round(r.height));
    }
    return out;
  })()`);
  if (!Array.isArray(info)) return;
  if (info.length !== 1 || !String(info[0]).startsWith('shown')) ctx.fail(`"Logging streak" is in the page ${info.length} time(s): ${info.join(', ')}`);
}

// ------------------------------------------------------------------------------------------ more helpers

/** The headings of the More screen (a phone's fourth tab), in list order (apps/app/src/components/settings/more-sections.ts). */
const MORE_SECTIONS = ['Training', 'Coach', 'Profile', 'Connections', 'App', 'Account'] as const;

/**
 * Every section heading of the phone's More screen is there and they follow one another in ONE column, in list order. The headings are
 * found by their whole text: "App" and "Coach" would otherwise also match "Connected apps & devices" and "AI Coach & keys".
 * (A desktop window has no More screen: its sidebar lists the same rows, see the `shell: ...` scenarios.)
 */
async function checkMoreSections(page: Page, ctx: ScenarioContext): Promise<void> {
  const boxes = new Map<string, { x: number; y: number }>();
  for (const label of MORE_SECTIONS) {
    if (!(await ctx.expectText(label, { exact: true }))) continue;
    const box = await page.getByText(label, { exact: true }).first().boundingBox();
    if (box) boxes.set(label, box);
  }
  if (boxes.size !== MORE_SECTIONS.length) return; // a missing heading is already a FAIL above
  const box = (label: string) => boxes.get(label) as { x: number; y: number };
  await ctx.check('one column: Training, Coach, Profile, Connections, App, Account from top to bottom', () => {
    for (let i = 1; i < MORE_SECTIONS.length; i++) {
      const [above, below] = [MORE_SECTIONS[i - 1] as string, MORE_SECTIONS[i] as string];
      if (!(box(above).y < box(below).y)) throw new Error(`"${above}" (y ${box(above).y}) is not above "${below}" (y ${box(below).y})`);
    }
    for (const label of MORE_SECTIONS) if (Math.abs(box(label).x - box('Training').x) > 8) throw new Error(`"${label}" is not in the same column as "Training"`);
  });
}

// ------------------------------------------------------------------------------------------ desktop shell helpers

/** The headings of the desktop sidebar, top to bottom (apps/app/src/components/desktop/sidebar-model.ts). Each collapses its rows. */
const SIDEBAR_GROUPS = ['Daily', 'Training', 'Coach', 'Profile', 'Connections', 'App'] as const;

/** A row of the sidebar (a link; `string` = the whole name). */
const sidebarLink = (page: Page, name: string | RegExp) => page.getByRole('link', { name, exact: typeof name === 'string' }).first();

/** Number of sidebar rows with this name. */
const sidebarLinks = (page: Page, name: string | RegExp): Promise<number> => page.getByRole('link', { name, exact: typeof name === 'string' }).count();

/**
 * The row of the sidebar that is the open page: the link with this name that carries `aria-current="page"`. (Playwright's `selected`
 * option only knows tabs, options and grid cells, so it cannot be used for links.)
 */
const litLink = (page: Page, name: string) => page.locator('[aria-current="page"]').and(page.getByRole('link', { name, exact: true })).first();

/** The heading button of a sidebar group (named exactly like the group; `expanded` says whether its rows are shown). */
const groupButton = (page: Page, label: string, expanded?: boolean) =>
  page.getByRole('button', { name: label, exact: true, ...(expanded === undefined ? {} : { expanded }) }).first();

/**
 * Clicks the LAST button with this name. A desktop window has the sidebar's "Add to diary" button before everything else in the page;
 * the button a screen draws for itself comes after it. (On a phone there is no sidebar and the last one is the only one.)
 */
async function clickPageButton(page: Page, name: string | RegExp, opts: { exact?: boolean; timeout?: number } = {}): Promise<void> {
  await page.getByRole('button', { name, exact: opts.exact ?? false }).last().click({ timeout: opts.timeout ?? 6000 });
}

/** The names of the colour themes, for matching the status bar without depending on which one the run uses. */
const PALETTE_NAME = new RegExp(`^(${PALETTES.map((p) => p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);

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

// ------------------------------------------------------------------------------------------ desktop layout helpers

/** The title strip of a desktop panel (and the page header): a heading with exactly this text. */
const panelTitle = (page: Page, title: string) => page.getByRole('heading', { name: title, exact: true }).first();

/** Box of an element; throws when it is not on screen (the message names it). */
async function boxOf(locator: Locator, what: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox({ timeout: 6000 });
  if (!box) throw new Error(`${what} is not visible`);
  return box;
}

/** What a desktop window gives its pages: the width right of the sidebar, up to the widest content. */
function desktopContentWidth(page: Page): number {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('the page has no viewport');
  return Math.min(viewport.width - SIDEBAR_WIDTH, DESKTOP_CONTENT_MAX_WIDTH);
}

/**
 * The desktop dashboard (a window of 900 px or more): the KPI strip and the panels use the width of the content instead of a narrow
 * centred column. Panel titles are headings; the panels of a row share a top edge, and the last KPI cell starts in the right part
 * of the content area.
 */
async function checkDesktopDashboard(page: Page, ctx: ScenarioContext): Promise<void> {
  for (const title of ['Today', 'Consumed average', 'Weight trend', 'Recent workouts', 'Nutrition score']) {
    await ctx.check(`desktop: the "${title}" panel is on the dashboard`, () => panelTitle(page, title).waitFor({ state: 'visible', timeout: 8000 }));
  }
  await ctx.expectText('Logging streak', { exact: true });
  await ctx.check('desktop: the panels are laid out in columns across the content, not in one narrow column', async () => {
    const today = await boxOf(panelTitle(page, 'Today'), '"Today"');
    const average = await boxOf(panelTitle(page, 'Consumed average'), '"Consumed average"');
    if (Math.abs(today.y - average.y) > 8) throw new Error(`"Today" (y ${today.y}) and "Consumed average" (y ${average.y}) are not in the same row`);
    if (!(average.x > today.x + 150)) throw new Error(`"Consumed average" (x ${average.x}) is not beside "Today" (x ${today.x})`);
    const viewport = page.viewportSize();
    const content = desktopContentWidth(page);
    const streak = await boxOf(page.getByText('Logging streak', { exact: true }).first(), '"Logging streak"');
    const fromRight = (viewport?.width ?? 0) - streak.x;
    if (!(fromRight < content * 0.3)) throw new Error(`the last KPI cell starts ${fromRight}px from the right edge, the content is ${content}px wide`);
  });
  await ctx.snapshot('desktop-panels');
}

/**
 * The desktop diary: the entry list is one panel, Targets / Energy summary / Nutrient targets are panels beside it (to the right of
 * the list), and together they use the width of the content area.
 */
async function checkDesktopDiary(page: Page, ctx: ScenarioContext): Promise<void> {
  for (const title of ['Entries', 'Targets', 'Energy summary', 'Nutrient targets']) {
    await ctx.check(`desktop: the "${title}" panel is on the diary`, () => panelTitle(page, title).waitFor({ state: 'visible', timeout: 8000 }));
  }
  await ctx.check('desktop: the targets sit beside the entry list and both use the width of the content', async () => {
    const first = await boxOf(page.getByRole('tab', { name: /^food/i }).first(), 'the Food tab');
    const last = await boxOf(page.getByRole('tab', { name: /^note/i }).first(), 'the Note tab');
    const targets = await boxOf(panelTitle(page, 'Targets'), '"Targets"');
    const edit = await boxOf(page.getByRole('button', { name: 'Open target settings', exact: true }).first(), 'the link to the target settings');
    const listRight = last.x + last.width;
    if (!(targets.x > listRight)) throw new Error(`"Targets" starts at x ${targets.x}, the entry list ends at x ${listRight}`);
    // The link sits at the right end of the Targets panel: its edge plus the padding and the border is the edge of the panel.
    const span = edit.x + edit.width + 15 - (first.x - 1);
    const content = desktopContentWidth(page);
    if (!(span >= content * 0.8)) throw new Error(`the list and the targets span ${Math.round(span)}px of the ${content}px content area (less than 80 %)`);
  });
}

/** The desktop foods screen: the library panel at the left and the create actions in a column at the right. */
async function checkDesktopFoods(page: Page, ctx: ScenarioContext): Promise<void> {
  for (const title of ['Food library', 'Create']) {
    await ctx.check(`desktop: the "${title}" panel is on the foods screen`, () => panelTitle(page, title).waitFor({ state: 'visible', timeout: 8000 }));
  }
  await ctx.check('desktop: the create actions are in a column to the right of the list', async () => {
    const chip = await boxOf(page.getByRole('tab', { name: 'Saved meals', exact: true }).first(), 'the Saved meals chip');
    const create = await boxOf(page.getByRole('button', { name: 'Create food', exact: true }).first(), 'the Create food button');
    const scan = await boxOf(page.getByRole('button', { name: 'Scan barcode', exact: true }).first(), 'the Scan barcode button');
    if (!(create.x > scan.x + scan.width)) throw new Error(`"Create food" (x ${create.x}) is not to the right of the library (its scan button ends at ${scan.x + scan.width})`);
    if (!(create.x > chip.x + chip.width)) throw new Error('the create actions are not beside the filter chips');
    const viewport = page.viewportSize();
    if (viewport && !(create.x + create.width > viewport.width * 0.75)) throw new Error(`the create column ends at x ${create.x + create.width}: the screen does not use the width`);
  });
}

// ------------------------------------------------------------------------------------------ energy summary helpers

/** The button under the energy summary's third circle (Remaining / Over in Target, Deficit / Surplus in Balance). */
const thirdCircleButton = (page: Page) => page.getByRole('button', { name: 'Switch between Target and Balance', exact: true }).first();

/** FAIL unless the label under the third circle reads like the pattern (it re-renders a moment after a tap). */
async function expectThirdCircle(ctx: ScenarioContext, page: Page, pattern: RegExp): Promise<boolean> {
  return ctx.check(`the third energy circle reads ${String(pattern)}`, async () => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const text = (await thirdCircleButton(page).innerText({ timeout: 6000 })).trim();
      if (pattern.test(text)) return;
      if (Date.now() > deadline) throw new Error(`it reads "${text}"`);
      await page.waitForTimeout(150);
    }
  });
}

const TARGET_VIEW = /^(Remaining|Over)$/;
const BALANCE_VIEW = /^(Deficit|Surplus)$/;

/** Top edge of the first button with this accessible name (to compare the order of rows on screen). */
async function rowTop(page: Page, name: RegExp): Promise<number> {
  const box = await page.getByRole('button', { name }).first().boundingBox({ timeout: 6000 });
  if (!box) throw new Error(`${String(name)} is not visible`);
  return box.y;
}

/** Waits until the row named `above` is higher on the page than the row named `below` (the list re-renders a moment after a menu click). */
async function expectRowOrder(page: Page, above: RegExp, below: RegExp, message: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await rowTop(page, above)) < (await rowTop(page, below))) return;
    } catch {
      // not rendered yet
    }
    if (Date.now() > deadline) throw new Error(message);
    await page.waitForTimeout(150);
  }
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
    async after(page, ctx) {
      await ctx.expectUrl(/\/onboarding/);
      // The wizard is a full-screen flow: a desktop window draws it without the sidebar and status bar.
      if (!ctx.isPhone) await ctx.check('desktop: no sidebar around the onboarding wizard', () => sidebarLink(page, 'Diary').waitFor({ state: 'hidden', timeout: 6000 }));
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
      if (!ctx.isPhone) await checkDesktopDashboard(page, ctx);
      await stepThen(ctx, 'open the diary from the dashboard', () => clickButton(page, 'Open diary'), () => ctx.expectUrl(/\/diary/));
    },
  },
  {
    // Cronometer's "Energy Summary 3rd Circle Display": the label under the third circle is a button that switches
    // between Target (Remaining / Over) and Balance (Deficit / Surplus) and remembers the choice in the profile.
    name: 'dashboard: the third energy circle switches between Target and Balance',
    route: '/',
    path: '/',
    auth: 'signed-in',
    expect: ['Dashboard', 'Today', 'Expenditure'],
    async after(page, ctx) {
      const profileUpdates = () => ctx.backend.mutationsOf('profiles', 'update');
      await expectThirdCircle(ctx, page, TARGET_VIEW);
      await stepThen(ctx, 'tap the label under the third circle', () => thirdCircleButton(page).click({ timeout: 6000 }), async () => {
        await expectThirdCircle(ctx, page, BALANCE_VIEW);
        await ctx.expectMutation('profiles', 'update', (m) => payloadOf(m).energy_summary_mode === 'balance');
        await ctx.check('switching views is exactly one request that only changes the preference', () => {
          if (profileUpdates().length !== 1) throw new Error(`${profileUpdates().length} profile updates`);
          const keys = Object.keys(payloadOf(profileUpdates()[0]!));
          if (keys.join() !== 'energy_summary_mode') throw new Error(`the update sends ${keys.join(', ')}`);
        });
        await ctx.expectText(/Expenditure [\d,]+ kcal - Consumed [\d,]+ kcal/);
        await ctx.snapshot('balance', { tall: false });
        // the choice is remembered: a reload still shows Deficit / Surplus
        await stepThen(ctx, 'reload the dashboard', async () => {
          // The query cache is written to storage about a second after a change; reloading sooner restores the old copy.
          await page.waitForTimeout(1600);
          await page.reload();
          await ctx.settle();
        }, () => expectThirdCircle(ctx, page, BALANCE_VIEW));
        await stepThen(ctx, 'tap it again to go back to Target', () => thirdCircleButton(page).click({ timeout: 6000 }), async () => {
          await expectThirdCircle(ctx, page, TARGET_VIEW);
          await ctx.expectMutation('profiles', 'update', (m) => payloadOf(m).energy_summary_mode === 'target');
          await ctx.check('two taps are two requests', () => {
            if (profileUpdates().length !== 2) throw new Error(`${profileUpdates().length} profile updates`);
          });
        });
      });
    },
  },
  {
    // The Expenditure circle opens the parts that add up to it: BMR, adjusted baseline activity, exercise, TEF.
    name: 'dashboard: the expenditure circle lists what it is made of',
    route: '/',
    path: '/',
    auth: 'signed-in',
    expect: ['Dashboard', 'Expenditure'],
    async after(page, ctx) {
      await stepThen(ctx, 'open the expenditure breakdown', () => clickButton(page, /Expenditure .* show how it adds up/), async () => {
        for (const text of ['Energy expenditure', 'Basal metabolic rate (BMR)', 'Adjusted baseline activity', 'Thermic effect of food', 'Total expenditure']) {
          await ctx.expectText(text);
        }
        await ctx.expectNoText('Tracker activity', { timeout: 1500 }); // the default fixtures use the Static energy mode: no tracker
        await ctx.snapshot('breakdown', { tall: false });
        await closeSheet(page, 'Total expenditure');
      });
    },
  },
  { name: 'dashboard: imperial units', route: '/', path: '/', auth: 'signed-in', fixtures: 'imperial', expect: ['Dashboard'] },
  { name: 'dashboard: empty diary', route: '/', path: '/', auth: 'signed-in', fixtures: 'empty-diary', expect: ['Dashboard'] },
  {
    // The same rings in the diary (the Energy page of the targets on phones, the Energy summary panel on wide screens).
    name: 'diary: the energy summary switches between Target and Balance',
    route: '/diary',
    path: '/diary',
    auth: 'signed-in',
    expect: ['Breakfast', 'Lunch', 'Dinner', 'Snacks'],
    async after(page, ctx) {
      if (ctx.isPhone) await ctx.step('open the Energy page of the targets', () => clickTab(page, /^Energy/));
      await expectThirdCircle(ctx, page, TARGET_VIEW);
      await stepThen(ctx, 'tap the label under the third circle', () => thirdCircleButton(page).click({ timeout: 6000 }), async () => {
        await expectThirdCircle(ctx, page, BALANCE_VIEW);
        await ctx.expectMutation('profiles', 'update', (m) => payloadOf(m).energy_summary_mode === 'balance');
        await ctx.snapshot('balance', { tall: false });
      });
    },
  },
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
      if (!ctx.isPhone) await checkDesktopDiary(page, ctx);
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
      // The watch / Health group starts closed (a dozen rows a day) and opens and closes with its header; meals are unchanged.
      await ctx.expectText('Apple Health activity');
      await ctx.expectNoText('Daily Activity', { timeout: 500 });
      await stepThen(ctx, 'open the device activity group', () => clickButton(page, /activity, .*Expand/), async () => {
        await ctx.expectText('Daily Activity');
        await stepThen(ctx, 'close it again', () => clickButton(page, /activity, .*Collapse/), () => ctx.expectNoText('Daily Activity', { timeout: 1500 }));
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
      await ctx.check('oldest first by default: oats above coffee', () => expectRowOrder(page, oats, coffee, 'oats are not above the coffee'));
      await stepThen(ctx, 'Sort by Time: newest first', () => pickGroupAction(page, 'Breakfast', 'Sort by Time: newest first'), async () => {
        await ctx.check('newest first: coffee above oats', () => expectRowOrder(page, coffee, oats, 'coffee is not above the oats'));
        await ctx.snapshot('newest-first', { tall: false });
        await ctx.check('sorting writes no diary entries', () => {
          if (diaryWrites(ctx).length > 0) throw new Error(`unexpected writes: ${diaryWrites(ctx).join(', ')}`);
        });
        await stepThen(ctx, 'Sort by Time: oldest first', () => pickGroupAction(page, 'Breakfast', 'Sort by Time: oldest first'), async () => {
          await ctx.check('oldest first again: oats above coffee', () => expectRowOrder(page, oats, coffee, 'oats are not above the coffee'));
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
      if (!ctx.isPhone) await checkDesktopFoods(page, ctx);
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
    // The field on the Foods tab is a real input: the results come up right below it and the page stays the Foods tab (Add food is for adding).
    name: 'foods tab: typing in the search field searches in place',
    route: '/foods',
    path: '/foods',
    auth: 'signed-in',
    expect: ['Foods', 'Favorites'],
    async after(page, ctx) {
      const onFoodsTab = () => {
        if (!/\/foods\/?(\?.*)?$/.test(page.url())) throw new Error(`left the Foods tab: ${page.url()}`);
      };
      const savedMealsChip = page.getByRole('tab', { name: 'Saved meals', exact: true });
      await stepThen(ctx, 'type chicken into the search field', () => fill(page, 'Search foods', 'chicken'), async () => {
        // The roasted chicken is not a favourite (the list behind the chips): it can only come from the search.
        await ctx.expectText('Chicken breast, roasted, skinless');
        await ctx.expectText('Chicken breast, skinless, boneless, raw');
        await ctx.check('the results are in place: still the Foods tab, not the Add food screen', onFoodsTab);
        await ctx.check('the filter chips step aside while searching', async () => {
          if ((await savedMealsChip.count()) > 0) throw new Error('the chips are still shown next to the results');
        });
        await ctx.snapshot('chicken', { tall: false });
      });
      await stepThen(ctx, 'search for cevapi (without the accent)', () => fill(page, 'Search foods', 'cevapi'), async () => {
        await ctx.expectText('Ćevapi');
        await ctx.expectNoText('Chicken breast, roasted, skinless'); // the new results replace the old ones
        await ctx.check('the search RPC was called', () => {
          if (!ctx.backend.calls.some((c) => c.kind === 'rpc' && c.target === 'search_foods' && c.status === 200)) throw new Error('no search_foods call');
        });
        await ctx.check('still the Foods tab', onFoodsTab);
      });
      await stepThen(ctx, 'clear the field with the X', () => clickButton(page, 'Clear search', { exact: true }), async () => {
        await ctx.expectInputValue('Search foods', '');
        await ctx.check('the library and its chips are back', () => savedMealsChip.first().waitFor({ state: 'visible', timeout: 6000 }));
        await ctx.expectText('Banana, raw'); // a favourite, and not a result of "cevapi"
        await ctx.check('still the Foods tab', onFoodsTab);
        await ctx.snapshot('cleared', { tall: false });
      });
      await stepThen(
        ctx,
        'type banana, then press Escape in the field',
        async () => {
          await fill(page, 'Search foods', 'banana');
          await (await findField(page, 'Search foods')).press('Escape');
        },
        async () => {
          await ctx.expectInputValue('Search foods', '');
          await ctx.check('the chips are back after Escape', () => savedMealsChip.first().waitFor({ state: 'visible', timeout: 6000 }));
        },
      );
    },
  },
  {
    // A result is a normal food row: tap it to open the food, or the + to add one serving to the default meal of the selected day, here.
    name: 'foods tab: a search result opens the food and the + adds a serving without leaving',
    route: '/foods',
    path: '/foods',
    auth: 'signed-in',
    expect: ['Foods', 'Favorites'],
    async after(page, ctx) {
      await stepThen(ctx, 'search for cevapi', () => fill(page, 'Search foods', 'cevapi'), async () => {
        await ctx.expectText('Ćevapi');
        await stepThen(
          ctx,
          'quick add Ćevapi with its +',
          () => page.getByRole('button', { name: /Quick add one serving of Ćevapi/ }).first().click({ timeout: 6000 }),
          async () => {
            await ctx.expectMutation('diary_entries', 'insert', (m) => payloadOf(m).food_id === F.cevapi);
            await ctx.expectText(/Added .* of Ćevapi to /);
            await ctx.check('still the Foods tab', () => {
              if (!/\/foods\/?(\?.*)?$/.test(page.url())) throw new Error(`left the Foods tab: ${page.url()}`);
            });
            await ctx.snapshot('quick-added', { tall: false });
          },
        );
        await stepThen(ctx, 'open Ćevapi from its row', () => page.getByRole('button', { name: /^Ćevapi.*Open details$/ }).first().click({ timeout: 6000 }), async () => {
          await ctx.expectUrl(new RegExp(`/food/${F.cevapi}`));
        });
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
      // "Search foods" in an empty list puts the cursor in the search field of this page (it does not open another screen).
      await stepThen(ctx, 'tap Search foods in the empty Favorites list', () => clickButton(page, 'Search foods', { exact: true }), async () => {
        await ctx.check('the search field has the focus and the page is still the Foods tab', async () => {
          const label = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');
          if (label !== 'Search foods') throw new Error(`the focus is on "${label}"`);
          if (!/\/foods\/?(\?.*)?$/.test(page.url())) throw new Error(`left the Foods tab: ${page.url()}`);
        });
      });
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
    // A phone's fourth tab. A desktop window has no More page: its sidebar lists everything More lists (see the next scenarios).
    name: 'more',
    route: '/more',
    path: '/more',
    auth: 'signed-in',
    viewports: ['phone', 'phone-dark'],
    expect: [
      'More',
      'Profile & targets',
      'Personal details',
      'Nutrient targets',
      'Display & units',
      'Connected apps & devices',
      'Workouts',
      'AI (optional)',
      'About',
      'Sign out',
      USER.email,
    ],
    async after(page, ctx) {
      await checkMoreSections(page, ctx);
      // The Coach row needs a working AI key; the AI row says it is off. The short texts are matched exactly.
      await ctx.expectNoText('Chat about your nutrition', { timeout: 1500 });
      await ctx.expectText('Off', { exact: true });
    },
  },
  {
    name: 'more: sign out',
    route: '/more',
    path: '/more',
    auth: 'signed-in',
    viewports: ['phone', 'phone-dark'],
    expect: ['Sign out'],
    async after(page, ctx) {
      await stepThen(ctx, 'tap Sign out', () => clickButton(page, 'Sign out', { exact: true }), async () => {
        await ctx.expectUrl(/\/sign-in/, 15_000);
        await ctx.expectText('Sign in');
      });
    },
  },
  {
    // The sidebar has all of More, so an old link or bookmark to /more must not show a second copy of it.
    name: 'more: a desktop window has no More page (it opens the dashboard)',
    route: '/more',
    path: '/more',
    auth: 'signed-in',
    viewports: ['desktop', 'desktop-dark'],
    expect: ['Dashboard'],
    async after(page, ctx) {
      await ctx.expectUrl(/^https?:\/\/[^/]+\/?(\?.*)?$/);
      await ctx.check('the sidebar has no "More" link', async () => {
        if ((await sidebarLinks(page, 'More')) > 0) throw new Error('a "More" link is shown');
      });
      await ctx.check('the Dashboard row is the open one', async () => {
        await litLink(page, 'Dashboard').waitFor({ state: 'visible', timeout: 6000 });
      });
    },
  },
  {
    // The account of the More screen is the footer of the sidebar on a desktop.
    name: 'shell: Sign out in the footer of the sidebar',
    route: '/',
    path: '/',
    auth: 'signed-in',
    viewports: ['desktop', 'desktop-dark'],
    expect: ['Sign out', USER.email],
    async after(page, ctx) {
      await ctx.check('the footer says who is signed in', async () => {
        await page.getByText(USER.email, { exact: true }).first().waitFor({ state: 'visible', timeout: 6000 });
      });
      await stepThen(ctx, 'tap Sign out', () => clickButton(page, 'Sign out', { exact: true }), async () => {
        await ctx.expectUrl(/\/sign-in/, 15_000);
        await ctx.expectText('Sign in');
        await ctx.check('the sidebar is gone on the sign-in screen', async () => {
          await sidebarLink(page, 'Diary').waitFor({ state: 'hidden', timeout: 6000 });
        });
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
      await ctx.check('the "Scan nutrition label" action is hidden without a connected key', async () => {
        if (await page.getByText(/nutrition label/i).count()) throw new Error('"Scan nutrition label" is visible although AI is not connected');
        if (await page.getByRole('button', { name: /nutrition label/i }).count()) throw new Error('a "nutrition label" button exists although AI is not connected');
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
        // The camera is a full-screen flow: a desktop window draws it without the sidebar.
        if (!ctx.isPhone) await ctx.check('desktop: the scanner has no sidebar', () => sidebarLink(page, 'Diary').waitFor({ state: 'hidden', timeout: 6000 }));
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
      await stepThen(ctx, 'add to the diary', () => clickPageButton(page, /^Add to diary/), async () => {
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
          if (!(await page.getByRole('button', { name: /^Add to diary/ }).last().isEnabled({ timeout: 3000 }))) throw new Error('"Add to diary" is disabled');
        });
        await stepThen(ctx, 'tap "Use 200 g"', () => clickButton(page, 'Use 200 g', { exact: true }), async () => {
          await ctx.expectText('= 200 g');
          await ctx.expectNoText('did you mean grams');
          await stepThen(ctx, 'add to the diary', () => clickPageButton(page, /^Add to diary/), async () => {
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
      // AI is not connected in the harness: the form offers no "Scan nutrition label" and shows no scan banner.
      await ctx.check('no "Scan nutrition label" button or label banner without a connected key', async () => {
        if (await page.getByText(/nutrition label/i).count()) throw new Error('the form mentions a nutrition label although AI is not connected');
        if (await page.getByText('Read from a photo of the label').count()) throw new Error('the label banner is visible without a scan');
        if (await page.getByRole('button', { name: /nutrition label/i }).count()) throw new Error('a "nutrition label" button exists although AI is not connected');
      });
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
        await ctx.check('no "Fill in from the nutrition label (AI)" action without a connected key', async () => {
          if (await page.getByText(/nutrition label/i).count()) throw new Error('the result card offers the nutrition label scan although AI is not connected');
        });
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
        // Exact: the recipe screen below this one stays mounted (hidden) and also contains "Servings" / "Serving size".
        await ctx.expectText('Serving', { exact: true });
        await stepThen(ctx, 'confirm on the food screen', () => clickPageButton(page, /^Add to diary/), async () => {
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
    // The energy modes are named after what they do, and the third circle of the energy summary can be set here too.
    name: 'settings: energy mode wording and the 3rd circle (Target | Balance)',
    route: '/settings/targets',
    path: '/settings/targets',
    auth: 'signed-in',
    expect: ['Energy calculation', 'Energy summary 3rd circle'],
    async after(page, ctx) {
      await ctx.step('scroll to the energy mode', () => scrollToText(page, /Energy mode:/));
      await stepThen(ctx, 'open the energy modes', () => clickButton(page, /Energy mode: Static/), async () => {
        for (const text of [
          'Baseline activity only. Ignores your watch.',
          'Device-adjusted',
          'Your watch activity replaces the baseline during the day; workouts are added.',
          'Device total',
          "Uses your watch's active + resting calories only.",
        ]) {
          await ctx.expectText(text);
        }
        await ctx.snapshot('modes', { tall: false });
        await choose(page, 'Device-adjusted', { exact: true });
      });
      await stepThen(ctx, 'show Balance in the third circle and save', async () => {
        await choose(page, 'Balance', { exact: true });
        await clickButton(page, 'Save energy settings', { exact: true });
      }, () =>
        ctx.expectMutation(
          'profiles',
          'update',
          (m) => payloadOf(m).energy_summary_mode === 'balance' && payloadOf(m).energy_mode === 'device_adjusted',
        ),
      );
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
    // The Garmin card on the web: it only explains that Garmin sync needs the phone app.
    expect: ['Connected Apps & Devices', 'Energy mode', 'Garmin sync runs in the iPhone and Android app'],
    async after(page, ctx) {
      await ctx.expectText('Garmin sync runs in the iPhone and Android app');
      await ctx.expectText('Nothing is written to Garmin');
      await ctx.check('the web build has no Connect Garmin / Sync now / Copy sync report button', async () => {
        for (const name of [/Connect Garmin/i, /Sync now/i, /Copy sync report/i, /Sign in to Garmin/i]) {
          const n = await buttonCount(page, name);
          if (n > 0) throw new Error(`found ${n} button(s) named ${String(name)}`);
        }
      });
      await ctx.check('the web build never calls a Garmin function or rpc', () => {
        const touched = ctx.backend.calls.filter((c) => /garmin/i.test(c.target));
        if (touched.length > 0) throw new Error(`unexpected backend calls: ${touched.map((c) => c.target).join(', ')}`);
      });
    },
  },
  {
    name: 'settings: sign in to Garmin (web: explains it needs the phone app)',
    route: '/settings/garmin-sign-in',
    path: '/settings/garmin-sign-in',
    auth: 'signed-in',
    expect: ['Sign in to Garmin', 'Garmin sync runs in the iPhone and Android app'],
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
    // /coach?topicKind=workout&topicId=<exercise_entries id> opens a chat ABOUT a workout (the Workouts screens link to it)
    name: 'coach: a chat about a workout (topic params) is gated like any other chat',
    route: '/coach',
    path: `/coach?topicKind=workout&topicId=${IDS.workout.strength}`,
    auth: 'signed-in',
    expect: [/The coach needs OpenRouter|Checking your AI connection/],
    async after(_page, ctx) {
      await ctx.expectText('The coach needs OpenRouter');
      await ctx.check('no coach data was loaded behind the closed gate', () => {
        const touched = ctx.backend.calls.filter((c) => c.target === 'coach_threads' || c.target === 'coach_messages');
        if (touched.length > 0) throw new Error(`the coach queried ${touched.map((c) => c.target).join(', ')}`);
      });
    },
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
  {
    name: 'ai: scan nutrition label (AI not set up)',
    route: '/ai/label',
    // The barcode and meal group a scan result would carry into the new food are accepted and ignored here.
    path: '/ai/label?gtin=03017620422003&from=food-form',
    auth: 'signed-in',
    expect: ['AI is not set up'],
    async after(page, ctx) {
      await ctx.check('no camera or photo controls without a connected key', async () => {
        for (const name of [/take a photo/i, /choose from library/i, /read label/i]) {
          if (await page.getByRole('button', { name }).count()) throw new Error(`a "${String(name)}" button is visible although AI is not connected`);
        }
      });
      await ctx.check('no food is created by opening the screen', () => {
        if (ctx.backend.mutationsOf('foods', 'insert').length > 0) throw new Error('a food was inserted');
      });
    },
  },
  { name: 'ai: photo log (AI not set up)', route: '/ai/photo', path: '/ai/photo', auth: 'signed-in', expect: [/AI is not set up|Checking your AI connection/] },
  { name: 'ai: recipe from a description (AI not set up)', route: '/ai/recipe', path: '/ai/recipe', auth: 'signed-in', expect: [/AI is not set up|Checking your AI connection/] },

  // ------------------------------------------------------------------------------------------ app shell navigation
  {
    // Regression: the sidebar (wide) and the bottom bar (phone) rendered but did nothing when pressed, because the
    // expo-router/ui <TabTrigger>s were hidden inside custom components and never registered. Every other scenario
    // opens its page by URL, so this is the one place that clicks the real navigation. On a desktop it also clicks rows
    // of the sidebar that lead OUT of the tab pages (Workouts, Profile & targets, About): the sidebar must stay.
    name: 'shell: main navigation (sidebar on desktop, tab bar on phone)',
    route: '/',
    path: '/',
    auth: 'signed-in',
    expect: ['Dashboard'],
    async after(page, ctx) {
      const navLink = (name: string) => page.getByRole('link', { name, exact: true }).first();
      // Each entry: the nav item, the URL it must lead to and a text that only that screen shows (so the screen
      // really switched, not just the address bar).
      const tabs: { name: string; url: RegExp; text: string | RegExp }[] = [
        { name: 'Diary', url: /\/diary/, text: 'Breakfast' },
        { name: 'Foods', url: /\/foods/, text: 'Favorites' },
      ];
      // A phone has More as its fourth tab; a desktop sidebar has no such item (its rows are the sidebar's groups).
      if (ctx.isPhone) tabs.push({ name: 'More', url: /\/more/, text: 'Sign out' });
      tabs.push({ name: 'Dashboard', url: /^https?:\/\/[^/]+\/?(\?.*)?$/, text: 'Logging streak' });
      for (const target of tabs) {
        await stepThen(ctx, `open ${target.name} from the navigation`, () => navLink(target.name).click({ timeout: 6000 }), async () => {
          await ctx.snapshot(`open-${target.name.toLowerCase()}`, { tall: false });
          await ctx.expectUrl(target.url);
          if (target.name === 'Dashboard') await checkOneStreakLabel(page, ctx);
          await ctx.expectText(target.text);
        });
      }

      if (!ctx.isPhone) {
        // Pages that are NOT tabs open inside the shell: the sidebar is still there, and the row of the open page is lit.
        const rows: { name: string; url: RegExp; text: string }[] = [
          { name: 'Workouts', url: /\/workouts\/?(\?.*)?$/, text: 'This week' },
          { name: 'Profile & targets', url: /\/settings\/targets/, text: 'Weight Goal' },
          { name: 'About', url: /\/settings\/about/, text: 'Food data sources' },
        ];
        for (const target of rows) {
          await stepThen(ctx, `open ${target.name} from the sidebar`, () => navLink(target.name).click({ timeout: 6000 }), async () => {
            await ctx.expectUrl(target.url);
            await ctx.expectText(target.text);
            await ctx.check(`the sidebar stays and lights ${target.name}`, async () => {
              await litLink(page, target.name).waitFor({ state: 'visible', timeout: 6000 });
              await navLink('Dashboard').waitFor({ state: 'visible', timeout: 6000 });
            });
          });
        }
        // ...and a tab page can be reached again from there.
        await stepThen(ctx, 'back to the Dashboard from a page that is not a tab', () => navLink('Dashboard').click({ timeout: 6000 }), async () => {
          await ctx.snapshot('back-to-dashboard', { tall: false });
          await ctx.expectUrl(/^https?:\/\/[^/]+\/?(\?.*)?$/);
          await checkOneStreakLabel(page, ctx);
          await ctx.expectText('Logging streak');
        });
      }
      await stepThen(ctx, 'open the add sheet from the navigation', () => clickButton(page, 'Add to diary'), () => ctx.expectUrl(/\/add/));
      if (!ctx.isPhone) {
        await ctx.check('the sidebar is still there beside the add sheet', () => navLink('Dashboard').waitFor({ state: 'visible', timeout: 6000 }));
      }
    },
  },
  {
    // The desktop sidebar: the groups of the More screen (without a "More" item), the account at the bottom, a status bar below.
    name: 'shell: the desktop sidebar has the groups of the More screen and a status bar',
    route: '/',
    path: '/',
    auth: 'signed-in',
    viewports: ['desktop', 'desktop-dark'],
    expect: ['Dashboard'],
    async after(page, ctx) {
      await ctx.check('the group headings are there, top to bottom: Daily, Training, Coach, Profile, Connections, App', async () => {
        const ys: number[] = [];
        for (const label of SIDEBAR_GROUPS) {
          const box = await groupButton(page, label).boundingBox({ timeout: 6000 });
          if (!box) throw new Error(`the "${label}" heading is not visible`);
          ys.push(box.y);
        }
        for (let i = 1; i < ys.length; i++) if (!((ys[i - 1] as number) < (ys[i] as number))) throw new Error(`"${SIDEBAR_GROUPS[i - 1]}" is not above "${SIDEBAR_GROUPS[i]}"`);
      });
      await ctx.check('every row of the More screen is a link of the sidebar, and there is no "More" link', async () => {
        const missing: string[] = [];
        for (const name of ['Dashboard', 'Diary', 'Foods', 'Workouts', 'Profile & targets', 'Personal details', 'Nutrient targets', 'Connected apps & devices', 'Display & units', 'About']) {
          if ((await sidebarLinks(page, name)) < 1) missing.push(name);
        }
        // Without an AI key the Coach row is hidden and the AI row says Off (its name includes the status, like the More row).
        if ((await sidebarLinks(page, /^AI \(optional\)/)) < 1) missing.push('AI (optional)');
        if (missing.length > 0) throw new Error(`no sidebar link named: ${missing.join(', ')}`);
        if ((await sidebarLinks(page, 'More')) > 0) throw new Error('the sidebar has a "More" link');
        if ((await sidebarLinks(page, 'Coach')) > 0) throw new Error('a Coach row is shown without an AI key');
      });
      await ctx.expectText('Off', { exact: true }); // the AI row's status
      await ctx.check('the open page is lit: the Dashboard row', async () => {
        await litLink(page, 'Dashboard').waitFor({ state: 'visible', timeout: 6000 });
      });
      await ctx.check('the "Add to diary" button is in the sidebar', () =>
        page.getByRole('button', { name: 'Add to diary', exact: true }).first().waitFor({ state: 'visible', timeout: 6000 }),
      );
      await ctx.check('the sidebar is as wide as the shared measurement, at the left edge', async () => {
        const box = await sidebarLink(page, 'Diary').boundingBox({ timeout: 6000 });
        if (!box) throw new Error('the Diary row is not visible');
        if (!(box.x >= 0 && box.x < SIDEBAR_WIDTH / 2 && box.x + box.width <= SIDEBAR_WIDTH)) throw new Error(`the Diary row is at x ${box.x}, ${box.width} wide (the sidebar is ${SIDEBAR_WIDTH})`);
      });
      // The status bar: sync state at the left; AI status, colour theme and version at the right. There is no connected source
      // in the default fixtures, so nothing has synced.
      await ctx.expectText('Not synced', { exact: true });
      await ctx.expectText('AI: off', { exact: true });
      await ctx.expectText(PALETTE_NAME);
      await ctx.expectText(/^v\d+\.\d+/);
      await ctx.check('the status bar is a thin strip along the bottom edge of the window', async () => {
        const box = await page.getByText('AI: off', { exact: true }).first().boundingBox({ timeout: 6000 });
        const viewport = page.viewportSize();
        if (!box || !viewport) throw new Error('no box');
        if (!(viewport.height - (box.y + box.height) < 20)) throw new Error(`the status text ends ${viewport.height - (box.y + box.height)}px above the bottom edge`);
      });
      await ctx.snapshot('sidebar');
    },
  },
  {
    name: 'shell: the sidebar groups collapse and expand, and the choice is remembered',
    route: '/',
    path: '/',
    auth: 'signed-in',
    viewports: ['desktop', 'desktop-dark'],
    expect: ['Dashboard'],
    async after(page, ctx) {
      const profileRows = ['Profile & targets', 'Personal details', 'Nutrient targets'];
      const waitLinks = (names: string[], state: 'visible' | 'hidden') => Promise.all(names.map((name) => sidebarLink(page, name).waitFor({ state, timeout: 6000 })));
      await ctx.check('every group starts open: its heading says expanded and its rows are shown', async () => {
        await groupButton(page, 'Profile', true).waitFor({ state: 'visible', timeout: 6000 });
        await waitLinks(profileRows, 'visible');
      });
      await stepThen(ctx, 'collapse Profile', () => groupButton(page, 'Profile').click({ timeout: 6000 }), async () => {
        await ctx.check('its rows are gone, the heading stays (collapsed) and the other groups keep their rows', async () => {
          await waitLinks(profileRows, 'hidden');
          await groupButton(page, 'Profile', false).waitFor({ state: 'visible', timeout: 6000 });
          await waitLinks(['Display & units', 'Diary', 'Workouts'], 'visible');
        });
        await ctx.snapshot('profile-collapsed', { tall: false });
        await stepThen(ctx, 'collapse Training too, then reload the page', async () => {
          await groupButton(page, 'Training').click({ timeout: 6000 });
          await page.reload();
          await sidebarLink(page, 'Diary').waitFor({ state: 'visible', timeout: 15_000 });
        }, async () => {
          await ctx.check('after the reload the two groups are still collapsed (the choice is saved on this device)', async () => {
            await groupButton(page, 'Profile', false).waitFor({ state: 'visible', timeout: 6000 });
            await groupButton(page, 'Training', false).waitFor({ state: 'visible', timeout: 6000 });
            await waitLinks([...profileRows, 'Workouts'], 'hidden');
            await waitLinks(['Display & units', 'Diary'], 'visible');
          });
        });
        await stepThen(ctx, 'expand Profile again', () => groupButton(page, 'Profile').click({ timeout: 6000 }), () => ctx.check('its rows are back', () => waitLinks(profileRows, 'visible')));
      });
    },
  },
  {
    // Calendar group: closed at first; a month grid (Monday first) with today ringed and the diary date filled; a day opens the diary.
    name: 'shell: the sidebar calendar opens, pages between months and a day opens the diary',
    route: '/',
    path: '/',
    auth: 'signed-in',
    viewports: ['desktop', 'desktop-dark'],
    expect: ['Dashboard'],
    async after(page, ctx) {
      const today = ctx.fixtures.today;
      const [year, month] = today.split('-') as [string, string];
      const pick = today.endsWith('-04') ? `${year}-${month}-05` : `${year}-${month}-04`;
      const dayButton = (iso: string, selected?: boolean) =>
        page.getByRole('button', { name: dayLabel(iso), exact: true, ...(selected === undefined ? {} : { pressed: selected }) }).first();

      await ctx.check('the calendar starts closed: no day buttons, the heading says collapsed', async () => {
        await groupButton(page, 'Calendar', false).waitFor({ state: 'visible', timeout: 6000 });
        if ((await page.getByRole('button', { name: dayLabel(pick), exact: true }).count()) > 0) throw new Error('a day is shown while the calendar is closed');
      });
      await stepThen(ctx, 'open the calendar', () => groupButton(page, 'Calendar').click({ timeout: 6000 }), async () => {
        await ctx.check('the month of today is shown, with the day buttons, "Today", and the month arrows', async () => {
          await groupButton(page, 'Calendar', true).waitFor({ state: 'visible', timeout: 6000 });
          await dayButton(pick).waitFor({ state: 'visible', timeout: 6000 });
          await dayButton(today, true).waitFor({ state: 'visible', timeout: 6000 });
          for (const name of ['Jump to today', 'Previous month', 'Next month']) await page.getByRole('button', { name, exact: true }).first().waitFor({ state: 'visible', timeout: 6000 });
        });
        await ctx.snapshot('calendar-open', { tall: false });
        await stepThen(ctx, 'page to the next month and back', () => clickButton(page, 'Next month', { exact: true }), async () => {
          await ctx.check('the days of today\'s month are gone while another month is shown', () => dayButton(pick).waitFor({ state: 'hidden', timeout: 6000 }));
          await stepThen(ctx, 'previous month', () => clickButton(page, 'Previous month', { exact: true }), () => dayButton(pick).waitFor({ state: 'visible', timeout: 6000 }));
        });
        await stepThen(ctx, `pick ${pick}`, () => dayButton(pick).click({ timeout: 6000 }), async () => {
          await ctx.expectUrl(/\/diary/);
          await ctx.check('that day is the selected one in the calendar (the diary date)', () => dayButton(pick, true).waitFor({ state: 'visible', timeout: 6000 }));
          await ctx.check('the diary asked the database for that day', async () => {
            const asked = () => ctx.backend.calls.some((c) => c.kind === 'rest' && decodeURIComponent(c.query).includes(`entry_date=eq.${pick}`));
            // The diary screen mounts and queries a moment after the address changed: wait for the request instead of looking once.
            for (let waited = 0; !asked() && waited < 6000; waited += 100) await page.waitForTimeout(100);
            if (!asked()) throw new Error(`no request asked for the entries of ${pick}`);
          });
          await ctx.check('the sidebar lights the Diary row', () => litLink(page, 'Diary').waitFor({ state: 'visible', timeout: 6000 }));
          await stepThen(ctx, 'jump back to today', () => clickButton(page, 'Jump to today', { exact: true }), () =>
            ctx.check('today is the selected day again', () => dayButton(today, true).waitFor({ state: 'visible', timeout: 6000 })),
          );
        });
      });
    },
  },
  {
    // The shell wraps every screen that is not a full-screen flow: the sidebar is still there on settings, workouts, search, ...
    // and not on the barcode camera. Dynamic routes keep their row lit. Slim header: back button and "Parent > Title".
    name: 'shell: the sidebar stays on settings, workouts and detail pages, with a slim page header',
    route: '/settings/display',
    path: '/settings/display',
    auth: 'signed-in',
    viewports: ['desktop', 'desktop-dark'],
    expect: ['Units', 'Appearance'],
    async after(page, ctx) {
      await ctx.check('the sidebar is on the page and lights Display & units', async () => {
        await litLink(page, 'Display & units').waitFor({ state: 'visible', timeout: 6000 });
        await sidebarLink(page, 'Dashboard').waitFor({ state: 'visible', timeout: 6000 });
      });
      await ctx.check('the header is one slim strip: the parent "Settings", then the title; below the top of the window', async () => {
        const title = await page.getByRole('heading', { name: 'Display & units', exact: true }).first().boundingBox({ timeout: 6000 });
        if (!title) throw new Error('the page title is not a visible heading');
        if (!(title.y >= 0 && title.y + title.height <= 56)) throw new Error(`the title is at y ${title.y}, ${title.height} high (the strip is 44 px)`);
        await page.getByText('Settings', { exact: true }).first().waitFor({ state: 'visible', timeout: 6000 });
      });
      await stepThen(ctx, 'open Workouts from the sidebar', () => sidebarLink(page, 'Workouts').click({ timeout: 6000 }), async () => {
        await ctx.expectUrl(/\/workouts\/?(\?.*)?$/);
        await ctx.expectText('This week');
        await stepThen(ctx, 'open the Garmin strength session', () => clickButton(page, /^Strength training, /), async () => {
          await ctx.expectUrl(/\/workouts\/[0-9a-f-]{36}/);
          await ctx.expectText('Time in heart-rate zones');
          await ctx.check('the detail page keeps the Workouts row lit, with the sidebar and a back button', async () => {
            await litLink(page, 'Workouts').waitFor({ state: 'visible', timeout: 6000 });
            await page.getByRole('button', { name: 'Go back', exact: true }).first().waitFor({ state: 'visible', timeout: 6000 });
          });
        });
      });
      await stepThen(ctx, 'open the food search from the add button', () => clickButton(page, 'Add to diary', { exact: true }), async () => {
        await ctx.expectUrl(/\/add/);
        await stepThen(ctx, 'choose Search food', () => clickButton(page, /Search food/), async () => {
          await ctx.expectUrl(/\/search/);
          await ctx.check('the sidebar is on the search screen too', () => sidebarLink(page, 'Foods').waitFor({ state: 'visible', timeout: 6000 }));
        });
      });
    },
  },
  {
    // The Add food screen has a "..." in its header to change WHAT is being added (same list as the "+" of the tab bar).
    name: 'search: the "..." menu switches to another way of adding',
    route: '/search',
    path: '/search',
    auth: 'signed-in',
    expect: ['Add food'],
    async after(page, ctx) {
      await stepThen(ctx, 'open the "..." menu', () => clickButton(page, 'More ways to add', { exact: true }), async () => {
        await ctx.expectText('Add something else');
        for (const label of ['Scan barcode', 'Create custom food', 'Add exercise', 'Add biometric', 'Add note', 'Add water']) {
          await ctx.expectText(label);
        }
        await ctx.expectNoText('Photo log', { timeout: 1500 }); // AI entries stay hidden without an AI key
        await ctx.expectNoText('Search food', { timeout: 1500 }); // this is the screen the user is on
        await ctx.snapshot('add-menu', { tall: false });
        await stepThen(ctx, 'choose Add exercise', () => clickButton(page, 'Add exercise', { exact: true }), () => ctx.expectUrl(/\/exercise\/new/));
      });
    },
  },
  {
    name: 'search: picking an ingredient for a recipe has no "..." menu',
    route: '/search',
    path: '/search?mode=pick',
    auth: 'signed-in',
    expect: ['Add ingredient'],
    async after(page, ctx) {
      await ctx.check('no "More ways to add" button', async () => {
        if ((await page.getByRole('button', { name: 'More ways to add', exact: true }).count()) > 0) throw new Error('the menu button is shown in pick mode');
      });
    },
  },

  // ------------------------------------------------------------------------------------------ workouts (More > Workouts)
  ...WORKOUT_SCENARIOS,

  // ------------------------------------------------------------------------------------------ themes (Settings > Display)
  ...THEME_SCENARIOS,
];
