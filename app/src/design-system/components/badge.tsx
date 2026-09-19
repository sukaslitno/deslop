import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

const variantClasses = {
  default: "border-transparent bg-[var(--vc-action-primary)] text-[var(--vc-action-primary-foreground)]",
  secondary: "border-transparent bg-[var(--vc-surface-active)] text-foreground",
  outline: "border-[var(--vc-border-strong)] bg-transparent text-foreground",
} as const;

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  variant?: keyof typeof variantClasses;
};

export function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-[var(--vc-radius-full)] border px-2.5 py-1 text-style-caption font-medium",
        variantClasses[variant],
        className,
      )}
      {...props}
    />
  );
}
