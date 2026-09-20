import type { Release } from "./releases";

export interface DownloadAvailability {
  macReleases: Release[];
  windowsReleases: Release[];
  macAvailable: boolean;
  windowsAvailable: boolean;
  macOption: DownloadOption;
  windowsOption: DownloadOption;
}

export interface DownloadOption {
  platform: Release["platform"];
  mode: "architecture" | "link" | "disabled";
  releases: Release[];
  href?: string;
}

/** A renderer-facing projection. No URL is guessed: every available branch
 * is backed by a concrete Release entry and every absent branch stays disabled. */
export function getDownloadAvailability(entries: readonly Release[]): DownloadAvailability {
  const macReleases = entries.filter((entry) => entry.platform === "macos");
  const windowsReleases = entries.filter((entry) => entry.platform === "windows");
  const option = (platform: Release["platform"], releases: Release[]): DownloadOption => ({
    platform,
    releases,
    mode: releases.length === 0 ? "disabled" : releases.length === 1 ? "link" : "architecture",
    href: releases.length === 1 ? releases[0]?.url : undefined,
  });
  return {
    macReleases,
    windowsReleases,
    macAvailable: macReleases.length > 0,
    windowsAvailable: windowsReleases.length > 0,
    macOption: option("macos", macReleases),
    windowsOption: option("windows", windowsReleases),
  };
}

const fixture = (platform: Release["platform"], architecture: Release["architecture"], filename: string): Release => ({
  platform,
  architecture,
  version: "fixture",
  filename,
  url: `/fixture-downloads/${filename}`,
  available: true,
});

/** Test-only local mappings. They deliberately never invoke a real installer URL. */
export const releaseFixtures = {
  both: [fixture("macos", "apple-silicon", "fixture-arm.dmg"), fixture("macos", "intel", "fixture-intel.dmg"), fixture("windows", "x64", "fixture.exe")],
  none: [],
  macOnly: [fixture("macos", "intel", "fixture-intel.dmg")],
  windowsOnly: [fixture("windows", "x64", "fixture.exe")],
} as const satisfies Record<string, readonly Release[]>;
