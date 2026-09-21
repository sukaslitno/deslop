import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

export type CheckedState = boolean | "indeterminate";

export type CheckboxProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & {
  checked?: CheckedState;
  onCheckedChange?: (checked: CheckedState) => void;
};

export function Checkbox({
  checked = false,
  className,
  disabled,
  onCheckedChange,
  onClick,
  ...props
}: CheckboxProps) {
  const selected = checked === true || checked === "indeterminate";

  return (
    <button
      aria-checked={checked === "indeterminate" ? "mixed" : checked}
      className={cn(
        "flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[var(--vc-radius-4)] border border-[var(--vc-text-secondary)] bg-transparent text-[var(--vc-text-inverse)] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--vc-focus-ring)] disabled:cursor-not-allowed disabled:opacity-45",
        selected && "border-[var(--vc-action-primary)] bg-[var(--vc-action-primary)]",
        className,
      )}
      disabled={disabled}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onCheckedChange?.(checked === true ? false : true);
      }}
      role="checkbox"
      type="button"
      {...props}
    >
      {checked === "indeterminate" ? (
        <span className="h-px w-2 bg-[var(--vc-text-inverse)]" />
      ) : selected ? (
        <span aria-hidden className="mb-px h-[7px] w-1 rotate-45 border-b-2 border-r-2 border-[var(--vc-text-inverse)]" />
      ) : null}
    </button>
  );
}
