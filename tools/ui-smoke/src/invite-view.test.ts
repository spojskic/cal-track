import { describe, expect, it } from 'vitest';

// The app modules are imported at run time through the `@/` alias (see targets-view.test.ts for why).
const load = (specifier: string): Promise<any> => import(/* @vite-ignore */ specifier);

const NOW = Date.parse('2026-11-10T12:00:00Z');
const DAY = 86_400_000;

const code = (over: Record<string, unknown> = {}): any => ({
  code: 'H2KP-7TQM-4WXN',
  note: null,
  invited_email: 'anna@example.com',
  uses: 0,
  max_uses: 1,
  status: 'active',
  expires_at: new Date(NOW + 13 * DAY).toISOString(),
  revoked_at: null,
  created_at: '2026-11-09T12:00:00.000Z',
  last_used_at: null,
  ...over,
});

describe('parseInviteForm', () => {
  it('trims and lower-cases the e-mail, reads the number of uses and keeps the expiry choice', async () => {
    const { parseInviteForm } = await load('@/components/settings/invite-view');
    expect(parseInviteForm({ email: '  Dora@Example.COM ', maxUses: ' 2 ', validDays: 30 })).toEqual({
      ok: true,
      value: { email: 'dora@example.com', maxUses: 2, validDays: 30 },
    });
    expect(parseInviteForm({ email: 'a@b.co', maxUses: '1', validDays: null })).toEqual({
      ok: true,
      value: { email: 'a@b.co', maxUses: 1, validDays: null },
    });
  });

  it('needs an e-mail, and refuses a name, a note or anything that is not an e-mail address', async () => {
    const { parseInviteForm } = await load('@/components/settings/invite-view');
    const empty = parseInviteForm({ email: '   ', maxUses: '1', validDays: 14 });
    expect(empty.ok).toBe(false);
    expect(empty.errors.email).toBe('Enter the e-mail address of the person you are inviting.');
    for (const email of ['Anna', 'for Anna', 'anna@', '@example.com', 'anna@example', 'a b@example.com', 'a@@example.com', `${'a'.repeat(250)}@example.com`]) {
      const r = parseInviteForm({ email, maxUses: '1', validDays: 14 });
      expect(r.ok, email).toBe(false);
      expect(r.errors.email, email).toBe('Enter a valid e-mail address, for example anna@example.com.');
    }
  });

  it('refuses anything but a whole number of uses from 1 to 1000, and reports both problems at once', async () => {
    const { parseInviteForm } = await load('@/components/settings/invite-view');
    for (const maxUses of ['', '0', '-1', '1.5', '1e2', 'two', '1001', '\uFF11']) {
      const r = parseInviteForm({ email: 'a@example.com', maxUses, validDays: 14 });
      expect(r.ok, maxUses).toBe(false);
      expect(r.errors.maxUses, maxUses).toBe('Enter a whole number from 1 to 1000.');
    }
    expect(parseInviteForm({ email: 'a@example.com', maxUses: '1000', validDays: 14 }).ok).toBe(true);
    const both = parseInviteForm({ email: '', maxUses: '0', validDays: 14 });
    expect(Object.keys(both.errors).sort()).toEqual(['email', 'maxUses']);
  });

  it('the expiry choices are 7, 14, 30 days and no expiry, and the form starts empty with one use for 14 days', async () => {
    const { EXPIRY_CHOICES, DEFAULT_INVITE_FORM } = await load('@/components/settings/invite-view');
    expect(EXPIRY_CHOICES.map((c: any) => c.days)).toEqual([7, 14, 30, null]);
    expect(DEFAULT_INVITE_FORM).toEqual({ email: '', maxUses: '1', validDays: 14 });
  });
});

describe('labels', () => {
  it('uses', async () => {
    const { usesLabel } = await load('@/components/settings/invite-view');
    expect(usesLabel(code())).toBe('Not used yet');
    expect(usesLabel(code({ uses: 1, max_uses: 3 }))).toBe('1 of 3 used');
    expect(usesLabel(code({ uses: 1, max_uses: 1, status: 'used_up' }))).toBe('Used 1 of 1');
    expect(usesLabel(code({ uses: 0, status: 'expired' }))).toBe('Not used yet');
  });

  it('expiry', async () => {
    const { expiryLabel } = await load('@/components/settings/invite-view');
    expect(expiryLabel(code(), NOW)).toBe('Expires in 13 days');
    expect(expiryLabel(code({ expires_at: new Date(NOW + DAY).toISOString() }), NOW)).toBe('Expires in 1 day');
    expect(expiryLabel(code({ expires_at: new Date(NOW + 3 * 3_600_000).toISOString() }), NOW)).toBe('Expires today');
    expect(expiryLabel(code({ expires_at: null }), NOW)).toBe('Never expires');
    expect(expiryLabel(code({ status: 'expired', expires_at: new Date(NOW - 2 * DAY - 1000).toISOString() }), NOW)).toBe('Expired 2 days ago');
    expect(expiryLabel(code({ status: 'expired', expires_at: new Date(NOW - DAY - 1000).toISOString() }), NOW)).toBe('Expired 1 day ago');
    expect(expiryLabel(code({ status: 'expired', expires_at: new Date(NOW - 1000).toISOString() }), NOW)).toBe('Expired today');
    expect(expiryLabel(code({ status: 'revoked' }), NOW)).toBe('Revoked');
    expect(expiryLabel(code({ expires_at: 'not a date' }), NOW)).toBe('Never expires');
  });

  it('the details line joins usage, expiry and the day it was made', async () => {
    const { inviteDetails } = await load('@/components/settings/invite-view');
    const line = inviteDetails(code(), NOW);
    expect(line).toMatch(/^Not used yet \u00B7 Expires in 13 days \u00B7 Created [A-Z][a-z]{2} 9, 2026$/);
    // a used-up code does not repeat its expiry
    expect(inviteDetails(code({ status: 'used_up', uses: 1 }), NOW)).toMatch(/^Used 1 of 1 \u00B7 Created /);
  });

  it('status names, the title of a row and the message that is copied', async () => {
    const { inviteStatusLabel, inviteTitle, inviteMessage } = await load('@/components/settings/invite-view');
    expect(['active', 'used_up', 'expired', 'revoked'].map(inviteStatusLabel)).toEqual(['Active', 'Used up', 'Expired', 'Revoked']);
    expect(inviteTitle(code())).toBe('anna@example.com');
    // a code made before the e-mail field only has a note
    expect(inviteTitle(code({ invited_email: null, note: 'family' }))).toBe('family');
    expect(inviteTitle(code({ invited_email: 'x@example.com', note: 'family' }))).toBe('x@example.com');
    expect(inviteTitle(code({ invited_email: null, note: null }))).toBe('No e-mail');
    expect(inviteTitle(code({ invited_email: '  ', note: '  ' }))).toBe('No e-mail');
    expect(inviteMessage('H2KP-7TQM-4WXN')).toBe('You are invited to Ration. Open the app, tap Create account and enter this invite code: H2KP-7TQM-4WXN');
  });

  it('errors: the owner-only refusal is explained, anything else is shown, nothing at all gets a generic sentence', async () => {
    const { inviteErrorMessage } = await load('@/components/settings/invite-view');
    expect(inviteErrorMessage({ code: '42501', message: 'only the app owner can create invite codes' })).toBe('Only the app owner can invite people.');
    expect(inviteErrorMessage({ code: '22023', message: 'max uses must be between 1 and 1000' })).toBe('max uses must be between 1 and 1000');
    expect(inviteErrorMessage(null)).toBe('Something went wrong. Try again.');
    expect(inviteErrorMessage({})).toBe('Something went wrong. Try again.');
  });
});

describe('pageInfo', () => {
  it('cuts 137 codes into 7 pages of 20 and says which ones the page shows', async () => {
    const { pageInfo, INVITE_PAGE_SIZE } = await load('@/components/settings/invite-view');
    expect(INVITE_PAGE_SIZE).toBe(20);
    expect(pageInfo(137, 0)).toEqual({ page: 0, pageCount: 7, total: 137, from: 1, to: 20, hasPrev: false, hasNext: true, label: '1\u201320 of 137' });
    expect(pageInfo(137, 3)).toMatchObject({ page: 3, from: 61, to: 80, hasPrev: true, hasNext: true, label: '61\u201380 of 137' });
    expect(pageInfo(137, 6)).toMatchObject({ page: 6, from: 121, to: 137, hasPrev: true, hasNext: false, label: '121\u2013137 of 137' });
  });

  it('50,000 codes are 2,500 pages, and the last page is full', async () => {
    const { pageInfo } = await load('@/components/settings/invite-view');
    expect(pageInfo(50_000, 2499)).toMatchObject({ page: 2499, pageCount: 2500, from: 49_981, to: 50_000, hasNext: false, label: '49981\u201350000 of 50000' });
  });

  it('exactly one page, an exact multiple and nothing', async () => {
    const { pageInfo } = await load('@/components/settings/invite-view');
    expect(pageInfo(20, 0)).toMatchObject({ pageCount: 1, hasPrev: false, hasNext: false, from: 1, to: 20 });
    expect(pageInfo(21, 0)).toMatchObject({ pageCount: 2, hasNext: true });
    expect(pageInfo(40, 1)).toMatchObject({ pageCount: 2, from: 21, to: 40, hasNext: false });
    expect(pageInfo(0, 0)).toEqual({ page: 0, pageCount: 1, total: 0, from: 0, to: 0, hasPrev: false, hasNext: false, label: '' });
  });

  it('brings a page that does not exist (any more) back to the last one, and survives bad numbers', async () => {
    const { pageInfo } = await load('@/components/settings/invite-view');
    expect(pageInfo(41, 9)).toMatchObject({ page: 2, from: 41, to: 41, label: '41 of 41' });
    expect(pageInfo(0, 3).page).toBe(0);
    expect(pageInfo(41, -4).page).toBe(0);
    expect(pageInfo(Number.NaN, Number.NaN)).toMatchObject({ page: 0, total: 0, label: '' });
    expect(pageInfo(10, 0, 3)).toMatchObject({ pageCount: 4, to: 3, label: '1\u20133 of 10' });
  });
});

describe('the Admin section of More and the sidebar', () => {
  it('only the super admin gets it, after App and before Account, with one row', async () => {
    const { buildMoreSections } = await load('@/components/settings/more-sections');
    expect(buildMoreSections({ aiEnabled: false }).map((s: any) => s.id)).toEqual(['training', 'coach', 'profile', 'connections', 'app', 'account']);
    expect(buildMoreSections({ aiEnabled: false, isAdmin: false }).some((s: any) => s.id === 'admin')).toBe(false);
    const sections = buildMoreSections({ aiEnabled: true, isAdmin: true });
    expect(sections.map((s: any) => s.id)).toEqual(['training', 'coach', 'profile', 'connections', 'app', 'admin', 'account']);
    const admin = sections.find((s: any) => s.id === 'admin');
    expect(admin.label).toBe('Admin');
    expect(admin.rows).toHaveLength(1);
    expect(admin.rows[0]).toMatchObject({ id: 'invites', label: 'Invite people', href: '/settings/invites' });
  });

  it('the sidebar lists the same row in an Admin group for the super admin only, and highlights it on its page', async () => {
    const { buildSidebarGroups, resolveActiveRowId } = await load('@/components/desktop/sidebar-model');
    expect(buildSidebarGroups({ aiEnabled: false }).some((g: any) => g.id === 'admin')).toBe(false);
    const groups = buildSidebarGroups({ aiEnabled: false, isAdmin: true });
    expect(groups.map((g: any) => g.id)).toEqual(['daily', 'training', 'coach', 'profile', 'connections', 'app', 'admin']);
    expect(groups.find((g: any) => g.id === 'admin').rows.map((r: any) => [r.label, r.href])).toEqual([['Invite people', '/settings/invites']]);
    expect(resolveActiveRowId(groups, '/settings/invites')).toBe('invites');
    // an ordinary user's sidebar has no row for the page, so nothing is highlighted
    expect(resolveActiveRowId(buildSidebarGroups({ aiEnabled: false }), '/settings/invites')).toBeNull();
  });
});
