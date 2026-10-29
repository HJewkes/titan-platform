// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { errorEnvelope } from "@titan-design/registry";
import { snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import { twinSnapshot } from "../server/twin/snapshot.js";
import { renderPage } from "./render-page.test-helpers.js";

let twin: Snapshot;

beforeAll(async () => {
  twin = await twinSnapshot();
});

afterEach(cleanup);

function renderConsole(hash: string, snapshot: Snapshot = twin, { inApp = false } = {}): void {
  renderPage(snapshot, hash, { inApp });
}

/** The text of the one stat in the header that shows this label. */
function statText(header: HTMLElement, label: string): string {
  const stats = within(header).getAllByTestId(/^autoresearch-stat-[a-z]+$/).filter((stat) => within(stat).queryByText(label) !== null);
  expect(stats).toHaveLength(1);
  return stats[0]?.textContent ?? "";
}

const withAnswer = (command: string, args: unknown, envelope: Snapshot["calls"][string]): Snapshot => ({ ...twin, calls: { ...twin.calls, [snapshotKey(command, args)]: envelope } });

describe("the autoresearch page", () => {
  it("lists the run the twin's autoresearch.runs answers and opens its header", async () => {
    renderConsole("#/autoresearch", twin, { inApp: true });

    fireEvent.click(within(await screen.findByTestId("autoresearch-run-ar-7c1e")).getByText("ar-7c1e"));

    expect(within(screen.getByTestId("autoresearch-run-ar-7c1e")).getByText("3 / 50")).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe("#/autoresearch/ar-7c1e"));
    expect(await screen.findByTestId("autoresearch-header")).toBeTruthy();
  });

  it("reads the run header from autoresearch.run, with the superseded winner apart from the stops", async () => {
    renderConsole("#/autoresearch/ar-7c1e");
    const header = await screen.findByTestId("autoresearch-header");

    expect(within(header).getByText("fixture-target · ar-7c1e")).toBeTruthy();
    expect(within(header).getByText("running")).toBeTruthy();
    expect(statText(header, "Round")).toContain("3 / 50");
    expect(statText(header, "Best score")).toContain("231.2");
    expect(statText(header, "Best score")).toContain("+3.3 vs B₀ 234.5, +5.3σ");
    expect(statText(header, "Noise")).toContain("σ 0.62");
    expect(statText(header, "Noise")).toContain("band ±1.24");
    expect(statText(header, "Decisions")).toContain("kept 1");
    expect(statText(header, "Decisions")).toContain("rejected 2 · stopped 0 · superseded 1");
    expect(statText(header, "Lanes in use")).toContain("2 / 3");
  });

  it("shows the backlog left after the picks, marking a top-K idea the draw passed over", async () => {
    renderConsole("#/autoresearch/ar-7c1e");
    const backlog = await screen.findByTestId("autoresearch-backlog");

    expect(within(backlog).queryByTestId("autoresearch-backlog-i-77aa2b4c6d8e")).toBeNull();
    const requeued = within(backlog).getByTestId("autoresearch-backlog-i-0d4e8f2a6b1c");
    expect(requeued.textContent).toContain("requeue");
    expect(requeued.textContent).toContain("bold");
    expect(requeued.textContent).toContain("0.38 · top K, not picked");
  });

  it("shows the planner's bold quota exemption reason when it added no bold idea", async () => {
    renderConsole("#/autoresearch/ar-7c1e");

    const quota = await screen.findByTestId("autoresearch-quota-bold");

    expect(within(quota).getByText("[EXEMPT] The requeued bold idea still stands in the pool")).toBeTruthy();
  });

  it("labels a superseded winner as requeued in its round's decisions", async () => {
    renderConsole("#/autoresearch/ar-7c1e");
    const decisions = await screen.findByTestId("autoresearch-decisions");

    fireEvent.click(within(decisions).getByText("Round 1 · 2 decided"));

    const superseded = await within(decisions).findByTestId("autoresearch-decision-i-0d4e8f2a6b1c");
    expect(superseded.textContent).toContain("superseded: another winner moved the ratchet first; requeued");
    const kept = within(decisions).getByTestId("autoresearch-decision-i-3f9a0c1d2e4b");
    expect(kept.textContent).toContain("+1.2pp · +1.9σ");
    expect(within(kept).getByTestId("autoresearch-ratchet-links").textContent).toMatch(/^9e1d4b7.*→4a7c0e3/);
  });

  it("opens the newest round and keeps earlier ones collapsed", async () => {
    renderConsole("#/autoresearch/ar-7c1e");
    const decisions = await screen.findByTestId("autoresearch-decisions");

    expect(within(decisions).getByText("No idea has reached a decision this round")).toBeTruthy();
    expect(within(decisions).queryByTestId("autoresearch-decision-i-3f9a0c1d2e4b")).toBeNull();
  });

  it("shows the factory's error instead of an empty list when the runs read fails", async () => {
    renderConsole("#/autoresearch", withAnswer("autoresearch.runs", {}, errorEnvelope("factory not answering on port 7410: connect ECONNREFUSED", 69)));

    expect(await screen.findByText(/^Could not load the autoresearch runs: factory not answering/)).toBeTruthy();
    expect(screen.queryByText("The factory holds no autoresearch run")).toBeNull();
  });

  it("names a run the factory does not hold rather than show another", async () => {
    renderConsole("#/autoresearch/ar-0000", withAnswer("autoresearch.run", { runId: "ar-0000" }, errorEnvelope("factory autoresearch.run: no autoresearch run ar-0000", 64)));

    expect(await screen.findByText(/^Could not load autoresearch run ar-0000: .*no autoresearch run ar-0000/)).toBeTruthy();
    expect(screen.queryByTestId("autoresearch-header")).toBeNull();
  });

  it("still opens Home for an unknown view, its rail label included", () => {
    renderConsole("#/research", twin, { inApp: true });
    expect(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "Home" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByTestId("autoresearch-header")).toBeNull();
  });
});

