import { expect, test } from "@playwright/test";
import { releases } from "../src/config/releases";
import { getDownloadAvailability, releaseFixtures } from "../src/config/releaseAvailability";

test.use({ reducedMotion: "reduce" });

test("the published mapping points only at real, unambiguous release installers", () => {
  const keys = releases.map((entry) => `${entry.platform}/${entry.architecture}`);
  expect(new Set(keys).size).toBe(keys.length);
  for (const entry of releases) {
    expect(entry.url).toMatch(/^https:\/\/github\.com\/sukaslitno\/deslop\/releases\/download\/v\d+\.\d+\.\d+\//);
    expect(entry.url).toContain(`/v${entry.version}/`);
    expect(entry.url.endsWith(`/${entry.filename}`)).toBe(true);
    expect(entry.filename).toMatch(entry.platform === "macos" ? /\.dmg$/ : /\.exe$/);
  }
  expect(getDownloadAvailability(releases)).toMatchObject({ macAvailable: true, windowsAvailable: true });
});

for (const locale of ["ru", "en"] as const) for (const width of [1440, 390]) {
  test(`${locale} @ ${width}: every platform control and the CTA follow only the configured assets`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, entries] of Object.entries(releaseFixtures)) {
      await page.goto(`/qa/releases/${locale}/${name}/`);
      const mapping = getDownloadAvailability(entries);
      await expect(page.locator("[data-download-trigger]")).toHaveCount(3);
      await page.locator("[data-download-trigger]").first().click();
      if (width < 768) {
        await expect(page.locator("[data-download-choices]")).toBeHidden();
        await page.locator("[data-mobile-continue]").click();
      }
      for (const platform of ["macos", "windows"] as const) {
        const expected = platform === "macos" ? mapping.macReleases : mapping.windowsReleases;
        const controls = page.locator(`[data-download-platform="${platform}"]`);
        if (!expected.length) {
          await expect(controls).toBeDisabled();
          await expect(controls).not.toHaveAttribute("href");
        } else {
          await expect(controls).toHaveCount(expected.length);
          for (const entry of expected) await expect(page.locator(`[data-download-platform="${platform}"][data-download-architecture="${entry.architecture}"]`)).toHaveAttribute("href", entry.url);
        }
      }
      // The CTA only distinguishes the states that can ship: Mac-only and both.
      const later = locale === "ru" ? "позже" : "later";
      if (mapping.macAvailable) await (mapping.windowsAvailable ? expect(page.locator("#cta-title")).not.toContainText(later) : expect(page.locator("#cta-title")).toContainText(later));
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect(await page.locator("[data-download-dialog]").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.keyboard.press("Escape");
    }
  });
}

test("fixture installers navigate only to the exact local asset; the mobile intro never downloads", async ({ page }) => {
  const requested: string[] = [];
  await page.route("**/fixture-downloads/**", (route) => {
    requested.push(new URL(route.request().url()).pathname);
    return route.fulfill({ contentType: "text/plain", body: "Local installer fixture" });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/qa/releases/ru/windowsOnly/");
  await page.locator("[data-download-trigger]").first().click();
  await page.locator("[data-mobile-continue]").dblclick();
  expect(requested).toEqual([]);
  await page.locator('[data-download-platform="windows"]').press("Enter");
  await expect(page).toHaveURL(/\/fixture-downloads\/fixture\.exe$/);
  expect(requested).toEqual(["/fixture-downloads/fixture.exe"]);
});

test("the no-JavaScript fallback preserves every configured installer", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await page.goto("/qa/releases/ru/both/");
    const fallback = page.locator("#download-options");
    await expect(fallback).toBeVisible();
    for (const entry of releaseFixtures.both) await expect(fallback.locator(`a[href="${entry.url}"]`)).toBeVisible();
  } finally { await context.close(); }
});
