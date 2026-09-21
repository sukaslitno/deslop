<img src="app/app-icon.png" width="128" height="128" alt="Deslop app icon" />

# Deslop

Deslop is a desktop utility for reviewing disk usage and removing selected regenerable cache data. It shows the proposed cleanup before anything is deleted. macOS supports Apple Silicon and Intel; Windows x64 support is an initial preview.

## Download for macOS

Download a published installer from [Releases](https://github.com/sukaslitno/deslop/releases):

- **Apple Silicon** — for M-series Macs
- **Intel** — for Intel-based Macs

Open the matching `.dmg`, then move Deslop to Applications. The current builds are not code-signed or notarized, so macOS may require you to Control-click the app and choose **Open** the first time.

To verify your download, save `checksums.txt` from the same release next to the
installer, open Terminal in that folder, and run:

```sh
shasum -a 256 -c checksums.txt --ignore-missing
```

Your downloaded DMG must report `OK`. `--ignore-missing` skips the installer for
the other architecture. If you downloaded both installers, verify the full set
with `shasum -a 256 -c checksums.txt`.

## Windows x64 preview

Use the `x64-setup.exe` asset from a release that includes Windows. The installer
downloads Microsoft WebView2 when it is missing, so that first installation
requires an internet connection. Builds are currently unsigned.

Windows cleanup is limited to explicit Code/Cursor, Slack and package-manager
cache locations. It requires supported local filesystem identities and skips
reparse points and cloud placeholders. macOS-only rules are not offered on
Windows. Automatic scheduled cleanup is not implemented on either platform.

To check a Windows installer, run `Get-FileHash` in PowerShell with its path and
`-Algorithm SHA256`, then compare the hash to `checksums.txt` from the same release.
Release notes state the actual native test and installer-smoke coverage; a
successful build alone is not a full manual Windows acceptance test.

## What it does

- Scans exact, known cache locations and shows candidates before cleanup
- Separates recommended items from entries that need review or manual action
- Provides a disk map, per-run cleanup results and local history records
- Revalidates the selected snapshot, path boundaries, identities, and symbolic links immediately before deletion
- Excludes sessions, persistent memory, settings, and Claude/Codex project data from its cleanup rules

## Build from source

Requirements: Node.js 20+, pnpm, and Rust 1.88.

```sh
cd app
pnpm install --frozen-lockfile
pnpm tauri dev
```

For a production macOS bundle:

```sh
cd app
pnpm tauri build --bundles dmg
```

On Windows with the Microsoft C++ build tools and WebView2 prerequisites:

```sh
cd app
pnpm tauri build --bundles nsis --target x86_64-pc-windows-msvc
```

The app icon comes from `deslop icon.png`. With Python 3 and Pillow installed,
run `pnpm icons:generate` from `app/` to regenerate the transparent master,
macOS `.icns`, Windows `.ico`, PNG sizes, and browser favicon. Commit the
generated files together so local builds and release installers use the same icon.

## Checks

```sh
cd app
pnpm typecheck
pnpm test:state
pnpm exec playwright install chromium
pnpm test:ui
pnpm build
cd src-tauri
cargo fmt --check
cargo clippy --lib --tests -- -D warnings
cargo test --lib
```

## License

[MIT](LICENSE)
