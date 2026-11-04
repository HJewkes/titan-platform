// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RpcProvider } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { snapshotKey, staticSource, type Snapshot } from "@titan-design/rpc-client";
import type { ArRunView } from "../server/autoresearch-view.js";
import { AR_RUN_FIXTURE, AR_RUN_PRE_S3A, AR_RUN_SYNC_FAILED } from "../server/twin/autoresearch.js";
import { twinSnapshot } from "../server/twin/snapshot.js";
import { App } from "./App.js";

let twin: Snapshot;

beforeAll(async () => {
  twin = await twinSnapshot();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const RUN_ROUTE = "#/autoresearch/ar-7c1e";
const SUPERSEDED = "i-0d4e8f2a6b1c";
const L2_REJECT = "i-c81e5a7f3b20";

function renderConsole(hash: string, snapshot: Snapshot = twin): void {
  window.location.hash = hash;
  render(
    <RpcProvider source={staticSource({ snapshot })}>
      <App />
    </RpcProvider>,
  );
}

const withRun = (run: ArRunView): Snapshot => ({ ...twin, calls: { ...twin.calls, [snapshotKey("autoresearch.run", { runId: run.runId })]: successEnvelope(run) } });

async function openRound(round: number): Promise<HTMLElement> {
  const decisions = await screen.findByTestId("autoresearch-decisions");
  fireEvent.click(within(decisions).getByRole("button", { name: new RegExp(`^Round ${round} ·`) }));
  return screen.findByTestId(`autoresearch-settle-${round}`);
}

/** Round 2 with its L2 reject turned into a later winner that the new head rejected on re-evaluation. */
function withReevalReject(): ArRunView {
  const reeval = { ideaId: L2_REJECT, from: "a".repeat(40), vs: "b".repeat(40), merge: "c".repeat(40), runs: [], delta: -0.4, decision: "rejected" as const, reason: "not-better" };
  const rounds = AR_RUN_FIXTURE.rounds.map((round) =>
    round.round !== 2
      ? round
      : {
          ...round,
          moves: [{ from: "a".repeat(40), to: "b".repeat(40), kind: "merge" as const, ideaId: "i-5b3c7e9a1d0f" }],
          reevals: [reeval],
          ladders: round.ladders.map((ladder) =>
            ladder.idea.id === L2_REJECT && ladder.outcome !== null
              ? { ...ladder, outcome: { ...ladder.outcome, reason: "reeval:not-better", reeval: { vs: reeval.vs, decision: reeval.decision, reason: reeval.reason } } }
              : ladder,
          ),
        },
  );
  return { ...AR_RUN_FIXTURE, rounds };
}

describe("a round's ratchet moves and re-evaluations", () => {
  it("lists the round's fast-forward with its idea and commit links", async () => {
    renderConsole(RUN_ROUTE);

    const settle = await openRound(1);
    const move = within(settle).getByTestId("autoresearch-move-1");

    expect(move.textContent).toContain("fast-forward");
    expect(move.textContent).toContain("i-3f9a");
    expect(within(move).getByTestId("autoresearch-ratchet-links")).toBeTruthy();
  });

  it("shows a requeued winner's conflict with the files it touched", async () => {
    renderConsole(RUN_ROUTE);

    const row = within(await openRound(1)).getByTestId(`autoresearch-reeval-${SUPERSEDED}`);

    expect(row.textContent).toContain("requeued");
    expect(row.textContent).toContain("conflict: the merge onto the new head conflicted (src/thresholds.ts)");
    expect(row.textContent).toContain("—");
  });

  it("shows a re-evaluation reject's decision, readable reason and Δ, and the decision row reads the same reason", async () => {
    renderConsole(RUN_ROUTE, withRun(withReevalReject()));

    const row = within(await openRound(2)).getByTestId(`autoresearch-reeval-${L2_REJECT}`);
    const decision = screen.getByTestId(`autoresearch-decision-${L2_REJECT}`);

    expect(row.textContent).toContain("rejected");
    expect(row.textContent).toContain("not-better: Δ ≤ 0");
    expect(row.textContent).toContain("−0.4pp");
    expect(decision.textContent).toContain("reeval:not-better: re-evaluated on the new head: Δ ≤ 0");
  });

  it("shows nothing for a round recorded before concurrent winners", async () => {
    renderConsole("#/autoresearch/ar-2b90", withRun(AR_RUN_PRE_S3A));

    await screen.findByTestId("autoresearch-decisions");

    expect(screen.queryByTestId("autoresearch-settle-1")).toBeNull();
  });

  it("names the re-evaluation in the superseded idea's record", async () => {
    renderConsole(`${RUN_ROUTE}?idea=${SUPERSEDED}`);

    const row = await screen.findByTestId("autoresearch-drawer-reeval");

    expect(row.textContent).toContain("requeued on 4a7c0e3 · conflict: the merge onto the new head conflicted");
  });
});

describe("the run's snapshots and syncs", () => {
  it("lists each snapshot with its PR link, trigger and round", async () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    renderConsole(RUN_ROUTE);
    const first = await screen.findByTestId("autoresearch-snapshot-1");
    const second = screen.getByTestId("autoresearch-snapshot-2");

    fireEvent.click(within(first).getByText(/^#101/));
    fireEvent.click(within(second).getByText(/^#102/));

    expect(opened.mock.calls.map(([url]) => url)).toEqual(["https://github.com/example-org/example-target/pull/101", "https://github.com/example-org/example-target/pull/102"]);
    expect(first.textContent).toContain("kept");
    expect(second.textContent).toContain("round 2");
    expect(second.textContent).toContain("spend");
  });

  it("shows a changed-tree sync's re-measure of B and a held sync waiting on the owner's gate", async () => {
    renderConsole(RUN_ROUTE);

    const merged = await screen.findByTestId("autoresearch-sync-2");
    const held = screen.getByTestId("autoresearch-sync-3");

    expect(merged.textContent).toContain("merged · tree changed");
    expect(merged.textContent).toContain("s1 231.4 · s2 231.1 · s3 231.3");
    expect(held.textContent).toContain("conflict: src/config.json");
    expect(held.textContent).toContain("waiting for the owner");
  });

  it("shows a pending cut and a frozen sync the owner answered", async () => {
    const syncs = [{ round: 2, pr: 101, state: "merged" as const, frozen: ["src/gate/measure.py"], gate: { answered: true, resolved: "d".repeat(40) } }];
    renderConsole(RUN_ROUTE, withRun({ ...AR_RUN_FIXTURE, syncs, snapshotPending: { trigger: "phase-end" } }));

    const pending = await screen.findByTestId("autoresearch-snapshot-pending");
    const sync = screen.getByTestId("autoresearch-sync-2");

    expect(pending.textContent).toContain("A phase-end snapshot is waiting");
    expect(sync.textContent).toContain("frozen: src/gate/measure.py");
    expect(sync.textContent).toContain("answered: ddddddd");
  });

  it("notes a failed sync with its reason, leaving the PR open for the next round", async () => {
    renderConsole(RUN_ROUTE, withRun(AR_RUN_SYNC_FAILED));

    const failed = await screen.findByTestId("autoresearch-sync-3");

    expect(failed.textContent).toContain("open");
    expect(failed.textContent).toContain("sync failed, retried next round: [sync-push] the push to the snapshot branch was refused");
    expect(screen.getByTestId("autoresearch-sync-2").textContent).not.toContain("sync failed");
  });

  it("says a run recorded before snapshots cut none", async () => {
    renderConsole("#/autoresearch/ar-2b90", withRun(AR_RUN_PRE_S3A));

    const section = await screen.findByTestId("autoresearch-snapshots");

    expect(section.textContent).toContain("The run has cut no snapshot");
    expect(within(section).queryByTestId("autoresearch-syncs")).toBeNull();
  });

  it("names the open snapshot in the runs list", async () => {
    renderConsole("#/autoresearch");

    const row = await screen.findByTestId("autoresearch-run-ar-7c1e");

    expect(row.textContent).toContain("k2 · PR #102");
  });
});

/** What the page derives from ladders: the header's spend and decisions, the stops by rung and the progress summary. */
async function ladderReadings(run: ArRunView): Promise<string[]> {
  renderConsole(RUN_ROUTE, withRun(run));
  const ids = ["autoresearch-stat-spend", "autoresearch-stat-decisions", "autoresearch-stops", "autoresearch-progress-summary"];
  const readings = [await screen.findByTestId(ids[0]!), ...ids.slice(1).map((id) => screen.getByTestId(id))].map((element) => element.textContent);
  cleanup();
  return readings;
}

describe("a sync's re-measure of B", () => {
  it("never reaches an idea's ladder, its rung, the spend or the progress", async () => {
    const remeasure = { case: "seed-a", repeat: "s9", metrics: { score: 199.9 }, gates: { all_gate: true }, violations: {}, usd: 40 };
    const synced = { ...AR_RUN_FIXTURE, syncs: [{ round: 2, pr: 101, state: "merged" as const, treeChanged: true, runs: [remeasure, remeasure] }] };

    const without = await ladderReadings({ ...AR_RUN_FIXTURE, syncs: [] });
    const withSync = await ladderReadings(synced);
    renderConsole(RUN_ROUTE, withRun(synced));

    expect(withSync).toEqual(without);
    expect((await screen.findByTestId("autoresearch-sync-2")).textContent).toContain("s9 199.9");
  });
});
