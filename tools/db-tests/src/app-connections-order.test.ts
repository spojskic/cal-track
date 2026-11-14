// Pure ordering rule of the "Connected apps & devices" screen (apps/app/src/health/settings.ts). Like app-signup.test.ts: the
// app has no test runner of its own, and these modules import nothing from react-native / expo / '@/'. Pure tests for the pure core
// of the screen: the connected services float to the top, the rest keep their order.
import { describe, expect, it } from 'vitest';

import { orderConnections } from '../../../apps/app/src/health/settings.ts';

const KEY = (entry: { key: string }) => entry.key;

describe('app connections order: connected services first', () => {
  it('a connected Garmin floats above the platform integration (the user must not scroll to it)', () => {
    const order = orderConnections([
      { key: 'platform', connected: true, lastSyncAt: null },
      { key: 'garmin', connected: true, lastSyncAt: new Date('2026-11-14T07:00:00Z') },
    ]);
    expect(order.map(KEY)).toEqual(['garmin', 'platform']);
  });

  it('a disconnected card sinks below the connected ones', () => {
    const order = orderConnections([
      { key: 'platform', connected: false, lastSyncAt: null },
      { key: 'garmin', connected: true, lastSyncAt: null },
    ]);
    expect(order.map(KEY)).toEqual(['garmin', 'platform']);
  });

  it('both connected: the one with the more recent sync wins; a never-synced card keeps its position', () => {
    const garminFirst = orderConnections([
      { key: 'platform', connected: true, lastSyncAt: new Date('2026-11-14T06:00:00Z') },
      { key: 'garmin', connected: true, lastSyncAt: new Date('2026-11-14T07:00:00Z') },
    ]);
    expect(garminFirst.map(KEY)).toEqual(['garmin', 'platform']);

    const platformFirst = orderConnections([
      { key: 'platform', connected: true, lastSyncAt: new Date('2026-11-14T09:00:00Z') },
      { key: 'garmin', connected: true, lastSyncAt: new Date('2026-11-14T07:00:00Z') },
    ]);
    expect(platformFirst.map(KEY)).toEqual(['platform', 'garmin']);

    const stable = orderConnections([
      { key: 'platform', connected: true, lastSyncAt: null },
      { key: 'garmin', connected: true, lastSyncAt: new Date('2026-11-13T07:00:00Z') },
    ]);
    expect(stable.map(KEY)).toEqual(['garmin', 'platform']);
  });

  it('neither connected (and a web screen without a platform card): the original order stands', () => {
    const order = orderConnections([
      { key: 'platform', connected: false, lastSyncAt: null },
      { key: 'garmin', connected: false, lastSyncAt: null },
    ]);
    expect(order.map(KEY)).toEqual(['platform', 'garmin']);
  });
});
