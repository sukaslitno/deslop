import { invoke } from "@tauri-apps/api/core";

export type Tier = "GREEN" | "YELLOW" | "RED";

export interface Entry {
  id: string;
  path: string;
  size: number;
  size_known: boolean;
  reason: string;
  scope: string;
  restore: string | null;
  /**
   * Optional per-entry tier. An entry may be stricter than its category
   * (e.g. Service Worker/CacheStorage is YELLOW inside a GREEN category).
   * Absent in older backends; the UI then falls back to the category tier.
   */
  tier?: Tier;
}

export interface Category {
  id: string;
  title: string;
  tier: Tier;
  note: string;
  manual: string | null;
  entries: Entry[];
  total: number;
}

export interface ScanSnapshot {
  id: string;
  policy_fingerprint: string;
  categories: Category[];
  skipped_roots: string[];
  breakdown: CleanupBreakdownSnapshot;
}

export type CleanupCategoryId =
  | "agentCaches"
  | "editorCaches"
  | "applicationCaches"
  | "packageCaches"
  | "developerCaches"
  | "modelCaches"
  | "projectArtifacts";

export interface CleanupBreakdownCategory {
  categoryId: CleanupCategoryId;
  candidateCount: number;
  measuredBytes: number;
}

export interface CleanupBreakdownSnapshot {
  snapshotId: string;
  volumeId: string;
  volumeCapacityBytes: number;
  volumeAvailableBytes: number;
  measurementKind: "allocated" | "logicalFallback";
  completedAt: number;
  scope: string;
  isPartial: boolean;
  skippedRoots: string[];
  categories: CleanupBreakdownCategory[];
}

export interface ScanJobStatus {
  id: string;
  phase: "running" | "cancelling" | "completed" | "cancelled" | "failed";
  completed_rules: number;
  total_rules: number;
  message: string;
  snapshot: ScanSnapshot | null;
  error: string | null;
}

export interface TreeJobStatus {
  id: string;
  phase: "running" | "cancelling" | "completed" | "cancelled" | "failed";
  visited_nodes: number;
  message: string;
  snapshot: MapSnapshot | null;
  error: string | null;
}

export interface Preflight {
  id: string;
  snapshot_id: string;
  entries: Entry[];
  total: number;
  yellow_count: number;
  warnings: string[];
  running_apps: string[];
  blocked_entries: Admission[];
  requires_yellow_confirmation: boolean;
}

export type AdmissionReasonCode =
  | "allowed"
  | "identity_or_scope_changed"
  | "excluded"
  | "manual_only"
  | "owner_running"
  | "singleton_lock_live"
  | "sqlite_in_use"
  | "process_probe_unavailable"
  | "process_probe_timeout"
  | "process_probe_unsupported"
  | "sqlite_probe_unavailable"
  | "sqlite_probe_timeout"
  | "lock_unreadable";

/**
 * Wire shape of `Admission`. The Rust struct is `#[serde(rename_all =
 * "camelCase")]`, so the reason code is serialised as `reasonCode`.
 */
export interface Admission {
  id: string;
  path: string;
  /** Display name of the owning application; empty when not known. */
  owner?: string;
  state: "allowed" | "busy" | "unknown" | "protected";
  /** Known codes are listed; unknown future codes still arrive as strings. */
  reasonCode: AdmissionReasonCode | (string & {});
  detail: string;
}

export type CandidateOutcomeStatus =
  | "deleted"
  | "completed"
  | "partial"
  | "recreated"
  | "skipped"
  | "error"
  | "unknown";

export interface CandidateOutcome {
  id: string;
  path: string;
  status: CandidateOutcomeStatus;
  detail: string;
  freed: number;
  /** Bytes still present after a partial removal. */
  remaining?: number;
  measurement?: "allocated" | "scanEstimate" | "unknown";
  /** Admission reason for skipped outcomes; `allowed` when the effect was attempted. */
  reason_code?: string;
  owner?: string;
}

export interface DiskInfo {
  total: number;
  free: number;
}

export interface CleanResult {
  run_id: string | null;
  record_error: string | null;
  freed: number;
  freed_size_unknown: boolean;
  outcomes: CandidateOutcome[];
  deleted: string[];
  skipped: string[];
  errors: string[];
  reinstall: [string, string][];
  /** Volume free space before/after the run; null when it could not be measured. */
  free_space_before?: number | null;
  free_space_after?: number | null;
  free_space_delta?: number | null;
}

export interface RunRecord {
  id: string;
  schema_version: number;
  policy_fingerprint: string;
  started_at: number;
  completed_at: number;
  status: "completed" | "interrupted" | "running";
  freed: number;
  freed_size_unknown: boolean;
  deleted: number;
  skipped: number;
  errors: number;
  outcomes: CandidateOutcome[];
}

export interface CleanupExclusion {
  id: string;
  ruleId: string;
  owner: string;
  path: string;
  createdAt: number;
}

export interface MapNode {
  id: string;
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  can_reveal: boolean;
  cleanup_rule_id: string | null;
  children: MapNode[];
}

export interface MapSnapshot {
  id: string;
  created_at: number;
  is_partial: boolean;
  skipped_nodes: number;
  root: MapNode;
}

export interface ExternalLinkAvailability {
  kind: "github_repository" | "github_star" | "buy_me_a_coffee" | "telegram_channel" | "beta_testers_chat";
  available: boolean;
}

export interface AppInfo {
  name: string;
  version: string;
  build: string;
  license: string;
}

export type SupportedLocale = "en" | "ru";
export type Appearance = "system" | "light" | "dark";
export type SafeCandidateSelection = "automatic" | "manual";
export type SizeUnits = "binary" | "decimal";

export interface AppPreferences {
  schemaVersion: number;
  locale: SupportedLocale;
  appearance: Appearance;
  safeCandidateSelection: SafeCandidateSelection;
  sizeUnits: SizeUnits;
  rememberLastMapFolder: boolean;
  lastMapFolder: string | null;
}

export interface PreferencesResponse {
  preferences: AppPreferences;
  hasPersistedPreferences: boolean;
}

export interface AppPreferencesPatch {
  locale?: SupportedLocale;
  appearance?: Appearance;
  safeCandidateSelection?: SafeCandidateSelection;
  sizeUnits?: SizeUnits;
  rememberLastMapFolder?: boolean;
  lastMapFolder?: string;
}

export interface FeatureCapability {
  feature_id: string;
  access_class: "core_free" | "planned_paid";
  availability: "available" | "experimental" | "unavailable";
  entitlement: "free" | "unavailable";
}

export interface EntitlementResponse {
  mode: "open_preview" | "enforced";
  features: FeatureCapability[];
}

export const api = {
  defaultRoots: () => invoke<string[]>("default_roots"),
  diskInfo: () => invoke<DiskInfo>("disk_info"),
  scan: (roots: string[], only?: string[]) =>
    invoke<ScanSnapshot>("scan", { roots, only: only ?? null }),
  startScan: (roots: string[], only?: string[]) =>
    invoke<ScanJobStatus>("start_scan", { roots, only: only ?? null }),
  scanJobStatus: (id: string) => invoke<ScanJobStatus>("scan_job_status", { id }),
  cancelScan: (id: string) => invoke<ScanJobStatus>("cancel_scan", { id }),
  preflight: (snapshotId: string, candidateIds: string[]) =>
    invoke<Preflight>("preflight", { snapshotId, candidateIds }),
  clean: (preflightId: string, confirmYellow: boolean) =>
    invoke<CleanResult>("clean", { preflightId, confirmYellow }),
  runHistory: () => invoke<RunRecord[]>("run_history"),
  cleanupExclusions: () => invoke<CleanupExclusion[]>("cleanup_exclusions"),
  addCleanupExclusion: (snapshotId: string, candidateId: string) =>
    invoke<CleanupExclusion[]>("add_cleanup_exclusion", { snapshotId, candidateId }),
  removeCleanupExclusion: (exclusionId: string) =>
    invoke<CleanupExclusion[]>("remove_cleanup_exclusion", { exclusionId }),
  getPreferences: () => invoke<PreferencesResponse>("get_preferences"),
  updatePreferences: (patch: AppPreferencesPatch) =>
    invoke<AppPreferences>("update_preferences", { patch }),
  resetPreferences: () => invoke<AppPreferences>("reset_preferences"),
  homeDir: () => invoke<string>("home_dir"),
  startTreeScan: (root: string, maxDepth?: number, minSize?: number) =>
    invoke<TreeJobStatus>("start_tree_scan", {
      root,
      maxDepth: maxDepth ?? null,
      minSize: minSize ?? null,
    }),
  treeJobStatus: (id: string) => invoke<TreeJobStatus>("tree_job_status", { id }),
  cancelTreeScan: (id: string) => invoke<TreeJobStatus>("cancel_tree_scan", { id }),
  revealMapNode: (snapshotId: string, nodeId: string) =>
    invoke<void>("reveal_map_node", { snapshotId, nodeId }),
  externalLinkAvailability: () =>
    invoke<ExternalLinkAvailability[]>("external_link_availability"),
  openExternalLink: (kind: ExternalLinkAvailability["kind"]) =>
    invoke<void>("open_external_link", { kind }),
  entitlements: () => invoke<EntitlementResponse>("entitlements"),
  appInfo: () => invoke<AppInfo>("app_info"),
};
