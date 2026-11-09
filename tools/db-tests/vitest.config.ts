import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Every test file boots its own PGlite (WASM Postgres) and applies all migrations.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
