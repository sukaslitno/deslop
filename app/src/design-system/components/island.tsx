import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Floating action island (Figma node 15-2866). It is a compact 64px action
 * container anchored above the scrolling content by its parent screen.
 */
export function Island({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "vc-corner-smooth flex h-16 max-w-full items-center gap-[var(--vc-gap-8)] overflow-hidden rounded-[var(--vc-radius-16)] bg-[var(--vc-surface-background)] p-[var(--vc-gap-8)]",
        className,
      )}
      {...props}
    />
  );
}

/** Figma Island / path: selection details and actions in the same 64px surface. */
export function PathIsland({
  name,
  size,
  path,
  children,
  className,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  name: string;
  size: string;
  path: string;
  children: ReactNode;
}) {
  return (
    <Island className={cn("w-full", className)} {...props}>
      <div className="flex h-full min-w-0 flex-1 flex-col justify-center gap-[var(--vc-gap-8)] overflow-hidden px-[var(--vc-gap-16)] py-[var(--vc-gap-2)] font-medium tracking-[-0.02em]">
        <div className="flex min-w-0 items-center gap-[var(--vc-gap-8)]">
          <span className="truncate text-style-body" title={name}>{name}</span>
          <span className="shrink-0 text-style-numeric-small">{size}</span>
        </div>
        <span className="truncate text-style-body-small text-[var(--vc-text-secondary)]" title={path}>{path}</span>
      </div>
      {children}
    </Island>
  );
}
