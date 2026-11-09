//! Deslop backend — a fail-closed, snapshot-based cleanup engine.
//!
//! The WebView never supplies paths to `clean`.  A scan creates immutable
//! candidates in backend state; preflight locks an exact selection from that
//! snapshot; clean revalidates identity immediately before every deletion.

mod rules;

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const POLICY_FINGERPRINT: &str = "2026-11-09-snapshot-v3";
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
const EXTERNAL_MEASUREMENT_TIMEOUT: Duration = Duration::from_secs(10);
const EXTERNAL_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// One `lsof` call covers every SQLite family of a candidate. `lsof` walks the
/// descriptors of every process, which regularly takes several seconds on a
/// busy Mac, so this budget is deliberately larger than the per-process probe.
#[cfg(not(windows))]
const SQLITE_PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const NATIVE_TOOL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_SAFE_SIZE_ENTRIES: usize = 1_000_000;
const EXCLUSIONS_SCHEMA_VERSION: u32 = 1;
const RUN_SCHEMA_VERSION: u8 = 3;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
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
    ProjectArtifacts,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ActionMethod {
    Delete,
    NativeTool,
    Manual,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProbeRequirement {
    None,
    Owner,
    /// Owner process check, then the Chromium/Electron `SingletonLock` of the
    /// owner's profile, then a cheap, bounded open-file check of top-level
    /// SQLite families. It never walks a whole cache tree.
    OwnerAndSqlite,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativeToolKind {
    PnpmStorePrune,
    UvCachePrune,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProjectArtifactKind {
    NodeModules,
    CargoTarget,
    NextBuild,
}

impl ProjectArtifactKind {
    fn directory(self) -> &'static str {
        match self {
            Self::NodeModules => "node_modules",
            Self::CargoTarget => "target",
            Self::NextBuild => ".next",
        }
    }
    fn owner(self) -> &'static str {
        match self {
            Self::NodeModules | Self::NextBuild => "Project Node build",
            Self::CargoTarget => "Project Rust build",
        }
    }
    fn restore(self) -> &'static str {
        match self {
            Self::NodeModules => "Run your package install command in this project.",
            Self::CargoTarget => "Run cargo build in this project.",
            Self::NextBuild => "Run the project's Next.js build command.",
        }
    }
}

impl NativeToolKind {
    fn program(self) -> &'static str {
        match self {
            Self::PnpmStorePrune => "pnpm",
            Self::UvCachePrune => "uv",
        }
    }
    fn scope_args(self) -> &'static [&'static str] {
        match self {
            Self::PnpmStorePrune => &["store", "path"],
            Self::UvCachePrune => &["cache", "dir"],
        }
    }
    fn execute_args(self) -> &'static [&'static str] {
        match self {
            Self::PnpmStorePrune => &["store", "prune"],
            Self::UvCachePrune => &["cache", "prune"],
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::PnpmStorePrune => "pnpm store prune",
            Self::UvCachePrune => "uv cache prune",
        }
    }
}

#[derive(Clone)]
struct NativeToolSnapshot {
    kind: NativeToolKind,
    executable: PathBuf,
    executable_identity: FileIdentity,
    scope: PathBuf,
    scope_identity: FileIdentity,
    version: String,
}

#[derive(Clone, Copy)]
struct Rule {
    id: &'static str,
    title: &'static str,
    tier: Tier,
    cleanup_category: CleanupCategoryId,
    owner: &'static str,
    action: ActionMethod,
    required_probe: ProbeRequirement,
    supported_on: &'static [&'static str],
    note: &'static str,
    restore: Option<&'static str>,
}

// Every enabled rule below resolves an exact, owned cache location.  Project
// output names (build/dist/target/etc.) are intentionally absent until they
// have a project-aware rule and fixture coverage.
const RULES: &[Rule] = &[
    Rule { id: "claude", title: "Claude Code cache", tier: Tier::Green, cleanup_category: CleanupCategoryId::AgentCaches, owner: "Claude Code", action: ActionMethod::Delete, required_probe: ProbeRequirement::None, supported_on: &["macos", "windows"], note: "Only shell snapshots, logs and statsig. Projects, memory, todos and file history stay protected.", restore: None },
    Rule { id: "codex", title: "Codex logs and runtimes", tier: Tier::Yellow, cleanup_category: CleanupCategoryId::AgentCaches, owner: "Codex", action: ActionMethod::Delete, required_probe: ProbeRequirement::None, supported_on: &["macos"], note: "Rollout sessions are protected. Runtimes download again on demand.", restore: Some("Run Codex again to download required runtimes.") },
    Rule { id: "editors", title: "Cursor / VS Code caches", tier: Tier::Green, cleanup_category: CleanupCategoryId::EditorCaches, owner: "Editor", action: ActionMethod::Delete, required_probe: ProbeRequirement::OwnerAndSqlite, supported_on: &["macos", "windows"], note: "Exact render caches only; settings and extensions are not selected.", restore: None },
    Rule { id: "appcache", title: "Known app caches", tier: Tier::Green, cleanup_category: CleanupCategoryId::ApplicationCaches, owner: "Application", action: ActionMethod::Delete, required_probe: ProbeRequirement::OwnerAndSqlite, supported_on: &["macos", "windows"], note: "Exact application cache roots only. Service Worker CacheStorage is review-only because an exact path alone does not prove it can be recreated.", restore: Some("Open the owning application after cleanup; it may recreate cache data.") },
    Rule { id: "pkg", title: "Package caches", tier: Tier::Green, cleanup_category: CleanupCategoryId::PackageCaches, owner: "Package tools", action: ActionMethod::Delete, required_probe: ProbeRequirement::Owner, supported_on: &["macos", "windows"], note: "Exact package-manager cache roots; projects are not selected.", restore: None },
    Rule { id: "xcode", title: "Xcode caches", tier: Tier::Green, cleanup_category: CleanupCategoryId::DeveloperCaches, owner: "Xcode", action: ActionMethod::Delete, required_probe: ProbeRequirement::Owner, supported_on: &["macos"], note: "Derived data and simulator cache are rebuilt by Xcode.", restore: None },
    Rule { id: "hf", title: "Hugging Face cache", tier: Tier::Yellow, cleanup_category: CleanupCategoryId::ModelCaches, owner: "Hugging Face", action: ActionMethod::Delete, required_probe: ProbeRequirement::Owner, supported_on: &["macos"], note: "Models and datasets are never selected automatically; their exact path alone does not prove recovery is safe.", restore: Some("Re-run the model or dataset download.") },
    Rule { id: "project", title: "Selected project artifacts", tier: Tier::Green, cleanup_category: CleanupCategoryId::ProjectArtifacts, owner: "Project build", action: ActionMethod::Delete, required_probe: ProbeRequirement::Owner, supported_on: &["macos"], note: "Only selected project roots with confirmed build artifacts are checked; arbitrary build and dist folders are never candidates.", restore: Some("Use the project's normal build or install command to recreate artifacts.") },
];

#[derive(Clone, Serialize)]
struct Entry {
    id: String,
    path: String,
    /// Per-entry tier; may be stricter than its category (e.g. Service Worker
    /// CacheStorage inside the GREEN application-cache category).
    tier: Tier,
    size: u64,
    size_known: bool,
    reason: String,
    scope: String,
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

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileIdentity {
    volume: u64,
    file_id: [u8; 16],
    is_dir: bool,
}

#[cfg(unix)]
fn file_identity(meta: &fs::Metadata) -> FileIdentity {
    use std::os::unix::fs::MetadataExt;
    FileIdentity {
        volume: meta.dev(),
        file_id: {
            let mut file_id = [0; 16];
            file_id[..8].copy_from_slice(&meta.ino().to_le_bytes());
            file_id
        },
        is_dir: meta.is_dir(),
    }
}

#[cfg(all(not(unix), not(windows)))]
fn file_identity(meta: &fs::Metadata) -> FileIdentity {
    FileIdentity {
        volume: 0,
        file_id: [0; 16],
        is_dir: meta.is_dir(),
    }
}

#[cfg(not(windows))]
fn file_identity_from_path(_path: &Path, meta: &fs::Metadata) -> Result<FileIdentity, String> {
    Ok(file_identity(meta))
}

#[cfg(windows)]
fn file_identity_from_path(path: &Path, meta: &fs::Metadata) -> Result<FileIdentity, String> {
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandleEx, GetVolumeInformationByHandleW,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO,
    };

    let flags = if meta.is_dir() {
        FILE_FLAG_BACKUP_SEMANTICS
    } else {
        0
    } | FILE_FLAG_OPEN_REPARSE_POINT;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(flags)
        .open(path)
        .map_err(|error| format!("file identity handle unavailable: {error}"))?;
    let mut info: FILE_ID_INFO = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            &mut info as *mut FILE_ID_INFO as *mut std::ffi::c_void,
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if ok == 0 {
        return Err("file identity unavailable; cleanup is disabled for this entry".into());
    }
    let mut filesystem = [0u16; 32];
    let volume_ok = unsafe {
        GetVolumeInformationByHandleW(
            file.as_raw_handle(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            filesystem.as_mut_ptr(),
            filesystem.len() as u32,
        )
    };
    let filesystem = String::from_utf16_lossy(&filesystem)
        .trim_end_matches('\0')
        .to_ascii_uppercase();
    if volume_ok == 0 || filesystem != "NTFS" {
        return Err("cleanup identity is supported only on NTFS volumes".into());
    }
    if info.VolumeSerialNumber == 0 || info.FileId.Identifier.iter().all(|byte| *byte == 0) {
        return Err(
            "file identity is unreliable on this filesystem; cleanup is disabled for this entry"
                .into(),
        );
    }
    Ok(FileIdentity {
        volume: info.VolumeSerialNumber,
        file_id: info.FileId.Identifier,
        is_dir: meta.is_dir(),
    })
}

#[derive(Clone)]
struct CandidateInternal {
    id: String,
    snapshot_id: String,
    rule_id: String,
    owner: String,
    tier: Tier,
    action: ActionMethod,
    required_probe: ProbeRequirement,
    native_tool: Option<NativeToolSnapshot>,
    project_root: Option<PathBuf>,
    project_artifact: Option<ProjectArtifactKind>,
    canonical_path: PathBuf,
    identity: FileIdentity,
    size: u64,
    size_known: bool,
    reason: String,
    scope: String,
    restore: Option<String>,
    policy_fingerprint: String,
}

struct SnapshotInternal {
    candidates: BTreeMap<String, CandidateInternal>,
}
struct PreflightInternal {
    snapshot_id: String,
    requested_candidate_ids: BTreeSet<String>,
    candidate_ids: BTreeSet<String>,
    exclusion_revision: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CleanupExclusion {
    id: String,
    rule_id: String,
    owner: String,
    path: String,
    created_at: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExclusionsDocument {
    schema_version: u32,
    revision: u64,
    entries: Vec<CleanupExclusion>,
}

impl Default for ExclusionsDocument {
    fn default() -> Self {
        Self {
            schema_version: EXCLUSIONS_SCHEMA_VERSION,
            revision: 0,
            entries: Vec::new(),
        }
    }
}

struct EngineState {
    home: PathBuf,
    snapshots: BTreeMap<String, SnapshotInternal>,
    preflights: BTreeMap<String, PreflightInternal>,
    exclusions: ExclusionsDocument,
    counter: AtomicU64,
}

impl EngineState {
    fn new(home: PathBuf) -> Self {
        Self {
            exclusions: load_exclusions(&home),
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
    // Immutable platform state stays outside the deletion/snapshot mutex so
    // status, preferences and map commands never wait on a long cleanup.
    home: PathBuf,
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
    #[cfg(windows)]
    {
        return canonical_home_from(std::env::var_os("USERPROFILE").map(PathBuf::from));
    }
    #[cfg(not(windows))]
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
    #[cfg(windows)]
    {
        return PROTECTED_SUFFIXES.iter().any(|needle| {
            parts.windows(needle.len()).any(|window| {
                window
                    .iter()
                    .zip(needle.iter())
                    .all(|(actual, expected)| actual.eq_ignore_ascii_case(expected))
            })
        });
    }
    #[cfg(not(windows))]
    PROTECTED_SUFFIXES
        .iter()
        .any(|needle| parts.windows(needle.len()).any(|window| window == *needle))
}

fn is_never_name(name: &str) -> bool {
    #[cfg(windows)]
    return NEVER_NAMES
        .iter()
        .any(|blocked| name.eq_ignore_ascii_case(blocked));
    #[cfg(not(windows))]
    NEVER_NAMES.contains(&name)
}

fn remove_authorized_candidate(path: &Path, is_dir: bool) -> Result<(), std::io::Error> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileAttributesW, SetFileAttributesW, FILE_ATTRIBUTE_READONLY,
        };
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let attributes = unsafe { GetFileAttributesW(wide.as_ptr()) };
        if attributes != u32::MAX && attributes & FILE_ATTRIBUTE_READONLY != 0 {
            // This is deliberately non-recursive and runs only after the
            // snapshot/preflight identity check for this exact candidate.
            if unsafe { SetFileAttributesW(wide.as_ptr(), attributes & !FILE_ATTRIBUTE_READONLY) }
                == 0
            {
                return Err(std::io::Error::last_os_error());
            }
        }
    }
    if is_dir {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
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
    #[cfg(windows)]
    windows_path_safety(path)?;
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

#[cfg(windows)]
fn windows_path_safety(path: &Path) -> Result<(), String> {
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileAttributesW, FILE_ATTRIBUTE_OFFLINE, FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
        FILE_ATTRIBUTE_REPARSE_POINT,
    };

    for ancestor in path.ancestors() {
        let wide = windows_verbatim_wide(ancestor);
        let attributes = unsafe { GetFileAttributesW(wide.as_ptr()) };
        if attributes == u32::MAX {
            return Err("file attributes are unavailable".into());
        }
        if attributes
            & (FILE_ATTRIBUTE_REPARSE_POINT
                | FILE_ATTRIBUTE_OFFLINE
                | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS)
            != 0
        {
            return Err("reparse or cloud-placeholder paths are not eligible for cleanup".into());
        }
    }
    Ok(())
}

#[cfg(windows)]
fn windows_verbatim_wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    // Verbatim Win32 paths do not normalize forward slashes, and lossy UTF-8
    // conversion would change legal Windows filenames containing lone UTF-16
    // surrogates. Preserve the OS string throughout.
    let raw: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .map(|c| if c == 47 { 92 } else { c })
        .collect();
    let mut verbatim = if raw.starts_with(&[92, 92, 63, 92]) {
        raw
    } else if raw.starts_with(&[92, 92]) {
        r"\\?\UNC\"
            .encode_utf16()
            .chain(raw.into_iter().skip(2))
            .collect()
    } else {
        r"\\?\".encode_utf16().chain(raw).collect()
    };
    verbatim.push(0);
    verbatim
}

#[cfg(windows)]
type SeenFiles = BTreeSet<(u64, [u8; 16])>;
#[cfg(all(not(unix), not(windows)))]
type SeenFiles = BTreeSet<PathBuf>;

enum MeasurementCommandError {
    TimedOut,
    Failed,
}

fn output_with_timeout(
    command: &mut Command,
    timeout: Duration,
) -> Result<Output, MeasurementCommandError> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|_| MeasurementCommandError::Failed)?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|_| MeasurementCommandError::Failed)
            }
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(MeasurementCommandError::TimedOut);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => return Err(MeasurementCommandError::Failed),
        }
    }
}

fn du_bytes(path: &Path) -> Option<u64> {
    let mut command = Command::new("du");
    command.arg("-sk").arg(path);
    match output_with_timeout(&mut command, EXTERNAL_MEASUREMENT_TIMEOUT) {
        Ok(out) => {
            if out.status.success() {
                if let Ok(s) = String::from_utf8(out.stdout) {
                    if let Some(Ok(kb)) = s.split_whitespace().next().map(str::parse::<u64>) {
                        return Some(kb * 1024);
                    }
                }
            }
            walk_size(path)
        }
        // A timed-out external command has already been terminated and reaped.
        // Do not immediately restart a second unbounded walk of the same path.
        Err(MeasurementCommandError::TimedOut) => None,
        Err(MeasurementCommandError::Failed) => walk_size(path),
    }
}

fn walk_size(path: &Path) -> Option<u64> {
    let mut pending = vec![path.to_path_buf()];
    let mut bytes = 0u64;
    let mut visited = 0usize;
    while let Some(current) = pending.pop() {
        visited += 1;
        if visited > MAX_SAFE_SIZE_ENTRIES {
            return None;
        }
        #[cfg(windows)]
        if windows_path_safety(&current).is_err() {
            return None;
        }
        let meta = fs::symlink_metadata(&current).ok()?;
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_file() {
            bytes = bytes.checked_add(meta.len())?;
            continue;
        }
        let entries = fs::read_dir(&current).ok()?;
        for entry in entries {
            pending.push(entry.ok()?.path());
        }
    }
    Some(bytes)
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
    if is_never_name(name) {
        return;
    }
    if candidates
        .values()
        .any(|c| c.canonical_path == canonical_path)
    {
        return;
    }
    let identity = match file_identity_from_path(&canonical_path, &meta) {
        Ok(identity) => identity,
        Err(_) => return,
    };
    let id = state.next_id("candidate");
    let owner = candidate_owner(rule, &canonical_path, &state.home);
    let tier = candidate_tier(rule, &canonical_path);
    let action = if tier == Tier::Red {
        ActionMethod::Manual
    } else {
        rule.action
    };
    candidates.insert(
        id.clone(),
        CandidateInternal {
            id,
            snapshot_id: snapshot_id.into(),
            rule_id: rule.id.into(),
            owner,
            tier,
            action,
            required_probe: rule.required_probe,
            native_tool: None,
            project_root: None,
            project_artifact: None,
            canonical_path,
            identity,
            // Filled in one globally-deduped, cancellable pass after all
            // candidates are discovered.
            size: 0,
            size_known: false,
            reason: candidate_reason(rule, &path),
            scope: "Exact owned cache path".into(),
            restore: candidate_restore(rule, &path),
            policy_fingerprint: POLICY_FINGERPRINT.into(),
        },
    );
}

fn rule_for_id(rule_id: &str) -> Option<Rule> {
    RULES.iter().copied().find(|rule| rule.id == rule_id)
}

/// Path components below `home`. Owner and tier decisions must never depend on
/// the account name: a user called `Marcus`, `Arcadia` or `luvi` must not turn
/// every cache into "Arc" or "uv".
fn relative_components(path: &Path, home: &Path) -> Vec<String> {
    path.strip_prefix(home)
        .unwrap_or(path)
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(part) => Some(part.to_string_lossy().to_string()),
            _ => None,
        })
        .collect()
}

fn has_part(parts: &[String], predicate: impl Fn(&str) -> bool) -> bool {
    parts.iter().any(|part| predicate(part))
}

fn candidate_owner(rule: Rule, path: &Path, home: &Path) -> String {
    let parts = relative_components(path, home);
    let lower = |needle: &str| {
        has_part(&parts, |part: &str| {
            part.to_ascii_lowercase().contains(needle)
        })
    };
    let exact = |name: &str| has_part(&parts, |part: &str| part == name);
    match rule.id {
        "appcache" if lower("slack") => "Slack".into(),
        "appcache" if lower("figma") => "Figma".into(),
        "appcache" if exact("Arc") || lower("thebrowser") => "Arc".into(),
        "appcache" if exact("Claude") => "Claude".into(),
        "appcache" if lower("codex") => "Codex".into(),
        "appcache" if exact("ChatGPT") || exact("com.openai.chat") => "ChatGPT".into(),
        "appcache" if has_part(&parts, |part: &str| part.starts_with("Lark")) => "Lark".into(),
        "editors" if exact("Cursor") => "Cursor".into(),
        "editors" if exact("Code - Insiders") => "Code - Insiders".into(),
        "editors" => "Code".into(),
        "pkg" if exact("uv") => "uv".into(),
        "pkg" if has_part(&parts, |part: &str| part.starts_with("pnpm")) => "pnpm".into(),
        "pkg" if exact(".bun") => "Bun".into(),
        "pkg" if exact(".npm") || exact("npm-cache") => "npm".into(),
        "pkg" if exact("pip") => "pip".into(),
        "pkg" if exact("Homebrew") => "Homebrew".into(),
        _ => rule.owner.into(),
    }
}

fn is_service_worker_cache(path: &Path) -> bool {
    path.ends_with("Service Worker/CacheStorage")
}

fn is_playwright_browsers(path: &Path) -> bool {
    path.ends_with("Library/Caches/ms-playwright")
}

fn is_jetbrains_cache(path: &Path) -> bool {
    path.ends_with("Library/Caches/JetBrains")
}

fn candidate_tier(rule: Rule, path: &Path) -> Tier {
    if rule.id == "appcache" && is_service_worker_cache(path) {
        // Exact location is not a recovery contract for offline application
        // data. It is visible only after explicit review and never selected
        // automatically.
        Tier::Yellow
    } else if rule.id == "pkg" && (is_playwright_browsers(path) || is_jetbrains_cache(path)) {
        // Installed browser binaries and IDE indexes are expensive to
        // recreate; they are offered only after explicit review.
        Tier::Yellow
    } else {
        rule.tier
    }
}

fn candidate_reason(rule: Rule, path: &Path) -> String {
    if rule.id == "appcache" && is_service_worker_cache(path) {
        "Service Worker CacheStorage needs explicit review; Deslop never selects it automatically."
            .into()
    } else if rule.id == "pkg" && is_playwright_browsers(path) {
        "installed browser binaries for Playwright; re-download required".into()
    } else if rule.id == "pkg" && is_jetbrains_cache(path) {
        "IDE indexes rebuild slowly".into()
    } else {
        rule.note.into()
    }
}

fn candidate_restore(rule: Rule, path: &Path) -> Option<String> {
    if rule.id == "pkg" && is_playwright_browsers(path) {
        Some("npx playwright install".into())
    } else if rule.id == "pkg" && is_jetbrains_cache(path) {
        Some("Reopen the JetBrains IDE; it rebuilds its indexes.".into())
    } else {
        rule.restore.map(str::to_string)
    }
}

fn executable_from_path(program: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join(program);
        if candidate.is_file() {
            if let Ok(canonical) = candidate.canonicalize() {
                return Some(canonical);
            }
        }
        #[cfg(windows)]
        {
            let candidate = directory.join(format!("{program}.exe"));
            if candidate.is_file() {
                if let Ok(canonical) = candidate.canonicalize() {
                    return Some(canonical);
                }
            }
        }
    }
    None
}

fn native_tool_snapshot(kind: NativeToolKind, home: &Path) -> Result<NativeToolSnapshot, String> {
    let executable = executable_from_path(kind.program())
        .ok_or_else(|| format!("{} is not installed", kind.program()))?;
    let (canonical_executable, executable_meta) = safe_metadata(&executable)
        .map_err(|error| format!("{} executable is not safe: {error}", kind.program()))?;
    if !executable_meta.is_file() {
        return Err(format!("{} executable is not a file", kind.program()));
    }
    let executable_identity = file_identity_from_path(&canonical_executable, &executable_meta)?;
    let mut version_command = Command::new(&canonical_executable);
    version_command.arg("--version");
    let version_output = output_with_timeout(&mut version_command, EXTERNAL_PROBE_TIMEOUT)
        .map_err(|_| format!("{} version check failed", kind.program()))?;
    if !version_output.status.success() {
        return Err(format!("{} version check failed", kind.program()));
    }
    let version = String::from_utf8(version_output.stdout)
        .map_err(|_| format!("{} version output is not valid UTF-8", kind.program()))?
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();
    if version.is_empty() {
        return Err(format!("{} version is unavailable", kind.program()));
    }
    let mut scope_command = Command::new(&canonical_executable);
    scope_command.args(kind.scope_args());
    let scope_output = output_with_timeout(&mut scope_command, EXTERNAL_PROBE_TIMEOUT)
        .map_err(|_| format!("{} scope check failed", kind.label()))?;
    if !scope_output.status.success() {
        return Err(format!("{} scope check failed", kind.label()));
    }
    let scope_raw = String::from_utf8(scope_output.stdout)
        .map_err(|_| format!("{} scope output is not valid UTF-8", kind.label()))?;
    let scope_text = scope_raw
        .lines()
        .find(|line| !line.trim().is_empty())
        .map(str::trim)
        .ok_or_else(|| format!("{} did not report a cache scope", kind.label()))?;
    let (scope, scope_meta) = safe_metadata(Path::new(scope_text))
        .map_err(|error| format!("{} scope is not safe: {error}", kind.label()))?;
    if !scope.starts_with(home) || !scope_meta.is_dir() {
        return Err(format!(
            "{} scope is outside the safe HOME boundary",
            kind.label()
        ));
    }
    let scope_identity = file_identity_from_path(&scope, &scope_meta)?;
    Ok(NativeToolSnapshot {
        kind,
        executable: canonical_executable,
        executable_identity,
        scope,
        scope_identity,
        version,
    })
}

fn add_native_tool_candidates(
    state: &EngineState,
    snapshot_id: &str,
    candidates: &mut BTreeMap<String, CandidateInternal>,
) {
    let Some(rule) = rule_for_id("pkg") else {
        return;
    };
    for kind in [NativeToolKind::PnpmStorePrune, NativeToolKind::UvCachePrune] {
        let Ok(native_tool) = native_tool_snapshot(kind, &state.home) else {
            continue;
        };
        if candidates.values().any(|candidate| {
            candidate.canonical_path == native_tool.scope
                && candidate.action == ActionMethod::NativeTool
        }) {
            continue;
        }
        let id = state.next_id("candidate");
        candidates.insert(id.clone(), CandidateInternal {
            id,
            snapshot_id: snapshot_id.into(),
            rule_id: rule.id.into(),
            owner: match kind { NativeToolKind::PnpmStorePrune => "pnpm", NativeToolKind::UvCachePrune => "uv" }.into(),
            tier: Tier::Yellow,
            action: ActionMethod::NativeTool,
            required_probe: ProbeRequirement::Owner,
            native_tool: Some(native_tool.clone()),
            project_root: None,
            project_artifact: None,
            canonical_path: native_tool.scope.clone(),
            identity: native_tool.scope_identity.clone(),
            // A native prune can affect the entire reported store but does not
            // promise to reclaim its full current size.
            size: 0,
            size_known: false,
            reason: format!("{} runs the installed tool's own prune operation; it may affect unused data across this reported store.", kind.label()),
            scope: format!("{} {} — reported store: {}", kind.label(), native_tool.version, native_tool.scope.display()),
            restore: Some("Run the package tool again to download any pruned data.".into()),
            policy_fingerprint: POLICY_FINGERPRINT.into(),
        });
    }
}

fn validate_native_tool(candidate: &CandidateInternal, home: &Path) -> Result<(), String> {
    let expected = candidate
        .native_tool
        .as_ref()
        .ok_or("native tool snapshot is missing")?;
    let current = native_tool_snapshot(expected.kind, home)?;
    if current.executable != expected.executable
        || current.executable_identity != expected.executable_identity
    {
        return Err("native tool executable changed since review".into());
    }
    if current.scope != expected.scope || current.scope_identity != expected.scope_identity {
        return Err("native tool scope changed since review".into());
    }
    Ok(())
}

fn execute_native_tool(candidate: &CandidateInternal) -> Result<(), String> {
    let native = candidate
        .native_tool
        .as_ref()
        .ok_or("native tool snapshot is missing")?;
    let mut command = Command::new(&native.executable);
    command.args(native.kind.execute_args());
    let output =
        output_with_timeout(&mut command, NATIVE_TOOL_TIMEOUT).map_err(|error| match error {
            MeasurementCommandError::TimedOut => {
                format!("{} timed out and was stopped", native.kind.label())
            }
            MeasurementCommandError::Failed => format!("{} could not start", native.kind.label()),
        })?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if detail.is_empty() {
            format!("{} failed", native.kind.label())
        } else {
            format!("{} failed: {detail}", native.kind.label())
        })
    }
}

struct ProjectArtifactInspection {
    newest_modified: SystemTime,
}

fn project_marker(root: &Path, name: &str) -> bool {
    safe_metadata(&root.join(name)).is_ok_and(|(_, meta)| meta.is_file())
}

fn project_has_next_dependency(root: &Path) -> Result<bool, String> {
    let manifest = root.join("package.json");
    let metadata =
        fs::metadata(&manifest).map_err(|_| "package.json is unavailable".to_string())?;
    if metadata.len() > 1_048_576 {
        return Err("package.json exceeds the bounded project check".into());
    }
    let bytes = fs::read(manifest).map_err(|_| "package.json could not be read".to_string())?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "package.json is not valid JSON".to_string())?;
    Ok([
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
    ]
    .iter()
    .any(|key| {
        value
            .get(key)
            .and_then(|value| value.as_object())
            .is_some_and(|map| map.contains_key("next"))
    }))
}

fn secured_git_command(root: &Path) -> Result<Command, String> {
    let git = executable_from_path("git")
        .ok_or("git is unavailable; project artifact cleanup is disabled")?;
    let mut command = Command::new(git);
    // Do not inherit a caller's GIT_DIR/GIT_WORK_TREE/config redirects. The
    // repository itself may still be a worktree, but its resolved top level
    // must equal the selected project root before any tracked-file query.
    command.env_clear();
    command.env("LC_ALL", "C");
    command.env("GIT_CONFIG_NOSYSTEM", "1");
    command.env("GIT_CONFIG_GLOBAL", "/dev/null");
    command.arg("--no-optional-locks").arg("-C").arg(root);
    Ok(command)
}

fn verified_git_project_root(root: &Path) -> Result<(), String> {
    let mut command = secured_git_command(root)?;
    command.args(["rev-parse", "--show-toplevel"]);
    let output = output_with_timeout(&mut command, EXTERNAL_PROBE_TIMEOUT)
        .map_err(|_| "project Git root check timed out or failed".to_string())?;
    if !output.status.success() {
        return Err("selected root is not a verifiable Git project".into());
    }
    let reported = String::from_utf8(output.stdout)
        .map_err(|_| "Git root output is invalid".to_string())?
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();
    let (canonical, meta) = safe_metadata(Path::new(&reported))
        .map_err(|_| "Git reported an unsafe project root".to_string())?;
    if !meta.is_dir() || canonical != root {
        return Err("Git configuration resolves outside the selected project root".into());
    }
    Ok(())
}

fn project_artifact_has_tracked_files(root: &Path, artifact: &Path) -> Result<bool, String> {
    let relative = artifact
        .strip_prefix(root)
        .map_err(|_| "artifact escaped the selected project root")?;
    let mut command = secured_git_command(root)?;
    command
        .arg("ls-files")
        .arg("--full-name")
        .arg("--")
        .arg(relative);
    let output = output_with_timeout(&mut command, EXTERNAL_PROBE_TIMEOUT)
        .map_err(|_| "tracked-file check timed out or failed".to_string())?;
    if !output.status.success() {
        return Err("tracked-file check did not complete".into());
    }
    Ok(!output.stdout.is_empty())
}

fn is_project_protected_name(name: &str) -> bool {
    name == ".git"
        || name == ".env"
        || name.starts_with(".env.")
        || name.eq_ignore_ascii_case("id_rsa")
        || name.eq_ignore_ascii_case("credentials.json")
        || name.ends_with(".pem")
        || name.ends_with(".key")
}

fn inspect_project_artifact(
    root: &Path,
    artifact: &Path,
) -> Result<ProjectArtifactInspection, String> {
    const MAX_PROJECT_ARTIFACT_ENTRIES: usize = 50_000;
    if project_artifact_has_tracked_files(root, artifact)? {
        return Err("artifact contains Git-tracked files".into());
    }
    let mut pending = vec![artifact.to_path_buf()];
    let mut visited = 0usize;
    let mut newest_modified = UNIX_EPOCH;
    while let Some(current) = pending.pop() {
        visited += 1;
        if visited > MAX_PROJECT_ARTIFACT_ENTRIES {
            return Err("artifact protection check exceeded its bounded budget".into());
        }
        let metadata = fs::symlink_metadata(&current)
            .map_err(|_| "artifact protection check could not read a path".to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("artifact contains a symbolic link".into());
        }
        if let Ok(modified) = metadata.modified() {
            newest_modified = newest_modified.max(modified);
        }
        let name = current
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if current != artifact && is_project_protected_name(name) {
            return Err("artifact contains a protected file or nested repository marker".into());
        }
        if metadata.is_dir() {
            let entries = fs::read_dir(&current).map_err(|_| {
                "artifact protection check could not enumerate a directory".to_string()
            })?;
            for entry in entries {
                pending.push(
                    entry
                        .map_err(|_| {
                            "artifact protection check found an unreadable entry".to_string()
                        })?
                        .path(),
                );
            }
        }
    }
    Ok(ProjectArtifactInspection { newest_modified })
}

fn add_project_artifact_candidates(
    state: &EngineState,
    snapshot_id: &str,
    roots: &[PathBuf],
    candidates: &mut BTreeMap<String, CandidateInternal>,
) {
    let Some(rule) = rule_for_id("project") else {
        return;
    };
    for requested_root in roots {
        let Ok((root, root_meta)) = safe_metadata(requested_root) else {
            continue;
        };
        if !root_meta.is_dir() || !root.starts_with(&state.home) || is_protected(&root) {
            continue;
        }
        if verified_git_project_root(&root).is_err() {
            continue;
        }
        let is_node = project_marker(&root, "package.json");
        let is_rust = project_marker(&root, "Cargo.toml");
        let is_next = is_node && project_has_next_dependency(&root).unwrap_or(false);
        for kind in [
            ProjectArtifactKind::NodeModules,
            ProjectArtifactKind::CargoTarget,
            ProjectArtifactKind::NextBuild,
        ] {
            let context_matches = match kind {
                ProjectArtifactKind::NodeModules => is_node,
                ProjectArtifactKind::CargoTarget => is_rust,
                ProjectArtifactKind::NextBuild => is_next,
            };
            if !context_matches {
                continue;
            }
            let path = root.join(kind.directory());
            let Ok((canonical_path, metadata)) = safe_metadata(&path) else {
                continue;
            };
            if !metadata.is_dir() || !canonical_path.starts_with(&root) || canonical_path == root {
                continue;
            }
            let Ok(inspection) = inspect_project_artifact(&root, &canonical_path) else {
                continue;
            };
            let Ok(identity) = file_identity_from_path(&canonical_path, &metadata) else {
                continue;
            };
            let recent = current_unix_seconds().saturating_sub(
                inspection
                    .newest_modified
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
            ) < 7 * 24 * 60 * 60;
            let id = state.next_id("candidate");
            candidates.insert(id.clone(), CandidateInternal {
                id,
                snapshot_id: snapshot_id.into(),
                rule_id: rule.id.into(),
                owner: kind.owner().into(),
                tier: if recent { Tier::Yellow } else { Tier::Green },
                action: ActionMethod::Delete,
                required_probe: ProbeRequirement::Owner,
                native_tool: None,
                project_root: Some(root.clone()),
                project_artifact: Some(kind),
                canonical_path,
                identity,
                size: 0,
                size_known: false,
                reason: if recent { "This selected project artifact changed in the last 7 days, so it requires explicit review.".into() } else { "Confirmed project build artifact under a selected Git project root.".into() },
                scope: format!("Selected project root: {}", root.display()),
                restore: Some(kind.restore().into()),
                policy_fingerprint: POLICY_FINGERPRINT.into(),
            });
        }
    }
}

fn validate_project_artifact(candidate: &CandidateInternal, home: &Path) -> Result<(), String> {
    let root = candidate
        .project_root
        .as_ref()
        .ok_or("project root snapshot is missing")?;
    let kind = candidate
        .project_artifact
        .ok_or("project artifact type is missing")?;
    let (canonical_root, meta) = safe_metadata(root)?;
    if !meta.is_dir() || canonical_root != *root || !root.starts_with(home) {
        return Err("selected project root changed since review".into());
    }
    verified_git_project_root(root)?;
    let expected = root.join(kind.directory());
    if expected != candidate.canonical_path {
        return Err("project artifact scope changed since review".into());
    }
    inspect_project_artifact(root, &candidate.canonical_path)?;
    Ok(())
}

#[cfg(unix)]
fn logical_bytes_with_dedupe(
    path: &Path,
    seen: &mut BTreeSet<(u64, u64)>,
    cancelled: &AtomicBool,
) -> Result<(u64, bool), String> {
    use std::os::unix::fs::MetadataExt;
    let mut pending = vec![path.to_path_buf()];
    let mut bytes = 0;
    let mut partial = false;
    while let Some(current) = pending.pop() {
        if cancelled.load(Ordering::Relaxed) {
            return Err("scan cancelled".into());
        }
        #[cfg(windows)]
        if windows_path_safety(&current).is_err() {
            partial = true;
            continue;
        }
        let meta = match fs::symlink_metadata(&current) {
            Ok(meta) => meta,
            Err(_) => {
                partial = true;
                continue;
            }
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_file() {
            if seen.insert((meta.dev(), meta.ino())) {
                bytes += meta.len();
            }
            continue;
        }
        let entries = match fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(_) => {
                partial = true;
                continue;
            }
        };
        for entry in entries {
            match entry {
                Ok(entry) => pending.push(entry.path()),
                Err(_) => partial = true,
            }
        }
    }
    Ok((bytes, partial))
}

#[cfg(not(unix))]
fn logical_bytes_with_dedupe(
    path: &Path,
    seen: &mut SeenFiles,
    cancelled: &AtomicBool,
) -> Result<(u64, bool), String> {
    let mut pending = vec![path.to_path_buf()];
    let mut bytes = 0;
    let mut partial = false;
    while let Some(current) = pending.pop() {
        if cancelled.load(Ordering::Relaxed) {
            return Err("scan cancelled".into());
        }
        #[cfg(windows)]
        if windows_path_safety(&current).is_err() {
            partial = true;
            continue;
        }
        let meta = match fs::symlink_metadata(&current) {
            Ok(meta) => meta,
            Err(_) => {
                partial = true;
                continue;
            }
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_file() {
            #[cfg(windows)]
            let key = match file_identity_from_path(&current, &meta) {
                Ok(identity) => (identity.volume, identity.file_id),
                Err(_) => {
                    partial = true;
                    continue;
                }
            };
            #[cfg(not(windows))]
            let key = current;
            if seen.insert(key) {
                bytes += meta.len();
            }
            continue;
        }
        let entries = match fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(_) => {
                partial = true;
                continue;
            }
        };
        for entry in entries {
            match entry {
                Ok(entry) => pending.push(entry.path()),
                Err(_) => partial = true,
            }
        }
    }
    Ok((bytes, partial))
}

fn assign_candidate_measurements(
    candidates: &mut BTreeMap<String, CandidateInternal>,
    cancelled: &AtomicBool,
) -> Result<bool, String> {
    let mut ids: Vec<String> = candidates.keys().cloned().collect();
    ids.sort_by(|left, right| {
        candidates[left]
            .canonical_path
            .cmp(&candidates[right].canonical_path)
    });
    let mut partial = false;
    #[cfg(unix)]
    let mut seen = BTreeSet::<(u64, u64)>::new();
    #[cfg(not(unix))]
    let mut seen = SeenFiles::new();
    for id in ids {
        let candidate = candidates.get_mut(&id).ok_or("candidate disappeared")?;
        if candidate.action == ActionMethod::NativeTool {
            // A tool-owned prune has an intentionally unknown reclaim size;
            // never turn the whole current store size into a promise.
            candidate.size = 0;
            candidate.size_known = false;
            continue;
        }
        let (bytes, was_partial) =
            logical_bytes_with_dedupe(&candidate.canonical_path, &mut seen, cancelled)?;
        candidate.size = bytes;
        candidate.size_known = !was_partial;
        partial |= was_partial;
    }
    Ok(partial)
}

fn current_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn current_platform() -> &'static str {
    #[cfg(windows)]
    {
        "windows"
    }
    #[cfg(not(windows))]
    {
        "macos"
    }
}

fn cleanup_breakdown_snapshot(
    snapshot_id: &str,
    home: &Path,
    candidates: &BTreeMap<String, CandidateInternal>,
    skipped_roots: &[String],
    measurement_partial: bool,
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
    for candidate in accepted_roots {
        let Some(rule) = rule_for_id(&candidate.rule_id) else {
            continue;
        };
        let total = totals.entry(rule.cleanup_category).or_insert((0, 0));
        total.0 += 1;
        total.1 += candidate.size;
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
        is_partial: !skipped_roots.is_empty() || invalid_candidates > 0 || measurement_partial,
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
    let (validated_roots, skipped_roots) = canonical_roots(roots, &state.home); // root input is validated but is not a delete authority except in explicit project-artifact mode.
    let wanted: Option<BTreeSet<String>> = only.map(|items| items.into_iter().collect());
    let mut candidates = BTreeMap::new();
    let selected_rules: Vec<Rule> = RULES
        .iter()
        .copied()
        .filter(|rule| rule.supported_on.contains(&current_platform()))
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
    if wanted.as_ref().is_none_or(|items| items.contains("pkg")) {
        add_native_tool_candidates(state, &snapshot_id, &mut candidates);
    }
    if wanted
        .as_ref()
        .is_some_and(|items| items.contains("project"))
    {
        add_project_artifact_candidates(state, &snapshot_id, &validated_roots, &mut candidates);
    }
    let measurement_partial = assign_candidate_measurements(&mut candidates, cancelled)?;
    let mut categories = Vec::new();
    for rule in RULES {
        if rule.id == "project" {
            let mut by_root = BTreeMap::<PathBuf, Vec<&CandidateInternal>>::new();
            for candidate in candidates
                .values()
                .filter(|candidate| candidate.rule_id == rule.id)
            {
                if let Some(root) = &candidate.project_root {
                    by_root.entry(root.clone()).or_default().push(candidate);
                }
            }
            for (root, group) in by_root {
                let mut entries: Vec<Entry> = group
                    .into_iter()
                    .map(|candidate| Entry {
                        id: candidate.id.clone(),
                        path: candidate.canonical_path.to_string_lossy().to_string(),
                        size: candidate.size,
                        size_known: candidate.size_known,
                        reason: candidate.reason.clone(),
                        scope: candidate.scope.clone(),
                        restore: candidate.restore.clone(),
                        tier: candidate.tier,
                    })
                    .collect();
                entries.sort_by(|a, b| b.size.cmp(&a.size));
                let total = entries.iter().map(|entry| entry.size).sum();
                let tier = if candidates.values().any(|candidate| {
                    candidate.project_root.as_ref() == Some(&root) && candidate.tier == Tier::Yellow
                }) {
                    Tier::Yellow
                } else {
                    Tier::Green
                };
                categories.push(Category {
                    id: format!("project:{}", root.display()),
                    title: format!(
                        "Project artifacts — {}",
                        root.file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or("selected project")
                    ),
                    tier,
                    note: rule.note.into(),
                    manual: rule.restore.map(str::to_string),
                    entries,
                    total,
                });
            }
            continue;
        }
        let mut entries: Vec<Entry> = candidates
            .values()
            .filter(|candidate| candidate.rule_id == rule.id)
            .map(|candidate| Entry {
                id: candidate.id.clone(),
                path: candidate.canonical_path.to_string_lossy().to_string(),
                size: candidate.size,
                size_known: candidate.size_known,
                reason: candidate.reason.clone(),
                scope: candidate.scope.clone(),
                restore: candidate.restore.clone(),
                tier: candidate.tier,
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
    let breakdown = cleanup_breakdown_snapshot(
        &snapshot_id,
        &state.home,
        &candidates,
        &skipped_roots,
        measurement_partial,
    );
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
    if is_never_name(name) {
        return Err("protected name".into());
    }
    let current = file_identity_from_path(&canonical, &meta)?;
    if current != candidate.identity {
        return Err("file identity changed since scan".into());
    }
    if candidate.action == ActionMethod::NativeTool {
        validate_native_tool(candidate, home)?;
    }
    if candidate.project_root.is_some() {
        validate_project_artifact(candidate, home)?;
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ProbeState {
    Idle,
    Busy(Vec<String>),
    Unknown {
        reason_code: &'static str,
        detail: String,
    },
}

/// OS-facing state is isolated so the policy can be fixture-tested without
/// invoking `pgrep`/`ps`/`lsof`/`tasklist`. A probe failure is deliberately
/// not an idle result.
trait SafetyProbe {
    fn owner_state(&self, owner: &str) -> ProbeState;
    fn sqlite_state(&self, candidate: &Path) -> ProbeState;
    /// Chromium/Electron profile lock of the owner. The default is the real
    /// check below `home`; a fixture home without a lock file is inert.
    fn singleton_lock_state(&self, owner: &str, candidate: &Path, home: &Path) -> ProbeState {
        system_singleton_lock_state(owner, candidate, home)
    }
    /// Allocated bytes of a path, measured immediately before the effect.
    fn allocated_bytes(&self, path: &Path) -> Option<u64> {
        du_bytes(path)
    }
}

struct SystemSafetyProbe;

/// Process names whose presence means the owner may be writing the cache.
/// Generic runtimes (`node`, `python`, `python3`) are deliberately absent:
/// a developer almost always has one running (Claude Code, language servers)
/// and that says nothing about a content-addressed package cache (F-02).
#[cfg_attr(windows, allow(dead_code))]
fn process_names_for_owner(owner: &str) -> Vec<&'static str> {
    match owner {
        "Cursor" => vec![
            "Cursor",
            "Cursor Helper",
            "Cursor Helper (Renderer)",
            "Cursor Helper (GPU)",
        ],
        "Code" => vec![
            "Code",
            "Code Helper",
            "Code Helper (Renderer)",
            "Code Helper (GPU)",
        ],
        "Code - Insiders" => vec!["Code - Insiders", "Code - Insiders Helper"],
        "Slack" => vec![
            "Slack",
            "Slack Helper",
            "Slack Helper (Renderer)",
            "Slack Helper (GPU)",
        ],
        "Figma" => vec!["Figma", "Figma Helper", "Figma Helper (Renderer)"],
        "Arc" => vec![
            "Arc",
            "Arc Helper",
            "Arc Helper (Renderer)",
            "Arc Helper (GPU)",
        ],
        "Claude" => vec!["Claude", "Claude Helper", "claude"],
        "Codex" => vec!["Codex", "Codex Helper", "codex"],
        "ChatGPT" => vec!["ChatGPT", "ChatGPT Helper"],
        "Lark" => vec!["Lark", "Lark Helper"],
        "Xcode" => vec![
            "Xcode",
            "xcodebuild",
            "xctest",
            "XCTRunner",
            "XCBBuildService",
            "swift-frontend",
        ],
        "pnpm" => vec!["pnpm"],
        "npm" => vec!["npm"],
        "Bun" => vec!["bun"],
        "uv" => vec!["uv"],
        "pip" => vec!["pip", "pip3"],
        "Homebrew" => vec!["brew", "ruby"],
        "Hugging Face" => vec!["huggingface-cli", "hf"],
        "Project Node build" => vec!["pnpm", "npm", "npx", "yarn", "bun"],
        "Project Rust build" => vec!["cargo", "rustc", "build-script-build"],
        _ => Vec::new(),
    }
}

#[cfg(not(windows))]
impl SafetyProbe for SystemSafetyProbe {
    fn owner_state(&self, owner: &str) -> ProbeState {
        let names = process_names_for_owner(owner);
        if names.is_empty() {
            return ProbeState::Idle;
        }
        let mut busy = Vec::new();
        let mut unknown: Option<(&'static str, String)> = None;
        for name in names {
            let mut command = Command::new("pgrep");
            command.arg("-x").arg(name);
            match output_with_timeout(&mut command, EXTERNAL_PROBE_TIMEOUT) {
                Ok(output) if output.status.success() => busy.push(name.to_string()),
                Ok(output) if output.status.code() == Some(1) => {}
                Ok(_) => {
                    unknown = Some((
                        "process_probe_unavailable",
                        format!("process check for {name} returned an unexpected status"),
                    ))
                }
                Err(MeasurementCommandError::TimedOut) => {
                    unknown = Some((
                        "process_probe_timeout",
                        format!("process check for {name} timed out"),
                    ))
                }
                Err(MeasurementCommandError::Failed) => {
                    unknown = Some((
                        "process_probe_unavailable",
                        format!("process check for {name} is unavailable"),
                    ))
                }
            }
        }
        if !busy.is_empty() {
            ProbeState::Busy(busy)
        } else if let Some((reason_code, detail)) = unknown {
            ProbeState::Unknown {
                reason_code,
                detail,
            }
        } else {
            ProbeState::Idle
        }
    }

    fn sqlite_state(&self, candidate: &Path) -> ProbeState {
        system_sqlite_state(candidate)
    }
}

/// Windows has no `pgrep`; `tasklist` gives the same three-state answer.
#[cfg(windows)]
impl SafetyProbe for SystemSafetyProbe {
    fn owner_state(&self, owner: &str) -> ProbeState {
        use std::os::windows::process::CommandExt;
        // Keep the GUI app from flashing a console window for every probe.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let images = windows_image_names_for_owner(owner);
        if images.is_empty() {
            return ProbeState::Idle;
        }
        let mut busy = Vec::new();
        let mut unknown: Option<(&'static str, String)> = None;
        for image in images {
            let mut command = Command::new("tasklist");
            command
                .arg("/FI")
                .arg(format!("IMAGENAME eq {image}"))
                .args(["/FO", "CSV", "/NH"])
                .creation_flags(CREATE_NO_WINDOW);
            match output_with_timeout(&mut command, WINDOWS_PROCESS_PROBE_TIMEOUT) {
                Ok(output) if output.status.success() => {
                    if tasklist_lists_image(&String::from_utf8_lossy(&output.stdout), image) {
                        busy.push(image.to_string());
                    }
                }
                Ok(_) => {
                    unknown = Some((
                        "process_probe_unavailable",
                        format!("process check for {image} returned an unexpected status"),
                    ))
                }
                Err(MeasurementCommandError::TimedOut) => {
                    unknown = Some((
                        "process_probe_timeout",
                        format!("process check for {image} timed out"),
                    ))
                }
                Err(MeasurementCommandError::Failed) => {
                    unknown = Some((
                        "process_probe_unavailable",
                        format!("process check for {image} is unavailable"),
                    ))
                }
            }
        }
        if !busy.is_empty() {
            ProbeState::Busy(busy)
        } else if let Some((reason_code, detail)) = unknown {
            ProbeState::Unknown {
                reason_code,
                detail,
            }
        } else {
            ProbeState::Idle
        }
    }

    /// There is no `lsof` on Windows. It is also not needed there: Windows
    /// refuses to delete a file another process holds open without
    /// `FILE_SHARE_DELETE`, so an in-use database surfaces as a per-entry
    /// error instead of a silent unlink. The owner check above has already
    /// passed when this runs.
    fn sqlite_state(&self, _candidate: &Path) -> ProbeState {
        ProbeState::Idle
    }
}

#[cfg(windows)]
const WINDOWS_PROCESS_PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// Windows image names per owner. `npm`/`yarn` run as `*.cmd` scripts under
/// the generic `node.exe`, which is never used as evidence (see
/// `process_names_for_owner`), so those owners have no image to check.
#[cfg(any(windows, test))]
fn windows_image_names_for_owner(owner: &str) -> Vec<&'static str> {
    match owner {
        "Cursor" => vec!["Cursor.exe"],
        "Code" => vec!["Code.exe"],
        "Code - Insiders" => vec!["Code - Insiders.exe"],
        "Slack" => vec!["slack.exe"],
        "Figma" => vec!["Figma.exe"],
        "Arc" => vec!["Arc.exe"],
        "Claude" => vec!["claude.exe"],
        "Codex" => vec!["codex.exe"],
        "ChatGPT" => vec!["ChatGPT.exe"],
        "Lark" => vec!["Lark.exe"],
        "pnpm" => vec!["pnpm.exe"],
        "Bun" => vec!["bun.exe"],
        "uv" => vec!["uv.exe"],
        "pip" => vec!["pip.exe", "pip3.exe"],
        "Project Node build" => vec!["pnpm.exe", "bun.exe"],
        "Project Rust build" => vec!["cargo.exe", "rustc.exe"],
        _ => Vec::new(),
    }
}

/// `tasklist /FO CSV /NH` prints one quoted CSV row per match and a localized
/// "INFO: ..." line when nothing matches, so only a quoted first field that
/// equals the image name counts as a running process.
#[cfg(any(windows, test))]
fn tasklist_lists_image(stdout: &str, image: &str) -> bool {
    stdout.lines().any(|line| {
        line.trim()
            .strip_prefix('"')
            .and_then(|rest| rest.split_once('"'))
            .is_some_and(|(name, _)| name.eq_ignore_ascii_case(image))
    })
}

/// Windows has no `SingletonLock` symlink (the file there carries no pid), so
/// the lock check is skipped and `tasklist` is the owner evidence.
#[cfg(windows)]
fn system_singleton_lock_state(_owner: &str, _candidate: &Path, _home: &Path) -> ProbeState {
    ProbeState::Idle
}

#[cfg(not(windows))]
fn system_singleton_lock_state(owner: &str, candidate: &Path, home: &Path) -> ProbeState {
    singleton_lock_state_for_dirs(owner, &singleton_lock_dirs(owner, candidate, home))
}

/// Chromium "user data" directories whose `SingletonLock` proves a live
/// instance of the owner. When the candidate lives inside one of them, only
/// those directories are consulted (so a Slack cache never touches the
/// sandbox container of a different Slack install).
#[cfg(not(windows))]
fn singleton_lock_dirs(owner: &str, candidate: &Path, home: &Path) -> Vec<PathBuf> {
    const MAX_PROFILE_DIRS: usize = 32;
    let support = home.join("Library/Application Support");
    let mut dirs = match owner {
        "Cursor" => vec![support.join("Cursor")],
        "Code" => vec![support.join("Code")],
        "Code - Insiders" => vec![support.join("Code - Insiders")],
        "Slack" => vec![
            support.join("Slack"),
            home.join(
                "Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack",
            ),
        ],
        "Figma" => vec![support.join("Figma")],
        "Arc" => vec![support.join("Arc/User Data"), support.join("Arc")],
        "Claude" => vec![support.join("Claude")],
        "Codex" => vec![support.join("Codex")],
        "ChatGPT" => vec![support.join("ChatGPT"), support.join("com.openai.chat")],
        "Lark" => vec![support.join("LarkInternational"), support.join("Lark")],
        _ => Vec::new(),
    };
    if owner == "Figma" {
        if let Ok(entries) = fs::read_dir(support.join("Figma/DesktopProfile")) {
            for entry in entries.flatten().take(MAX_PROFILE_DIRS) {
                if entry.file_name().to_string_lossy().starts_with('v') {
                    dirs.push(entry.path());
                }
            }
        }
    }
    let related: Vec<PathBuf> = dirs
        .iter()
        .filter(|dir| candidate.starts_with(dir))
        .cloned()
        .collect();
    if related.is_empty() {
        dirs
    } else {
        related
    }
}

#[cfg(not(windows))]
enum SingletonLock {
    Absent,
    Pid(u32),
    Unreadable(String),
}

/// Chromium writes `SingletonLock` as a symlink whose target is
/// `<hostname>-<pid>`. The pid is the last `-`-separated field because host
/// names may themselves contain dashes.
#[cfg(not(windows))]
fn parse_singleton_lock_target(target: &str) -> Option<u32> {
    let (_host, pid) = target.rsplit_once('-')?;
    pid.parse::<u32>().ok().filter(|pid| *pid > 0)
}

#[cfg(not(windows))]
fn read_singleton_lock(dir: &Path) -> SingletonLock {
    let lock = dir.join("SingletonLock");
    match fs::symlink_metadata(&lock) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => SingletonLock::Absent,
        Err(error) => {
            SingletonLock::Unreadable(format!("{} could not be read: {error}", lock.display()))
        }
        Ok(_) => match fs::read_link(&lock) {
            Ok(target) => match parse_singleton_lock_target(&target.to_string_lossy()) {
                Some(pid) => SingletonLock::Pid(pid),
                None => SingletonLock::Unreadable(format!(
                    "{} does not name an owner process",
                    lock.display()
                )),
            },
            Err(error) => SingletonLock::Unreadable(format!(
                "{} is not a readable lock: {error}",
                lock.display()
            )),
        },
    }
}

/// `ps -p` answers for any user's process (unlike `kill -0`, which fails with
/// EPERM), exits 1 when the pid does not exist, and needs no libc binding.
#[cfg(not(windows))]
fn process_is_alive(pid: u32) -> Result<bool, (&'static str, String)> {
    let mut command = Command::new("ps");
    command.arg("-p").arg(pid.to_string()).arg("-o").arg("pid=");
    match output_with_timeout(&mut command, EXTERNAL_PROBE_TIMEOUT) {
        Ok(output) if output.status.success() => {
            Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
        }
        Ok(output) if output.status.code() == Some(1) => Ok(false),
        Ok(_) => Err((
            "process_probe_unavailable",
            format!("process check for pid {pid} returned an unexpected status"),
        )),
        Err(MeasurementCommandError::TimedOut) => Err((
            "process_probe_timeout",
            format!("process check for pid {pid} timed out"),
        )),
        Err(MeasurementCommandError::Failed) => Err((
            "process_probe_unavailable",
            format!("process check for pid {pid} is unavailable"),
        )),
    }
}

/// Live pid → busy; no lock or a dead pid (stale lock after a crash) → idle;
/// an unreadable or unparsable lock → unknown.
#[cfg(not(windows))]
fn singleton_lock_state_for_dirs(owner: &str, dirs: &[PathBuf]) -> ProbeState {
    let mut unknown: Option<(&'static str, String)> = None;
    for dir in dirs {
        match read_singleton_lock(dir) {
            SingletonLock::Absent => {}
            SingletonLock::Unreadable(detail) => unknown = Some(("lock_unreadable", detail)),
            SingletonLock::Pid(pid) => match process_is_alive(pid) {
                Ok(true) => {
                    return ProbeState::Busy(vec![format!(
                        "{owner} profile lock held by pid {pid}"
                    )])
                }
                Ok(false) => {}
                Err(reason) => unknown = Some(reason),
            },
        }
    }
    match unknown {
        Some((reason_code, detail)) => ProbeState::Unknown {
            reason_code,
            detail,
        },
        None => ProbeState::Idle,
    }
}

/// One `lsof` call for every SQLite family near the candidate root.
#[cfg(not(windows))]
fn system_sqlite_state(candidate: &Path) -> ProbeState {
    let files: Vec<PathBuf> = sqlite_families(candidate).into_iter().flatten().collect();
    if files.is_empty() {
        return ProbeState::Idle;
    }
    let mut command = Command::new("lsof");
    // `-w` suppresses warnings about unrelated mounts that would otherwise
    // make an idle answer look like a failure.
    command.arg("-w").arg("-Fpc").arg("--").args(&files);
    match output_with_timeout(&mut command, SQLITE_PROBE_TIMEOUT) {
        Ok(output) => {
            let holders = lsof_holders(&String::from_utf8_lossy(&output.stdout));
            if !holders.is_empty() {
                ProbeState::Busy(holders)
            } else if output.status.success() {
                ProbeState::Busy(vec![format!("SQLite database in {}", candidate.display())])
            } else if output.status.code() == Some(1) {
                // lsof exits 1 when none of the named files is open.
                ProbeState::Idle
            } else {
                ProbeState::Unknown {
                    reason_code: "sqlite_probe_unavailable",
                    detail: format!(
                        "open-file check for SQLite data in {} was incomplete",
                        candidate.display()
                    ),
                }
            }
        }
        Err(MeasurementCommandError::TimedOut) => ProbeState::Unknown {
            reason_code: "sqlite_probe_timeout",
            detail: format!(
                "open-file check for SQLite data in {} timed out",
                candidate.display()
            ),
        },
        Err(MeasurementCommandError::Failed) => ProbeState::Unknown {
            reason_code: "sqlite_probe_unavailable",
            detail: format!(
                "open-file check for SQLite data in {} is unavailable",
                candidate.display()
            ),
        },
    }
}

/// Process names (`c` lines) from `lsof -F`, falling back to pids (`p` lines).
#[cfg(not(windows))]
fn lsof_holders(stdout: &str) -> Vec<String> {
    let mut names = BTreeSet::new();
    let mut pids = BTreeSet::new();
    for line in stdout.lines() {
        if let Some(name) = line.strip_prefix('c') {
            names.insert(name.to_string());
        } else if let Some(pid) = line.strip_prefix('p') {
            pids.insert(format!("pid {pid}"));
        }
    }
    if names.is_empty() {
        pids.into_iter().collect()
    } else {
        names.into_iter().collect()
    }
}

/// Returns complete SQLite families at depth ≤ 2 below the candidate: a lone
/// old `-shm` file is not proof of an active database, and database contents
/// are never read. Chromium/Electron keep their databases at the profile root,
/// never inside `Cache_Data`, so the whole tree is not walked. Reaching the
/// entry bound or an unreadable entry means "checked what we could", never
/// "unknown" — a large cache must not be blocked by its size (F-01).
#[cfg_attr(windows, allow(dead_code))]
fn sqlite_families(candidate: &Path) -> Vec<Vec<PathBuf>> {
    const MAX_SQLITE_DEPTH: usize = 2;
    const MAX_SQLITE_DISCOVERY_ENTRIES: usize = 2_048;
    let mut pending = vec![(candidate.to_path_buf(), 0usize)];
    let mut bases = BTreeSet::new();
    let mut visited = 0usize;
    while let Some((current, depth)) = pending.pop() {
        visited += 1;
        if visited > MAX_SQLITE_DISCOVERY_ENTRIES {
            break;
        }
        let Ok(meta) = fs::symlink_metadata(&current) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            if depth >= MAX_SQLITE_DEPTH {
                continue;
            }
            let Ok(entries) = fs::read_dir(&current) else {
                continue;
            };
            let room = MAX_SQLITE_DISCOVERY_ENTRIES.saturating_sub(visited + pending.len());
            for entry in entries.flatten().take(room) {
                pending.push((entry.path(), depth + 1));
            }
            continue;
        }
        let Some(name) = current.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".db") || lower.ends_with(".sqlite") || lower.ends_with(".sqlite3") {
            bases.insert(current);
        }
    }
    bases
        .into_iter()
        .map(|base| {
            let mut family = vec![base.clone()];
            for suffix in ["-wal", "-shm"] {
                let companion = PathBuf::from(format!("{}{}", base.display(), suffix));
                if companion.exists() {
                    family.push(companion);
                }
            }
            family
        })
        .collect()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Admission {
    id: String,
    path: String,
    owner: String,
    state: String,
    reason_code: String,
    detail: String,
}

impl Admission {
    fn allowed(candidate: &CandidateInternal) -> Self {
        Self {
            id: candidate.id.clone(),
            path: candidate.canonical_path.to_string_lossy().to_string(),
            owner: candidate.owner.clone(),
            state: "allowed".into(),
            reason_code: "allowed".into(),
            detail: "Ready to clean after current safety checks.".into(),
        }
    }
    fn blocked(
        candidate: &CandidateInternal,
        state: &str,
        reason_code: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            id: candidate.id.clone(),
            path: candidate.canonical_path.to_string_lossy().to_string(),
            owner: candidate.owner.clone(),
            state: state.into(),
            reason_code: reason_code.into(),
            detail: detail.into(),
        }
    }
}

fn is_excluded(candidate: &CandidateInternal, exclusions: &ExclusionsDocument) -> bool {
    exclusions.entries.iter().any(|exclusion| {
        exclusion.rule_id == candidate.rule_id
            && exclusion.owner == candidate.owner
            && (candidate
                .canonical_path
                .starts_with(Path::new(&exclusion.path))
                || Path::new(&exclusion.path).starts_with(&candidate.canonical_path))
    })
}

fn candidate_admission(
    candidate: &CandidateInternal,
    home: &Path,
    exclusions: &ExclusionsDocument,
    probe: &dyn SafetyProbe,
) -> Admission {
    if let Err(detail) = validate_candidate(candidate, home) {
        return Admission::blocked(candidate, "protected", "identity_or_scope_changed", detail);
    }
    if is_excluded(candidate, exclusions) {
        return Admission::blocked(
            candidate,
            "protected",
            "excluded",
            "Protected by your cleanup exclusion.",
        );
    }
    if candidate.action == ActionMethod::Manual || candidate.tier == Tier::Red {
        return Admission::blocked(
            candidate,
            "protected",
            "manual_only",
            "This path needs manual review and is not deleted by Deslop.",
        );
    }
    if candidate.required_probe == ProbeRequirement::None {
        return Admission::allowed(candidate);
    }
    match probe.owner_state(&candidate.owner) {
        ProbeState::Idle => {}
        ProbeState::Busy(processes) => {
            return Admission::blocked(
                candidate,
                "busy",
                "owner_running",
                format!("{} is running ({})", candidate.owner, processes.join(", ")),
            )
        }
        ProbeState::Unknown {
            reason_code,
            detail,
        } => return Admission::blocked(candidate, "unknown", reason_code, detail),
    }
    if candidate.required_probe == ProbeRequirement::OwnerAndSqlite {
        match probe.singleton_lock_state(&candidate.owner, &candidate.canonical_path, home) {
            ProbeState::Idle => {}
            ProbeState::Busy(holders) => {
                return Admission::blocked(
                    candidate,
                    "busy",
                    "singleton_lock_live",
                    format!("{} is running ({})", candidate.owner, holders.join(", ")),
                )
            }
            ProbeState::Unknown {
                reason_code,
                detail,
            } => return Admission::blocked(candidate, "unknown", reason_code, detail),
        }
        match probe.sqlite_state(&candidate.canonical_path) {
            ProbeState::Idle => {}
            ProbeState::Busy(processes) => {
                return Admission::blocked(candidate, "busy", "sqlite_in_use", processes.join(", "))
            }
            ProbeState::Unknown {
                reason_code,
                detail,
            } => return Admission::blocked(candidate, "unknown", reason_code, detail),
        }
    }
    Admission::allowed(candidate)
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
    blocked_entries: Vec<Admission>,
    requires_yellow_confirmation: bool,
}

fn default_measurement() -> String {
    "unknown".into()
}

/// `status`: deleted | completed | partial | recreated | skipped | error | unknown.
/// `measurement`: allocated (du before the effect) | scanEstimate (the scan's
/// size, used when du timed out) | unknown.
#[derive(Clone, Deserialize, Serialize)]
struct CandidateOutcome {
    id: String,
    path: String,
    status: String,
    detail: String,
    freed: u64,
    /// Bytes still present after a failed or partial removal; 0 otherwise.
    #[serde(default)]
    remaining: u64,
    #[serde(default = "default_measurement")]
    measurement: String,
    /// Admission reason (same vocabulary as `Admission.reason_code`);
    /// `allowed` for every outcome whose effect was attempted.
    #[serde(default = "default_outcome_reason")]
    reason_code: String,
    #[serde(default)]
    owner: String,
}

fn default_outcome_reason() -> String {
    "allowed".into()
}

impl CandidateOutcome {
    fn without_effect(id: &str, path: &Path, status: &str, detail: String) -> Self {
        Self {
            id: id.into(),
            path: path.to_string_lossy().to_string(),
            status: status.into(),
            detail,
            freed: 0,
            remaining: 0,
            measurement: default_measurement(),
            reason_code: default_outcome_reason(),
            owner: String::new(),
        }
    }

    fn for_candidate(mut self, candidate: &CandidateInternal) -> Self {
        self.owner = candidate.owner.clone();
        self
    }

    fn skipped(candidate: &CandidateInternal, admission: Admission) -> Self {
        Self {
            reason_code: admission.reason_code,
            ..Self::without_effect(
                &candidate.id,
                &candidate.canonical_path,
                "skipped",
                admission.detail,
            )
            .for_candidate(candidate)
        }
    }
}

#[derive(Serialize)]
struct CleanResult {
    run_id: Option<String>,
    record_error: Option<String>,
    /// Sum of what Deslop removed by its own accounting (deleted, partial and
    /// recreated outcomes).
    freed: u64,
    freed_size_unknown: bool,
    /// Free space of the home volume before the first and after the last
    /// effect. `None` when the volume could not be measured. The delta can
    /// differ from `freed`: APFS snapshots and files held open by running
    /// applications keep blocks allocated after an unlink.
    free_space_before: Option<u64>,
    free_space_after: Option<u64>,
    free_space_delta: Option<i64>,
    outcomes: Vec<CandidateOutcome>,
    deleted: Vec<String>,
    skipped: Vec<String>,
    errors: Vec<String>,
    reinstall: Vec<(String, String)>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunAction {
    candidate_id: String,
    path: String,
    method: String,
    status: String,
    detail: String,
    updated_at: u64,
}

fn default_run_status() -> String {
    "completed".into()
}

#[derive(Clone, Deserialize, Serialize)]
struct RunRecord {
    id: String,
    schema_version: u8,
    policy_fingerprint: String,
    #[serde(default)]
    started_at: u64,
    completed_at: u64,
    #[serde(default = "default_run_status")]
    status: String,
    freed: u64,
    #[serde(default)]
    freed_size_unknown: bool,
    deleted: usize,
    skipped: usize,
    errors: usize,
    #[serde(default)]
    actions: Vec<RunAction>,
    outcomes: Vec<CandidateOutcome>,
    #[serde(default)]
    free_space_before: Option<u64>,
    #[serde(default)]
    free_space_after: Option<u64>,
    #[serde(default)]
    free_space_delta: Option<i64>,
}

fn app_data_dir(home: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        #[cfg(test)]
        return home.join("AppData/Roaming/Deslop");
        #[cfg(not(test))]
        // APPDATA is the roaming per-user data location. A missing value is
        // confined to the validated profile; it never falls back to cwd or /.
        return std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join("Deslop");
    }
    #[cfg(not(windows))]
    home.join("Library/Application Support/Deslop")
}

fn runs_dir(home: &Path) -> PathBuf {
    app_data_dir(home).join("runs")
}

fn exclusions_path(home: &Path) -> PathBuf {
    app_data_dir(home).join("cleanup-exclusions.json")
}

fn load_exclusions(home: &Path) -> ExclusionsDocument {
    let Ok(bytes) = fs::read(exclusions_path(home)) else {
        return ExclusionsDocument::default();
    };
    let Ok(document) = serde_json::from_slice::<ExclusionsDocument>(&bytes) else {
        return ExclusionsDocument::default();
    };
    if document.schema_version != EXCLUSIONS_SCHEMA_VERSION {
        return ExclusionsDocument::default();
    }
    // Stored paths never grant deletion authority: an exclusion only matches a
    // snapshot candidate that has independently passed canonical validation.
    document
}

fn write_json_atomically(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path.parent().ok_or("local storage path has no parent")?;
    fs::create_dir_all(parent).map_err(|error| format!("cannot create local storage: {error}"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = parent.join(format!(
        ".{}.{}.{nonce}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("record"),
        std::process::id()
    ));
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("cannot encode local storage: {error}"))?;
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("cannot create local storage transaction: {error}"))?;
    let write_result = (|| {
        file.write_all(&bytes)
            .map_err(|error| format!("cannot write local storage transaction: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("cannot sync local storage transaction: {error}"))?;
        fs::rename(&temporary, path)
            .map_err(|error| format!("cannot replace local storage atomically: {error}"))?;
        // Best effort directory sync makes the completed rename durable on
        // filesystems that support it; a failure here is still reported.
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("cannot sync local storage directory: {error}"))?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

fn persist_exclusions(home: &Path, exclusions: &ExclusionsDocument) -> Result<(), String> {
    write_json_atomically(&exclusions_path(home), exclusions)
}

#[tauri::command]
fn cleanup_exclusions(state: tauri::State<'_, AppState>) -> Result<Vec<CleanupExclusion>, String> {
    Ok(state
        .engine
        .lock()
        .map_err(|_| "engine state unavailable")?
        .exclusions
        .entries
        .clone())
}

#[tauri::command]
fn add_cleanup_exclusion(
    state: tauri::State<'_, AppState>,
    snapshot_id: String,
    candidate_id: String,
) -> Result<Vec<CleanupExclusion>, String> {
    let mut engine = state
        .engine
        .lock()
        .map_err(|_| "engine state unavailable")?;
    let candidate = engine
        .snapshots
        .get(&snapshot_id)
        .and_then(|snapshot| snapshot.candidates.get(&candidate_id))
        .cloned()
        .ok_or("candidate is unavailable; rescan before adding an exclusion")?;
    validate_candidate(&candidate, &engine.home)?;
    let exact_owned_scope = rules::exact_rule_for_path(&candidate.canonical_path, &engine.home)
        == Some(candidate.rule_id.as_str());
    let selected_project_scope = candidate.project_root.is_some()
        && validate_project_artifact(&candidate, &engine.home).is_ok();
    let native_tool_scope =
        candidate.native_tool.is_some() && validate_native_tool(&candidate, &engine.home).is_ok();
    if !exact_owned_scope && !selected_project_scope && !native_tool_scope {
        return Err("an exclusion may only protect an exact owned cache candidate".into());
    }
    if engine.exclusions.entries.iter().any(|entry| {
        entry.rule_id == candidate.rule_id
            && entry.owner == candidate.owner
            && entry.path == candidate.canonical_path.to_string_lossy()
    }) {
        return Ok(engine.exclusions.entries.clone());
    }
    let mut next = engine.exclusions.clone();
    next.revision = next.revision.saturating_add(1);
    let id = format!(
        "exclusion-{}-{}-{}",
        current_unix_seconds(),
        std::process::id(),
        engine.next_id("exclude")
    );
    next.entries.push(CleanupExclusion {
        id,
        rule_id: candidate.rule_id,
        owner: candidate.owner,
        path: candidate.canonical_path.to_string_lossy().to_string(),
        created_at: current_unix_seconds(),
    });
    persist_exclusions(&engine.home, &next)?;
    engine.exclusions = next;
    Ok(engine.exclusions.entries.clone())
}

#[tauri::command]
fn remove_cleanup_exclusion(
    state: tauri::State<'_, AppState>,
    exclusion_id: String,
) -> Result<Vec<CleanupExclusion>, String> {
    let mut engine = state
        .engine
        .lock()
        .map_err(|_| "engine state unavailable")?;
    let mut next = engine.exclusions.clone();
    let before = next.entries.len();
    next.entries.retain(|entry| entry.id != exclusion_id);
    if next.entries.len() == before {
        return Err("cleanup exclusion not found".into());
    }
    next.revision = next.revision.saturating_add(1);
    persist_exclusions(&engine.home, &next)?;
    engine.exclusions = next;
    Ok(engine.exclusions.entries.clone())
}

fn run_path(home: &Path, id: &str) -> PathBuf {
    runs_dir(home).join(format!("{id}.json"))
}

fn persist_run_record(home: &Path, record: &RunRecord) -> Result<(), String> {
    write_json_atomically(&run_path(home, &record.id), record)
}

struct RunJournal {
    record: RunRecord,
}

impl RunJournal {
    fn begin(home: &Path, run_nonce: u64) -> Result<Self, String> {
        let started_at = current_unix_seconds();
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let id = format!(
            "run-{started_at}-{nanos}-{}-{run_nonce}",
            std::process::id()
        );
        let journal = Self {
            record: RunRecord {
                id,
                schema_version: RUN_SCHEMA_VERSION,
                policy_fingerprint: POLICY_FINGERPRINT.into(),
                started_at,
                completed_at: 0,
                status: "running".into(),
                freed: 0,
                freed_size_unknown: false,
                deleted: 0,
                skipped: 0,
                errors: 0,
                actions: Vec::new(),
                outcomes: Vec::new(),
                free_space_before: None,
                free_space_after: None,
                free_space_delta: None,
            },
        };
        persist_run_record(home, &journal.record)?;
        Ok(journal)
    }

    fn intent(&mut self, home: &Path, candidate: &CandidateInternal) -> Result<(), String> {
        self.record.actions.push(RunAction {
            candidate_id: candidate.id.clone(),
            path: candidate.canonical_path.to_string_lossy().to_string(),
            method: match candidate.action {
                ActionMethod::Delete => "delete",
                ActionMethod::NativeTool => "nativeTool",
                ActionMethod::Manual => "manual",
            }
            .into(),
            status: "intended".into(),
            detail:
                "Effect has not started; recovery outcome is unknown if this run is interrupted."
                    .into(),
            updated_at: current_unix_seconds(),
        });
        persist_run_record(home, &self.record)
    }

    fn record_outcome(&mut self, home: &Path, outcome: CandidateOutcome) -> Result<(), String> {
        if let Some(action) = self
            .record
            .actions
            .iter_mut()
            .rev()
            .find(|action| action.candidate_id == outcome.id && action.status == "intended")
        {
            action.status = match outcome.status.as_str() {
                "deleted" | "completed" | "recreated" => "completed",
                "partial" => "partial",
                "skipped" => "skipped",
                "error" => "error",
                _ => "unknown",
            }
            .into();
            action.detail = outcome.detail.clone();
            action.updated_at = current_unix_seconds();
        }
        self.record.outcomes.push(outcome);
        persist_run_record(home, &self.record)
    }

    fn finish(&mut self, home: &Path, result: &CleanResult) -> Result<(), String> {
        self.record.completed_at = current_unix_seconds();
        self.record.status = "completed".into();
        self.record.freed = result.freed;
        self.record.freed_size_unknown = result.freed_size_unknown;
        self.record.free_space_before = result.free_space_before;
        self.record.free_space_after = result.free_space_after;
        self.record.free_space_delta = result.free_space_delta;
        self.record.deleted = result.deleted.len();
        self.record.skipped = result.skipped.len();
        self.record.errors = result.errors.len();
        persist_run_record(home, &self.record)
    }
}

fn load_run_history(home: &Path) -> Vec<RunRecord> {
    let mut records: Vec<RunRecord> = fs::read_dir(runs_dir(home))
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| fs::read(entry.path()).ok())
        .filter_map(|bytes| serde_json::from_slice::<RunRecord>(&bytes).ok())
        .map(|mut record| {
            if record.status == "running" {
                record.status = "interrupted".into();
                for action in &mut record.actions {
                    if action.status == "intended" {
                        action.status = "unknown".into();
                        action.detail = "The app stopped before this action could be recorded as completed; its outcome is unknown.".into();
                    }
                }
            }
            record
        })
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

/// Free bytes of the volume holding `path`, or `None` when it could not be
/// measured (never a fabricated 0).
fn free_space(path: &Path) -> Option<u64> {
    let volume = volume_stats(path);
    (volume.id != "unknown").then_some(volume.free)
}

fn free_space_delta(before: Option<u64>, after: Option<u64>) -> Option<i64> {
    let before = i64::try_from(before?).ok()?;
    let after = i64::try_from(after?).ok()?;
    after.checked_sub(before)
}

#[cfg(windows)]
fn volume_stats(path: &Path) -> VolumeStats {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available = 0u64;
    let mut total = 0u64;
    let mut free = 0u64;
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, &mut free) };
    if ok != 0 {
        return VolumeStats {
            id: path.to_string_lossy().into(),
            total,
            free: available,
        };
    }
    VolumeStats {
        id: "unknown".into(),
        total: 0,
        free: 0,
    }
}

#[cfg(not(windows))]
fn volume_stats(path: &Path) -> VolumeStats {
    let mut command = Command::new("df");
    command.arg("-k").arg(path);
    if let Ok(out) = output_with_timeout(&mut command, EXTERNAL_MEASUREMENT_TIMEOUT) {
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
    let home = &state.home;
    let raw: Vec<String> = ["Documents", "Developer", "code", "Projects"]
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
    Ok(state.home.to_string_lossy().to_string())
}

#[tauri::command]
async fn disk_info(state: tauri::State<'_, AppState>) -> Result<DiskInfo, String> {
    let home = state.home.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let volume = volume_stats(&home);
        Ok(DiskInfo {
            total: volume.total,
            free: volume.free,
        })
    })
    .await
    .map_err(|error| format!("disk information task failed: {error}"))?
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
    // Take only immutable startup data while holding the shared engine lock.
    // Filesystem traversal and measurement happen on the worker without
    // blocking navigation, preferences, cancellation, or status commands.
    let home = state.home.clone();
    let snapshot_id = format!("snapshot-from-{id}");
    let engine = state.engine.clone();
    let jobs = state.scan_jobs.clone();
    std::thread::spawn(move || {
        let progress_jobs = jobs.clone();
        let progress_id = id.clone();
        let mut worker = EngineState::new(home);
        let result = scan_snapshot_with_progress(
            &mut worker,
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
        );
        let result = if cancel.load(Ordering::Relaxed) {
            Err("scan cancelled".into())
        } else {
            result
        };
        // Attaching the immutable snapshot can wait behind clean's engine
        // mutex. Do that before acquiring the jobs mutex, so cancel/status
        // remain responsive while cleanup is active.
        let result = match result {
            Ok(mut snapshot) => {
                let old_snapshot_id = snapshot.id.clone();
                if let Some(mut internal) = worker.snapshots.remove(&old_snapshot_id) {
                    for candidate in internal.candidates.values_mut() {
                        candidate.snapshot_id = snapshot_id.clone();
                    }
                    snapshot.id = snapshot_id.clone();
                    snapshot.breakdown.snapshot_id = snapshot_id.clone();
                    match engine.lock() {
                        Ok(mut engine) => {
                            engine.snapshots.insert(snapshot_id, internal);
                            Ok(snapshot)
                        }
                        Err(_) => Err("engine state unavailable".into()),
                    }
                } else {
                    Err("scan snapshot state unavailable".into())
                }
            }
            Err(error) => Err(error),
        };
        if let Ok(mut jobs) = jobs.lock() {
            if let Some(job) = jobs.get_mut(&id) {
                // Serialize the terminal decision with cancellation. A cancel
                // that arrives after the worker's last filesystem check still
                // wins over a completed result.
                let result =
                    if job.cancel.load(Ordering::Relaxed) || job.status.phase == "cancelling" {
                        Err("scan cancelled".into())
                    } else {
                        result
                    };
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
async fn preflight(
    state: tauri::State<'_, AppState>,
    snapshot_id: String,
    candidate_ids: Vec<String>,
) -> Result<Preflight, String> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut state = engine.lock().map_err(|_| "engine state unavailable")?;
        create_preflight(&mut state, snapshot_id, candidate_ids)
    })
    .await
    .map_err(|error| format!("preflight task failed: {error}"))?
}

fn create_preflight(
    state: &mut EngineState,
    snapshot_id: String,
    candidate_ids: Vec<String>,
) -> Result<Preflight, String> {
    create_preflight_with_probe(state, snapshot_id, candidate_ids, &SystemSafetyProbe)
}

fn create_preflight_with_probe(
    state: &mut EngineState,
    snapshot_id: String,
    candidate_ids: Vec<String>,
    probe: &dyn SafetyProbe,
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
    let mut blocked_entries = Vec::new();
    let mut allowed_ids = BTreeSet::new();
    let mut yellow_count = 0;
    for id in &requested {
        let candidate = snapshot
            .candidates
            .get(id)
            .ok_or_else(|| format!("candidate {id} was not in this snapshot"))?;
        let admission = candidate_admission(candidate, &state.home, &state.exclusions, probe);
        if admission.state != "allowed" {
            if admission.state == "busy" {
                running_apps.insert(candidate.owner.clone());
            }
            warnings.push(format!(
                "{}: {}",
                candidate.canonical_path.display(),
                admission.detail
            ));
            blocked_entries.push(admission);
            continue;
        }
        if candidate.tier == Tier::Yellow {
            yellow_count += 1;
        }
        allowed_ids.insert(id.clone());
        entries.push(Entry {
            id: candidate.id.clone(),
            path: candidate.canonical_path.to_string_lossy().to_string(),
            size: candidate.size,
            size_known: candidate.size_known,
            reason: candidate.reason.clone(),
            scope: candidate.scope.clone(),
            restore: candidate.restore.clone(),
            tier: candidate.tier,
        });
    }
    let id = state.next_id("preflight");
    state.preflights.insert(
        id.clone(),
        PreflightInternal {
            snapshot_id: snapshot_id.clone(),
            requested_candidate_ids: requested,
            candidate_ids: allowed_ids,
            exclusion_revision: state.exclusions.revision,
        },
    );
    let total = entries.iter().map(|entry| entry.size).sum();
    let has_entries = !entries.is_empty();
    Ok(Preflight {
        id,
        snapshot_id,
        entries,
        total,
        yellow_count,
        warnings,
        running_apps: running_apps.into_iter().collect(),
        blocked_entries,
        requires_yellow_confirmation: yellow_count > 0 && has_entries,
    })
}

#[tauri::command]
async fn clean(
    state: tauri::State<'_, AppState>,
    preflight_id: String,
    confirm_yellow: bool,
) -> Result<CleanResult, String> {
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut state = engine.lock().map_err(|_| "engine state unavailable")?;
        clean_engine(&mut state, preflight_id, confirm_yellow)
    })
    .await
    .map_err(|error| format!("cleanup task failed: {error}"))?
}

fn clean_engine(
    state: &mut EngineState,
    preflight_id: String,
    confirm_yellow: bool,
) -> Result<CleanResult, String> {
    clean_engine_with_probe(state, preflight_id, confirm_yellow, &SystemSafetyProbe)
}

fn clean_engine_with_probe(
    state: &mut EngineState,
    preflight_id: String,
    confirm_yellow: bool,
    probe: &dyn SafetyProbe,
) -> Result<CleanResult, String> {
    let preflight = state
        .preflights
        .remove(&preflight_id)
        .ok_or("preflight is unavailable or already used")?;
    if preflight.exclusion_revision != state.exclusions.revision {
        return Err("cleanup exclusions changed after review; review the selection again".into());
    }
    if preflight.requested_candidate_ids.is_empty() {
        return Err("preflight has no reviewed candidates".into());
    }
    let snapshot = state
        .snapshots
        .get(&preflight.snapshot_id)
        .ok_or("scan snapshot is unavailable; rescan before cleaning")?;
    let candidates: Vec<CandidateInternal> = preflight
        .candidate_ids
        .iter()
        .filter_map(|id| snapshot.candidates.get(id).cloned())
        .collect();
    if candidates.is_empty() {
        return Err(
            "no selected entries are currently safe to clean; close the dialog and review again"
                .into(),
        );
    }
    let has_yellow = candidates
        .iter()
        .any(|candidate| candidate.tier == Tier::Yellow);
    if has_yellow && !confirm_yellow {
        return Err("YELLOW entries require explicit preflight confirmation".into());
    }
    // Persist the run before beginning an effect. If storage is unavailable,
    // fail closed rather than creating an un-auditable deletion.
    let mut journal =
        RunJournal::begin(&state.home, state.counter.fetch_add(1, Ordering::Relaxed))?;
    // The volume delta is reported next to Deslop's own accounting so the
    // user can see snapshot/open-file effects instead of trusting one number.
    let free_space_before = free_space(&state.home);
    let mut freed_size_unknown = false;
    let mut outcomes = Vec::new();
    let mut deleted = Vec::new();
    let mut skipped = Vec::new();
    let mut errors = Vec::new();
    let mut reinstall = BTreeMap::new();
    let mut record_error = None;
    for candidate in &candidates {
        let id = &candidate.id;
        let path = candidate.canonical_path.clone();
        let admission = candidate_admission(candidate, &state.home, &state.exclusions, probe);
        if admission.state != "allowed" {
            skipped.push(format!("{} — {}", path.display(), admission.detail));
            let outcome = CandidateOutcome::skipped(candidate, admission);
            if let Err(error) = journal.record_outcome(&state.home, outcome.clone()) {
                record_error = Some(error);
                outcomes.push(CandidateOutcome {
                    status: "unknown".into(),
                    detail: "cleanup journal could not record this skipped action".into(),
                    ..outcome
                });
                break;
            }
            outcomes.push(outcome);
            continue;
        }
        // Allocated size immediately before the effect. A timed-out `du`
        // falls back to the size the scan already measured instead of
        // reporting 0 B for data that is really removed (F-05).
        let (before, measurement) = if candidate.action == ActionMethod::NativeTool {
            (None, "unknown")
        } else {
            match probe.allocated_bytes(&path) {
                Some(bytes) => (Some(bytes), "allocated"),
                None if candidate.size_known => (Some(candidate.size), "scanEstimate"),
                None => (None, "unknown"),
            }
        };
        // Measurement can take long enough for a concurrent rename,
        // application start, or database open. Re-run the *entire* admission
        // and identity policy at the final action boundary.
        let final_admission = candidate_admission(candidate, &state.home, &state.exclusions, probe);
        if final_admission.state != "allowed" {
            skipped.push(format!("{} — {}", path.display(), final_admission.detail));
            let outcome = CandidateOutcome::skipped(candidate, final_admission);
            if let Err(error) = journal.record_outcome(&state.home, outcome.clone()) {
                record_error = Some(error);
                outcomes.push(CandidateOutcome {
                    status: "unknown".into(),
                    detail: "cleanup journal could not record this skipped action".into(),
                    ..outcome
                });
                break;
            }
            outcomes.push(outcome);
            continue;
        }
        // The durable intent is the last step before the effect. If the app
        // exits after this write and before the outcome write, history reports
        // the action as interrupted/unknown instead of claiming success.
        if let Err(error) = journal.intent(&state.home, candidate) {
            record_error = Some(error.clone());
            let detail = "cleanup journal could not persist the action intent; nothing was deleted"
                .to_string();
            errors.push(format!("{} — {detail}", path.display()));
            outcomes.push(
                CandidateOutcome::without_effect(id, &path, "error", detail)
                    .for_candidate(candidate),
            );
            break;
        }
        let outcome = match candidate.action {
            ActionMethod::NativeTool => match execute_native_tool(candidate) {
                Ok(()) => CandidateOutcome {
                    detail: "The installed tool completed its own prune operation; released space is not estimated.".into(),
                    ..CandidateOutcome::without_effect(id, &path, "completed", String::new())
                },
                Err(detail) => CandidateOutcome::without_effect(id, &path, "error", detail),
            },
            ActionMethod::Manual => CandidateOutcome::without_effect(
                id,
                &path,
                "error",
                "manual-only candidates cannot be executed".into(),
            ),
            ActionMethod::Delete => {
                let result = remove_authorized_candidate(&path, candidate.identity.is_dir)
                    .map_err(|error| error.to_string());
                let remeasure = |remaining: &Path| {
                    if measurement == "allocated" {
                        probe.allocated_bytes(remaining)
                    } else {
                        walk_size(remaining)
                    }
                };
                let report = classify_removal(&path, result, before, &remeasure);
                CandidateOutcome {
                    id: id.clone(),
                    path: path.to_string_lossy().to_string(),
                    status: report.status.into(),
                    detail: report.detail,
                    freed: report.freed,
                    remaining: report.remaining,
                    measurement: measurement.into(),
                    reason_code: default_outcome_reason(),
                    owner: candidate.owner.clone(),
                }
            }
        };
        let outcome = outcome.for_candidate(candidate);
        if let Err(error) = journal.record_outcome(&state.home, outcome.clone()) {
            // The filesystem effect may have completed, but it is not safe
            // to report it as a confirmed result without its journal record.
            // Do not process later candidates.
            record_error = Some(error);
            freed_size_unknown = true;
            errors.push(format!(
                "{} — cleanup outcome is unknown because the journal write failed",
                path.display()
            ));
            outcomes.push(CandidateOutcome {
                status: "unknown".into(),
                detail:
                    "The action may have completed, but its journal result could not be written."
                        .into(),
                freed: 0,
                remaining: 0,
                ..outcome
            });
            break;
        }
        match outcome.status.as_str() {
            "deleted" | "recreated" => {
                if outcome.measurement == "unknown" {
                    freed_size_unknown = true;
                }
                deleted.push(outcome.path.clone());
            }
            "partial" | "error" => errors.push(format!("{} — {}", path.display(), outcome.detail)),
            _ => {}
        }
        if matches!(
            outcome.status.as_str(),
            "deleted" | "recreated" | "partial" | "completed"
        ) {
            if let Some(hint) = &candidate.restore {
                reinstall.insert(outcome.path.clone(), hint.clone());
            }
        }
        outcomes.push(outcome);
    }
    let freed = outcomes
        .iter()
        .filter(|outcome| matches!(outcome.status.as_str(), "deleted" | "partial" | "recreated"))
        .fold(0u64, |total, outcome| total.saturating_add(outcome.freed));
    let free_space_after = free_space(&state.home);
    let mut result = CleanResult {
        run_id: Some(journal.record.id.clone()),
        record_error,
        freed,
        freed_size_unknown,
        free_space_before,
        free_space_after,
        free_space_delta: free_space_delta(free_space_before, free_space_after),
        outcomes,
        deleted,
        skipped,
        errors,
        reinstall: reinstall.into_iter().collect(),
    };
    if result.record_error.is_none() {
        if let Err(error) = journal.finish(&state.home, &result) {
            result.record_error = Some(error);
        }
    }
    Ok(result)
}

/// What a delete effect actually achieved, judged from the filesystem after
/// it returned rather than from its return value alone.
struct RemovalReport {
    status: &'static str,
    detail: String,
    freed: u64,
    remaining: u64,
}

/// `remove_dir_all` stops at the first failure without restoring what it
/// already removed (F-07), and a running application may recreate its cache
/// a moment after a successful removal (F-08). Both are reported as such.
fn classify_removal(
    path: &Path,
    result: Result<(), String>,
    before: Option<u64>,
    remeasure: &dyn Fn(&Path) -> Option<u64>,
) -> RemovalReport {
    let still_exists = fs::symlink_metadata(path).is_ok();
    match result {
        Ok(()) if still_exists => RemovalReport {
            status: "recreated",
            detail: "the owning application recreated this cache immediately".into(),
            freed: before.unwrap_or(0),
            remaining: 0,
        },
        Ok(()) => RemovalReport {
            status: "deleted",
            detail: if before.is_some() {
                "deleted after safety and identity revalidation".into()
            } else {
                "deleted after safety and identity revalidation; removed size was not measured"
                    .into()
            },
            freed: before.unwrap_or(0),
            remaining: 0,
        },
        Err(error) if !still_exists => RemovalReport {
            status: "deleted",
            detail: format!("deleted; the system also reported: {error}"),
            freed: before.unwrap_or(0),
            remaining: 0,
        },
        Err(error) => match (before, remeasure(path)) {
            (Some(before), Some(remaining)) if remaining < before => RemovalReport {
                status: "partial",
                detail: format!(
                    "partially removed; {remaining} bytes remain because the system reported: {error}"
                ),
                freed: before - remaining,
                remaining,
            },
            _ => RemovalReport {
                status: "error",
                detail: error,
                freed: 0,
                remaining: 0,
            },
        },
    }
}

#[tauri::command]
fn run_history(state: tauri::State<'_, AppState>) -> Result<Vec<RunRecord>, String> {
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
    app_data_dir(home).join("preferences.json")
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
    Ok(load_preferences(&state.home))
}

#[tauri::command]
fn update_preferences(
    state: tauri::State<'_, AppState>,
    patch: AppPreferencesPatch,
) -> Result<AppPreferences, String> {
    let home = state.home.clone();
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
    let home = state.home.clone();
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
    can_reveal: bool,
    cleanup_rule_id: Option<String>,
    children: Vec<TreeNode>,
}

#[derive(Serialize, Clone)]
struct MapSnapshot {
    id: String,
    created_at: u64,
    is_partial: bool,
    skipped_nodes: usize,
    root: TreeNode,
}

#[derive(Default)]
struct TreeTraversalStats {
    skipped_nodes: usize,
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
    stats: &mut TreeTraversalStats,
) -> Result<u64, String> {
    // The depth limit hands the rest of a subtree to this iterative walker so
    // a deep fixture cannot overflow the thread stack.
    let mut pending = vec![path.to_path_buf()];
    let mut total = 0;
    while let Some(current) = pending.pop() {
        if cancel.load(Ordering::Relaxed) {
            return Err("tree scan cancelled".into());
        }
        #[cfg(windows)]
        if windows_path_safety(&current).is_err() {
            stats.skipped_nodes += 1;
            continue;
        }
        *visited += 1;
        let meta = match fs::symlink_metadata(&current) {
            Ok(meta) => meta,
            Err(_) => {
                stats.skipped_nodes += 1;
                continue;
            }
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_file() {
            total += meta.len();
            continue;
        }
        let entries = match fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(_) => {
                stats.skipped_nodes += 1;
                continue;
            }
        };
        for entry in entries {
            match entry {
                Ok(entry) => pending.push(entry.path()),
                Err(_) => stats.skipped_nodes += 1,
            }
        }
    }
    Ok(total)
}

fn build_node_with_progress<F>(
    path: &Path,
    depth: usize,
    max_depth: usize,
    min_size: u64,
    cancel: &AtomicBool,
    stats: &mut TreeTraversalStats,
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
    #[cfg(windows)]
    windows_path_safety(path)?;
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Ok(TreeNode {
            id: String::new(),
            name,
            path: path_string,
            size: 0,
            is_dir: false,
            can_reveal: false,
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
            can_reveal: false,
            cleanup_rule_id: None,
            children: vec![],
        });
    }
    if depth >= max_depth {
        let mut visited = 0;
        let size = walk_size_with_cancel(path, cancel, &mut visited, stats)?;
        progress(visited);
        return Ok(TreeNode {
            id: String::new(),
            name,
            path: path_string,
            size,
            is_dir: true,
            can_reveal: false,
            cleanup_rule_id: None,
            children: vec![],
        });
    }
    let mut children = Vec::new();
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                stats.skipped_nodes += 1;
                continue;
            }
        };
        match build_node_with_progress(
            &entry.path(),
            depth + 1,
            max_depth,
            min_size,
            cancel,
            stats,
            progress,
        ) {
            Ok(child) => children.push(child),
            Err(error) if error == "tree scan cancelled" => return Err(error),
            Err(_) => stats.skipped_nodes += 1,
        }
    }
    Ok(aggregate_small(
        TreeNode {
            id: String::new(),
            name,
            path: path_string,
            size: 0,
            is_dir: true,
            can_reveal: false,
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
            can_reveal: false,
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
    // Every display node needs an identity for React selection. Synthetic and
    // unavailable nodes deliberately receive an ID that is never registered
    // as a Finder-reveal capability.
    let id = format!("map-node-{snapshot_id}-{}", *next_node);
    *next_node += 1;
    node.id = id.clone();
    node.can_reveal = false;
    if node.name.starts_with('…') {
        return node;
    }
    let Ok((canonical_path, meta)) = safe_metadata(Path::new(&node.path)) else {
        return node;
    };
    if !canonical_path.starts_with(root) {
        return node;
    }
    let identity = match file_identity_from_path(&canonical_path, &meta) {
        Ok(identity) => identity,
        Err(_) => return node,
    };
    node.cleanup_rule_id = rules::exact_rule_for_path(&canonical_path, home).map(str::to_string);
    node.can_reveal = true;
    nodes.insert(
        id,
        MapNodeInternal {
            canonical_path,
            identity,
        },
    );
    node
}

fn create_map_snapshot(
    tree: TreeNode,
    home: &Path,
    root: &Path,
    snapshot_id: String,
    stats: TreeTraversalStats,
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
            is_partial: stats.skipped_nodes > 0,
            skipped_nodes: stats.skipped_nodes,
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
    if file_identity_from_path(&canonical_path, &meta)? != node.identity {
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
    let home = state.home.clone();
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
        let mut stats = TreeTraversalStats::default();
        let result = build_node_with_progress(
            &canonical,
            0,
            max_depth.unwrap_or(6),
            min_size.unwrap_or(20 * 1024 * 1024),
            &cancel,
            &mut stats,
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
        // Snapshot materialization touches the filesystem; never perform it
        // while status/cancel callers are waiting on the jobs mutex.
        let result = match result {
            Ok(tree) if !cancel.load(Ordering::Relaxed) => {
                let snapshot_id = format!("map-snapshot-{id}");
                let (snapshot, internal) =
                    create_map_snapshot(tree, &home, &canonical, snapshot_id.clone(), stats);
                if cancel.load(Ordering::Relaxed) {
                    Err("tree scan cancelled".into())
                } else if let Ok(mut snapshots) = map_snapshots.lock() {
                    snapshots.insert(snapshot_id, internal);
                    Ok(snapshot)
                } else {
                    Err("map snapshot state unavailable".into())
                }
            }
            Ok(_) => Err("tree scan cancelled".into()),
            Err(_) if cancel.load(Ordering::Relaxed) => Err("tree scan cancelled".into()),
            Err(error) => Err(error),
        };
        if let Ok(mut jobs) = jobs.lock() {
            if let Some(job) = jobs.get_mut(&id) {
                let result =
                    if job.cancel.load(Ordering::Relaxed) || job.status.phase == "cancelling" {
                        Err("tree scan cancelled".into())
                    } else {
                        result
                    };
                match result {
                    Ok(snapshot) => {
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
    #[cfg(windows)]
    {
        let status = Command::new("explorer.exe")
            .arg(format!("/select,{}", path.to_string_lossy()))
            .status()
            .map_err(|error| format!("Explorer could not reveal the selected map node: {error}"))?;
        if !status.success() {
            return Err("Explorer could not reveal the selected map node".into());
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = path;
        Err("File reveal is unavailable on this platform".into())
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
    #[cfg(windows)]
    {
        let status = Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(url)
            .status()
            .map_err(|error| format!("link could not be opened: {error}"))?;
        if !status.success() {
            return Err("link could not be opened".into());
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
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
                    can_reveal: false,
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
                        can_reveal: false,
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
    let home = match canonical_home() {
        Ok(home) => home,
        Err(error) => {
            // Do not substitute cwd, `/`, or an unvalidated environment path.
            // Startup remains fail-closed instead of panicking before Tauri.
            eprintln!("Deslop startup disabled: {error}");
            return;
        }
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            engine: Arc::new(Mutex::new(EngineState::new(home.clone()))),
            home,
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
            cleanup_exclusions,
            add_cleanup_exclusion,
            remove_cleanup_exclusion,
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
        let identity = file_identity_from_path(&canonical_path, &meta).unwrap();
        CandidateInternal {
            id: format!("fixture-{rule_id}"),
            snapshot_id: "fixture-snapshot".into(),
            rule_id: rule_id.into(),
            owner: rule_for_id(rule_id)
                .map(|rule| rule.owner)
                .unwrap_or("fixture")
                .into(),
            tier: Tier::Green,
            action: ActionMethod::Delete,
            required_probe: ProbeRequirement::None,
            native_tool: None,
            project_root: None,
            project_artifact: None,
            canonical_path,
            identity,
            size: 0,
            size_known: true,
            reason: "fixture".into(),
            scope: "fixture".into(),
            restore: None,
            policy_fingerprint: POLICY_FINGERPRINT.into(),
        }
    }

    struct FakeProbe {
        owner: ProbeState,
        sqlite: ProbeState,
    }

    impl FakeProbe {
        fn idle() -> Self {
            Self {
                owner: ProbeState::Idle,
                sqlite: ProbeState::Idle,
            }
        }
    }

    impl SafetyProbe for FakeProbe {
        fn owner_state(&self, _owner: &str) -> ProbeState {
            self.owner.clone()
        }
        fn sqlite_state(&self, _candidate: &Path) -> ProbeState {
            self.sqlite.clone()
        }
    }

    fn snapshot_with_candidate(
        state: &mut EngineState,
        mut candidate: CandidateInternal,
    ) -> String {
        let snapshot_id = "fixture-snapshot".to_string();
        candidate.snapshot_id = snapshot_id.clone();
        let candidate_id = candidate.id.clone();
        let mut candidates = BTreeMap::new();
        candidates.insert(candidate_id, candidate);
        state
            .snapshots
            .insert(snapshot_id.clone(), SnapshotInternal { candidates });
        snapshot_id
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
    fn admission_blocks_busy_or_unknown_candidates_without_blocking_other_entries() {
        let home = fixture();
        let busy_path = home.join("busy-cache");
        let idle_path = home.join("idle-cache");
        fs::write(&busy_path, b"busy").unwrap();
        fs::write(&idle_path, b"idle").unwrap();
        let mut state = engine(&home);
        let mut busy = fixture_candidate(busy_path, "editors");
        busy.id = "busy".into();
        busy.owner = "Cursor".into();
        busy.required_probe = ProbeRequirement::Owner;
        let mut idle = fixture_candidate(idle_path, "editors");
        idle.id = "idle".into();
        idle.owner = "Code".into();
        idle.required_probe = ProbeRequirement::Owner;
        let snapshot_id = "fixture-snapshot".to_string();
        busy.snapshot_id = snapshot_id.clone();
        idle.snapshot_id = snapshot_id.clone();
        let mut candidates = BTreeMap::new();
        candidates.insert(busy.id.clone(), busy);
        candidates.insert(idle.id.clone(), idle);
        state
            .snapshots
            .insert(snapshot_id.clone(), SnapshotInternal { candidates });
        let probe = FakeProbe {
            owner: ProbeState::Busy(vec!["Cursor".into()]),
            sqlite: ProbeState::Idle,
        };
        let preflight = create_preflight_with_probe(
            &mut state,
            snapshot_id,
            vec!["busy".into(), "idle".into()],
            &probe,
        )
        .unwrap();
        assert!(preflight.entries.is_empty());
        assert_eq!(preflight.blocked_entries.len(), 2);
        assert!(preflight
            .blocked_entries
            .iter()
            .all(|entry| entry.state == "busy"));
        let unknown = FakeProbe {
            owner: ProbeState::Unknown {
                reason_code: "process_probe_timeout",
                detail: "timed out".into(),
            },
            sqlite: ProbeState::Idle,
        };
        let snapshot_id = "fixture-unknown".to_string();
        let mut candidate = fixture_candidate(home.join("idle-cache"), "editors");
        candidate.snapshot_id = snapshot_id.clone();
        candidate.owner = "Code".into();
        candidate.required_probe = ProbeRequirement::Owner;
        let id = candidate.id.clone();
        state.snapshots.insert(
            snapshot_id.clone(),
            SnapshotInternal {
                candidates: BTreeMap::from([(id.clone(), candidate)]),
            },
        );
        let preflight =
            create_preflight_with_probe(&mut state, snapshot_id, vec![id], &unknown).unwrap();
        assert!(preflight.entries.is_empty());
        assert_eq!(preflight.blocked_entries[0].state, "unknown");
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn candidate_becoming_busy_after_preflight_is_skipped_before_effect() {
        let home = fixture();
        let path = home.join("cache");
        fs::write(&path, b"data").unwrap();
        let mut state = engine(&home);
        let mut candidate = fixture_candidate(path.clone(), "editors");
        candidate.owner = "Cursor".into();
        candidate.required_probe = ProbeRequirement::Owner;
        let id = candidate.id.clone();
        let snapshot_id = snapshot_with_candidate(&mut state, candidate);
        let preflight =
            create_preflight_with_probe(&mut state, snapshot_id, vec![id], &FakeProbe::idle())
                .unwrap();
        let busy = FakeProbe {
            owner: ProbeState::Busy(vec!["Cursor Helper".into()]),
            sqlite: ProbeState::Idle,
        };
        let result = clean_engine_with_probe(&mut state, preflight.id, false, &busy).unwrap();
        assert!(result.deleted.is_empty());
        assert_eq!(result.outcomes[0].status, "skipped");
        assert_eq!(result.outcomes[0].reason_code, "owner_running");
        assert_eq!(result.outcomes[0].owner, "Cursor");
        assert!(path.exists());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn replacement_after_measurement_boundary_is_not_deleted() {
        struct ReplacingProbe {
            path: PathBuf,
            calls: std::sync::atomic::AtomicUsize,
        }
        impl SafetyProbe for ReplacingProbe {
            fn owner_state(&self, _owner: &str) -> ProbeState {
                if self.calls.fetch_add(1, Ordering::Relaxed) == 0 {
                    fs::remove_file(&self.path).unwrap();
                    fs::write(&self.path, b"replacement").unwrap();
                }
                ProbeState::Idle
            }
            fn sqlite_state(&self, _candidate: &Path) -> ProbeState {
                ProbeState::Idle
            }
        }
        let home = fixture();
        let path = home.join("cache");
        fs::write(&path, b"original").unwrap();
        let mut state = engine(&home);
        let mut candidate = fixture_candidate(path.clone(), "editors");
        candidate.owner = "Cursor".into();
        candidate.required_probe = ProbeRequirement::Owner;
        let id = candidate.id.clone();
        let snapshot_id = snapshot_with_candidate(&mut state, candidate);
        let preflight =
            create_preflight_with_probe(&mut state, snapshot_id, vec![id], &FakeProbe::idle())
                .unwrap();
        let result = clean_engine_with_probe(
            &mut state,
            preflight.id,
            false,
            &ReplacingProbe {
                path: path.clone(),
                calls: std::sync::atomic::AtomicUsize::new(0),
            },
        )
        .unwrap();
        assert!(result.deleted.is_empty());
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
        assert_eq!(result.outcomes[0].status, "skipped");
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn preflight_is_single_use_even_when_no_effect_is_repeated() {
        let home = fixture();
        let path = home.join("cache");
        fs::write(&path, b"data").unwrap();
        let mut state = engine(&home);
        let candidate = fixture_candidate(path.clone(), "pkg");
        let id = candidate.id.clone();
        let snapshot_id = snapshot_with_candidate(&mut state, candidate);
        let preflight =
            create_preflight_with_probe(&mut state, snapshot_id, vec![id], &FakeProbe::idle())
                .unwrap();
        let result =
            clean_engine_with_probe(&mut state, preflight.id.clone(), false, &FakeProbe::idle())
                .unwrap();
        assert_eq!(result.deleted.len(), 1);
        assert!(
            clean_engine_with_probe(&mut state, preflight.id, false, &FakeProbe::idle()).is_err()
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn sqlite_families_require_the_main_database_and_include_wal_shm() {
        let root = fixture();
        fs::write(root.join("old.db-shm"), b"old").unwrap();
        assert!(sqlite_families(&root).is_empty());
        fs::write(root.join("active.sqlite"), b"db").unwrap();
        fs::write(root.join("active.sqlite-wal"), b"wal").unwrap();
        fs::write(root.join("active.sqlite-shm"), b"shm").unwrap();
        let families = sqlite_families(&root);
        assert_eq!(families.len(), 1);
        assert_eq!(families[0].len(), 3);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn exclusion_child_protects_parent_and_revision_invalidates_preflight() {
        let home = fixture();
        let parent = home.join("cache");
        let child = parent.join("keep");
        fs::create_dir_all(&child).unwrap();
        fs::write(parent.join("removable"), b"data").unwrap();
        let mut state = engine(&home);
        let candidate = fixture_candidate(parent.clone(), "pkg");
        let id = candidate.id.clone();
        let snapshot_id = snapshot_with_candidate(&mut state, candidate.clone());
        state.exclusions.entries.push(CleanupExclusion {
            id: "child".into(),
            rule_id: "pkg".into(),
            owner: candidate.owner.clone(),
            path: child.canonicalize().unwrap().to_string_lossy().to_string(),
            created_at: current_unix_seconds(),
        });
        assert!(is_excluded(&candidate, &state.exclusions));
        state.exclusions.entries.clear();
        let preflight =
            create_preflight_with_probe(&mut state, snapshot_id, vec![id], &FakeProbe::idle())
                .unwrap();
        state.exclusions.revision = state.exclusions.revision.saturating_add(1);
        assert!(
            clean_engine_with_probe(&mut state, preflight.id, false, &FakeProbe::idle()).is_err()
        );
        assert!(parent.exists());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn interrupted_run_is_reported_as_unknown_not_completed() {
        let home = fixture();
        let record = RunRecord {
            id: "run-interrupted".into(),
            schema_version: RUN_SCHEMA_VERSION,
            policy_fingerprint: POLICY_FINGERPRINT.into(),
            started_at: current_unix_seconds(),
            completed_at: 0,
            status: "running".into(),
            freed: 0,
            freed_size_unknown: false,
            deleted: 0,
            skipped: 0,
            errors: 0,
            outcomes: Vec::new(),
            free_space_before: None,
            free_space_after: None,
            free_space_delta: None,
            actions: vec![RunAction {
                candidate_id: "candidate".into(),
                path: "/fixture".into(),
                method: "delete".into(),
                status: "intended".into(),
                detail: "pending".into(),
                updated_at: current_unix_seconds(),
            }],
        };
        persist_run_record(&home, &record).unwrap();
        let history = load_run_history(&home);
        assert_eq!(history[0].status, "interrupted");
        assert_eq!(history[0].actions[0].status, "unknown");
        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(not(windows))]
    #[test]
    fn project_artifacts_require_selected_git_context_and_recent_activity_is_review_only() {
        let home = fixture();
        let project = home.join("project");
        let artifact = project.join("node_modules");
        fs::create_dir_all(&artifact).unwrap();
        fs::write(
            project.join("package.json"),
            br#"{"dependencies":{"next":"1.0.0"}}"#,
        )
        .unwrap();
        fs::write(artifact.join("recent-output"), b"new").unwrap();
        assert!(Command::new("git")
            .args(["init", "-q"])
            .arg(&project)
            .status()
            .unwrap()
            .success());
        let state = engine(&home);
        let mut candidates = BTreeMap::new();
        add_project_artifact_candidates(
            &state,
            "project-snapshot",
            &[project.canonicalize().unwrap()],
            &mut candidates,
        );
        assert_eq!(candidates.len(), 1);
        let candidate = candidates.values().next().unwrap();
        assert_eq!(
            candidate.project_artifact,
            Some(ProjectArtifactKind::NodeModules)
        );
        assert_eq!(candidate.tier, Tier::Yellow);
        assert!(validate_project_artifact(candidate, &state.home).is_ok());
        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(not(windows))]
    #[test]
    fn project_artifact_rejects_tracked_files_and_nested_repositories() {
        let home = fixture();
        let project = home.join("project");
        let artifact = project.join("target");
        fs::create_dir_all(&artifact).unwrap();
        fs::write(
            project.join("Cargo.toml"),
            "[package]\nname='fixture'\nversion='0.1.0'\n",
        )
        .unwrap();
        fs::write(artifact.join("tracked"), b"keep").unwrap();
        assert!(Command::new("git")
            .args(["init", "-q"])
            .arg(&project)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .arg("-C")
            .arg(&project)
            .args(["add", "--", "target/tracked"])
            .status()
            .unwrap()
            .success());
        assert!(inspect_project_artifact(
            &project.canonicalize().unwrap(),
            &artifact.canonicalize().unwrap()
        )
        .is_err());
        assert!(Command::new("git")
            .arg("-C")
            .arg(&project)
            .args(["reset", "-q"])
            .status()
            .unwrap()
            .success());
        fs::remove_file(artifact.join("tracked")).unwrap();
        fs::create_dir_all(artifact.join("nested/.git")).unwrap();
        assert!(inspect_project_artifact(
            &project.canonicalize().unwrap(),
            &artifact.canonicalize().unwrap()
        )
        .is_err());
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn snapshot_rejects_renderer_tampering_and_only_deletes_selected_candidate() {
        let home = fixture();
        #[cfg(windows)]
        let safe = home.join("AppData/Local/npm-cache");
        #[cfg(not(windows))]
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
        let preflight =
            create_preflight_with_probe(&mut state, scan.id.clone(), vec![id], &FakeProbe::idle())
                .unwrap();
        let result =
            clean_engine_with_probe(&mut state, preflight.id, false, &FakeProbe::idle()).unwrap();
        assert_eq!(result.deleted.len(), 1);
        assert!(result.run_id.is_some());
        assert_eq!(load_run_history(&home).len(), 1);
        assert!(protected.exists());
        fs::remove_dir_all(home).unwrap();
    }
    #[cfg(unix)]
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
        let tree = build_node_with_progress(
            &root,
            0,
            1,
            0,
            &cancel,
            &mut TreeTraversalStats::default(),
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(tree.size, 5);
        cancel.store(true, Ordering::Relaxed);
        assert!(build_node_with_progress(
            &root,
            0,
            1,
            0,
            &cancel,
            &mut TreeTraversalStats::default(),
            &mut |_| {},
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn measurement_timeout_terminates_the_child_process() {
        let mut command = Command::new("sh");
        command.arg("-c").arg("sleep 1");
        assert!(matches!(
            output_with_timeout(&mut command, Duration::from_millis(20)),
            Err(MeasurementCommandError::TimedOut)
        ));
    }
    #[cfg(unix)]
    #[test]
    fn disk_tree_keeps_readable_siblings_when_a_child_is_unavailable() {
        use std::os::unix::fs::PermissionsExt;

        let root = fixture();
        fs::write(root.join("available"), b"12345").unwrap();
        let blocked = root.join("blocked");
        fs::create_dir_all(&blocked).unwrap();
        fs::write(blocked.join("hidden"), b"12345").unwrap();
        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o000)).unwrap();

        let cancel = AtomicBool::new(false);
        let mut stats = TreeTraversalStats::default();
        let tree =
            build_node_with_progress(&root, 0, 4, 0, &cancel, &mut stats, &mut |_| {}).unwrap();
        assert_eq!(tree.size, 5);
        assert!(stats.skipped_nodes > 0);

        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o755)).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn disk_tree_depth_limit_uses_an_iterative_size_walk() {
        let root = fixture();
        let mut current = root.clone();
        for _ in 0..300 {
            current = current.join("d");
            fs::create_dir_all(&current).unwrap();
        }
        fs::write(current.join("payload"), b"123").unwrap();
        let cancel = AtomicBool::new(false);
        let tree = build_node_with_progress(
            &root,
            0,
            2,
            0,
            &cancel,
            &mut TreeTraversalStats::default(),
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(tree.size, 3);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn aggregate_map_nodes_are_selectable_but_never_revealable() {
        let root = fixture();
        fs::write(root.join("one"), b"1").unwrap();
        fs::write(root.join("two"), b"2").unwrap();
        let cancel = AtomicBool::new(false);
        let tree = build_node_with_progress(
            &root,
            0,
            2,
            10,
            &cancel,
            &mut TreeTraversalStats::default(),
            &mut |_| {},
        )
        .unwrap();
        let canonical = root.canonicalize().unwrap();
        let (snapshot, internal) = create_map_snapshot(
            tree,
            &canonical,
            &canonical,
            "map-snapshot-aggregate".into(),
            TreeTraversalStats::default(),
        );
        let aggregate = &snapshot.root.children[0];
        assert!(!aggregate.id.is_empty());
        assert!(!aggregate.can_reveal);
        let mut snapshots = BTreeMap::new();
        snapshots.insert(snapshot.id.clone(), internal);
        assert!(resolve_map_node(&snapshots, &snapshot.id, &aggregate.id).is_err());
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
        let measurement_partial =
            assign_candidate_measurements(&mut candidates, &AtomicBool::new(false)).unwrap();
        let breakdown = cleanup_breakdown_snapshot(
            "fixture-snapshot",
            &canonical_home,
            &candidates,
            &[],
            measurement_partial,
        );
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
        let tree = build_node_with_progress(
            &root,
            0,
            2,
            0,
            &cancel,
            &mut TreeTraversalStats::default(),
            &mut |_| {},
        )
        .unwrap();
        let canonical_root = root.canonicalize().unwrap();
        let (snapshot, internal) = create_map_snapshot(
            tree,
            &canonical_root,
            &canonical_root,
            "map-snapshot-test".into(),
            TreeTraversalStats::default(),
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
    #[cfg(windows)]
    #[test]
    fn windows_exact_cache_paths_keep_neighbouring_profile_data_out() {
        let home = fixture();
        let local = home.join("AppData/Local");
        let roaming = home.join("AppData/Roaming");
        let code_cache = roaming.join("Code/Cache");
        let code_cookies = roaming.join("Code/Cookies");
        let npm_cache = local.join("npm-cache");
        let generic_cache = home.join("Documents/project/Cache");
        fs::create_dir_all(&code_cache).unwrap();
        fs::create_dir_all(&code_cookies).unwrap();
        fs::create_dir_all(&npm_cache).unwrap();
        fs::create_dir_all(&generic_cache).unwrap();
        let editors = rules::windows_paths_for_locations("editors", &home, &local, &roaming);
        let packages = rules::windows_paths_for_locations("pkg", &home, &local, &roaming);
        assert!(editors.contains(&code_cache));
        assert!(!editors.contains(&code_cookies));
        assert!(packages.contains(&npm_cache));
        assert!(!editors.contains(&generic_cache));
        fs::remove_dir_all(home).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn windows_identity_is_distinct_and_replacement_is_rejected() {
        let root = fixture().join("профиль с пробелом");
        fs::create_dir_all(&root).unwrap();
        let first = root.join("first");
        let second = root.join("second");
        fs::write(&first, b"one").unwrap();
        fs::write(&second, b"two").unwrap();
        let (_, first_meta) = safe_metadata(&first).unwrap();
        let (_, second_meta) = safe_metadata(&second).unwrap();
        let first_identity = file_identity_from_path(&first, &first_meta).unwrap();
        let second_identity = file_identity_from_path(&second, &second_meta).unwrap();
        assert_ne!(first_identity, second_identity);
        fs::remove_file(&first).unwrap();
        fs::write(&first, b"replacement").unwrap();
        let (_, replacement_meta) = safe_metadata(&first).unwrap();
        assert_ne!(
            first_identity,
            file_identity_from_path(&first, &replacement_meta).unwrap()
        );
        fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn windows_protected_paths_are_case_insensitive() {
        let home = Path::new("C:\\Users\\Tester");
        assert!(is_protected(&home.join(".CODEX/SESSIONS/keep")));
        assert!(is_protected(&home.join(".Claude/Projects/keep")));
    }
    #[cfg(windows)]
    #[test]
    fn windows_readonly_is_cleared_only_for_the_authorized_entry() {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            SetFileAttributesW, FILE_ATTRIBUTE_READONLY,
        };

        let root = fixture();
        let candidate = root.join("owned-cache");
        let sibling = root.join("sibling");
        fs::write(&candidate, b"cache").unwrap();
        fs::write(&sibling, b"keep").unwrap();
        let wide: Vec<u16> = candidate.as_os_str().encode_wide().chain(Some(0)).collect();
        assert_ne!(
            unsafe { SetFileAttributesW(wide.as_ptr(), FILE_ATTRIBUTE_READONLY) },
            0
        );
        remove_authorized_candidate(&candidate, false).unwrap();
        assert!(!candidate.exists());
        assert!(sibling.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn windows_hardlinks_in_sibling_candidates_are_counted_once() {
        let root = fixture();
        let first = root.join("first-cache");
        let second = root.join("second-cache");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        fs::write(first.join("payload"), b"12345").unwrap();
        fs::hard_link(first.join("payload"), second.join("payload")).unwrap();
        let mut candidates = BTreeMap::new();
        candidates.insert("first".into(), fixture_candidate(first, "pkg"));
        candidates.insert("second".into(), fixture_candidate(second, "editors"));
        assert!(!assign_candidate_measurements(&mut candidates, &AtomicBool::new(false)).unwrap());
        assert_eq!(
            candidates
                .values()
                .map(|candidate| candidate.size)
                .sum::<u64>(),
            5
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn windows_locked_candidate_reports_an_error_without_touching_sibling() {
        use std::fs::OpenOptions;
        use std::os::windows::fs::OpenOptionsExt;

        let root = fixture();
        let candidate = root.join("locked-cache");
        let sibling = root.join("sibling");
        fs::write(&candidate, b"cache").unwrap();
        fs::write(&sibling, b"keep").unwrap();
        let lock = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&candidate)
            .unwrap();
        assert!(remove_authorized_candidate(&candidate, false).is_err());
        assert!(sibling.exists());
        drop(lock);
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn windows_junction_ancestor_is_rejected_without_touching_its_target() {
        let home = fixture();
        let outside = fixture();
        let link = home.join("linked-cache");
        fs::write(outside.join("child"), b"keep").unwrap();
        assert!(safe_metadata(&outside.join("child")).is_ok());
        let created = Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(
            created.status.success(),
            "junction fixture failed: {}",
            String::from_utf8_lossy(&created.stderr)
        );
        assert!(safe_metadata(&link).is_err());
        assert!(safe_metadata(&link.join("child")).is_err());
        assert_eq!(fs::read(outside.join("child")).unwrap(), b"keep");
        fs::remove_dir(&link).unwrap();
        fs::remove_dir_all(home).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn windows_cleanup_never_follows_a_junction_inside_an_owned_cache() {
        let home = fixture();
        let outside = fixture();
        // cmd's mklink interprets slash-delimited segments as switches. Build
        // its fixture path with native separators; the application separately
        // tests mixed-slash and verbatim Win32 paths.
        let cache = home.join("AppData").join("Local").join("npm-cache");
        fs::create_dir_all(&cache).unwrap();
        fs::write(cache.join("cache-data"), b"cache").unwrap();
        fs::write(outside.join("valuable"), b"keep").unwrap();
        let link = cache.join("external");
        let created = Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(
            created.status.success(),
            "junction fixture failed: {}",
            String::from_utf8_lossy(&created.stderr)
        );
        let mut state = engine(&home);
        let snapshot = scan_snapshot(&mut state, &[], Some(vec!["pkg".into()]));
        let candidate = snapshot.categories[0].entries[0].id.clone();
        let preflight = create_preflight(&mut state, snapshot.id, vec![candidate]).unwrap();
        let result = clean_engine(&mut state, preflight.id, false).unwrap();
        assert_eq!(result.deleted.len(), 1);
        assert_eq!(fs::read(outside.join("valuable")).unwrap(), b"keep");
        fs::remove_dir_all(home).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn windows_offline_attribute_is_rejected_when_supported_by_the_volume() {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{SetFileAttributesW, FILE_ATTRIBUTE_OFFLINE};

        let root = fixture();
        let candidate = root.join("cloud-placeholder");
        fs::write(&candidate, b"local").unwrap();
        let wide: Vec<u16> = candidate.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { SetFileAttributesW(wide.as_ptr(), FILE_ATTRIBUTE_OFFLINE) } != 0 {
            assert!(windows_path_safety(&candidate).is_err());
        } else {
            eprintln!("SKIP: FILE_ATTRIBUTE_OFFLINE cannot be set on this fixture volume");
        }
        fs::remove_dir_all(root).unwrap();
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

    /// The exact set the frontend maps to translated reasons (T5).
    const STABLE_REASON_CODES: &[&str] = &[
        "allowed",
        "identity_or_scope_changed",
        "excluded",
        "manual_only",
        "owner_running",
        "singleton_lock_live",
        "sqlite_in_use",
        "process_probe_unavailable",
        "process_probe_timeout",
        "process_probe_unsupported",
        "sqlite_probe_unavailable",
        "sqlite_probe_timeout",
        "lock_unreadable",
    ];

    fn assert_stable_reason(admission: &Admission) {
        assert!(
            STABLE_REASON_CODES.contains(&admission.reason_code.as_str()),
            "unexpected reason code {}",
            admission.reason_code
        );
    }

    fn electron_candidate(home: &Path, app: &str) -> CandidateInternal {
        let cache = home.join(format!("Library/Application Support/{app}/Cache"));
        fs::create_dir_all(&cache).unwrap();
        fs::write(cache.join("data_0"), b"cache").unwrap();
        let mut candidate = fixture_candidate(cache, "editors");
        candidate.owner = app.into();
        candidate.required_probe = ProbeRequirement::OwnerAndSqlite;
        candidate
    }

    #[cfg(unix)]
    fn write_singleton_lock(home: &Path, app: &str, target: &str) {
        let lock = home.join(format!("Library/Application Support/{app}/SingletonLock"));
        let _ = fs::remove_file(&lock);
        std::os::unix::fs::symlink(target, &lock).unwrap();
    }

    #[cfg(unix)]
    fn dead_pid() -> u32 {
        let mut child = Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        pid
    }

    #[cfg(not(windows))]
    #[test]
    fn cache_with_thousands_of_files_is_admitted_without_a_full_walk() {
        struct SystemSqliteProbe;
        impl SafetyProbe for SystemSqliteProbe {
            fn owner_state(&self, _owner: &str) -> ProbeState {
                ProbeState::Idle
            }
            fn sqlite_state(&self, candidate: &Path) -> ProbeState {
                system_sqlite_state(candidate)
            }
        }
        let home = fixture();
        let mut state = engine(&home);
        let candidate = electron_candidate(&state.home, "Cursor");
        let data = candidate.canonical_path.join("Cache_Data");
        fs::create_dir_all(&data).unwrap();
        for index in 0..3_000 {
            fs::write(data.join(format!("f_{index:06x}")), b"x").unwrap();
        }
        // A database deep inside the cache tree is out of the bounded probe.
        let deep = candidate.canonical_path.join("a/b/c");
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("index.db"), b"db").unwrap();
        assert!(sqlite_families(&candidate.canonical_path).is_empty());
        let admission = candidate_admission(
            &candidate,
            &state.home,
            &state.exclusions,
            &SystemSqliteProbe,
        );
        assert_eq!(admission.state, "allowed");
        assert_eq!(admission.owner, "Cursor");
        let id = candidate.id.clone();
        let snapshot_id = snapshot_with_candidate(&mut state, candidate);
        let preflight =
            create_preflight_with_probe(&mut state, snapshot_id, vec![id], &SystemSqliteProbe)
                .unwrap();
        assert_eq!(preflight.entries.len(), 1);
        assert!(preflight.blocked_entries.is_empty());
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn sqlite_discovery_stops_at_its_bound_without_failing() {
        let root = fixture();
        for index in 0..2_500 {
            fs::write(root.join(format!("entry-{index}")), b"x").unwrap();
        }
        fs::write(root.join("profile.sqlite"), b"db").unwrap();
        // Reaching the bound is "checked what we could", never an error.
        let families = sqlite_families(&root);
        assert!(families.len() <= 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn live_singleton_lock_blocks_and_dead_pid_lock_admits() {
        let home = fixture();
        let state = engine(&home);
        let candidate = electron_candidate(&state.home, "Cursor");
        write_singleton_lock(
            &state.home,
            "Cursor",
            &format!("build-host.local-{}", std::process::id()),
        );
        let admission = candidate_admission(
            &candidate,
            &state.home,
            &state.exclusions,
            &FakeProbe::idle(),
        );
        assert_eq!(admission.state, "busy");
        assert_eq!(admission.reason_code, "singleton_lock_live");
        assert_eq!(admission.owner, "Cursor");
        assert_stable_reason(&admission);

        write_singleton_lock(
            &state.home,
            "Cursor",
            &format!("build-host.local-{}", dead_pid()),
        );
        let admission = candidate_admission(
            &candidate,
            &state.home,
            &state.exclusions,
            &FakeProbe::idle(),
        );
        assert_eq!(admission.state, "allowed");
        assert_stable_reason(&admission);
        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_singleton_lock_is_unknown() {
        let home = fixture();
        let state = engine(&home);
        let candidate = electron_candidate(&state.home, "Slack");
        write_singleton_lock(&state.home, "Slack", "no-pid-here");
        let admission = candidate_admission(
            &candidate,
            &state.home,
            &state.exclusions,
            &FakeProbe::idle(),
        );
        assert_eq!(admission.state, "unknown");
        assert_eq!(admission.reason_code, "lock_unreadable");
        assert_eq!(admission.owner, "Slack");
        assert_stable_reason(&admission);

        // A regular file is not a Chromium lock either.
        let lock = state
            .home
            .join("Library/Application Support/Slack/SingletonLock");
        fs::remove_file(&lock).unwrap();
        fs::write(&lock, b"").unwrap();
        let admission = candidate_admission(
            &candidate,
            &state.home,
            &state.exclusions,
            &FakeProbe::idle(),
        );
        assert_eq!(admission.reason_code, "lock_unreadable");
        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn singleton_lock_target_parsing_takes_the_last_field() {
        assert_eq!(parse_singleton_lock_target("my-mac.local-4321"), Some(4321));
        assert_eq!(parse_singleton_lock_target("host-0"), None);
        assert_eq!(parse_singleton_lock_target("4321"), None);
        assert_eq!(parse_singleton_lock_target("host-abc"), None);
    }

    #[test]
    fn admission_reason_codes_come_from_the_stable_set() {
        let home = fixture();
        let state = engine(&home);
        let candidate = electron_candidate(&state.home, "Code");
        let probes = [
            (
                FakeProbe {
                    owner: ProbeState::Busy(vec!["Code".into()]),
                    sqlite: ProbeState::Idle,
                },
                "owner_running",
            ),
            (
                FakeProbe {
                    owner: ProbeState::Idle,
                    sqlite: ProbeState::Busy(vec!["Code Helper".into()]),
                },
                "sqlite_in_use",
            ),
            (
                FakeProbe {
                    owner: ProbeState::Idle,
                    sqlite: ProbeState::Unknown {
                        reason_code: "sqlite_probe_timeout",
                        detail: "timed out".into(),
                    },
                },
                "sqlite_probe_timeout",
            ),
            (FakeProbe::idle(), "allowed"),
        ];
        for (probe, expected) in probes {
            let admission = candidate_admission(&candidate, &state.home, &state.exclusions, &probe);
            assert_eq!(admission.reason_code, expected);
            assert_eq!(admission.owner, "Code");
            assert_stable_reason(&admission);
        }
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn generic_runtimes_never_block_package_caches() {
        for owner in ["npm", "pnpm", "Project Node build"] {
            assert!(!process_names_for_owner(owner).contains(&"node"));
        }
        for owner in ["uv", "pip", "Hugging Face"] {
            let names = process_names_for_owner(owner);
            assert!(!names.contains(&"python") && !names.contains(&"python3"));
        }
        assert!(process_names_for_owner("npm").contains(&"npm"));
        assert!(process_names_for_owner("Project Node build").contains(&"yarn"));

        // A probe that reports `node` running whenever the owner would have
        // listed it: the npm cache must still be admitted.
        struct NodeRunningProbe;
        impl SafetyProbe for NodeRunningProbe {
            fn owner_state(&self, owner: &str) -> ProbeState {
                if process_names_for_owner(owner).contains(&"node") {
                    ProbeState::Busy(vec!["node".into()])
                } else {
                    ProbeState::Idle
                }
            }
            fn sqlite_state(&self, _candidate: &Path) -> ProbeState {
                ProbeState::Idle
            }
        }
        let home = fixture();
        let path = home.join(".npm/_cacache");
        fs::create_dir_all(&path).unwrap();
        let state = engine(&home);
        let mut candidate = fixture_candidate(path, "pkg");
        candidate.owner = "npm".into();
        candidate.required_probe = ProbeRequirement::Owner;
        let admission = candidate_admission(
            &candidate,
            &state.home,
            &state.exclusions,
            &NodeRunningProbe,
        );
        assert_eq!(admission.state, "allowed");
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn windows_owner_images_and_tasklist_rows_are_parsed() {
        assert!(windows_image_names_for_owner("npm").is_empty());
        for owner in [
            "Cursor",
            "Code",
            "Slack",
            "npm",
            "pnpm",
            "uv",
            "pip",
            "Project Node build",
        ] {
            assert!(!windows_image_names_for_owner(owner).contains(&"node.exe"));
        }
        assert_eq!(windows_image_names_for_owner("Code"), ["Code.exe"]);
        let row = "\"Code.exe\",\"1234\",\"Console\",\"1\",\"120,000 K\"\r\n";
        assert!(tasklist_lists_image(row, "Code.exe"));
        assert!(tasklist_lists_image(row, "code.exe"));
        assert!(!tasklist_lists_image(row, "Cursor.exe"));
        assert!(!tasklist_lists_image(
            "INFO: No tasks are running which match the specified criteria.\r\n",
            "Code.exe"
        ));
        assert!(!tasklist_lists_image("", "Code.exe"));
    }

    #[test]
    fn du_timeout_falls_back_to_the_scan_estimate() {
        struct NoDuProbe;
        impl SafetyProbe for NoDuProbe {
            fn owner_state(&self, _owner: &str) -> ProbeState {
                ProbeState::Idle
            }
            fn sqlite_state(&self, _candidate: &Path) -> ProbeState {
                ProbeState::Idle
            }
            fn allocated_bytes(&self, _path: &Path) -> Option<u64> {
                None
            }
        }
        let home = fixture();
        let path = home.join("cache");
        fs::write(&path, b"data").unwrap();
        let mut state = engine(&home);
        let mut candidate = fixture_candidate(path.clone(), "pkg");
        candidate.size = 4_096;
        candidate.size_known = true;
        let id = candidate.id.clone();
        let snapshot_id = snapshot_with_candidate(&mut state, candidate);
        let preflight =
            create_preflight_with_probe(&mut state, snapshot_id, vec![id], &NoDuProbe).unwrap();
        let result = clean_engine_with_probe(&mut state, preflight.id, false, &NoDuProbe).unwrap();
        assert!(!path.exists());
        assert_eq!(result.outcomes[0].status, "deleted");
        assert_eq!(result.outcomes[0].measurement, "scanEstimate");
        assert_eq!(result.outcomes[0].freed, 4_096);
        assert_eq!(result.freed, 4_096);
        assert!(!result.freed_size_unknown);

        fs::write(&path, b"data").unwrap();
        let mut candidate = fixture_candidate(path.clone(), "pkg");
        candidate.size_known = false;
        let id = candidate.id.clone();
        let snapshot_id = snapshot_with_candidate(&mut state, candidate);
        let preflight =
            create_preflight_with_probe(&mut state, snapshot_id, vec![id], &NoDuProbe).unwrap();
        let result = clean_engine_with_probe(&mut state, preflight.id, false, &NoDuProbe).unwrap();
        assert_eq!(result.outcomes[0].measurement, "unknown");
        assert_eq!(result.freed, 0);
        assert!(result.freed_size_unknown);
        fs::remove_dir_all(home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn partial_removal_reports_freed_and_remaining_bytes() {
        use std::os::unix::fs::PermissionsExt;

        // The first measurement is inflated so the result does not depend on
        // the order in which `remove_dir_all` visits the two children.
        struct InflatedBeforeProbe {
            calls: std::sync::atomic::AtomicUsize,
        }
        impl SafetyProbe for InflatedBeforeProbe {
            fn owner_state(&self, _owner: &str) -> ProbeState {
                ProbeState::Idle
            }
            fn sqlite_state(&self, _candidate: &Path) -> ProbeState {
                ProbeState::Idle
            }
            fn allocated_bytes(&self, path: &Path) -> Option<u64> {
                if self.calls.fetch_add(1, Ordering::Relaxed) == 0 {
                    Some(64 * 1024 * 1024)
                } else {
                    du_bytes(path)
                }
            }
        }
        let home = fixture();
        let cache = home.join("cache");
        let locked = cache.join("locked");
        fs::create_dir_all(&locked).unwrap();
        fs::write(cache.join("removable.bin"), [1u8; 64 * 1024]).unwrap();
        fs::write(locked.join("kept.bin"), [2u8; 16 * 1024]).unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o500)).unwrap();
        let mut state = engine(&home);
        let candidate = fixture_candidate(cache.clone(), "pkg");
        let id = candidate.id.clone();
        let snapshot_id = snapshot_with_candidate(&mut state, candidate);
        let probe = InflatedBeforeProbe {
            calls: std::sync::atomic::AtomicUsize::new(0),
        };
        let preflight =
            create_preflight_with_probe(&mut state, snapshot_id, vec![id], &probe).unwrap();
        let result = clean_engine_with_probe(&mut state, preflight.id, false, &probe).unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
        if result.outcomes[0].status == "deleted" {
            eprintln!("SKIP: directory permissions are not enforced for this user");
            fs::remove_dir_all(home).unwrap();
            return;
        }
        let outcome = &result.outcomes[0];
        assert_eq!(outcome.status, "partial");
        assert_eq!(outcome.measurement, "allocated");
        assert!(outcome.remaining > 0);
        assert!(outcome.freed > 0);
        assert_eq!(outcome.freed + outcome.remaining, 64 * 1024 * 1024);
        assert_eq!(result.freed, outcome.freed);
        assert_eq!(result.errors.len(), 1);
        assert!(result.deleted.is_empty());
        assert!(locked.join("kept.bin").exists());
        let history = load_run_history(&state.home);
        assert_eq!(history[0].actions[0].status, "partial");
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn removal_classification_reports_recreated_deleted_and_error() {
        let root = fixture();
        let recreated = root.join("recreated");
        fs::create_dir_all(&recreated).unwrap();
        let report = classify_removal(&recreated, Ok(()), Some(1_000), &|_: &Path| Some(0_u64));
        assert_eq!(report.status, "recreated");
        assert_eq!(report.freed, 1_000);
        assert_eq!(
            report.detail,
            "the owning application recreated this cache immediately"
        );

        let gone = root.join("gone");
        let report = classify_removal(&gone, Ok(()), Some(500), &|_: &Path| Some(0_u64));
        assert_eq!(report.status, "deleted");
        assert_eq!(report.freed, 500);
        let report = classify_removal(&gone, Err("busy".into()), Some(500), &|_: &Path| {
            Some(0_u64)
        });
        assert_eq!(report.status, "deleted");

        let report = classify_removal(&recreated, Err("denied".into()), Some(500), &|_: &Path| {
            Some(500_u64)
        });
        assert_eq!(report.status, "error");
        assert_eq!(report.freed, 0);
        assert_eq!(report.remaining, 0);
        let report = classify_removal(&recreated, Err("denied".into()), Some(500), &|_: &Path| {
            Some(200_u64)
        });
        assert_eq!(report.status, "partial");
        assert_eq!((report.freed, report.remaining), (300, 200));
        let report = classify_removal(&recreated, Err("denied".into()), None, &|_: &Path| {
            Some(200_u64)
        });
        assert_eq!(report.status, "error");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn clean_result_reports_free_space_before_and_after() {
        let home = fixture();
        let path = home.join("cache");
        fs::write(&path, [0u8; 8 * 1024]).unwrap();
        let mut state = engine(&home);
        let candidate = fixture_candidate(path, "pkg");
        let id = candidate.id.clone();
        let snapshot_id = snapshot_with_candidate(&mut state, candidate);
        let preflight =
            create_preflight_with_probe(&mut state, snapshot_id, vec![id], &FakeProbe::idle())
                .unwrap();
        let result =
            clean_engine_with_probe(&mut state, preflight.id, false, &FakeProbe::idle()).unwrap();
        assert!(result.free_space_before.is_some());
        assert!(result.free_space_after.is_some());
        assert_eq!(
            result.free_space_delta,
            free_space_delta(result.free_space_before, result.free_space_after)
        );
        assert!(result.free_space_delta.is_some());
        let json = serde_json::to_value(&result).unwrap();
        for key in ["free_space_before", "free_space_after", "free_space_delta"] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
        let outcome = &json["outcomes"][0];
        assert!(outcome.get("remaining").is_some());
        assert_eq!(outcome["measurement"], "allocated");
        assert_eq!(outcome["reason_code"], "allowed");
        assert_eq!(outcome["owner"], "Package tools");
        let history = load_run_history(&state.home);
        assert_eq!(history[0].schema_version, 3);
        assert_eq!(history[0].free_space_before, result.free_space_before);
        assert_eq!(free_space_delta(Some(10), Some(4)), Some(-6));
        assert_eq!(free_space_delta(None, Some(4)), None);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn journal_maps_partial_and_recreated_outcomes() {
        let home = fixture();
        let path = home.join("cache");
        fs::write(&path, b"x").unwrap();
        let candidate = fixture_candidate(path.clone(), "pkg");
        let mut journal = RunJournal::begin(&home, 1).unwrap();
        journal.intent(&home, &candidate).unwrap();
        journal
            .record_outcome(
                &home,
                CandidateOutcome::without_effect(&candidate.id, &path, "partial", "x".into()),
            )
            .unwrap();
        journal.intent(&home, &candidate).unwrap();
        journal
            .record_outcome(
                &home,
                CandidateOutcome::without_effect(&candidate.id, &path, "recreated", "x".into()),
            )
            .unwrap();
        assert_eq!(journal.record.actions[0].status, "partial");
        assert_eq!(journal.record.actions[1].status, "completed");
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn version_two_run_records_still_load() {
        let home = fixture();
        let runs = runs_dir(&home);
        fs::create_dir_all(&runs).unwrap();
        let legacy = r#"{"id":"run-v2","schema_version":2,"policy_fingerprint":"2026-09-25-snapshot-v2","started_at":1,"completed_at":2,"status":"completed","freed":10,"freed_size_unknown":false,"deleted":1,"skipped":0,"errors":0,"actions":[],"outcomes":[{"id":"c","path":"/p","status":"deleted","detail":"d","freed":10}]}"#;
        fs::write(runs.join("run-v2.json"), legacy).unwrap();
        let history = load_run_history(&home);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].schema_version, 2);
        assert_eq!(history[0].free_space_delta, None);
        assert_eq!(history[0].outcomes[0].remaining, 0);
        assert_eq!(history[0].outcomes[0].measurement, "unknown");
        assert_eq!(history[0].outcomes[0].reason_code, "allowed");
        assert_eq!(history[0].outcomes[0].owner, "");
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn expensive_package_paths_need_review_and_appcache_is_green() {
        let home = Path::new("/Users/tester");
        let pkg = rule_for_id("pkg").unwrap();
        let playwright = home.join("Library/Caches/ms-playwright");
        assert_eq!(candidate_tier(pkg, &playwright), Tier::Yellow);
        assert_eq!(
            candidate_reason(pkg, &playwright),
            "installed browser binaries for Playwright; re-download required"
        );
        assert_eq!(
            candidate_restore(pkg, &playwright).as_deref(),
            Some("npx playwright install")
        );
        let jetbrains = home.join("Library/Caches/JetBrains");
        assert_eq!(candidate_tier(pkg, &jetbrains), Tier::Yellow);
        assert_eq!(
            candidate_reason(pkg, &jetbrains),
            "IDE indexes rebuild slowly"
        );
        assert_eq!(
            candidate_tier(pkg, &home.join("Library/Caches/Homebrew")),
            Tier::Green
        );
        assert_eq!(candidate_restore(pkg, &home.join(".npm/_cacache")), None);

        let appcache = rule_for_id("appcache").unwrap();
        assert_eq!(appcache.tier, Tier::Green);
        assert_eq!(
            candidate_tier(appcache, &home.join("Library/Caches/Arc")),
            Tier::Green
        );
        assert_eq!(
            candidate_tier(
                appcache,
                &home.join("Library/Application Support/Arc/User Data/Default/GPUCache")
            ),
            Tier::Green
        );
        let worker = home.join("Library/Application Support/Slack/Service Worker/CacheStorage");
        assert_eq!(candidate_tier(appcache, &worker), Tier::Yellow);
    }

    #[cfg(not(windows))]
    #[test]
    fn package_rule_skips_npx_and_app_rule_covers_both_openai_bundles() {
        let home = fixture();
        for relative in [
            ".npm/_cacache",
            ".npm/_npx",
            "Library/Caches/com.openai.chat",
            "Library/Caches/com.openai.codex",
        ] {
            fs::create_dir_all(home.join(relative)).unwrap();
        }
        let packages = rules::paths_for("pkg", &home);
        assert!(packages.contains(&home.join(".npm/_cacache")));
        assert!(!packages.contains(&home.join(".npm/_npx")));
        let apps = rules::app_cache_paths(&home);
        assert!(apps.contains(&home.join("Library/Caches/com.openai.chat")));
        assert!(apps.contains(&home.join("Library/Caches/com.openai.codex")));
        let appcache = rule_for_id("appcache").unwrap();
        assert_eq!(
            candidate_owner(
                appcache,
                &home.join("Library/Caches/com.openai.codex"),
                &home
            ),
            "Codex"
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn owner_detection_ignores_the_account_name() {
        let appcache = rule_for_id("appcache").unwrap();
        let pkg = rule_for_id("pkg").unwrap();
        let editors = rule_for_id("editors").unwrap();
        let marcus = Path::new("/Users/Marcus");
        assert_eq!(
            candidate_owner(
                appcache,
                &marcus.join("Library/Application Support/Slack/Cache"),
                marcus
            ),
            "Slack"
        );
        assert_eq!(
            candidate_owner(
                appcache,
                &marcus.join("Library/Caches/LarkInternational"),
                marcus
            ),
            "Lark"
        );
        assert_eq!(
            candidate_owner(pkg, &marcus.join("Library/Caches/Homebrew"), marcus),
            "Homebrew"
        );
        let arcadia = Path::new("/Users/Arcadia");
        assert_eq!(
            candidate_owner(
                appcache,
                &arcadia.join("Library/Application Support/Claude/Cache"),
                arcadia
            ),
            "Claude"
        );
        let luvi = Path::new("/Users/luvi");
        assert_eq!(
            candidate_owner(pkg, &luvi.join(".npm/_cacache"), luvi),
            "npm"
        );
        assert_eq!(candidate_owner(pkg, &luvi.join(".cache/uv"), luvi), "uv");
        let cursor = Path::new("/Users/Cursor");
        assert_eq!(
            candidate_owner(
                editors,
                &cursor.join("Library/Application Support/Code/Cache"),
                cursor
            ),
            "Code"
        );
    }
}
