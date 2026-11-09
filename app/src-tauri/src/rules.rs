//! Exact, owned cache paths.  This module deliberately never discovers a
//! project artifact by folder name: every returned path is a cache leaf below
//! a known application/tool location.

#[cfg(any(not(windows), test))]
use std::fs;
use std::path::{Path, PathBuf};

fn existing(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    paths.into_iter().filter(|path| path.exists()).collect()
}

pub fn paths_for(rule_id: &str, home: &Path) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        return windows_paths_for(rule_id, home);
    }
    #[cfg(not(windows))]
    paths_for_macos(rule_id, home)
}

#[cfg(not(windows))]
fn paths_for_macos(rule_id: &str, home: &Path) -> Vec<PathBuf> {
    let path = |relative: &str| home.join(relative);
    match rule_id {
        "claude" => existing(
            [".claude/shell-snapshots", ".claude/logs", ".claude/statsig"]
                .into_iter()
                .map(path)
                .collect(),
        ),
        "codex" => existing(
            [".codex/log", ".codex/logs", ".cache/codex-runtimes"]
                .into_iter()
                .map(path)
                .collect(),
        ),
        "editors" => editor_cache_paths(home),
        "appcache" => app_cache_paths(home),
        "pkg" => existing(
            [
                // `.npm/_npx` is deliberately absent: it holds the packages of
                // running `npx` commands, and removing it breaks them.
                ".npm/_cacache",
                ".bun/install/cache",
                ".cache/uv",
                ".cache/pip",
                "Library/Caches/pip",
                "Library/Caches/pnpm",
                "Library/Caches/JetBrains",
                "Library/Caches/ms-playwright",
                "Library/Caches/Homebrew",
            ]
            .into_iter()
            .map(path)
            .collect(),
        ),
        "xcode" => existing(
            [
                "Library/Developer/Xcode/DerivedData",
                "Library/Developer/CoreSimulator/Caches",
                "Library/Developer/Xcode/iOS DeviceSupport",
                "Library/Developer/Xcode/watchOS DeviceSupport",
                "Library/Developer/Xcode/tvOS DeviceSupport",
            ]
            .into_iter()
            .map(path)
            .collect(),
        ),
        "hf" => existing(
            [".cache/huggingface/hub", ".cache/huggingface/datasets"]
                .into_iter()
                .map(path)
                .collect(),
        ),
        "browsers" => browser_cache_paths(home),
        "devcaches" => dev_cache_paths(home),
        "maclogs" => mac_system_paths(home),
        // Review-only: shown, never deleted (the rules are RED / Manual).
        "review_models" => existing(
            [
                ".ollama/models",
                ".lmstudio/models",
                ".cache/lm-studio/models",
            ]
            .into_iter()
            .map(path)
            .collect(),
        ),
        "review_dev" => existing(
            [
                "Library/Application Support/MobileSync/Backup",
                ".android/avd",
                "Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw",
                "Library/Application Support/Claude/vm_bundles",
            ]
            .into_iter()
            .map(path)
            .collect(),
        ),
        _ => Vec::new(),
    }
}

#[cfg(windows)]
fn windows_paths_for(rule_id: &str, home: &Path) -> Vec<PathBuf> {
    #[cfg(test)]
    {
        return windows_paths_for_locations(
            rule_id,
            home,
            &home.join("AppData/Local"),
            &home.join("AppData/Roaming"),
        );
    }
    #[cfg(not(test))]
    {
        let local = match std::env::var_os("LOCALAPPDATA") {
            Some(path) => PathBuf::from(path),
            None => return Vec::new(),
        };
        let roaming = match std::env::var_os("APPDATA") {
            Some(path) => PathBuf::from(path),
            None => return Vec::new(),
        };
        windows_paths_for_locations(rule_id, home, &local, &roaming)
    }
}

#[cfg(windows)]
pub(crate) fn windows_paths_for_locations(
    rule_id: &str,
    _home: &Path,
    local: &Path,
    roaming: &Path,
) -> Vec<PathBuf> {
    // Each path is an owned cache leaf. We deliberately never search for a
    // generic directory named Cache or scan Windows temp/project folders.
    let paths = match rule_id {
        // No desktop Claude/Codex cache is claimed without an owned-path
        // contract; their macOS-specific rules remain untouched above.
        "claude" | "codex" => Vec::new(),
        "editors" => vec![
            roaming.join("Code/Cache"),
            roaming.join("Code/CachedData"),
            roaming.join("Cursor/Cache"),
            roaming.join("Cursor/CachedData"),
        ],
        "appcache" => vec![
            roaming.join("Slack/Cache"),
            roaming.join("Slack/Code Cache"),
            local.join("slack/Cache"),
        ],
        "pkg" => vec![local.join("npm-cache"), local.join("pnpm-store/v3/files")],
        _ => Vec::new(),
    };
    existing(paths)
}

/// Returns a rule only for an exact, existing cache root owned by that rule.
/// This intentionally does not infer cleanup eligibility from a folder name or
/// from a descendant path: map coloring must not become delete authority.
pub fn exact_rule_for_path(path: &Path, home: &Path) -> Option<&'static str> {
    let canonical = path.canonicalize().ok()?;
    [
        "claude",
        "codex",
        "editors",
        "appcache",
        "pkg",
        "xcode",
        "hf",
        "browsers",
        "devcaches",
        "maclogs",
        "review_models",
        "review_dev",
    ]
    .into_iter()
    .find(|rule_id| {
        paths_for(rule_id, home).into_iter().any(|candidate| {
            candidate
                .canonicalize()
                .is_ok_and(|candidate| candidate == canonical)
        })
    })
}

#[cfg(not(windows))]
fn editor_cache_paths(home: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for app in ["Cursor", "Code", "Code - Insiders"] {
        for cache in [
            "CachedData",
            "Cache",
            "GPUCache",
            "Code Cache",
            "CachedExtensionVSIXs",
            "ShaderCache",
            "logs",
        ] {
            paths.push(home.join(format!("Library/Application Support/{app}/{cache}")));
        }
    }
    existing(paths)
}

#[cfg(any(not(windows), test))]
pub fn app_cache_paths(home: &Path) -> Vec<PathBuf> {
    let mut paths = vec![
        home.join("Library/Caches/com.figma.Desktop.ShipIt"),
        home.join("Library/Application Support/Slack/Cache"),
        home.join("Library/Application Support/Slack/Service Worker/CacheStorage"),
        home.join("Library/Application Support/Slack/Code Cache"),
        home.join("Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack/Cache"),
        home.join("Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack/Service Worker/CacheStorage"),
        home.join("Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack/Code Cache"),
        home.join("Library/Application Support/Claude/Cache"),
        home.join("Library/Application Support/Claude/Code Cache"),
        home.join("Library/Caches/Arc"),
        home.join("Library/Caches/company.thebrowser.Browser"),
        home.join("Library/Caches/LarkInternational"),
        home.join("Library/Caches/Codex"),
        // Both bundle ids exist on different machines (ChatGPT desktop and
        // the Codex desktop app).
        home.join("Library/Caches/com.openai.chat"),
        home.join("Library/Caches/com.openai.codex"),
        // Claude / Codex desktop apps (never anything under ~/.claude or ~/.codex).
        home.join("Library/Caches/com.anthropic.claudefordesktop"),
        home.join("Library/Logs/Claude"),
        home.join("Library/Application Support/Codex/Crashpad/pending"),
        home.join("Library/Application Support/discord/Cache"),
        home.join("Library/Application Support/discord/Code Cache"),
        home.join("Library/Application Support/discord/GPUCache"),
        home.join("Library/Caches/us.zoom.xos"),
        home.join("Library/Caches/ru.keepcoder.Telegram"),
        home.join("Library/Caches/notion.id"),
        home.join("Library/Caches/md.obsidian"),
        home.join("Library/Caches/com.microsoft.teams2"),
        home.join("Library/Application Support/Steam/htmlcache"),
        home.join("Library/Application Support/Steam/appcache"),
        home.join("Library/Application Support/Steam/depotcache"),
        home.join("Library/Application Support/Steam/steamapps/shadercache"),
        home.join("Library/Application Support/Adobe/Common/Media Cache Files"),
        home.join("Library/Application Support/Adobe/Common/Media Cache"),
        home.join("Library/Caches/com.getdropbox.dropbox"),
        home.join("Library/Caches/com.google.GoogleDrive"),
        home.join("Library/Caches/com.microsoft.OneDrive"),
    ];
    append_profile_caches(
        &mut paths,
        &home.join("Library/Application Support/Figma/DesktopProfile"),
        [
            "Cache",
            "Code Cache",
            "GPUCache",
            "Service Worker/CacheStorage",
        ],
    );
    append_profile_caches(
        &mut paths,
        &home.join("Library/Application Support/Arc/User Data"),
        [
            "Service Worker/CacheStorage",
            "Code Cache",
            "GPUCache",
            "ShaderCache",
        ],
    );
    existing(paths)
}

#[cfg(any(not(windows), test))]
fn append_profile_caches<const N: usize>(
    paths: &mut Vec<PathBuf>,
    profiles: &Path,
    children: [&str; N],
) {
    if let Ok(entries) = fs::read_dir(profiles) {
        for entry in entries.flatten() {
            for child in children {
                paths.push(entry.path().join(child));
            }
        }
    }
}

/// Chromium-family browsers. Only these known roots are enumerated; no folder
/// is discovered by name elsewhere.
#[cfg(not(windows))]
const CHROMIUM_BROWSERS: &[&str] = &[
    "Google/Chrome",
    "BraveSoftware/Brave-Browser",
    "Microsoft Edge",
    "Chromium",
    "Vivaldi",
];

/// Cache leaves directly under a Chromium user-data root (not profiles).
#[cfg(not(windows))]
const CHROMIUM_ROOT_LEAVES: &[&str] = &[
    "ShaderCache",
    "GrShaderCache",
    "GraphiteDawnCache",
    "component_crx_cache",
    "OptGuideOnDeviceModel",
    "optimization_guide_model_store",
];

#[cfg(not(windows))]
fn browser_cache_paths(home: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for browser in CHROMIUM_BROWSERS {
        paths.push(home.join("Library/Caches").join(browser));
        let root = home.join("Library/Application Support").join(browser);
        for leaf in CHROMIUM_ROOT_LEAVES {
            paths.push(root.join(leaf));
        }
        paths.push(root.join("Crashpad/completed"));
        append_chromium_profile_caches(&mut paths, &root);
    }
    // Firefox: the cache root plus the per-profile cache2 directories.
    paths.push(home.join("Library/Caches/Firefox"));
    append_profile_caches(
        &mut paths,
        &home.join("Library/Application Support/Firefox/Profiles"),
        ["cache2"],
    );
    // Safari (needs Full Disk Access; reported as YELLOW by the engine).
    paths.push(home.join("Library/Caches/com.apple.Safari"));
    existing(paths)
}

/// Per-profile render caches of one Chromium user-data root. Cookies, Login
/// Data, Local Storage, IndexedDB and Sessions are never named here.
#[cfg(not(windows))]
fn append_chromium_profile_caches(paths: &mut Vec<PathBuf>, root: &Path) {
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let is_root_leaf = CHROMIUM_ROOT_LEAVES.contains(&&*name) || name == "Crashpad";
            if is_root_leaf || !entry.path().is_dir() {
                continue;
            }
            for child in [
                "Code Cache",
                "GPUCache",
                "DawnCache",
                "GrShaderCache",
                "GraphiteDawnCache",
            ] {
                paths.push(entry.path().join(child));
            }
        }
    }
}

#[cfg(not(windows))]
fn dev_cache_paths(home: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = [
        ".cache/typescript",
        ".cache/node-gyp",
        ".cache/vite",
        ".cache/webpack",
        ".cache/eslint",
        ".cache/prettier",
        ".cache/ruff",
        ".cache/mypy",
        ".turbo/cache",
        ".parcel-cache",
        // Yarn v1 only; Yarn Berry's cache lives in projects and is untouched.
        "Library/Caches/Yarn",
        ".cargo/registry/cache",
        ".gradle/caches/build-cache-1",
        ".android/build-cache",
        ".android/cache",
    ]
    .into_iter()
    .map(|relative| home.join(relative))
    .collect();
    if let Ok(entries) = fs::read_dir(home.join("Library/Caches/Google")) {
        for entry in entries.flatten() {
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with("AndroidStudio")
            {
                paths.push(entry.path());
            }
        }
    }
    existing(paths)
}

/// macOS user-level logs and thumbnails. `DiagnosticReports` is the user's
/// crash-report archive and is never listed; `Library/Logs/Claude` belongs to
/// the Claude application rule.
#[cfg(not(windows))]
fn mac_system_paths(home: &Path) -> Vec<PathBuf> {
    let mut paths = vec![
        home.join("Library/Caches/com.apple.QuickLook.thumbnailcache"),
        home.join(
            "Library/Group Containers/group.com.apple.coreservices.useractivityd/shared-pasteboard",
        ),
    ];
    if let Ok(entries) = fs::read_dir(home.join("Library/Logs")) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == "DiagnosticReports" || name == "Claude" || name.starts_with('.') {
                continue;
            }
            paths.push(entry.path());
        }
    }
    existing(paths)
}
