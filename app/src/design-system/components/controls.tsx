import type { HTMLAttributes } from "react";

import { Button } from "@/design-system/components/button";
import { TabBar, type TabBarItem } from "@/design-system/components/tab-bar";
import type { IconName } from "@/design-system/icons";
import { cn } from "@/lib/utils";

export type ControlsProps = Omit<HTMLAttributes<HTMLDivElement>, "onChange"> & {
  tabs: readonly TabBarItem[];
  value: string;
  onValueChange?: (value: string) => void;
  actionLabel?: string;
  actionIcon?: IconName;
  actionDisabled?: boolean;
  actionVisualState?: "default" | "hover" | "active" | "disabled";
  onActionClick?: () => void;
};

/** Header controls: a `TabBar` paired with the Figma gray default `Button`. */
export function Controls({
  actionDisabled = false,
  actionIcon = "settings",
  actionLabel,
  actionVisualState = "default",
  className,
  onActionClick,
  onValueChange,
  tabs,
  value,
  ...props
}: ControlsProps) {
  return (
    <div
      className={cn("flex w-full items-center justify-between", className)}
      {...props}
    >
      <TabBar items={tabs} onValueChange={onValueChange} value={value} />
      {actionLabel ? <Button
        disabled={actionDisabled}
        icon={actionIcon}
        onClick={onActionClick}
        variant="gray"
        visualState={actionVisualState}
      >
        {actionLabel}
      </Button> : null}
    </div>
  );
}
