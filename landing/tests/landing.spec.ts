import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { getDownloadAvailability, releaseFixtures } from "../src/config/releaseAvailability";

// Geometry/content references use the static state; motion has its own live suite.
test.use({ reducedMotion: "reduce" });

const localOrigin = process.env.LANDING_URL ?? "http://127.0.0.1:4321";
const routes = [
  { path: "/", locale: "ru", hero: "Не копи шлоп, управляй хранилищем", feature: "Ничего лишнего — зато сколько гибкости (и бесплатно!)", firstCard: "Разбирает шлоп по категориям. Лишнее выбираете сами" },
  { path: "/en/", locale: "en", hero: "Don’t hoard slop, take charge of storage", feature: "Nothing extra — but so much freedom (and it’s free!)", firstCard: "Sorts slop by category. You pick what goes" },
] as const;
const widths = [360, 375, 390, 414, 479, 480, 481, 767, 768, 769, 1023, 1024, 1025, 1279, 1280, 1281, 1366, 1439, 1440, 1441, 1536, 1919, 1920];
const evidenceDirectory = resolve(import.meta.dirname, "../../docs/landing-v2/qa/implementation");

function localUrl(path: string): string { return new URL(path, localOrigin).toString(); }

async function goto(page: Page, path: string): Promise<void> {
  await page.goto(localUrl(path), { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("main[data-locale]")).toBeVisible();
}

async function newPage(browser: Browser, options: Parameters<Browser["newContext"]>[0] = {}): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  return { page: await context.newPage(), close: () => context.close() };
}

test("renders the exact v2 desktop content, local assets, and locale paths", async ({ page }) => {
  for (const route of routes) {
    await goto(page, route.path);
    await expect(page.locator("html")).toHaveAttribute("lang", route.locale);
    await expect(page.getByRole("heading", { level: 1, name: route.hero })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: route.feature })).toBeVisible();
    await expect(page.locator(".feature-card")).toHaveCount(3);
    await expect(page.locator(".feature-card").nth(0)).toContainText(route.firstCard);
    await expect(page.locator(".screen-section img")).toHaveAttribute("src", "/landing-v2/assets/screen-img.png");
    await expect(page.locator(".brand__wordmark")).toHaveAttribute("src", "/landing-v2/assets/hero-wordmark.svg");
    await expect(page.locator("a[href='#']")).toHaveCount(0);
    await expect(page.locator(".site-footer")).toHaveAttribute("id", "footer");
    await expect(page.locator(".social-link--github")).toHaveAttribute("href", "https://github.com/sukaslitno/verbaclean");
    await expect(page.locator(".social-link--telegram")).toHaveAttribute("href", "https://t.me/insideverbes");
    await expect(page.locator(".social-link--beta-chat")).toHaveAttribute("href", "https://t.me/+pEqQ2UBbciAyZGYy");
    await expect(page.locator(".social-link--donate")).toBeDisabled();
    await expect(page.locator(".social-link--donate")).toContainText(/Ссылка появится позже|Link coming later/);
  }
});

test("keeps the reference desktop anchors and full-page height", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await goto(page, "/");
  const boxes = await page.evaluate(() => Object.fromEntries([".hero-copy h1", ".disk-stats", ".features-section", ".feature-cards", ".screen-section", ".cta-section", ".giant-download", ".site-footer"].map((selector) => [selector, document.querySelector(selector)?.getBoundingClientRect().toJSON()]))) as Record<string, DOMRect>;
  expect(boxes[".hero-copy h1"]).toMatchObject({ x: 254, y: 160, width: 932, height: 188 });
  expect(boxes[".disk-stats"]).toMatchObject({ x: 200, y: 627, width: 1040, height: 209 });
  expect(boxes[".feature-cards"]).toMatchObject({ x: 200, y: 1134, width: 1040, height: 418 });
  expect(boxes[".screen-section"]).toMatchObject({ x: 200, y: 1616, width: 1040, height: 828 });
  expect(boxes[".giant-download"]).toMatchObject({ x: 376, y: 2678, width: 688, height: 172 });
  expect(boxes[".site-footer"]).toMatchObject({ y: 3067, height: 114 });
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(3181);
  expect(await page.locator(".disk-stats__scan").evaluate((element) => element.getBoundingClientRect().y)).toBe(675);
  await expect(page.locator(".disk-stats__legend li").nth(0)).toHaveText("Кэши агентов:\u00a01,9 GB");
});

test("keeps every requested width inside the viewport on both locales", async ({ page }) => {
  test.setTimeout(90_000);
  for (const route of routes) for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await goto(page, route.path);
    const dimensions = await page.evaluate(() => ({ viewport: window.innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, dialogWidth: document.querySelector("dialog")?.getBoundingClientRect().width ?? 0 }));
    expect(dimensions.documentWidth, `${route.path} @ ${width}px document overflow`).toBeLessThanOrEqual(width);
    expect(dimensions.bodyWidth, `${route.path} @ ${width}px body overflow`).toBeLessThanOrEqual(width);
    expect(dimensions.dialogWidth, `${route.path} @ ${width}px dialog width`).toBeLessThanOrEqual(width);
  }
});

test("one dialog serves all three triggers and restores focus and scroll", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await goto(page, "/");
  const dialog = page.locator("[data-download-dialog]");
  const triggers = page.locator("[data-download-trigger]");
  await expect(triggers).toHaveCount(3);
  await page.evaluate(() => window.scrollTo(0, 2400));
  const before = await page.evaluate(() => window.scrollY);
  await triggers.nth(2).click();
  await expect(dialog).toHaveAttribute("open", "");
  await expect(page.locator("#main-content")).toHaveAttribute("inert", "");
  await expect(page.locator("#download-dialog-title")).toBeFocused();
  const focusSequence: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    await page.keyboard.press("Tab");
    expect(await page.locator("[data-download-dialog]").evaluate((element) => element.contains(document.activeElement))).toBe(true);
    focusSequence.push(await page.evaluate(() => document.activeElement?.matches("[data-download-close]") ? "close" : document.activeElement?.matches("summary") ? "os" : document.activeElement?.matches("[data-download-platform='windows']") ? "windows" : document.activeElement?.tagName ?? "none"));
  }
  expect(focusSequence).toEqual(["close", "os", "windows", "close"]);
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("[data-download-platform='windows']")).toBeFocused();
  const panelBox = await page.locator(".download-dialog__inner").boundingBox();
  if (!panelBox) throw new Error("dialog panel is missing");
  await page.mouse.click(panelBox.x + 10, panelBox.y + panelBox.height / 2);
  await expect(dialog).toHaveAttribute("open", "");
  await page.locator(".architecture-choice summary").click();
  await expect(page.locator(".architecture-choice")).toHaveAttribute("open", "");
  await page.keyboard.press("Tab");
  await expect(page.locator("[data-download-architecture='apple-silicon']")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(".architecture-choice summary")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toHaveAttribute("open", "");
  await expect(triggers.nth(2)).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
  await triggers.nth(0).click();
  await expect(page.locator(".architecture-choice")).not.toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  for (let index = 0; index < 10; index += 1) {
    await triggers.nth(0).click();
    await expect(dialog).toHaveAttribute("open", "");
    await page.locator("[data-download-close]").click();
    await expect(dialog).not.toHaveAttribute("open", "");
  }
});

test("has an honest OS mapping without starting a real download", async ({ page }) => {
  await goto(page, "/");
  await page.locator("[data-download-trigger]").first().click();
  const mac = page.locator("[data-download-platform='macos']");
  await expect(mac).toHaveCount(2);
  await expect(mac.nth(0)).toHaveAttribute("data-download-architecture", "apple-silicon");
  await expect(mac.nth(0)).toHaveAttribute("href", /Deslop_0\.1\.2_aarch64\.dmg$/);
  await expect(mac.nth(1)).toHaveAttribute("data-download-architecture", "intel");
  await expect(mac.nth(1)).toHaveAttribute("href", /Deslop_0\.1\.2_x64\.dmg$/);
  const windows = page.locator("[data-download-platform='windows']");
  await expect(windows).toHaveAttribute("data-download-architecture", "x64");
  await expect(windows).toHaveAttribute("href", /Deslop_0\.1\.2_x64-setup\.exe$/);
  await expect(page.locator(".download-dialog__notice")).toHaveCount(0);
  await expect(page.locator("#cta-title")).toHaveAttribute("aria-label", "Скачать на Мак или Винду");
});

test("models both, none, Mac-only, and Windows-only installer fixtures without inventing URLs", () => {
  for (const [name, fixture] of Object.entries(releaseFixtures)) {
    const availability = getDownloadAvailability(fixture);
    if (name === "both") expect(availability).toMatchObject({ macAvailable: true, windowsAvailable: true, macOption: { mode: "architecture", href: undefined }, windowsOption: { mode: "link", href: "/fixture-downloads/fixture.exe" } });
    if (name === "none") expect(availability).toMatchObject({ macAvailable: false, windowsAvailable: false, macOption: { mode: "disabled", href: undefined }, windowsOption: { mode: "disabled", href: undefined } });
    if (name === "macOnly") expect(availability).toMatchObject({ macAvailable: true, windowsAvailable: false, macOption: { mode: "link", href: "/fixture-downloads/fixture-intel.dmg" }, windowsOption: { mode: "disabled", href: undefined } });
    if (name === "windowsOnly") expect(availability).toMatchObject({ macAvailable: false, windowsAvailable: true, macOption: { mode: "disabled", href: undefined }, windowsOption: { mode: "link", href: "/fixture-downloads/fixture.exe" } });
    for (const release of [...availability.macReleases, ...availability.windowsReleases]) expect(release.url).toMatch(/^\/fixture-downloads\//);
  }
});

test("keeps content and fallback download links available without JavaScript", async ({ browser }) => {
  const { page, close } = await newPage(browser, { javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  try {
    await goto(page, "/");
    await expect(page.getByRole("heading", { level: 1, name: "Не копи шлоп, управляй хранилищем" })).toBeVisible();
    await expect(page.locator(".feature-card")).toHaveCount(3);
    await expect(page.locator("#download-options")).toBeVisible();
    await expect(page.locator(".download-fallback__mobile-context")).toHaveText("А зачем качать с мобилы?");
    await expect(page.locator("#download-options a").first()).toHaveAttribute("href", /aarch64\.dmg$/);
  } finally { await close(); }
});

test("works without IntersectionObserver and honours reduced motion", async ({ browser }) => {
  const { page, close } = await newPage(browser, { reducedMotion: "reduce" });
  const errors: string[] = [];
  try {
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => { Reflect.deleteProperty(window, "IntersectionObserver"); });
    await goto(page, "/");
    expect(await page.locator(".feature-card").evaluateAll((cards) => cards.every((card) => getComputedStyle(card).animationName === "none"))).toBe(true);
    await page.locator("[data-download-trigger]").first().click();
    await expect(page.locator("[data-download-dialog]")).toHaveAttribute("open", "");
    expect(errors).toEqual([]);
  } finally { await close(); }
});

test("loads local assets, actual fonts, and no first-party errors", async ({ page }) => {
  const errors: string[] = []; const failed: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => { if (response.url().startsWith(localOrigin) && response.status() >= 400) failed.push(`${response.status()} ${response.url()}`); });
  await goto(page, "/");
  const state = await page.evaluate(() => ({ fonts: [...document.fonts].every((font) => font.status === "loaded"), h1: getComputedStyle(document.querySelector("h1")!).fontFamily, iconSizes: [...document.querySelectorAll<SVGSVGElement>(".feature-card__icon svg")].map((icon) => [icon.viewBox.baseVal.width, icon.viewBox.baseVal.height]), screen: document.querySelector<HTMLImageElement>(".screen-section img")?.naturalWidth, smoothCorners: [...document.querySelectorAll(".disk-progress,.disk-progress span,.download-dialog__inner,.dialog-close,.architecture-choice__links a")].every((element) => element.classList.contains("vc-corner-smooth")) }));
  expect(state.fonts).toBe(true); expect(state.h1).toContain("Roobert Pro"); expect(state.iconSizes).toEqual([[210, 210], [210, 210], [210, 210]]); expect(state.screen).toBeGreaterThan(0); expect(state.smoothCorners).toBe(true); expect(errors).toEqual([]); expect(failed).toEqual([]);
});

test("captures Figma-comparison evidence", async ({ page }) => {
  await mkdir(evidenceDirectory, { recursive: true });
  for (const [path, width, height, name] of [["/", 1440, 900, "qa-ru-1440.png"], ["/en/", 1440, 900, "qa-en-1440.png"], ["/", 1280, 900, "qa-ru-1280.png"], ["/", 1920, 1080, "qa-ru-1920.png"], ["/", 390, 844, "qa-narrow-390.png"]] as const) {
    await page.setViewportSize({ width, height }); await goto(page, path); await page.screenshot({ path: resolve(evidenceDirectory, name), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 }); await goto(page, "/"); await page.locator("[data-download-trigger]").first().click(); await page.screenshot({ path: resolve(evidenceDirectory, "qa-modal-1440.png") });
});

test("matches the independent 390px mobile section geometry and mobile-only source copy", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await goto(page, "/");
  const boxes = await page.evaluate(() => Object.fromEntries([
    ".hero-section", ".site-header", ".hero-copy h1", ".hero-copy__disk", ".hero-copy p", ".hero-copy__actions", ".disk-stats",
    ".features-section", ".features-section h2", ".screen-section", ".screen-section__mobile-copy--before", ".screen-section picture", ".screen-section__mobile-copy--after",
    ".cta-section", ".cta-section h2", ".giant-download", ".cta-section__aside", ".social-links", ".site-footer",
  ].map((selector) => [selector, document.querySelector(selector)?.getBoundingClientRect().toJSON()])));
  expect(boxes[".hero-section"]).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
  expect(boxes[".site-header"]).toMatchObject({ x: 24, y: 24, width: 342, height: 48 });
  expect(boxes[".hero-copy h1"]).toMatchObject({ x: 24, y: 172, width: 342, height: 194 });
  expect(boxes[".hero-copy__disk"]).toMatchObject({ x: 45, y: 231, width: 64, height: 64 });
  expect(boxes[".hero-copy p"]).toMatchObject({ x: 24, y: 374, width: 342, height: 38 });
  expect(boxes[".hero-copy__actions"]).toMatchObject({ x: 24, y: 436, width: 342, height: 48 });
  expect(boxes[".disk-stats"]).toMatchObject({ x: 24, y: 548, width: 342, height: 227 });
  expect(boxes[".features-section"]).toMatchObject({ x: 0, y: 844, width: 390, height: 1528 });
  expect(boxes[".screen-section"]).toMatchObject({ x: 0, y: 2372, width: 390, height: 542 });
  expect(boxes[".screen-section__mobile-copy--before"]).toMatchObject({ x: 24, y: 2420, width: 342, height: 76 });
  const mobileScreen = boxes[".screen-section picture"];
  expect(mobileScreen).toMatchObject({ y: 2529, height: 230 });
  expect(mobileScreen.x).toBeCloseTo(24, 0);
  expect(mobileScreen.width).toBeCloseTo(341.705, 2);
  expect(boxes[".screen-section__mobile-copy--after"]).toMatchObject({ x: 24, y: 2790, width: 342, height: 76 });
  expect(boxes[".cta-section"]).toMatchObject({ x: 0, y: 2914, width: 390, height: 633 });
  expect(boxes[".giant-download"]).toMatchObject({ x: 24, y: 3086, width: 342, height: 100 });
  expect(boxes[".social-links"]).toMatchObject({ x: 24, y: 3283, width: 342, height: 216 });
  expect(boxes[".site-footer"]).toMatchObject({ x: 0, y: 3547, width: 390, height: 134 });
  await expect(page.locator(".screen-section__mobile-copy--before")).toHaveText("тут на мобиле\nвидно вообще что-то?");
  await expect(page.locator(".screen-section__mobile-copy--after")).toHaveText("сори, адаптивы\nделать не учили");
  await expect(page.locator(".screen-section img")).toHaveAttribute("src", "/landing-v2/assets/screen-img.png");
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(3681);
});

test("uses the mobile intro then real platform controls without side effects", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await goto(page, "/");
  const requests: string[] = [];
  page.on("request", (request) => { if (!request.url().startsWith(localOrigin)) requests.push(request.url()); });
  const dialog = page.locator("[data-download-dialog]");
  const triggers = page.locator("[data-download-trigger]");
  await expect(triggers).toHaveCount(3);
  await triggers.nth(0).click();
  await expect(page.locator('[data-dialog-title="mobile-intro"]')).toHaveText("А зачем качать с мобилы?");
  await expect(page.locator("[data-mobile-continue]")).toBeVisible();
  await expect(page.locator("[data-download-choices]")).toBeHidden();
  expect(await page.locator(".download-dialog__inner").boundingBox()).toMatchObject({ x: 0, y: 700, width: 390, height: 144 });
  await page.locator("[data-mobile-continue]").dblclick();
  await expect(page.locator('[data-dialog-title="mobile-platforms"]')).toHaveText("Не, ну если СИЛЬНО надо...");
  await expect(page.locator("[data-download-choices]")).toBeVisible();
  await expect(page.locator("[data-mobile-continue]")).toBeHidden();
  expect(requests).toEqual([]);
  await page.locator("[data-download-close]").click();
  await expect(dialog).not.toHaveAttribute("open", "");
  await expect(triggers.nth(0)).toBeFocused();
  await triggers.nth(2).click();
  await expect(page.locator('[data-dialog-title="mobile-intro"]')).toHaveText("А зачем качать с мобилы?");
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator("[data-mobile-continue]")).toBeVisible();
  await page.locator("[data-mobile-continue]").click();
  await expect(page.locator('[data-dialog-title="mobile-platforms"]')).toHaveText("Не, ну если СИЛЬНО надо...");
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(page.locator('[data-dialog-title="mobile-platforms"]')).toHaveText("Не, ну если СИЛЬНО надо...");
  await page.keyboard.press("Escape");
});

test("keeps narrow stats visible and the header download name intact", async ({ page }) => {
  for (const width of [320, 360, 390, 767, 768, 769]) {
    await page.setViewportSize({ width, height: 844 });
    await goto(page, "/");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const headerDownload = page.locator(".small-control--download");
    await expect(headerDownload).toHaveAttribute("aria-label", "Скачать");
    const hidden = await page.locator(".disk-stats__legend li").evaluateAll((items) => items.some((item) => item.getBoundingClientRect().bottom > item.closest(".disk-stats")!.getBoundingClientRect().bottom));
    expect(hidden).toBe(false);
  }
});
