import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const output = process.env.DESLOP_STATE_TEST_OUTPUT;
if (!output) throw new Error("DESLOP_STATE_TEST_OUTPUT is required");
const { initialSelection, selectableEntries } = await import(pathToFileURL(resolve(output, "initial-selection.js")).href);

const categories = [
  { tier: "GREEN", entries: [{ id: "arc-cache" }, { id: "arc-sw", tier: "YELLOW" }, { id: "arc-gpu", tier: "GREEN" }] },
  { tier: "YELLOW", entries: [{ id: "pkg" }, { id: "pkg-green", tier: "GREEN" }] },
  { tier: "RED", entries: [{ id: "manual" }] },
];

test("automatic selection is per entry: own tier first, category tier otherwise", () => {
  assert.deepEqual([...initialSelection(categories, "automatic")].sort(), ["arc-cache", "arc-gpu", "pkg-green"]);
});

test("Service Worker style YELLOW entries inside a GREEN category are not preselected", () => {
  assert.equal(initialSelection(categories, "automatic").has("arc-sw"), false);
});

test("manual mode selects nothing", () => {
  assert.equal(initialSelection(categories, "manual").size, 0);
});

test("RED entries are never selectable", () => {
  assert.deepEqual(selectableEntries(categories).map((entry) => entry.id), ["arc-cache", "arc-sw", "arc-gpu", "pkg", "pkg-green"]);
});
