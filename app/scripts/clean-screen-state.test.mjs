import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const output = process.env.DESLOP_STATE_TEST_OUTPUT;
if (!output) throw new Error("DESLOP_STATE_TEST_OUTPUT is required");
const { scanCtaFor } = await import(pathToFileURL(resolve(output, "clean-screen-state.js")).href);

test("initial state exposes only the central Scan my Mac action", () => {
  assert.deepEqual(
    scanCtaFor({
      initializing: false,
      scanning: false,
      scannedOnce: false,
      resultCount: 0,
      hasInitialScanError: false,
    }),
    { location: "center", label: "Scan my Mac" },
  );
});

test("first scan uses central Cancel scan progress action", () => {
  assert.deepEqual(
    scanCtaFor({
      initializing: false,
      scanning: true,
      scannedOnce: false,
      resultCount: 0,
      hasInitialScanError: false,
    }),
    { location: "progress", label: "Cancel scan" },
  );
});

test("initial errors and zero results retain one central action", () => {
  assert.deepEqual(
    scanCtaFor({
      initializing: false,
      scanning: false,
      scannedOnce: false,
      resultCount: 0,
      hasInitialScanError: true,
    }),
    { location: "center", label: "Retry" },
  );
  assert.deepEqual(
    scanCtaFor({
      initializing: false,
      scanning: false,
      scannedOnce: true,
      resultCount: 0,
      hasInitialScanError: false,
    }),
    { location: "center", label: "Scan again" },
  );
});

test("results move the only scan action to compact header Rescan", () => {
  assert.deepEqual(
    scanCtaFor({
      initializing: false,
      scanning: false,
      scannedOnce: true,
      resultCount: 3,
      hasInitialScanError: false,
    }),
    { location: "header", label: "Rescan" },
  );
});

test("a rescan keeps its cancel action in the header alongside existing results", () => {
  assert.deepEqual(
    scanCtaFor({
      initializing: false,
      scanning: true,
      scannedOnce: true,
      resultCount: 3,
      hasInitialScanError: false,
    }),
    { location: "header", label: "Cancel scan" },
  );
});
