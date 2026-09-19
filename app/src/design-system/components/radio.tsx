import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export type RadioProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
};

/** Figma 16px radio control with native button keyboard semantics. */
export function Radio({
  checked = false,
  className,
  disabled,
  onCheckedChange,
  onClick,
  ...props
}: RadioProps) {
  return (
    <button
      aria-checked={checked}
      className={cn(
        "vc-corner-smooth relative flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[var(--vc-radius-full)] border border-[var(--vc-text-secondary)] bg-transparent outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--vc-focus-ring)] disabled:cursor-not-allowed disabled:opacity-45",
        checked && "border-[var(--vc-action-primary)] bg-[var(--vc-action-primary)]",
        className,
      )}
      disabled={disabled}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onCheckedChange?.(true);
      }}
      role="radio"
      type="button"
      {...props}
    >
      {checked ? <span aria-hidden className="size-1.5 rounded-[var(--vc-radius-full)] bg-[var(--vc-text-inverse)]" /> : null}
    </button>
  );
}
