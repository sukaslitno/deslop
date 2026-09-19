export type ScanCta =
  | { location: "none" }
  | { location: "header"; label: "Rescan" | "Cancel scan" }
  | { location: "center"; label: "Scan my Mac" | "Retry" | "Scan again" }
  | { location: "progress"; label: "Cancel scan" };

export function scanCtaFor({
  initializing,
  scanning,
  scannedOnce,
  resultCount,
  hasInitialScanError,
}: {
  initializing: boolean;
  scanning: boolean;
  scannedOnce: boolean;
  resultCount: number;
  hasInitialScanError: boolean;
}): ScanCta {
  if (initializing) return { location: "none" };
  if (scanning) {
    return scannedOnce && resultCount > 0
      ? { location: "header", label: "Cancel scan" }
      : { location: "progress", label: "Cancel scan" };
  }
  if (!scannedOnce) {
    return hasInitialScanError
      ? { location: "center", label: "Retry" }
      : { location: "center", label: "Scan my Mac" };
  }
  if (resultCount === 0) return { location: "center", label: "Scan again" };
  return { location: "header", label: "Rescan" };
}
