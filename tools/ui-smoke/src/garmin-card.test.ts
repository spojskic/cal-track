// The Garmin card on the WEB build must only explain ("Garmin sync runs in the iPhone and Android app") and offer no button.
// The browser run cannot happen in the sandbox, so the scenario's own assertions are exercised here with a fake page.
import { describe, expect, it } from 'vitest';

import { SCENARIOS } from './scenarios';
import type { Scenario, ScenarioContext } from './types';

const integrations = SCENARIOS.find((s) => s.route === '/settings/integrations') as Scenario;
const signIn = SCENARIOS.find((s) => s.route === '/settings/garmin-sign-in') as Scenario;

/** A page whose buttons are known by name; `getByRole('button', { name })` counts the ones the pattern matches. */
function fakePage(buttons: string[]) {
  return {
    getByRole: (_role: string, options: { name: string | RegExp; exact?: boolean }) => ({
      count: async () =>
        buttons.filter((b) => (options.name instanceof RegExp ? options.name.test(b) : options.exact ? b === options.name : b.includes(options.name))).length,
    }),
  };
}

function fakeContext(backendCalls: { target: string }[] = []) {
  const failures: string[] = [];
  const texts: string[] = [];
  const ctx = {
    backend: { calls: backendCalls },
    check: async (label: string, fn: () => unknown) => {
      try {
        await fn();
        return true;
      } catch (e) {
        failures.push(`${label}: ${(e as Error).message}`);
        return false;
      }
    },
    expectText: async (text: string | RegExp) => {
      texts.push(String(text));
      return true;
    },
  };
  return { ctx: ctx as unknown as ScenarioContext, failures, texts };
}

describe('scenario: the Garmin card on the web build', () => {
  it('exists and expects the note that Garmin sync runs in the phone app', () => {
    expect(integrations).toBeDefined();
    expect(integrations.expect).toContain('Garmin sync runs in the iPhone and Android app');
    expect(signIn.expect).toContain('Garmin sync runs in the iPhone and Android app');
    expect(signIn.auth).toBe('signed-in');
  });

  it('passes when the page has no Connect Garmin / Sync now / Copy sync report button', async () => {
    const { ctx, failures, texts } = fakeContext();
    await integrations.after?.(fakePage(['Go back', 'Profile & targets']) as never, ctx);
    expect(failures).toEqual([]);
    expect(texts).toContain('Garmin sync runs in the iPhone and Android app');
  });

  it('fails when a Connect Garmin button shows up on the web', async () => {
    for (const button of ['Connect Garmin', 'Sync now', 'Copy sync report', 'Sign in to Garmin again']) {
      const { ctx, failures } = fakeContext();
      await integrations.after?.(fakePage(['Go back', button]) as never, ctx);
      expect(failures.join('\n'), button).toContain('found 1 button');
    }
  });

  it('fails when the web build talks to a Garmin function or rpc', async () => {
    const { ctx, failures } = fakeContext([{ target: 'garmin_connection_status' }]);
    await integrations.after?.(fakePage([]) as never, ctx);
    expect(failures.join('\n')).toContain('garmin_connection_status');
  });
});
