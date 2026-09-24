# Installer handoff

`src/config/releases.ts` is the only place the landing learns about installers.
It currently maps the published GitHub **v0.1.2** release: both macOS `.dmg`
builds and the Windows x64 `.exe` preview.

## Supply verified assets

Update only `src/config/releases.ts` when a new release is published. Keep one
current entry per platform/architecture:

| Platform | Architecture | Installer |
| --- | --- | --- |
| `macos` | `apple-silicon` | Published Apple Silicon `.dmg` |
| `macos` | `intel` | Published Intel `.dmg` |
| `windows` | `x64` | Published x64 setup `.exe` |

Each entry needs the actual version, exact filename and exact public HTTPS URL
from the published release. Set `available: true` only after those assets have
been downloaded and checked. Do not infer filenames, versions or URLs. Omit an
unavailable platform; a missing Windows asset does not disable macOS. Platforms
can be enabled independently when only some artifacts are ready.

There is no checksum surface on the landing: the release manifest
(`checksums.txt`) covers all three published installers and is reached through the
GitHub release page. Do not add a checksum link that synthesizes a URL or digest.

`tests/releases.spec.ts` checks the committed mapping: unique platform/architecture
pairs, an HTTPS github.com release-download URL, the URL agreeing with both the
`version` and the `filename`, and the installer extension matching the platform.
It does not claim to verify network availability or signatures; those are the
release owner's checks before flipping `available`.

## Behavior

- All three download triggers open the same OS selector.
- Two Mac builds show Apple Silicon/Intel choices; a single Mac build names its
  architecture explicitly. Windows x64 opens its configured `.exe` directly.
- Each missing platform keeps its disabled control and release-page notice.
- The bottom CTA headline follows Windows availability: `cta.windowsReady` in
  `src/content/{ru,en}.ts` replaces the "Windows later" line once the Windows
  installer is configured. The headline covers only the states that can ship
  (Mac-only and both), so a Mac-less fixture still reads as Mac-available.
- Choices are hidden during the first mobile prompt.
- The no-JavaScript fallback lists every configured installer.

## Local verification

Use the shared Astro dev server on port 4321. Development-only pages live at
`/qa/releases/ru/both/` and `/qa/releases/en/both/`; replace `both` with `none`,
`macOnly` or `windowsOnly` for other states. These fixtures use local
`/fixture-downloads/` paths and no QA pages are generated in production builds.
Tests intercept fixture navigation; no real installer is downloaded.

Run `pnpm typecheck`, `pnpm test:content` and `pnpm exec playwright test` from
`landing/`. `pnpm test:content` also pins the expected release version, so it
fails until the mapping and its guard are updated together.

For a shared release checkout, use `pnpm exec astro build` to verify the existing
landing token snapshot without running the token-sync prebuild against another
agent's in-progress app changes. The production standalone build validates the
committed snapshot hash.
