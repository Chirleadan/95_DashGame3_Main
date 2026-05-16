import { defineConfig, devices } from '@playwright/test';

const FRONTEND_PORT = Number(process.env.PLAYWRIGHT_FRONTEND_PORT) || 5173;
const API_PORT = Number(process.env.PLAYWRIGHT_API_PORT) || 3001;

export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node scripts/ensure-env-local.mjs && npm run dev:backend',
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: 'node scripts/ensure-env-local.mjs && npm run dev:strict',
      url: `http://localhost:${FRONTEND_PORT}`,
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
});
