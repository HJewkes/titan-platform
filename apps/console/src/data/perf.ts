import { createContext, useContext, useRef } from "react";
import type { QuerySettled } from "@titan-design/react-app";
import type { DataSource } from "@titan-design/rpc-client";
import type { Route } from "../router.js";
import type { ViewKey } from "../view-keys.js";

/** What the browser measures. Names, view keys and numbers only: a route's id and query never appear. */
export type PerfRow =
  | { kind: "route"; view: ViewKey; detail: boolean; ms: number; queries: number }
  | { kind: "query"; command: string; ms: number; ok: boolean; fromCache: boolean };

export const MAX_ROWS_PER_POST = 100;
export const REPORT_EVERY_MS = 10_000;
/** The queries a page mounts start within this long of the route change. */
export const ROUTE_WINDOW_MS = 100;
const REPORT_URL = "/rpc/perf.report";

interface Report {
  rows: PerfRow[];
  dropped: number;
}

export interface PerfSink {
  add(row: PerfRow): void;
  flush(): void;
}

/** Holds up to {@link MAX_ROWS_PER_POST} rows; later rows are dropped and the count goes out with the next post. */
export function createPerfSink(post: (report: Report) => void): PerfSink {
  let rows: PerfRow[] = [];
  let dropped = 0;
  return {
    add(row) {
      if (rows.length >= MAX_ROWS_PER_POST) dropped += 1;
      else rows.push(row);
    },
    flush() {
      if (rows.length === 0 && dropped === 0) return;
      const report = { rows, dropped };
      rows = [];
      dropped = 0;
      post(report);
    },
  };
}

/** A beacon survives the tab closing, which a fetch does not; it carries the cookie the LAN gate asks for. */
export function beaconPost(report: Report): void {
  navigator.sendBeacon(REPORT_URL, new Blob([JSON.stringify(report)], { type: "application/json" }));
}

/** Flushes every {@link REPORT_EVERY_MS} and when the tab hides; returns the stop function. */
export function startReporting(sink: PerfSink): () => void {
  const timer = setInterval(sink.flush, REPORT_EVERY_MS);
  const onHide = (): void => {
    if (document.visibilityState === "hidden") sink.flush();
  };
  document.addEventListener("visibilitychange", onHide);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onHide);
  };
}

interface Visit {
  view: ViewKey;
  detail: boolean;
  t0: number;
  windowOpen: boolean;
  started: number;
  pending: number;
  lastSettledAt: number;
  reported: boolean;
}

export interface RouteTracker {
  /** A route change: starts timing a new page and abandons the one before it. */
  begin(view: ViewKey, detail: boolean): void;
  /** A call began; the returned function marks it finished. A call outside the first window is not the page's own. */
  callStarted(): () => void;
}

interface TrackerOptions {
  emit: (row: PerfRow) => void;
  now?: () => number;
  later?: (run: () => void, ms: number) => unknown;
}

/** Reports a page's time to first data: from the route change until every query it started in its first 100 ms has finished. */
export function createRouteTracker({ emit, now = () => performance.now(), later = setTimeout }: TrackerOptions): RouteTracker {
  let current: Visit | undefined;

  const finishIfDone = (visit: Visit): void => {
    if (visit !== current || visit.windowOpen || visit.pending > 0 || visit.reported || visit.started === 0) return;
    visit.reported = true;
    emit({ kind: "route", view: visit.view, detail: visit.detail, ms: visit.lastSettledAt - visit.t0, queries: visit.started });
  };

  return {
    begin(view, detail) {
      const visit: Visit = { view, detail, t0: now(), windowOpen: true, started: 0, pending: 0, lastSettledAt: 0, reported: false };
      current = visit;
      later(() => {
        visit.windowOpen = false;
        finishIfDone(visit);
      }, ROUTE_WINDOW_MS);
    },
    callStarted() {
      const visit = current;
      if (!visit?.windowOpen) return () => {};
      visit.started += 1;
      visit.pending += 1;
      return () => {
        visit.pending -= 1;
        visit.lastSettledAt = now();
        finishIfDone(visit);
      };
    },
  };
}

/** Lets the tracker see when each call starts and ends, whatever its outcome. */
export function trackCalls(source: DataSource, tracker: RouteTracker): DataSource {
  return {
    ...source,
    call(command, args, options) {
      const done = tracker.callStarted();
      const answer = source.call(command, args, options);
      answer.then(done, done);
      return answer;
    },
  };
}

export function queryRow({ command, ms, ok, fromCache }: QuerySettled): PerfRow {
  return { kind: "query", command, ms, ok, fromCache };
}

const RouteTrackerContext = createContext<RouteTracker | null>(null);
export const RouteTrackerProvider = RouteTrackerContext.Provider;

/** Starts timing during render, because a page's queries start in its children's effects, which run before this component's own. */
export function useRoutePerf(route: Route): void {
  const tracker = useContext(RouteTrackerContext);
  const visited = useRef<string | null>(null);
  // The id picks out a new page to time; only whether there is one leaves this function.
  const page = `${route.view}/${route.id ?? ""}`;
  if (!tracker || visited.current === page) return;
  visited.current = page;
  tracker.begin(route.view, route.id !== undefined);
}
