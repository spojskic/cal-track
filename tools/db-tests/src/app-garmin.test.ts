// Pure helpers of the app's "Connect Garmin" card (apps/app/src/health/garmin.ts). The app has no test runner of its own;
// the module imports nothing from react-native / expo on purpose, so it is exercised here.
import { describe, expect, it } from 'vitest';
import {
  GARMIN_ENABLED,
  GARMIN_PAST_DATA_NOTE,
  NOT_CONNECTED,
  describeGarminFunctionError,
  describeGarminReturn,
  describeLastError,
  describeLastPush,
  parseGarminReturn,
  parseGarminReturnUrl,
  parseGarminStatus,
} from '../../../apps/app/src/health/garmin.ts';

describe('app garmin: feature flag', () => {
  it('ships dormant: the flag is off unless EXPO_PUBLIC_GARMIN_ENABLED is exactly "true"', () => {
    expect(process.env.EXPO_PUBLIC_GARMIN_ENABLED).toBeUndefined();
    expect(GARMIN_ENABLED).toBe(false);
  });

  it('says that Garmin only sends data from the moment of connecting', () => {
    expect(GARMIN_PAST_DATA_NOTE).toContain('only sends data from the moment you connect');
    expect(GARMIN_PAST_DATA_NOTE).toContain('past days are not imported');
  });
});

describe('app garmin: status', () => {
  it('parses the one-row RPC answer', () => {
    expect(
      parseGarminStatus([
        {
          connected: true,
          connected_at: '2026-11-10T08:00:00+00:00',
          last_push_at: '2026-11-10T09:30:00+00:00',
          last_error: null,
        },
      ]),
    ).toEqual({
      connected: true,
      connectedAt: '2026-11-10T08:00:00+00:00',
      lastPushAt: '2026-11-10T09:30:00+00:00',
      lastError: null,
    });
    expect(
      parseGarminStatus({
        connected: true,
        connected_at: null,
        last_push_at: null,
        last_error: 'apply_failed',
      }),
    ).toEqual({
      connected: true,
      connectedAt: null,
      lastPushAt: null,
      lastError: 'apply_failed',
    });
  });

  it('anything else means "not connected" (and nothing else leaks through)', () => {
    for (const bad of [
      null,
      undefined,
      [],
      [{}],
      [{ connected: false }],
      [{ connected: 'yes' }],
      'x',
      5,
    ]) {
      expect(parseGarminStatus(bad)).toEqual(NOT_CONNECTED);
    }
    expect(
      parseGarminStatus([{ connected: true, connected_at: 'not a date', access_token: 'SECRET' }]),
    ).toEqual({
      connected: true,
      connectedAt: null,
      lastPushAt: null,
      lastError: null,
    });
  });

  it('describes errors and the last sync in plain words', () => {
    expect(describeLastError(null)).toBeNull();
    expect(describeLastError('apply_failed')).toMatch(/could not be saved/);
    expect(describeLastError('weird')).toMatch(/problem with the last Garmin update/);
    expect(describeLastPush(null, () => 'x')).toMatch(/No data received yet/);
    expect(describeLastPush('2026-11-10T09:30:00Z', (d) => d.toISOString())).toBe(
      '2026-11-10T09:30:00.000Z',
    );
  });
});

describe('app garmin: return from the browser', () => {
  it('parses router params (web)', () => {
    expect(parseGarminReturn({ garmin: 'connected' })).toEqual({ status: 'connected' });
    expect(parseGarminReturn({ garmin: ['connected', 'x'] })).toEqual({ status: 'connected' });
    expect(parseGarminReturn({ garmin: 'error', reason: 'access_denied' })).toEqual({
      status: 'error',
      reason: 'access_denied',
    });
    expect(parseGarminReturn({ garmin: 'error' })).toEqual({ status: 'error', reason: 'unknown' });
    expect(parseGarminReturn({ garmin: 'error', reason: '<script>alert(1)</script>' })).toEqual({
      status: 'error',
      reason: 'unknown',
    });
    expect(parseGarminReturn({})).toBeNull();
    expect(parseGarminReturn({ garmin: 'maybe' })).toBeNull();
  });

  it('parses the deep link that ends a native auth session', () => {
    expect(parseGarminReturnUrl('caltrack://settings/integrations?garmin=connected')).toEqual({
      status: 'connected',
    });
    expect(
      parseGarminReturnUrl(
        'caltrack://settings/integrations?garmin=error&reason=account_already_linked#top',
      ),
    ).toEqual({
      status: 'error',
      reason: 'account_already_linked',
    });
    expect(
      parseGarminReturnUrl('https://app.example.com/settings/integrations?garmin=connected'),
    ).toEqual({ status: 'connected' });
    expect(parseGarminReturnUrl('caltrack://settings/integrations')).toBeNull();
    expect(parseGarminReturnUrl(undefined)).toBeNull();
    expect(parseGarminReturnUrl('')).toBeNull();
  });

  it('turns every outcome into a message and never echoes unknown reasons', () => {
    expect(describeGarminReturn({ status: 'connected' })).toMatchObject({ tone: 'success' });
    for (const reason of [
      'access_denied',
      'account_already_linked',
      'not_configured',
      'token_exchange_failed',
      'save_failed',
    ]) {
      const m = describeGarminReturn({ status: 'error', reason });
      expect(m.tone).toBe('danger');
      expect(m.text.length).toBeGreaterThan(10);
    }
    expect(describeGarminReturn({ status: 'error', reason: 'brand_new_code' }).text).toBe(
      'Garmin sign-in failed. Please try again.',
    );
  });

  it('explains edge function failures', () => {
    expect(describeGarminFunctionError({ status: null })).toMatch(/Could not reach/);
    expect(describeGarminFunctionError({ status: 503, error: 'garmin_not_configured' })).toMatch(
      /not set up on the server/,
    );
    expect(describeGarminFunctionError({ status: 429, error: 'rate_limited' })).toMatch(/Too many/);
    expect(describeGarminFunctionError({ status: 404 })).toMatch(/not deployed/);
    expect(describeGarminFunctionError({ status: 401 })).toMatch(/signed out/);
    expect(describeGarminFunctionError({ status: 500 })).toMatch(/could not be reached/);
  });
});
