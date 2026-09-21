import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const output = process.env.DESLOP_STATE_TEST_OUTPUT;
if (!output) throw new Error("DESLOP_STATE_TEST_OUTPUT is required");
const { mapScreenState } = await import(pathToFileURL(resolve(output, "map-screen-state.js")).href);

test("empty Disk Map exposes the single Figma View map action", () => {
  assert.deepEqual(mapScreenState({ hasSnapshot: false, scanning: false }), {
    primaryAction: "View map",
    showsFolderScan: false,
    retainsSnapshot: false,
    showsProgress: false,
  });
});

test("initial Disk Map scan replaces the empty state with its progress state", () => {
  assert.deepEqual(mapScreenState({ hasSnapshot: false, scanning: true }), {
    primaryAction: null,
    showsFolderScan: false,
    retainsSnapshot: false,
    showsProgress: true,
  });
});

test("refresh retains the completed map instead of replacing it with an empty state", () => {
  assert.deepEqual(mapScreenState({ hasSnapshot: true, scanning: true }), {
    primaryAction: null,
    showsFolderScan: false,
    retainsSnapshot: true,
    showsProgress: true,
  });
});

test("completed results leave the full surface to the map and selection island", () => {
  assert.deepEqual(mapScreenState({ hasSnapshot: true, scanning: false }), {
    primaryAction: null,
    showsFolderScan: false,
    retainsSnapshot: true,
    showsProgress: false,
  });
});
