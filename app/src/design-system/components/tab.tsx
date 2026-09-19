import type { ButtonHTMLAttributes, ReactNode } from "react";

import { type IconName, Icon } from "@/design-system/icons";
import { cn } from "@/lib/utils";

export type TabProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  icon?: IconName;
  visualState?: "default" | "hover" | "active" | "disabled";
  children: ReactNode;
};

export function Tab({
  active = false,
  children,
  className,
  icon,
  visualState = "default",
  disabled,
  type,
  ...props
}: TabProps) {
  return (
    <button
      aria-selected={active}
      className={cn(
        "vc-corner-smooth inline-flex h-11 shrink-0 cursor-pointer items-center justify-center gap-[var(--vc-gap-8)] rounded-[var(--vc-radius-14)] border border-transparent px-[var(--vc-gap-16)] py-[var(--vc-gap-2)] text-style-body font-medium tracking-[-0.02em] outline-none transition-[background-color,color,transform] duration-150 focus-visible:ring-2 focus-visible:ring-[var(--vc-focus-ring)] active:scale-[0.98] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45",
        active
          ? "bg-[var(--vc-surface-active)] text-[var(--vc-text-primary)]"
          : "bg-transparent text-[var(--vc-text-secondary)] hover:bg-[var(--vc-surface-foreground)] hover:text-[var(--vc-text-primary)] data-[visual-state=hover]:bg-[var(--vc-surface-foreground)] data-[visual-state=hover]:text-[var(--vc-text-primary)]",
        className,
      )}
      data-visual-state={visualState === "default" ? undefined : visualState}
      disabled={disabled || visualState === "disabled"}
      role="tab"
      type={type ?? "button"}
      {...props}
    >
      {icon ? <Icon aria-hidden className="size-4" name={icon} /> : null}
      {children}
    </button>
  );
}
