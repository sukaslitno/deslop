import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const output = process.env.DESLOP_STATE_TEST_OUTPUT;
const i18n = process.env.DESLOP_I18N_TEST_OUTPUT;
if (!output || !i18n) throw new Error("DESLOP_STATE_TEST_OUTPUT and DESLOP_I18N_TEST_OUTPUT are required");
const { admissionReasonKey, outcomeLabelKey } = await import(pathToFileURL(resolve(output, "admission-reason.js")).href);
const { en } = await import(pathToFileURL(resolve(i18n, "en.js")).href);
const { ru } = await import(pathToFileURL(resolve(i18n, "ru.js")).href);

const CODES = [
  "allowed", "identity_or_scope_changed", "excluded", "manual_only", "owner_running", "singleton_lock_live",
  "sqlite_in_use", "process_probe_unavailable", "process_probe_timeout", "process_probe_unsupported",
  "sqlite_probe_unavailable", "sqlite_probe_timeout", "sqlite_probe_unsupported", "sqlite_family_incomplete",
  "probe_timeout", "lock_unreadable",
];

test("every backend reason code maps to a key present in both catalogues", () => {
  for (const code of CODES) {
    for (const owner of ["Cursor", "", null]) {
      const key = admissionReasonKey(code, "unknown", owner);
      assert.ok(key in en, `${code} → ${key} missing in en`);
      assert.ok(key in ru, `${code} → ${key} missing in ru`);
    }
  }
});

test("running owners are named, and an unnamed owner gets a neutral sentence", () => {
  assert.equal(admissionReasonKey("owner_running", "busy", "Cursor"), "reasonOwnerRunning");
  assert.equal(admissionReasonKey("singleton_lock_live", "busy", "Arc"), "reasonOwnerRunning");
  assert.equal(admissionReasonKey("owner_running", "busy", ""), "reasonAppRunning");
  assert.match(ru.reasonOwnerRunning.replace("{owner}", "Cursor"), /^Cursor запущен — закройте приложение и повторите$/);
  assert.ok(!ru.reasonAppRunning.includes("{owner}"));
});

test("specific codes map to specific explanations", () => {
  assert.equal(admissionReasonKey("identity_or_scope_changed", "protected"), "reasonIdentityChanged");
  assert.equal(admissionReasonKey("excluded", "protected"), "reasonExcluded");
  assert.equal(admissionReasonKey("manual_only", "protected"), "reasonManualOnly");
  assert.equal(admissionReasonKey("sqlite_in_use", "busy"), "reasonSqliteInUse");
  assert.equal(admissionReasonKey("process_probe_unavailable", "unknown"), "reasonProbeFailed");
  assert.equal(admissionReasonKey("sqlite_probe_timeout", "unknown"), "reasonProbeTimeout");
  assert.equal(admissionReasonKey("lock_unreadable", "unknown"), "reasonLockUnreadable");
});

test("unknown codes fall back by state, never to raw backend text", () => {
  assert.equal(admissionReasonKey("future_probe_timeout", "unknown"), "reasonProbeTimeout");
  assert.equal(admissionReasonKey("something_new", "unknown"), "reasonProbeFailed");
  assert.equal(admissionReasonKey("something_new", "protected"), "reasonProtected");
  assert.equal(admissionReasonKey("something_new", "busy", "Slack"), "reasonOwnerRunning");
  assert.equal(admissionReasonKey(undefined, undefined), "reasonNotIncluded");
});

test("outcome labels: partial and recreated are notes, skipped uses its reason when known", () => {
  assert.equal(outcomeLabelKey("partial"), "outcomePartial");
  assert.equal(outcomeLabelKey("recreated"), "outcomeRecreated");
  assert.equal(outcomeLabelKey("skipped"), "outcomeSkipped");
  assert.equal(outcomeLabelKey("skipped", "owner_running", "Cursor"), "reasonOwnerRunning");
  assert.equal(outcomeLabelKey("error"), "outcomeError");
  assert.equal(outcomeLabelKey("unknown"), "outcomeUnknown");
});
