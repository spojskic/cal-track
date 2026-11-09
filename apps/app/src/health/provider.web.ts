// Web: there is no health store in a browser. Data synced from the iOS/Android app shows up in the diary as usual.
import { WEB_NOTE } from './settings';
import { createUnsupportedProvider } from './unsupported';
import type { HealthProvider } from './types';

const provider: HealthProvider = createUnsupportedProvider('apple_health', 'Health sync', WEB_NOTE);

export const getHealthProvider = (): HealthProvider => provider;
