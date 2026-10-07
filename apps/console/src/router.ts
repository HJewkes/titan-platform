import { useSyncExternalStore } from "react";

export const VIEW_KEYS = ["status", "initiatives", "tasks", "sessions", "agents", "productivity", "knowledge", "search", "stores"] as const;
export type ViewKey = (typeof VIEW_KEYS)[number];

export interface Route {
  view: ViewKey;
  /** The initiative a detail route names; only the initiatives view reads it. */
  slug?: string;
}

/** A hand-typed hash can hold a lone `%`; keep the raw text rather than throw during render. */
function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Hash routes, because a page opened from disk has no server to answer a pushed path. */
export function parseRoute(hash: string): Route {
  const [, segment = "", detail = ""] = hash.replace(/^#/, "").split("?")[0]!.split("/");
  const view = VIEW_KEYS.find((key) => key === segment) ?? "status";
  return view === "initiatives" && detail ? { view, slug: safeDecode(detail) } : { view };
}

export function href(route: Route): string {
  if (route.view === "status") return "#/";
  return route.slug ? `#/${route.view}/${encodeURIComponent(route.slug)}` : `#/${route.view}`;
}

/** Takes the key a nav item reports; an unknown one lands on the status view. */
export function navigate(key: string): void {
  open(parseRoute(`#/${key}`));
}

export function open(route: Route): void {
  window.location.hash = href(route);
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

const readHash = (): string => window.location.hash;

export function useRoute(): Route {
  return parseRoute(useSyncExternalStore(subscribe, readHash, readHash));
}
