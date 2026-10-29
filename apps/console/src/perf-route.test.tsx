// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import { App } from "./App.js";
import { RouteTrackerProvider, createPerfSink, createRouteTracker, postReport, startReporting, trackCalls, type PerfRow } from "./data/perf.js";

afterEach(cleanup);

const SECRET_ID = "TP-4242-secret";

function renderTimed(hash: string, rows: PerfRow[]): void {
  const snapshot: Snapshot = { format: SNAPSHOT_FORMAT, createdAt: "2026-01-02T03:04:05.000Z", calls: { [snapshotKey("upstreams.health", {})]: { ok: true as const, data: { checkedAt: "2026-01-02T03:04:05.000Z", upstreams: [] } } } };
  const doc = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html");
  const tracker = createRouteTracker({ emit: (row) => rows.push(row) });
  window.location.hash = hash;
  render(
    <RouteTrackerProvider value={tracker}>
      <RpcProvider source={trackCalls(pageDataSource({ doc }), tracker)}>
        <App />
      </RpcProvider>
    </RouteTrackerProvider>,
  );
}

describe("route timing", () => {
  it("a detail route reports its view key and never its id", async () => {
    const rows: PerfRow[] = [];

    renderTimed(`#/tasks/${SECRET_ID}?tab=graph`, rows);
    await waitFor(() => expect(rows).toHaveLength(1));

    expect(rows[0]).toEqual({ kind: "route", view: "tasks", detail: true, ms: expect.any(Number), queries: expect.any(Number) });
    expect(JSON.stringify(rows)).not.toContain(SECRET_ID);
    expect(JSON.stringify(rows)).not.toContain("graph");
  });

  it("a list route reports detail false", async () => {
    const rows: PerfRow[] = [];

    renderTimed("#/tasks", rows);
    await waitFor(() => expect(rows).toHaveLength(1));

    expect(rows[0]).toMatchObject({ view: "tasks", detail: false });
  });
});

describe("report batching", () => {
  const route = (n: number): PerfRow => ({ kind: "route", view: "home", detail: false, ms: n, queries: 1 });

  it("posts at most 100 rows and counts the rows it dropped", () => {
    const posts: Array<{ rows: PerfRow[]; dropped: number }> = [];
    const sink = createPerfSink((report) => posts.push(report));

    for (let n = 0; n < 130; n += 1) sink.add(route(n));
    sink.flush();
    sink.flush();

    expect(posts).toHaveLength(1);
    expect(posts[0]?.dropped).toBe(30);
    expect(posts[0]?.rows).toHaveLength(100);
  });
});

describe("report sending", () => {
  const report = { rows: [{ kind: "route" as const, view: "home" as const, detail: false, ms: 5, queries: 1 }], dropped: 0 };

  it("posts the report as JSON to perf.report and outlives the tab", () => {
    const send = vi.fn((_url: string, _init: RequestInit) => Promise.resolve());

    postReport(report, send);

    expect(send).toHaveBeenCalledWith("/rpc/perf.report", expect.objectContaining({ method: "POST", keepalive: true, headers: { "content-type": "application/json" } }));
    expect(JSON.parse(String(send.mock.calls[0]?.[1].body))).toEqual(report);
  });

  it("flushes when the tab hides and stops when told to", () => {
    const flush = vi.fn();
    const hide = (): void => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    };

    const stop = startReporting({ add: () => {}, flush });
    hide();
    stop();
    hide();
    Reflect.deleteProperty(document, "visibilityState");

    expect(flush).toHaveBeenCalledTimes(1);
  });
});

describe("route tracker", () => {
  function manualTracker() {
    let t = 0;
    const timers: Array<() => void> = [];
    const rows: PerfRow[] = [];
    const tracker = createRouteTracker({ emit: (row) => rows.push(row), now: () => t, later: (run) => timers.push(run) });
    return { tracker, rows, advance: (ms: number) => (t += ms), closeWindow: () => timers.shift()?.() };
  }

  it("waits for a query still running when its first window closes", () => {
    const { tracker, rows, advance, closeWindow } = manualTracker();

    tracker.begin("inbox", false);
    const done = tracker.callStarted();
    advance(100);
    closeWindow();
    expect(rows).toEqual([]);
    advance(300);
    done();

    expect(rows).toEqual([{ kind: "route", view: "inbox", detail: false, ms: 400, queries: 1 }]);
  });

  it("does not count a call that starts after the first window", () => {
    const { tracker, rows, advance, closeWindow } = manualTracker();

    tracker.begin("inbox", false);
    const first = tracker.callStarted();
    advance(100);
    closeWindow();
    const late = tracker.callStarted();
    first();
    late();

    expect(rows).toEqual([{ kind: "route", view: "inbox", detail: false, ms: 100, queries: 1 }]);
  });
});
