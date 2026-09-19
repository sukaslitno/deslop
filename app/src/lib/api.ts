import { invoke } from "@tauri-apps/api/core";

export type Tier = "GREEN" | "YELLOW" | "RED";

export interface Entry {
  id: string;
  path: string;
  size: number;
  reason: string;
  restore: string | null;
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
  | "modelCaches";

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
  requires_yellow_confirmation: boolean;
}

export interface CandidateOutcome {
  id: string;
  path: string;
  status: "deleted" | "skipped" | "error";
  detail: string;
  freed: number;
}

export interface DiskInfo {
  total: number;
  free: number;
}

export interface CleanResult {
  run_id: string | null;
  record_error: string | null;
  freed: number;
  outcomes: CandidateOutcome[];
  deleted: string[];
  skipped: string[];
  errors: string[];
  reinstall: [string, string][];
}

export interface RunRecord {
  id: string;
  schema_version: number;
  policy_fingerprint: string;
  completed_at: number;
  freed: number;
  deleted: number;
  skipped: number;
  errors: number;
  outcomes: CandidateOutcome[];
}

export interface MapNode {
  id: string;
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  cleanup_rule_id: string | null;
  children: MapNode[];
}

export interface MapSnapshot {
  id: string;
  created_at: number;
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
