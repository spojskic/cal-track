import { describe, expect, it } from 'vitest';

// The app modules are imported at run time through the `@/` alias (see targets-view.test.ts for why).
const load = (specifier: string): Promise<any> => import(/* @vite-ignore */ specifier);

describe('parseFriendEmail', () => {
  it('trims and lower-cases a plausible address', async () => {
    const { parseFriendEmail } = await load('@/components/friends/friends-view');
    expect(parseFriendEmail('  Anna@Example.COM ')).toEqual({ ok: true, email: 'anna@example.com' });
  });

  it('asks for an address when empty and refuses anything that is not one', async () => {
    const { parseFriendEmail } = await load('@/components/friends/friends-view');
    expect(parseFriendEmail('   ')).toEqual({ ok: false, error: "Enter your friend's e-mail address." });
    for (const bad of ['Anna', 'anna@', '@example.com', 'anna@example', 'a b@example.com', `${'a'.repeat(250)}@example.com`]) {
      const r = parseFriendEmail(bad);
      expect(r.ok, bad).toBe(false);
      expect(r.error, bad).toBe('Enter a valid e-mail address, for example anna@example.com.');
    }
  });
});

describe('the words after a request', () => {
  it('"sent" never claims the person received it (an address without an account gets the same answer)', async () => {
    const { sendAnswerMessage } = await load('@/components/friends/friends-view');
    expect(sendAnswerMessage('sent', 'anna@example.com')).toBe(
      'Request sent. If anna@example.com uses Ration, they will see it the next time they open the app.',
    );
    expect(sendAnswerMessage('sent', 'anna@example.com')).toMatch(/\bIf\b/);
  });

  it('the other answers say what happened', async () => {
    const { sendAnswerMessage } = await load('@/components/friends/friends-view');
    expect(sendAnswerMessage('accepted', 'ben@example.com')).toBe('ben@example.com had already asked you, so you are friends now.');
    expect(sendAnswerMessage('already_friends', 'ben@example.com')).toBe('You are already friends with ben@example.com.');
    expect(sendAnswerMessage('already_requested', 'ben@example.com')).toBe(
      'You already sent ben@example.com a request. It is waiting for their answer.',
    );
  });

  it("the database's refusals are put in plain words", async () => {
    const { friendErrorMessage } = await load('@/components/friends/friends-view');
    expect(friendErrorMessage({ code: '54000', message: 'too many friend requests today, try again tomorrow' })).toBe(
      'You have sent a lot of requests today. Try again tomorrow.',
    );
    expect(friendErrorMessage({ code: '22023', message: 'that is your own e-mail address' })).toBe('That is your own e-mail address.');
    expect(friendErrorMessage({ code: '22023', message: 'that is not a valid e-mail address' })).toBe(
      'Enter a valid e-mail address, for example anna@example.com.',
    );
    expect(friendErrorMessage({ code: '42501', message: 'not signed in' })).toBe('You are signed out. Please sign in again.');
    expect(friendErrorMessage({ message: 'Failed to fetch' })).toBe('Failed to fetch');
    expect(friendErrorMessage(null)).toBe('Something went wrong. Try again.');
  });
});

describe('people', () => {
  const anna = { displayName: 'Anna', email: 'anna@example.com' };

  it('shows the name with the e-mail under it, or only the e-mail when that is the name', async () => {
    const { personTitle, personSubtitle } = await load('@/components/friends/friends-view');
    expect(personTitle(anna)).toBe('Anna');
    expect(personSubtitle(anna)).toBe('anna@example.com');
    expect(personTitle({ displayName: '  ', email: 'x@example.com' })).toBe('x@example.com');
    expect(personSubtitle({ displayName: '', email: 'x@example.com' })).toBeNull();
    expect(personSubtitle({ displayName: 'x@example.com', email: 'x@example.com' })).toBeNull();
  });

  it('dates', async () => {
    const { friendsSince, requestDate } = await load('@/components/friends/friends-view');
    expect(friendsSince({ respondedAt: '2026-11-10T09:30:00+00:00', createdAt: '2026-11-01T09:30:00+00:00' })).toMatch(/^Friends since [A-Z][a-z]{2} 10, 2026$/);
    expect(friendsSince({ respondedAt: null, createdAt: '2026-11-01T09:30:00+00:00' })).toMatch(/^Friends since [A-Z][a-z]{2} 1, 2026$/);
    expect(friendsSince({ respondedAt: null, createdAt: '' })).toBe('Friends');
    expect(requestDate({ createdAt: '2026-11-09T12:00:00Z', direction: 'incoming' })).toMatch(/^Received [A-Z][a-z]{2} 9, 2026$/);
    expect(requestDate({ createdAt: '2026-11-09T12:00:00Z', direction: 'outgoing' })).toMatch(/^Sent [A-Z][a-z]{2} 9, 2026$/);
  });
});

describe('the count that is the notification', () => {
  it('the pill on the Friends row says how many requests wait; nothing when none', async () => {
    const { friendRequestsBadge } = await load('@/components/friends/friends-view');
    expect(friendRequestsBadge(0)).toBeUndefined();
    expect(friendRequestsBadge(-1)).toBeUndefined();
    expect(friendRequestsBadge(Number.NaN)).toBeUndefined();
    expect(friendRequestsBadge(1)).toBe('1 request');
    expect(friendRequestsBadge(2)).toBe('2 requests');
  });

  it('the number on the More tab is capped at 9+', async () => {
    const { tabBadgeText } = await load('@/components/friends/friends-view');
    expect(tabBadgeText(0)).toBeUndefined();
    expect(tabBadgeText(1)).toBe('1');
    expect(tabBadgeText(9)).toBe('9');
    expect(tabBadgeText(10)).toBe('9+');
  });

  it('More and the sidebar show it on the Friends row (in the Profile group), and only when there are requests', async () => {
    const { buildMoreSections } = await load('@/components/settings/more-sections');
    const { buildSidebarGroups } = await load('@/components/desktop/sidebar-model');
    const row = (sections: any[]) => sections.find((s) => s.id === 'profile').rows.find((r: any) => r.id === 'friends');
    expect(row(buildMoreSections({ aiEnabled: false }))).toMatchObject({ label: 'Friends', href: '/friends' });
    expect(row(buildMoreSections({ aiEnabled: false })).badge).toBeUndefined();
    expect(row(buildMoreSections({ aiEnabled: false, friendRequests: 2 })).badge).toBe('2 requests');
    const groups = buildSidebarGroups({ aiEnabled: false, friendRequests: 1 });
    expect(groups.map((g: any) => g.id)).toEqual(['daily', 'training', 'coach', 'profile', 'connections', 'app']);
    expect(groups.find((g: any) => g.id === 'profile').rows.find((r: any) => r.id === 'friends')).toMatchObject({ label: 'Friends', href: '/friends', badge: '1 request' });
  });
});

describe('who shared', () => {
  it('"from Anna" on a row, "Shared by Anna..." on the page, nothing for your own or database foods', async () => {
    const { sharedByLabel, sharedByDetail } = await load('@/components/friends/friends-view');
    expect(sharedByLabel('Anna')).toBe('from Anna');
    expect(sharedByLabel(' Anna ')).toBe('from Anna');
    expect(sharedByLabel(null)).toBeNull();
    expect(sharedByLabel('  ')).toBeNull();
    expect(sharedByLabel('a former friend')).toBe('from a former friend');
    expect(sharedByDetail('Anna')).toBe('Shared by Anna. You can use it, but only Anna can change it.');
    expect(sharedByDetail('a former friend')).toBe('Shared by a former friend. You can use it, but only they can change it.');
    expect(sharedByDetail(null)).toBeNull();
  });

  it('removing a friend says what stays', async () => {
    const { removeFriendMessage } = await load('@/components/friends/friends-view');
    expect(removeFriendMessage('Anna')).toContain('Anna will no longer see your custom foods and recipes');
    expect(removeFriendMessage('Anna')).toContain('Foods you already logged or saved stay');
  });
});

describe('splitFriendships', () => {
  const f = (over: Record<string, unknown>): any => ({
    id: 'x',
    status: 'accepted',
    direction: 'outgoing',
    userId: 'u',
    displayName: '',
    email: 'u@example.com',
    createdAt: '2026-11-01T00:00:00Z',
    respondedAt: null,
    ...over,
  });

  it('splits friends from incoming and outgoing requests and names the friends by display name, else e-mail', async () => {
    const { splitFriendships } = await load('@/components/friends/friends-view');
    const split = splitFriendships([
      f({ id: '1', userId: 'a', displayName: 'Anna', email: 'anna@example.com' }),
      f({ id: '2', userId: 'b', status: 'pending', direction: 'incoming' }),
      f({ id: '3', userId: 'd', status: 'pending', direction: 'outgoing' }),
      f({ id: '4', userId: 'c', direction: 'incoming', displayName: '', email: 'c@example.com' }),
    ]);
    expect(split.friends.map((x: any) => x.id)).toEqual(['1', '4']);
    expect(split.incoming.map((x: any) => x.id)).toEqual(['2']);
    expect(split.outgoing.map((x: any) => x.id)).toEqual(['3']);
    expect(split.friendIds).toEqual(['a', 'c']);
    expect([...split.names.entries()]).toEqual([
      ['a', 'Anna'],
      ['c', 'c@example.com'],
    ]);
    expect(splitFriendships([]).friendIds).toEqual([]);
  });
});
