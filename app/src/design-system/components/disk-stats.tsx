import type { HTMLAttributes, ReactNode } from "react";

import driveIcon from "@/design-system/assets/disk-stats-drive.svg?url";
import { Icon } from "@/design-system/icons";
import { cn } from "@/lib/utils";

export type DiskStatsState = "empty" | "results" | "compact";
export type DiskStatsSegmentTone = "green" | "blue" | "orange" | "white";

export type DiskStatsSegment = {
  id: string;
  label: ReactNode;
  /** Portion of the progress track, from 0 to 100. */
  percentage: number;
  tone: DiskStatsSegmentTone;
};

const defaultSegments: readonly DiskStatsSegment[] = [
  { id: "agents", label: "Кэши агентов: 1,9 GB", percentage: 6.1, tone: "green" },
  { id: "packages", label: "Кэши пакетов: 1,9 GB", percentage: 3.9, tone: "blue" },
  { id: "apps", label: "Кэши приложений · 42,3 MB", percentage: 2.3, tone: "orange" },
  { id: "models", label: "Кэши моделей · 42,3 MB", percentage: 0.7, tone: "white" },
];

const segmentToneClasses: Record<DiskStatsSegmentTone, string> = {
  green: "bg-[var(--vc-success)]",
  blue: "bg-[var(--vc-color-blue)]",
  orange: "bg-[var(--vc-warning)]",
  white: "bg-[var(--vc-color-white)]",
};

export type DiskStatsProps = Omit<HTMLAttributes<HTMLElement>, "children"> & {
  state?: DiskStatsState;
  computerName?: ReactNode;
  usedLabel?: ReactNode;
  capacityLabel?: ReactNode;
  /** The neutral (non-categorised) portion of the progress track, from 0 to 100. */
  usedPercentage?: number;
  segments?: readonly DiskStatsSegment[];
  lastScanLabel?: ReactNode;
};

function percentage(value: number) {
  return Math.min(100, Math.max(0, value));
}

/**
 * Figma disk-capacity card. `compact` is header-only; `empty` adds the neutral
 * capacity track; `results` adds cache segments and the matching legend.
 */
export function DiskStats({
  capacityLabel = "245,1GB",
  className,
  computerName = "[computer_name]",
  lastScanLabel = "Последний скан: 16 минут назад",
  segments = defaultSegments,
  state = "empty",
  usedLabel = "60,1GB",
  usedPercentage = 63.5,
  ...props
}: DiskStatsProps) {
  const showTrack = state !== "compact";
  const showResults = state === "results";

  return (
    <section
      aria-label="Disk statistics"
      className={cn(
        "vc-corner-smooth flex w-full max-w-[974px] flex-col items-start gap-[var(--vc-gap-16)] overflow-hidden rounded-[var(--vc-radius-24)] bg-[var(--vc-surface-foreground)]",
        state === "empty" && "h-32 p-[var(--vc-gap-24)]",
        state === "results" && "h-40 p-[var(--vc-gap-24)]",
        state === "compact" && "p-[var(--vc-gap-16)]",
        className,
      )}
      {...props}
    >
      <div className={cn("flex w-full gap-[var(--vc-gap-16)]", state === "compact" ? "items-center" : "items-start")}>
        <div className="flex min-w-0 flex-1 items-center gap-[var(--vc-gap-16)]">
          <div className="vc-corner-smooth grid size-12 shrink-0 place-items-center overflow-hidden rounded-[var(--vc-radius-16)] bg-[var(--vc-surface-active)]">
            <img alt="" className="size-8" src={driveIcon} />
          </div>
          <div className={cn("flex min-w-0 flex-1 gap-[var(--vc-gap-8)]", state === "compact" ? "items-center" : "flex-col items-start whitespace-nowrap")}>
            {state !== "compact" ? <p className="text-style-caption tracking-[-0.02em] text-[var(--vc-text-secondary)]">{computerName}</p> : null}
            <div className="flex items-center gap-[var(--vc-gap-8)] whitespace-nowrap">
              <span className="text-style-numeric-large tracking-[-0.02em] text-[var(--vc-text-primary)]">{usedLabel}</span>
              <span className="text-style-body font-medium tracking-[-0.02em] text-[var(--vc-text-primary)]">/</span>
              <span className="text-style-numeric-large tracking-[-0.02em] text-[var(--vc-text-secondary)]">{capacityLabel}</span>
            </div>
          </div>
        </div>
        {state !== "empty" ? (
          <div className="flex shrink-0 items-center gap-[var(--vc-gap-4)] text-style-caption whitespace-nowrap tracking-[-0.02em] text-[var(--vc-text-secondary)]">
            <Icon aria-hidden className="size-4" name="time" />
            <span>{lastScanLabel}</span>
          </div>
        ) : null}
      </div>

      {showTrack ? (
        <div
          aria-label="Disk capacity segments"
          className="vc-corner-smooth flex h-4 w-full items-start gap-[var(--vc-gap-2)] overflow-hidden rounded-[var(--vc-radius-16)] bg-[var(--vc-surface-background)] p-[var(--vc-gap-2)]"
          role="img"
        >
          <span
            className="vc-corner-smooth h-3 shrink-0 rounded-[var(--vc-radius-full)] bg-[var(--vc-surface-active)]"
            style={{ width: `${percentage(usedPercentage)}%` }}
          />
          {showResults ? segments.map((segment) => (
            <span
              aria-label={`${segment.label}`}
              className={cn("vc-corner-smooth h-3 shrink-0 rounded-[var(--vc-radius-full)]", segmentToneClasses[segment.tone])}
              key={segment.id}
              style={{ width: `${percentage(segment.percentage)}%` }}
            />
          )) : null}
        </div>
      ) : null}

      {showResults ? (
        <ul aria-label="Cache categories" className="flex w-full flex-wrap items-start gap-x-[var(--vc-gap-16)] gap-y-[var(--vc-gap-4)]">
          {segments.map((segment) => (
            <li className="flex items-center gap-[var(--vc-gap-4)] text-style-caption whitespace-nowrap tracking-[-0.02em] text-[var(--vc-text-secondary)]" key={segment.id}>
              <span aria-hidden className={cn("vc-corner-smooth size-4 rounded-[var(--vc-radius-full)]", segmentToneClasses[segment.tone])} />
              {segment.label}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
