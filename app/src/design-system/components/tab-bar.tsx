import type { HTMLAttributes, ReactNode } from "react";

import { Tab } from "@/design-system/components/tab";
import type { IconName } from "@/design-system/icons";
import { cn } from "@/lib/utils";

export type TabBarItem = {
  id: string;
  label: ReactNode;
  icon?: IconName;
  disabled?: boolean;
  /** Use only for explicit component-state previews. */
  visualState?: "default" | "hover" | "active" | "disabled";
};

export type TabBarProps = Omit<HTMLAttributes<HTMLDivElement>, "onChange"> & {
  items: readonly TabBarItem[];
  value: string;
  onValueChange?: (value: string) => void;
};

/** A 48px segmented container that composes the local `Tab` primitive. */
export function TabBar({
  className,
  items,
  onValueChange,
  value,
  ...props
}: TabBarProps) {
  const enabled = items.filter((item) => !item.disabled);

  function moveFocus(step: number) {
    if (!enabled.length) return;
    const current = enabled.findIndex((item) => item.id === value);
    const next = enabled[(current + step + enabled.length) % enabled.length];
    onValueChange?.(next.id);
    document.getElementById(`${next.id}-navigation`)?.focus();
  }

  return (
    <div
      onKeyDown={(event) => {
        const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        moveFocus(step);
      }}
      className={cn(
        "vc-corner-smooth inline-flex h-12 items-start gap-[var(--vc-gap-2)] overflow-hidden rounded-[var(--vc-radius-16)] bg-[var(--vc-surface-foreground)] p-[var(--vc-gap-2)]",
        className,
      )}
      {...props}
    >
      {items.map((item) => (
        <Tab
          active={item.id === value}
          disabled={item.disabled}
          icon={item.icon}
          id={`${item.id}-navigation`}
          key={item.id}
          onClick={() => onValueChange?.(item.id)}
          tabIndex={item.id === value ? 0 : -1}
          visualState={item.visualState}
        >
          {item.label}
        </Tab>
      ))}
    </div>
  );
}
