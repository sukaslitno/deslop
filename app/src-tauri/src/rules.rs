//! Exact, owned cache paths.  This module deliberately never discovers a
//! project artifact by folder name: every returned path is a cache leaf below
//! a known application/tool location.

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
                ".npm/_cacache",
                ".npm/_npx",
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
        "claude", "codex", "editors", "appcache", "pkg", "xcode", "hf",
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
        home.join("Library/Caches/com.openai.chat"),
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
