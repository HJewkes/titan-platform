// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import { App } from "./App.js";

afterEach(cleanup);

const stats = (name: string, p50: number, p95: number, extra: Record<string, number> = {}) => ({ name, count: 10, errors: 0, p50, p95, max: p95, bytesP50: 2048, bytesMax: 4096, ...extra });

const SUMMARY_15M = {
  window: "15m",
  routes: [
    { name: "tasks", count: 4, p50: 400, p95: 900, max: 900 },
    { name: "home", count: 6, p50: 200, p95: 3500, max: 3500 },
  ],
  rpcs: [stats("work.tasks", 100, 900), stats("rounds.get", 20, 60)],
  upstreams: [stats("factory:needs.list", 300, 1200, { timeouts: 1 })],
};
const SUMMARY_24H = { ...SUMMARY_15M, window: "24h", rpcs: [stats("rounds.get", 20, 60)], routes: [], upstreams: [] };

function renderPerf(): void {
  const calls = {
    [snapshotKey("perf.summary", { window: "15m" })]: successEnvelope(SUMMARY_15M),
    [snapshotKey("perf.summary", { window: "24h" })]: successEnvelope(SUMMARY_24H),
  };
  const snapshot: Snapshot = { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls };
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html");
  window.location.hash = "#/config?tab=perf";
  render(
    <RpcProvider source={pageDataSource({ doc: page })}>
      <App />
    </RpcProvider>,
  );
}

describe("the perf tab", () => {
  it("an rpc over its budget shows the warning badge", async () => {
    renderPerf();

    const slow = await screen.findByTestId("perf-rpc-work.tasks");
    expect(within(slow).getByTestId("perf-over-budget")).toBeTruthy();
    expect(within(screen.getByTestId("perf-rpc-rounds.get")).queryByTestId("perf-over-budget")).toBeNull();
  });

  it("a route past three seconds shows the warning badge and a quick one does not", async () => {
    renderPerf();

    expect(within(await screen.findByTestId("perf-route-home")).getByTestId("perf-over-budget")).toBeTruthy();
    expect(within(screen.getByTestId("perf-route-tasks")).queryByTestId("perf-over-budget")).toBeNull();
  });

  it("lists routes, rpcs and upstreams, slowest as the server sent them", async () => {
    renderPerf();

    await screen.findByTestId("perf-routes");
    expect(within(screen.getByTestId("perf-upstream-factory:needs.list")).getByText("1,200")).toBeTruthy();
    expect(screen.getAllByTestId(/^perf-rpc-/).map((row) => row.getAttribute("data-testid"))).toEqual(["perf-rpc-work.tasks", "perf-rpc-rounds.get"]);
  });

  it("the 24 h toggle shows that window's rows", async () => {
    renderPerf();
    await screen.findByTestId("perf-rpc-work.tasks");

    fireEvent.click(screen.getByRole("tab", { name: "24 h" }));

    expect(await screen.findByText("No route timed yet")).toBeTruthy();
    expect(screen.queryByTestId("perf-rpc-work.tasks")).toBeNull();
  });
});
