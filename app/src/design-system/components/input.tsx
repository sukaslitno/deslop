import type { InputHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

/**
 * Compact Figma input geometry used for short, directly editable values such
 * as the two parts of an automation time.
 */
export function Input({ className, type = "text", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "vc-corner-smooth h-11 min-w-0 rounded-[var(--vc-radius-14)] border border-transparent bg-[var(--vc-surface-foreground)] px-[var(--vc-gap-16)] text-center text-style-body font-medium tracking-[-0.02em] text-[var(--vc-text-primary)] outline-none transition-colors placeholder:text-[var(--vc-text-disabled)] focus-visible:border-[var(--vc-action-primary)] focus-visible:ring-2 focus-visible:ring-[var(--vc-focus-ring)] disabled:cursor-not-allowed disabled:opacity-45",
        className,
      )}
      type={type}
      {...props}
    />
  );
}
