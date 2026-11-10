import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // The app's `@/` path alias, so app/src/data/* can be imported by the contract test.
    alias: [{ find: /^@\/(.*)$/, replacement: `${join(here, '..', '..', 'apps', 'app', 'src')}/$1` }],
  },
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 20_000,
    // Same switch as the browser build (src/constants.ts BUILD_ENV): the app's online lookups are on, the edge functions are mocked.
    env: { EXPO_PUBLIC_ONLINE_LOOKUP_ENABLED: 'true' },
  },
});
