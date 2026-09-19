import type { ButtonHTMLAttributes } from "react";

import { type IconName, Icon } from "@/design-system/icons";
import { cn } from "@/lib/utils";

export type ButtonIconProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  icon: IconName;
  label: string;
  size?: "large" | "small";
  visualState?: "default" | "hover" | "active" | "disabled";
};

export function ButtonIcon({
  className,
  icon,
  label,
  size = "large",
  visualState = "default",
  disabled,
  type,
  ...props
}: ButtonIconProps) {
  const isLarge = size === "large";
  return (
    <button
      aria-label={label}
      className={cn(
        "vc-corner-smooth inline-flex shrink-0 cursor-pointer items-center justify-center border border-transparent text-[var(--vc-text-primary)] outline-none transition-[background-color,transform] duration-150 focus-visible:ring-2 focus-visible:ring-[var(--vc-focus-ring)] active:scale-[0.96] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45",
        isLarge
          ? "size-12 rounded-[var(--vc-radius-16)] bg-[var(--vc-surface-active)] hover:bg-[var(--vc-surface-foreground)] data-[visual-state=hover]:bg-[var(--vc-surface-foreground)]"
          : "size-8 rounded-[var(--vc-radius-8)] bg-[var(--vc-surface-foreground)] hover:bg-[var(--vc-surface-active)] data-[visual-state=hover]:bg-[var(--vc-surface-active)]",
        className,
      )}
      data-visual-state={visualState === "default" ? undefined : visualState}
      disabled={disabled || visualState === "disabled"}
      type={type ?? "button"}
      {...props}
    >
      <Icon aria-hidden className={isLarge ? "size-6" : "size-4"} name={icon} />
    </button>
  );
}
