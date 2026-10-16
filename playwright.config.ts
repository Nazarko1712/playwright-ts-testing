import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration.
 *
 * Interview-relevant points to be able to explain:
 *  - `projects` are Playwright's unit of parallel/segmented execution. Here they
 *    split by layer, so `--project=api` runs no browser at all.
 *  - `fullyParallel` parallelises at test level, not just file level.
 *  - `forbidOnly` stops a stray `test.only` from silently shrinking a CI run.
 *  - `retries` only in CI: locally a flake should be seen and fixed, not hidden.
 *  - `trace: 'on-first-retry'` gives a full DOM/network/console timeline for the
 *    failing attempt without paying the cost on every green run.
 *  - `webServer` boots the local SSE/WebSocket server and waits for readiness,
 *    so messaging tests need no manual setup.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  webServer: {
    command: 'npx ts-node src/realtime-server.ts',
    url: 'http://127.0.0.1:8137/health',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },

  projects: [
    {
      name: 'ui',
      testDir: './tests/ui',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'https://demo.playwright.dev',
        // `slowMo` is a browser launch option, not a CLI flag - there is no
        // `--slowmo`. Driving it from an env var keeps it out of the committed
        // config while still being one command away: `SLOWMO=500 npm test`.
        launchOptions: { slowMo: Number(process.env.SLOWMO ?? 0) },
      },
    },
    {
      name: 'api',
      testDir: './tests/api',
      use: { baseURL: 'https://rickandmortyapi.com' },
    },
    {
      name: 'graphql',
      testDir: './tests/graphql',
      use: { baseURL: 'https://rickandmortyapi.com' },
    },
    {
      name: 'messaging',
      testDir: './tests/messaging',
      use: { baseURL: 'http://127.0.0.1:8137' },
    },
  ],
});
