export interface Release {
  platform: "macos" | "windows";
  architecture: "apple-silicon" | "intel" | "x64";
  version: string;
  url: string;
  filename: string;
  available: true;
}

/**
 * Populated only from the published GitHub v0.1.2 release, whose four assets
 * were downloaded and checked before this mapping was enabled. The Windows
 * installer is a preview build; checksums.txt covers all three installers.
 */
export const releases: Release[] = [
  {
    platform: "macos",
    architecture: "apple-silicon",
    version: "0.1.2",
    filename: "Deslop_0.1.2_aarch64.dmg",
    url: "https://github.com/sukaslitno/deslop/releases/download/v0.1.2/Deslop_0.1.2_aarch64.dmg",
    available: true,
  },
  {
    platform: "macos",
    architecture: "intel",
    version: "0.1.2",
    filename: "Deslop_0.1.2_x64.dmg",
    url: "https://github.com/sukaslitno/deslop/releases/download/v0.1.2/Deslop_0.1.2_x64.dmg",
    available: true,
  },
  {
    platform: "windows",
    architecture: "x64",
    version: "0.1.2",
    filename: "Deslop_0.1.2_x64-setup.exe",
    url: "https://github.com/sukaslitno/deslop/releases/download/v0.1.2/Deslop_0.1.2_x64-setup.exe",
    available: true,
  },
];
