import type { ButtonHTMLAttributes, ReactNode } from "react";

import { type IconName, Icon } from "@/design-system/icons";
import { cn } from "@/lib/utils";

const variantClasses = {
  aqua: "bg-[var(--vc-color-aqua)] text-[var(--vc-text-inverse)] hover:bg-[var(--vc-color-dark-aqua)] hover:text-[var(--vc-text-primary)] active:bg-[var(--vc-color-dark-aqua)] active:brightness-90 data-[visual-state=hover]:bg-[var(--vc-color-dark-aqua)] data-[visual-state=hover]:text-[var(--vc-text-primary)] data-[visual-state=active]:bg-[var(--vc-color-dark-aqua)] data-[visual-state=active]:brightness-90",
  gray: "bg-[var(--vc-surface-active)] text-[var(--vc-text-primary)] hover:bg-[var(--vc-surface-foreground)] hover:text-[var(--vc-text-secondary)] active:bg-[var(--vc-surface-foreground)] data-[visual-state=hover]:bg-[var(--vc-surface-foreground)] data-[visual-state=hover]:text-[var(--vc-text-secondary)] data-[visual-state=active]:bg-[var(--vc-surface-foreground)]",
  destructive: "bg-[var(--vc-danger)] text-[var(--vc-text-primary)] hover:bg-[var(--vc-danger-foreground)] active:bg-[var(--vc-danger-foreground)] active:brightness-110 data-[visual-state=hover]:bg-[var(--vc-danger-foreground)] data-[visual-state=active]:bg-[var(--vc-danger-foreground)]",
  colored: "bg-[var(--vc-surface-active)] text-[var(--vc-color-blue)] hover:bg-[var(--vc-surface-foreground)] active:bg-[var(--vc-surface-foreground)] data-[visual-state=hover]:bg-[var(--vc-surface-foreground)] data-[visual-state=active]:bg-[var(--vc-surface-foreground)]",
  success: "bg-[var(--vc-success)] text-[var(--vc-text-inverse)] hover:bg-[var(--vc-success-foreground)] hover:text-[var(--vc-text-primary)] active:bg-[var(--vc-success-foreground)] data-[visual-state=hover]:bg-[var(--vc-success-foreground)] data-[visual-state=hover]:text-[var(--vc-text-primary)] data-[visual-state=active]:bg-[var(--vc-success-foreground)]",
} as const;

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Figma primary variants. `default` is kept as the aqua alias for existing screens. */
  variant?: keyof typeof variantClasses | "default" | "secondary";
  icon?: IconName;
  visualState?: "default" | "hover" | "active" | "disabled";
  children: ReactNode;
};

export function Button({
  className,
  variant = "default",
  icon,
  visualState = "default",
  disabled,
  children,
  type,
  ...props
}: ButtonProps) {
  const resolvedVariant = variant === "default" ? "aqua" : variant === "secondary" ? "gray" : variant;

  return (
    <button
      className={cn(
        "vc-corner-smooth text-style-body inline-flex h-12 shrink-0 cursor-pointer items-center justify-center gap-[var(--vc-gap-8)] whitespace-nowrap rounded-[var(--vc-radius-16)] border border-transparent px-[var(--vc-gap-16)] font-medium tracking-[-0.02em] outline-none transition-[background-color,color,filter,transform] duration-150 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45 focus-visible:ring-2 focus-visible:ring-[var(--vc-focus-ring)] active:scale-[0.98] [&_svg]:pointer-events-none [&_svg]:shrink-0",
        variantClasses[resolvedVariant],
        className,
      )}
      data-visual-state={visualState === "default" ? undefined : visualState}
      disabled={disabled || visualState === "disabled"}
      type={type ?? "button"}
      {...props}
    >
      {icon ? <Icon aria-hidden className="size-4" name={icon} /> : null}
      {children}
    </button>
  );
}
