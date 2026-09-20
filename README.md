<img src="app/app-icon.png" width="128" height="128" alt="Deslop app icon" />

# Deslop

Deslop is a macOS desktop utility for reviewing disk usage and removing selected regenerable cache data. It shows the proposed cleanup before anything is deleted.

## Download for macOS

Download the latest installer from [Releases](https://github.com/sukaslitno/deslop/releases/latest):

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

## What it does

- Scans exact, known cache locations and shows candidates before cleanup
- Separates recommended items from entries that need review or manual action
- Provides a disk map and cleanup history
- Revalidates the selected snapshot, path boundaries, identities, and symbolic links immediately before deletion
- Excludes sessions, persistent memory, settings, and Claude/Codex project data from its cleanup rules

Deslop currently supports macOS. A Windows release will be added only after its cleanup rules are implemented and verified for Windows paths.

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

The app icon comes from `deslop icon.png`. With Python 3 and Pillow installed,
run `pnpm icons:generate` from `app/` to regenerate the transparent master,
macOS `.icns`, Windows `.ico`, PNG sizes, and browser favicon. Commit the
generated files together so local builds and release installers use the same icon.

## Checks

```sh
cd app
pnpm typecheck
pnpm build
cd src-tauri
cargo fmt --check
cargo test --lib
```

## License

[MIT](LICENSE)
