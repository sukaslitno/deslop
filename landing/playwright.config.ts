import { defineConfig } from "@playwright/test";

const browserName = (process.env.QA_BROWSER ?? "chromium") as "chromium" | "firefox" | "webkit";

/**
 * QA deliberately uses the shared preview. Do not add `webServer` here: desktop
 * owns `pnpm dev` on port 4321 and a second server makes HMR evidence unreliable.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 30_000,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: process.env.LANDING_URL ?? "http://127.0.0.1:4321",
    browserName,
    // A preinstalled Google Chrome can be selected for local QA while the
    // Playwright-managed runtime is unavailable: QA_CHROME_CHANNEL=chrome.
    channel: process.env.QA_CHROME_CHANNEL === "chrome" ? "chrome" : undefined,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  outputDir: "test-results",
});
