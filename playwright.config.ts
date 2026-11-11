import { defineConfig, devices } from '@playwright/test';

const PORT = 8798;

// End-to-end tests drive the real app (Worker + local D1) in phone-sized browsers.
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 30000,
  workers: 1, // one shared server and database: run in order
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'ar',
    timezoneId: 'America/New_York', // a deliberately wrong device time zone: the app must not care
    trace: 'off',
  },
  projects: [
    { name: 'iphone', use: { ...devices['iPhone 14'], browserName: 'chromium' } },
    { name: 'android', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `npx wrangler dev --port ${PORT} --ip 127.0.0.1 --var TEST_MODE:1 --persist-to .tmp/e2e-state --show-interactive-dev-session=false`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120000,
  },
});
