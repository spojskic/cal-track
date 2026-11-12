import { describe, expect, it } from 'vitest';
import { SendInviteFunctionMock, type SendInviteHost } from './send-invite-function';

// The Edge Function `send-invite` as the smoke harness's mock backend answers it. Validation is the REAL one
// (parseInviteBody from supabase/functions/_shared/invite.ts) and the mail is the REAL render (inviteEmail),
// recorded on the instance instead of sent; the code creation and the admin check are the mock backend's own
// state (the same helpers the admin_create_invite_code_for RPC uses).
const BODY = { email: 'anna@example.com', maxUses: 2, validDays: 14 };

const mock = (overrides: Partial<SendInviteHost> = {}): { m: SendInviteFunctionMock; created: unknown[]; host: SendInviteHost } => {
  const created: unknown[] = [];
  return {
    m: new SendInviteFunctionMock(),
    created,
    host: {
      isAdmin: () => true,
      createInviteFor: (email, maxUses, validDays) => {
        created.push({ email, maxUses, validDays });
        return 'H3KT-2XQP-9MWD';
      },
      ...overrides,
    },
  };
};

describe('SendInviteFunctionMock', () => {
  it('POST only', () => {
    const { m, host } = mock();
    expect(m.handle('GET', null, host)).toMatchObject({ status: 405 });
    expect(m.handle('POST', null, host)).toMatchObject({ status: 400, body: { error: 'invalid_json' } });
  });

  it('validates with the REAL parseInviteBody (defaults included) before anything else', () => {
    const { m, host, created } = mock();
    const ok = m.handle('POST', JSON.stringify({ email: '  Anna@Example.COM ' }), host);
    expect(ok.status).toBe(201);
    expect(created[0]).toEqual({ email: 'anna@example.com', maxUses: 1, validDays: null });
    const bad = mock();
    expect(bad.m.handle('POST', JSON.stringify({ email: 'nope' }), bad.host)).toMatchObject({ status: 400, body: { error: 'invalid_email' } });
  });

  it('refuses a non-admin (403 not_admin) and creates nothing', () => {
    const { m, created, host } = mock({ isAdmin: () => false });
    const res = m.handle('POST', JSON.stringify(BODY), host);
    expect(res).toMatchObject({ status: 403, body: { error: 'not_admin' } });
    expect(created).toHaveLength(0);
    expect(m.mails).toHaveLength(0);
  });

  it('a database failure while creating the code is a 500 and no mail is recorded (the real handler catches)', () => {
    const { m, host } = mock({
      createInviteFor: () => {
        throw new Error('db down');
      },
    });
    const res = m.handle('POST', JSON.stringify({ email: 'a@b.co' }), host);
    expect(res).toMatchObject({ status: 500, body: { error: 'internal_error' } });
    expect(m.mails).toHaveLength(0);
  });

  it('answers 201 { code, sent: true } and records the rendered mail (to + code in it)', () => {
    const { m, host } = mock();
    const res = m.handle('POST', JSON.stringify(BODY), host);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ code: 'H3KT-2XQP-9MWD', sent: true });
    expect(m.mails).toHaveLength(1);
    expect(m.mails[0]).toMatchObject({ to: 'anna@example.com', code: 'H3KT-2XQP-9MWD', subject: "You're invited to Ration" });
  });

  it('throttles after 10 calls (the real DEFAULT_INVITE_LIMITS) with 429 + Retry-After', () => {
    const { m, host } = mock();
    for (let i = 0; i < 10; i++) {
      expect(m.handle('POST', JSON.stringify({ email: `p${i}@example.com` }), host).status).toBe(201);
    }
    const res = m.handle('POST', JSON.stringify({ email: 'p11@example.com' }), host);
    expect(res.status).toBe(429);
    expect((res.body as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    expect(res.headers?.['Retry-After']).toBeTruthy();
  });
});
