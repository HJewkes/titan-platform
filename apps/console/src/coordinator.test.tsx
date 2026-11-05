// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { errorEnvelope, successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, staticSource, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import type { ServedCommands } from "./data/rpc.js";
import { renderPage } from "./render-page.test-helpers.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Pools = ServedCommands["coord.pools"]["result"];
type Cards = ServedCommands["coord.cards"]["result"];
type Account = Pools["accounts"][number];

// Synthetic accounts, coordinators and PRs; nothing here comes from a real broker, pace file or Shepherd.
const DATE = "2031-03-04";
const WINDOW = { date: DATE, from: "2031-03-04T07:00:00.000Z", to: "2031-03-05T07:00:00.000Z" };

function account(pool: string, overrides: Partial<Account> = {}): Account {
  return {
    pool, members: [pool], current: 50, beforeToday: 40, today: 10, reserveLine: 70, target: 60, level: "on_pace", perDayGuard: 55,
    resetsAt: 0, ageSeconds: 60, stale: false, ...overrides,
  };
}

const pr = (repo: string, number: number, task: string) => ({ repo, number, task, initiative: "harbor", url: `https://github.com/${repo}/pull/${number}` });

const POOLS: Pools = { ...WINDOW, accounts: [account("dock", { members: ["dock", "dock-spare"] }), account("quay", { level: "at_risk", stale: true })], gaps: [] };
const CARDS: Cards = {
  date: DATE,
  cards: [
    { coordinator: "harbor-coord", seat: "harbor-coord", agentsRun: 3, liveNow: 1, costUsd: 2.5, prsMerged: [pr("harbor/dock", 7, "HB-7")], tasks: [{ id: "HB-7", title: "Build the dock index" }] },
    { coordinator: "quay-session", seat: null, agentsRun: 1, liveNow: 0, costUsd: null, prsMerged: [], tasks: [] },
  ],
  unattributed: [pr("harbor/quay", 9, "HB-9")],
  gaps: [],
};

function snapshot(calls: Record<string, Snapshot["calls"][string]>): Snapshot {
  return { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls };
}

const answering = (day: { date?: string }, pools: Snapshot["calls"][string], cards: Snapshot["calls"][string]): Snapshot =>
  snapshot({ [snapshotKey("coord.pools", day)]: pools, [snapshotKey("coord.cards", day)]: cards, [snapshotKey("coord.shipped", day)]: successEnvelope({ date: DATE, built: false, stale: false, digest: null, merged: [] }) });

describe("the coordinator page", () => {
  it("draws one meter per account with its reserve, target and guard markers, for the day the query names", async () => {
    renderPage(answering({ date: DATE }, successEnvelope(POOLS), successEnvelope(CARDS)), `#/coordinator?date=${DATE}`);

    const dock = await screen.findByTestId("coord-meter-dock");
    expect(within(dock).getByText("dock (dock, dock-spare)")).toBeTruthy();
    expect(within(dock).getByText("40% before today + 10% today = 50% · reserve line 70% · target 60% · per-day guard 55%")).toBeTruthy();
    expect(screen.getByTestId("coord-meter-today-dock").style.left).toBe("40%");
    for (const [marker, left] of [["reserve", "70%"], ["target", "60%"], ["guard", "55%"]]) expect(screen.getByTestId(`coord-marker-${marker}-dock`).style.left).toBe(left);
    expect(screen.getByTestId("coord-meter-stale-quay")).toBeTruthy();
    expect(screen.getByTestId("coord-day-label").textContent).toBe(DATE);
  });

  it("gives each coordinator a card with its seat, agents, cost and merged PRs, and groups the unowned PRs apart", async () => {
    renderPage(answering({}, successEnvelope(POOLS), successEnvelope(CARDS)), "#/coordinator");

    const card = await screen.findByTestId("coord-card-harbor-coord");
    expect(within(card).getByText("seat harbor-coord")).toBeTruthy();
    expect(within(card).getByText("3 agents run · 1 live now · $2.50")).toBeTruthy();
    expect(within(card).getByTestId("coord-pr-harbor/dock#7")).toBeTruthy();
    expect(within(card).getByText("Build the dock index")).toBeTruthy();
    expect(within(screen.getByTestId("coord-card-unattributed")).getByTestId("coord-pr-harbor/quay#9")).toBeTruthy();
    expect(within(card).queryByTestId("coord-pr-harbor/quay#9")).toBeNull();
  });

  it("shows a coordinator whose agents reported no cost as n/a, not as $0.00", async () => {
    renderPage(answering({}, successEnvelope(POOLS), successEnvelope(CARDS)), "#/coordinator");

    expect((await screen.findByTestId("coord-card-stats-quay-session")).textContent).toBe("1 agent run · 0 live now · n/a");
    expect(screen.queryByTestId("coord-card-seat-quay-session")).toBeNull();
  });

  it("confines a failed pools read to one alert in its own section and still draws the cards", async () => {
    renderPage(answering({}, errorEnvelope("pace read crashed", 1), successEnvelope(CARDS)), "#/coordinator");

    expect((await screen.findByTestId("coord-pools-error")).textContent).toContain("pace read crashed");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByTestId("coord-card-harbor-coord")).toBeTruthy();
  });

  it("moves the day back through the query when Previous day is pressed", async () => {
    const replace = vi.fn();
    vi.stubGlobal("location", { ...window.location, hash: `#/coordinator?date=${DATE}`, replace });
    renderPage(answering({ date: DATE }, successEnvelope(POOLS), successEnvelope(CARDS)), `#/coordinator?date=${DATE}`);

    fireEvent.click(await screen.findByTestId("coord-day-previous"));

    expect(replace).toHaveBeenCalledWith("#/coordinator?date=2031-03-03");
  });
});

describe("the coordinator page while loading or degraded", () => {
  it("shows skeletons for the meters and the cards until the reads answer", () => {
    const pending: DataSource = { call: () => new Promise(() => undefined), subscribe: (handlers, options) => staticSource({ snapshot: snapshot({}) }).subscribe(handlers, options) };
    renderPage(pending, "#/coordinator");

    expect(screen.getByTestId("coord-pools-loading")).toBeTruthy();
    expect(screen.getByTestId("coord-cards-loading")).toBeTruthy();
  });

  it("explains in words what a missing pace.json leaves unknown, and keeps the account's own error", async () => {
    const missing: Pools = { ...WINDOW, accounts: [{ ...account("dock"), current: null, beforeToday: null, today: null, error: "pace.json: missing" }], gaps: ["pace.json: missing"] };
    renderPage(answering({}, successEnvelope(missing), successEnvelope(CARDS)), "#/coordinator");

    const gap = await screen.findByTestId("coord-pools-gap");
    expect(gap.textContent).toContain("agent-chat's pace.json could not be read, so no account shows its current use, glide target or level.");
    expect(within(screen.getByTestId("coord-meter-dock")).getByText("pace.json: missing")).toBeTruthy();
    expect(screen.queryByTestId("coord-meter-today-dock")).toBeNull();
  });

  it("says why every PR is unattributed when events.db cannot be read", async () => {
    const unreadable: Cards = { date: DATE, cards: [], unattributed: [pr("harbor/dock", 7, "HB-7")], gaps: ["agent-chat events.db: not readable, so no agent is counted and every PR is unattributed"] };
    renderPage(answering({}, successEnvelope(POOLS), successEnvelope(unreadable)), "#/coordinator");

    expect((await screen.findByTestId("coord-cards-gap")).textContent).toContain("events.db: not readable");
    expect(within(screen.getByTestId("coord-card-unattributed")).getByTestId("coord-pr-harbor/dock#7")).toBeTruthy();
  });

  it("says no coordinator worked the day when there are no cards and no PRs", async () => {
    renderPage(answering({}, successEnvelope(POOLS), successEnvelope({ date: DATE, cards: [], unattributed: [], gaps: [] })), "#/coordinator");

    expect((await screen.findByTestId("coord-cards-empty")).textContent).toBe("No coordinator spawned an agent this day, and Shepherd merged no PR in it.");
  });
});
