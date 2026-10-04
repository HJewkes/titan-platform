import { useSyncExternalStore } from "react";

export const FILTER_KEYS = ["rule", "severity", "kind", "provenance"] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
export const SORT_KEYS = ["severity", "excess", "value", "path", "rule"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export interface PrioritiesQuery {
  filters: Partial<Record<FilterKey, string[]>>;
  sort: SortKey;
  offset: number;
}

export type Route =
  | { page: "overview" }
  | { page: "priorities"; query: PrioritiesQuery }
  | { page: "node"; id: string }
  | { page: "finding"; id: string }
  | { page: "compare" };

/** Hash routes, because a page opened from disk has no server to answer a pushed path. */
export function parseRoute(hash: string): Route {
  const [path = "", search = ""] = hash.replace(/^#/, "").split("?");
  const [, page = "", ...rest] = path.split("/");
  const tail = decodeURIComponent(rest.join("/"));
  if (page === "priorities") return { page, query: parsePriorities(new URLSearchParams(search)) };
  if (page === "node") return { page, id: tail };
  if (page === "finding" && tail) return { page, id: tail };
  if (page === "compare") return { page };
  return { page: "overview" };
}

function parsePriorities(params: URLSearchParams): PrioritiesQuery {
  const filters: PrioritiesQuery["filters"] = {};
  for (const key of FILTER_KEYS) {
    const values = params.getAll(key);
    if (values.length > 0) filters[key] = values;
  }
  const sort = SORT_KEYS.find((k) => k === params.get("sort")) ?? "severity";
  const offset = Math.max(0, Number.parseInt(params.get("offset") ?? "0", 10) || 0);
  return { filters, sort, offset };
}

export function href(route: Route): string {
  if (route.page === "overview") return "#/";
  if (route.page === "compare") return "#/compare";
  if (route.page === "node") return `#/node/${encodeURIComponent(route.id)}`;
  if (route.page === "finding") return `#/finding/${encodeURIComponent(route.id)}`;
  return `#/priorities${prioritiesSearch(route.query)}`;
}

function prioritiesSearch(query: PrioritiesQuery): string {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) for (const value of query.filters[key] ?? []) params.append(key, value);
  if (query.sort !== "severity") params.set("sort", query.sort);
  if (query.offset > 0) params.set("offset", String(query.offset));
  const search = params.toString();
  return search ? `?${search}` : "";
}

export const nodeHref = (id: string): string => href({ page: "node", id });
export const findingHref = (id: string): string => href({ page: "finding", id });

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

const readHash = (): string => window.location.hash;

export function useRoute(): Route {
  return parseRoute(useSyncExternalStore(subscribe, readHash, readHash));
}
