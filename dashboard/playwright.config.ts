import { defineConfig, devices } from "@playwright/test";

// Smoke tests run against the production build served by `vite preview`, so the GitHub Pages
// base path (/Claim-Agent/) and the lazy chunks are exercised exactly as deployed.
const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}/Claim-Agent/`;

// The pinned @playwright/test matches the Chromium in PLAYWRIGHT_BROWSERS_PATH; CHROMIUM_PATH
// points at any other build without a `playwright install`.
const executablePath = process.env.CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results/artifacts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    launchOptions: { executablePath },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    {
      name: "mobile",
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true },
    },
  ],
  webServer: {
    command: "npm run preview",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
