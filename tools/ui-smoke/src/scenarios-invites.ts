/**
 * Smoke scenarios of the super admin's Invite people screen (More > Admin > Invite people on a phone, the Admin group of the sidebar on
 * a desktop). Appended to the main list by scenarios.ts.
 *
 * Fixtures: the `admin` variant is the default account with profiles.is_admin = true; the mock backend (invite-admin.ts) holds five
 * codes of every kind: an unused one for anna@example.com (13 days left), a family code from before the e-mail field (only a note) used
 * once of three, a used-up one for Ben, an expired one for Carla and a revoked one. The default variant is an ordinary user: no Admin
 * section, and the page says it is for the owner. The lists are paged by 20 (PostgREST limit / offset on the mock).
 */
import type { Page } from 'playwright-core';

import { clickButton, fill } from './actions';
import { ANON_KEY, BACKEND_ORIGIN, FIXED_NOW_MS } from './constants';
import { SEEDED_INVITES } from './invite-admin';
import { SEED_SESSION_TTL_SECONDS, buildSession } from './session';
import type { Scenario, ScenarioContext } from './types';

/** Runs an interaction; runs the follow-up assertions only when the interaction worked. */
async function stepThen(ctx: ScenarioContext, label: string, act: () => Promise<unknown>, then: () => Promise<unknown>): Promise<void> {
  if (await ctx.step(label, act)) await then();
}

const adminCalls = (ctx: ScenarioContext): string[] =>
  ctx.backend.calls.filter((c) => c.kind === 'rpc' && c.target.startsWith('admin_')).map((c) => c.target);

/** Makes `n` more active codes through the mock backend before the page opens (the way the owner would have, one by one). */
function makeCodes(ctx: ScenarioContext, n: number): void {
  const token = buildSession(ctx.fixtures.user, { nowMs: FIXED_NOW_MS, ttlSeconds: SEED_SESSION_TTL_SECONDS }).access_token;
  for (let i = 0; i < n; i++) {
    const res = ctx.backend.handle({
      method: 'POST',
      url: `${BACKEND_ORIGIN}/rest/v1/rpc/admin_create_invite_code_for`,
      headers: { apikey: ANON_KEY, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ p_email: `friend${String(i).padStart(2, '0')}@example.com`, p_max_uses: 1, p_valid_days: 14 }),
    });
    if (res.status !== 200) throw new Error(`could not make code ${i}: ${res.status} ${res.body}`);
  }
}

const buttonCount = (page: Page, name: string | RegExp, exact = false): Promise<number> => page.getByRole('button', { name, exact }).count();

export const INVITE_SCENARIOS: Scenario[] = [
  {
    name: 'more: the super admin has an Admin section with Invite people',
    route: '/more',
    path: '/more',
    auth: 'signed-in',
    fixtures: 'admin',
    viewports: ['phone', 'phone-dark'],
    expect: ['Admin', 'Invite people', 'Create invite codes and see which are still unused'],
    async after(page, ctx) {
      await stepThen(ctx, 'open Invite people', () => clickButton(page, /^Invite people\./), async () => {
        await ctx.expectUrl(/\/settings\/invites\/?(\?.*)?$/);
        await ctx.expectText('Create an invite code');
      });
    },
  },
  {
    name: 'sidebar: the super admin has an Admin group with Invite people',
    route: '/',
    path: '/',
    auth: 'signed-in',
    fixtures: 'admin',
    viewports: ['desktop', 'desktop-dark'],
    expect: ['Admin'],
    async after(page, ctx) {
      await stepThen(ctx, 'open Invite people', () => page.getByRole('link', { name: 'Invite people', exact: true }).first().click({ timeout: 6000 }), async () => {
        await ctx.expectUrl(/\/settings\/invites\/?(\?.*)?$/);
        await ctx.expectText('Create an invite code');
        await ctx.expectText('Active codes');
      });
    },
  },
  {
    name: 'more: an ordinary user has no Admin section',
    route: '/more',
    path: '/more',
    auth: 'signed-in',
    viewports: ['phone'],
    expect: ['Workouts', 'Connected apps'],
    async after(_page, ctx) {
      await ctx.expectNoText('Invite people', { timeout: 1500 });
      await ctx.expectNoText(/^Admin$/, { timeout: 500 });
    },
  },
  {
    name: 'sidebar: an ordinary user has no Admin group',
    route: '/',
    path: '/',
    auth: 'signed-in',
    viewports: ['desktop'],
    expect: ['Workouts'],
    async after(page, ctx) {
      await ctx.check('there is no Invite people link', async () => {
        if ((await page.getByRole('link', { name: 'Invite people', exact: true }).count()) > 0) throw new Error('the Invite people row is shown');
      });
      await ctx.expectNoText(/^Admin$/, { timeout: 500 });
    },
  },
  {
    name: 'invites: an ordinary user who opens the page is told it is for the owner and nothing is asked of the database',
    route: '/settings/invites',
    path: '/settings/invites',
    auth: 'signed-in',
    expect: ['Invite people', 'Only the app owner can invite people.'],
    async after(_page, ctx) {
      await ctx.expectNoText('Create an invite code', { timeout: 800 });
      await ctx.check('no admin RPC was called', () => {
        const calls = adminCalls(ctx);
        if (calls.length > 0) throw new Error(`called ${calls.join(', ')}`);
      });
    },
  },
  {
    name: 'invites: the super admin sees the active codes first and the closed ones on request',
    route: '/settings/invites',
    path: '/settings/invites',
    auth: 'signed-in',
    fixtures: 'admin',
    expect: [
      'Create an invite code',
      'E-mail',
      'Active codes',
      SEEDED_INVITES.unused,
      'anna@example.com',
      'Not used yet',
      'Expires in 13 days',
      SEEDED_INVITES.partlyUsed,
      'family', // made before the e-mail field: its note is shown
      '1 of 3 used',
      'Never expires',
      'Closed codes',
    ],
    async after(page, ctx) {
      await ctx.check('everything fits on one page: no Previous / Next', async () => {
        if ((await buttonCount(page, /(Previous|Next) page of/)) > 0) throw new Error('page controls are shown for 2 codes');
      });
      await ctx.check('only the two active codes can be revoked and copied', async () => {
        const revoke = await buttonCount(page, /^Revoke code [A-Z0-9]{4}-/);
        const copy = await buttonCount(page, /^Copy code [A-Z0-9]{4}-/);
        if (revoke !== 2 || copy !== 2) throw new Error(`revoke buttons: ${revoke}, copy buttons: ${copy}`);
      });
      await ctx.expectNoText(SEEDED_INVITES.usedUp, { timeout: 800 }); // closed codes are collapsed
      await stepThen(ctx, 'show the closed codes', () => clickButton(page, 'Show closed codes (3)', { exact: true }), async () => {
        await ctx.expectText(SEEDED_INVITES.usedUp);
        await ctx.expectText('ben@example.com');
        await ctx.expectText('Used 1 of 1');
        await ctx.expectText(SEEDED_INVITES.expired);
        await ctx.expectText('carla@example.com');
        await ctx.expectText('Expired 2 days ago');
        await ctx.expectText(SEEDED_INVITES.revoked);
        await ctx.expectText('old test');
        await ctx.expectText('Revoked', { exact: true });
        await ctx.check('closed codes have no Revoke button', async () => {
          if ((await buttonCount(page, /^Revoke code /)) !== 2) throw new Error('a closed code can be revoked');
        });
      });
      await ctx.snapshot('closed-shown');
    },
  },
  {
    name: 'invites: create a code for a person',
    route: '/settings/invites',
    path: '/settings/invites',
    auth: 'signed-in',
    fixtures: 'admin',
    expect: ['Create an invite code'],
    async after(page, ctx) {
      await stepThen(
        ctx,
        'fill the form and create the code',
        async () => {
          await fill(page, 'E-mail', '  Dora@Example.com ');
          await fill(page, 'Number of uses', '2');
          await clickButton(page, '30 days', { exact: true });
          await clickButton(page, 'Create code', { exact: true });
        },
        async () => {
          await ctx.expectMutation('rpc:admin_create_invite_code_for', 'rpc', (m) => {
            const p = m.payload as Record<string, unknown>;
            return p.p_email === 'dora@example.com' && p.p_max_uses === 2 && p.p_valid_days === 30;
          });
          await ctx.expectText('New invite code for dora@example.com');
          await ctx.expectText(/[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}/);
          await ctx.expectText('Expires in 30 days');
          await ctx.expectText('Not used yet');
          await ctx.expectInputValue('E-mail', '', { timeout: 3000 }); // the form starts again
          await ctx.snapshot('created');
          await stepThen(ctx, 'copy the code', () => clickButton(page, 'Copy code', { exact: true }), async () => {
            await ctx.check('no error is shown', async () => {
              if ((await page.getByText('Something went wrong').count()) > 0) throw new Error('an error is shown');
            });
          });
          await stepThen(ctx, 'dismiss the new code', () => clickButton(page, 'Done', { exact: true }), async () => {
            await ctx.expectNoText('New invite code for dora@example.com', { timeout: 3000 });
            await ctx.expectText('dora@example.com'); // still in the list
          });
        },
      );
    },
  },
  {
    name: 'invites: a missing or bad e-mail and a bad number of uses are refused before anything is sent',
    route: '/settings/invites',
    path: '/settings/invites',
    auth: 'signed-in',
    fixtures: 'admin',
    expect: ['Create an invite code'],
    async after(page, ctx) {
      await stepThen(
        ctx,
        'create without an e-mail',
        () => clickButton(page, 'Create code', { exact: true }),
        async () => {
          await ctx.expectText('Enter the e-mail address of the person you are inviting.');
        },
      );
      await stepThen(
        ctx,
        'a name instead of an e-mail, and 0 uses',
        async () => {
          await fill(page, 'E-mail', 'Anna');
          await fill(page, 'Number of uses', '0');
          await clickButton(page, 'Create code', { exact: true });
        },
        async () => {
          await ctx.expectText('Enter a valid e-mail address, for example anna@example.com.');
          await ctx.expectText('Enter a whole number from 1 to 1000.');
          await ctx.check('nothing was created', () => {
            if (ctx.backend.mutationsOf('rpc:admin_create_invite_code_for').length > 0) throw new Error('a code was created');
          });
        },
      );
    },
  },
  {
    name: 'invites: revoking asks first, then the code moves to the closed ones',
    route: '/settings/invites',
    path: '/settings/invites',
    auth: 'signed-in',
    fixtures: 'admin',
    expect: [SEEDED_INVITES.unused],
    async after(page, ctx) {
      await stepThen(ctx, 'ask to revoke the code for anna@example.com', () => clickButton(page, `Revoke code ${SEEDED_INVITES.unused}`, { exact: true }), async () => {
        await ctx.expectText('Revoke this code?');
        await ctx.expectText('H2KP-7TQM-4WXN (anna@example.com) will stop working');
        await stepThen(ctx, 'cancel', () => clickButton(page, 'Cancel', { exact: true }), async () => {
          await ctx.check('nothing was revoked', () => {
            if (ctx.backend.mutationsOf('rpc:admin_revoke_invite_code').length > 0) throw new Error('revoked without asking');
          });
        });
      });
      await stepThen(ctx, 'revoke it for real', async () => {
        await clickButton(page, `Revoke code ${SEEDED_INVITES.unused}`, { exact: true });
        await clickButton(page, 'Revoke code', { exact: true });
      }, async () => {
        await ctx.expectMutation('rpc:admin_revoke_invite_code', 'rpc', (m) => (m.payload as Record<string, unknown>).p_code === SEEDED_INVITES.unused);
        await ctx.expectNoText(SEEDED_INVITES.unused, { timeout: 4000 }); // gone from the active list, the closed list is collapsed
        await stepThen(ctx, 'show the closed codes', () => clickButton(page, 'Show closed codes (4)', { exact: true }), async () => {
          await ctx.expectText(SEEDED_INVITES.unused);
        });
      });
    },
  },
  {
    name: 'invites: 21 active codes are paged by 20 with Previous / Next, and revoking the last one steps back a page',
    route: '/settings/invites',
    path: '/settings/invites',
    auth: 'signed-in',
    fixtures: 'admin',
    expect: ['Active codes', '1\u201320 of 21'],
    async setup(_page, ctx) {
      makeCodes(ctx, 19); // 2 seeded active codes + 19 = 21 active: a page of 20 and a page of 1
    },
    async after(page, ctx) {
      await ctx.check('page 1 shows 20 codes and Previous is off', async () => {
        const rows = await buttonCount(page, /^Copy code [A-Z0-9]{4}-/);
        if (rows !== 20) throw new Error(`${rows} codes on page 1`);
        if (!(await page.getByRole('button', { name: 'Previous page of active codes', exact: true }).isDisabled())) throw new Error('Previous is enabled on page 1');
        if (await page.getByRole('button', { name: 'Next page of active codes', exact: true }).isDisabled()) throw new Error('Next is disabled on page 1');
      });
      await ctx.expectNoText(SEEDED_INVITES.partlyUsed, { timeout: 800 }); // the oldest active code is on the second page
      await ctx.snapshot('page-1');
      await stepThen(ctx, 'next page', () => clickButton(page, 'Next page of active codes', { exact: true }), async () => {
        await ctx.expectText('21 of 21');
        await ctx.expectText(SEEDED_INVITES.partlyUsed);
        await ctx.check('page 2 shows the one code left, and Next is off', async () => {
          const rows = await buttonCount(page, /^Copy code [A-Z0-9]{4}-/);
          if (rows !== 1) throw new Error(`${rows} codes on page 2`);
          if (!(await page.getByRole('button', { name: 'Next page of active codes', exact: true }).isDisabled())) throw new Error('Next is enabled on the last page');
        });
        await ctx.snapshot('page-2');
        await stepThen(ctx, 'previous page', () => clickButton(page, 'Previous page of active codes', { exact: true }), async () => {
          await ctx.expectText('1\u201320 of 21');
          await ctx.expectNoText(SEEDED_INVITES.partlyUsed, { timeout: 800 });
        });
      });
      await stepThen(
        ctx,
        'go to page 2 and revoke the only code on it',
        async () => {
          await clickButton(page, 'Next page of active codes', { exact: true });
          await clickButton(page, `Revoke code ${SEEDED_INVITES.partlyUsed}`, { exact: true });
          await clickButton(page, 'Revoke code', { exact: true });
        },
        async () => {
          await ctx.expectMutation('rpc:admin_revoke_invite_code', 'rpc', (m) => (m.payload as Record<string, unknown>).p_code === SEEDED_INVITES.partlyUsed);
          // page 2 is gone: the list went back to page 1, which now holds all 20 and needs no controls
          await ctx.expectText('Active codes');
          await ctx.check('back on a page of 20 without page controls', async () => {
            await page.waitForTimeout(600);
            const rows = await buttonCount(page, /^Copy code [A-Z0-9]{4}-/);
            if (rows !== 20) throw new Error(`${rows} codes shown`);
            if ((await buttonCount(page, /(Previous|Next) page of active codes/)) > 0) throw new Error('page controls are still shown');
          });
        },
      );
    },
  },
  {
    name: 'invites: closed codes are paged too',
    route: '/settings/invites',
    path: '/settings/invites',
    auth: 'signed-in',
    fixtures: 'admin',
    expect: ['Closed codes'],
    async setup(_page, ctx) {
      // revoke 21 new codes so that the closed list (3 seeded + 21) needs two pages
      makeCodes(ctx, 21);
      const token = buildSession(ctx.fixtures.user, { nowMs: FIXED_NOW_MS, ttlSeconds: SEED_SESSION_TTL_SECONDS }).access_token;
      const headers = { apikey: ANON_KEY, authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const list = ctx.backend.handle({ method: 'POST', url: `${BACKEND_ORIGIN}/rest/v1/rpc/admin_list_invites?status=eq.active&limit=100`, headers, body: '{}' });
      for (const row of JSON.parse(list.body) as { code: string; invited_email: string | null }[]) {
        if (!row.invited_email?.startsWith('friend')) continue;
        ctx.backend.handle({ method: 'POST', url: `${BACKEND_ORIGIN}/rest/v1/rpc/admin_revoke_invite_code`, headers, body: JSON.stringify({ p_code: row.code }) });
      }
    },
    async after(page, ctx) {
      await stepThen(ctx, 'show the closed codes', () => clickButton(page, 'Show closed codes (24)', { exact: true }), async () => {
        await ctx.expectText('1\u201320 of 24');
        await stepThen(ctx, 'next page of closed codes', () => clickButton(page, 'Next page of closed codes', { exact: true }), async () => {
          await ctx.expectText('21\u201324 of 24');
          // page 2 holds the last four closed codes: the oldest, so the seeded ones (the page label is there before its rows)
          await ctx.expectText(SEEDED_INVITES.usedUp);
          await ctx.expectText(SEEDED_INVITES.expired);
          await ctx.expectText(SEEDED_INVITES.revoked);
          await ctx.snapshot('closed-page-2');
        });
      });
    },
  },
];
