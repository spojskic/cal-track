// Sign-in helpers: the sign-in page URL and the single-use SSO service ticket that Garmin's own page hands back.
// Same rules as the reference (garmin-companion: crates/garmin-api/src/session.rs, apps/mobile/src/data/ticket.ts).

import { SSO_CLIENT_ID, SSO_SERVICE_URL, SSO_SIGN_IN_URL } from './constants';

/** Garmin's own sign-in page, to be shown in a web view. The service must be the one used for the ticket exchange. */
export function signInUrl(): string {
  return `${SSO_SIGN_IN_URL}?clientId=${encodeURIComponent(SSO_CLIENT_ID)}&service=${encodeURIComponent(SSO_SERVICE_URL)}`;
}

export const SIGN_IN_URL: string = signInUrl();

// scheme://[userinfo@]host[:port]/?#  Only https. The userinfo part is skipped, so "https://garmin.com@evil.test/" has the
// host evil.test.
const HTTPS_HOST = /^https:\/\/(?:[^/?#@]*@)?([^/?#:]+)(?::\d*)?(?:[/?#]|$)/i;

/** True for garmin.com and its subdomains over https ("notgarmin.com" and "garmin.com.evil.test" do not count). */
export function isGarminHttpsUrl(link: string): boolean {
  const host = HTTPS_HOST.exec(link)?.[1]?.toLowerCase();
  return host !== undefined && (host === 'garmin.com' || host.endsWith('.garmin.com'));
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

/**
 * The CAS ticket in a redirect to Garmin, if `link` is one. Only an https garmin.com host counts: a wrong guess would
 * spend the one attempt, and a ticket must never be taken from some other site.
 */
export function ticketIn(link: string): string | null {
  if (typeof link !== 'string' || !isGarminHttpsUrl(link)) return null;
  const query = link.split('#')[0]?.split('?')[1] ?? '';
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? '' : decode(pair.slice(eq + 1));
    if (key === 'ticket' && value !== '') return value;
  }
  return null;
}

/**
 * Only the FIRST ticket counts: Garmin Connect would spend it if the web view followed the redirect, and a second
 * navigation with a ticket must not trigger a second redemption. `inspect` tells the web view whether to let a
 * navigation through; `reset` re-arms the gate after a failed redemption ("Try again").
 */
export interface TicketGate {
  inspect(url: string): { allow: boolean; ticket: string | null };
  reset(): void;
}

export function createTicketGate(): TicketGate {
  let used = false;
  return {
    inspect(url) {
      const ticket = ticketIn(url);
      if (ticket === null) return { allow: true, ticket: null };
      // The navigation that carries a ticket is always stopped; only the first one hands the ticket out.
      if (used) return { allow: false, ticket: null };
      used = true;
      return { allow: false, ticket };
    },
    reset() {
      used = false;
    },
  };
}
