import { useSyncExternalStore } from "react";

export const VIEW_KEYS = ["status", "initiatives", "tasks", "sessions", "agents", "productivity", "knowledge", "search", "stores"] as const;
export type ViewKey = (typeof VIEW_KEYS)[number];

export interface Route {
  view: ViewKey;
}

/** Hash routes, because a page opened from disk has no server to answer a pushed path. */
export function parseRoute(hash: string): Route {
  const [, segment = ""] = hash.replace(/^#/, "").split("?")[0]!.split("/");
  return { view: VIEW_KEYS.find((key) => key === segment) ?? "status" };
}

export function href(route: Route): string {
  return route.view === "status" ? "#/" : `#/${route.view}`;
}

/** Takes the key a nav item reports; an unknown one lands on the status view. */
export function navigate(key: string): void {
  window.location.hash = href(parseRoute(`#/${key}`));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

const readHash = (): string => window.location.hash;

export function useRoute(): Route {
  return parseRoute(useSyncExternalStore(subscribe, readHash, readHash));
}
