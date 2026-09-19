import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  useContext,
  useState,
} from "react";

import { cn } from "@/lib/utils";

const TooltipContext = createContext({ open: false, setOpen: (_open: boolean) => {} });

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function Tooltip({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <TooltipContext.Provider value={{ open, setOpen }}>
      <span className="relative inline-flex">{children}</span>
    </TooltipContext.Provider>
  );
}

export function TooltipTrigger({ children, asChild }: { children: ReactElement; asChild?: boolean }) {
  const { setOpen } = useContext(TooltipContext);
  const child = Children.only(children);
  if (!isValidElement(child)) return null;

  const handlers = {
    onBlur: () => setOpen(false),
    onFocus: () => setOpen(true),
    onMouseEnter: () => setOpen(true),
    onMouseLeave: () => setOpen(false),
  };

  if (asChild) return cloneElement(child, handlers);
  return <button type="button" {...handlers}>{child}</button>;
}

export function TooltipContent({ className, children, ...props }: HTMLAttributes<HTMLSpanElement>) {
  const { open } = useContext(TooltipContext);
  if (!open) return null;

  return (
    <span
      className={cn(
        "pointer-events-none absolute left-1/2 top-full z-50 mt-2 w-max max-w-xs -translate-x-1/2 rounded-[var(--vc-radius-4)] border border-[var(--vc-border-strong)] bg-[var(--vc-surface-active)] px-2 py-1 text-style-caption text-foreground",
        className,
      )}
      role="tooltip"
      {...props}
    >
      {children}
    </span>
  );
}
