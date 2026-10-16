// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { errorEnvelope, successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import { App } from "./App.js";

afterEach(cleanup);

function watchRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    repo: "orbit/relay",
    pr: 12,
    branch: "feat/backoff",
    runId: "run-12",
    task: "orbit-relay/OR-12",
    phase: "review",
    headSha: "0b7e2c1a5d4f4e8b",
    phaseSince: "2031-03-05T00:00:00.000Z",
    nextAction: "waiting for the reviewer's verdict",
    pendingGate: null,
    held: null,
    stalled: null,
    stage: { name: "review", minutes: 42 },
    ...overrides,
  };
}

const HELD = watchRow({ runId: "run-12", held: { reason: "owner asked to wait" } });
const STALLED = watchRow({ runId: "run-13", pr: 13, phase: "ci", stalled: { reason: "CI silent for 90 minutes" }, stage: { name: "ci", minutes: 95 } });

const ENTRIES = [
  { kind: "step", stepId: "sh-ci", iteration: 1, startedAt: "2031-03-05T00:00:00.000Z", completedAt: "2031-03-05T00:10:00.000Z", signal: null, status: "done" },
  { kind: "verdict", stepId: "sh-review", verdict: "FIX_FIRST", headSha: "0b7e2c1a5d4f4e8b", locator: null, reviewer: "relay-reviewer-1" },
  { kind: "teleport", stepId: "sh-future" },
];

function gate(gateId: string, task: string): Record<string, unknown> {
  return { gateId, stepId: "sh-merge-gate", repo: "orbit/relay", pr: 12, task, since: "2031-03-05T00:00:00.000Z", ageHours: 3.25 };
}

function snapshot(calls: Snapshot["calls"]): Snapshot {
  return { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls };
}

const LIST_KEY = snapshotKey("shepherd.list", { state: "active" });

/** The answers the console daemon gives for a watch list with one held and one stalled run. */
const RECORDED = snapshot({
  [LIST_KEY]: successEnvelope([HELD, STALLED]),
  [snapshotKey("shepherd.waiting", {})]: successEnvelope({ owner: [gate("gate-owner", "orbit-relay/OR-12")], seat: [gate("gate-seat", "orbit-relay/OR-13")] }),
  [snapshotKey("shepherd.timeline", { repo: "orbit/relay", pr: 12 })]: successEnvelope({ row: HELD, entries: ENTRIES }),
  [snapshotKey("shepherd.timeline", { repo: "orbit/relay", pr: 99 })]: errorEnvelope("orbit/relay#99 is not shepherded", 66),
});

function renderConsole(hash: string, recorded: Snapshot = RECORDED): void {
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", recorded), "text/html");
  window.location.hash = hash;
  render(
    <RpcProvider source={pageDataSource({ doc: page })}>
      <App />
    </RpcProvider>,
  );
}

describe("the Shepherd watch list", () => {
  it("shows each run's phase, stage, minutes and next action, with held and stalled badges", async () => {
    renderConsole("#/shepherd");
    const held = await screen.findByTestId("shepherd-row-run-12");
    expect(within(held).getByText("orbit/relay#12")).toBeTruthy();
    expect(within(held).getByText("held")).toBeTruthy();
    expect(within(held).getByText("owner asked to wait")).toBeTruthy();
    expect(within(held).getByText("42")).toBeTruthy();
    expect(within(held).getByText("waiting for the reviewer's verdict")).toBeTruthy();
    const stalled = screen.getByTestId("shepherd-row-run-13");
    expect(within(stalled).getByText("stalled")).toBeTruthy();
    expect(within(stalled).getByText("CI silent for 90 minutes")).toBeTruthy();
    expect(within(stalled).queryByText("held")).toBeNull();
  });

  it("lists the owner's waiting gates before the seats'", async () => {
    renderConsole("#/shepherd");
    const owner = await screen.findByTestId("shepherd-owner-gates");
    const seat = screen.getByTestId("shepherd-seat-gates");
    expect(within(owner).getByText("orbit-relay/OR-12")).toBeTruthy();
    expect(within(seat).getByText("orbit-relay/OR-13")).toBeTruthy();
    expect(owner.compareDocumentPosition(seat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("offers no control that writes", async () => {
    renderConsole("#/shepherd");
    await screen.findByTestId("shepherd-row-run-12");
    expect(screen.queryAllByRole("button").filter((button) => /merge|hold|release|register/i.test(button.textContent))).toHaveLength(0);
  });

  it("opens a PR's timeline from its row", async () => {
    renderConsole("#/shepherd");
    fireEvent.click(within(await screen.findByTestId("shepherd-row-run-12")).getByRole("link"));
    await waitFor(() => expect(window.location.hash).toBe(`#/shepherd/${encodeURIComponent("orbit/relay#12")}`));
    expect(await screen.findByText(/verdict FIX_FIRST by relay-reviewer-1/)).toBeTruthy();
  });

  it("shows the error alert when Shepherd does not answer", async () => {
    renderConsole("#/shepherd", snapshot({ [LIST_KEY]: errorEnvelope("titan-factory unreachable on 127.0.0.1:7410", 69) }));
    expect(await screen.findByText(/Could not load Shepherd's watch list: .*unreachable/)).toBeTruthy();
  });
});

describe("a PR's Shepherd timeline", () => {
  it("renders each entry by kind and a fallback line for a kind it does not know", async () => {
    renderConsole(`#/shepherd/${encodeURIComponent("orbit/relay#12")}`);
    expect(await screen.findByText(/step sh-ci #1: done/)).toBeTruthy();
    expect(screen.getByText(/verdict FIX_FIRST by relay-reviewer-1 at 0b7e2c1/)).toBeTruthy();
    expect(screen.getByText("Unrecognised entry: teleport")).toBeTruthy();
    expect(screen.getByText("Next: waiting for the reviewer's verdict")).toBeTruthy();
  });

  it("shows the upstream error for a PR Shepherd does not watch", async () => {
    renderConsole(`#/shepherd/${encodeURIComponent("orbit/relay#99")}`);
    expect(await screen.findByText(/Could not load orbit\/relay#99: .*not shepherded/)).toBeTruthy();
  });

  it("refuses a route that names no PR", async () => {
    renderConsole("#/shepherd/orbit-relay");
    expect(await screen.findByText(/orbit-relay names no PR/)).toBeTruthy();
  });
});
