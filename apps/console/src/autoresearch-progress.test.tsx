// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RpcProvider } from "@titan-design/react-app";
import { snapshotKey, staticSource, type Snapshot } from "@titan-design/rpc-client";
import type { ArRunView } from "../server/autoresearch-view.js";
import { AR_RUN_FIXTURE, AR_RUN_PRE_S3A } from "../server/twin/autoresearch.js";
import { twinSnapshot } from "../server/twin/snapshot.js";
import { App } from "./App.js";

let twin: Snapshot;

beforeAll(async () => {
  twin = await twinSnapshot();
});

afterEach(cleanup);

function renderRun(snapshot: Snapshot = twin): void {
  window.location.hash = "#/autoresearch/ar-7c1e";
  render(
    <RpcProvider source={staticSource({ snapshot })}>
      <App />
    </RpcProvider>,
  );
}

/** The pre-S3a run under the route's id, so a test can add one noise record to a run that has none. */
const PRE_S3A: ArRunView = { ...AR_RUN_PRE_S3A, runId: AR_RUN_FIXTURE.runId };

const withRun = (run: ArRunView): Snapshot => ({ ...twin, calls: { ...twin.calls, [snapshotKey("autoresearch.run", { runId: run.runId })]: { ok: true, data: run } } });

describe("the autoresearch wins and losses section", () => {
  it("ranks the kept idea as a win and the L2 reject as a loss, by Δ/σ", async () => {
    renderRun();

    const wins = await screen.findByTestId("autoresearch-wins");
    const losses = screen.getByTestId("autoresearch-losses");

    expect(within(wins).getByText("i-3f9a · accept-gate:stricter-tree")).toBeTruthy();
    expect(within(losses).getByText("i-c81e · config-param:raise-slack")).toBeTruthy();
    expect(losses.textContent).toContain("−2.6σ");
  });

  it("counts stops by the rung they reached, leaving the superseded winner out", async () => {
    renderRun();

    const stops = await screen.findByTestId("autoresearch-stops");

    expect(["L0 · 1", "L1 · 0", "L2 · 1", "L3 · 0"].map((label) => within(stops).queryByText(label) !== null)).toEqual([true, true, true, true]);
  });

  it("shows the planner digest's cells with their flag", async () => {
    renderRun();

    const row = await screen.findByTestId("autoresearch-cell-config-param:raise-slack");

    expect(row.textContent).toContain("2.6");
    expect(row.textContent).toContain("demote");
  });

  it("reads σ as unlocked when the run carries no G7 noise record", async () => {
    renderRun(withRun(PRE_S3A));

    const summary = await screen.findByTestId("autoresearch-progress-summary");

    expect(summary.textContent).toBe("Best score 231.2 after 4 decided · band ±1.50 · σ unlocked: the default band until 5 pairs");
  });

  it("switches to the locked band once an outcome was judged against five pairs", async () => {
    const [first, ...rest] = PRE_S3A.rounds;
    const [kept, ...others] = first!.ladders;
    const lockedKept = { ...kept!, outcome: { ...kept!.outcome!, against: { sigma: 0.4, pairs: 5 } } };
    renderRun(withRun({ ...PRE_S3A, rounds: [{ ...first!, ladders: [lockedKept, ...others] }, ...rest] }));

    const summary = await screen.findByTestId("autoresearch-progress-summary");

    expect(summary.textContent).toBe("Best score 231.2 after 4 decided · band ±0.80 · σ locked from idea 2");
  });

  it("toggles the chart's x axis to ideas evaluated", async () => {
    renderRun();
    const chart = await screen.findByTestId("autoresearch-progress-chart");
    expect(within(chart).getByText("minutes since start")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Ideas evaluated" }));

    expect(within(screen.getByTestId("autoresearch-progress-chart")).getByText("ideas evaluated")).toBeTruthy();
  });
});
