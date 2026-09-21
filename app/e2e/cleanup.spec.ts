import { expect, test, type Page } from "@playwright/test";

// No native invocation escapes this fixture; these tests never inspect or
// delete host files, open Finder/Explorer, or navigate to external services.
async function boot(page: Page, options = { sixCategories: false }) {
  await page.addInitScript(({ sixCategories }) => {
    const prefs = { schemaVersion: 1, locale: "en", appearance: "dark", safeCandidateSelection: "automatic", sizeUnits: "binary", rememberLastMapFolder: false, lastMapFolder: null };
    const rules = ["pkg", "appcache", "editors", "claude", "xcode", "hf"];
    const categoryIds = ["packageCaches", "applicationCaches", "editorCaches", "agentCaches", "developerCaches", "modelCaches"];
    const categories = rules.slice(0, sixCategories ? 6 : 1).map((id, i) => ({
      id, title: id, tier: "GREEN", note: "fixture", manual: null, total: 1024,
      entries: [{ id: `entry-${i}`, path: `/fixture/${id}/cache`, size: 1024, reason: "fixture", restore: null }],
    }));
    const snapshot = { id: "snapshot-test", policy_fingerprint: "test", categories, skipped_roots: [], breakdown: {
      snapshotId: "snapshot-test", volumeId: "fixture", volumeCapacityBytes: 1e11, volumeAvailableBytes: 5e10, measurementKind: "logicalFallback", completedAt: Date.now() / 1000,
      scope: "exactRuleEngineHome", isPartial: false, skippedRoots: [], categories: categories.map((c, i) => ({ categoryId: categoryIds[i], candidateCount: 1, measuredBytes: c.total })),
    } };
    const harness: any = {
      calls: [] as { command: string; args: any }[], phase: "completed", mapPhase: "running", homeBlocked: false,
      cancelError: false, snapshot, finishClean: null, releaseHome: null,
    };
    const job = () => ({ id: "scan-test", phase: harness.phase, completed_rules: 1, total_rules: 1, message: "fixture", snapshot: harness.phase === "completed" ? snapshot : null, error: harness.phase === "failed" ? "Fixture refresh failed" : null });
    (window as any).__deslopTest = harness;
    (window as any).__TAURI_INTERNALS__ = { invoke: async (command: string, args: any = {}) => {
      harness.calls.push({ command, args });
      switch (command) {
        case "get_preferences": return { preferences: prefs, hasPersistedPreferences: true };
        case "update_preferences": return { ...prefs, ...args.patch };
        case "default_roots": return ["/fixture"];
        case "disk_info": return { total: 1e11, free: 5e10 };
        case "app_info": return { name: "Deslop", version: "test", build: "fixture", license: "MIT" };
        case "start_scan": case "scan_job_status": return job();
        case "cancel_scan":
          if (harness.cancelError) throw new Error("Fixture cancellation failed");
          harness.phase = "cancelled"; return job();
        case "preflight": return { id: "preflight-test", snapshot_id: snapshot.id, total: 1024, entries: categories.flatMap(c => c.entries), yellow_count: 1, warnings: [], running_apps: [], requires_yellow_confirmation: true };
        case "clean": return new Promise(resolve => { harness.finishClean = resolve; });
        case "home_dir": return harness.homeBlocked ? new Promise(resolve => { harness.releaseHome = () => resolve("/fixture"); }) : "/fixture";
        case "start_tree_scan": case "tree_job_status": return { id: "map-test", phase: harness.mapPhase, visited_nodes: 1, message: "fixture", snapshot: null, error: null };
        case "cancel_tree_scan": harness.mapPhase = "cancelled"; return { id: "map-test", phase: "cancelled", visited_nodes: 1, message: "fixture", snapshot: null, error: null };
        default: throw new Error(`Unexpected native invocation: ${command}`);
      }
    } };
  }, options);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Start scanning", exact: true })).toBeEnabled();
}

async function scanAndConfirm(page: Page) {
  await page.getByRole("button", { name: "Start scanning", exact: true }).click();
  // The workspace navigation also has a Clean button; the last one is the
  // selected-entry action, following the results.
  await page.getByRole("button", { name: "Clean", exact: true }).last().click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

const count = (page: Page, command: string) => page.evaluate(command => (window as any).__deslopTest.calls.filter((call: any) => call.command === command).length, command);
const partialResult = { run_id: "fixture-run", record_error: "Fixture history error", freed: 1024, freed_size_unknown: false, deleted: ["/fixture/deleted"], skipped: ["/fixture/skipped"], errors: ["/fixture/failed"], reinstall: [], outcomes: [{ id: "skip", path: "/fixture/skipped", status: "skipped", detail: "Identity changed", freed: 0 }, { id: "error", path: "/fixture/failed", status: "error", detail: "Permission denied", freed: 0 }] };

test("preflight is explicit, traps focus, and Escape returns to the initiator without deleting", async ({ page }) => {
  await boot(page);
  await scanAndConfirm(page);
  await expect.poll(() => count(page, "clean")).toBe(0);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Confirm and clean", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Clean", exact: true }).last()).toBeFocused();
  expect(await count(page, "clean")).toBe(0);
});

test("an active clean keeps keyboard focus inside the dialog and ignores Escape", async ({ page }) => {
  await boot(page);
  await scanAndConfirm(page);
  await page.getByRole("button", { name: "Confirm and clean", exact: true }).click();
  await expect.poll(() => count(page, "clean")).toBe(1);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+,");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  expect(await page.locator("[inert]").count()).toBe(1);
  expect(await page.evaluate(() => (window as any).__deslopTest.calls.find((call: any) => call.command === "clean").args.confirmYellow)).toBe(true);
});

test("partial cleanup survives refresh failure and retry never repeats deletion", async ({ page }) => {
  await boot(page);
  await scanAndConfirm(page);
  await page.getByRole("button", { name: "Confirm and clean", exact: true }).click();
  await page.evaluate(result => { const qa = (window as any).__deslopTest; qa.phase = "failed"; qa.finishClean(result); }, partialResult);
  await expect(page.getByText("Cleanup completed with issues", { exact: true })).toBeVisible();
  await expect(page.getByText(/1 deleted · 1 skipped · 1 errors/)).toBeVisible();
  await expect(page.getByText(/Fixture history error/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry refresh", exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__deslopTest.phase = "running"; });
  await page.getByRole("button", { name: "Retry refresh", exact: true }).dblclick();
  await expect.poll(() => count(page, "start_scan")).toBe(3);
  await expect(page.getByRole("button", { name: "Cancel scan", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Cancel scan", exact: true }).click();
  expect(await count(page, "clean")).toBe(1);
  await expect(page.getByText("Cleanup completed with issues", { exact: true })).toBeVisible();
});

test("post-clean refresh is cancellable and cancellation errors are visible", async ({ page }) => {
  await boot(page);
  await scanAndConfirm(page);
  await page.getByRole("button", { name: "Confirm and clean", exact: true }).click();
  await page.evaluate(result => { const qa = (window as any).__deslopTest; qa.phase = "running"; qa.cancelError = true; qa.finishClean(result); }, partialResult);
  const cancel = page.getByRole("button", { name: "Cancel scan", exact: true });
  await expect(cancel).toBeEnabled();
  await cancel.click();
  await expect(page.getByText(/Fixture cancellation failed/).first()).toBeVisible();
  expect(await count(page, "clean")).toBe(1);
});

test("map job survives Settings navigation and delayed startup cannot start a duplicate", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { (window as any).__deslopTest.homeBlocked = true; });
  await page.getByRole("button", { name: "Disk Map", exact: true }).click();
  await page.getByRole("button", { name: "View map", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Building map", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "View map", exact: true })).toHaveCount(0);
  await page.evaluate(() => { (window as any).__deslopTest.releaseHome(); });
  await expect.poll(() => count(page, "start_tree_scan")).toBe(1);
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("Disk map scan cancelled. No map was created.")).toBeVisible();
});

test("all six legends fit at minimum size and Settings returns keyboard focus", async ({ page }) => {
  await page.setViewportSize({ width: 920, height: 620 });
  await boot(page, { sixCategories: true });
  await page.getByRole("button", { name: "Start scanning", exact: true }).click();
  const legend = page.getByRole("list", { name: "Cache categories" });
  await expect(legend.locator("li")).toHaveCount(6);
  const last = await legend.locator("li").last().boundingBox();
  const card = await page.getByRole("region", { name: "Disk statistics" }).boundingBox();
  expect(last!.y + last!.height).toBeLessThanOrEqual(card!.y + card!.height);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
});
