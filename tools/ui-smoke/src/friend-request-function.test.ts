import { describe, expect, it } from 'vitest';
import { FriendRequestFunctionMock, type FriendRequestHost } from './friend-request-function';

// The Edge Function `friend-request` as the smoke harness's mock backend answers it. Validation is the REAL one
// (parseFriendRequestBody from supabase/functions/_shared/friend-request.ts) and the mail is the REAL render
// (friendRequestEmail), recorded on the instance instead of sent; the request itself is created through the
// mock backend's own friends state (the same helpers the send_friend_request RPC uses).
const mock = (overrides: Partial<FriendRequestHost> = {}): { m: FriendRequestFunctionMock; host: FriendRequestHost; sent: { email: string; status: string }[] } => {
  const sent: { email: string; status: string }[] = [];
  return {
    m: new FriendRequestFunctionMock(),
    sent,
    host: {
      uid: '00000000-0000-4000-8000-00000000000a',
      send: (_requesterId: string, email: string) => {
        sent.push({ email, status: 'sent' });
        return { status: 'sent', created: true };
      },
      displayNameOf: () => 'Anna',
      ...overrides,
    } as FriendRequestHost,
  };
};

const BODY = JSON.stringify({ email: '  BOB@example.com ' });

describe('FriendRequestFunctionMock', () => {
  it('POST only', () => {
    const { m, host } = mock();
    expect(m.handle('GET', null, host)).toMatchObject({ status: 405 });
    expect(m.handle('POST', null, host)).toMatchObject({ status: 400, body: { error: 'invalid_json' } });
  });

  it('validates with the REAL parseFriendRequestBody and lower-cases the address', () => {
    const { m, host, sent } = mock();
    expect(m.handle('POST', BODY, host)).toEqual({ status: 200, body: { status: 'sent' } });
    expect(sent[0]).toEqual({ email: 'bob@example.com', status: 'sent' });
    const bad = mock();
    expect(bad.m.handle('POST', JSON.stringify({ email: 'nope' }), bad.host)).toMatchObject({ status: 400, body: { error: 'invalid_email' } });
  });

  it('mails the addressee with the sender\'s name only when the request was actually created', () => {
    const { m, host } = mock();
    m.handle('POST', BODY, host);
    expect(m.mails).toHaveLength(1);
    expect(m.mails[0]).toMatchObject({ to: 'bob@example.com', subject: 'Anna wants to be your friend on Ration' });

    const nobody = mock({ send: () => ({ status: 'sent', created: false }) });
    nobody.m.handle('POST', BODY, nobody.host);
    expect(nobody.m.mails).toHaveLength(0);
  });

  it('the other answers (accepted / already_friends / already_requested) arrive as they are, with no mail', () => {
    for (const status of ['accepted', 'already_friends', 'already_requested']) {
      const { m, host } = mock({ send: () => ({ status, created: false }) });
      expect(m.handle('POST', BODY, host)).toEqual({ status: 200, body: { status } });
      expect(m.mails).toHaveLength(0);
    }
  });

  it('the database refusals are answered as the function answers them', () => {
    const own = mock({ send: () => ({ kind: 'own_email' as const }) });
    expect(own.m.handle('POST', BODY, own.host)).toMatchObject({ status: 400, body: { error: 'own_email' } });
    const invalid = mock({ send: () => ({ kind: 'invalid_email' as const }) });
    expect(invalid.m.handle('POST', BODY, invalid.host)).toMatchObject({ status: 400, body: { error: 'invalid_email' } });
    const tooMany = mock({ send: () => ({ kind: 'too_many' as const }) });
    expect(tooMany.m.handle('POST', BODY, tooMany.host).status).toBe(429);
  });

  it('a failed mail does not fail the request (the request exists)', () => {
    const { m, host } = mock({ failMail: true });
    expect(m.handle('POST', BODY, host)).toEqual({ status: 200, body: { status: 'sent' } });
    expect(m.mails).toHaveLength(0);
  });

  it('throttles after 20 requests per user (the real DEFAULT_FRIEND_REQUEST_LIMITS) with 429 + Retry-After', () => {
    const { m, host } = mock();
    for (let i = 0; i < 20; i++) {
      expect(m.handle('POST', JSON.stringify({ email: `p${i}@example.com` }), host).status).toBe(200);
    }
    const res = m.handle('POST', JSON.stringify({ email: 'p21@example.com' }), host);
    expect(res.status).toBe(429);
    expect((res.body as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    expect(res.headers?.['Retry-After']).toBeTruthy();
  });
});
