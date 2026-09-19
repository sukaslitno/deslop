import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export type ProgressProps = HTMLAttributes<HTMLDivElement> & {
  value?: number;
  indicatorClassName?: string;
};

export function Progress({ className, indicatorClassName, value = 0, ...props }: ProgressProps) {
  const clampedValue = Math.min(100, Math.max(0, value));

  return (
    <div
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={clampedValue}
      className={cn("h-2 w-full overflow-hidden rounded-[var(--vc-radius-full)] bg-[var(--vc-surface-foreground)]", className)}
      role="progressbar"
      {...props}
    >
      <div
        className={cn("h-full bg-[var(--vc-action-primary)] transition-[width] duration-200", indicatorClassName)}
        style={{ width: `${clampedValue}%` }}
      />
    </div>
  );
}
