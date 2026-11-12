/**
 * Smoke scenarios of the friends feature (More > Friends, the Friends row of the sidebar, the lists and search that show friends' foods).
 * Appended to the main list by scenarios.ts.
 *
 * Fixtures: the `friends` variant is the default account plus four people: Anna is a friend (she shares a custom food, a spice mix and a
 * lentil soup recipe; her AI estimate stays hidden), Ben has sent a request (incoming), the demo user has asked Dora (outgoing), and Carl
 * has no relation to anybody (his food must never show). The default variant has no friends at all.
 */
import type { Page } from 'playwright-core';
import { clickButton, clickText, fill } from './actions';
import { APP_ORIGIN } from './constants';
import { IDS } from './fixtures';
import type { Scenario, ScenarioContext } from './types';

/** Runs an interaction; runs the follow-up assertions only when the interaction worked. */
async function stepThen(ctx: ScenarioContext, label: string, act: () => Promise<unknown>, then: () => Promise<unknown>): Promise<void> {
  if (await ctx.step(label, act)) await then();
}

const F = IDS.food;
const OWN_ADDRESS = 'demo@ration.test';

const payloadOf = (m: { payload: unknown }): Record<string, unknown> => (m.payload ?? {}) as Record<string, unknown>;

/** Number of buttons whose accessible name matches. */
/** The "Add to diary" button of the page (on a desktop the sidebar has one too, and it comes first). */
const clickAddToDiary = (page: Page): Promise<void> => page.getByRole('button', { name: /^Add to diary/ }).last().click({ timeout: 6000 });

const buttonCount = (ctx: ScenarioContext, name: string | RegExp): Promise<number> =>
  ctx.page.getByRole('button', { name, exact: typeof name === 'string' }).count();

export const FRIEND_SCENARIOS: Scenario[] = [
  {
    name: 'more: Friends shows how many requests wait, on its row and on the More tab',
    route: '/more',
    path: '/more',
    auth: 'signed-in',
    fixtures: 'friends',
    viewports: ['phone', 'phone-dark'],
    expect: ['Friends', 'Share your custom foods and recipes with friends', '1 request'],
    async after(page, ctx) {
      await ctx.check('the More tab carries the count', async () => {
        const tab = page.getByRole('link', { name: 'More' }).first();
        const spoken = await tab.getAttribute('aria-valuetext');
        const text = await tab.innerText();
        if (spoken !== '1 friend request' && !/\b1\b/.test(text)) throw new Error(`no count on the tab: "${text}" / "${spoken}"`);
      });
      await ctx.snapshot('badge');
      await stepThen(ctx, 'open Friends', () => clickButton(page, /^Friends\./), async () => {
        await ctx.expectUrl(/\/friends\/?(\?.*)?$/);
        await ctx.expectText('Add a friend');
      });
    },
  },
  {
    name: 'more: without friend requests the Friends row and the More tab show no count',
    route: '/more',
    path: '/more',
    auth: 'signed-in',
    viewports: ['phone'],
    expect: ['Friends', 'Share your custom foods and recipes with friends'],
    async after(page, ctx) {
      await ctx.expectNoText('1 request', { timeout: 800 });
      await ctx.check('the More tab has no count', async () => {
        const tab = page.getByRole('link', { name: 'More' }).first();
        if ((await tab.getAttribute('aria-valuetext', { timeout: 4000 })) !== null) throw new Error('the More tab has a count');
      });
    },
  },
  {
    name: 'sidebar: the Friends row shows how many requests wait',
    route: '/',
    path: '/',
    auth: 'signed-in',
    fixtures: 'friends',
    viewports: ['desktop', 'desktop-dark'],
    expect: ['Friends'],
    async after(page, ctx) {
      await stepThen(ctx, 'open Friends from the sidebar', () => page.getByRole('link', { name: /^Friends/ }).first().click({ timeout: 6000 }), async () => {
        await ctx.expectUrl(/\/friends\/?(\?.*)?$/);
        await ctx.expectText('Add a friend');
        await ctx.expectText('1 request');
      });
    },
  },
  {
    name: 'friends: a user without friends sees an explanation and no count',
    route: '/friends',
    path: '/friends',
    auth: 'signed-in',
    expect: ['Add a friend', 'Friends see your custom foods and recipes, and nothing else', 'No friends yet.'],
    async after(_page, ctx) {
      await ctx.expectNoText('Requests', { exact: true, timeout: 800 });
      await ctx.expectNoText('Waiting for an answer', { timeout: 800 });
    },
  },
  {
    name: 'friends: friends, requests and the request I sent are listed',
    route: '/friends',
    path: '/friends',
    auth: 'signed-in',
    fixtures: 'friends',
    expect: [
      'Add a friend',
      'Requests',
      'Ben',
      'ben@example.com',
      'Received',
      'Waiting for an answer',
      'Dora',
      'dora@example.com',
      'Sent',
      'Anna',
      'anna@example.com',
      'Friends since',
    ],
    async after(page, ctx) {
      for (const name of ['Accept friend request from Ben', 'Decline friend request from Ben', 'Cancel friend request to Dora', 'Remove friend Anna']) {
        await ctx.check(`there is a "${name}" button`, async () => {
          if ((await buttonCount(ctx, name)) !== 1) throw new Error('missing');
        });
      }
      await ctx.expectNoText('Carl', { timeout: 800 });
      await ctx.snapshot('lists');
    },
  },
  {
    name: 'friends: accept a request and the person is a friend',
    route: '/friends',
    path: '/friends',
    auth: 'signed-in',
    fixtures: 'friends',
    expect: ['Requests', 'Ben'],
    async after(page, ctx) {
      await stepThen(ctx, 'accept Ben', () => clickButton(page, 'Accept friend request from Ben', { exact: true }), async () => {
        await ctx.expectMutation('rpc:respond_friend_request', 'rpc', (m) => payloadOf(m).p_id === IDS.friendship.ben && payloadOf(m).p_accept === true);
        await ctx.check('Ben is among the friends now and the request is gone', async () => {
          await page.getByRole('button', { name: 'Remove friend Ben', exact: true }).waitFor({ state: 'visible', timeout: 4000 });
          if ((await buttonCount(ctx, 'Accept friend request from Ben')) > 0) throw new Error('the request is still shown');
        });
        await ctx.expectNoText('Requests', { exact: true, timeout: 1500 });
      });
    },
  },
  {
    name: 'friends: decline a request and it is gone',
    route: '/friends',
    path: '/friends',
    auth: 'signed-in',
    fixtures: 'friends',
    expect: ['Requests', 'Ben'],
    async after(page, ctx) {
      await stepThen(ctx, 'decline Ben', () => clickButton(page, 'Decline friend request from Ben', { exact: true }), async () => {
        await ctx.expectMutation('rpc:respond_friend_request', 'rpc', (m) => payloadOf(m).p_id === IDS.friendship.ben && payloadOf(m).p_accept === false);
        await ctx.expectNoText('ben@example.com', { timeout: 4000 });
        await ctx.check('Ben did not become a friend', async () => {
          if ((await buttonCount(ctx, 'Remove friend Ben')) > 0) throw new Error('Ben is a friend');
        });
      });
    },
  },
  {
    name: 'friends: send a request to an e-mail address (an address without an account answers the same way)',
    route: '/friends',
    path: '/friends',
    auth: 'signed-in',
    fixtures: 'friends',
    expect: ['Add a friend', "Friend's e-mail"],
    async after(page, ctx) {
      await stepThen(
        ctx,
        'send a request to erin@example.com',
        async () => {
          await fill(page, "Friend's e-mail", '  Erin@Example.com ');
          await clickButton(page, 'Send request', { exact: true });
        },
        async () => {
          // the app asks the `friend-request` Edge Function, which creates the request and mails a real addressee
          await ctx.expectMutation('function:friend-request', 'function', (m) => payloadOf(m).email === 'erin@example.com');
          await ctx.expectText('Request sent. If erin@example.com uses Ration, they will see it the next time they open the app.');
          await ctx.expectInputValue("Friend's e-mail", '', { timeout: 3000 });
          await ctx.check('nobody new is listed as waiting (there is no such account)', async () => {
            if ((await buttonCount(ctx, /^Cancel friend request to /)) !== 1) throw new Error('the list of waiting requests changed');
          });
          await ctx.snapshot('sent');
        },
      );
    },
  },
  {
    name: 'friends: asking somebody who already asked you makes you friends',
    route: '/friends',
    path: '/friends',
    auth: 'signed-in',
    fixtures: 'friends',
    expect: ['Requests', 'Ben'],
    async after(page, ctx) {
      await stepThen(
        ctx,
        'send a request to ben@example.com',
        async () => {
          await fill(page, "Friend's e-mail", 'ben@example.com');
          await clickButton(page, 'Send request', { exact: true });
        },
        async () => {
          await ctx.expectText('ben@example.com had already asked you, so you are friends now.');
          await page.getByRole('button', { name: 'Remove friend Ben', exact: true }).waitFor({ state: 'visible', timeout: 4000 });
        },
      );
    },
  },
  {
    name: 'friends: a name instead of an e-mail, and your own address, are refused',
    route: '/friends',
    path: '/friends',
    auth: 'signed-in',
    fixtures: 'friends',
    expect: ['Add a friend'],
    allowBackendErrors: ['22023'],
    async after(page, ctx) {
      await stepThen(
        ctx,
        'send a request to "Anna"',
        async () => {
          await fill(page, "Friend's e-mail", 'Anna');
          await clickButton(page, 'Send request', { exact: true });
        },
        async () => {
          await ctx.expectText('Enter a valid e-mail address, for example anna@example.com.');
          await ctx.check('nothing was sent', () => {
            if (ctx.backend.mutationsOf('function:friend-request').length > 0) throw new Error('a request was sent');
          });
        },
      );
      await stepThen(
        ctx,
        'send a request to your own address',
        async () => {
          await fill(page, "Friend's e-mail", OWN_ADDRESS);
          await clickButton(page, 'Send request', { exact: true });
        },
        async () => {
          await ctx.expectText('That is your own e-mail address.');
        },
      );
    },
  },
  {
    name: 'friends: cancel a request I sent',
    route: '/friends',
    path: '/friends',
    auth: 'signed-in',
    fixtures: 'friends',
    expect: ['Waiting for an answer', 'Dora'],
    async after(page, ctx) {
      await stepThen(ctx, 'cancel the request to Dora', () => clickButton(page, 'Cancel friend request to Dora', { exact: true }), async () => {
        await ctx.expectMutation('friendships', 'delete', (m) => String((m as { filter?: unknown }).filter ?? '').includes(IDS.friendship.dora));
        await ctx.expectNoText('dora@example.com', { timeout: 4000 });
        await ctx.expectNoText('Waiting for an answer', { timeout: 1500 });
      });
    },
  },
  {
    name: 'friends: removing a friend asks first, and their foods leave the lists',
    route: '/friends',
    path: '/friends',
    auth: 'signed-in',
    fixtures: 'friends',
    expect: ['Anna', 'anna@example.com'],
    async after(page, ctx) {
      await stepThen(ctx, 'ask to remove Anna', () => clickButton(page, 'Remove friend Anna', { exact: true }), async () => {
        await ctx.expectText('Remove this friend?');
        await ctx.expectText('Anna will no longer see your custom foods and recipes');
        await stepThen(ctx, 'cancel', () => clickButton(page, 'Cancel', { exact: true }), async () => {
          await ctx.check('nothing was removed', () => {
            if (ctx.backend.mutationsOf('friendships', 'delete').length > 0) throw new Error('removed without asking');
          });
        });
      });
      await stepThen(
        ctx,
        'remove Anna for real',
        async () => {
          await clickButton(page, 'Remove friend Anna', { exact: true });
          await clickButton(page, 'Remove friend', { exact: true });
        },
        async () => {
          await ctx.expectMutation('friendships', 'delete', (m) => String((m as { filter?: unknown }).filter ?? '').includes(IDS.friendship.anna));
          await ctx.expectNoText('anna@example.com', { timeout: 4000 });
          await ctx.expectText('No friends yet. Accept a request or send one above.');
        },
      );
    },
  },
  {
    name: "foods: a friend's custom foods and recipes follow your own, marked as hers",
    route: '/foods',
    path: '/foods',
    auth: 'signed-in',
    fixtures: 'friends',
    expect: ['Foods', 'Favorites'],
    async after(page, ctx) {
      await stepThen(ctx, 'open My foods', () => clickText(page, 'My foods', { exact: true }), async () => {
        await ctx.expectText('Anna hummus');
        await ctx.expectText('Anna spice mix');
        await ctx.expectText('from Anna');
        await ctx.expectText('Ćevapi');
        await ctx.check('your own foods come first', async () => {
          const text = await page.locator('body').innerText();
          if (!(text.indexOf('Ćevapi') >= 0 && text.indexOf('Ćevapi') < text.indexOf('Anna hummus'))) throw new Error('a friend food is listed before an own food');
        });
        await ctx.expectNoText('Anna protein shake', { timeout: 800 }); // an AI estimate is not shared
        await ctx.expectNoText('Carl pasta sauce', { timeout: 800 }); // a stranger
        await ctx.expectNoText('Ben granola', { timeout: 800 }); // a request that was not accepted
        await ctx.snapshot('my-foods');
      });
      await stepThen(ctx, 'open Recipes', () => clickText(page, 'Recipes', { exact: true }), async () => {
        await ctx.expectText('Piletina s rižom');
        await ctx.expectText('Anna lentil soup');
        await ctx.expectText('from Anna');
        await ctx.snapshot('recipes');
      });
    },
  },
  {
    name: "foods: searching finds a friend's food, never a stranger's or an AI estimate",
    route: '/foods',
    path: '/foods',
    auth: 'signed-in',
    fixtures: 'friends',
    expect: ['Foods', 'Favorites'],
    async after(page, ctx) {
      await stepThen(ctx, 'search for hummus', () => fill(page, 'Search foods', 'hummus'), async () => {
        await ctx.expectText('Anna hummus');
        await ctx.expectText('from Anna');
      });
      await stepThen(ctx, 'search for pasta sauce', () => fill(page, 'Search foods', 'pasta sauce'), async () => {
        await ctx.expectNoText('Carl pasta sauce', { timeout: 1500 });
      });
      await stepThen(ctx, 'search for protein shake', () => fill(page, 'Search foods', 'protein shake'), async () => {
        await ctx.expectNoText('Anna protein shake', { timeout: 1500 });
      });
    },
  },
  {
    name: "food detail: a friend's food says who shared it, has no Edit, and can be logged",
    route: '/food/[id]',
    path: `/food/${F.annaHummus}`,
    auth: 'signed-in',
    fixtures: 'friends',
    expect: ['Anna hummus', 'Shared by Anna. You can use it, but only Anna can change it.', 'Add to diary'],
    async after(page, ctx) {
      await ctx.check('there is no Edit food button', async () => {
        if ((await buttonCount(ctx, 'Edit food')) > 0) throw new Error('a friend food can be edited');
      });
      await stepThen(ctx, 'add it to the diary', () => clickAddToDiary(page), async () => {
        await ctx.expectText(/Added to /);
        await ctx.expectMutation('diary_entries', 'insert', (m) => payloadOf(m).food_id === F.annaHummus);
      });
    },
  },
  {
    name: "recipe detail: a friend's recipe shows its ingredients and has no Edit, Duplicate or Delete",
    route: '/recipe/[id]',
    path: `/recipe/${F.annaSoup}`,
    auth: 'signed-in',
    fixtures: 'friends',
    expect: ['Anna lentil soup', 'Shared by Anna. You can use it, but only Anna can change it.', 'Ingredients', 'Anna spice mix'],
    async after(_page, ctx) {
      for (const name of ['Edit recipe', 'Duplicate recipe', 'Delete recipe']) {
        await ctx.check(`there is no "${name}" button`, async () => {
          if ((await buttonCount(ctx, name)) > 0) throw new Error('shown');
        });
      }
    },
  },
  {
    name: "food detail: a stranger's food is not found",
    route: '/food/[id]',
    path: `/food/${F.carlSauce}`,
    auth: 'signed-in',
    fixtures: 'friends',
    expect: ['Food not found'],
    allowText: [/Food not found/],
  },
  {
    name: 'friends: a food you logged stays in your diary and on its page after the friendship ends',
    route: '/food/[id]',
    path: `/food/${F.annaHummus}`,
    auth: 'signed-in',
    fixtures: 'friends',
    expect: ['Anna hummus', 'Add to diary'],
    async after(page, ctx) {
      await stepThen(ctx, 'log the hummus', () => clickAddToDiary(page), async () => {
        await ctx.expectText(/Added to /);
        await ctx.expectMutation('diary_entries', 'insert', (m) => payloadOf(m).food_id === F.annaHummus);
      });
      await stepThen(
        ctx,
        'end the friendship with Anna',
        async () => {
          await page.goto(`${APP_ORIGIN}/friends`);
          await page.getByRole('button', { name: 'Remove friend Anna', exact: true }).waitFor({ state: 'visible', timeout: 8000 });
          await clickButton(page, 'Remove friend Anna', { exact: true });
          await clickButton(page, 'Remove friend', { exact: true });
        },
        async () => {
          await ctx.expectMutation('friendships', 'delete', (m) => String((m as { filter?: unknown }).filter ?? '').includes(IDS.friendship.anna));
          await ctx.expectNoText('anna@example.com', { timeout: 4000 });
          // The query cache is saved to the browser storage at most once a second: reload only after the new list was saved.
          await page.waitForTimeout(1600);
        },
      );
      await stepThen(ctx, 'open the diary', () => page.goto(`${APP_ORIGIN}/diary`), async () => {
        await ctx.expectText('Anna hummus');
        await ctx.expectNoText('Unknown food', { timeout: 800 });
      });
      await stepThen(ctx, 'open the food page again', () => page.goto(`${APP_ORIGIN}/food/${F.annaHummus}`), async () => {
        await ctx.expectText('Anna hummus');
        await ctx.expectText('Shared by a former friend. You can use it, but only they can change it.');
      });
      await stepThen(ctx, "the friend's other food is gone", () => page.goto(`${APP_ORIGIN}/food/${F.annaSpice}`), async () => {
        await ctx.expectText('Food not found');
      });
    },
    allowText: [/Food not found/],
  },
];
