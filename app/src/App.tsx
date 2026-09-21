import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
// Pending Figma export: no local equivalent for the preflight shield yet (see DESIGN_AUDIT_PLAN 5.1).
import { SafeShield2Line } from "@mingcute/react";
import diskIcon from "@/assets/storage-drive-3d-256.png";
import automationEmptyIcon from "@/assets/figma/automation-empty.svg?no-inline";
import scanStatusCheck from "@/assets/figma/scan-status-check.svg?no-inline";
import warningHex from "@/assets/figma/warning-hex.svg?no-inline";
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
  type CleanResult,
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
  Island,
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
import { appCacheName } from "@/lib/app-cache-name";
import { initialMessage, LocaleProvider, useLocale } from "@/i18n";

const TIER_ORDER: Record<Tier, number> = { GREEN: 0, YELLOW: 1, RED: 2 };
type AppRoute = "clean" | "map" | "automations" | "assistant" | "settings";
type WorkspaceRoute = Exclude<AppRoute, "settings">;

function diskLabel(bytes: number) {
  return human(bytes);
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

const RULE_TITLE_KEYS = {
  claude: "ruleClaude",
  codex: "ruleCodex",
  editors: "ruleEditors",
  appcache: "ruleAppCache",
  pkg: "rulePackageCache",
  xcode: "ruleXcode",
  hf: "ruleHuggingFace",
} as const;

function localizedCategoryTitle(category: Category, t: ReturnType<typeof useLocale>["t"]) {
  const key = RULE_TITLE_KEYS[category.id as keyof typeof RULE_TITLE_KEYS];
  return key ? t(key) : category.title;
}

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
  const { t } = useLocale();
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
          capacityLabel={disk?.total ? diskLabel(disk.total) : "—"}
          state="empty"
          usedLabel={disk?.total ? diskLabel(used) : "—"}
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
  cleanResult: CleanResult | null;
  cleanRefreshFailed: boolean;
  disk: DiskInfo | null;
  error: string;
  expanded: Set<string>;
  initializing: boolean;
  onCancelScan: () => void;
  onOpenSettings: () => void;
  onRequestClean: (ids: string[]) => void;
  onRetryCleanRefresh: () => void;
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
  cleanResult,
  cleanRefreshFailed,
  disk,
  error,
  expanded,
  initializing,
  onCancelScan,
  onOpenSettings,
  onRequestClean,
  onRetryCleanRefresh,
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
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!breakdown) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [breakdown]);
  const capacity = breakdown?.volumeCapacityBytes ?? disk?.total ?? 0;
  const available = breakdown?.volumeAvailableBytes ?? disk?.free ?? 0;
  const used = Math.max(0, capacity - available);
  const breakdownById = new Map(
    (breakdown?.categories ?? []).map((category) => [category.categoryId, category.measuredBytes]),
  );
  const legendDefinitions: Array<{
    categoryId: CleanupCategoryId;
    label: string;
    tone: "green" | "blue" | "orange" | "white" | "aqua" | "purple" | "darkAqua";
  }> = [
    { categoryId: "agentCaches", label: t("agentCaches"), tone: "aqua" },
    { categoryId: "editorCaches", label: t("editorCaches"), tone: "purple" },
    { categoryId: "applicationCaches", label: t("applicationCaches"), tone: "orange" },
    { categoryId: "packageCaches", label: t("packageCaches"), tone: "blue" },
    { categoryId: "developerCaches", label: t("developerCaches"), tone: "green" },
    { categoryId: "modelCaches", label: t("modelCaches"), tone: "darkAqua" },
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
    ? Math.max(0, Math.floor(now / 1000 - breakdown.completedAt))
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
            capacityLabel={capacity > 0 ? diskLabel(capacity) : "—"}
            lastScanLabel={breakdown ? t("lastScan", { age: scanAge }) : undefined}
            segments={segments}
            state={cats.length ? "results" : "empty"}
            usedLabel={capacity > 0 ? diskLabel(used) : "—"}
            usedPercentage={neutralUsedPercentage}
          />

          {initializing ? <LoadingState message={t("preparing")} /> : null}
          {scanCta.location === "center" ? <EmptyState action={scanCta.label} onScan={onScan} /> : null}
          {error ? (
            <div className="vc-corner-smooth rounded-[var(--vc-radius-16)] bg-[var(--vc-danger-foreground)] p-[var(--vc-gap-16)] text-style-body-small text-[var(--vc-text-primary)]" role="alert">
              {error}
            </div>
          ) : null}

          {breakdown?.measurementKind === "logicalFallback" ? (
            <p className="text-style-caption text-[var(--vc-text-secondary)]">{t("candidateDataLogicalEstimate")}</p>
          ) : null}

          {cleanResult ? (
            <CleanupResultSummary
              cleanRefreshFailed={cleanRefreshFailed}
              onRetryRefresh={onRetryCleanRefresh}
              result={cleanResult}
            />
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

function CleanupResultSummary({
  result,
  cleanRefreshFailed,
  onRetryRefresh,
}: {
  result: CleanResult;
  cleanRefreshFailed: boolean;
  onRetryRefresh: () => void;
}) {
  const { t } = useLocale();
  const skippedOrFailed = result.outcomes.filter((outcome) => outcome.status !== "deleted");
  const hasIssues = result.skipped.length > 0 || result.errors.length > 0 || Boolean(result.record_error);
  const title = hasIssues ? t("cleanupFinishedWithIssues") : result.deleted.length ? t("cleanupFinished") : t("nothingRemoved");
  return (
    <section
      aria-live="polite"
      className="vc-corner-smooth flex flex-col gap-[var(--vc-gap-16)] rounded-[var(--vc-radius-16)] border border-[var(--vc-border-subtle)] bg-[var(--vc-surface-foreground)] p-[var(--vc-gap-16)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-[var(--vc-gap-16)]">
        <div>
          <h2 className="text-style-body font-medium tracking-[-0.02em]">{title}</h2>
          <p className="mt-[var(--vc-gap-4)] text-style-caption text-[var(--vc-text-secondary)]">
            {t("cleanupOutcomeSummary", {
              deleted: result.deleted.length,
              skipped: result.skipped.length,
              errors: result.errors.length,
              bytes: human(result.freed),
            })}
          </p>
        </div>
        {cleanRefreshFailed ? <Button icon="refresh" onClick={onRetryRefresh} variant="gray">{t("retryRefresh")}</Button> : null}
      </div>
      {skippedOrFailed.length > 0 ? (
        <ul className="space-y-[var(--vc-gap-4)] text-style-caption text-[var(--vc-text-secondary)]">
          {skippedOrFailed.map((outcome) => <li key={outcome.id}>{outcome.path}: {outcome.detail}</li>)}
        </ul>
      ) : null}
      {result.record_error ? <p className="text-style-caption text-[var(--vc-warning)]">{t("historyWriteError")} {result.record_error}</p> : null}
      {cleanRefreshFailed ? <p className="text-style-caption text-[var(--vc-text-secondary)]">{t("cleanupRefreshFailed")}</p> : null}
    </section>
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
  const categoryTitle = localizedCategoryTitle(category, t);
  const isOpen = expanded.has(category.id);
  const checkable = category.tier !== "RED";
  const entryIds = category.entries.map((entry) => entry.id);
  const allSelected = entryIds.length > 0 && entryIds.every((id) => selected.has(id));
  const someSelected = !allSelected && entryIds.some((id) => selected.has(id));
  const sortedEntries = [...category.entries].sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
  const applicationGroups = category.id === "appcache"
    ? Object.entries(sortedEntries.reduce<Record<string, typeof sortedEntries>>((groups, entry) => {
      const name = appCacheName(entry.path, t("otherApplication"));
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
            aria-label={t("select", { path: categoryTitle })}
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
              <span className="block truncate">{categoryTitle}</span>
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
  const isMac = navigator.userAgent.includes("Macintosh");
  const map = usePersistentMap(preferences, t);
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
  const [cleanResult, setCleanResult] = useState<CleanResult | null>(null);
  const [cleanRefreshFailed, setCleanRefreshFailed] = useState(false);
  const [error, setError] = useState<string>("");
  const [scanError, setScanError] = useState<string>("");
  const [scanJob, setScanJob] = useState<ScanJobStatus | null>(null);
  const [scannedOnce, setScannedOnce] = useState(false);
  const [view, setView] = useState<AppRoute>("clean");
  const [settingsReturnView, setSettingsReturnView] = useState<WorkspaceRoute>("clean");
  const [initializing, setInitializing] = useState(true);
  const [preflighting, setPreflighting] = useState(false);
  const cleanInFlight = useRef(false);
  const scanInFlight = useRef(false);
  const settingsReturnFocus = useRef<HTMLElement | null>(null);
  const preflightInitiator = useRef<HTMLElement | null>(null);

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

  async function runScan(): Promise<boolean> {
    // Claim synchronously so double activation during `defaultRoots` cannot
    // produce concurrent jobs.
    if (scanInFlight.current) return false;
    scanInFlight.current = true;
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
      if (job.phase === "cancelled") return false;
      if (job.phase !== "completed" || !job.snapshot) throw new Error(job.error ?? job.message);
      const snapshot = job.snapshot;
      setSnapshotId(snapshot.id);
      setCats(snapshot.categories);
      setBreakdown(snapshot.breakdown);
      // Default selection is per-entry, never a whole category.
      setSelected(initialSelection(snapshot));
      setScannedOnce(true);
      return true;
    } catch (e) {
      const message = String(e);
      setError(message);
      setScanError(message);
      toast(message, "danger");
      return false;
    } finally {
      scanInFlight.current = false;
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
          collator.compare(localizedCategoryTitle(a, t), localizedCategoryTitle(b, t)),
      ),
    [cats, collator, t],
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
    preflightInitiator.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
    if (!preflight || cleanInFlight.current) return;
    cleanInFlight.current = true;
    setCleaning(true);
    setError("");
    let shouldRefresh = false;
    try {
      const r = await api.clean(preflight.id, preflight.requires_yellow_confirmation);
      setPreflight(null);
      setCleanResult(r);
      setCleanRefreshFailed(false);
      const hasIssues = r.skipped.length > 0 || r.errors.length > 0 || Boolean(r.record_error);
      toast(
        r.deleted.length ? (r.freed_size_unknown ? t("cleanupCompletedSizeUnknown") : t("freed", { bytes: human(r.freed) })) : t("nothingRemoved"),
        hasIssues || !r.deleted.length ? "danger" : "success",
      );
      shouldRefresh = true;
    } catch (e) {
      // A preflight is single-use once confirmation starts. Never leave a
      // stale dialog that can accidentally repeat a destructive operation.
      setPreflight(null);
      setError(String(e));
      toast(String(e), "danger");
    } finally {
      cleanInFlight.current = false;
      setCleaning(false);
    }
    // Refresh is a distinct, cancellable operation. It must never keep the
    // destructive-operation lock or re-run cleanup on retry.
    if (shouldRefresh) {
      const refreshed = await runScan();
      setCleanRefreshFailed(!refreshed);
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
    try {
      setScanJob(await api.cancelScan(scanJob.id));
    } catch (reason) {
      setError(String(reason));
      toast(String(reason), "danger");
    }
  }

  function openSettings() {
    if (view !== "settings") {
      settingsReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setSettingsReturnView(view);
    }
    setView("settings");
  }

  function closeSettings() {
    setView(settingsReturnView);
    window.requestAnimationFrame(() => {
      const previous = settingsReturnFocus.current;
      if (previous?.isConnected) previous.focus();
      else document.querySelector<HTMLElement>("[data-settings-trigger]")?.focus();
    });
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (preflight) {
        if ((event.metaKey || event.ctrlKey) && event.key === ",") event.preventDefault();
        return;
      }
      if ((isMac ? event.metaKey : event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        openSettings();
      }
      if (event.key === "Escape" && view === "settings") {
        event.preventDefault();
        closeSettings();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMac, preflight, view, settingsReturnView]);

  return (
    <TooltipProvider>
      <div ref={(element) => { if (element) element.inert = Boolean(preflight); }} aria-hidden={preflight ? true : undefined} className={cn("flex h-screen flex-col bg-background text-foreground", preflight && "pointer-events-none")}>
        {/* Windows has its native title bar; only macOS needs this drag/traffic-light region. */}
        {isMac ? <div data-tauri-drag-region className="h-14 shrink-0" /> : null}
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
            cleanResult={cleanResult}
            cleanRefreshFailed={cleanRefreshFailed}
            disk={disk}
            error={error}
            expanded={expanded}
            initializing={initializing}
            onCancelScan={cancelScan}
            onOpenSettings={openSettings}
            onRequestClean={requestClean}
            onRetryCleanRefresh={() => void runScan().then((refreshed) => setCleanRefreshFailed(!refreshed))}
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
            map={map}
            onOpenSettings={openSettings}
            onViewChange={(nextView) => setView(nextView)}
          />
        ) : view === "automations" ? (
          <AutomationsView
            disk={disk}
            onOpenSettings={openSettings}
            onViewChange={(nextView) => setView(nextView)}
          />
        ) : view === "settings" ? (
          <SettingsView
            onBack={closeSettings}
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
          returnFocus={preflightInitiator.current}
          onCancel={() => setPreflight(null)}
          onConfirm={confirmClean}
        />
      )}
    </TooltipProvider>
  );
}

function MapView({
  disk,
  map,
  onOpenSettings,
  onViewChange,
}: {
  disk: DiskInfo | null;
  map: PersistentMapController;
  onOpenSettings: () => void;
  onViewChange: (view: WorkspaceRoute) => void;
}) {
  const { t, locale } = useLocale();
  const { snapshot, loading, error, treeJob, scanHome, cancelTreeScan } = map;

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
          capacityLabel={disk?.total ? diskLabel(disk.total) : "—"}
          className="max-w-none shrink-0"
          lastScanLabel={snapshot ? snapshotAge() : t("mapNotScanned")}
          state="compact"
          usedLabel={disk?.total ? diskLabel(used) : "—"}
        />

        <div className="relative min-h-0 w-full flex-1">
          {error && <div className="vc-corner-smooth mb-[var(--vc-gap-16)] rounded-[var(--vc-radius-16)] bg-[var(--vc-danger-foreground)] p-[var(--vc-gap-16)] text-style-body-small text-[var(--vc-text-primary)]" role="alert">{error}</div>}
          {snapshot?.is_partial ? <div className="vc-corner-smooth mb-[var(--vc-gap-16)] rounded-[var(--vc-radius-16)] bg-[var(--vc-warning-foreground)] p-[var(--vc-gap-16)] text-style-body-small text-[var(--vc-text-primary)]" role="status">{t("mapPartial", { count: snapshot.skipped_nodes })}</div> : null}
          {isInitialMapScan && (
            <section className="flex h-full w-full flex-col items-center justify-center gap-[var(--vc-gap-24)] overflow-hidden text-center" role="status" aria-busy="true" aria-live="polite">
              <div className="vc-corner-smooth grid size-16 place-items-center overflow-hidden rounded-[var(--vc-radius-24)] bg-[var(--vc-surface-foreground)]">
                <img alt="" src={scanStatusCheck} />
              </div>
              <div className="flex flex-col items-center gap-[var(--vc-gap-16)] whitespace-nowrap">
                <h1 className="text-style-heading font-medium tracking-[-0.02em]">{t("buildingDiskMap")}</h1>
                <p className="text-style-caption tracking-[-0.02em] text-[var(--vc-text-secondary)]">{t("buildingDiskMapDetail")}</p>
              </div>
              <Button disabled={!treeJob} icon="x" onClick={() => void cancelTreeScan()} variant="destructive">
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
              <Button icon="layers" onClick={() => void scanHome()}>
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
            <div className="grid grid-cols-3 gap-[var(--vc-gap-8)]">
              <SettingsLink icon="github" label={t("github")} onClick={() => openSettingsLink("github_repository")} tone="purple" />
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
  icon: "github" | "telegram" | "chat";
  label: string;
  onClick?: () => void;
  tone: "purple" | "aqua" | "blue";
}) {
  const toneClass = {
    purple: "text-[var(--vc-color-purple)]",
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

function AutomationsView({
  disk,
  onOpenSettings,
  onViewChange,
}: {
  disk: DiskInfo | null;
  onOpenSettings: () => void;
  onViewChange: (view: WorkspaceRoute) => void;
}) {
  const { t } = useLocale();
  const used = disk ? Math.max(0, disk.total - disk.free) : 0;

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
          capacityLabel={disk?.total ? diskLabel(disk.total) : "—"}
          className="max-w-none shrink-0"
          state="compact"
          usedLabel={disk?.total ? diskLabel(used) : "—"}
        />

        <section className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-[var(--vc-gap-24)] overflow-hidden text-center" aria-labelledby="automation-empty-title">
          <div className="vc-corner-smooth grid size-16 place-items-center overflow-hidden rounded-[var(--vc-radius-24)] bg-[var(--vc-color-dark-aqua)]">
            <img alt="" className="block" src={automationEmptyIcon} />
          </div>
          <div className="flex max-w-[416px] flex-col items-center gap-[var(--vc-gap-16)]">
            <h1 className="text-style-heading font-medium tracking-[-0.02em]" id="automation-empty-title">{t("automationTitle")}</h1>
            <p className="text-style-caption tracking-[-0.02em] text-[var(--vc-text-secondary)]">{t("automationUnavailable")}</p>
          </div>
        </section>
      </div>
    </main>
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

type PersistentMapState = {
  snapshot: MapSnapshot | null;
  loading: boolean;
  error: string;
  treeJob: TreeJobStatus | null;
};

type PersistentMapController = PersistentMapState & {
  scanHome: () => Promise<void>;
  cancelTreeScan: () => Promise<void>;
};

/**
 * Map work belongs to AppShell rather than its route component: changing tabs
 * must neither discard an active backend job nor erase a completed snapshot.
 */
function usePersistentMap(preferences: AppPreferences, t: ReturnType<typeof useLocale>["t"]): PersistentMapController {
  const [snapshot, setSnapshot] = useState<MapSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [treeJob, setTreeJob] = useState<TreeJobStatus | null>(null);
  const inFlight = useRef(false);
  const activeJobId = useRef<string | null>(null);
  const runToken = useRef(0);
  const cancellationRequested = useRef(new Set<string>());

  const scanHome = useCallback(async () => {
    // Claim the operation before the first await (including `homeDir`).
    if (inFlight.current) return;
    inFlight.current = true;
    const token = ++runToken.current;
    setError("");
    setLoading(true);
    try {
      const home = preferences.rememberLastMapFolder && preferences.lastMapFolder
        ? preferences.lastMapFolder
        : await api.homeDir();
      if (token !== runToken.current) return;
      const started = await api.startTreeScan(home, 6, 20 * 1024 * 1024);
      if (token !== runToken.current) return;
      activeJobId.current = started.id;
      setTreeJob(started);
      let job = started;
      while (job.phase === "running" || job.phase === "cancelling") {
        await new Promise((resolve) => window.setTimeout(resolve, 180));
        job = await api.treeJobStatus(started.id);
        if (token !== runToken.current) return;
        setTreeJob(job);
      }
      if (token !== runToken.current) return;
      if (job.phase === "cancelled" || cancellationRequested.current.has(started.id)) {
        setError(t(snapshot ? "mapRefreshCancelled" : "mapInitialScanCancelled"));
        return;
      }
      if (job.phase !== "completed" || !job.snapshot) throw new Error(job.error ?? job.message);
      setSnapshot(job.snapshot);
    } catch (reason) {
      if (token === runToken.current) setError(String(reason));
    } finally {
      if (token === runToken.current) {
        activeJobId.current = null;
        inFlight.current = false;
        setLoading(false);
        setTreeJob(null);
      }
    }
  }, [preferences.lastMapFolder, preferences.rememberLastMapFolder, snapshot, t]);

  const cancelTreeScan = useCallback(async () => {
    const id = activeJobId.current;
    if (!id) return;
    try {
      const status = await api.cancelTreeScan(id);
      if (status.phase === "cancelling" || status.phase === "cancelled") {
        cancellationRequested.current.add(id);
      }
      if (activeJobId.current === id) setTreeJob(status);
    } catch (reason) {
      setError(String(reason));
      toast(String(reason), "danger");
    }
  }, []);

  return { snapshot, loading, error, treeJob, scanHome, cancelTreeScan };
}


function PreflightDialog({
  preflight,
  cleaning,
  onCancel,
  onConfirm,
  returnFocus,
}: {
  preflight: Preflight;
  cleaning: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  returnFocus: HTMLElement | null;
}) {
  const { t } = useLocale();
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(returnFocus);
  const cleaningRef = useRef(cleaning);
  const onCancelRef = useRef(onCancel);

  useEffect(() => {
    cleaningRef.current = cleaning;
    onCancelRef.current = onCancel;
    if (cleaning) dialogRef.current?.focus();
  }, [cleaning, onCancel]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const focusable = () => dialog
      ? [...dialog.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")]
        .filter((element) => !element.hasAttribute("hidden"))
      : [];
    const initial = focusable()[0] ?? dialog;
    initial?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!cleaningRef.current) onCancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!dialog?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (dialog && !dialog.contains(event.target as Node)) (focusable()[0] ?? dialog).focus();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      window.requestAnimationFrame(() => {
        if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
      });
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--vc-overlay)] p-[var(--vc-gap-24)]" role="dialog" aria-modal="true" aria-labelledby="preflight-title">
      <div ref={dialogRef} tabIndex={-1} className="vc-corner-smooth max-h-[calc(100vh-2.5rem)] w-full max-w-xl overflow-y-auto rounded-[var(--vc-radius-24)] border border-[var(--vc-border-subtle)] bg-[var(--vc-surface-foreground)] p-[var(--vc-gap-24)]">
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
