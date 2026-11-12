import { describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../../../supabase/functions/_shared/http.ts';
import {
  DEFAULT_FRIEND_REQUEST_LIMITS,
  friendRequest,
  parseFriendRequestBody,
  type FriendRequestDeps,
} from '../../../supabase/functions/_shared/friend-request.ts';
import { classifyFriendRequestError } from '../../../supabase/functions/_shared/friend-request-store.ts';

// The pure handler behind the `friend-request` Edge Function. The Friends screen called public.send_friend_request
// directly; now the Edge Function in front of it also e-mails the addressee when a request was actually created
// (public.send_friend_request_internal answers created = true ONLY then, so an address without an account is never
// e-mailed and the client-side answer never changes).
function deps(overrides: Partial<FriendRequestDeps> = {}): FriendRequestDeps & { logLines: string[]; sent: unknown[] } {
  const logLines: string[] = [];
  const sent: unknown[] = [];
  return {
    logLines,
    sent,
    consumeRateLimit: vi.fn(async () => 0),
    sendRequestInternal: vi.fn(async () => ({ kind: 'ok' as const, status: 'sent', created: true })),
    displayNameOf: vi.fn(async () => 'Anna'),
    sendEmail: vi.fn(async (message: unknown) => {
      sent.push(message);
      return { ok: true, id: 'mail-1' };
    }),
    log: (kind: string, detail?: unknown) => logLines.push(`${kind} ${JSON.stringify(detail ?? '')}`),
    ...overrides,
  } as unknown as FriendRequestDeps & { logLines: string[]; sent: unknown[] };
}

const USER_A = '00000000-0000-4000-8000-00000000000a';

const run = (d: FriendRequestDeps, body: unknown, userId = USER_A): Promise<ApiResult> => friendRequest(userId, body, d);

describe('classifyFriendRequestError (the store\u2019s mapping of the database refusals)', () => {
  it('22023 with "own e-mail" is own_email, any other 22023 is invalid_email, 54000 is too_many, everything else is a sanitised error', () => {
    expect(classifyFriendRequestError({ code: '22023', message: 'that is your own e-mail address' })).toEqual({ kind: 'own_email' });
    expect(classifyFriendRequestError({ code: '22023', message: 'that is not a valid e-mail address' })).toEqual({ kind: 'invalid_email' });
    expect(classifyFriendRequestError({ code: '54000', message: 'too many friend requests today, try again tomorrow' })).toEqual({ kind: 'too_many' });
    expect(classifyFriendRequestError({ code: '42501', message: 'permission denied' })).toEqual({ kind: 'error', reason: '42501' });
    expect(classifyFriendRequestError({ code: 'XX Weird & long', message: '' })).toEqual({ kind: 'error', reason: 'unknown' });
  });
});

describe('parseFriendRequestBody', () => {
  it('takes the e-mail trimmed and lower-case', () => {
    expect(parseFriendRequestBody({ email: '  BOB@Example.com ' })).toEqual({ email: 'bob@example.com' });
  });

  it('refuses a missing or malformed e-mail (400, the same rule as the screen and the database)', () => {
    for (const email of [undefined, null, '', 'bob', 'bob@', 'a@b', `${'a'.repeat(250)}@example.com`]) {
      expect(parseFriendRequestBody({ email }), String(email)).toMatchObject({ status: 400 });
    }
  });
});

describe('friendRequest', () => {
  it('for a created request: mails the addressee with the sender\'s name and answers sent', async () => {
    const d = deps({ sendRequestInternal: vi.fn(async () => ({ kind: 'ok' as const, status: 'sent', created: true })) });
    const res = await run(d, { email: '  BOB@example.com ' });
    expect(res).toEqual({ status: 200, body: { status: 'sent' } });
    expect(d.sendRequestInternal as unknown as { calls: unknown[] }).toBeTruthy();
    expect((d.sendRequestInternal as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]).toEqual([USER_A, 'bob@example.com']);
    expect(d.sent).toHaveLength(1);
    const mail = d.sent[0] as { to: string; subject: string; html: string; text: string };
    expect(mail.to).toBe('bob@example.com');
    expect(mail.subject).toBe('Anna wants to be your friend on Ration');
    expect(mail.html).toContain('Anna');
  });

  it('an address without an account answers sent WITHOUT a mail (the same answer as a real one: the client never learns)', async () => {
    const d = deps({ sendRequestInternal: vi.fn(async () => ({ kind: 'ok' as const, status: 'sent', created: false })) });
    const res = await run(d, { email: 'nobody@example.com' });
    expect(res).toEqual({ status: 200, body: { status: 'sent' } });
    expect(d.sent).toHaveLength(0);
  });

  it('accepted / already_friends / already_requested are answered as they are, and nobody is mailed', async () => {
    for (const status of ['accepted', 'already_friends', 'already_requested']) {
      const d = deps({ sendRequestInternal: vi.fn(async () => ({ kind: 'ok' as const, status, created: false })) });
      expect(await run(d, { email: 'bob@example.com' })).toEqual({ status: 200, body: { status } });
      expect(d.sent).toHaveLength(0);
    }
  });

  it('throttles before the database is touched: 20 requests per user per day, like the database limit', async () => {
    const waited = 7200;
    const d = deps({ consumeRateLimit: vi.fn(async () => waited) });
    const res = await run(d, { email: 'bob@example.com' });
    expect(res.status).toBe(429);
    expect((d.sendRequestInternal as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(0);
    expect((d.consumeRateLimit as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]).toEqual([USER_A, 'friend-request', DEFAULT_FRIEND_REQUEST_LIMITS.perUser, DEFAULT_FRIEND_REQUEST_LIMITS.windowSeconds]);
  });

  it('the database refusals become answers the app can put in plain words: own e-mail, malformed, too many', async () => {
    const own = await run(deps({ sendRequestInternal: vi.fn(async () => ({ kind: 'own_email' as const })) }), { email: 'alice@example.com' });
    expect(own).toMatchObject({ status: 400, body: { error: 'own_email' } });
    const invalid = await run(deps({ sendRequestInternal: vi.fn(async () => ({ kind: 'invalid_email' as const })) }), { email: 'a@b.co' });
    expect(invalid).toMatchObject({ status: 400, body: { error: 'invalid_email' } });
    const tooMany = await run(deps({ sendRequestInternal: vi.fn(async () => ({ kind: 'too_many' as const })) }), { email: 'a@b.co' });
    expect(tooMany.status).toBe(429);
  });

  it('a failed mail does not fail the request: the request exists, so the answer stays sent (only the outcome is logged)', async () => {
    const d = deps({ sendEmail: vi.fn(async () => ({ ok: false as const, reason: 'http_503' })) });
    const res = await run(d, { email: 'bob@example.com' });
    expect(res).toEqual({ status: 200, body: { status: 'sent' } });
    expect(d.logLines.join('\n')).not.toContain('bob@example.com');
  });

  it('a failed name lookup still sends the mail (the template has a name fallback)', async () => {
    const d = deps({
      displayNameOf: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    const res = await run(d, { email: 'bob@example.com' });
    expect(res).toEqual({ status: 200, body: { status: 'sent' } });
    const mail = d.sent[0] as { subject: string };
    expect(mail.subject).toMatch(/wants to be your friend on Ration$/);
  });
});
