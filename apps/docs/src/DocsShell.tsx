import { AppShell, LayersIcon, TopBar, type BrandPreset } from "@titan-design/react-ui";
import type { ReactNode } from "react";
import { DocsNav } from "./DocsNav.js";

// BrandKey has no docs entry, so the docs pass their own preset.
export const DOCS_BRAND: BrandPreset = {
  mark: <LayersIcon size={14} color="currentColor" />,
  wordmark: "TITAN PLATFORM",
  accentClassName: "text-dataviz-categorical-3",
  accentBarClassName: "bg-dataviz-categorical-3",
  subtitle: "docs",
};

/**
 * The page chrome. The clock is off because a prerendered page is rendered at build time and hydrated later: a live
 * clock's text differs between the two and React throws the server tree away.
 */
export function DocsShell({ children }: { children: ReactNode }) {
  return (
    <AppShell brand={DOCS_BRAND} topBar={<TopBar brand={DOCS_BRAND} showClock={false} />} nav={<DocsNav />} contentPadding="none">
      {children}
    </AppShell>
  );
}
