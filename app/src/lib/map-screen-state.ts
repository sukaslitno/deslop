export type MapScreenState = {
  primaryAction: "View map" | null;
  showsFolderScan: boolean;
  retainsSnapshot: boolean;
  showsProgress: boolean;
};

/** Pure visibility model: entering Disk Map never initiates a scan by itself. */
export function mapScreenState({
  hasSnapshot,
  scanning,
}: {
  hasSnapshot: boolean;
  scanning: boolean;
}): MapScreenState {
  if (!hasSnapshot) {
    return {
      primaryAction: scanning ? null : "View map",
      showsFolderScan: false,
      retainsSnapshot: false,
      showsProgress: scanning,
    };
  }
  return {
    primaryAction: null,
    showsFolderScan: false,
    retainsSnapshot: true,
    showsProgress: scanning,
  };
}
