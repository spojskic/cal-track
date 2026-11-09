// Which health store a given platform has. Pure.
import type { HealthProviderId } from './types';

/** 'ios' -> Apple Health, 'android' -> Health Connect, anything else (web, ...) -> none. */
export function providerIdForPlatform(os: string): HealthProviderId | null {
  if (os === 'ios') return 'apple_health';
  if (os === 'android') return 'health_connect';
  return null;
}
