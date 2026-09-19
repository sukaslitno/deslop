import { motion } from "framer-motion";

import { cn } from "@/lib/utils";

type OrbitingCirclesProps = {
  /** Diameter in pixels. */
  size?: number;
  /** Announces the ongoing operation to assistive technology when supplied. */
  label?: string;
  className?: string;
};

/** A small, calm progress indicator for operations whose duration is unknown. */
export function OrbitingCircles({
  size = 48,
  label,
  className,
}: OrbitingCirclesProps) {
  const centerSize = size * 0.25;
  const orbitSize = size / 6;

  return (
    <div
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "status" : undefined}
      className={cn("relative flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      {label && <span className="sr-only">{label}</span>}
      <div
        className="rounded-full bg-foreground"
        style={{ width: centerSize, height: centerSize }}
      />
      {[1, -1].map((direction) => (
        <motion.div
          key={direction}
          className="absolute inset-0"
          animate={{ rotate: direction * 360 }}
          transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
        >
          <div
            className="absolute top-0 left-1/2 rounded-full bg-muted-foreground"
            style={{
              width: orbitSize,
              height: orbitSize,
              marginLeft: -orbitSize / 2,
            }}
          />
        </motion.div>
      ))}
    </div>
  );
}
