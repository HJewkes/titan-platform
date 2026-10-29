// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { successEnvelope } from "@titan-design/registry";
import { snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import type { ArRunView } from "../server/autoresearch-view.js";
import { AR_RUN_FIXTURE, AR_RUN_PRE_S3A } from "../server/twin/autoresearch.js";
import { twinSnapshot } from "../server/twin/snapshot.js";
import { renderPage } from "./render-page.test-helpers.js";

let twin: Snapshot;

beforeAll(async () => {
  twin = await twinSnapshot();
});

afterEach(cleanup);

const RUN_ROUTE = "#/autoresearch/ar-7c1e";
const PRE_S3A_ROUTE = "#/autoresearch/ar-2b90";
const KEPT = "i-3f9a0c1d2e4b";
const L0_STOP = "i-5b3c7e9a1d0f";
const L2_REJECT = "i-c81e5a7f3b20";

function renderConsole(hash: string, snapshot: Snapshot = twin, { inApp = false } = {}): void {
  renderPage(snapshot, hash, { inApp });
}

const withRun = (run: ArRunView): Snapshot => ({ ...twin, calls: { ...twin.calls, [snapshotKey("autoresearch.run", { runId: run.runId })]: successEnvelope(run) } });

/** The fixture with the newest decision's noise record replaced. */
function withNewestAgainst(against: NonNullable<NonNullable<ArRunView["rounds"][number]["ladders"][number]["outcome"]>["against"]>): ArRunView {
  const rounds = AR_RUN_FIXTURE.rounds.map((round) => ({
    ...round,
    ladders: round.ladders.map((ladder) => (ladder.idea.id === L2_REJECT && ladder.outcome !== null ? { ...ladder, outcome: { ...ladder.outcome, against } } : ladder)),
  }));
  return { ...AR_RUN_FIXTURE, rounds };
}

const noiseStat = async (): Promise<string> => (await screen.findByTestId("autoresearch-stat-noise")).textContent;

const drawerRow = async (name: string): Promise<string> => (await screen.findByTestId(`autoresearch-drawer-${name}`)).textContent;

describe("the header's σ from the engine's noise record", () => {
  it("names the case σ was measured on and reads the engine's lock", async () => {
    renderConsole(RUN_ROUTE);

    expect(await noiseStat()).toContain("σ 0.62");
    expect(await noiseStat()).toContain("5 pairs on seed-a · locked: band ±1.24");
  });

  it("stays unlocked when the engine says so, even past the lock pair count, with the engine's band width", async () => {
    renderConsole(RUN_ROUTE, withRun(withNewestAgainst({ case: "seed-b", head: "f".repeat(40), bandWidth: 1.7, sigma: 0.7, pairs: 7, locked: false })));

    expect(await noiseStat()).toContain("7 pairs on seed-b · unlocked: band ±1.70");
  });
});

describe("the idea drawer's S3a record", () => {
  it("shows the implementer's mode and account", async () => {
    renderConsole(`${RUN_ROUTE}?idea=${L0_STOP}`);

    expect(await drawerRow("mode")).toContain("resumed · account fixture-account");
  });

  it("shows the lane slot and an exploit lane's warm fork", async () => {
    renderConsole(`${RUN_ROUTE}?idea=${L0_STOP}`);

    expect(await drawerRow("lane")).toContain("lane 1");
    expect(await drawerRow("lane")).toContain("exploit · warm");
  });

  it("shows the noise the idea was judged against, its case and the baseline head", async () => {
    renderConsole(`${RUN_ROUTE}?idea=${KEPT}`);

    expect(await drawerRow("against")).toContain("σ 0.62 · 4 pairs on seed-a · unlocked: band ±1.50 · B at 9e1d4b7");
  });

  it("lists each L0 check, the failing one with its code", async () => {
    renderConsole(`${RUN_ROUTE}?idea=${L0_STOP}`);
    const checks = within(await screen.findByTestId("autoresearch-drawer-l0"));

    expect(checks.getByTestId("autoresearch-l0-check-bounds-post").textContent).toBe("✓ bounds-post · 1.8s");
    expect(checks.getByTestId("autoresearch-l0-check-unit").textContent).toBe("✗ unit · unit · 4.2s");
  });

  it("splits the idea's spend into implement, eval and micro", async () => {
    renderConsole(`${RUN_ROUTE}?idea=${KEPT}`);

    expect(await drawerRow("usage")).toContain("implement $1.60 · eval $1.50 · micro $0.20");
  });
});

describe("the registries' link to the idea and round", () => {
  it("links a dead end to the idea that produced it and shows its round", async () => {
    renderConsole(RUN_ROUTE, twin, { inApp: true });
    const deadEnds = within(await screen.findByTestId("autoresearch-dead-ends"));
    const row = deadEnds.getAllByRole("row").find((entry) => within(entry).queryByTestId(`autoresearch-registry-idea-${L2_REJECT}`) !== null);

    expect(row?.textContent).toMatch(/^i-c81er2config-param:raise-slack/);
    fireEvent.click(deadEnds.getByTestId(`autoresearch-registry-idea-${L2_REJECT}`));

    await waitFor(() => expect(window.location.hash).toBe(`${RUN_ROUTE}?idea=${L2_REJECT}`));
    expect(await screen.findByTestId("autoresearch-idea-drawer")).toBeTruthy();
  });

  it("links an L0 bug to its idea and leaves a planner bug's idea blank", async () => {
    renderConsole(RUN_ROUTE);
    const registries = within(await screen.findByTestId("autoresearch-registries"));
    fireEvent.click(registries.getByText("Bugs 2"));
    const rows = within(registries.getByTestId("autoresearch-bugs")).getAllByRole("row").slice(1);

    expect(within(rows[0]!).getByTestId(`autoresearch-registry-idea-${L0_STOP}`)).toBeTruthy();
    expect(rows[0]!.textContent).toContain("r2");
    expect(within(rows[1]!).queryByTestId(/autoresearch-registry-idea-/)).toBeNull();
    expect(rows[1]!.textContent).toMatch(/^—r2/);
  });
});

const headerLabels = (table: HTMLElement): string[] => within(table).getAllByRole("columnheader").map((cell) => cell.textContent);
const bodyRows = (table: HTMLElement): HTMLElement[] => within(table).getAllByRole("row").filter((row) => within(row).queryAllByRole("columnheader").length === 0);

function expectAligned(table: HTMLElement, headers: string[]): void {
  expect(headerLabels(table)).toEqual(headers);
  const rows = bodyRows(table);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(within(row).getAllByRole("cell")).toHaveLength(headers.length);
}

describe("the registry tables' columns", () => {
  const DEAD_END_HEADERS = ["Idea", "Round", "Cell", "Targets", "Rung failed", "Δ/σ", "Lesson"];
  const BUG_HEADERS = ["Idea", "Round", "Symptom", "Fix", "Source"];

  for (const route of [RUN_ROUTE, PRE_S3A_ROUTE]) {
    it(`labels every body cell with a header, Idea and Round first, on ${route}`, async () => {
      renderConsole(route);
      const registries = within(await screen.findByTestId("autoresearch-registries"));
      expectAligned(registries.getByTestId("autoresearch-dead-ends"), DEAD_END_HEADERS);
      fireEvent.click(registries.getByText(/^Bugs /));
      expectAligned(registries.getByTestId("autoresearch-bugs"), BUG_HEADERS);
    });
  }
});

const plannerRow = async (round: number): Promise<string> => (await screen.findByTestId(`autoresearch-planner-${round}`)).textContent;

describe("the round's planner from C-256 S3e", () => {
  it("names the newest round's planner agent, its resumed session and its turn's spend", async () => {
    renderConsole(RUN_ROUTE);

    expect(await plannerRow(3)).toContain("ar-plan-7c1e · resumed · $0.19 · 24.6K cache read · 3.1K cache write · 0 retries");
  });

  it("shows a planner that spawned fresh and one that retried", async () => {
    renderConsole(RUN_ROUTE);
    const decisions = within(await screen.findByTestId("autoresearch-decisions"));
    fireEvent.click(decisions.getByText(/^Round 2 /));
    fireEvent.click(decisions.getByText(/^Round 1 /));

    expect(await plannerRow(2)).toContain("resumed · $0.31 · 18.4K cache read · 6.2K cache write · 1 retry");
    expect(await plannerRow(1)).toContain("ar-plan-7c1e · spawned fresh · $0.42");
  });

  it("says when a planner named itself but recorded no mode or spend", async () => {
    const rounds = AR_RUN_FIXTURE.rounds.map((round) => (round.round === 3 ? { ...round, planner: { agent: "ar-plan-bare" } } : round));
    renderConsole(RUN_ROUTE, withRun({ ...AR_RUN_FIXTURE, rounds }));

    expect(await plannerRow(3)).toMatch(/ar-plan-bare · spend not recorded$/);
  });
});

const RUNNING_FOLLOWUP = "i-77aa2b4c6d8e";
const REQUEUED = "i-0d4e8f2a6b1c";

describe("C-256 S4c's stop reason and lineage depth", () => {
  it("names why an ended run stopped under the Round stat", async () => {
    renderConsole(RUN_ROUTE, withRun({ ...AR_RUN_FIXTURE, status: "completed", completedAt: AR_RUN_FIXTURE.startedAt, stopReason: "rounds-without-gain" }));

    expect((await screen.findByTestId("autoresearch-stat-round")).textContent).toContain("ended: rounds-without-gain");
  });

  it("names no stop reason on a run still going", async () => {
    renderConsole(RUN_ROUTE);

    expect((await screen.findByTestId("autoresearch-stat-round")).textContent).not.toContain("ended");
  });

  it("shows a follow-up's depth in its drawer and a root's in the backlog", async () => {
    renderConsole(`${RUN_ROUTE}?idea=${RUNNING_FOLLOWUP}`);

    expect(await drawerRow("lineage")).toMatch(/\(parent i-3f9a0c1d2e4b\) · depth 1$/);
    expect(screen.getByTestId(`autoresearch-backlog-${REQUEUED}`).textContent).toContain("i-0d4e · depth 0");
  });
});

describe("a run recorded before S3a", () => {
  it("renders its header, registries and idea drawer, saying what it did not record", async () => {
    renderConsole(`${PRE_S3A_ROUTE}?idea=${KEPT}`);

    expect(await noiseStat()).toContain("σ 0.62unlocked: band ±1.50");
    expect(within(screen.getByTestId("autoresearch-dead-ends")).queryByTestId(/autoresearch-registry-idea-/)).toBeNull();
    for (const name of ["mode", "lane", "against", "usage"]) expect(await drawerRow(name)).toContain("not recorded for this idea");
    expect(await drawerRow("l0")).toContain("passed (no per-check rows recorded)");
    expect(await drawerRow("lineage")).not.toContain("depth");
  });

  it("renders its rounds without a planner, saying it was not recorded", async () => {
    renderConsole(PRE_S3A_ROUTE);

    expect(await plannerRow(3)).toContain("not recorded for this round");
    expect(within(screen.getByTestId("autoresearch-decisions")).getByText("No idea has reached a decision this round")).toBeTruthy();
  });

  it("is in the twin's runs list beside the S3a run", async () => {
    renderConsole("#/autoresearch");

    expect(await screen.findByTestId(`autoresearch-run-${AR_RUN_PRE_S3A.runId}`)).toBeTruthy();
  });
});
