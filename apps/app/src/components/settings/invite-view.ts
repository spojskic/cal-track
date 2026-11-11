// Pure (no React Native / Expo imports): what the Invite people screen (app/settings/invites.tsx) shows and accepts. Kept apart so the
// rules can be unit-tested without a renderer (tools/ui-smoke/src/invite-view.test.ts). The limits mirror public.create_invite_code_for
// (supabase/migrations/20261110000100_invite_codes.sql and 20261110000108_invite_email.sql); the database is the real check.
import { isPlausibleEmail } from '../../lib/signup';
import { formatShortDate } from './format';

export type InviteStatus = 'active' | 'used_up' | 'expired' | 'revoked';

/** A row of public.admin_list_invites(). */
export interface InviteCode {
  /** Shown in groups of four: K7M2-9QXA-F3TW. */
  code: string;
  /** What the owner wrote in the free text field of the first version (and the SQL editor); new codes have none. */
  note: string | null;
  /** The e-mail address the code was made for (lower-case); null for the codes made before it existed. */
  invited_email: string | null;
  uses: number;
  max_uses: number;
  status: InviteStatus;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  last_used_at: string | null;
}

export const INVITE_LIMITS = {
  maxUses: { min: 1, max: 1000 },
  validDays: { min: 1, max: 3650 },
} as const;

/** How many codes one page of a list shows. */
export const INVITE_PAGE_SIZE = 20;

/** The expiry choices of the form; `null` is a code that never expires. */
export const EXPIRY_CHOICES: readonly { label: string; days: number | null }[] = [
  { label: '7 days', days: 7 },
  { label: '14 days', days: 14 },
  { label: '30 days', days: 30 },
  { label: 'No expiry', days: null },
];

export const DEFAULT_INVITE_FORM = { email: '', maxUses: '1', validDays: 14 as number | null };

export interface InviteForm {
  /** Text being edited. */
  email: string;
  /** Text being edited. */
  maxUses: string;
  validDays: number | null;
}

/** What `admin_create_invite_code_for` is called with. */
export interface NewInvite {
  /** Trimmed and lower-case. */
  email: string;
  maxUses: number;
  validDays: number | null;
}

export type InviteFormErrors = Partial<Record<'email' | 'maxUses', string>>;

export function parseInviteForm(form: InviteForm): { ok: true; value: NewInvite } | { ok: false; errors: InviteFormErrors } {
  const errors: InviteFormErrors = {};
  const email = form.email.trim().toLowerCase();
  if (email === '') errors.email = 'Enter the e-mail address of the person you are inviting.';
  else if (!isPlausibleEmail(email)) errors.email = 'Enter a valid e-mail address, for example anna@example.com.';
  const raw = form.maxUses.trim();
  const maxUses = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(maxUses) || maxUses < INVITE_LIMITS.maxUses.min || maxUses > INVITE_LIMITS.maxUses.max) {
    errors.maxUses = `Enter a whole number from ${INVITE_LIMITS.maxUses.min} to ${INVITE_LIMITS.maxUses.max}.`;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { email, maxUses, validDays: form.validDays } };
}

export function inviteStatusLabel(status: InviteStatus): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'used_up':
      return 'Used up';
    case 'expired':
      return 'Expired';
    case 'revoked':
      return 'Revoked';
  }
}

/** "Not used yet", "1 of 3 used", "Used 1 of 1". */
export function usesLabel(code: Pick<InviteCode, 'uses' | 'max_uses' | 'status'>): string {
  if (code.uses === 0) return 'Not used yet';
  return code.status === 'used_up' ? `Used ${code.uses} of ${code.max_uses}` : `${code.uses} of ${code.max_uses} used`;
}

const DAY_MS = 86_400_000;

/** "Expires in 13 days", "Expires today", "Never expires", "Expired 2 days ago"; a revoked code says "Revoked". */
export function expiryLabel(code: Pick<InviteCode, 'expires_at' | 'status'>, nowMs: number): string {
  if (code.status === 'revoked') return 'Revoked';
  if (code.expires_at === null) return 'Never expires';
  const ms = Date.parse(code.expires_at);
  if (!Number.isFinite(ms)) return 'Never expires';
  const diff = ms - nowMs;
  if (diff <= 0) {
    const ago = Math.floor(-diff / DAY_MS);
    return ago < 1 ? 'Expired today' : `Expired ${ago} ${ago === 1 ? 'day' : 'days'} ago`;
  }
  if (diff < DAY_MS) return 'Expires today';
  const days = Math.ceil(diff / DAY_MS);
  return `Expires in ${days} ${days === 1 ? 'day' : 'days'}`;
}

/** "Created Nov 10, 2026" (the day in UTC; the exact time is not needed). */
export function createdLabel(code: Pick<InviteCode, 'created_at'>): string {
  return `Created ${formatShortDate(code.created_at.slice(0, 10))}`;
}

/** The line under a code: usage, expiry and creation day, for example "Not used yet · Expires in 13 days · Created Nov 10, 2026". */
export function inviteDetails(code: InviteCode, nowMs: number): string {
  const parts = [usesLabel(code)];
  // A used-up code's expiry no longer matters; a revoked one says so in the status chip and here.
  if (code.status === 'active' || code.status === 'revoked' || code.status === 'expired') parts.push(expiryLabel(code, nowMs));
  parts.push(createdLabel(code));
  return parts.join(' \u00B7 ');
}

/** The title of a row: the e-mail the code was made for; for a code made before that, its note; else "No e-mail". */
export function inviteTitle(code: Pick<InviteCode, 'invited_email' | 'note'>): string {
  if (code.invited_email && code.invited_email.trim() !== '') return code.invited_email;
  return code.note && code.note.trim() !== '' ? code.note : 'No e-mail';
}

/** What gets copied to send to a friend. */
export function inviteMessage(code: string, appName = 'Ration'): string {
  return `You are invited to ${appName}. Open the app, tap Create account and enter this invite code: ${code}`;
}

/** The sentence under a failed request: the database's "only the app owner" refusal is explained, anything else is shown as it is. */
export function inviteErrorMessage(error: unknown): string {
  const e = error as { code?: unknown; message?: unknown } | null;
  if (e && e.code === '42501') return 'Only the app owner can invite people.';
  const message = typeof e?.message === 'string' && e.message !== '' ? e.message : 'Something went wrong. Try again.';
  return message;
}

export interface PageInfo {
  /** The page shown (0-based), after it was brought back into range. */
  page: number;
  pageCount: number;
  total: number;
  /** 1-based position of the first and the last code on the page; both 0 when there is none. */
  from: number;
  to: number;
  hasPrev: boolean;
  hasNext: boolean;
  /** "1\u201320 of 137" ("21 of 21" for a page of one), or "" when there is nothing to show. */
  label: string;
}

/** Where a page of a list stands: `page` is clamped to the pages that exist for `total` codes. */
export function pageInfo(total: number, page: number, pageSize: number = INVITE_PAGE_SIZE): PageInfo {
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  const size = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(safeTotal / size));
  const current = Math.min(Math.max(0, Math.floor(Number.isFinite(page) ? page : 0)), pageCount - 1);
  const from = safeTotal === 0 ? 0 : current * size + 1;
  const to = Math.min(safeTotal, (current + 1) * size);
  return {
    page: current,
    pageCount,
    total: safeTotal,
    from,
    to,
    hasPrev: current > 0,
    hasNext: current < pageCount - 1,
    label: safeTotal === 0 ? '' : from === to ? `${from} of ${safeTotal}` : `${from}\u2013${to} of ${safeTotal}`,
  };
}
