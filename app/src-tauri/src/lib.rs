//! Deslop backend — a fail-closed, snapshot-based cleanup engine.
//!
//! The WebView never supplies paths to `clean`.  A scan creates immutable
//! candidates in backend state; preflight locks an exact selection from that
//! snapshot; clean revalidates identity immediately before every deletion.

mod rules;

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const POLICY_FINGERPRINT: &str = "2026-07-27-snapshot-v1";
const PROTECTED_SUFFIXES: &[&[&str]] = &[
    &[".claude", "projects"],
    &[".claude", "todos"],
    &[".claude", "file-history"],
    &[".codex", "sessions"],
];
const NEVER_NAMES: &[&str] = &[
    ".git",
    ".env",
    ".env.local",
    ".env.production",
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "bun.lockb",
    "Cargo.toml",
    "Cargo.lock",
    "Podfile",
    "requirements.txt",
    "pyproject.toml",
    "CLAUDE.md",
    "settings.json",
    "settings.local.json",
    ".credentials.json",
    "config.toml",
    "auth.json",
];

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
enum Tier {
    Green,
    Yellow,
    Red,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::enum_variant_names)]
enum CleanupCategoryId {
    AgentCaches,
    EditorCaches,
    ApplicationCaches,
    PackageCaches,
    DeveloperCaches,
    ModelCaches,
}

#[derive(Clone, Copy)]
struct Rule {
    id: &'static str,
    title: &'static str,
    tier: Tier,
    cleanup_category: CleanupCategoryId,
    note: &'static str,
    restore: Option<&'static str>,
}

// Every enabled rule below resolves an exact, owned cache location.  Project
// output names (build/dist/target/etc.) are intentionally absent until they
// have a project-aware rule and fixture coverage.
const RULES: &[Rule] = &[
    Rule { id: "claude", title: "Claude Code cache", tier: Tier::Green, cleanup_category: CleanupCategoryId::AgentCaches, note: "Only shell snapshots, logs and statsig. Projects, memory, todos and file history stay protected.", restore: None },
    Rule { id: "codex", title: "Codex logs and runtimes", tier: Tier::Yellow, cleanup_category: CleanupCategoryId::AgentCaches, note: "Rollout sessions are protected. Runtimes download again on demand.", restore: Some("Run Codex again to download required runtimes.") },
    Rule { id: "editors", title: "Cursor / VS Code caches", tier: Tier::Green, cleanup_category: CleanupCategoryId::EditorCaches, note: "Exact render caches only; settings and extensions are not selected.", restore: None },
    Rule { id: "appcache", title: "Known app caches", tier: Tier::Green, cleanup_category: CleanupCategoryId::ApplicationCaches, note: "Exact application cache roots only; logins, cookies, local storage and sessions are not selected.", restore: None },
    Rule { id: "pkg", title: "Package caches", tier: Tier::Green, cleanup_category: CleanupCategoryId::PackageCaches, note: "Exact package-manager cache roots; projects are not selected.", restore: None },
    Rule { id: "xcode", title: "Xcode caches", tier: Tier::Green, cleanup_category: CleanupCategoryId::DeveloperCaches, note: "Derived data and simulator cache are rebuilt by Xcode.", restore: None },
    Rule { id: "hf", title: "Hugging Face cache", tier: Tier::Yellow, cleanup_category: CleanupCategoryId::ModelCaches, note: "Models and datasets will download again when used.", restore: Some("Re-run the model or dataset download.") },
];

#[derive(Clone, Serialize)]
struct Entry {
    id: String,
    path: String,
    size: u64,
    reason: String,
    restore: Option<String>,
}

#[derive(Clone, Serialize)]
struct Category {
    id: String,
    title: String,
    tier: Tier,
    note: String,
    manual: Option<String>,
    entries: Vec<Entry>,
    total: u64,
}

#[derive(Clone, Serialize)]
struct ScanSnapshot {
    id: String,
    policy_fingerprint: String,
    categories: Vec<Category>,
    skipped_roots: Vec<String>,
    breakdown: CleanupBreakdownSnapshot,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupBreakdownCategory {
    category_id: CleanupCategoryId,
    candidate_count: usize,
    measured_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupBreakdownSnapshot {
    snapshot_id: String,
    volume_id: String,
    volume_capacity_bytes: u64,
    volume_available_bytes: u64,
    measurement_kind: String,
    completed_at: u64,
    scope: String,
    is_partial: bool,
    skipped_roots: Vec<String>,
    categories: Vec<CleanupBreakdownCategory>,
}

#[derive(Clone, PartialEq, Eq)]
struct FileIdentity {
    dev: u64,
    ino: u64,
    is_dir: bool,
}

#[cfg(unix)]
fn file_identity(meta: &fs::Metadata) -> FileIdentity {
    use std::os::unix::fs::MetadataExt;
    FileIdentity {
        dev: meta.dev(),
        ino: meta.ino(),
        is_dir: meta.is_dir(),
    }
}

#[cfg(not(unix))]
fn file_identity(meta: &fs::Metadata) -> FileIdentity {
    FileIdentity {
        dev: 0,
        ino: 0,
        is_dir: meta.is_dir(),
    }
}

#[derive(Clone)]
struct CandidateInternal {
    id: String,
    snapshot_id: String,
    rule_id: String,
    tier: Tier,
    canonical_path: PathBuf,
    identity: FileIdentity,
    size: u64,
    restore: Option<String>,
    policy_fingerprint: String,
}

struct SnapshotInternal {
    candidates: BTreeMap<String, CandidateInternal>,
}
struct PreflightInternal {
    snapshot_id: String,
    candidate_ids: BTreeSet<String>,
}

struct EngineState {
    home: PathBuf,
    snapshots: BTreeMap<String, SnapshotInternal>,
    preflights: BTreeMap<String, PreflightInternal>,
    counter: AtomicU64,
}

impl EngineState {
    fn new(home: PathBuf) -> Self {
        Self {
            home,
            snapshots: BTreeMap::new(),
            preflights: BTreeMap::new(),
            counter: AtomicU64::new(1),
        }
    }
    fn next_id(&self, kind: &str) -> String {
        format!("{kind}-{}", self.counter.fetch_add(1, Ordering::Relaxed))
    }
}

#[derive(Clone, Serialize)]
struct ScanJobStatus {
    id: String,
    phase: String,
    completed_rules: usize,
    total_rules: usize,
    message: String,
    snapshot: Option<ScanSnapshot>,
    error: Option<String>,
}

struct ScanJobInternal {
    status: ScanJobStatus,
    cancel: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
struct TreeJobStatus {
    id: String,
    phase: String,
    visited_nodes: usize,
    message: String,
    snapshot: Option<MapSnapshot>,
    error: Option<String>,
}

struct TreeJobInternal {
    status: TreeJobStatus,
    cancel: Arc<AtomicBool>,
}

struct AppState {
    engine: Arc<Mutex<EngineState>>,
    scan_jobs: Arc<Mutex<BTreeMap<String, ScanJobInternal>>>,
    tree_jobs: Arc<Mutex<BTreeMap<String, TreeJobInternal>>>,
    map_snapshots: Arc<Mutex<BTreeMap<String, MapSnapshotInternal>>>,
    next_job: AtomicU64,
}

fn canonical_home_from(value: Option<PathBuf>) -> Result<PathBuf, String> {
    let raw = value
        .ok_or_else(|| "HOME is unavailable; cleanup is disabled (fail closed)".to_string())?;
    let canonical = raw
        .canonicalize()
        .map_err(|e| format!("HOME cannot be canonicalized; cleanup is disabled: {e}"))?;
    if !canonical.is_dir() {
        return Err("HOME is not a directory; cleanup is disabled".into());
    }
    Ok(canonical)
}

fn canonical_home() -> Result<PathBuf, String> {
    canonical_home_from(std::env::var_os("HOME").map(PathBuf::from))
}

fn expand_under_home(input: &str, home: &Path) -> PathBuf {
    input
        .strip_prefix("~/")
        .map(|rest| home.join(rest))
        .unwrap_or_else(|| {
            if input == "~" {
                home.to_path_buf()
            } else {
                PathBuf::from(input)
            }
        })
}

fn is_protected(path: &Path) -> bool {
    let parts: Vec<&str> = path
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect();
    PROTECTED_SUFFIXES
        .iter()
        .any(|needle| parts.windows(needle.len()).any(|window| window == *needle))
}

fn canonical_roots(roots: &[String], home: &Path) -> (Vec<PathBuf>, Vec<String>) {
    let mut canonical = BTreeSet::new();
    let mut skipped = Vec::new();
    for root in roots {
        let expanded = expand_under_home(root, home);
        match expanded.canonicalize() {
            Ok(path) if path.is_dir() && path.starts_with(home) && !is_protected(&path) => {
                canonical.insert(path);
            }
            Ok(_) => skipped.push(format!(
                "{root}: outside HOME, protected, or not a directory"
            )),
            Err(_) => skipped.push(format!("{root}: unavailable or cannot be canonicalized")),
        }
    }
    let all: Vec<PathBuf> = canonical.into_iter().collect();
    let roots = all
        .iter()
        .filter(|candidate| {
            !all.iter()
                .any(|other| other != *candidate && candidate.starts_with(other))
        })
        .cloned()
        .collect();
    (roots, skipped)
}

fn safe_metadata(path: &Path) -> Result<(PathBuf, fs::Metadata), String> {
    let link = fs::symlink_metadata(path).map_err(|e| format!("metadata failed: {e}"))?;
    if link.file_type().is_symlink() {
        return Err("symlink".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("canonicalize failed: {e}"))?;
    let meta =
        fs::symlink_metadata(&canonical).map_err(|e| format!("canonical metadata failed: {e}"))?;
    if meta.file_type().is_symlink() {
        return Err("symlink".into());
    }
    Ok((canonical, meta))
}

fn du_bytes(path: &Path) -> u64 {
    if let Ok(out) = Command::new("du").arg("-sk").arg(path).output() {
        if out.status.success() {
            if let Ok(s) = String::from_utf8(out.stdout) {
                if let Some(Ok(kb)) = s.split_whitespace().next().map(str::parse::<u64>) {
                    return kb * 1024;
                }
            }
        }
    }
    walk_size(path)
}

fn walk_size(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.file_type().is_symlink() {
        return 0;
    }
    if meta.is_file() {
        return meta.len();
    }
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| walk_size(&entry.path()))
        .sum()
}

fn add_candidate(
    state: &EngineState,
    snapshot_id: &str,
    rule: Rule,
    path: PathBuf,
    candidates: &mut BTreeMap<String, CandidateInternal>,
) {
    let Ok((canonical_path, meta)) = safe_metadata(&path) else {
        return;
    };
    if !canonical_path.starts_with(&state.home) || is_protected(&canonical_path) {
        return;
    }
    let name = canonical_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if NEVER_NAMES.contains(&name) {
        return;
    }
    if candidates
        .values()
        .any(|c| c.canonical_path == canonical_path)
    {
        return;
    }
    let id = state.next_id("candidate");
    candidates.insert(
        id.clone(),
        CandidateInternal {
            id,
            snapshot_id: snapshot_id.into(),
            rule_id: rule.id.into(),
            tier: rule.tier,
            canonical_path,
            identity: file_identity(&meta),
            size: du_bytes(&path),
            restore: rule.restore.map(str::to_string),
            policy_fingerprint: POLICY_FINGERPRINT.into(),
        },
    );
}

fn rule_for_id(rule_id: &str) -> Option<Rule> {
    RULES.iter().copied().find(|rule| rule.id == rule_id)
}

#[cfg(unix)]
fn logical_bytes_with_dedupe(path: &Path, seen: &mut BTreeSet<(u64, u64)>) -> u64 {
    use std::os::unix::fs::MetadataExt;
    let Ok(meta) = fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.file_type().is_symlink() {
        return 0;
    }
    if meta.is_file() {
        return if seen.insert((meta.dev(), meta.ino())) {
            meta.len()
        } else {
            0
        };
    }
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| logical_bytes_with_dedupe(&entry.path(), seen))
        .sum()
}

#[cfg(not(unix))]
fn logical_bytes_with_dedupe(path: &Path, seen: &mut BTreeSet<PathBuf>) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.file_type().is_symlink() {
        return 0;
    }
    if meta.is_file() {
        return if seen.insert(path.to_path_buf()) {
            meta.len()
        } else {
            0
        };
    }
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| logical_bytes_with_dedupe(&entry.path(), seen))
        .sum()
}

fn current_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn cleanup_breakdown_snapshot(
    snapshot_id: &str,
    home: &Path,
    candidates: &BTreeMap<String, CandidateInternal>,
    skipped_roots: &[String],
) -> CleanupBreakdownSnapshot {
    let mut selected: Vec<&CandidateInternal> = candidates
        .values()
        .filter(|candidate| validate_candidate(candidate, home).is_ok())
        .collect();
    let invalid_candidates = candidates.len().saturating_sub(selected.len());
    selected.sort_by(|left, right| {
        left.canonical_path
            .components()
            .count()
            .cmp(&right.canonical_path.components().count())
            .then_with(|| left.canonical_path.cmp(&right.canonical_path))
    });
    let mut accepted_roots = Vec::<&CandidateInternal>::new();
    for candidate in selected {
        if !accepted_roots
            .iter()
            .any(|root| candidate.canonical_path.starts_with(&root.canonical_path))
        {
            accepted_roots.push(candidate);
        }
    }
    let mut totals = BTreeMap::<CleanupCategoryId, (usize, u64)>::new();
    #[cfg(unix)]
    let mut seen = BTreeSet::<(u64, u64)>::new();
    #[cfg(not(unix))]
    let mut seen = BTreeSet::<PathBuf>::new();
    for candidate in accepted_roots {
        let Some(rule) = rule_for_id(&candidate.rule_id) else {
            continue;
        };
        let measured = logical_bytes_with_dedupe(&candidate.canonical_path, &mut seen);
        let total = totals.entry(rule.cleanup_category).or_insert((0, 0));
        total.0 += 1;
        total.1 += measured;
    }
    let volume = volume_stats(home);
    CleanupBreakdownSnapshot {
        snapshot_id: snapshot_id.into(),
        volume_id: volume.id,
        volume_capacity_bytes: volume.total,
        volume_available_bytes: volume.free,
        measurement_kind: "logicalFallback".into(),
        completed_at: current_unix_seconds(),
        scope: "exactRuleEngineHome".into(),
        is_partial: !skipped_roots.is_empty() || invalid_candidates > 0,
        skipped_roots: skipped_roots.to_vec(),
        categories: totals
            .into_iter()
            .map(
                |(category_id, (candidate_count, measured_bytes))| CleanupBreakdownCategory {
                    category_id,
                    candidate_count,
                    measured_bytes,
                },
            )
            .collect(),
    }
}

fn scan_snapshot(
    state: &mut EngineState,
    roots: &[String],
    only: Option<Vec<String>>,
) -> ScanSnapshot {
    let cancelled = AtomicBool::new(false);
    scan_snapshot_with_progress(state, roots, only, &cancelled, |_, _, _| {})
        .expect("in-memory scan cannot be cancelled")
}

fn scan_snapshot_with_progress<F>(
    state: &mut EngineState,
    roots: &[String],
    only: Option<Vec<String>>,
    cancelled: &AtomicBool,
    mut progress: F,
) -> Result<ScanSnapshot, String>
where
    F: FnMut(usize, usize, String),
{
    let snapshot_id = state.next_id("snapshot");
    let (_, skipped_roots) = canonical_roots(roots, &state.home); // root input is validated but is not a delete authority.
    let wanted: Option<BTreeSet<String>> = only.map(|items| items.into_iter().collect());
    let mut candidates = BTreeMap::new();
    let selected_rules: Vec<Rule> = RULES
        .iter()
        .copied()
        .filter(|rule| wanted.as_ref().is_none_or(|items| items.contains(rule.id)))
        .collect();
    let total_rules = selected_rules.len();
    for (index, rule) in selected_rules.into_iter().enumerate() {
        if cancelled.load(Ordering::Relaxed) {
            return Err("scan cancelled".into());
        }
        progress(index, total_rules, format!("Scanning {}", rule.title));
        for path in rules::paths_for(rule.id, &state.home) {
            if cancelled.load(Ordering::Relaxed) {
                return Err("scan cancelled".into());
            }
            add_candidate(state, &snapshot_id, rule, path, &mut candidates);
        }
        progress(index + 1, total_rules, format!("Scanned {}", rule.title));
    }
    let mut categories = Vec::new();
    for rule in RULES {
        let mut entries: Vec<Entry> = candidates
            .values()
            .filter(|candidate| candidate.rule_id == rule.id)
            .map(|candidate| Entry {
                id: candidate.id.clone(),
                path: candidate.canonical_path.to_string_lossy().to_string(),
                size: candidate.size,
                reason: rule.note.into(),
                restore: candidate.restore.clone(),
            })
            .collect();
        entries.sort_by(|a, b| b.size.cmp(&a.size));
        let total = entries.iter().map(|entry| entry.size).sum();
        if !entries.is_empty() {
            categories.push(Category {
                id: rule.id.into(),
                title: rule.title.into(),
                tier: rule.tier,
                note: rule.note.into(),
                manual: rule.restore.map(str::to_string),
                entries,
                total,
            });
        }
    }
    let breakdown =
        cleanup_breakdown_snapshot(&snapshot_id, &state.home, &candidates, &skipped_roots);
    state
        .snapshots
        .insert(snapshot_id.clone(), SnapshotInternal { candidates });
    Ok(ScanSnapshot {
        id: snapshot_id,
        policy_fingerprint: POLICY_FINGERPRINT.into(),
        categories,
        skipped_roots,
        breakdown,
    })
}

fn validate_candidate(candidate: &CandidateInternal, home: &Path) -> Result<(), String> {
    if candidate.policy_fingerprint != POLICY_FINGERPRINT {
        return Err("policy changed since scan".into());
    }
    if candidate.snapshot_id.is_empty() || candidate.rule_id.is_empty() {
        return Err("invalid snapshot candidate".into());
    }
    let (canonical, meta) = safe_metadata(&candidate.canonical_path)?;
    if canonical != candidate.canonical_path {
        return Err("path changed since scan".into());
    }
    if !canonical.starts_with(home) || is_protected(&canonical) {
        return Err("outside safe HOME policy or protected".into());
    }
    let name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if NEVER_NAMES.contains(&name) {
        return Err("protected name".into());
    }
    let current = file_identity(&meta);
    if current.dev != candidate.identity.dev
        || current.ino != candidate.identity.ino
        || current.is_dir != candidate.identity.is_dir
    {
        return Err("file identity changed since scan".into());
    }
    Ok(())
}

#[derive(Serialize)]
struct Preflight {
    id: String,
    snapshot_id: String,
    entries: Vec<Entry>,
    total: u64,
    yellow_count: usize,
    warnings: Vec<String>,
    running_apps: Vec<String>,
    requires_yellow_confirmation: bool,
}

#[derive(Clone, Deserialize, Serialize)]
struct CandidateOutcome {
    id: String,
    path: String,
    status: String,
    detail: String,
    freed: u64,
}

#[derive(Serialize)]
struct CleanResult {
    run_id: Option<String>,
    record_error: Option<String>,
    freed: u64,
    outcomes: Vec<CandidateOutcome>,
    deleted: Vec<String>,
    skipped: Vec<String>,
    errors: Vec<String>,
    reinstall: Vec<(String, String)>,
}

#[derive(Clone, Deserialize, Serialize)]
struct RunRecord {
    id: String,
    schema_version: u8,
    policy_fingerprint: String,
    completed_at: u64,
    freed: u64,
    deleted: usize,
    skipped: usize,
    errors: usize,
    outcomes: Vec<CandidateOutcome>,
}

fn runs_dir(home: &Path) -> PathBuf {
    home.join("Library/Application Support/Deslop/runs")
}

fn save_run_record(home: &Path, result: &CleanResult) -> Result<String, String> {
    let completed_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let id = format!("run-{completed_at}-{}", result.outcomes.len());
    let record = RunRecord {
        id: id.clone(),
        schema_version: 1,
        policy_fingerprint: POLICY_FINGERPRINT.into(),
        completed_at,
        freed: result.freed,
        deleted: result.deleted.len(),
        skipped: result.skipped.len(),
        errors: result.errors.len(),
        outcomes: result.outcomes.clone(),
    };
    let directory = runs_dir(home);
    fs::create_dir_all(&directory).map_err(|e| format!("cannot create run history: {e}"))?;
    let encoded = serde_json::to_vec_pretty(&record).map_err(|e| e.to_string())?;
    fs::write(directory.join(format!("{id}.json")), encoded)
        .map_err(|e| format!("cannot write run history: {e}"))?;
    Ok(id)
}

fn load_run_history(home: &Path) -> Vec<RunRecord> {
    let mut records: Vec<RunRecord> = fs::read_dir(runs_dir(home))
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| fs::read(entry.path()).ok())
        .filter_map(|bytes| serde_json::from_slice(&bytes).ok())
        .collect();
    records.sort_by(|a, b| b.completed_at.cmp(&a.completed_at));
    records.truncate(20);
    records
}

#[derive(Serialize)]
struct DiskInfo {
    total: u64,
    free: u64,
}

struct VolumeStats {
    id: String,
    total: u64,
    free: u64,
}

fn volume_stats(path: &Path) -> VolumeStats {
    if let Ok(out) = Command::new("df").arg("-k").arg(path).output() {
        if let Ok(text) = String::from_utf8(out.stdout) {
            if let Some(line) = text.lines().nth(1) {
                let fields: Vec<&str> = line.split_whitespace().collect();
                if fields.len() >= 4 {
                    return VolumeStats {
                        id: fields[0].into(),
                        total: fields[1].parse::<u64>().unwrap_or(0) * 1024,
                        free: fields[3].parse::<u64>().unwrap_or(0) * 1024,
                    };
                }
            }
        }
    }
    VolumeStats {
        id: "unknown".into(),
        total: 0,
        free: 0,
    }
}

#[tauri::command]
fn default_roots(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let state = state
        .engine
        .lock()
        .map_err(|_| "engine state unavailable")?;
    let home = &state.home;
    let raw: Vec<String> = [
        "Documents",
        "Documents/VIBE BUILD",
        "Developer",
        "code",
        "Projects",
    ]
    .iter()
    .map(|part| home.join(part).to_string_lossy().to_string())
    .collect();
    let (roots, _) = canonical_roots(&raw, home);
    Ok(roots
        .into_iter()
        .map(|root| root.to_string_lossy().to_string())
        .collect())
}

#[tauri::command]
fn home_dir(state: tauri::State<'_, AppState>) -> Result<String, String> {
    Ok(state
        .engine
        .lock()
        .map_err(|_| "engine state unavailable")?
        .home
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
fn disk_info(state: tauri::State<'_, AppState>) -> Result<DiskInfo, String> {
    let home = state
        .engine
        .lock()
        .map_err(|_| "engine state unavailable")?
        .home
        .clone();
    let volume = volume_stats(&home);
    Ok(DiskInfo {
        total: volume.total,
        free: volume.free,
    })
}

#[tauri::command]
fn scan(
    state: tauri::State<'_, AppState>,
    roots: Vec<String>,
    only: Option<Vec<String>>,
) -> Result<ScanSnapshot, String> {
    let mut state = state
        .engine
        .lock()
        .map_err(|_| "engine state unavailable")?;
    Ok(scan_snapshot(&mut state, &roots, only))
}

/// Start an exact-rule scan off the command thread. Progress is intentionally
/// coarse (rule granularity) so it never exposes arbitrary filesystem paths.
#[tauri::command]
fn start_scan(
    state: tauri::State<'_, AppState>,
    roots: Vec<String>,
    only: Option<Vec<String>>,
) -> Result<ScanJobStatus, String> {
    let id = format!(
        "scan-job-{}",
        state.next_job.fetch_add(1, Ordering::Relaxed)
    );
    let cancel = Arc::new(AtomicBool::new(false));
    let initial = ScanJobStatus {
        id: id.clone(),
        phase: "running".into(),
        completed_rules: 0,
        total_rules: 0,
        message: "Preparing safe scan".into(),
        snapshot: None,
        error: None,
    };
    state
        .scan_jobs
        .lock()
        .map_err(|_| "job state unavailable")?
        .insert(
            id.clone(),
            ScanJobInternal {
                status: initial.clone(),
                cancel: cancel.clone(),
            },
        );
    let engine = state.engine.clone();
    let jobs = state.scan_jobs.clone();
    std::thread::spawn(move || {
        let progress_jobs = jobs.clone();
        let progress_id = id.clone();
        let result = match engine.lock() {
            Ok(mut engine) => scan_snapshot_with_progress(
                &mut engine,
                &roots,
                only,
                &cancel,
                |completed, total, message| {
                    if let Ok(mut jobs) = progress_jobs.lock() {
                        if let Some(job) = jobs.get_mut(&progress_id) {
                            job.status.completed_rules = completed;
                            job.status.total_rules = total;
                            job.status.message = message;
                        }
                    }
                },
            ),
            Err(_) => Err("engine state unavailable".into()),
        };
        if let Ok(mut jobs) = jobs.lock() {
            if let Some(job) = jobs.get_mut(&id) {
                match result {
                    Ok(snapshot) => {
                        job.status.phase = "completed".into();
                        job.status.completed_rules = job.status.total_rules;
                        job.status.message = "Scan complete".into();
                        job.status.snapshot = Some(snapshot);
                    }
                    Err(error) if error == "scan cancelled" => {
                        job.status.phase = "cancelled".into();
                        job.status.message = "Scan cancelled; no snapshot was created".into();
                    }
                    Err(error) => {
                        job.status.phase = "failed".into();
                        job.status.error = Some(error);
                        job.status.message = "Scan failed".into();
                    }
                }
            }
        }
    });
    Ok(initial)
}

#[tauri::command]
fn scan_job_status(state: tauri::State<'_, AppState>, id: String) -> Result<ScanJobStatus, String> {
    state
        .scan_jobs
        .lock()
        .map_err(|_| "job state unavailable")?
        .get(&id)
        .map(|job| job.status.clone())
        .ok_or("scan job not found".into())
}

#[tauri::command]
fn cancel_scan(state: tauri::State<'_, AppState>, id: String) -> Result<ScanJobStatus, String> {
    let mut jobs = state
        .scan_jobs
        .lock()
        .map_err(|_| "job state unavailable")?;
    let job = jobs.get_mut(&id).ok_or("scan job not found")?;
    if job.status.phase == "running" {
        job.cancel.store(true, Ordering::Relaxed);
        job.status.phase = "cancelling".into();
        job.status.message = "Cancelling after the current safe operation".into();
    }
    Ok(job.status.clone())
}

#[tauri::command]
fn preflight(
    state: tauri::State<'_, AppState>,
    snapshot_id: String,
    candidate_ids: Vec<String>,
) -> Result<Preflight, String> {
    let mut state = state
        .engine
        .lock()
        .map_err(|_| "engine state unavailable")?;
    create_preflight(&mut state, snapshot_id, candidate_ids)
}

fn create_preflight(
    state: &mut EngineState,
    snapshot_id: String,
    candidate_ids: Vec<String>,
) -> Result<Preflight, String> {
    if candidate_ids.is_empty() {
        return Err("select at least one scanned entry".into());
    }
    let supplied_count = candidate_ids.len();
    let requested: BTreeSet<String> = candidate_ids.into_iter().collect();
    let snapshot = state
        .snapshots
        .get(&snapshot_id)
        .ok_or("scan snapshot is unavailable; rescan before cleaning")?;
    if requested.len() != supplied_count {
        return Err("duplicate candidate ids".into());
    }
    let mut entries = Vec::new();
    let mut warnings = Vec::new();
    let mut running_apps = BTreeSet::new();
    let mut yellow_count = 0;
    for id in &requested {
        let candidate = snapshot
            .candidates
            .get(id)
            .ok_or_else(|| format!("candidate {id} was not in this snapshot"))?;
        if candidate.tier == Tier::Red {
            return Err("RED candidates are manual-only".into());
        }
        if candidate.tier == Tier::Yellow {
            yellow_count += 1;
        }
        for app in running_apps_for_rule(&candidate.rule_id) {
            running_apps.insert(app);
        }
        if let Err(reason) = validate_candidate(candidate, &state.home) {
            warnings.push(format!("{}: {reason}", candidate.canonical_path.display()));
        }
        entries.push(Entry {
            id: candidate.id.clone(),
            path: candidate.canonical_path.to_string_lossy().to_string(),
            size: candidate.size,
            reason: "Validated against the scan snapshot immediately before cleaning.".into(),
            restore: candidate.restore.clone(),
        });
    }
    if !warnings.is_empty() {
        return Err(format!(
            "preflight rejected stale or unsafe entries: {}",
            warnings.join("; ")
        ));
    }
    let id = state.next_id("preflight");
    state.preflights.insert(
        id.clone(),
        PreflightInternal {
            snapshot_id: snapshot_id.clone(),
            candidate_ids: requested,
        },
    );
    let total = entries.iter().map(|entry| entry.size).sum();
    Ok(Preflight {
        id,
        snapshot_id,
        entries,
        total,
        yellow_count,
        warnings,
        running_apps: running_apps.into_iter().collect(),
        requires_yellow_confirmation: yellow_count > 0,
    })
}

fn running_apps_for_rule(rule_id: &str) -> Vec<String> {
    let processes: &[&str] = match rule_id {
        "editors" => &["Cursor", "Code"],
        "appcache" => &[
            "Slack", "Figma", "Arc", "Claude", "Codex", "ChatGPT", "Lark",
        ],
        "xcode" => &["Xcode", "Simulator"],
        _ => &[],
    };
    processes
        .iter()
        .filter(|name| {
            Command::new("pgrep")
                .arg("-x")
                .arg(name)
                .output()
                .is_ok_and(|output| output.status.success())
        })
        .map(|name| (*name).to_string())
        .collect()
}

#[tauri::command]
async fn clean(
    state: tauri::State<'_, AppState>,
    preflight_id: String,
    confirm_yellow: bool,
) -> Result<CleanResult, String> {
    let mut state = state
        .engine
        .lock()
        .map_err(|_| "engine state unavailable")?;
    clean_engine(&mut state, preflight_id, confirm_yellow)
}

fn clean_engine(
    state: &mut EngineState,
    preflight_id: String,
    confirm_yellow: bool,
) -> Result<CleanResult, String> {
    let preflight = state
        .preflights
        .remove(&preflight_id)
        .ok_or("preflight is unavailable or already used")?;
    let snapshot = state
        .snapshots
        .get(&preflight.snapshot_id)
        .ok_or("scan snapshot is unavailable; rescan before cleaning")?;
    let has_yellow = preflight.candidate_ids.iter().any(|id| {
        snapshot
            .candidates
            .get(id)
            .is_some_and(|candidate| candidate.tier == Tier::Yellow)
    });
    if has_yellow && !confirm_yellow {
        return Err("YELLOW entries require explicit preflight confirmation".into());
    }
    let mut freed = 0;
    let mut outcomes = Vec::new();
    let mut deleted = Vec::new();
    let mut skipped = Vec::new();
    let mut errors = Vec::new();
    let mut reinstall = BTreeMap::new();
    for id in &preflight.candidate_ids {
        let Some(candidate) = snapshot.candidates.get(id) else {
            continue;
        };
        let path = candidate.canonical_path.clone();
        match validate_candidate(candidate, &state.home) {
            Err(detail) => {
                skipped.push(format!("{} — {detail}", path.display()));
                outcomes.push(CandidateOutcome {
                    id: id.clone(),
                    path: path.to_string_lossy().to_string(),
                    status: "skipped".into(),
                    detail,
                    freed: 0,
                });
            }
            Ok(()) => {
                let bytes = du_bytes(&path);
                let result = if candidate.identity.is_dir {
                    fs::remove_dir_all(&path)
                } else {
                    fs::remove_file(&path)
                };
                match result {
                    Ok(()) => {
                        freed += bytes;
                        deleted.push(path.to_string_lossy().to_string());
                        if let Some(hint) = &candidate.restore {
                            reinstall.insert(path.to_string_lossy().to_string(), hint.clone());
                        }
                        outcomes.push(CandidateOutcome {
                            id: id.clone(),
                            path: path.to_string_lossy().to_string(),
                            status: "deleted".into(),
                            detail: "deleted after identity revalidation".into(),
                            freed: bytes,
                        });
                    }
                    Err(error) => {
                        let detail = error.to_string();
                        errors.push(format!("{} — {detail}", path.display()));
                        outcomes.push(CandidateOutcome {
                            id: id.clone(),
                            path: path.to_string_lossy().to_string(),
                            status: "error".into(),
                            detail,
                            freed: 0,
                        });
                    }
                }
            }
        }
    }
    let mut result = CleanResult {
        run_id: None,
        record_error: None,
        freed,
        outcomes,
        deleted,
        skipped,
        errors,
        reinstall: reinstall.into_iter().collect(),
    };
    match save_run_record(&state.home, &result) {
        Ok(id) => result.run_id = Some(id),
        Err(error) => result.record_error = Some(error),
    }
    Ok(result)
}

#[tauri::command]
fn run_history(state: tauri::State<'_, AppState>) -> Result<Vec<RunRecord>, String> {
    let state = state
        .engine
        .lock()
        .map_err(|_| "engine state unavailable")?;
    Ok(load_run_history(&state.home))
}

const PREFERENCES_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum SupportedLocale {
    En,
    Ru,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Appearance {
    System,
    Light,
    Dark,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum SafeCandidateSelection {
    Automatic,
    Manual,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum SizeUnits {
    Binary,
    Decimal,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppPreferences {
    schema_version: u32,
    locale: SupportedLocale,
    appearance: Appearance,
    safe_candidate_selection: SafeCandidateSelection,
    size_units: SizeUnits,
    remember_last_map_folder: bool,
    last_map_folder: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppPreferencesPatch {
    locale: Option<SupportedLocale>,
    appearance: Option<Appearance>,
    safe_candidate_selection: Option<SafeCandidateSelection>,
    size_units: Option<SizeUnits>,
    remember_last_map_folder: Option<bool>,
    last_map_folder: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreferencesResponse {
    preferences: AppPreferences,
    has_persisted_preferences: bool,
}

fn default_locale() -> SupportedLocale {
    let locale = std::env::var("LC_ALL")
        .ok()
        .or_else(|| std::env::var("LANG").ok())
        .unwrap_or_default()
        .to_lowercase();
    if locale.starts_with("ru") {
        SupportedLocale::Ru
    } else {
        SupportedLocale::En
    }
}

fn default_preferences() -> AppPreferences {
    AppPreferences {
        schema_version: PREFERENCES_SCHEMA_VERSION,
        locale: default_locale(),
        appearance: Appearance::System,
        safe_candidate_selection: SafeCandidateSelection::Automatic,
        size_units: SizeUnits::Binary,
        remember_last_map_folder: false,
        last_map_folder: None,
    }
}

fn preferences_path(home: &Path) -> PathBuf {
    home.join("Library/Application Support/Deslop/preferences.json")
}

fn load_preferences(home: &Path) -> PreferencesResponse {
    let path = preferences_path(home);
    let Ok(bytes) = fs::read(path) else {
        return PreferencesResponse {
            preferences: default_preferences(),
            has_persisted_preferences: false,
        };
    };
    let Ok(mut preferences) = serde_json::from_slice::<AppPreferences>(&bytes) else {
        return PreferencesResponse {
            preferences: default_preferences(),
            has_persisted_preferences: false,
        };
    };
    if preferences.schema_version != PREFERENCES_SCHEMA_VERSION {
        return PreferencesResponse {
            preferences: default_preferences(),
            has_persisted_preferences: false,
        };
    }
    if !preferences.remember_last_map_folder {
        preferences.last_map_folder = None;
    }
    PreferencesResponse {
        preferences,
        has_persisted_preferences: true,
    }
}

fn persist_preferences(home: &Path, preferences: &AppPreferences) -> Result<(), String> {
    let path = preferences_path(home);
    let parent = path.parent().ok_or("preferences path unavailable")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("preferences directory unavailable: {error}"))?;
    let bytes = serde_json::to_vec_pretty(preferences)
        .map_err(|error| format!("preferences serialization failed: {error}"))?;
    let temporary = parent.join(format!(
        ".preferences-{}-{}.tmp",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    fs::write(&temporary, bytes).map_err(|error| format!("preferences write failed: {error}"))?;
    fs::rename(&temporary, path).map_err(|error| format!("preferences replace failed: {error}"))
}

fn validated_map_folder(path: &str) -> Result<String, String> {
    let (canonical, meta) = safe_metadata(Path::new(path))
        .map_err(|error| format!("map folder is not safe to remember: {error}"))?;
    if !meta.is_dir() {
        return Err("map folder is not a directory".into());
    }
    Ok(canonical.to_string_lossy().to_string())
}

#[tauri::command]
fn get_preferences(state: tauri::State<'_, AppState>) -> Result<PreferencesResponse, String> {
    let home = state
        .engine
        .lock()
        .map_err(|_| "engine state unavailable")?
        .home
        .clone();
    Ok(load_preferences(&home))
}

#[tauri::command]
fn update_preferences(
    state: tauri::State<'_, AppState>,
    patch: AppPreferencesPatch,
) -> Result<AppPreferences, String> {
    let home = state
        .engine
        .lock()
        .map_err(|_| "engine state unavailable")?
        .home
        .clone();
    let mut preferences = load_preferences(&home).preferences;
    if let Some(locale) = patch.locale {
        preferences.locale = locale;
    }
    if let Some(appearance) = patch.appearance {
        preferences.appearance = appearance;
    }
    if let Some(selection) = patch.safe_candidate_selection {
        preferences.safe_candidate_selection = selection;
    }
    if let Some(size_units) = patch.size_units {
        preferences.size_units = size_units;
    }
    if let Some(remember) = patch.remember_last_map_folder {
        preferences.remember_last_map_folder = remember;
        if !remember {
            preferences.last_map_folder = None;
        }
    }
    if let Some(last_map_folder) = patch.last_map_folder {
        if !preferences.remember_last_map_folder {
            return Err("enable remembered map folder before setting it".into());
        }
        preferences.last_map_folder = Some(validated_map_folder(&last_map_folder)?);
    }
    preferences.schema_version = PREFERENCES_SCHEMA_VERSION;
    persist_preferences(&home, &preferences)?;
    Ok(preferences)
}

#[tauri::command]
fn reset_preferences(state: tauri::State<'_, AppState>) -> Result<AppPreferences, String> {
    let home = state
        .engine
        .lock()
        .map_err(|_| "engine state unavailable")?
        .home
        .clone();
    let path = preferences_path(&home);
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("preferences reset failed: {error}")),
    }
    Ok(default_preferences())
}

// ------------------------------------------------------------------ treemap
#[derive(Serialize, Clone)]
struct TreeNode {
    id: String,
    name: String,
    path: String,
    size: u64,
    is_dir: bool,
    cleanup_rule_id: Option<String>,
    children: Vec<TreeNode>,
}

#[derive(Serialize, Clone)]
struct MapSnapshot {
    id: String,
    created_at: u64,
    root: TreeNode,
}

#[derive(Clone)]
struct MapNodeInternal {
    canonical_path: PathBuf,
    identity: FileIdentity,
}

struct MapSnapshotInternal {
    root: PathBuf,
    nodes: BTreeMap<String, MapNodeInternal>,
}

fn walk_size_with_cancel(
    path: &Path,
    cancel: &AtomicBool,
    visited: &mut usize,
) -> Result<u64, String> {
    if cancel.load(Ordering::Relaxed) {
        return Err("tree scan cancelled".into());
    }
    *visited += 1;
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Ok(0);
    }
    if meta.is_file() {
        return Ok(meta.len());
    }
    let mut total = 0;
    for entry in fs::read_dir(path).map_err(|e| e.to_string())?.flatten() {
        total += walk_size_with_cancel(&entry.path(), cancel, visited)?;
    }
    Ok(total)
}

fn build_node_with_progress<F>(
    path: &Path,
    depth: usize,
    max_depth: usize,
    min_size: u64,
    cancel: &AtomicBool,
    progress: &mut F,
) -> Result<TreeNode, String>
where
    F: FnMut(usize),
{
    if cancel.load(Ordering::Relaxed) {
        return Err("tree scan cancelled".into());
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_else(|| path.to_str().unwrap_or("/"))
        .to_string();
    let path_string = path.to_string_lossy().to_string();
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Ok(TreeNode {
            id: String::new(),
            name,
            path: path_string,
            size: 0,
            is_dir: false,
            cleanup_rule_id: None,
            children: vec![],
        });
    }
    if !meta.is_dir() {
        return Ok(TreeNode {
            id: String::new(),
            name,
            path: path_string,
            size: meta.len(),
            is_dir: false,
            cleanup_rule_id: None,
            children: vec![],
        });
    }
    if depth >= max_depth {
        let mut visited = 0;
        let size = walk_size_with_cancel(path, cancel, &mut visited)?;
        progress(visited);
        return Ok(TreeNode {
            id: String::new(),
            name,
            path: path_string,
            size,
            is_dir: true,
            cleanup_rule_id: None,
            children: vec![],
        });
    }
    let mut children = Vec::new();
    for entry in fs::read_dir(path).map_err(|e| e.to_string())?.flatten() {
        children.push(build_node_with_progress(
            &entry.path(),
            depth + 1,
            max_depth,
            min_size,
            cancel,
            progress,
        )?);
    }
    Ok(aggregate_small(
        TreeNode {
            id: String::new(),
            name,
            path: path_string,
            size: 0,
            is_dir: true,
            cleanup_rule_id: None,
            children,
        },
        min_size,
    ))
}

fn aggregate_small(mut node: TreeNode, min_size: u64) -> TreeNode {
    node.size = node.children.iter().map(|child| child.size).sum();
    let children = std::mem::take(&mut node.children);
    let (mut keep, small): (Vec<_>, Vec<_>) = children
        .into_iter()
        .partition(|child| child.size >= min_size);
    keep.sort_by(|a, b| b.size.cmp(&a.size));
    let small_size: u64 = small.iter().map(|child| child.size).sum();
    if !small.is_empty() && small_size > 0 {
        keep.push(TreeNode {
            id: String::new(),
            name: format!("… {} smaller items", small.len()),
            path: node.path.clone(),
            size: small_size,
            is_dir: true,
            cleanup_rule_id: None,
            children: vec![],
        });
    }
    node.children = keep;
    node
}

fn resolve_map_root(input: &str, home: &Path) -> Result<PathBuf, String> {
    let expanded = expand_under_home(input, home);
    let (canonical, meta) = safe_metadata(&expanded)
        .map_err(|error| format!("cannot scan selected folder safely: {error}"))?;
    if !meta.is_dir() {
        return Err("selected map root is not a directory".into());
    }
    Ok(canonical)
}

fn materialize_map_node(
    mut node: TreeNode,
    home: &Path,
    root: &Path,
    snapshot_id: &str,
    next_node: &mut u64,
    nodes: &mut BTreeMap<String, MapNodeInternal>,
) -> TreeNode {
    node.children = node
        .children
        .into_iter()
        .map(|child| materialize_map_node(child, home, root, snapshot_id, next_node, nodes))
        .collect();
    if node.name.starts_with('…') {
        return node;
    }
    let Ok((canonical_path, meta)) = safe_metadata(Path::new(&node.path)) else {
        return node;
    };
    if !canonical_path.starts_with(root) {
        return node;
    }
    let id = format!("map-node-{snapshot_id}-{}", *next_node);
    *next_node += 1;
    node.cleanup_rule_id = rules::exact_rule_for_path(&canonical_path, home).map(str::to_string);
    node.id = id.clone();
    nodes.insert(
        id,
        MapNodeInternal {
            canonical_path,
            identity: file_identity(&meta),
        },
    );
    node
}

fn create_map_snapshot(
    tree: TreeNode,
    home: &Path,
    root: &Path,
    snapshot_id: String,
) -> (MapSnapshot, MapSnapshotInternal) {
    let mut nodes = BTreeMap::new();
    let mut next_node = 1;
    let root_node =
        materialize_map_node(tree, home, root, &snapshot_id, &mut next_node, &mut nodes);
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    (
        MapSnapshot {
            id: snapshot_id,
            created_at,
            root: root_node,
        },
        MapSnapshotInternal {
            root: root.to_path_buf(),
            nodes,
        },
    )
}

fn resolve_map_node(
    snapshots: &BTreeMap<String, MapSnapshotInternal>,
    snapshot_id: &str,
    node_id: &str,
) -> Result<PathBuf, String> {
    let snapshot = snapshots.get(snapshot_id).ok_or("map snapshot not found")?;
    let node = snapshot.nodes.get(node_id).ok_or("map node not found")?;
    let (canonical_path, meta) = safe_metadata(&node.canonical_path)
        .map_err(|error| format!("map node is no longer safe to reveal: {error}"))?;
    if !canonical_path.starts_with(&snapshot.root) {
        return Err("map node escaped its snapshot root".into());
    }
    if file_identity(&meta) != node.identity {
        return Err("map node changed since the snapshot".into());
    }
    Ok(canonical_path)
}

#[tauri::command]
fn start_tree_scan(
    state: tauri::State<'_, AppState>,
    root: String,
    max_depth: Option<usize>,
    min_size: Option<u64>,
) -> Result<TreeJobStatus, String> {
    let home = state
        .engine
        .lock()
        .map_err(|_| "engine state unavailable")?
        .home
        .clone();
    let canonical = resolve_map_root(&root, &home)?;
    let id = format!(
        "tree-job-{}",
        state.next_job.fetch_add(1, Ordering::Relaxed)
    );
    let cancel = Arc::new(AtomicBool::new(false));
    let initial = TreeJobStatus {
        id: id.clone(),
        phase: "running".into(),
        visited_nodes: 0,
        message: "Building disk map".into(),
        snapshot: None,
        error: None,
    };
    state
        .tree_jobs
        .lock()
        .map_err(|_| "job state unavailable")?
        .insert(
            id.clone(),
            TreeJobInternal {
                status: initial.clone(),
                cancel: cancel.clone(),
            },
        );
    let jobs = state.tree_jobs.clone();
    let map_snapshots = state.map_snapshots.clone();
    std::thread::spawn(move || {
        let progress_jobs = jobs.clone();
        let progress_id = id.clone();
        let result = build_node_with_progress(
            &canonical,
            0,
            max_depth.unwrap_or(6),
            min_size.unwrap_or(20 * 1024 * 1024),
            &cancel,
            &mut |visited| {
                if let Ok(mut jobs) = progress_jobs.lock() {
                    if let Some(job) = jobs.get_mut(&progress_id) {
                        job.status.visited_nodes += visited;
                        job.status.message =
                            format!("Indexed {} filesystem nodes", job.status.visited_nodes);
                    }
                }
            },
        );
        if let Ok(mut jobs) = jobs.lock() {
            if let Some(job) = jobs.get_mut(&id) {
                match result {
                    Ok(tree) => {
                        let snapshot_id = format!("map-snapshot-{id}");
                        let (snapshot, internal) =
                            create_map_snapshot(tree, &home, &canonical, snapshot_id.clone());
                        if let Ok(mut snapshots) = map_snapshots.lock() {
                            snapshots.insert(snapshot_id, internal);
                        } else {
                            job.status.phase = "failed".into();
                            job.status.error = Some("map snapshot state unavailable".into());
                            job.status.message = "Disk map failed".into();
                            return;
                        }
                        job.status.phase = "completed".into();
                        job.status.message =
                            format!("Indexed {} filesystem nodes", job.status.visited_nodes);
                        job.status.snapshot = Some(snapshot);
                    }
                    Err(error) if error == "tree scan cancelled" => {
                        job.status.phase = "cancelled".into();
                        job.status.message = "Disk map cancelled".into();
                    }
                    Err(error) => {
                        job.status.phase = "failed".into();
                        job.status.error = Some(error);
                        job.status.message = "Disk map failed".into();
                    }
                }
            }
        }
    });
    Ok(initial)
}

#[tauri::command]
fn tree_job_status(state: tauri::State<'_, AppState>, id: String) -> Result<TreeJobStatus, String> {
    state
        .tree_jobs
        .lock()
        .map_err(|_| "job state unavailable")?
        .get(&id)
        .map(|job| job.status.clone())
        .ok_or("tree job not found".into())
}

#[tauri::command]
fn cancel_tree_scan(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<TreeJobStatus, String> {
    let mut jobs = state
        .tree_jobs
        .lock()
        .map_err(|_| "job state unavailable")?;
    let job = jobs.get_mut(&id).ok_or("tree job not found")?;
    if job.status.phase == "running" {
        job.cancel.store(true, Ordering::Relaxed);
        job.status.phase = "cancelling".into();
        job.status.message = "Cancelling after the current directory".into();
    }
    Ok(job.status.clone())
}

#[tauri::command]
fn reveal_map_node(
    state: tauri::State<'_, AppState>,
    snapshot_id: String,
    node_id: String,
) -> Result<(), String> {
    let path = {
        let snapshots = state
            .map_snapshots
            .lock()
            .map_err(|_| "map snapshot state unavailable")?;
        resolve_map_node(&snapshots, &snapshot_id, &node_id)?
    };
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open")
            .arg("-R")
            .arg(&path)
            .status()
            .map_err(|error| format!("Finder could not be opened: {error}"))?;
        if !status.success() {
            return Err("Finder could not reveal the selected map node".into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("Finder reveal is available only on macOS".into())
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ExternalLinkKind {
    GithubRepository,
    GithubStar,
    BuyMeACoffee,
    TelegramChannel,
    BetaTestersChat,
}

#[derive(Serialize)]
struct ExternalLinkAvailability {
    kind: String,
    available: bool,
}

fn external_link_url(kind: ExternalLinkKind) -> Option<&'static str> {
    // Links are deliberately maintained here instead of accepting renderer-provided URLs.
    // This keeps external navigation constrained to the user-supplied allowlist.
    match kind {
        ExternalLinkKind::TelegramChannel => Some("https://t.me/insideverbes"),
        ExternalLinkKind::BetaTestersChat => Some("https://t.me/+pEqQ2UBbciAyZGYy"),
        ExternalLinkKind::GithubRepository | ExternalLinkKind::GithubStar => {
            Some("https://github.com/sukaslitno/deslop")
        }
        ExternalLinkKind::BuyMeACoffee => None,
    }
}

#[tauri::command]
fn external_link_availability() -> Vec<ExternalLinkAvailability> {
    [
        (ExternalLinkKind::GithubRepository, "github_repository"),
        (ExternalLinkKind::GithubStar, "github_star"),
        (ExternalLinkKind::BuyMeACoffee, "buy_me_a_coffee"),
        (ExternalLinkKind::TelegramChannel, "telegram_channel"),
        (ExternalLinkKind::BetaTestersChat, "beta_testers_chat"),
    ]
    .into_iter()
    .map(|(kind, name)| ExternalLinkAvailability {
        kind: name.into(),
        available: external_link_url(kind).is_some(),
    })
    .collect()
}

#[tauri::command]
fn open_external_link(kind: ExternalLinkKind) -> Result<(), String> {
    let url = external_link_url(kind).ok_or("this link is not configured for this build")?;
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open")
            .arg(url)
            .status()
            .map_err(|error| format!("link could not be opened: {error}"))?;
        if !status.success() {
            return Err("link could not be opened".into());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = url;
        Err("external links are available only on macOS".into())
    }
}

#[derive(Serialize)]
struct AppInfo {
    name: String,
    version: String,
    build: String,
    license: String,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum MonetizationMode {
    OpenPreview,
    Enforced,
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum AccessClass {
    CoreFree,
    PlannedPaid,
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum FeatureAvailability {
    Available,
    Experimental,
    Unavailable,
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum FeatureId {
    Scan,
    Cleanup,
    DiskMap,
    FolderScan,
    FinderReveal,
    BasicHistory,
    Automation,
    DuplicateFinder,
    AppUninstaller,
    StorageTrends,
}

#[derive(Serialize)]
struct FeatureCapability {
    feature_id: FeatureId,
    access_class: AccessClass,
    availability: FeatureAvailability,
    entitlement: String,
}

#[derive(Serialize)]
struct EntitlementResponse {
    mode: MonetizationMode,
    features: Vec<FeatureCapability>,
}

trait EntitlementService {
    fn entitlement(&self, feature: FeatureId, mode: MonetizationMode) -> &'static str;
}

struct DefaultEntitlementService;

impl EntitlementService for DefaultEntitlementService {
    fn entitlement(&self, feature: FeatureId, mode: MonetizationMode) -> &'static str {
        if mode == MonetizationMode::OpenPreview
            || feature_access_class(feature) == AccessClass::CoreFree
        {
            "free"
        } else {
            // There is no LicenseProvider yet.  Future paid features are only
            // eligible for enforcement after one exists; core never is.
            "unavailable"
        }
    }
}

fn feature_access_class(feature: FeatureId) -> AccessClass {
    match feature {
        FeatureId::Scan
        | FeatureId::Cleanup
        | FeatureId::DiskMap
        | FeatureId::FolderScan
        | FeatureId::FinderReveal
        | FeatureId::BasicHistory => AccessClass::CoreFree,
        FeatureId::Automation
        | FeatureId::DuplicateFinder
        | FeatureId::AppUninstaller
        | FeatureId::StorageTrends => AccessClass::PlannedPaid,
    }
}

fn feature_availability(feature: FeatureId) -> FeatureAvailability {
    match feature {
        FeatureId::Scan
        | FeatureId::Cleanup
        | FeatureId::DiskMap
        | FeatureId::FolderScan
        | FeatureId::FinderReveal
        | FeatureId::BasicHistory => FeatureAvailability::Available,
        FeatureId::Automation => FeatureAvailability::Experimental,
        _ => FeatureAvailability::Unavailable,
    }
}

fn monetization_mode_from(value: Option<&str>) -> MonetizationMode {
    match value {
        Some("enforced") => MonetizationMode::Enforced,
        _ => MonetizationMode::OpenPreview,
    }
}

fn entitlement_response(mode: MonetizationMode) -> EntitlementResponse {
    let service = DefaultEntitlementService;
    let features = [
        FeatureId::Scan,
        FeatureId::Cleanup,
        FeatureId::DiskMap,
        FeatureId::FolderScan,
        FeatureId::FinderReveal,
        FeatureId::BasicHistory,
        FeatureId::Automation,
        FeatureId::DuplicateFinder,
        FeatureId::AppUninstaller,
        FeatureId::StorageTrends,
    ]
    .into_iter()
    .map(|feature_id| FeatureCapability {
        feature_id,
        access_class: feature_access_class(feature_id),
        availability: feature_availability(feature_id),
        entitlement: service.entitlement(feature_id, mode).into(),
    })
    .collect();
    EntitlementResponse { mode, features }
}

#[tauri::command]
fn entitlements() -> EntitlementResponse {
    entitlement_response(monetization_mode_from(option_env!(
        "DESLOP_MONETIZATION_MODE"
    )))
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        name: "Deslop".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        build: option_env!("DESLOP_BUILD").unwrap_or("local").into(),
        license: "MIT".into(),
    }
}

// GrandPerspective import: stream gzip/XML and reject intentionally oversized
// or malformed input before it can consume unbounded memory.
#[cfg(test)]
const MAX_GPSCAN_NODES: usize = 250_000;
#[cfg(test)]
const MAX_GPSCAN_DEPTH: usize = 128;

#[cfg(test)]
struct LimitedReader<R> {
    inner: R,
    read: u64,
    limit: u64,
}
#[cfg(test)]
impl<R: std::io::Read> std::io::Read for LimitedReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.read += read as u64;
        if self.read > self.limit {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "decompressed .gpscan exceeds 512 MiB limit",
            ));
        }
        Ok(read)
    }
}

#[cfg(test)]
fn xml_attribute(
    start: &quick_xml::events::BytesStart<'_>,
    key: &[u8],
    decoder: quick_xml::encoding::Decoder,
) -> Result<Option<String>, String> {
    for attribute in start.attributes().with_checks(false) {
        let attribute = attribute.map_err(|e| format!("invalid XML attribute: {e}"))?;
        if attribute.key.as_ref() == key {
            return attribute
                .decode_and_unescape_value(decoder)
                .map(|value| Some(value.into_owned()))
                .map_err(|e| format!("invalid XML value: {e}"));
        }
    }
    Ok(None)
}

#[cfg(test)]
fn parse_gpscan_stream<R: std::io::BufRead>(reader: R) -> Result<TreeNode, String> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_reader(reader);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut stack = Vec::<TreeNode>::new();
    let mut root = None;
    let mut nodes = 0usize;
    loop {
        match reader
            .read_event_into(&mut buffer)
            .map_err(|e| format!("malformed .gpscan XML: {e}"))?
        {
            Event::Start(start) if start.name().as_ref() == b"Folder" => {
                if stack.len() >= MAX_GPSCAN_DEPTH {
                    return Err(".gpscan folder depth exceeds limit".into());
                }
                nodes += 1;
                if nodes > MAX_GPSCAN_NODES {
                    return Err(".gpscan node count exceeds limit".into());
                }
                let name = xml_attribute(&start, b"name", reader.decoder())?.unwrap_or_default();
                let parent = stack
                    .last()
                    .map(|node| node.path.clone())
                    .unwrap_or_default();
                let path = if parent.is_empty() {
                    name.clone()
                } else {
                    format!("{parent}/{name}")
                };
                stack.push(TreeNode {
                    id: String::new(),
                    name,
                    path,
                    size: 0,
                    is_dir: true,
                    cleanup_rule_id: None,
                    children: vec![],
                });
            }
            Event::End(end) if end.name().as_ref() == b"Folder" => {
                let Some(mut node) = stack.pop() else {
                    return Err("unbalanced Folder tag".into());
                };
                node.size = node.children.iter().map(|child| child.size).sum();
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(node);
                } else if root.is_none() {
                    root = Some(node);
                } else {
                    return Err("multiple folder roots".into());
                }
            }
            Event::Start(start) | Event::Empty(start) if start.name().as_ref() == b"File" => {
                nodes += 1;
                if nodes > MAX_GPSCAN_NODES {
                    return Err(".gpscan node count exceeds limit".into());
                }
                if let Some(parent) = stack.last_mut() {
                    let name =
                        xml_attribute(&start, b"name", reader.decoder())?.unwrap_or_default();
                    let size = xml_attribute(&start, b"size", reader.decoder())?
                        .and_then(|value| value.parse().ok())
                        .unwrap_or(0);
                    parent.children.push(TreeNode {
                        id: String::new(),
                        path: format!("{}/{}", parent.path, name),
                        name,
                        size,
                        is_dir: false,
                        cleanup_rule_id: None,
                        children: vec![],
                    });
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    if !stack.is_empty() {
        return Err("unclosed Folder tag".into());
    }
    root.ok_or_else(|| "no folder data found in scan file".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let home = canonical_home().expect("Deslop cannot start safely without a canonical HOME");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            engine: Arc::new(Mutex::new(EngineState::new(home))),
            scan_jobs: Arc::new(Mutex::new(BTreeMap::new())),
            tree_jobs: Arc::new(Mutex::new(BTreeMap::new())),
            map_snapshots: Arc::new(Mutex::new(BTreeMap::new())),
            next_job: AtomicU64::new(1),
        })
        .invoke_handler(tauri::generate_handler![
            default_roots,
            disk_info,
            scan,
            start_scan,
            scan_job_status,
            cancel_scan,
            preflight,
            clean,
            run_history,
            get_preferences,
            update_preferences,
            reset_preferences,
            start_tree_scan,
            tree_job_status,
            cancel_tree_scan,
            reveal_map_node,
            external_link_availability,
            open_external_link,
            entitlements,
            app_info,
            home_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running Deslop");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static TEST_COUNTER: AtomicU64 = AtomicU64::new(1);
    fn fixture() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "deslop-test-{}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }
    fn engine(home: &Path) -> EngineState {
        EngineState::new(home.canonicalize().unwrap())
    }
    fn fixture_candidate(path: PathBuf, rule_id: &str) -> CandidateInternal {
        let (canonical_path, meta) = safe_metadata(&path).unwrap();
        CandidateInternal {
            id: format!("fixture-{rule_id}"),
            snapshot_id: "fixture-snapshot".into(),
            rule_id: rule_id.into(),
            tier: Tier::Green,
            canonical_path,
            identity: file_identity(&meta),
            size: 0,
            restore: None,
            policy_fingerprint: POLICY_FINGERPRINT.into(),
        }
    }
    #[test]
    fn protected_fragments_match_real_absolute_paths() {
        let home = Path::new("/Users/tester");
        assert!(is_protected(&home.join(".claude/projects")));
        assert!(is_protected(&home.join(".claude/projects/deep/nested")));
        assert!(is_protected(&home.join(".claude/todos")));
        assert!(is_protected(&home.join(".claude/file-history")));
        assert!(is_protected(&home.join(".codex/sessions")));
        assert!(is_protected(&home.join(".codex/sessions/deep/nested")));
        assert!(!is_protected(&home.join(".claude/logs")));
        assert!(!is_protected(&home.join(".claude-backup/projects")));
        assert!(!is_protected(&home.join(".claude/projects-backup")));
        assert!(!is_protected(&home.join(".codex/sessions-backup")));
    }
    #[test]
    fn home_fails_closed_when_unavailable() {
        assert!(canonical_home_from(None).is_err());
    }
    #[test]
    fn preferences_persist_validate_and_reset_only_in_temp_home() {
        let home = fixture();
        let mut preferences = default_preferences();
        preferences.locale = SupportedLocale::Ru;
        preferences.appearance = Appearance::Dark;
        preferences.safe_candidate_selection = SafeCandidateSelection::Manual;
        preferences.size_units = SizeUnits::Decimal;
        let map_folder = home.join("map-folder");
        fs::create_dir_all(&map_folder).unwrap();
        preferences.remember_last_map_folder = true;
        preferences.last_map_folder =
            Some(validated_map_folder(&map_folder.display().to_string()).unwrap());
        persist_preferences(&home, &preferences).unwrap();
        let loaded = load_preferences(&home);
        assert!(loaded.has_persisted_preferences);
        assert_eq!(loaded.preferences.locale, SupportedLocale::Ru);
        assert_eq!(loaded.preferences.appearance, Appearance::Dark);
        assert_eq!(loaded.preferences.size_units, SizeUnits::Decimal);
        assert!(loaded.preferences.last_map_folder.is_some());
        fs::write(preferences_path(&home), b"not json").unwrap();
        assert!(!load_preferences(&home).has_persisted_preferences);
        assert!(validated_map_folder(&home.join("missing").display().to_string()).is_err());
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn roots_are_canonical_deduped_and_nested_roots_removed() {
        let home = fixture();
        let inner = home.join("Documents/VIBE BUILD");
        fs::create_dir_all(&inner).unwrap();
        let (roots, skipped) = canonical_roots(
            &[
                home.join("Documents").display().to_string(),
                inner.display().to_string(),
                "/".into(),
            ],
            &home.canonicalize().unwrap(),
        );
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0], home.join("Documents").canonicalize().unwrap());
        assert_eq!(skipped.len(), 1);
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn generic_build_folder_is_never_a_candidate() {
        let home = fixture();
        let project = home.join("Documents/project/build");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("important.txt"), b"keep").unwrap();
        let mut state = engine(&home);
        let scan = scan_snapshot(
            &mut state,
            &[home.join("Documents").display().to_string()],
            None,
        );
        assert!(scan
            .categories
            .iter()
            .flat_map(|category| &category.entries)
            .all(|entry| entry.path != project.canonicalize().unwrap().display().to_string()));
        assert!(project.exists());
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn snapshot_rejects_renderer_tampering_and_only_deletes_selected_candidate() {
        let home = fixture();
        let safe = home.join(".npm/_cacache");
        let protected = home.join(".codex/sessions/keep");
        fs::create_dir_all(&safe).unwrap();
        fs::write(safe.join("cache"), b"cache").unwrap();
        fs::create_dir_all(&protected).unwrap();
        fs::write(protected.join("session"), b"keep").unwrap();
        let mut state = engine(&home);
        let scan = scan_snapshot(&mut state, &[], Some(vec!["pkg".into()]));
        let id = scan.categories[0].entries[0].id.clone();
        assert!(
            create_preflight(&mut state, scan.id.clone(), vec!["renderer-path".into()]).is_err()
        );
        let preflight = create_preflight(&mut state, scan.id.clone(), vec![id]).unwrap();
        let result = clean_engine(&mut state, preflight.id, false).unwrap();
        assert_eq!(result.deleted.len(), 1);
        assert!(result.run_id.is_some());
        assert_eq!(load_run_history(&home).len(), 1);
        assert!(protected.exists());
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn symlink_candidate_is_rejected() {
        let home = fixture();
        let external = fixture();
        let link = home.join(".npm/_cacache");
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&external, &link).unwrap();
        let mut state = engine(&home);
        let scan = scan_snapshot(&mut state, &[], Some(vec!["pkg".into()]));
        assert!(scan.categories.is_empty());
        assert!(external.exists());
        fs::remove_dir_all(home).unwrap();
        fs::remove_dir_all(external).unwrap();
    }
    #[test]
    fn cancelled_scan_creates_no_snapshot() {
        let home = fixture();
        fs::create_dir_all(home.join(".npm/_cacache")).unwrap();
        let mut state = engine(&home);
        let cancelled = AtomicBool::new(true);
        let outcome = scan_snapshot_with_progress(
            &mut state,
            &[],
            Some(vec!["pkg".into()]),
            &cancelled,
            |_, _, _| {},
        );
        assert!(outcome.is_err());
        assert!(state.snapshots.is_empty());
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn disk_tree_uses_temp_fixture_and_can_cancel() {
        let root = fixture();
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::write(root.join("a/b/data"), b"12345").unwrap();
        let cancel = AtomicBool::new(false);
        let tree = build_node_with_progress(&root, 0, 1, 0, &cancel, &mut |_| {}).unwrap();
        assert_eq!(tree.size, 5);
        cancel.store(true, Ordering::Relaxed);
        assert!(build_node_with_progress(&root, 0, 1, 0, &cancel, &mut |_| {}).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn breakdown_uses_exact_rule_categories_and_dedupes_overlap_hardlinks_and_symlinks() {
        let home = fixture();
        let cache = home.join("Library/Caches/exact-cache");
        let nested = cache.join("nested");
        let outside = fixture();
        fs::create_dir_all(&nested).unwrap();
        fs::write(cache.join("payload"), b"1234567").unwrap();
        fs::hard_link(cache.join("payload"), cache.join("payload-hardlink")).unwrap();
        fs::write(nested.join("nested-payload"), b"12345").unwrap();
        fs::write(outside.join("outside-payload"), b"123456789").unwrap();
        std::os::unix::fs::symlink(outside.join("outside-payload"), cache.join("outside-link"))
            .unwrap();
        let mut candidates = BTreeMap::new();
        candidates.insert("parent".into(), fixture_candidate(cache.clone(), "pkg"));
        candidates.insert("nested".into(), fixture_candidate(nested, "editors"));
        let canonical_home = home.canonicalize().unwrap();
        let breakdown =
            cleanup_breakdown_snapshot("fixture-snapshot", &canonical_home, &candidates, &[]);
        assert_eq!(breakdown.measurement_kind, "logicalFallback");
        assert!(!breakdown.is_partial);
        assert_eq!(breakdown.categories.len(), 1);
        assert_eq!(
            breakdown.categories[0].category_id,
            CleanupCategoryId::PackageCaches
        );
        assert_eq!(breakdown.categories[0].candidate_count, 1);
        assert_eq!(breakdown.categories[0].measured_bytes, 12);
        fs::remove_dir_all(home).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
    #[test]
    fn map_node_resolution_is_snapshot_bound_and_revalidates_identity() {
        let root = fixture();
        let item = root.join("cache");
        fs::write(&item, b"old").unwrap();
        let cancel = AtomicBool::new(false);
        let tree = build_node_with_progress(&root, 0, 2, 0, &cancel, &mut |_| {}).unwrap();
        let canonical_root = root.canonicalize().unwrap();
        let (snapshot, internal) = create_map_snapshot(
            tree,
            &canonical_root,
            &canonical_root,
            "map-snapshot-test".into(),
        );
        let node_id = snapshot.root.children[0].id.clone();
        let mut snapshots = BTreeMap::new();
        snapshots.insert(snapshot.id.clone(), internal);
        assert_eq!(
            resolve_map_node(&snapshots, &snapshot.id, &node_id).unwrap(),
            item.canonicalize().unwrap()
        );
        assert!(resolve_map_node(&snapshots, &snapshot.id, "renderer-path").is_err());
        fs::remove_file(&item).unwrap();
        fs::write(&item, b"new identity").unwrap();
        assert!(resolve_map_node(&snapshots, &snapshot.id, &node_id).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn map_node_resolution_rejects_symlinks_and_root_escape() {
        let root = fixture();
        let outside = fixture();
        let link = root.join("outside-link");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let (outside_path, outside_meta) = safe_metadata(&outside).unwrap();
        let mut nodes = BTreeMap::new();
        nodes.insert(
            "escaped".into(),
            MapNodeInternal {
                canonical_path: outside_path,
                identity: file_identity(&outside_meta),
            },
        );
        nodes.insert(
            "symlink".into(),
            MapNodeInternal {
                canonical_path: link,
                identity: file_identity(&outside_meta),
            },
        );
        let mut snapshots = BTreeMap::new();
        snapshots.insert(
            "map-snapshot-test".into(),
            MapSnapshotInternal {
                root: root.canonicalize().unwrap(),
                nodes,
            },
        );
        assert!(resolve_map_node(&snapshots, "map-snapshot-test", "escaped").is_err());
        assert!(resolve_map_node(&snapshots, "map-snapshot-test", "symlink").is_err());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
    #[test]
    fn open_preview_unlocks_all_and_enforced_keeps_core_free() {
        let preview = entitlement_response(MonetizationMode::OpenPreview);
        assert!(preview
            .features
            .iter()
            .all(|feature| feature.entitlement == "free"));
        let enforced = entitlement_response(MonetizationMode::Enforced);
        assert!(enforced
            .features
            .iter()
            .filter(|feature| feature.access_class == AccessClass::CoreFree)
            .all(|feature| feature.entitlement == "free"));
        assert_eq!(
            monetization_mode_from(Some("enforced")),
            MonetizationMode::Enforced
        );
        assert_eq!(monetization_mode_from(None), MonetizationMode::OpenPreview);
        assert_eq!(
            external_link_url(ExternalLinkKind::GithubRepository),
            Some("https://github.com/sukaslitno/deslop")
        );
        assert_eq!(
            external_link_url(ExternalLinkKind::TelegramChannel),
            Some("https://t.me/insideverbes")
        );
        assert_eq!(
            external_link_url(ExternalLinkKind::BetaTestersChat),
            Some("https://t.me/+pEqQ2UBbciAyZGYy")
        );
    }
    #[test]
    fn gpscan_stream_parser_handles_fixture_and_rejects_unclosed_xml() {
        let xml = br#"<Folder name="home"><Folder name="cache"><File name="a&amp;b" size="7"/></Folder></Folder>"#;
        let tree = parse_gpscan_stream(std::io::Cursor::new(xml)).unwrap();
        assert_eq!(tree.size, 7);
        assert_eq!(tree.children[0].children[0].name, "a&b");
        assert!(
            parse_gpscan_stream(std::io::Cursor::new(b"<Folder name=\"broken\">" as &[u8]))
                .is_err()
        );
    }
    #[test]
    fn gpscan_limits_are_enforced() {
        use std::io::Read;
        let mut limited = LimitedReader {
            inner: std::io::Cursor::new(b"abc"),
            read: 0,
            limit: 2,
        };
        let mut out = Vec::new();
        assert!(limited.read_to_end(&mut out).is_err());
        let mut xml = String::new();
        for _ in 0..=MAX_GPSCAN_DEPTH {
            xml.push_str("<Folder name=\"x\">");
        }
        assert!(parse_gpscan_stream(std::io::Cursor::new(xml)).is_err());
    }
    #[test]
    fn exact_app_rules_include_variants_but_never_protected_siblings() {
        let home = fixture();
        let cache = home.join("Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack/Service Worker/CacheStorage");
        let cookies = home.join("Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack/Cookies");
        fs::create_dir_all(&cache).unwrap();
        fs::create_dir_all(&cookies).unwrap();
        let paths = rules::app_cache_paths(&home);
        assert!(paths.contains(&cache));
        assert!(!paths.contains(&cookies));
        fs::remove_dir_all(home).unwrap();
    }
}
