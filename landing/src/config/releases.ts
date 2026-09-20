export interface Release {
  platform: "macos" | "windows";
  architecture: "apple-silicon" | "intel" | "x64";
  version: string;
  url: string;
  filename: string;
  available: true;
}

/**
 * Populated only from the verified GitHub v0.1.1 release. It intentionally
 * contains no Windows entry: that asset has not been published.
 */
export const releases: Release[] = [
  {
    platform: "macos",
    architecture: "apple-silicon",
    version: "0.1.1",
    filename: "Deslop_0.1.1_aarch64.dmg",
    url: "https://github.com/sukaslitno/deslop/releases/download/v0.1.1/Deslop_0.1.1_aarch64.dmg",
    available: true,
  },
  {
    platform: "macos",
    architecture: "intel",
    version: "0.1.1",
    filename: "Deslop_0.1.1_x64.dmg",
    url: "https://github.com/sukaslitno/deslop/releases/download/v0.1.1/Deslop_0.1.1_x64.dmg",
    available: true,
  },
];
