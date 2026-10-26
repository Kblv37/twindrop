import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.TWINDROP_E2E_BASE_URL || 'http://127.0.0.1:5173';
// Port 8888 is used by other local services in some environments. Keep the
// preview port configurable while using a free default for the SW suite.
const previewPort = process.env.TWINDROP_E2E_PREVIEW_PORT || '4173';
const previewURL = process.env.TWINDROP_E2E_PREVIEW_URL || `http://127.0.0.1:${previewPort}`;
const backendURL = process.env.TWINDROP_E2E_BACKEND_URL || 'http://127.0.0.1:3000';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    acceptDownloads: true,
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: '**/share-target-sw.spec.js',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
    {
      name: 'chromium-sw',
      testMatch: '**/share-target-sw.spec.js',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: previewURL,
      },
    },
  ],
  webServer: process.env.TWINDROP_E2E_SKIP_WEBSERVER === '1'
    ? undefined
    : [
      {
        command: 'npm --prefix ../backend start',
        url: `${backendURL}/api/health`,
        reuseExistingServer: true,
        timeout: 30_000,
        env: {
          NODE_ENV: 'development',
          HOST: '127.0.0.1',
          PORT: '3000',
          TWINDROP_FRONTEND_ORIGINS: 'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:4173,http://localhost:4173,http://127.0.0.1:8888,http://localhost:8888',
          TWINDROP_SIGNALING_URL: 'http://127.0.0.1:3000',
          TWINDROP_FRONTEND_URL: 'http://127.0.0.1:5173',
          // The whole Chromium suite opens more than 20 signaling joins from
          // 127.0.0.1 within one minute. Keep the production defaults intact
          // while avoiding a test-only rate-limit failure.
          TWINDROP_SOCKET_JOIN_LIMIT: '1000',
        },
      },
      {
        command: 'npm run dev -- --host 127.0.0.1',
        url: baseURL,
        reuseExistingServer: true,
        timeout: 60_000,
      },
      {
        // The production service worker is only registered by a production
        // build. Build and serve it through `vite preview` for the SW suite.
        command: `npm run build && npx --no-install vite preview --host 127.0.0.1 --port ${previewPort} --strictPort`,
        url: previewURL,
        reuseExistingServer: false,
        timeout: 180_000,
      },
    ],
});
