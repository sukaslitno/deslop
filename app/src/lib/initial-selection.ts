/**
 * Automatic pre-selection after a completed scan.
 *
 * Selection is per entry: an entry carries its own tier when the backend
 * reports one (for example Service Worker/CacheStorage stays YELLOW inside a
 * GREEN application-cache category), otherwise it inherits its category tier.
 * Only GREEN entries are ever selected automatically.
 */
export type SelectionTier = "GREEN" | "YELLOW" | "RED";

export interface SelectionEntry {
  id: string;
  tier?: SelectionTier | null;
}

export interface SelectionCategory {
  tier: SelectionTier;
  entries: readonly SelectionEntry[];
}

export function entryTier(entry: SelectionEntry, category: SelectionCategory): SelectionTier {
  return entry.tier ?? category.tier;
}

export function initialSelection(
  categories: readonly SelectionCategory[],
  mode: "automatic" | "manual",
): Set<string> {
  if (mode !== "automatic") return new Set();
  return new Set(
    categories.flatMap((category) =>
      category.entries.filter((entry) => entryTier(entry, category) === "GREEN").map((entry) => entry.id),
    ),
  );
}

/** Entries the user may tick: anything that is not manual-only (RED). */
export function selectableEntries<C extends SelectionCategory>(categories: readonly C[]): C["entries"][number][] {
  return categories.flatMap((category) => category.entries.filter((entry) => entryTier(entry, category) !== "RED"));
}
