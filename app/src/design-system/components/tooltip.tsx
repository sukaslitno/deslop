import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  useContext,
  useId,
  useState,
} from "react";

import { cn } from "@/lib/utils";

const TooltipContext = createContext({ open: false, setOpen: (_open: boolean) => {}, contentId: "" });

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function Tooltip({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  return (
    <TooltipContext.Provider value={{ open, setOpen, contentId }}>
      <span className="relative inline-flex">{children}</span>
    </TooltipContext.Provider>
  );
}

export function TooltipTrigger({ children, asChild }: { children: ReactElement; asChild?: boolean }) {
  const { contentId, open, setOpen } = useContext(TooltipContext);
  const child = Children.only(children);
  if (!isValidElement(child)) return null;
  const childProps = child.props as {
    onBlur?: (event: React.FocusEvent<HTMLElement>) => void;
    onFocus?: (event: React.FocusEvent<HTMLElement>) => void;
    onMouseEnter?: (event: React.MouseEvent<HTMLElement>) => void;
    onMouseLeave?: (event: React.MouseEvent<HTMLElement>) => void;
    onKeyDown?: (event: React.KeyboardEvent<HTMLElement>) => void;
  };

  const handlers = {
    "aria-describedby": open ? contentId : undefined,
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      childProps.onBlur?.(event);
      setOpen(false);
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      childProps.onFocus?.(event);
      setOpen(true);
    },
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) => {
      childProps.onMouseEnter?.(event);
      setOpen(true);
    },
    onMouseLeave: (event: React.MouseEvent<HTMLElement>) => {
      childProps.onMouseLeave?.(event);
      setOpen(false);
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      childProps.onKeyDown?.(event);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    },
  };

  if (asChild) return cloneElement(child, handlers);
  return <button type="button" {...handlers}>{child}</button>;
}

export function TooltipContent({ className, children, ...props }: HTMLAttributes<HTMLSpanElement>) {
  const { contentId, open } = useContext(TooltipContext);
  if (!open) return null;

  return (
    <span
      className={cn(
        "pointer-events-none absolute left-1/2 top-full z-50 mt-2 w-max max-w-xs -translate-x-1/2 rounded-[var(--vc-radius-4)] border border-[var(--vc-border-strong)] bg-[var(--vc-surface-active)] px-2 py-1 text-style-caption text-foreground",
        className,
      )}
      id={contentId}
      role="tooltip"
      {...props}
    >
      {children}
    </span>
  );
}
