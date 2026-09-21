import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  use: { baseURL: "http://127.0.0.1:1420", viewport: { width: 1040, height: 700 }, trace: "retain-on-failure" },
  webServer: {
    command: "pnpm dev --host 127.0.0.1",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: !process.env.CI,
  },
});
