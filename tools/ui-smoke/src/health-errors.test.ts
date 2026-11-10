import { describe, expect, it } from 'vitest';

import { friendlyPermissionError } from '@/health/errors';

describe('friendlyPermissionError', () => {
  it('explains the missing HealthKit entitlement', () => {
    const raw = new Error('Error Domain=com.apple.healthkit Code=4 "Missing com.apple.developer.healthkit entitlement."');
    const out = friendlyPermissionError(raw);
    expect(out.message).toMatch(/HealthKit permission/);
    expect(out.message).not.toMatch(/Domain=/);
  });
  it('keeps other errors as they are', () => {
    const raw = new Error('Health data is unavailable on this device');
    expect(friendlyPermissionError(raw)).toBe(raw);
    expect(friendlyPermissionError('boom').message).toBe('boom');
  });
});
