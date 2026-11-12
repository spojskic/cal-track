import { describe, expect, it, vi, type Mock } from 'vitest';
import type { ApiResult } from '../../../supabase/functions/_shared/http.ts';
import { DEFAULT_INVITE_LIMITS, parseInviteBody, sendInvite, type InviteDeps } from '../../../supabase/functions/_shared/invite.ts';

// The pure handler behind the `send-invite` Edge Function (supabase/functions/send-invite/index.ts):
// the same shape as the sign-up function (supabase/functions/_shared/signup.ts). Order of work:
//   1. validate the body        400
//   2. throttle the admin       429   (BEFORE the code table is touched)
//   3. the super-admin check    403 not_admin   (the database gate of admin_create_invite_code_for, pre-checked so
//                                the e-mail is only sent for an admin: the RPC would refuse a non-admin anyway)
//   4. create the code          500 when the database fails (nothing was created yet)
//   5. render + send the mail   the code is returned either way: sent=false lets the owner fall back to
//                               copying it, and the mail must not orphan a code that already exists.
function deps(overrides: Partial<InviteDeps> = {}): InviteDeps & { logLines: string[]; sent: unknown[] } {
  const logLines: string[] = [];
  const sent: unknown[] = [];
  return {
    logLines,
    sent,
    consumeRateLimit: vi.fn(async () => 0),
    isSuperAdmin: vi.fn(async () => true),
    createInviteCodeFor: vi.fn(async () => 'K7M2-9QXA-F3TW'),
    sendEmail: vi.fn(async (message) => {
      sent.push(message);
      return { ok: true, id: 'mail-1' };
    }),
    log: (kind: string, detail?: unknown) => logLines.push(`${kind} ${JSON.stringify(detail ?? '')}`),
    ...overrides,
  } as unknown as InviteDeps & { logLines: string[]; sent: unknown[] };
}

const run = async (d: InviteDeps, body: unknown, userId = '00000000-0000-4000-8000-00000000000a'): Promise<ApiResult> =>
  sendInvite(userId, body, d);

describe('parseInviteBody', () => {
  it('accepts the form of the Invite people screen, with defaults for the omitted fields', () => {
    expect(parseInviteBody({ email: '  Anna@Example.COM ', maxUses: '3', validDays: 7 })).toEqual({
      email: 'anna@example.com',
      maxUses: 3,
      validDays: 7,
    });
    expect(parseInviteBody({ email: ' ben@example.com ' })).toEqual({ email: 'ben@example.com', maxUses: 1, validDays: null });
    expect(parseInviteBody({ email: 'ben@example.com', validDays: null })).toEqual({
      email: 'ben@example.com',
      maxUses: 1,
      validDays: null,
    });
  });

  it('refuses a missing or malformed e-mail (400, like the sign-up rule)', () => {
    for (const email of [undefined, null, '', '   ', 'anna', 'anna@', 'a@b', `${'a'.repeat(250)}@example.com`]) {
      const r = parseInviteBody({ email });
      expect(r, String(email)).toMatchObject({ status: 400 });
    }
  });

  it('refuses uses and days outside the database limits (1..1000 uses, 1..3650 days)', () => {
    for (const body of [{ email: 'a@b.co', maxUses: 0 }, { email: 'a@b.co', maxUses: 1001 }, { email: 'a@b.co', maxUses: 'x' }, { email: 'a@b.co', validDays: 0 }, { email: 'a@b.co', validDays: 3651 }]) {
      expect(parseInviteBody(body)).toMatchObject({ status: 400 });
    }
  });
});

describe('sendInvite', () => {
  it('creates the code for the lower-cased e-mail and sends the rendered mail to it', async () => {
    const d = deps();
    const create = d.createInviteCodeFor as Mock;
    const res = await run(d, { email: 'ANNA@example.com', maxUses: 2, validDays: 14 });
    expect(res).toEqual({ status: 201, body: { code: 'K7M2-9QXA-F3TW', sent: true } });
    expect(create).toHaveBeenCalledWith('anna@example.com', 2, 14);
    expect(d.sent).toHaveLength(1);
    const mail = d.sent[0] as { to: string; subject: string; html: string; text: string };
    expect(mail.to).toBe('anna@example.com');
    expect(mail.subject).toBe("You're invited to Ration");
    expect(mail.html).toContain('K7M2-9QXA-F3TW');
    expect(mail.text).toContain('K7M2-9QXA-F3TW');
  });

  it('throttles before the database is touched: 10 sends per admin per hour, 429 with Retry-After', async () => {
    const waited = 1234;
    const d = deps({ consumeRateLimit: vi.fn(async () => waited) });
    const create = d.createInviteCodeFor as Mock;
    const res = await run(d, { email: 'anna@example.com' });
    expect(res.status).toBe(429);
    expect((res.body as { retryAfterSeconds: number }).retryAfterSeconds).toBe(waited);
    expect((res.headers as Record<string, string>)['Retry-After']).toBe(String(waited));
    expect(create).not.toHaveBeenCalled();
    const calls = (d.consumeRateLimit as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls[0]![1]).toBe('send-invite');
    expect(calls[0]![2]).toBe(DEFAULT_INVITE_LIMITS.perAdmin);
  });

  it('a non-admin is refused (403 not_admin) after the throttle, and nothing is created or sent', async () => {
    const d = deps({ isSuperAdmin: async () => false });
    const res = await run(d, { email: 'anna@example.com' });
    expect(res).toMatchObject({ status: 403, body: { error: 'not_admin' } });
    expect(d.createInviteCodeFor as Mock).not.toHaveBeenCalled();
    expect(d.sent).toHaveLength(0);
  });

  it('a failed send still returns the code with sent=false, and logs only outcome kinds (no address)', async () => {
    const d = deps({ sendEmail: async () => ({ ok: false, reason: 'http_503' }) });
    const res = await run(d, { email: 'anna@example.com' });
    expect(res).toEqual({ status: 201, body: { code: 'K7M2-9QXA-F3TW', sent: false } });
    expect(d.logLines.join('\n')).not.toContain('anna@example.com');
  });

  it('a database failure while creating the code is a 500 and sends nothing', async () => {
    const d = deps({
      createInviteCodeFor: async () => {
        throw new Error('db down');
      },
    });
    const res = await run(d, { email: 'anna@example.com' });
    expect(res).toMatchObject({ status: 500, body: { error: 'internal_error' } });
    expect(d.sent).toHaveLength(0);
  });

  it('an invalid body is refused before the throttle is even consumed', async () => {
    const limit = vi.fn(async () => 0);
    const d = deps({ consumeRateLimit: limit });
    const res = await run(d, { email: 'nope' });
    expect(res.status).toBe(400);
    expect(limit).not.toHaveBeenCalled();
  });
});
