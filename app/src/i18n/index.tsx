import { createContext, type ReactNode, useContext, useEffect, useMemo } from "react";
import { en } from "./messages/en";
import { ru } from "./messages/ru";
import { configureHumanFormatting } from "@/lib/utils";
import type { AppPreferences, SupportedLocale } from "@/lib/api";

type MessageKey = keyof typeof en;
type Params = Record<string, string | number>;
type LocaleContextValue = { locale: SupportedLocale; t: (key: MessageKey, params?: Params) => string; collator: Intl.Collator };
const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ preferences, children }: { preferences: AppPreferences; children: ReactNode }) {
  configureHumanFormatting(preferences.locale, preferences.sizeUnits);
  const value = useMemo<LocaleContextValue>(() => {
    const catalog = preferences.locale === "ru" ? ru : en;
    return {
      locale: preferences.locale,
      t: (key, params = {}) => catalog[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`)),
      collator: new Intl.Collator(preferences.locale),
    };
  }, [preferences.locale]);
  useEffect(() => {
    document.documentElement.lang = preferences.locale;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyAppearance = () => document.documentElement.classList.toggle("dark", preferences.appearance === "dark" || (preferences.appearance === "system" && media.matches));
    applyAppearance();
    media.addEventListener("change", applyAppearance);
    return () => media.removeEventListener("change", applyAppearance);
  }, [preferences]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const value = useContext(LocaleContext);
  if (!value) throw new Error("LocaleProvider is required");
  return value;
}

export function initialMessage(locale: SupportedLocale, key: MessageKey) {
  return (locale === "ru" ? ru : en)[key];
}
