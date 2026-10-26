import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'evals/**/*.test.ts'],
    // Tests must never depend on a developer's local .env.
    env: {},
  },
});
