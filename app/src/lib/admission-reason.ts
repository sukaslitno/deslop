/**
 * Maps backend admission/outcome reason codes to localized message keys.
 *
 * The backend `detail` string is a technical English explanation. It is kept
 * as a secondary caption; the primary line shown to the user always comes
 * from the catalogue key returned here.
 */
export type AdmissionReasonKey =
  | "reasonAllowed"
  | "reasonOwnerRunning"
  | "reasonAppRunning"
  | "reasonSqliteInUse"
  | "reasonProbeFailed"
  | "reasonProbeTimeout"
  | "reasonProbeUnsupported"
  | "reasonLockUnreadable"
  | "reasonIdentityChanged"
  | "reasonExcluded"
  | "reasonManualOnly"
  | "reasonProtected"
  | "reasonNotIncluded";

export type OutcomeLabelKey =
  | AdmissionReasonKey
  | "outcomeSkipped"
  | "outcomeError"
  | "outcomeUnknown"
  | "outcomePartial"
  | "outcomeRecreated";

const OWNER_RUNNING_CODES = new Set(["owner_running", "singleton_lock_live"]);

const CODE_KEYS: Record<string, AdmissionReasonKey> = {
  allowed: "reasonAllowed",
  identity_or_scope_changed: "reasonIdentityChanged",
  excluded: "reasonExcluded",
  manual_only: "reasonManualOnly",
  sqlite_in_use: "reasonSqliteInUse",
  process_probe_unavailable: "reasonProbeFailed",
  sqlite_probe_unavailable: "reasonProbeFailed",
  process_probe_timeout: "reasonProbeTimeout",
  sqlite_probe_timeout: "reasonProbeTimeout",
  probe_timeout: "reasonProbeTimeout",
  sqlite_family_incomplete: "reasonProbeTimeout",
  process_probe_unsupported: "reasonProbeUnsupported",
  sqlite_probe_unsupported: "reasonProbeUnsupported",
  lock_unreadable: "reasonLockUnreadable",
};

/**
 * Returns the catalogue key for an admission. `owner` decides between the
 * "{owner} is running" copy and an owner-less fallback; unknown codes fall
 * back to a key derived from the admission state, never to raw backend text.
 */
export function admissionReasonKey(
  code: string | null | undefined,
  state?: string | null,
  owner?: string | null,
): AdmissionReasonKey {
  const normalized = (code ?? "").trim();
  if (OWNER_RUNNING_CODES.has(normalized)) {
    return owner && owner.trim() ? "reasonOwnerRunning" : "reasonAppRunning";
  }
  const mapped = CODE_KEYS[normalized];
  if (mapped) return mapped;
  if (normalized.endsWith("_timeout")) return "reasonProbeTimeout";
  if (normalized.endsWith("_unavailable")) return "reasonProbeFailed";
  if (normalized.endsWith("_unsupported")) return "reasonProbeUnsupported";
  switch (state) {
    case "allowed":
      return "reasonAllowed";
    case "busy":
      return owner && owner.trim() ? "reasonOwnerRunning" : "reasonAppRunning";
    case "unknown":
      return "reasonProbeFailed";
    case "protected":
      return "reasonProtected";
    default:
      return "reasonNotIncluded";
  }
}

/**
 * Primary label for a per-candidate cleanup outcome. When the backend reports
 * a reason code for a skipped candidate it is mapped like an admission;
 * otherwise the status alone selects a localized label.
 */
export function outcomeLabelKey(
  status: string,
  reasonCode?: string | null,
  owner?: string | null,
): OutcomeLabelKey {
  if (status === "partial") return "outcomePartial";
  if (status === "recreated") return "outcomeRecreated";
  if (status === "skipped") {
    return reasonCode ? admissionReasonKey(reasonCode, null, owner) : "outcomeSkipped";
  }
  if (status === "error") return "outcomeError";
  return "outcomeUnknown";
}
