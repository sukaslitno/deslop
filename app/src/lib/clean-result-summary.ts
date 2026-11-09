/**
 * Pure summary of a cleanup result for the result card and the toast.
 *
 * "Data removed" (sum of per-candidate `freed`) and "free space gained"
 * (`free_space_delta`, a before/after volume measurement) are different
 * quantities on APFS: open file handles of running apps and local Time
 * Machine snapshots can keep blocks allocated after unlink. Both numbers are
 * reported, and a gap is explained instead of hidden.
 */
export interface SummaryOutcome {
  status: string;
  freed: number;
  remaining?: number;
  measurement?: string;
}

export interface SummaryResult {
  freed: number;
  freed_size_unknown: boolean;
  outcomes: readonly SummaryOutcome[];
  deleted: readonly unknown[];
  skipped: readonly unknown[];
  errors: readonly unknown[];
  record_error: string | null;
  free_space_delta?: number | null;
}

export type CleanResultTitle = "finished" | "finishedWithIssues" | "nothingRemoved";

export interface CleanResultSummary {
  /** Bytes of data removed according to per-candidate measurement. */
  removedBytes: number;
  removedUnknown: boolean;
  /** True when at least one successful outcome only has a scan estimate. */
  removedIsEstimate: boolean;
  /** Free-space gain on the volume, clamped at zero; null when not measured. */
  freeSpaceDelta: number | null;
  /** Free space grew substantially less than data removed. */
  spaceHeld: boolean;
  succeeded: number;
  partial: number;
  recreated: number;
  skipped: number;
  failed: number;
  hasIssues: boolean;
  title: CleanResultTitle;
}

/** Free space below this share of removed data triggers the explanation. */
export const SPACE_HELD_RATIO = 0.7;

const SUCCESS_STATUSES = new Set(["deleted", "completed", "partial", "recreated"]);

export function isSuccessfulOutcome(status: string) {
  return SUCCESS_STATUSES.has(status);
}

export function summarizeCleanResult(result: SummaryResult): CleanResultSummary {
  const outcomes = result.outcomes ?? [];
  const successful = outcomes.filter((outcome) => isSuccessfulOutcome(outcome.status));
  const counted = outcomes.length > 0;
  const succeeded = counted ? successful.length : result.deleted.length;
  const skipped = counted ? outcomes.filter((outcome) => outcome.status === "skipped").length : result.skipped.length;
  const failed = counted
    ? outcomes.filter((outcome) => outcome.status === "error" || outcome.status === "unknown").length
    : result.errors.length;
  const partial = outcomes.filter((outcome) => outcome.status === "partial").length;
  const recreated = outcomes.filter((outcome) => outcome.status === "recreated").length;
  const removedBytes = Math.max(0, result.freed);
  const rawDelta = result.free_space_delta;
  const freeSpaceDelta = typeof rawDelta === "number" && Number.isFinite(rawDelta) ? Math.max(0, rawDelta) : null;
  const spaceHeld = freeSpaceDelta !== null && removedBytes > 0 && freeSpaceDelta < removedBytes * SPACE_HELD_RATIO;
  const hasIssues = skipped > 0 || failed > 0 || Boolean(result.record_error);
  return {
    removedBytes,
    removedUnknown: result.freed_size_unknown,
    removedIsEstimate: successful.some((outcome) => outcome.measurement === "scanEstimate"),
    freeSpaceDelta,
    spaceHeld,
    succeeded,
    partial,
    recreated,
    skipped,
    failed,
    hasIssues,
    title: hasIssues ? "finishedWithIssues" : succeeded > 0 ? "finished" : "nothingRemoved",
  };
}
