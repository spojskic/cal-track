/**
 * The admin invite RPCs of supabase/migrations/20261110000107_super_admin_invites.sql (admin_create_invite_code with a note,
 * admin_list_invite_codes, admin_revoke_invite_code) and 20261110000108_invite_email.sql (admin_create_invite_code_for with an e-mail,
 * admin_list_invites with the e-mail, which the app pages with PostgREST limit / offset / status filter / Prefer: count=exact), as the
 * smoke harness's mock backend answers them.
 *
 * The codes live in a private table in the real database (private.invite_codes); here they are rows of a pseudo table the mock backend
 * keeps next to the real ones, so a failed request rolls them back with everything else. The checks are the ones of the SQL (limits,
 * messages, status precedence). The "is the caller a super admin" check is done by the mock backend, from the profile row.
 * Pure: no sockets, no timers, no clock (the caller passes `nowMs`).
 */

export type InviteRow = Record<string, unknown>;

/** Name of the pseudo table inside the mock backend (not a public table, never reachable through REST). */
export const INVITES_TABLE = '__admin_invite_codes';

const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const DAY_MS = 86_400_000;

/** A SQL exception of the RPC: the SQLSTATE and the HTTP status PostgREST maps it to. */
export class InviteAdminError extends Error {
  constructor(
    readonly sqlstate: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The codes the demo owner has already made: one of each kind, so the screen shows every state. */
export const SEEDED_INVITES = {
  unused: 'H2KP-7TQM-4WXN',
  partlyUsed: 'R8VC-3DNZ-6BYJ',
  usedUp: 'M4GS-9XEK-2PRA',
  expired: 'T6WJ-5CFH-8QDV',
  revoked: 'N3YB-7KAP-4SGX',
} as const;

export const normalizeCode = (raw: string): string => raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
export const formatCode = (code: string): string => code.replace(/(.{4})(?=.)/g, '$1-');

const iso = (ms: number): string => new Date(ms).toISOString();

export function seedInvites(nowMs: number): InviteRow[] {
  const row = (code: string, note: string | null, o: Partial<InviteRow>): InviteRow => ({
    code: normalizeCode(code),
    note,
    invited_email: null,
    max_uses: 1,
    uses: 0,
    expires_at: null,
    revoked_at: null,
    created_at: iso(nowMs),
    last_used_at: null,
    ...o,
  });
  return [
    row(SEEDED_INVITES.unused, null, { invited_email: 'anna@example.com', created_at: iso(nowMs - DAY_MS), expires_at: iso(nowMs + 13 * DAY_MS) }),
    // made before the e-mail field existed: only a note
    row(SEEDED_INVITES.partlyUsed, 'family', { max_uses: 3, uses: 1, created_at: iso(nowMs - 5 * DAY_MS), last_used_at: iso(nowMs - 2 * DAY_MS) }),
    row(SEEDED_INVITES.usedUp, null, {
      invited_email: 'ben@example.com',
      uses: 1,
      created_at: iso(nowMs - 9 * DAY_MS),
      expires_at: iso(nowMs + 5 * DAY_MS),
      last_used_at: iso(nowMs - 8 * DAY_MS),
    }),
    row(SEEDED_INVITES.expired, null, { invited_email: 'carla@example.com', created_at: iso(nowMs - 16 * DAY_MS), expires_at: iso(nowMs - 2 * DAY_MS) }),
    row(SEEDED_INVITES.revoked, 'old test', { created_at: iso(nowMs - 20 * DAY_MS), revoked_at: iso(nowMs - 3 * DAY_MS) }),
  ];
}

const invalid = (message: string): InviteAdminError => new InviteAdminError('22023', message, 400);

/** public.create_invite_code(note, max_uses, valid_days): same limits and messages. Returns the formatted code. */
export function createInvite(
  rows: InviteRow[],
  nowMs: number,
  seq: number,
  args: { note: unknown; maxUses: unknown; validDays: unknown },
): string {
  const maxUses = args.maxUses;
  if (typeof maxUses !== 'number' || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000) {
    throw invalid('max uses must be between 1 and 1000');
  }
  const days = args.validDays;
  if (days !== null && (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 3650)) {
    throw invalid('valid days must be between 1 and 3650 (or null for no expiry)');
  }
  const trimmed = typeof args.note === 'string' ? args.note.trim() : '';
  if (trimmed.length > 200) throw invalid('note is limited to 200 characters');

  // A deterministic stand-in for the random code: different for every call, always from the real alphabet.
  const code = Array.from({ length: 12 }, (_, i) => ALPHABET[(seq * 7 + i * 11 + i * i + 3) % ALPHABET.length]).join('');
  rows.push({
    code,
    note: trimmed === '' ? null : trimmed,
    invited_email: null,
    max_uses: maxUses,
    uses: 0,
    expires_at: days === null ? null : iso(nowMs + days * DAY_MS),
    revoked_at: null,
    created_at: iso(nowMs),
    last_used_at: null,
  });
  return formatCode(code);
}

/** status as public.list_invite_codes: revoked, then expired, then used_up, else active. */
export function inviteStatus(row: InviteRow, nowMs: number): 'active' | 'used_up' | 'expired' | 'revoked' {
  if (row.revoked_at !== null) return 'revoked';
  if (typeof row.expires_at === 'string' && Date.parse(row.expires_at) <= nowMs) return 'expired';
  if ((row.uses as number) >= (row.max_uses as number)) return 'used_up';
  return 'active';
}

/** public.admin_list_invite_codes() of 107: newest first, nine columns (no e-mail). */
export function listInvites(rows: readonly InviteRow[], nowMs: number): InviteRow[] {
  return listInvitesWithEmail(rows, nowMs).map((r) => {
    const { invited_email: _email, ...old } = r;
    return old;
  });
}

/** public.admin_list_invites() of 108: newest first, with the e-mail. */
export function listInvitesWithEmail(rows: readonly InviteRow[], nowMs: number): InviteRow[] {
  return [...rows]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map((r) => ({
      code: formatCode(String(r.code)),
      note: r.note,
      invited_email: r.invited_email,
      uses: r.uses,
      max_uses: r.max_uses,
      status: inviteStatus(r, nowMs),
      expires_at: r.expires_at,
      revoked_at: r.revoked_at,
      created_at: r.created_at,
      last_used_at: r.last_used_at,
    }));
}

/** public.admin_revoke_invite_code(code): true when the code exists; revoking twice keeps the first time. */
export function revokeInvite(rows: InviteRow[], nowMs: number, rawCode: unknown): boolean {
  const code = normalizeCode(typeof rawCode === 'string' ? rawCode : '');
  const row = rows.find((r) => r.code === code);
  if (!row) return false;
  if (row.revoked_at === null) row.revoked_at = iso(nowMs);
  return true;
}

const EMAIL_RULE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** public.create_invite_code_for / admin_create_invite_code_for: a code for an e-mail address (trimmed, lower-case, checked). */
export function createInviteFor(
  rows: InviteRow[],
  nowMs: number,
  seq: number,
  args: { email: unknown; maxUses: unknown; validDays: unknown },
): string {
  const email = typeof args.email === 'string' ? args.email.trim().toLowerCase() : '';
  if (email === '') throw invalid('an e-mail address is required');
  if (email.length > 254 || !EMAIL_RULE.test(email)) throw invalid('that is not a valid e-mail address');
  const formatted = createInvite(rows, nowMs, seq, { note: null, maxUses: args.maxUses, validDays: args.validDays });
  const row = rows.find((r) => r.code === normalizeCode(formatted));
  if (row) row.invited_email = email;
  return formatted;
}

export interface InvitePageResult {
  rows: InviteRow[];
  /** Rows that matched the filters, before limit / offset (what `Prefer: count=exact` reports). */
  total: number;
  /** Query parameters the mock does not emulate (reported as harness warnings). */
  unsupported: string[];
}

/**
 * What PostgREST does with the query string of a call to a function that returns a table: `<column>=eq.<v>` / `neq.<v>` filters, `order`,
 * `limit` and `offset`. Only what the app sends is emulated (`status`, `order` on any column, `limit`, `offset`); the rest is reported.
 */
export function pageInvites(all: readonly InviteRow[], params: URLSearchParams): InvitePageResult {
  const unsupported: string[] = [];
  let rows = [...all];
  let order: { column: string; desc: boolean }[] = [];
  let limit = Number.POSITIVE_INFINITY;
  let offset = 0;
  for (const [key, value] of params.entries()) {
    if (key === 'order') {
      order = value.split(',').map((term) => {
        const [column = '', direction = 'asc'] = term.split('.');
        return { column, desc: direction === 'desc' };
      });
    } else if (key === 'limit') {
      limit = Number(value);
    } else if (key === 'offset') {
      offset = Number(value);
    } else if (key === 'status') {
      const m = /^(eq|neq)\.(.*)$/.exec(value);
      if (m) rows = rows.filter((r) => (r.status === m[2]) === (m[1] === 'eq'));
      else unsupported.push(`${key}=${value}`);
    } else {
      unsupported.push(`${key}=${value}`);
    }
  }
  if (order.length > 0) {
    rows.sort((a, b) => {
      for (const { column, desc } of order) {
        const x = String(a[column] ?? '');
        const y = String(b[column] ?? '');
        if (x !== y) return (x < y ? -1 : 1) * (desc ? -1 : 1);
      }
      return 0;
    });
  }
  const total = rows.length;
  const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const end = Number.isFinite(limit) ? start + Math.max(0, limit) : undefined;
  return { rows: rows.slice(start, end), total, unsupported };
}
