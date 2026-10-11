import { useSyncExternalStore } from "react";

/** The rail, in rail order. */
export const VIEW_KEYS = ["home", "initiatives", "tasks", "sessions", "agents", "knowledge", "rounds"] as const;
export type ViewKey = (typeof VIEW_KEYS)[number];

export interface Route {
  view: ViewKey;
  /** The record a detail route names: an initiative slug, task id, session id, agent name, knowledge ref or round id. */
  id?: string;
  /** The text after `?`, kept whole so deep links such as `?task=` and `?tab=graph` reach the page. */
  query?: string;
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
  const raw = hash.replace(/^#/, "");
  const queryAt = raw.indexOf("?");
  const path = queryAt === -1 ? raw : raw.slice(0, queryAt);
  const query = queryAt === -1 ? "" : raw.slice(queryAt + 1);
  // A knowledge ref holds `/`; one typed unencoded still names one record, so the detail is the whole rest.
  const [, segment = "", ...rest] = path.split("/");
  const view = VIEW_KEYS.find((key) => key === segment) ?? "home";
  const detail = view === "home" ? "" : rest.join("/");
  return { view, ...(detail ? { id: safeDecode(detail) } : {}), ...(query ? { query } : {}) };
}

export function href(route: Route): string {
  const path = route.view === "home" ? "#/" : route.id ? `#/${route.view}/${encodeURIComponent(route.id)}` : `#/${route.view}`;
  return route.query ? `${path}?${route.query}` : path;
}

/** Takes the key a nav item reports; an unknown one lands on the home view. */
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
