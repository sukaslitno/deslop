import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

export type ButtonSmallProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  visualState?: "default" | "hover" | "active" | "disabled";
  children: ReactNode;
};

export function ButtonSmall({
  active = false,
  children,
  className,
  visualState = "default",
  disabled,
  type,
  ...props
}: ButtonSmallProps) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "vc-corner-smooth inline-flex h-11 min-w-14 shrink-0 cursor-pointer items-center justify-center rounded-[var(--vc-radius-16)] border border-transparent px-[var(--vc-gap-16)] py-[var(--vc-gap-2)] text-style-body font-medium tracking-[-0.02em] outline-none transition-[background-color,color,transform] duration-150 focus-visible:ring-2 focus-visible:ring-[var(--vc-focus-ring)] active:scale-[0.98] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45",
        active
          ? "bg-[var(--vc-color-aqua)] text-[var(--vc-text-inverse)]"
          : "bg-[var(--vc-surface-foreground)] text-[var(--vc-text-primary)] hover:bg-[var(--vc-surface-active)] data-[visual-state=hover]:bg-[var(--vc-surface-active)]",
        className,
      )}
      data-visual-state={visualState === "default" ? undefined : visualState}
      disabled={disabled || visualState === "disabled"}
      type={type ?? "button"}
      {...props}
    >
      {children}
    </button>
  );
}
