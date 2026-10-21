// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { snapshotKey, staticSource, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import type { ArRunView } from "../server/autoresearch-view.js";
import { AR_RUN_FIXTURE } from "../server/twin/autoresearch.js";
import { TWIN_NOW } from "../server/twin/clock.js";
import { twinSnapshot } from "../server/twin/snapshot.js";
import { App } from "./App.js";
import { RUN_POLL_MS } from "./pages/autoresearch-live.js";

let twin: Snapshot;

beforeAll(async () => {
  twin = await twinSnapshot();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const RUN_ROUTE = "#/autoresearch/ar-7c1e";
const IMPLEMENTING = "i-77aa2b4c6d8e";
const EVALUATING = "i-c22d9e1f3a5b";

/** Counts each read the page makes, so a test can see a poll refetch the run. */
function countingSource(snapshot: Snapshot): DataSource & { reads: string[] } {
  const inner = staticSource({ snapshot });
  const reads: string[] = [];
  return { reads, call: (name, args, options) => (reads.push(name), inner.call(name, args, options)), subscribe: (handlers, options) => inner.subscribe(handlers, options) };
}

function renderConsole(hash: string, snapshot: Snapshot = twin): DataSource & { reads: string[] } {
  window.location.hash = hash;
  const source = countingSource(snapshot);
  render(
    <RpcProvider source={source}>
      <App />
    </RpcProvider>,
  );
  return source;
}

const KEPT = "i-3f9a0c1d2e4b";

/** Asked only when the drawer's button is pressed, so the twin, which holds only what some route asks for, has none. */
const DIFF = { stat: { files: 1, insertions: 2, deletions: 1 }, patch: "--- a/src/gate.ts\n+++ b/src/gate.ts\n-const scope = \"file\";\n+const scope = \"tree\";\n", truncated: false };

const withRun = (run: ArRunView): Snapshot => ({ ...twin, calls: { ...twin.calls, [snapshotKey("autoresearch.run", { runId: run.runId })]: successEnvelope(run) } });

/** The fixture with its round-2 L0 stop moved into the newest round, so the board holds a decided card too. */
function withDecidedCard(): ArRunView {
  const rounds = AR_RUN_FIXTURE.rounds.map((round, index, all) => (index === all.length - 1 ? { ...round, ladders: [...round.ladders, ...all[1]!.ladders] } : round));
  return { ...AR_RUN_FIXTURE, rounds };
}

const spinners = (card: HTMLElement): number => within(card).queryAllByRole("progressbar", { hidden: true }).length;

const column = async (stage: string): Promise<HTMLElement> => screen.findByTestId(`autoresearch-lane-${stage}`);

describe("the autoresearch lanes board", () => {
  it("puts each idea in the column of the stage it is in, live cards with a spinner and a restart badge", async () => {
    renderConsole(RUN_ROUTE, withRun(withDecidedCard()));

    const implementing = within(await column("implementing")).getByTestId(`autoresearch-card-${IMPLEMENTING}`);
    const evaluating = within(await column("l2")).getByTestId(`autoresearch-card-${EVALUATING}`);
    const done = within(await column("done")).getByTestId("autoresearch-card-i-5b3c7e9a1d0f");

    expect(spinners(implementing)).toBeGreaterThan(0);
    expect(spinners(done)).toBe(0);
    expect(within(evaluating).getByText("restarted ×1")).toBeTruthy();
    expect(done.textContent).toContain("rejected at L0 · rejected:post:unit");
    expect(within(done).queryByText(/restarted/)).toBeNull();
    expect(within(await column("l1")).queryByTestId(/autoresearch-card-/)).toBeNull();
  });

  it("links the implementer's session log when the run names a session", async () => {
    renderConsole(RUN_ROUTE);

    fireEvent.click(await screen.findByTestId(`autoresearch-implementer-${IMPLEMENTING}`));

    await waitFor(() => expect(window.location.hash).toBe("#/sessions/00000000-0000-4000-8000-00000000a003"));
  });

  it("falls back to the agent's page when the run names no session", async () => {
    renderConsole(RUN_ROUTE);

    fireEvent.click(await screen.findByTestId(`autoresearch-implementer-${EVALUATING}`));

    await waitFor(() => expect(window.location.hash).toBe("#/agents/ar-impl-7c1e-4"));
  });

  it("says when the run has not recorded an idea's implementer", async () => {
    renderConsole(RUN_ROUTE, withRun(withDecidedCard()));

    expect(within(await screen.findByTestId("autoresearch-card-i-5b3c7e9a1d0f")).getByText("implementer not recorded yet")).toBeTruthy();
  });

  it("opens an idea's drawer from its card, with the gaps it waits on, and closes back to the run", async () => {
    renderConsole(RUN_ROUTE);

    fireEvent.click(await screen.findByTestId(`autoresearch-card-details-${EVALUATING}`));
    await waitFor(() => expect(window.location.hash).toBe(`${RUN_ROUTE}?idea=${EVALUATING}`));

    const links = within(await screen.findByTestId("autoresearch-drawer-links"));
    expect(links.getByText("not recorded yet")).toBeTruthy();
    expect(links.getByText("ar-impl-7c1e-4")).toBeTruthy();
    fireEvent.click(within(screen.getByTestId("autoresearch-idea-drawer")).getByText("×"));
    await waitFor(() => expect(window.location.hash).toBe(RUN_ROUTE));
  });

  it("links the agent from the drawer", async () => {
    renderConsole(`${RUN_ROUTE}?idea=${EVALUATING}`);

    fireEvent.click(await screen.findByTestId("autoresearch-drawer-agent"));

    await waitFor(() => expect(window.location.hash).toBe("#/agents/ar-impl-7c1e-4"));
  });

  it("shows a kept idea's ratchet move and fetches its diff only when asked", async () => {
    const withDiff = { ...twin, calls: { ...twin.calls, [snapshotKey("autoresearch.diff", { runId: "ar-7c1e", ideaId: KEPT })]: successEnvelope(DIFF) } };
    const source = renderConsole(`${RUN_ROUTE}?idea=${KEPT}`, withDiff);
    const links = within(await screen.findByTestId("autoresearch-drawer-links"));

    expect(links.getByText("9e1d4b7 → 4a7c0e3")).toBeTruthy();
    expect(source.reads).not.toContain("autoresearch.diff");
    fireEvent.click(links.getByTestId("autoresearch-drawer-diff"));

    expect((await links.findByTestId("autoresearch-drawer-diff-body")).textContent).toContain("1 files · +2 −1");
  });
});

describe("the lanes board's clock and poll", () => {
  it("runs a restarted stage's timer from firstStartedAt and ticks it", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(TWIN_NOW);
    renderConsole(RUN_ROUTE);

    const stages = await screen.findByTestId(`autoresearch-card-stages-${EVALUATING}`);
    expect(within(stages).getByText("L2 6m…")).toBeTruthy();
    act(() => vi.advanceTimersByTime(60_000));

    expect(within(stages).getByText("L2 7m…")).toBeTruthy();
  });

  it("refetches the run every 15 s while it runs", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const source = renderConsole(RUN_ROUTE);
    await screen.findByTestId("autoresearch-lanes");
    const before = source.reads.filter((name) => name === "autoresearch.run").length;

    act(() => vi.advanceTimersByTime(RUN_POLL_MS));

    await waitFor(() => expect(source.reads.filter((name) => name === "autoresearch.run").length).toBe(before + 1));
  });

  it("stops polling once the run is no longer running", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const source = renderConsole(RUN_ROUTE, withRun({ ...AR_RUN_FIXTURE, status: "completed", completedAt: AR_RUN_FIXTURE.startedAt }));
    await screen.findByTestId("autoresearch-lanes");
    const before = source.reads.filter((name) => name === "autoresearch.run").length;

    act(() => vi.advanceTimersByTime(RUN_POLL_MS * 3));

    expect(source.reads.filter((name) => name === "autoresearch.run").length).toBe(before);
  });
});
