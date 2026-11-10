import { describe, expect, it } from 'vitest';
import { SSO_SERVICE_URL } from './constants';
import { SIGN_IN_URL, createTicketGate, isGarminHttpsUrl, signInUrl, ticketIn } from './session';

describe('signInUrl', () => {
  it('is Garmin\'s own sign-in page for the GarminConnect client and the connect.garmin.com service', () => {
    expect(SIGN_IN_URL).toBe(signInUrl());
    expect(SIGN_IN_URL).toBe(
      'https://sso.garmin.com/portal/sso/en-US/sign-in?clientId=GarminConnect&service=https%3A%2F%2Fconnect.garmin.com%2Fapp',
    );
  });
  it('uses the same service URL as the ticket exchange (CAS compares it byte for byte)', () => {
    const service = new URL(SIGN_IN_URL).searchParams.get('service');
    expect(service).toBe(SSO_SERVICE_URL);
  });
  it('is not mistaken for a ticket redirect', () => {
    expect(ticketIn(SIGN_IN_URL)).toBeNull();
  });
});

describe('ticketIn', () => {
  it('reads the ticket of a redirect to a garmin.com host', () => {
    expect(ticketIn('https://connect.garmin.com/app?ticket=ST-1-abc')).toBe('ST-1-abc');
    expect(ticketIn('https://connect.garmin.com/modern/?foo=1&ticket=ST-2-def&bar=2')).toBe('ST-2-def');
    expect(ticketIn('https://garmin.com/?ticket=ST-3')).toBe('ST-3');
    expect(ticketIn('https://sso.garmin.com/portal?ticket=ST-4')).toBe('ST-4');
    expect(ticketIn('HTTPS://CONNECT.GARMIN.COM/app?ticket=ST-5')).toBe('ST-5');
    expect(ticketIn('https://connect.garmin.com:443/app?ticket=ST-6')).toBe('ST-6');
  });
  it('accepts every garmin.com subdomain', () => {
    for (const host of ['a.garmin.com', 'a.b.garmin.com', 'connect.garmin.com', 'sso.garmin.com']) {
      expect(ticketIn(`https://${host}/x?ticket=ST-1`), host).toBe('ST-1');
    }
  });
  it('rejects look-alike hosts: notgarmin.com, garmin.com.evil.test and friends', () => {
    for (const host of [
      'notgarmin.com',
      'garmin.com.evil.test',
      'evilgarmin.com',
      'garmin.com.',
      'garmin.co',
      'xgarmin.com',
      'connect.garmin.com.evil.test',
      'evil.test',
    ]) {
      expect(ticketIn(`https://${host}/app?ticket=ST-1`), host).toBeNull();
    }
  });
  it('is not fooled by garmin.com in the user info, the path or the query', () => {
    expect(ticketIn('https://garmin.com@evil.test/app?ticket=ST-1')).toBeNull();
    expect(ticketIn('https://user:pw@evil.test/app?ticket=ST-1')).toBeNull();
    expect(ticketIn('https://evil.test/garmin.com?ticket=ST-1')).toBeNull();
    expect(ticketIn('https://evil.test/?next=https://garmin.com/&ticket=ST-1')).toBeNull();
    expect(ticketIn('https://evil.test#garmin.com?ticket=ST-1')).toBeNull();
    expect(ticketIn('https://evil.test:443@garmin.com/?ticket=ST-1')).toBe('ST-1'); // host IS garmin.com here
  });
  it('rejects every scheme but https', () => {
    for (const scheme of ['http', 'ftp', 'javascript', 'file', 'garmin', 'data']) {
      expect(ticketIn(`${scheme}://connect.garmin.com/app?ticket=ST-1`), scheme).toBeNull();
    }
    expect(ticketIn('//connect.garmin.com/app?ticket=ST-1')).toBeNull();
    expect(ticketIn('connect.garmin.com/app?ticket=ST-1')).toBeNull();
  });
  it('needs a non-empty ticket parameter with exactly that name', () => {
    expect(ticketIn('https://connect.garmin.com/app?ticket=')).toBeNull();
    expect(ticketIn('https://connect.garmin.com/app?ticket')).toBeNull();
    expect(ticketIn('https://connect.garmin.com/app')).toBeNull();
    expect(ticketIn('https://connect.garmin.com/app?tickets=ST-1')).toBeNull();
    expect(ticketIn('https://connect.garmin.com/app?Ticket=ST-1')).toBeNull();
    expect(ticketIn('https://connect.garmin.com/app#ticket=ST-1')).toBeNull();
  });
  it('decodes the value and survives garbage', () => {
    expect(ticketIn('https://connect.garmin.com/app?ticket=ST-1%2Fx')).toBe('ST-1/x');
    expect(ticketIn('https://connect.garmin.com/app?ticket=%E0%A4')).toBe('%E0%A4'); // bad escape stays as is
    for (const junk of ['', 'not a url', '://', 'https://', 'https:///?ticket=x', undefined as unknown as string, 5 as unknown as string]) {
      expect(() => ticketIn(junk)).not.toThrow();
      expect(ticketIn(junk)).toBeNull();
    }
  });
});

describe('isGarminHttpsUrl', () => {
  it('matches only https garmin.com hosts', () => {
    expect(isGarminHttpsUrl('https://connect.garmin.com/app')).toBe(true);
    expect(isGarminHttpsUrl('http://connect.garmin.com/app')).toBe(false);
    expect(isGarminHttpsUrl('https://notgarmin.com/')).toBe(false);
  });
});

describe('createTicketGate', () => {
  it('lets ordinary pages through', () => {
    const gate = createTicketGate();
    expect(gate.inspect(SIGN_IN_URL)).toEqual({ allow: true, ticket: null });
    expect(gate.inspect('https://sso.garmin.com/portal/sso/en-US/sign-in/mfa')).toEqual({ allow: true, ticket: null });
  });
  it('stops the navigation that carries the ticket and hands out ONLY the first one', () => {
    const gate = createTicketGate();
    expect(gate.inspect('https://connect.garmin.com/app?ticket=ST-1')).toEqual({ allow: false, ticket: 'ST-1' });
    expect(gate.inspect('https://connect.garmin.com/app?ticket=ST-2')).toEqual({ allow: false, ticket: null });
    expect(gate.inspect('https://connect.garmin.com/app?ticket=ST-1')).toEqual({ allow: false, ticket: null });
  });
  it('can be re-armed after a failed redemption (Try again)', () => {
    const gate = createTicketGate();
    gate.inspect('https://connect.garmin.com/app?ticket=ST-1');
    gate.reset();
    expect(gate.inspect('https://connect.garmin.com/app?ticket=ST-9')).toEqual({ allow: false, ticket: 'ST-9' });
  });
  it('ignores a ticket on a foreign host (it is not stopped and does not use up the gate)', () => {
    const gate = createTicketGate();
    expect(gate.inspect('https://evil.test/?ticket=ST-1')).toEqual({ allow: true, ticket: null });
    expect(gate.inspect('https://connect.garmin.com/app?ticket=ST-2')).toEqual({ allow: false, ticket: 'ST-2' });
  });
});
