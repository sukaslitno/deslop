import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const output = process.env.DESLOP_STATE_TEST_OUTPUT;
if (!output) throw new Error("DESLOP_STATE_TEST_OUTPUT is required");
const { summarizeCleanResult } = await import(pathToFileURL(resolve(output, "clean-result-summary.js")).href);

const GB = 1024 ** 3;
const base = { freed: 0, freed_size_unknown: false, outcomes: [], deleted: [], skipped: [], errors: [], record_error: null, free_space_delta: null };

test("reports removed data and free-space gain as separate numbers", () => {
  const summary = summarizeCleanResult({ ...base, freed: 3 * GB, free_space_delta: 2.9 * GB, outcomes: [{ status: "deleted", freed: 3 * GB }] });
  assert.equal(summary.removedBytes, 3 * GB);
  assert.equal(summary.freeSpaceDelta, 2.9 * GB);
  assert.equal(summary.spaceHeld, false);
  assert.equal(summary.title, "finished");
});

test("explains when free space grew much less than data removed", () => {
  const summary = summarizeCleanResult({ ...base, freed: 3 * GB, free_space_delta: 0.3 * GB, outcomes: [{ status: "deleted", freed: 3 * GB }] });
  assert.equal(summary.spaceHeld, true);
});

test("an unmeasured delta stays null and never triggers the explanation", () => {
  const summary = summarizeCleanResult({ ...base, freed: GB, outcomes: [{ status: "deleted", freed: GB }] });
  assert.equal(summary.freeSpaceDelta, null);
  assert.equal(summary.spaceHeld, false);
  const legacy = summarizeCleanResult({ ...base, freed: GB, free_space_delta: undefined, outcomes: [{ status: "deleted", freed: GB }] });
  assert.equal(legacy.freeSpaceDelta, null);
});

test("a negative delta is clamped to zero", () => {
  const summary = summarizeCleanResult({ ...base, freed: GB, free_space_delta: -5, outcomes: [{ status: "deleted", freed: GB }] });
  assert.equal(summary.freeSpaceDelta, 0);
  assert.equal(summary.spaceHeld, true);
});

test("partial and recreated outcomes are successes with notes, not failures", () => {
  const summary = summarizeCleanResult({ ...base, freed: GB, outcomes: [
    { status: "partial", freed: GB / 2, remaining: GB / 4, measurement: "allocated" },
    { status: "recreated", freed: GB / 2, measurement: "scanEstimate" },
  ] });
  assert.equal(summary.succeeded, 2);
  assert.equal(summary.partial, 1);
  assert.equal(summary.recreated, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.hasIssues, false);
  assert.equal(summary.removedIsEstimate, true);
  assert.equal(summary.title, "finished");
});

test("skipped, error and unknown outcomes are issues", () => {
  const summary = summarizeCleanResult({ ...base, outcomes: [
    { status: "skipped", freed: 0 }, { status: "error", freed: 0 }, { status: "unknown", freed: 0 },
  ] });
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 2);
  assert.equal(summary.title, "finishedWithIssues");
  assert.equal(summarizeCleanResult(base).title, "nothingRemoved");
});
