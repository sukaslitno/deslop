# Deslop

Deslop is a macOS desktop utility for reviewing disk usage and removing selected regenerable cache data. It shows the proposed cleanup before anything is deleted.

## Download for macOS

Download the latest installer from [Releases](https://github.com/sukaslitno/deslop/releases/latest):

- **Apple Silicon** — for M-series Macs
- **Intel** — for Intel-based Macs

Open the matching `.dmg`, then move Deslop to Applications. The current builds are not code-signed or notarized, so macOS may require you to Control-click the app and choose **Open** the first time.

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
