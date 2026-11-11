import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      {
        test: {
          name: 'api',
          include: ['test/api/**/*.test.ts'],
          globalSetup: ['test/server.ts'],
          fileParallelism: false,
          testTimeout: 20000,
          hookTimeout: 60000,
        },
      },
    ],
  },
});
