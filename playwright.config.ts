import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "e2e.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90000,
  expect: { timeout: 15000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    channel: process.env.FINANCE_BROWSER_CHANNEL || undefined,
    baseURL: "http://127.0.0.1:4321",
    viewport: { width: 1440, height: 1120 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
