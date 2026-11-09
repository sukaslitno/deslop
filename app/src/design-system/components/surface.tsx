import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export function Surface({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "vc-corner-smooth flex flex-col rounded-[var(--vc-radius-14)] border border-[var(--vc-border-subtle)] bg-[var(--vc-surface-foreground)] text-[var(--vc-text-primary)]",
        className,
      )}
      {...props}
    />
  );
}
