import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

let formatting: { locale: string; sizeUnits: "binary" | "decimal" } = {
  locale: "en",
  sizeUnits: "binary",
};

export function configureHumanFormatting(locale: string, sizeUnits: "binary" | "decimal") {
  formatting = { locale, sizeUnits };
}

/** Human-readable byte size using the active persisted display preference. */
export function human(n: number): string {
  const base = formatting.sizeUnits === "binary" ? 1024 : 1000;
  const units = formatting.sizeUnits === "binary"
    ? ["B", "KiB", "MiB", "GiB", "TiB"]
    : ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  for (const unit of units) {
    if (Math.abs(v) < base) return `${new Intl.NumberFormat(formatting.locale, { maximumFractionDigits: 1 }).format(v)} ${unit}`;
    v /= base;
  }
  return `${new Intl.NumberFormat(formatting.locale, { maximumFractionDigits: 1 }).format(v)} ${formatting.sizeUnits === "binary" ? "PiB" : "PB"}`;
}
