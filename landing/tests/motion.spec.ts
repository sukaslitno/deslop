import { expect, test } from "@playwright/test";

test.use({ reducedMotion: "no-preference" });

test("disk counts down faster than rounded bars and survives a mid-flight resize", async ({ page }) => {
  // Let navigation, fonts and scrolling settle before starting the one-shot demo.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const disk = page.locator('[data-motion="disk"]');
  await disk.scrollIntoViewIfNeeded();
  await expect(disk).toHaveAttribute("data-motion-state", "static");
  const read = () => disk.evaluate((el) => ({
    used: Number(el.querySelector("[data-disk-value='used']")!.textContent!.replace(",", ".").replace(" GB", "")),
    bars: [...el.querySelectorAll<HTMLElement>("[data-disk-bar]")].map((bar) => ({ width: bar.getBoundingClientRect().width, radius: getComputedStyle(bar).borderRadius, transform: getComputedStyle(bar).transform })),
  }));
  const start = await read();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(disk).toHaveAttribute("data-motion-state", "running");
  await page.waitForTimeout(1500);
  const middle = await read();
  expect(middle.used).toBeLessThan(start.used);
  middle.bars.forEach((bar, index) => {
    expect(bar.width).toBeGreaterThan(0);
    expect(bar.width).toBeLessThan(start.bars[index].width);
    expect(parseFloat(bar.radius)).toBeGreaterThan(0);
    expect(bar.transform).toBe("none");
  });
  await page.setViewportSize({ width: 320, height: 740 });
  await disk.scrollIntoViewIfNeeded();
  const fits = await disk.evaluate((el) => {
    const track = el.querySelector(".disk-progress")!.getBoundingClientRect();
    return [...el.querySelectorAll(".disk-progress > span")].every((bar) => {
      const box = bar.getBoundingClientRect();
      return box.left >= track.left && box.right <= track.right + 0.5;
    });
  });
  expect(fits).toBe(true);
  await expect(page.locator("[data-disk-value='used']")).toHaveText("56,2 GB");
  expect((await read()).bars[0].width).toBeGreaterThan(0);
  await expect(disk).toHaveAttribute("data-motion-state", "finished", { timeout: 8000 });
  (await read()).bars.forEach((bar) => expect(bar.width).toBe(0));
  await expect(page.locator("[data-disk-value='cache']").first()).toHaveText("0,0 GB");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await disk.scrollIntoViewIfNeeded();
  await page.waitForTimeout(100);
  (await read()).bars.forEach((bar) => expect(bar.width).toBe(0));
  await expect(page.locator("[data-disk-value='used']")).toHaveText("56,2 GB");
});

test("icons animate together, pause offscreen, and accelerate without restarting", async ({ page }) => {
  await page.goto("/");
  const brush = page.locator('[data-motion="brush"]');
  await brush.scrollIntoViewIfNeeded();
  await expect(brush).toHaveAttribute("data-motion-state", "running");
  const read = () => brush.evaluate((root) => root.getAnimations({ subtree: true }).map((a) => ({ time: Number(a.currentTime), rate: a.playbackRate, state: a.playState, now: performance.now() })));
  await page.waitForTimeout(500);
  const before = await read();
  await page.locator(".feature-card").first().hover();
  await page.waitForTimeout(650);
  const hovered = await read();
  expect(hovered[0].rate).toBeCloseTo(1.3, 1);
  // Use the browser clock: automation may wait for a stable hover target.
  const elapsed = hovered[0].now - before[0].now;
  expect(hovered[0].time - before[0].time).toBeGreaterThan(elapsed * 0.95 - 100);
  expect(hovered[0].time - before[0].time).toBeLessThan(elapsed * 1.31 + 100);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(650);
  expect((await read())[0].rate).toBeCloseTo(1, 1);
  await page.locator(".site-footer").scrollIntoViewIfNeeded();
  await expect(brush).toHaveAttribute("data-motion-state", "paused");
  const paused = await read();
  await page.waitForTimeout(200);
  expect((await read())[0].time).toBeCloseTo(paused[0].time, 1);
  await brush.scrollIntoViewIfNeeded();
  await expect(brush).toHaveAttribute("data-motion-state", "running");
  expect((await read())[0].time).toBeGreaterThanOrEqual(paused[0].time);
  for (const name of ["map", "alarm"]) {
    const root = page.locator(`[data-motion="${name}"]`);
    await root.scrollIntoViewIfNeeded();
    await expect(root).toHaveAttribute("data-motion-state", "running");
    expect(await root.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBeGreaterThan(0);
  }
});

test("live reduced-motion preference restores complete static artwork and values", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-motion="disk"]').scrollIntoViewIfNeeded();
  await expect(page.locator('[data-motion="disk"]')).toHaveAttribute("data-motion-state", "running");
  await page.waitForTimeout(900);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".disk-stats__numbers strong")).toHaveText("60,1 GB");
  for (const name of ["disk", "brush", "map", "alarm"]) {
    const root = page.locator(`[data-motion="${name}"]`);
    await expect(root).toHaveAttribute("data-motion-state", "static");
    expect(await root.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator('[data-motion="disk"]')).toHaveAttribute("data-motion-state", "running");
});

test("page lifecycle pauses native tracks and resumes their existing phase", async ({ page }) => {
  await page.goto("/");
  const brush = page.locator('[data-motion="brush"]');
  await brush.scrollIntoViewIfNeeded();
  await expect(brush).toHaveAttribute("data-motion-state", "running");
  await page.waitForTimeout(200);
  // Exercise the lifecycle handlers deterministically in headless browsers.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await expect(brush).toHaveAttribute("data-motion-state", "paused");
  const time = await brush.evaluate((el) => Number(el.getAnimations({ subtree: true })[0].currentTime));
  await page.waitForTimeout(200);
  expect(await brush.evaluate((el) => Number(el.getAnimations({ subtree: true })[0].currentTime))).toBeCloseTo(time, 1);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(brush).toHaveAttribute("data-motion-state", "running");
  expect(await brush.evaluate((el) => Number(el.getAnimations({ subtree: true })[0].currentTime))).toBeGreaterThanOrEqual(time);
});

for (const failure of ["javascript", "network", "observer", "waapi"] as const) {
  test(`keeps static illustrations when ${failure} is unavailable`, async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: failure !== "javascript", viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    if (failure === "network") await page.route("**/*", (route) => route.request().resourceType() === "script" ? route.abort() : route.continue());
    if (failure === "observer") await page.addInitScript(() => { Reflect.deleteProperty(window, "IntersectionObserver"); });
    if (failure === "waapi") await page.addInitScript(() => { Reflect.deleteProperty(Element.prototype, "animate"); });
    try {
      await page.goto("/");
      await expect(page.locator(".disk-stats__numbers strong")).toHaveText("60,1 GB");
      await expect(page.locator(".feature-card__icon svg")).toHaveCount(3);
      for (const icon of await page.locator(".feature-card__icon").all()) {
        await icon.scrollIntoViewIfNeeded();
        await expect(icon).toBeVisible();
        expect(await icon.locator("path").count()).toBeGreaterThan(1);
      }
      expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    } finally { await context.close(); }
  });
}

test("touch layout keeps icons together and never latches hover acceleration", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 740 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await page.goto("/");
    for (const icon of await page.locator(".feature-card__icon").all()) {
      await icon.scrollIntoViewIfNeeded();
      await expect(icon).toHaveAttribute("data-motion-state", "running");
      await icon.tap();
      await page.waitForTimeout(100);
      const result = await icon.evaluate((el) => {
        const card = el.closest(".feature-card")!.getBoundingClientRect();
        const paths = [...el.querySelectorAll("path")].map((p) => p.getBoundingClientRect());
        return { rates: el.getAnimations({ subtree: true }).map((a) => a.playbackRate), fits: paths.every((p) => p.left >= card.left && p.right <= card.right && p.bottom <= card.bottom && p.top >= card.top), overflow: document.documentElement.scrollWidth > innerWidth };
      });
      expect(result.rates.every((rate) => rate === 1)).toBe(true);
      expect(result.fits).toBe(true);
      expect(result.overflow).toBe(false);
    }
  } finally { await context.close(); }
});
