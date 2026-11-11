import { describe, expect, it } from 'vitest';

import { ANON_KEY, APP_ORIGIN, BACKEND_ORIGIN, FIXED_NOW_MS } from './constants';
import { USER, buildFixtures, type FixtureVariant } from './fixtures';
import { SEEDED_INVITES, formatCode, inviteStatus, normalizeCode, pageInvites, seedInvites } from './invite-admin';
import { createMockBackend } from './mock-backend';
import { SEED_SESSION_TTL_SECONDS, buildSession } from './session';

const TOKEN = buildSession(USER, { nowMs: FIXED_NOW_MS, ttlSeconds: SEED_SESSION_TTL_SECONDS }).access_token;

function setup(variant: FixtureVariant = 'admin') {
  const backend = createMockBackend(buildFixtures(variant).seed);
  const call = (method: string, path: string, body?: unknown, token: string | null = TOKEN, headers: Record<string, string> = {}) => {
    const res = backend.handle({
      method,
      url: `${BACKEND_ORIGIN}${path}`,
      headers: {
        apikey: ANON_KEY,
        authorization: `Bearer ${token ?? ANON_KEY}`,
        origin: APP_ORIGIN,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, json: res.body ? JSON.parse(res.body) : null };
  };
  const rpc = (name: string, body: unknown = {}, query = '', headers: Record<string, string> = {}) =>
    call('POST', `/rest/v1/rpc/${name}${query}`, body, TOKEN, headers);
  return { backend, call, rpc };
}

const COUNT = { prefer: 'count=exact' };

describe('mock backend: the admin invite RPCs of migration 107 (note based, kept for older app builds)', () => {
  it('lists the seeded codes newest first with every status, nine columns, no e-mail', () => {
    const { rpc } = setup();
    const r = rpc('admin_list_invite_codes');
    expect(r.status).toBe(200);
    expect(r.json.map((c: any) => [c.code, c.status, `${c.uses}/${c.max_uses}`])).toEqual([
      [SEEDED_INVITES.unused, 'active', '0/1'],
      [SEEDED_INVITES.partlyUsed, 'active', '1/3'],
      [SEEDED_INVITES.usedUp, 'used_up', '1/1'],
      [SEEDED_INVITES.expired, 'expired', '0/1'],
      [SEEDED_INVITES.revoked, 'revoked', '0/1'],
    ]);
    expect(Object.keys(r.json[0])).toEqual(['code', 'note', 'uses', 'max_uses', 'status', 'expires_at', 'revoked_at', 'created_at', 'last_used_at']);
  });

  it('creates a code with a note, with the limits of the SQL function (400, 22023)', () => {
    const { rpc } = setup();
    const made = rpc('admin_create_invite_code', { p_note: '  for Dora ', p_max_uses: 2, p_valid_days: 30 });
    expect(made.status).toBe(200);
    expect(rpc('admin_list_invite_codes').json[0]).toMatchObject({ code: made.json, note: 'for Dora', max_uses: 2 });
    for (const body of [
      { p_max_uses: 0, p_valid_days: 14 },
      { p_max_uses: 1, p_valid_days: 3651 },
      { p_note: 'n'.repeat(201), p_max_uses: 1, p_valid_days: 14 },
    ]) {
      const r = rpc('admin_create_invite_code', body);
      expect(r.status).toBe(400);
      expect(r.json.code).toBe('22023');
    }
  });

  it('revokes a code (any spelling), false for an unknown one, and keeps the first revoke time', () => {
    const { rpc } = setup();
    expect(rpc('admin_revoke_invite_code', { p_code: SEEDED_INVITES.unused.toLowerCase().replaceAll('-', ' ') }).json).toBe(true);
    const revoked = rpc('admin_list_invite_codes').json.find((c: any) => c.code === SEEDED_INVITES.unused);
    expect(revoked.status).toBe('revoked');
    expect(rpc('admin_revoke_invite_code', { p_code: SEEDED_INVITES.unused }).json).toBe(true);
    expect(rpc('admin_list_invite_codes').json.find((c: any) => c.code === SEEDED_INVITES.unused).revoked_at).toBe(revoked.revoked_at);
    expect(rpc('admin_revoke_invite_code', { p_code: 'ZZZZ-ZZZZ-ZZZZ' }).json).toBe(false);
  });
});

describe('mock backend: codes for an e-mail (migration 108)', () => {
  it('refuses everything with 42501 when the profile is not a super admin, and records no mutation', () => {
    const { rpc, backend } = setup('default');
    for (const [name, body] of [
      ['admin_list_invites', {}],
      ['admin_create_invite_code_for', { p_email: 'a@example.com', p_max_uses: 1, p_valid_days: 14 }],
      ['admin_revoke_invite_code', { p_code: SEEDED_INVITES.unused }],
      ['admin_list_invite_codes', {}],
      ['admin_create_invite_code', { p_note: 'x', p_max_uses: 1, p_valid_days: 14 }],
    ] as const) {
      const r = rpc(name, body);
      expect(r.status, name).toBe(403);
      expect(r.json.code, name).toBe('42501');
      expect(r.json.message, name).toMatch(/only the app owner/);
    }
    expect(backend.mutations.filter((m) => m.table.startsWith('rpc:admin_') && m.ok)).toEqual([]);
  });

  it('refuses an anonymous caller', () => {
    const { call } = setup();
    expect(call('POST', '/rest/v1/rpc/admin_list_invites', {}, null).status).toBe(401);
  });

  it('lists the seeded codes with the e-mail they were made for (older codes only have a note)', () => {
    const { rpc } = setup();
    const r = rpc('admin_list_invites');
    expect(r.status).toBe(200);
    expect(r.json.map((c: any) => [c.code, c.invited_email, c.note])).toEqual([
      [SEEDED_INVITES.unused, 'anna@example.com', null],
      [SEEDED_INVITES.partlyUsed, null, 'family'],
      [SEEDED_INVITES.usedUp, 'ben@example.com', null],
      [SEEDED_INVITES.expired, 'carla@example.com', null],
      [SEEDED_INVITES.revoked, null, 'old test'],
    ]);
    expect(Object.keys(r.json[0])).toEqual(['code', 'note', 'invited_email', 'uses', 'max_uses', 'status', 'expires_at', 'revoked_at', 'created_at', 'last_used_at']);
  });

  it('creates a code for an e-mail (trimmed, lower-case) and it is the first in the list; the mutation is recorded', () => {
    const { rpc, backend } = setup();
    const made = rpc('admin_create_invite_code_for', { p_email: '  Dora@Example.COM ', p_max_uses: 2, p_valid_days: 30 });
    expect(made.status).toBe(200);
    expect(made.json).toMatch(/^[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/);
    const first = rpc('admin_list_invites').json[0];
    expect(first).toMatchObject({ code: made.json, invited_email: 'dora@example.com', note: null, uses: 0, max_uses: 2, status: 'active' });
    expect(Date.parse(first.expires_at) - Date.parse(first.created_at)).toBe(30 * 86_400_000);
    expect(backend.mutationsOf('rpc:admin_create_invite_code_for')[0]).toMatchObject({
      op: 'rpc',
      ok: true,
      payload: { p_email: '  Dora@Example.COM ', p_max_uses: 2, p_valid_days: 30 },
    });
  });

  it('needs an e-mail and refuses a malformed one or a bad number (400, 22023), leaving nothing behind; p_email is required by name', () => {
    const { rpc } = setup();
    const before = rpc('admin_list_invites').json.length;
    for (const body of [
      { p_email: '', p_max_uses: 1, p_valid_days: 14 },
      { p_email: null, p_max_uses: 1, p_valid_days: 14 },
      { p_email: 'not an e-mail', p_max_uses: 1, p_valid_days: 14 },
      { p_email: 'a@b', p_max_uses: 1, p_valid_days: 14 },
      { p_email: `${'a'.repeat(250)}@example.com`, p_max_uses: 1, p_valid_days: 14 },
      { p_email: 'a@example.com', p_max_uses: 0, p_valid_days: 14 },
      { p_email: 'a@example.com', p_max_uses: 1, p_valid_days: 0 },
    ]) {
      const r = rpc('admin_create_invite_code_for', body);
      expect(r.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(r.json.code).toBe('22023');
    }
    expect(rpc('admin_list_invites').json).toHaveLength(before);
    expect(rpc('admin_create_invite_code_for', { p_max_uses: 1 }).status).toBe(404); // p_email is required
  });

  it('two codes made in a row differ; null days means no expiry; the defaults are 1 use and 14 days', () => {
    const { rpc } = setup();
    const a = rpc('admin_create_invite_code_for', { p_email: 'a@example.com', p_max_uses: 1, p_valid_days: null }).json;
    const b = rpc('admin_create_invite_code_for', { p_email: 'b@example.com' }).json;
    expect(a).not.toBe(b);
    const rows = rpc('admin_list_invites').json;
    expect(rows.find((r: any) => r.code === a).expires_at).toBeNull();
    expect(rows.find((r: any) => r.code === b)).toMatchObject({ max_uses: 1 });
    expect(rows.find((r: any) => r.code === b).expires_at).not.toBeNull();
  });

  it('the owner and service-only RPCs stay out of reach (403)', () => {
    const { rpc } = setup();
    for (const name of ['create_invite_code', 'list_invite_codes', 'create_invite_code_for']) expect(rpc(name, { p_note: 'x' }).status, name).toBe(403);
  });

  it('the private table is not reachable through REST', () => {
    const { call } = setup();
    expect(call('GET', '/rest/v1/__admin_invite_codes').status).toBe(404);
    expect(call('GET', '/rest/v1/invite_codes').status).toBe(404);
  });
});

describe('mock backend: paging the list the way PostgREST does', () => {
  const makeMany = (rpc: ReturnType<typeof setup>['rpc'], n: number) => {
    for (let i = 0; i < n; i++) rpc('admin_create_invite_code_for', { p_email: `p${String(i).padStart(2, '0')}@example.com`, p_max_uses: 1, p_valid_days: 14 });
  };
  const PAGE = '?status=eq.active&order=created_at.desc,code.asc&limit=20';

  it('filters on the status, cuts the page and reports the total in Content-Range when it is asked for', () => {
    const { rpc } = setup();
    makeMany(rpc, 25); // 25 new + 2 active seeded = 27 active, 3 closed
    const first = rpc('admin_list_invites', {}, `${PAGE}&offset=0`, COUNT);
    expect(first.status).toBe(200);
    expect(first.json).toHaveLength(20);
    expect(first.json.every((c: any) => c.status === 'active')).toBe(true);
    expect(first.headers['content-range']).toBe('0-19/27');
    const second = rpc('admin_list_invites', {}, `${PAGE}&offset=20`, COUNT);
    expect(second.json).toHaveLength(7);
    expect(second.headers['content-range']).toBe('20-26/27');
    // no overlap between the pages
    const codes = new Set([...first.json, ...second.json].map((c: any) => c.code));
    expect(codes.size).toBe(27);
    const closed = rpc('admin_list_invites', {}, '?status=neq.active&order=created_at.desc,code.asc&limit=20&offset=0', COUNT);
    expect(closed.json.map((c: any) => c.status).sort()).toEqual(['expired', 'revoked', 'used_up']);
    expect(closed.headers['content-range']).toBe('0-2/3');
  });

  it('an empty page says */total, and the count header is only sent when asked for', () => {
    const { rpc } = setup();
    const beyond = rpc('admin_list_invites', {}, `${PAGE}&offset=100`, COUNT);
    expect(beyond.json).toEqual([]);
    expect(beyond.headers['content-range']).toBe('*/2');
    expect(rpc('admin_list_invites', {}, `${PAGE}&offset=0`).headers['content-range']).toBeUndefined();
  });

  it('newest first, ties broken by the code, and a new code lands on the first page', () => {
    const { rpc } = setup();
    makeMany(rpc, 3);
    const rows = rpc('admin_list_invites', {}, `${PAGE}&offset=0`, COUNT).json;
    expect(rows.slice(0, 3).map((c: any) => c.invited_email).sort()).toEqual(['p00@example.com', 'p01@example.com', 'p02@example.com']);
    const created = rows.slice(0, 3).map((c: any) => c.created_at);
    expect(new Set(created).size).toBeLessThanOrEqual(3);
    const sorted = [...rows].sort((a: any, b: any) => (a.created_at === b.created_at ? (a.code < b.code ? -1 : 1) : a.created_at < b.created_at ? 1 : -1));
    expect(rows.map((c: any) => c.code)).toEqual(sorted.map((c: any) => c.code));
  });

  it('reports a query parameter it does not emulate as a harness warning instead of ignoring it silently', () => {
    const { rpc, backend } = setup();
    rpc('admin_list_invites', {}, '?invited_email=ilike.*anna*&limit=5');
    expect(backend.warnings.some((w) => w.includes('invited_email=ilike.*anna*'))).toBe(true);
  });

  it('pageInvites on its own: limit 0 gives an empty page, offset past the end too, the total stays', () => {
    const rows = seedInvites(FIXED_NOW_MS).map((r, i) => ({ ...r, status: i < 2 ? 'active' : 'used_up' }));
    expect(pageInvites(rows, new URLSearchParams('limit=0')).rows).toEqual([]);
    expect(pageInvites(rows, new URLSearchParams('limit=0')).total).toBe(5);
    expect(pageInvites(rows, new URLSearchParams('offset=9&limit=5')).rows).toEqual([]);
    expect(pageInvites(rows, new URLSearchParams('status=eq.active')).total).toBe(2);
    expect(pageInvites(rows, new URLSearchParams('status=neq.active')).total).toBe(3);
  });
});

describe('mock backend: profiles.is_admin', () => {
  it('is false for every profile except the owner variant, and the REST read returns it', () => {
    expect(setup('default').call('GET', '/rest/v1/profiles?select=is_admin').json).toEqual([{ is_admin: false }]);
    expect(setup('admin').call('GET', '/rest/v1/profiles?select=is_admin').json).toEqual([{ is_admin: true }]);
  });

  it('a client cannot make itself super admin (update), nor switch it off, but may edit the rest of the profile', () => {
    const { call, backend } = setup('default');
    const up = call('PATCH', `/rest/v1/profiles?user_id=eq.${USER.id}`, { is_admin: true });
    expect(up.status).toBe(403);
    expect(up.json.code).toBe('42501');
    expect(call('GET', '/rest/v1/profiles?select=is_admin').json).toEqual([{ is_admin: false }]);
    expect(backend.mutationsOf('profiles', 'update').filter((m) => m.ok)).toEqual([]);

    const owner = setup('admin');
    expect(owner.call('PATCH', `/rest/v1/profiles?user_id=eq.${USER.id}`, { is_admin: false }).status).toBe(403);
    expect(owner.call('PATCH', `/rest/v1/profiles?user_id=eq.${USER.id}`, { display_name: 'Owner', is_admin: true }).status).toBe(204);
    expect(owner.call('GET', '/rest/v1/profiles?select=display_name,is_admin').json).toEqual([{ display_name: 'Owner', is_admin: true }]);
  });

  it('...nor with an upsert that carries is_admin: true', () => {
    const { call } = setup('default');
    const up = call('POST', '/rest/v1/profiles?on_conflict=user_id', { user_id: USER.id, is_admin: true });
    expect(up.status).toBe(403);
    expect(call('GET', '/rest/v1/profiles?select=is_admin').json).toEqual([{ is_admin: false }]);
  });
});

describe('invite-admin helpers', () => {
  it('normalises and groups like the SQL helpers', () => {
    expect(normalizeCode('k7m2 9qxa-f3tw')).toBe('K7M29QXAF3TW');
    expect(formatCode('K7M29QXAF3TW')).toBe('K7M2-9QXA-F3TW');
  });

  it('status precedence: revoked, then expired, then used up, else active', () => {
    const now = FIXED_NOW_MS;
    const rows = seedInvites(now);
    expect(rows.map((r) => inviteStatus(r, now))).toEqual(['active', 'active', 'used_up', 'expired', 'revoked']);
    const both = { ...rows[2]!, revoked_at: new Date(now).toISOString() };
    expect(inviteStatus(both, now)).toBe('revoked');
    const expiredAndUsed = { ...rows[2]!, expires_at: new Date(now - 1000).toISOString() };
    expect(inviteStatus(expiredAndUsed, now)).toBe('expired');
  });
});
