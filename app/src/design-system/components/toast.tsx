import type { HTMLAttributes, ReactNode } from "react";

import { Icon } from "@/design-system/icons";
import { cn } from "@/lib/utils";

export type ToastProps = HTMLAttributes<HTMLDivElement> & {
  variant?: "success" | "danger";
  children: ReactNode;
};

export function Toast({ className, children, variant = "success", ...props }: ToastProps) {
  const success = variant === "success";
  return (
    <div
      className={cn(
        "vc-corner-smooth flex h-16 w-fit max-w-full items-center gap-[var(--vc-gap-8)] overflow-hidden rounded-[var(--vc-radius-16)] px-[var(--vc-gap-24)] py-[var(--vc-gap-8)]",
        success
          ? "bg-[var(--vc-success-foreground)] text-[var(--vc-success)]"
          : "bg-[var(--vc-danger-foreground)] text-[var(--vc-danger)]",
        className,
      )}
      role={success ? "status" : "alert"}
      {...props}
    >
      <Icon aria-hidden className="size-6" name={success ? "check24" : "x24"} />
      <span className="text-style-heading min-w-0 truncate font-medium tracking-[-0.02em]">{children}</span>
    </div>
  );
}
