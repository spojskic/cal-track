// Default provider resolution. Metro picks provider.ios.ts / provider.android.ts / provider.web.ts on those platforms;
// this file is what TypeScript sees and what any other target falls back to (no health store).
//
// The platform files export the same `getHealthProvider`.
import { createUnsupportedProvider } from './unsupported';
import type { HealthProvider } from './types';

const provider: HealthProvider = createUnsupportedProvider(
  'apple_health',
  'Health sync',
  'Health sync is not available on this platform.',
);

export const getHealthProvider = (): HealthProvider => provider;
