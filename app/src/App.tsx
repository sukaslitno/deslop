import { Fragment, useEffect, useMemo, useState } from "react";
// Pending Figma export: no local equivalent for the preflight shield yet (see DESIGN_AUDIT_PLAN 5.1).
import { SafeShield2Line } from "@mingcute/react";
import diskIcon from "@/assets/storage-drive-3d-256.png";
import automationEmptyIcon from "@/assets/figma/automation-empty.svg?url";
import scanStatusCheck from "@/assets/figma/scan-status-check.svg?url";
import warningHex from "@/assets/figma/warning-hex.svg?url";
import {
  api,
  type Category,
  type DiskInfo,
  type Preflight,
  type ScanJobStatus,
  type Tier,
  type TreeJobStatus,
  type MapSnapshot,
  type ExternalLinkAvailability,
  type CleanupBreakdownSnapshot,
  type CleanupCategoryId,
  type AppPreferences,
  type AppPreferencesPatch,
  type ScanSnapshot,
} from "@/lib/api";
import { cn, human } from "@/lib/utils";
import {
  Button,
  ButtonIcon,
  ButtonSmall,
  Checkbox,
  Controls,
  DiskStats,
  Icon,
  Input,
  Island,
  Radio,
  TabBar,
} from "@/design-system";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/design-system";
import { toast, ToastHost } from "@/lib/toast";
import { Treemap } from "@/components/treemap";
import { mapScreenState } from "@/lib/map-screen-state";
import { OrbitingCircles } from "@/components/orbiting-circles";
import { ScanningGlow } from "@/components/scanning-glow";
import { scanCtaFor } from "@/lib/clean-screen-state";
import { initialMessage, LocaleProvider, useLocale } from "@/i18n";

const TIER_ORDER: Record<Tier, number> = { GREEN: 0, YELLOW: 1, RED: 2 };
type AppRoute = "clean" | "map" | "automations" | "assistant" | "settings";
type WorkspaceRoute = Exclude<AppRoute, "settings">;

function diskLabel(bytes: number, locale: string) {
  const gigabytes = bytes / 1_000_000_000;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(gigabytes)} GB`;
}

function appCacheName(path: string) {
  const normalized = path.toLowerCase();
  if (normalized.includes("figma")) return "Figma";
  if (normalized.includes("slack") || normalized.includes("tinyspeck")) return "Slack";
  if (normalized.includes("arc") || normalized.includes("thebrowser")) return "Arc";
  if (normalized.includes("claude")) return "Claude";
  if (normalized.includes("codex")) return "Codex";
  if (normalized.includes("openai.chat") || normalized.includes("chatgpt")) return "ChatGPT";
  if (normalized.includes("lark")) return "Lark";
  return "Другое приложение";
}

function cacheLeaf(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(-2).join(" / ") || path;
}

// Main Palette only — one token per candidate category, no second palette.
const STORAGE_CATEGORY_META: Record<CleanupCategoryId, { token: string }> = {
  agentCaches: { token: "bg-[var(--vc-color-aqua)]" },
  editorCaches: { token: "bg-[var(--vc-color-purple)]" },
  applicationCaches: { token: "bg-[var(--vc-color-blue)]" },
  packageCaches: { token: "bg-[var(--vc-color-orange)]" },
  developerCaches: { token: "bg-[var(--vc-color-green)]" },
  modelCaches: { token: "bg-[var(--vc-color-dark-aqua)]" },
};

function StorageBreakdownBar({
  disk,
  breakdown,
  scanning,
}: {
  disk: DiskInfo | null;
  breakdown: CleanupBreakdownSnapshot | null;
  scanning: boolean;
}) {
  const { t, locale } = useLocale();
  const capacity = breakdown?.volumeCapacityBytes ?? disk?.total ?? 0;
  const available = breakdown?.volumeAvailableBytes ?? disk?.free ?? 0;
  const categories = breakdown?.categories ?? [];
  const candidateBytes = categories.reduce((total, category) => total + category.measuredBytes, 0);
  const used = Math.max(0, capacity - available);
  const otherUsed = Math.max(0, used - candidateBytes);
  const percent = (bytes: number) => capacity > 0 ? (bytes / capacity) * 100 : 0;
  const age = breakdown ? Math.max(0, Math.floor(Date.now() / 1000 - breakdown.completedAt)) : 0;
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const ageLabel = age < 60 ? relative.format(0, "second") : age < 3600 ? relative.format(-Math.floor(age / 60), "minute") : relative.format(-Math.floor(age / 3600), "hour");
  const caption = !breakdown
    ? scanning ? t("scanProgress") : t("scanToCalculate")
    : scanning ? t("scanProgressPrevious") : t(breakdown.isPartial ? "basedPartial" : "basedCompleted", { age: ageLabel });
  const Segment = ({ label, bytes, color }: { label: string; bytes: number; color: string }) => bytes > 0 ? (
    <div
      role="img"
      tabIndex={0}
      aria-label={`${label}: ${human(bytes)}`}
      className={cn("relative h-full shrink-0 overflow-hidden first:rounded-l-full last:rounded-r-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--vc-focus-ring)] focus-visible:ring-inset", color)}
      style={{ width: `${percent(bytes)}%` }}
    />
  ) : null;
  return (
    <section className="vc-corner-smooth w-full rounded-[var(--vc-radius-24)] border border-[var(--vc-border-subtle)] bg-[var(--vc-surface-foreground)] px-[var(--vc-gap-24)] py-[var(--vc-gap-16)]" aria-label={t("storageBreakdown")}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2">
          <img className="size-11 shrink-0" src={diskIcon} alt="" />
          <div className="min-w-0">
            <p className="text-muted-foreground text-style-caption font-medium tracking-[0.08em] uppercase">{t("currentVolume")}</p>
            {disk ? <p className="truncate text-style-body-small tracking-tight"><span className="text-style-heading font-medium tabular-nums">{t("availableOf", { available: human(available), capacity: human(capacity) })}</span></p> : <p className="text-muted-foreground mt-0.5 text-style-body-small">{t("readingCapacity")}</p>}
          </div>
        </div>
        {breakdown && <span className="text-muted-foreground pt-1 text-right text-style-caption tabular-nums">{candidateBytes ? t("candidateData", { bytes: human(candidateBytes) }) : t("noVerifiedCandidates")}</span>}
      </div>
      <div className="mt-4 flex h-5 overflow-hidden rounded-[var(--vc-radius-full)] border border-[var(--vc-border-subtle)] bg-[var(--vc-surface-background)] p-[var(--vc-gap-2)]" aria-label={t("capacitySegments")}>
        <Segment label={t("otherUsed")} bytes={otherUsed} color="bg-[var(--vc-surface-active)]" />
        {categories.map((category) => <Segment key={category.categoryId} label={t(category.categoryId)} bytes={category.measuredBytes} color={STORAGE_CATEGORY_META[category.categoryId].token} />)}
        <Segment label={t("available")} bytes={available} color="bg-[var(--vc-color-white)]" />
      </div>
      <div className="text-muted-foreground mt-2 text-style-caption" aria-live="polite">{caption}</div>
      {breakdown?.measurementKind === "logicalFallback" && candidateBytes > 0 && <div className="text-muted-foreground mt-1 text-style-caption">{t("candidateDataLogicalEstimate")}</div>}
      {breakdown && categories.length > 0 && <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-style-caption" aria-label={t("candidateCategories")}>
        {categories.map((category) => {
          const meta = STORAGE_CATEGORY_META[category.categoryId];
          const label = t(category.categoryId);
          return <li key={category.categoryId} className="flex items-center gap-1.5" tabIndex={0} aria-label={`${label}: ${human(category.measuredBytes)}, ${t("candidateCount", { count: category.candidateCount })}`}><span className={cn("size-2 rounded-sm", meta.token)} aria-hidden="true" />{label} · {human(category.measuredBytes)} · {t("candidateCount", { count: category.candidateCount })}</li>;
        })}
      </ul>}
      {breakdown && categories.length === 0 && <div className="text-muted-foreground mt-3 text-style-caption">{t("noVerifiedCandidates")}</div>}
    </section>
  );
}

const FALLBACK_PREFERENCES: AppPreferences = {
  schemaVersion: 1,
  locale: "en",
  appearance: "system",
  safeCandidateSelection: "automatic",
  sizeUnits: "binary",
  rememberLastMapFolder: false,
  lastMapFolder: null,
};

export default function App() {
  const [preferences, setPreferences] = useState<AppPreferences | null>(null);
  useEffect(() => {
    void api.getPreferences().then((response) => {
      const locale = response.hasPersistedPreferences
        ? response.preferences.locale
        : navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";
      setPreferences({ ...response.preferences, locale });
    }).catch(() => setPreferences(FALLBACK_PREFERENCES));
  }, []);
  if (!preferences) {
    const locale = navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";
    return <div className="flex h-screen items-center justify-center bg-background text-style-body-small text-muted-foreground">{initialMessage(locale, "loading")}</div>;
  }
  return <LocaleProvider preferences={preferences}><AppShell preferences={preferences} onPreferencesChange={setPreferences} /></LocaleProvider>;
}

function ScanningWorkspace({
  disk,
  onCancel,
  onOpenSettings,
  onViewChange,
  scanJob,
}: {
  disk: DiskInfo | null;
  onCancel: () => void;
  onOpenSettings: () => void;
  onViewChange: (view: WorkspaceRoute) => void;
  scanJob: ScanJobStatus | null;
}) {
  const { locale, t } = useLocale();
  const used = disk ? Math.max(0, disk.total - disk.free) : 0;
  const usedPercentage = disk?.total ? (used / disk.total) * 100 : 0;
  const detail = scanJob?.total_rules
    ? t("scanProgressDetail", { completed: scanJob.completed_rules, total: scanJob.total_rules })
    : t("preparingRules");

  return (
    <main className="vc-corner-smooth relative h-full min-h-0 w-full overflow-hidden rounded-[var(--vc-radius-32)] bg-[var(--vc-surface-background)] text-[var(--vc-text-primary)]">
      <ScanningGlow />

      <div className="absolute inset-[var(--vc-gap-32)] flex min-h-0 flex-col items-start gap-[var(--vc-gap-32)]">
        <Controls
          actionLabel={t("settings")}
          onActionClick={onOpenSettings}
          onValueChange={(value) => onViewChange(value as WorkspaceRoute)}
          tabs={[
            { id: "clean", label: t("clean"), icon: "clean" },
            { id: "map", label: t("diskMap"), icon: "layers" },
            { id: "automations", label: t("automations"), icon: "automation" },
          ]}
          value="clean"
        />
        <DiskStats
          capacityLabel={disk ? diskLabel(disk.total, locale) : "—"}
          state="empty"
          usedLabel={disk ? diskLabel(used, locale) : "—"}
          usedPercentage={usedPercentage}
        />

        <section className="flex w-full min-h-0 flex-1 flex-col items-center justify-center gap-[var(--vc-gap-24)] overflow-hidden text-center" role="status" aria-live="polite">
          <div className="vc-corner-smooth grid size-16 place-items-center overflow-hidden rounded-[var(--vc-radius-24)] bg-[var(--vc-surface-foreground)]">
            <img alt="" src={scanStatusCheck} />
          </div>
          <div className="flex flex-col items-center gap-[var(--vc-gap-16)] whitespace-nowrap">
            <h1 className="text-style-heading font-medium tracking-[-0.02em]">{t("scanningLocations")}</h1>
            <p className="text-style-caption tracking-[-0.02em] text-[var(--vc-text-secondary)]">{detail}</p>
          </div>
          <Button disabled={!scanJob} icon="x" onClick={onCancel} variant="destructive">
            {t("cancelScanShort")}
          </Button>
        </section>
      </div>
    </main>
  );
}

type CleanupResultsWorkspaceProps = {
  breakdown: CleanupBreakdownSnapshot | null;
  cats: Category[];
  cleaning: boolean;
  disk: DiskInfo | null;
  error: string;
  expanded: Set<string>;
  initializing: boolean;
  onCancelScan: () => void;
  onOpenSettings: () => void;
  onRequestClean: (ids: string[]) => void;
  onScan: () => void;
  onToggleCategory: (category: Category) => void;
  onToggleEntry: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onViewChange: (view: WorkspaceRoute) => void;
  preflighting: boolean;
  scanCta: ReturnType<typeof scanCtaFor>;
  scanJob: ScanJobStatus | null;
  scanning: boolean;
  selectable: readonly Category["entries"][number][];
  selected: Set<string>;
  selectedTotal: number;
  sortedCats: readonly Category[];
};

function CleanupResultsWorkspace({
  breakdown,
  cats,
  cleaning,
  disk,
  error,
  expanded,
  initializing,
  onCancelScan,
  onOpenSettings,
  onRequestClean,
  onScan,
  onToggleCategory,
  onToggleEntry,
  onToggleExpand,
  onViewChange,
  preflighting,
  scanCta,
  scanJob,
  scanning,
  selectable,
  selected,
  selectedTotal,
  sortedCats,
}: CleanupResultsWorkspaceProps) {
  const { locale, t } = useLocale();
  const capacity = breakdown?.volumeCapacityBytes ?? disk?.total ?? 0;
  const available = breakdown?.volumeAvailableBytes ?? disk?.free ?? 0;
  const used = Math.max(0, capacity - available);
  const breakdownById = new Map(
    (breakdown?.categories ?? []).map((category) => [category.categoryId, category.measuredBytes]),
  );
  const legendDefinitions: Array<{
    categoryId: CleanupCategoryId;
    label: string;
    tone: "green" | "blue" | "orange" | "white";
  }> = [
    { categoryId: "agentCaches", label: t("agentCaches"), tone: "green" },
    { categoryId: "packageCaches", label: t("packageCaches"), tone: "blue" },
    { categoryId: "applicationCaches", label: t("applicationCaches"), tone: "orange" },
    { categoryId: "modelCaches", label: t("modelCaches"), tone: "white" },
  ];
  const segments = legendDefinitions.flatMap((definition) => {
    const bytes = breakdownById.get(definition.categoryId) ?? 0;
    if (!bytes || !capacity) return [];
    return [{
      id: definition.categoryId,
      label: `${definition.label}: ${human(bytes)}`,
      percentage: (bytes / capacity) * 100,
      tone: definition.tone,
    }];
  });
  const representedBytes = segments.reduce(
    (sum, segment) => sum + (segment.percentage / 100) * capacity,
    0,
  );
  const neutralUsedPercentage = capacity
    ? (Math.max(0, used - representedBytes) / capacity) * 100
    : 0;
  const elapsedSeconds = breakdown
    ? Math.max(0, Math.floor(Date.now() / 1000 - breakdown.completedAt))
    : 0;
  const relativeTime = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const scanAge = elapsedSeconds < 60
    ? relativeTime.format(0, "second")
    : elapsedSeconds < 3600
      ? relativeTime.format(-Math.floor(elapsedSeconds / 60), "minute")
      : relativeTime.format(-Math.floor(elapsedSeconds / 3600), "hour");
  const categoryGroups = ["GREEN", "YELLOW", "RED"] as const;

  return (
    <main className="relative h-full min-h-0 w-full overflow-hidden rounded-[var(--vc-radius-32)] bg-[var(--vc-surface-background)] text-[var(--vc-text-primary)]">
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="flex min-h-full flex-col gap-[var(--vc-gap-32)] p-[var(--vc-gap-32)] pb-[calc(var(--vc-gap-64)+var(--vc-gap-32))]">
          <Controls
            actionLabel={t("settings")}
            onActionClick={onOpenSettings}
            onValueChange={(value) => onViewChange(value as WorkspaceRoute)}
            tabs={[
              { id: "clean", label: t("clean"), icon: "clean" },
              { id: "map", label: t("diskMap"), icon: "layers" },
              { id: "automations", label: t("automations"), icon: "automation" },
            ]}
            value="clean"
          />
          <DiskStats
            capacityLabel={disk ? diskLabel(capacity, locale) : "—"}
            lastScanLabel={breakdown ? t("lastScan", { age: scanAge }) : undefined}
            segments={segments}
            state={cats.length ? "results" : "empty"}
            usedLabel={disk ? diskLabel(used, locale) : "—"}
            usedPercentage={neutralUsedPercentage}
          />

          {initializing ? <LoadingState message={t("preparing")} /> : null}
          {scanCta.location === "center" ? <EmptyState action={scanCta.label} onScan={onScan} /> : null}
          {error ? (
            <div className="vc-corner-smooth rounded-[var(--vc-radius-16)] bg-[var(--vc-danger-foreground)] p-[var(--vc-gap-16)] text-style-body-small text-[var(--vc-text-primary)]" role="alert">
              {error}
            </div>
          ) : null}

          {categoryGroups.map((tier) => {
            const categories = sortedCats.filter((category) => category.tier === tier);
            return categories.length ? (
              <CleanupTierSection
                categories={categories}
                expanded={expanded}
                key={tier}
                onToggleCategory={onToggleCategory}
                onToggleEntry={onToggleEntry}
                onToggleExpand={onToggleExpand}
                selected={selected}
                tier={tier}
              />
            ) : null;
          })}
        </div>
      </div>

      {selectable.length > 0 ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-[var(--vc-gap-24)] z-30 flex justify-center px-[var(--vc-gap-24)]">
          <Island className="pointer-events-auto">
            <div className="flex h-full items-center justify-center px-[var(--vc-gap-16)] text-style-body font-medium tracking-[-0.02em] text-[var(--vc-text-secondary)]">
              {t("selectedSummary", { count: selected.size, bytes: human(selectedTotal) })}
            </div>
            {scanCta.location === "header" ? (
              scanCta.label === "Cancel scan" ? (
                <Button
                  disabled={cleaning || preflighting || !scanJob}
                  icon="x"
                  onClick={onCancelScan}
                  variant="gray"
                >
                  {t("cancelScan")}
                </Button>
              ) : (
                <Button disabled={cleaning || preflighting} icon="refresh" onClick={onScan} variant="gray">
                  {t("rescanShort")}
                </Button>
              )
            ) : null}
            <Button
              disabled={cleaning || scanning || preflighting || selected.size === 0}
              icon="delete"
              onClick={() => onRequestClean([...selected])}
              variant="destructive"
            >
              {preflighting ? t("checking") : t("cleanAction")}
            </Button>
          </Island>
        </div>
      ) : null}
    </main>
  );
}

function CleanupTierSection({
  categories,
  expanded,
  onToggleCategory,
  onToggleEntry,
  onToggleExpand,
  selected,
  tier,
}: {
  categories: readonly Category[];
  expanded: Set<string>;
  onToggleCategory: (category: Category) => void;
  onToggleEntry: (id: string) => void;
  onToggleExpand: (id: string) => void;
  selected: Set<string>;
  tier: Tier;
}) {
  const { t } = useLocale();
  const isSafe = tier === "GREEN";
  const title = isSafe ? t("readyToClean") : tier === "YELLOW" ? t("questionable") : t("manualOnly");
  const description = isSafe
    ? t("tierRecommendedDetail")
    : tier === "YELLOW"
      ? t("questionableDetail")
      : t("tierManualDetail");

  return (
    <section className="vc-corner-smooth flex flex-col gap-[var(--vc-gap-24)] rounded-[var(--vc-radius-24)] bg-[var(--vc-surface-foreground)] p-[var(--vc-gap-24)]" aria-labelledby={`tier-${tier}`}>
      <header className="flex h-12 items-center gap-[var(--vc-gap-16)]">
        <span className={cn(
          "vc-corner-smooth grid size-12 shrink-0 place-items-center rounded-[var(--vc-radius-16)]",
          isSafe ? "bg-[var(--vc-success-foreground)]" : "bg-[var(--vc-warning-foreground)]",
        )}>
          {isSafe ? (
            <span className="grid size-6 place-items-center rounded-full bg-[var(--vc-success)]">
              <span aria-hidden className="mb-px h-[9px] w-[5px] rotate-45 border-b-2 border-r-2 border-[var(--vc-success-foreground)]" />
            </span>
          ) : <img alt="" className="size-8" src={warningHex} />}
        </span>
        <div className="min-w-0">
          <h1 id={`tier-${tier}`} className="text-style-heading font-normal tracking-[-0.02em]">{title}</h1>
          <p className="mt-[var(--vc-gap-8)] text-style-caption tracking-[-0.02em] text-[var(--vc-text-secondary)]">{description}</p>
        </div>
      </header>
      <div className="flex flex-col gap-[var(--vc-gap-8)]">
        {categories.map((category) => (
          <CleanupCategoryRow
            category={category}
            expanded={expanded}
            key={category.id}
            onToggleCategory={onToggleCategory}
            onToggleEntry={onToggleEntry}
            onToggleExpand={onToggleExpand}
            selected={selected}
          />
        ))}
      </div>
    </section>
  );
}

function CleanupCategoryRow({
  category,
  expanded,
  onToggleCategory,
  onToggleEntry,
  onToggleExpand,
  selected,
}: {
  category: Category;
  expanded: Set<string>;
  onToggleCategory: (category: Category) => void;
  onToggleEntry: (id: string) => void;
  onToggleExpand: (id: string) => void;
  selected: Set<string>;
}) {
  const { t } = useLocale();
  const isOpen = expanded.has(category.id);
  const checkable = category.tier !== "RED";
  const entryIds = category.entries.map((entry) => entry.id);
  const allSelected = entryIds.length > 0 && entryIds.every((id) => selected.has(id));
  const someSelected = !allSelected && entryIds.some((id) => selected.has(id));
  const sortedEntries = [...category.entries].sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
  const applicationGroups = category.id === "appcache"
    ? Object.entries(sortedEntries.reduce<Record<string, typeof sortedEntries>>((groups, entry) => {
      const name = appCacheName(entry.path);
      (groups[name] ??= []).push(entry);
      return groups;
    }, {})).sort(([, left], [, right]) => (
      right.reduce((sum, entry) => sum + entry.size, 0) - left.reduce((sum, entry) => sum + entry.size, 0)
    ))
    : [];

  return (
    <article className="vc-corner-smooth flex flex-col gap-[var(--vc-gap-16)] overflow-hidden rounded-[var(--vc-radius-16)] bg-[var(--vc-surface-active)] p-[var(--vc-gap-16)]">
      <div className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-[var(--vc-gap-16)]">
        <div className="flex min-w-0 items-center gap-[var(--vc-gap-16)]">
          <Checkbox
            aria-label={t("select", { path: category.title })}
            checked={allSelected ? true : someSelected ? "indeterminate" : false}
            disabled={!checkable}
            onCheckedChange={() => onToggleCategory(category)}
          />
          <div className="flex min-w-0 items-center gap-[var(--vc-gap-8)]">
            <button
              aria-expanded={isOpen}
              className="min-w-0 text-left text-style-body font-medium tracking-[-0.02em] outline-none focus-visible:ring-2 focus-visible:ring-[var(--vc-focus-ring)]"
              onClick={() => onToggleExpand(category.id)}
              type="button"
            >
              <span className="block truncate">{category.title}</span>
            </button>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex -translate-y-[0.5px]" tabIndex={0}>
                  <Icon className="size-4 text-[var(--vc-text-secondary)]" name="info" />
                </span>
              </TooltipTrigger>
              <TooltipContent>{category.note}</TooltipContent>
            </Tooltip>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-[var(--vc-gap-16)]">
          <span className="text-style-numeric-large tracking-[-0.02em]">{human(category.total)}</span>
          <button
            aria-label={isOpen ? t("collapse") : t("expand")}
            className="grid size-4 place-items-center outline-none focus-visible:ring-2 focus-visible:ring-[var(--vc-focus-ring)]"
            onClick={() => onToggleExpand(category.id)}
            type="button"
          >
            <Icon className="size-4 text-[var(--vc-text-primary)]" name={isOpen ? "arrowUp" : "arrowDown"} />
          </button>
        </div>
      </div>

      {isOpen ? (
        <div className="w-full">
          {applicationGroups.length ? (
            <div className="flex flex-col gap-[var(--vc-gap-8)]">
              {applicationGroups.map(([name, entries]) => (
                <CleanupApplicationGroup
                  entries={entries}
                  expanded={expanded}
                  groupId={`${category.id}:${name}`}
                  key={name}
                  name={name}
                  onToggleEntry={onToggleEntry}
                  onToggleExpand={onToggleExpand}
                  selected={selected}
                />
              ))}
            </div>
          ) : (
            <ul className="vc-corner-smooth flex flex-col gap-[var(--vc-gap-8)] rounded-[var(--vc-radius-16)] bg-[var(--vc-surface-foreground)] p-[var(--vc-gap-16)]">
              {sortedEntries.map((entry) => (
                <CleanupEntryRow
                  checkable={checkable}
                  entry={entry}
                  key={entry.id}
                  onToggleEntry={onToggleEntry}
                  selected={selected.has(entry.id)}
                />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </article>
  );
}

function CleanupApplicationGroup({
  entries,
  expanded,
  groupId,
  name,
  onToggleEntry,
  onToggleExpand,
  selected,
}: {
  entries: readonly Category["entries"][number][];
  expanded: Set<string>;
  groupId: string;
  name: string;
  onToggleEntry: (id: string) => void;
  onToggleExpand: (id: string) => void;
  selected: Set<string>;
}) {
  const { t } = useLocale();
  const isOpen = expanded.has(groupId);
  const allSelected = entries.length > 0 && entries.every((entry) => selected.has(entry.id));
  const someSelected = !allSelected && entries.some((entry) => selected.has(entry.id));
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);

  return (
    <section className="vc-corner-smooth flex flex-col gap-[var(--vc-gap-8)] rounded-[var(--vc-radius-16)] bg-[var(--vc-surface-foreground)] p-[var(--vc-gap-16)]">
      <div className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-[var(--vc-gap-16)]">
        <div className="flex min-w-0 items-center gap-[var(--vc-gap-8)]">
          <Checkbox
            aria-label={t("select", { path: name })}
            checked={allSelected ? true : someSelected ? "indeterminate" : false}
            onCheckedChange={() => entries.forEach((entry) => {
              if (allSelected === selected.has(entry.id)) onToggleEntry(entry.id);
            })}
          />
          <button
            aria-expanded={isOpen}
            className="min-w-0 flex-1 text-left text-style-body font-medium tracking-[-0.02em] outline-none focus-visible:ring-2 focus-visible:ring-[var(--vc-focus-ring)]"
            onClick={() => onToggleExpand(groupId)}
            type="button"
          >
            <span className="block truncate">{name}</span>
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-[var(--vc-gap-8)]">
          <span className="text-style-body tabular-nums tracking-[-0.02em]">{human(total)}</span>
          <button
            aria-label={isOpen ? t("collapse") : t("expand")}
            className="grid size-4 place-items-center outline-none focus-visible:ring-2 focus-visible:ring-[var(--vc-focus-ring)]"
            onClick={() => onToggleExpand(groupId)}
            type="button"
          >
            <Icon className="size-4 text-[var(--vc-text-primary)]" name={isOpen ? "arrowUp" : "arrowDown"} />
          </button>
        </div>
      </div>
      {isOpen ? (
        <ul className="flex flex-col gap-[var(--vc-gap-8)]">
          {entries.map((entry) => (
            <CleanupEntryRow entry={entry} key={entry.id} nested onToggleEntry={onToggleEntry} selected={selected.has(entry.id)} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function CleanupEntryRow({
  checkable = true,
  entry,
  nested = false,
  onToggleEntry,
  selected,
}: {
  checkable?: boolean;
  entry: Category["entries"][number];
  nested?: boolean;
  onToggleEntry: (id: string) => void;
  selected: boolean;
}) {
  const { t } = useLocale();
  return (
    <li className={cn(
      "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-[var(--vc-gap-16)]",
      nested && "px-[var(--vc-gap-24)]",
    )}>
      <div className="flex min-w-0 items-center gap-[var(--vc-gap-8)]">
        <Checkbox
          aria-label={t("select", { path: entry.path })}
          checked={selected}
          disabled={!checkable}
          onCheckedChange={() => onToggleEntry(entry.id)}
        />
        <span className={cn(
          "min-w-0 flex-1 truncate text-[var(--vc-text-secondary)] tracking-[-0.02em]",
          nested ? "text-style-body-small font-medium" : "text-style-body",
        )} title={entry.path}>{cacheLeaf(entry.path)}</span>
      </div>
      <span className="shrink-0 text-style-body tabular-nums tracking-[-0.02em]">{human(entry.size)}</span>
    </li>
  );
}

function AppShell({ preferences, onPreferencesChange }: { preferences: AppPreferences; onPreferencesChange: (preferences: AppPreferences) => void }) {
  const { t, collator } = useLocale();
  const [roots, setRoots] = useState<string[]>([]);
  const [disk, setDisk] = useState<DiskInfo | null>(null);
  const [breakdown, setBreakdown] = useState<CleanupBreakdownSnapshot | null>(null);
  const [cats, setCats] = useState<Category[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [error, setError] = useState<string>("");
  const [scanError, setScanError] = useState<string>("");
  const [scanJob, setScanJob] = useState<ScanJobStatus | null>(null);
  const [scannedOnce, setScannedOnce] = useState(false);
  const [view, setView] = useState<AppRoute>("clean");
  const [settingsReturnView, setSettingsReturnView] = useState<WorkspaceRoute>("clean");
  const [initializing, setInitializing] = useState(true);
  const [preflighting, setPreflighting] = useState(false);

  async function applyPreferences(patch: AppPreferencesPatch) {
    const previous = preferences;
    const optimistic = { ...preferences, ...patch } as AppPreferences;
    if (patch.rememberLastMapFolder === false) optimistic.lastMapFolder = null;
    onPreferencesChange(optimistic);
    try {
      onPreferencesChange(await api.updatePreferences(patch));
    } catch {
      onPreferencesChange(previous);
      toast(t("settingsSaveError"), "danger");
    }
  }

  function initialSelection(snapshot: ScanSnapshot) {
    return preferences.safeCandidateSelection === "automatic"
      ? new Set(snapshot.categories.filter((category) => category.tier === "GREEN").flatMap((category) => category.entries.map((entry) => entry.id)))
      : new Set<string>();
  }

  async function runScan() {
    setScanning(true);
    setError("");
    setScanError("");
    try {
      const r = roots.length ? roots : await api.defaultRoots();
      if (!roots.length) setRoots(r);
      const [d, started] = await Promise.all([api.diskInfo(), api.startScan(r)]);
      setDisk(d);
      setScanJob(started);
      let job = started;
      while (job.phase === "running" || job.phase === "cancelling") {
        await new Promise((resolve) => window.setTimeout(resolve, 180));
        job = await api.scanJobStatus(started.id);
        setScanJob(job);
      }
      setScanJob(job);
      if (job.phase === "cancelled") return;
      if (job.phase !== "completed" || !job.snapshot) throw new Error(job.error ?? job.message);
      const snapshot = job.snapshot;
      setSnapshotId(snapshot.id);
      setCats(snapshot.categories);
      setBreakdown(snapshot.breakdown);
      // Default selection is per-entry, never a whole category.
      setSelected(initialSelection(snapshot));
      setScannedOnce(true);
    } catch (e) {
      const message = String(e);
      setError(message);
      setScanError(message);
      toast(message, "danger");
    } finally {
      setScanning(false);
      setScanJob(null);
    }
  }

  useEffect(() => {
    let mounted = true;
    Promise.all([api.defaultRoots(), api.diskInfo()])
      .then(([defaultRoots, diskInfo]) => {
        if (!mounted) return;
        setRoots(defaultRoots);
        setDisk(diskInfo);
      })
      .catch((e) => mounted && setError(String(e)))
      .finally(() => mounted && setInitializing(false));
    return () => {
      mounted = false;
    };
  }, []);

  const selectable = useMemo(() => cats.flatMap((c) => c.tier === "RED" ? [] : c.entries), [cats]);
  const selectedTotal = useMemo(
    () =>
      cats
        .flatMap((c) => c.entries)
        .filter((entry) => selected.has(entry.id))
        .reduce((sum, entry) => sum + entry.size, 0),
    [cats, selected],
  );
  const sortedCats = useMemo(
    () =>
      [...cats].sort(
        (a, b) =>
          TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
          b.total - a.total ||
          collator.compare(a.title, b.title),
      ),
    [cats],
  );

  function toggleEntry(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function toggleCategory(category: Category) {
    const ids = category.entries.map((entry) => entry.id);
    setSelected((previous) => {
      const next = new Set(previous);
      const allSelected = ids.every((id) => next.has(id));
      ids.forEach((id) => allSelected ? next.delete(id) : next.add(id));
      return next;
    });
  }
  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function requestClean(ids: string[]) {
    if (!snapshotId || !ids.length) return;
    setPreflighting(true);
    setError("");
    try {
      setPreflight(await api.preflight(snapshotId, ids));
    } catch (e) {
      setError(String(e));
    } finally {
      setPreflighting(false);
    }
  }
  async function confirmClean() {
    if (!preflight) return;
    setCleaning(true);
    setError("");
    try {
      const r = await api.clean(preflight.id, preflight.requires_yellow_confirmation);
      toast(
        r.deleted.length ? t("freed", { bytes: human(r.freed) }) : t("nothingRemoved"),
        r.errors.length || !r.deleted.length ? "danger" : "success",
      );
      setPreflight(null);
      const [d, snapshot] = await Promise.all([api.diskInfo(), api.scan(roots)]);
      setDisk(d);
      setSnapshotId(snapshot.id);
      setCats(snapshot.categories);
      setBreakdown(snapshot.breakdown);
      setSelected(initialSelection(snapshot));
    } catch (e) {
      setError(String(e));
      toast(String(e), "danger");
    } finally {
      setCleaning(false);
    }
  }

  const scanCta = scanCtaFor({
    initializing,
    scanning,
    scannedOnce,
    resultCount: cats.length,
    hasInitialScanError: !scannedOnce && scanError.length > 0,
  });
  const isScanningClean = view === "clean" && scanCta.location === "progress";

  async function cancelScan() {
    if (!scanJob) return;
    setScanJob(await api.cancelScan(scanJob.id));
  }

  function openSettings() {
    if (view !== "settings") setSettingsReturnView(view);
    setView("settings");
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey && event.key === ",") {
        event.preventDefault();
        openSettings();
      }
      if (event.key === "Escape" && view === "settings") {
        event.preventDefault();
        setView(settingsReturnView);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [view, settingsReturnView]);

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col bg-background text-foreground">
        {/* Keep this space clear for macOS traffic lights and window dragging. */}
        <div data-tauri-drag-region className="h-14 shrink-0" />
        {isScanningClean ? (
          <ScanningWorkspace
            disk={disk}
            onCancel={cancelScan}
            onOpenSettings={openSettings}
            onViewChange={(nextView) => setView(nextView)}
            scanJob={scanJob}
          />
        ) : view === "clean" ? (
          <CleanupResultsWorkspace
            breakdown={breakdown}
            cats={cats}
            cleaning={cleaning}
            disk={disk}
            error={error}
            expanded={expanded}
            initializing={initializing}
            onCancelScan={cancelScan}
            onOpenSettings={openSettings}
            onRequestClean={requestClean}
            onScan={runScan}
            onToggleCategory={toggleCategory}
            onToggleEntry={toggleEntry}
            onToggleExpand={toggleExpand}
            onViewChange={(nextView) => setView(nextView)}
            preflighting={preflighting}
            scanCta={scanCta}
            scanJob={scanJob}
            scanning={scanning}
            selectable={selectable}
            selected={selected}
            selectedTotal={selectedTotal}
            sortedCats={sortedCats}
          />
        ) : view === "map" ? (
          <MapView
            disk={disk}
            onOpenSettings={openSettings}
            onViewChange={(nextView) => setView(nextView)}
            preferences={preferences}
          />
        ) : view === "automations" ? (
          <AutomationsView
            disk={disk}
            onOpenSettings={openSettings}
            onViewChange={(nextView) => setView(nextView)}
          />
        ) : view === "settings" ? (
          <SettingsView
            onBack={() => setView(settingsReturnView)}
            onPreferencesUpdate={applyPreferences}
            preferences={preferences}
          />
        ) : <>
        <header className="flex shrink-0 flex-col gap-3 px-5 pb-5">
          <StorageBreakdownBar disk={disk} breakdown={breakdown} scanning={scanning} />

          <div className="flex flex-wrap items-center justify-between gap-[var(--vc-gap-16)]">
            <TabBar
              aria-label={t("workspace")}
              className="min-w-0 max-[980px]:flex-1"
              items={[
                { id: "clean", label: t("clean"), icon: "clean" },
                { id: "map", label: t("diskMap"), icon: "layers" },
                { id: "automations", label: t("automations"), icon: "time" },
                { id: "assistant", label: t("assistant"), icon: "chat" },
              ]}
              onValueChange={(next) => setView(next as WorkspaceRoute)}
              value={view}
            />
            <ButtonIcon icon="settings" label={t("settings")} onClick={openSettings} />
          </div>
        </header>

        {view === "assistant" && <AssistantView />}

        </>}
      </div>
      <ToastHost />
      {preflight && (
        <PreflightDialog
          preflight={preflight}
          cleaning={cleaning}
          onCancel={() => setPreflight(null)}
          onConfirm={confirmClean}
        />
      )}
    </TooltipProvider>
  );
}

function MapView({
  disk,
  onOpenSettings,
  onViewChange,
  preferences,
}: {
  disk: DiskInfo | null;
  onOpenSettings: () => void;
  onViewChange: (view: WorkspaceRoute) => void;
  preferences: AppPreferences;
}) {
  const { t, locale } = useLocale();
  const [snapshot, setSnapshot] = useState<MapSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [treeJob, setTreeJob] = useState<TreeJobStatus | null>(null);

  async function scanHome() {
    setError("");
    try {
      const home = preferences.rememberLastMapFolder && preferences.lastMapFolder
        ? preferences.lastMapFolder
        : await api.homeDir();
      const next = await runTreeScan(home, 6, 20 * 1024 * 1024);
      if (next) setSnapshot(next);
    } catch (e) {
      setError(String(e));
    }
  }

  async function runTreeScan(root: string, maxDepth: number, minSize: number) {
    setLoading(true);
    setError("");
    try {
      const started = await api.startTreeScan(root, maxDepth, minSize);
      setTreeJob(started);
      let job = started;
      while (job.phase === "running" || job.phase === "cancelling") {
        await new Promise((resolve) => window.setTimeout(resolve, 180));
        job = await api.treeJobStatus(started.id);
        setTreeJob(job);
      }
      if (job.phase === "cancelled") {
        setError(t(snapshot ? "mapRefreshCancelled" : "mapInitialScanCancelled"));
        return null;
      }
      if (job.phase !== "completed" || !job.snapshot) throw new Error(job.error ?? job.message);
      return job.snapshot;
    } finally {
      setLoading(false);
      setTreeJob(null);
    }
  }

  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!snapshot) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [snapshot]);

  function snapshotAge() {
    if (!snapshot) return "";
    const seconds = Math.max(0, Math.floor(now / 1000 - snapshot.created_at));
    const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    const age = seconds < 60 ? relative.format(0, "second") : seconds < 3600 ? relative.format(-Math.floor(seconds / 60), "minute") : relative.format(-Math.floor(seconds / 3600), "hour");
    return t("lastScan", { age });
  }

  const used = disk ? Math.max(0, disk.total - disk.free) : 0;
  const screenState = mapScreenState({ hasSnapshot: Boolean(snapshot), scanning: loading });
  const isInitialMapScan = !snapshot && screenState.showsProgress;

  function cancelTreeScan() {
    if (!treeJob) return;
    void api.cancelTreeScan(treeJob.id).then(setTreeJob);
  }

  return (
    <main className="vc-corner-smooth relative h-full min-h-0 w-full overflow-hidden rounded-[var(--vc-radius-32)] bg-[var(--vc-surface-background)] text-[var(--vc-text-primary)]">
      {isInitialMapScan ? <ScanningGlow /> : null}
      <div className="relative z-10 flex h-full min-h-0 flex-col items-start gap-[var(--vc-gap-32)] p-[var(--vc-gap-32)]">
        <Controls
          actionLabel={t("settings")}
          onActionClick={onOpenSettings}
          onValueChange={(value) => onViewChange(value as WorkspaceRoute)}
          tabs={[
            { id: "clean", label: t("clean"), icon: "clean" },
            { id: "map", label: t("diskMap"), icon: "layers" },
            { id: "automations", label: t("automations"), icon: "automation" },
          ]}
          value="map"
        />
        <DiskStats
          capacityLabel={disk ? diskLabel(disk.total, locale) : "—"}
          className="max-w-none shrink-0"
          lastScanLabel={snapshot ? snapshotAge() : t("mapNotScanned")}
          state="compact"
          usedLabel={disk ? diskLabel(used, locale) : "—"}
        />

        <div className="relative min-h-0 w-full flex-1">
          {error && <div className="border-red/30 bg-red/5 text-red mb-3 rounded-xl border p-3 text-style-body-small" role="alert">{error}</div>}
          {isInitialMapScan && (
            <section className="flex h-full w-full flex-col items-center justify-center gap-[var(--vc-gap-24)] overflow-hidden text-center" role="status" aria-busy="true" aria-live="polite">
              <div className="vc-corner-smooth grid size-16 place-items-center overflow-hidden rounded-[var(--vc-radius-24)] bg-[var(--vc-surface-foreground)]">
                <img alt="" src={scanStatusCheck} />
              </div>
              <div className="flex flex-col items-center gap-[var(--vc-gap-16)] whitespace-nowrap">
                <h1 className="text-style-heading font-medium tracking-[-0.02em]">{t("buildingDiskMap")}</h1>
                <p className="text-style-caption tracking-[-0.02em] text-[var(--vc-text-secondary)]">{t("buildingDiskMapDetail")}</p>
              </div>
              <Button disabled={!treeJob} icon="x" onClick={cancelTreeScan} variant="destructive">
                {t("cancelScanShort")}
              </Button>
            </section>
          )}
          {snapshot && <Treemap key={snapshot.id} root={snapshot.root} snapshotId={snapshot.id} onReveal={api.revealMapNode} />}
          {!snapshot && !loading && (
            <section className="flex h-full w-full flex-col items-center justify-center gap-[var(--vc-gap-24)] overflow-hidden text-center">
              <div className="vc-corner-smooth grid size-16 place-items-center overflow-hidden rounded-[var(--vc-radius-24)] bg-[var(--vc-color-dark-aqua)]">
                <Icon className="size-[42px] text-[var(--vc-color-aqua)]" name="layers" />
              </div>
              <div className="flex flex-col items-center gap-[var(--vc-gap-16)]">
                <h1 className="text-style-heading font-medium tracking-[-0.02em]">{t("diskMapEmptyTitle")}</h1>
                <p className="max-w-[416px] whitespace-pre-line text-style-caption tracking-[-0.02em] text-[var(--vc-text-secondary)]">
                  {t("diskMapEmptyBody")}
                </p>
              </div>
              <Button icon="layers" onClick={scanHome}>
                {t("viewDiskMap")}
              </Button>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}

function SettingsView({
  onBack,
  preferences,
  onPreferencesUpdate,
}: {
  onBack: () => void;
  preferences: AppPreferences;
  onPreferencesUpdate: (patch: AppPreferencesPatch) => Promise<void>;
}) {
  const { t } = useLocale();
  const [version, setVersion] = useState("");

  useEffect(() => {
    void api.appInfo().then((info) => setVersion(info.version)).catch(() => undefined);
  }, []);

  const openSettingsLink = (kind: ExternalLinkAvailability["kind"]) => {
    void api.openExternalLink(kind).catch(() => toast(t("settingsLinksUnavailable"), "danger"));
  };

  return (
    <main className="vc-corner-smooth relative h-full min-h-0 w-full overflow-hidden rounded-[var(--vc-radius-32)] bg-[var(--vc-surface-background)] text-[var(--vc-text-primary)]" aria-label={t("settings")}>
      <header className="absolute left-[var(--vc-gap-32)] right-[var(--vc-gap-32)] top-[var(--vc-gap-32)] flex h-12 items-center gap-[var(--vc-gap-8)]">
        <button
          aria-label={t("back")}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-[var(--vc-radius-4)] text-[var(--vc-text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--vc-focus-ring)]"
          onClick={onBack}
          type="button"
        >
          <Icon aria-hidden className="size-6" name="arrowLeft" />
        </button>
        <h1 className="text-style-heading font-medium tracking-[-0.02em]">{t("settings")}</h1>
      </header>

      <section className="vc-corner-smooth absolute left-[var(--vc-gap-32)] right-[var(--vc-gap-32)] top-[calc(var(--vc-gap-64)+var(--vc-gap-32)+var(--vc-gap-8))] flex flex-col gap-[var(--vc-gap-24)] overflow-hidden rounded-[var(--vc-radius-24)] bg-[var(--vc-surface-foreground)] p-[var(--vc-gap-24)]">
        <section className="flex flex-col gap-[var(--vc-gap-16)]" aria-labelledby="settings-general-title">
          <h2 className="text-style-body font-medium tracking-[-0.02em]" id="settings-general-title">{t("settingsGeneral")}</h2>
          <div className="vc-corner-smooth flex items-center justify-between gap-[var(--vc-gap-16)] overflow-hidden rounded-[var(--vc-radius-16)] bg-[var(--vc-surface-active)] p-[var(--vc-gap-16)]">
            <span className="text-style-body font-medium tracking-[-0.02em]">{t("language")}</span>
            <div className="flex shrink-0 items-center gap-[var(--vc-gap-4)]" role="group" aria-label={t("language")}>
              <ButtonSmall active={preferences.locale === "ru"} onClick={() => void onPreferencesUpdate({ locale: "ru" })}>RU</ButtonSmall>
              <ButtonSmall active={preferences.locale === "en"} onClick={() => void onPreferencesUpdate({ locale: "en" })}>EN</ButtonSmall>
            </div>
          </div>
        </section>

        <section className="flex flex-col gap-[var(--vc-gap-16)]" aria-labelledby="settings-about-title">
          <h2 className="text-style-body font-medium tracking-[-0.02em]" id="settings-about-title">{t("about")}</h2>
          <div className="flex flex-col gap-[var(--vc-gap-8)]">
            <div className="vc-corner-smooth flex h-12 items-center justify-between rounded-[var(--vc-radius-16)] bg-[var(--vc-surface-active)] px-[var(--vc-gap-16)] text-style-body font-medium tracking-[-0.02em]">
              <span>{t("version")}</span>
              <span className="tabular-nums">{version}</span>
            </div>
            <div className="grid grid-cols-4 gap-[var(--vc-gap-8)]">
              <SettingsLink icon="github" label={t("github")} tone="purple" />
              <SettingsLink icon="donate" label={t("donate")} tone="orange" />
              <SettingsLink icon="telegram" label={t("telegramChannel")} onClick={() => openSettingsLink("telegram_channel")} tone="aqua" />
              <SettingsLink icon="chat" label={t("betaTestersChat")} onClick={() => openSettingsLink("beta_testers_chat")} tone="blue" />
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}

function SettingsLink({
  icon,
  label,
  onClick,
  tone,
}: {
  icon: "github" | "donate" | "telegram" | "chat";
  label: string;
  onClick?: () => void;
  tone: "purple" | "orange" | "aqua" | "blue";
}) {
  const toneClass = {
    purple: "text-[var(--vc-color-purple)]",
    orange: "text-[var(--vc-color-orange)]",
    aqua: "text-[var(--vc-color-aqua)]",
    blue: "text-[var(--vc-color-blue)]",
  }[tone];

  const content = <><Icon aria-hidden className="size-4" name={icon} /><span className="truncate">{label}</span></>;
  const className = cn(
    "vc-corner-smooth flex h-12 min-w-0 items-center justify-center gap-[var(--vc-gap-8)] overflow-hidden rounded-[var(--vc-radius-14)] bg-[var(--vc-surface-active)] px-[var(--vc-gap-16)] py-[var(--vc-gap-2)] text-style-body font-medium tracking-[-0.02em]",
    onClick && "cursor-pointer border border-transparent outline-none transition-[background-color,transform] duration-150 hover:bg-[var(--vc-surface-foreground)] focus-visible:ring-2 focus-visible:ring-[var(--vc-focus-ring)] active:scale-[0.98]",
    toneClass,
  );

  return onClick ? <button className={className} onClick={onClick} type="button">{content}</button> : <div className={className}>{content}</div>;
}

function InformationCallout({ title, detail }: { title: string; detail: string }) {
  return <section className="mt-4 flex gap-3 rounded-xl bg-muted/60 px-3 py-3"><SafeShield2Line className="mt-0.5 size-4 shrink-0 text-foreground" aria-hidden="true" /><div className="min-w-0"><h2 className="text-style-body-small font-medium">{title}</h2><p className="text-muted-foreground mt-1 text-style-body-small leading-5 text-pretty">{detail}</p></div></section>;
}

const AUTOMATION_TARGETS = [
  { id: "applications", labelKey: "automationApplicationCaches" },
  { id: "packages", labelKey: "automationPackageCaches" },
  { id: "editors", labelKey: "automationEditorCaches" },
  { id: "claude", labelKey: "automationClaudeCaches" },
] as const;

const AUTOMATION_DAYS = [
  { id: "mon", labelKey: "automationMonday" },
  { id: "tue", labelKey: "automationTuesday" },
  { id: "wed", labelKey: "automationWednesday" },
  { id: "thu", labelKey: "automationThursday" },
  { id: "fri", labelKey: "automationFriday" },
  { id: "sat", labelKey: "automationSaturday" },
  { id: "sun", labelKey: "automationSunday" },
] as const;

type AutomationTargetId = (typeof AUTOMATION_TARGETS)[number]["id"];
type AutomationDayId = (typeof AUTOMATION_DAYS)[number]["id"];
type AutomationFrequency = "daily" | "weekly";
type AutomationNameKey = "automationAppsEndOfDay" | "automationAgents";

type AutomationDraft = {
  targetIds: AutomationTargetId[];
  frequency: AutomationFrequency;
  dayIds: AutomationDayId[];
  hour: string;
  minute: string;
};

type AutomationJob = AutomationDraft & {
  id: string;
  name?: string;
  nameKey?: AutomationNameKey;
};

function newAutomationDraft(): AutomationDraft {
  return {
    targetIds: ["applications", "editors"],
    frequency: "daily",
    dayIds: ["mon", "wed", "fri"],
    hour: "18",
    minute: "00",
  };
}

function boundedTimePart(value: string, ceiling: number) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return "00";
  return String(Math.min(Math.max(parsed, 0), ceiling)).padStart(2, "0");
}

function automationTime({ hour, minute }: Pick<AutomationDraft, "hour" | "minute">) {
  return `${boundedTimePart(hour, 23)}:${boundedTimePart(minute, 59)}`;
}

function AutomationSectionIcon() {
  return (
    <div className="vc-corner-smooth grid size-12 shrink-0 place-items-center overflow-hidden rounded-[var(--vc-radius-16)] bg-[var(--vc-color-dark-aqua)]">
      <Icon aria-hidden className="size-8 text-[var(--vc-color-aqua)]" name="automation" />
    </div>
  );
}

function AutomationsView({
  disk,
  onOpenSettings,
  onViewChange,
}: {
  disk: DiskInfo | null;
  onOpenSettings: () => void;
  onViewChange: (view: WorkspaceRoute) => void;
}) {
  const { t, locale } = useLocale();
  const used = disk ? Math.max(0, disk.total - disk.free) : 0;
  const [screen, setScreen] = useState<"list" | "editor">("list");
  // The first visit is deliberately empty. Saved jobs enter the list only
  // through this session's form until scheduler persistence is wired up.
  const [automations, setAutomations] = useState<AutomationJob[]>([]);
  const [draft, setDraft] = useState<AutomationDraft>(newAutomationDraft);
  const [editingId, setEditingId] = useState<string | null>(null);

  const formattedSchedule = (automation: AutomationDraft) => {
    const time = automationTime(automation);
    if (automation.frequency === "daily") return t("automationDailyAt", { time });
    const days = AUTOMATION_DAYS
      .filter((day) => automation.dayIds.includes(day.id))
      .map((day) => t(day.labelKey))
      .join(", ");
    return t("automationWeeklyAt", { days, time });
  };

  const footerSummary = () => {
    const time = automationTime(draft);
    if (draft.frequency === "daily") return t("automationDailySummary", { time });
    const days = AUTOMATION_DAYS
      .filter((day) => draft.dayIds.includes(day.id))
      .map((day) => t(day.labelKey))
      .join(", ");
    return t("automationWeeklySummary", { days, time });
  };

  const automationName = (automation: AutomationJob) => automation.name ?? (automation.nameKey ? t(automation.nameKey) : t("automationTitle"));
  const canSave = draft.targetIds.length > 0 && (draft.frequency === "daily" || draft.dayIds.length > 0);

  const startCreate = () => {
    setEditingId(null);
    setDraft(newAutomationDraft());
    setScreen("editor");
  };

  const startEdit = (automation: AutomationJob) => {
    setEditingId(automation.id);
    setDraft({
      targetIds: [...automation.targetIds],
      frequency: automation.frequency,
      dayIds: [...automation.dayIds],
      hour: automation.hour,
      minute: automation.minute,
    });
    setScreen("editor");
  };

  const saveAutomation = () => {
    if (!canSave) return;
    const normalizedDraft: AutomationDraft = {
      ...draft,
      hour: boundedTimePart(draft.hour, 23),
      minute: boundedTimePart(draft.minute, 59),
    };
    const name = normalizedDraft.targetIds.includes("editors") || normalizedDraft.targetIds.includes("claude")
      ? t("automationAgents")
      : t("automationAppsEndOfDay");
    const automation: AutomationJob = {
      ...normalizedDraft,
      id: editingId ?? `automation-${Date.now()}`,
      name,
    };
    setAutomations((current) => editingId
      ? current.map((item) => item.id === editingId ? automation : item)
      : [...current, automation]);
    setScreen("list");
    toast(t("automationSaved"));
  };

  const toggleTarget = (id: AutomationTargetId, checked: boolean) => {
    setDraft((current) => ({
      ...current,
      targetIds: checked ? [...current.targetIds, id] : current.targetIds.filter((target) => target !== id),
    }));
  };

  const toggleDay = (id: AutomationDayId) => {
    setDraft((current) => ({
      ...current,
      dayIds: current.dayIds.includes(id) ? current.dayIds.filter((day) => day !== id) : [...current.dayIds, id],
    }));
  };

  const updateTimePart = (part: "hour" | "minute", value: string) => {
    if (!/^\d{0,2}$/.test(value)) return;
    setDraft((current) => ({ ...current, [part]: value }));
  };

  return (
    <main className="vc-corner-smooth relative h-full min-h-0 w-full overflow-hidden rounded-[var(--vc-radius-32)] bg-[var(--vc-surface-background)] text-[var(--vc-text-primary)]">
      <div className="flex h-full min-h-0 flex-col items-start gap-[var(--vc-gap-32)] p-[var(--vc-gap-32)]">
        <Controls
          actionLabel={t("settings")}
          onActionClick={onOpenSettings}
          onValueChange={(value) => onViewChange(value as WorkspaceRoute)}
          tabs={[
            { id: "clean", label: t("clean"), icon: "clean" },
            { id: "map", label: t("diskMap"), icon: "layers" },
            { id: "automations", label: t("automations"), icon: "automation" },
          ]}
          value="automations"
        />
        <DiskStats
          capacityLabel={disk ? diskLabel(disk.total, locale) : "—"}
          className="max-w-none shrink-0"
          state="compact"
          usedLabel={disk ? diskLabel(used, locale) : "—"}
        />

        {screen === "list" && automations.length === 0 ? (
          <section className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-[var(--vc-gap-24)] overflow-hidden text-center" aria-labelledby="automation-empty-title">
            <div className="vc-corner-smooth grid size-16 place-items-center overflow-hidden rounded-[var(--vc-radius-24)] bg-[var(--vc-color-dark-aqua)]">
              <img alt="" className="block" src={automationEmptyIcon} />
            </div>
            <div className="flex flex-col items-center gap-[var(--vc-gap-16)] whitespace-nowrap">
              <h1 className="text-style-heading font-medium tracking-[-0.02em]" id="automation-empty-title">{t("automationTitle")}</h1>
              <p className="text-style-caption tracking-[-0.02em] text-[var(--vc-text-secondary)]">{t("automationEmptyBody")}</p>
            </div>
            <Button icon="add" onClick={startCreate}>{t("createAutomation")}</Button>
          </section>
        ) : screen === "list" ? (
          <section className="vc-corner-smooth flex min-h-0 w-full flex-1 flex-col gap-[var(--vc-gap-24)] overflow-hidden rounded-[var(--vc-radius-24)] bg-[var(--vc-surface-foreground)] p-[var(--vc-gap-24)]" aria-labelledby="automation-list-title">
            <header className="flex h-12 shrink-0 items-center gap-[var(--vc-gap-16)]">
              <AutomationSectionIcon />
              <div className="min-w-0 flex-1">
                <h1 className="text-style-heading font-normal tracking-[-0.02em]" id="automation-list-title">{t("automationMyTitle")}</h1>
                <p className="mt-[var(--vc-gap-8)] text-style-caption tracking-[-0.02em] text-[var(--vc-text-secondary)]">
                  {automations[0] ? formattedSchedule(automations[0]) : t("automationEmptyBody")}
                </p>
              </div>
              <ButtonIcon icon="add" label={t("createAutomation")} onClick={startCreate} />
            </header>

            <div className="min-h-0 space-y-[var(--vc-gap-8)] overflow-y-auto pr-[var(--vc-gap-2)]" role="list">
              {automations.map((automation) => (
                <article className="vc-corner-smooth flex min-h-16 items-center gap-[var(--vc-gap-16)] rounded-[var(--vc-radius-16)] bg-[var(--vc-surface-active)] p-[var(--vc-gap-16)]" key={automation.id} role="listitem">
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-style-body font-medium tracking-[-0.02em]">{automationName(automation)}</h2>
                    <p className="mt-[var(--vc-gap-4)] truncate text-style-caption tracking-[-0.02em] text-[var(--vc-text-secondary)]">{formattedSchedule(automation)}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-[var(--vc-gap-4)]">
                    <ButtonIcon icon="edit" label={t("automationEdit")} onClick={() => startEdit(automation)} size="small" />
                    <ButtonIcon className="bg-[var(--vc-danger-foreground)] text-[var(--vc-danger)] hover:bg-[var(--vc-danger)] hover:text-[var(--vc-text-inverse)]" icon="delete" label={t("automationDelete")} onClick={() => setAutomations((current) => current.filter((item) => item.id !== automation.id))} size="small" />
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : (
          <section className="relative flex min-h-0 w-full flex-1 flex-col" aria-labelledby="automation-editor-title">
            <div className="min-h-0 flex-1 overflow-y-auto pb-[calc(var(--vc-gap-64)+var(--vc-gap-24))] pr-[var(--vc-gap-2)]">
              <div className="vc-corner-smooth flex flex-col gap-[var(--vc-gap-24)] rounded-[var(--vc-radius-24)] bg-[var(--vc-surface-foreground)] p-[var(--vc-gap-24)]">
                <header className="flex h-12 items-center gap-[var(--vc-gap-16)]">
                  <AutomationSectionIcon />
                  <div className="min-w-0">
                    <h1 className="text-style-heading font-normal tracking-[-0.02em]" id="automation-editor-title">{t("automationSetTitle")}</h1>
                    <p className="mt-[var(--vc-gap-8)] text-style-caption tracking-[-0.02em] text-[var(--vc-text-secondary)]">{t("automationSetBody")}</p>
                  </div>
                </header>

                <div className="flex flex-col gap-[var(--vc-gap-8)]">
                  <section className="vc-corner-smooth flex flex-col gap-[var(--vc-gap-16)] rounded-[var(--vc-radius-16)] bg-[var(--vc-surface-active)] p-[var(--vc-gap-16)]" aria-labelledby="automation-clean-title">
                    <h2 className="text-style-body font-medium tracking-[-0.02em]" id="automation-clean-title">{t("automationWhatClean")}</h2>
                    {AUTOMATION_TARGETS.map((target) => {
                      const checked = draft.targetIds.includes(target.id);
                      return (
                        <div className="flex min-h-4 items-center gap-[var(--vc-gap-16)]" key={target.id}>
                          <Checkbox aria-label={t(target.labelKey)} checked={checked} onCheckedChange={(next) => toggleTarget(target.id, next === true)} />
                          <button className="flex min-w-0 items-center gap-[var(--vc-gap-8)] text-left text-style-body font-medium tracking-[-0.02em] outline-none focus-visible:ring-2 focus-visible:ring-[var(--vc-focus-ring)]" onClick={() => toggleTarget(target.id, !checked)} type="button">
                            <span>{t(target.labelKey)}</span>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="inline-flex size-4 shrink-0 cursor-help text-[var(--vc-text-secondary)]" tabIndex={0}><Icon aria-hidden className="size-4" name="info" /></span>
                              </TooltipTrigger>
                              <TooltipContent>{t("automationScopeHelp")}</TooltipContent>
                            </Tooltip>
                          </button>
                        </div>
                      );
                    })}
                  </section>

                  <section className="vc-corner-smooth flex flex-col gap-[var(--vc-gap-16)] rounded-[var(--vc-radius-16)] bg-[var(--vc-surface-active)] p-[var(--vc-gap-16)]" aria-labelledby="automation-when-title">
                    <h2 className="text-style-body font-medium tracking-[-0.02em]" id="automation-when-title">{t("automationWhenClean")}</h2>
                    <div aria-labelledby="automation-when-title" className="flex flex-col gap-[var(--vc-gap-16)]" role="radiogroup">
                      <div className="flex items-center gap-[var(--vc-gap-16)]">
                        <Radio aria-label={t("automationEveryDay")} checked={draft.frequency === "daily"} onCheckedChange={() => setDraft((current) => ({ ...current, frequency: "daily" }))} />
                        <button className="text-left text-style-body font-medium tracking-[-0.02em] outline-none focus-visible:ring-2 focus-visible:ring-[var(--vc-focus-ring)]" onClick={() => setDraft((current) => ({ ...current, frequency: "daily" }))} type="button">{t("automationEveryDay")}</button>
                      </div>
                      {draft.frequency === "daily" ? <AutomationTimeFields draft={draft} onChange={updateTimePart} t={t} /> : null}

                      <div className="flex items-center gap-[var(--vc-gap-16)]">
                        <Radio aria-label={t("automationEveryWeek")} checked={draft.frequency === "weekly"} onCheckedChange={() => setDraft((current) => ({ ...current, frequency: "weekly" }))} />
                        <button className="text-left text-style-body font-medium tracking-[-0.02em] outline-none focus-visible:ring-2 focus-visible:ring-[var(--vc-focus-ring)]" onClick={() => setDraft((current) => ({ ...current, frequency: "weekly" }))} type="button">{t("automationEveryWeek")}</button>
                      </div>
                      {draft.frequency === "weekly" ? (
                        <div className="flex flex-col gap-[var(--vc-gap-16)]">
                          <div className="flex flex-wrap gap-[var(--vc-gap-4)]" aria-label={t("automationEveryWeek")}>
                            {AUTOMATION_DAYS.map((day) => <ButtonSmall active={draft.dayIds.includes(day.id)} key={day.id} onClick={() => toggleDay(day.id)}>{t(day.labelKey)}</ButtonSmall>)}
                          </div>
                          <AutomationTimeFields draft={draft} onChange={updateTimePart} t={t} />
                        </div>
                      ) : null}
                    </div>
                  </section>
                </div>
              </div>
            </div>

            <footer className="pointer-events-none absolute inset-x-0 bottom-[var(--vc-gap-24)] z-10 flex justify-center">
              <Island className="pointer-events-auto max-w-full">
                <p className="min-w-0 px-[var(--vc-gap-16)] text-right text-style-body tracking-[-0.02em] text-[var(--vc-text-secondary)]">
                  {canSave ? <><span> {footerSummary().split(" ")[0]}</span> <span className="text-[var(--vc-color-aqua)]">{footerSummary().slice(footerSummary().indexOf(" ") + 1)}</span></> : t("automationNoSelection")}
                </p>
                <Button icon="check" disabled={!canSave} onClick={saveAutomation} variant="success">{t("automationSave")}</Button>
                <Button icon="x" onClick={() => setScreen("list")} variant="gray">{t("automationCancel")}</Button>
              </Island>
            </footer>
          </section>
        )}
      </div>
    </main>
  );
}

function AutomationTimeFields({
  draft,
  onChange,
  t,
}: {
  draft: AutomationDraft;
  onChange: (part: "hour" | "minute", value: string) => void;
  t: ReturnType<typeof useLocale>["t"];
}) {
  return (
    <div className="flex items-center gap-[var(--vc-gap-4)]">
      <Input aria-label={`${t("automationWhenClean")} hour`} inputMode="numeric" maxLength={2} onChange={(event) => onChange("hour", event.target.value)} value={draft.hour} className="w-20" />
      <span className="text-style-body font-medium tracking-[-0.02em]" aria-hidden>:</span>
      <Input aria-label={`${t("automationWhenClean")} minute`} inputMode="numeric" maxLength={2} onChange={(event) => onChange("minute", event.target.value)} value={draft.minute} className="w-20" />
    </div>
  );
}


type LocalProviderId = "codex" | "claude";
type ProviderConnectionState = "notConfigured" | "detecting" | "ready" | "authRequired" | "notInstalled" | "unsupportedVersion" | "unavailable";
type AgentProviderPreview = { id: LocalProviderId; nameKey: "codex" | "claudeCode"; state: ProviderConnectionState };

const PREVIEW_PROVIDERS: AgentProviderPreview[] = [
  { id: "codex", nameKey: "codex", state: "notConfigured" },
  { id: "claude", nameKey: "claudeCode", state: "notConfigured" },
];

function currentProviderConnectionState(): ProviderConnectionState {
  // A backend-owned adapter will replace this preview state in the next phase.
  return "notConfigured";
}

function AssistantView() {
  const connectionState = currentProviderConnectionState();
  if (connectionState === "ready") return <AssistantReadyForm provider="codex" />;
  return <AssistantConnectionView providers={PREVIEW_PROVIDERS} />;
}

function AssistantConnectionView({ providers }: { providers: AgentProviderPreview[] }) {
  const { t } = useLocale();
  return <main className="min-h-0 flex-1 overflow-y-auto px-5 pb-5"><section className="mx-auto max-w-3xl py-8"><h1 className="text-style-heading font-medium tracking-tight">{t("connectAgent")}</h1><p className="text-muted-foreground mt-1 max-w-2xl text-style-body-small leading-6 text-pretty">{t("assistantNoBuiltInModel")}</p><div className="mt-7 divide-y border-y">{providers.map((provider) => <div key={provider.id} className="flex min-h-16 flex-wrap items-center justify-between gap-3 py-3"><div className="min-w-0"><h2 className="text-style-body-small font-medium">{t(provider.nameKey)}</h2><p className="text-muted-foreground mt-0.5 text-style-caption">{t("notConnected")}</p></div><span className="text-muted-foreground text-style-caption font-medium">{t("comingSoon")}</span></div>)}</div><p className="text-muted-foreground mt-4 text-style-body-small text-pretty">{t("connectionNextPhase")}</p><div className="mt-8 grid gap-x-8 gap-y-5 sm:grid-cols-2"><BoundaryItem label={t("localOnMac")} /><BoundaryItem label={t("selectedFolderOnly")} /><BoundaryItem label={t("readOnlyAccess")} /><BoundaryItem label={t("metadataDefault")} /></div></section></main>;
}

function BoundaryItem({ label }: { label: string }) {
  return <div className="flex items-center gap-2 text-style-body-small font-medium text-pretty"><Icon className="size-4 text-[var(--vc-success)]" name="check" />{label}</div>;
}

function AssistantReadyForm({ provider }: { provider: LocalProviderId }) {
  const { t } = useLocale();
  const name = t(provider === "codex" ? "codex" : "claudeCode");
  return <main className="min-h-0 flex-1 overflow-y-auto px-5 pb-5"><section className="mx-auto max-w-3xl py-8"><h1 className="text-style-heading font-medium">{t("agentReadyHeader", { provider: name })}</h1><InformationCallout title={t("assistantConnectionNotImplemented")} detail={t("directAdapterUnavailable")} /><Button className="mt-5" disabled>{t("analyzeWith", { provider: name })}</Button></section></main>;
}

function EmptyState({ action, onScan }: { action: "Scan my Mac" | "Retry" | "Scan again"; onScan: () => void }) {
  const { t } = useLocale();
  const copy = action === "Retry"
    ? { title: t("scanFailedTitle"), body: t("noCleanupStarted") }
    : action === "Scan again"
      ? { title: t("noCandidatesTitle"), body: t("noCandidatesBody") }
      : { title: t("readyReview"), body: t("readyReviewBody") };
  const actionLabel = action === "Scan my Mac" ? t("startScan") : action === "Retry" ? t("retry") : t("scanAgain");
  const isReady = action === "Scan my Mac";
  return (
    <div className="flex h-full min-h-[380px] flex-col items-center justify-center gap-[var(--vc-gap-24)] pb-[var(--vc-gap-16)] text-center">
      <div className="vc-corner-smooth grid size-16 place-items-center rounded-[var(--vc-radius-24)] bg-[var(--vc-success-foreground)]">
        <Icon className="size-[42px] text-[var(--vc-success)]" name="check24" />
      </div>
      <div className="flex flex-col items-center gap-[var(--vc-gap-16)]">
        <h2 className="text-style-heading font-medium tracking-[-0.02em]">{copy.title}</h2>
        <p className="max-w-[540px] text-style-caption tracking-[-0.02em] text-[var(--vc-text-secondary)]">
          {isReady
            ? t("readyReviewBody").split("\n").map((line, index, lines) => (
              <Fragment key={`${line}-${index}`}>
                {line}{index < lines.length - 1 ? <br /> : null}
              </Fragment>
            ))
            : copy.body}
        </p>
      </div>
      <Button aria-label={actionLabel} icon={isReady ? "scan" : "refresh"} onClick={onScan}>
        {actionLabel}
      </Button>
    </div>
  );
}

function LoadingState({ message, compact = false }: { message: string; compact?: boolean }) {
  return (
    <div
      className={cn(
        "text-muted-foreground flex flex-col items-center justify-center gap-3 text-center text-style-body-small",
        compact ? "h-40" : "h-full min-h-40",
      )}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <OrbitingCircles size={compact ? 32 : 48} />
      <span>{message}</span>
    </div>
  );
}


function PreflightDialog({
  preflight,
  cleaning,
  onCancel,
  onConfirm,
}: {
  preflight: Preflight;
  cleaning: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useLocale();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--vc-overlay)] p-[var(--vc-gap-24)]" role="dialog" aria-modal="true" aria-labelledby="preflight-title">
      <div className="vc-corner-smooth max-h-[calc(100vh-2.5rem)] w-full max-w-xl overflow-y-auto rounded-[var(--vc-radius-24)] border border-[var(--vc-border-subtle)] bg-[var(--vc-surface-foreground)] p-[var(--vc-gap-24)]">
        <div className="flex items-start gap-3">
          <SafeShield2Line className={cn("mt-0.5 size-5", preflight.requires_yellow_confirmation ? "text-yellow" : "text-green")} />
          <div>
            <h2 id="preflight-title" className="font-medium">{t("reviewScope")}</h2>
            <p className="text-muted-foreground mt-1 text-style-body-small">
              {t("preflightSummary", { count: preflight.entries.length, bytes: human(preflight.total) })}
            </p>
          </div>
        </div>
        {preflight.requires_yellow_confirmation && (
          <div className="border-yellow/30 bg-yellow/5 mt-4 rounded-lg border p-3 text-style-body-small">
            <span className="font-medium">{t("redownloadRequired")}</span> {t("redownloadDetail", { count: preflight.yellow_count })}
          </div>
        )}
        {preflight.running_apps.length > 0 && (
          <div className="border-yellow/30 bg-yellow/5 mt-3 rounded-lg border p-3 text-style-body-small">
            {t("runningAppsDetail", { apps: preflight.running_apps.join(", ") })}
          </div>
        )}
        <ul className="mt-4 max-h-48 space-y-2 overflow-y-auto text-style-caption">
          {preflight.entries.map((entry) => (
            <li key={entry.id} className="rounded-md bg-muted/60 px-3 py-2">
              <div className="flex justify-between gap-3"><code className="min-w-0 truncate font-mono" title={entry.path}>{entry.path}</code><span className="shrink-0">{human(entry.size)}</span></div>
              {entry.restore && <p className="text-muted-foreground mt-1">{t("restore", { value: entry.restore })}</p>}
            </li>
          ))}
        </ul>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="gray" onClick={onCancel} disabled={cleaning}>{t("cancel")}</Button>
          <Button disabled={cleaning} icon={cleaning ? undefined : "delete"} onClick={onConfirm} variant="destructive">
            {cleaning ? <OrbitingCircles size={16} /> : null}
            {cleaning ? t("cleaning") : preflight.requires_yellow_confirmation ? t("confirmClean") : t("cleanEntries")}
          </Button>
        </div>
      </div>
    </div>
  );
}
