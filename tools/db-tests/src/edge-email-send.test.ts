import { describe, expect, it } from 'vitest';
import { FROM_ADDRESS } from '../../../supabase/functions/_shared/emails.ts';
import { makeSendEmail, type SendCall } from '../../../supabase/functions/_shared/email-send.ts';

const MESSAGE = {
  to: 'anna@example.com',
  subject: "You're invited to Ration",
  html: '<p>hello</p>',
  text: 'hello',
};

// The sender the Edge Functions use: a POST to the fullsend API (the Resend body), classified like every
// other upstream call in the app (see fetchUpstreamJson). It never throws and never logs an address.
describe('makeSendEmail', () => {
  const okFetch = (status = 200, body: unknown = { id: 'abc-123' }): { fetch: ReturnType<typeof makeSendEmail>['name']; calls: SendCall[]; fn: (input: string, init?: RequestInit) => Promise<Response> } & Record<string, unknown> => {
    const calls: SendCall[] = [];
    const fn = async (input: string, init?: RequestInit) => {
      calls.push({ url: input, init: init ?? {} });
      return new Response(JSON.stringify(body), { status });
    };
    return { calls, fn } as never;
  };

  it('POSTs the Resend body to <baseUrl>/emails with the bearer key and the fixed From, and answers ok with the id', async () => {
    const { calls, fn } = okFetch();
    const outcome = await makeSendEmail(fn, 'https://send.example.com', 'fs_key')(MESSAGE);
    expect(outcome).toEqual({ ok: true, id: 'abc-123' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://send.example.com/emails');
    const init = calls[0]!.init;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fs_key');
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ from: FROM_ADDRESS, ...MESSAGE });
  });

  it('a 429 is rate_limited, any other non-2xx is http_<status>, a network error is network, and none of them throw', async () => {
    expect(await makeSendEmail(async () => new Response('{}', { status: 429 }), 'https://s.example', 'k')(MESSAGE)).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect(await makeSendEmail(async () => new Response('no', { status: 503 }), 'https://s.example', 'k')(MESSAGE)).toMatchObject({ ok: false, reason: 'http_503' });
    expect(await makeSendEmail(async () => { throw new Error('nope'); }, 'https://s.example', 'k')(MESSAGE)).toMatchObject({ ok: false, reason: 'network' });
    const abort = new Error('too slow'); abort.name = 'AbortError';
    expect(await makeSendEmail(async () => { throw abort; }, 'https://s.example', 'k')(MESSAGE)).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('dry run sends nothing and answers ok (local dev: the rendered mail is logged instead)', async () => {
    const calls: SendCall[] = [];
    const lines: string[] = [];
    const sender = makeSendEmail(
      async (input, init) => {
        calls.push({ url: input, init: init ?? {} });
        return new Response('{}', { status: 200 });
      },
      'https://send.example.com',
      'fs_key',
      { log: (line, detail) => lines.push(line + ' ' + JSON.stringify(detail ?? '')) },
    );
    const outcome = await sender(MESSAGE, { dryRun: true });
    expect(outcome).toEqual({ ok: true, id: null });
    expect(calls).toHaveLength(0);
    expect(lines.join('\n')).toContain('anna@example.com');
    expect(lines.join('\n')).toContain('hello');
  });

  it('a 2xx without an id is still ok (the id is optional)', async () => {
    const outcome = await makeSendEmail(async () => new Response('', { status: 201 }), 'https://s.example', 'k')(MESSAGE);
    expect(outcome).toEqual({ ok: true, id: null });
  });
});
