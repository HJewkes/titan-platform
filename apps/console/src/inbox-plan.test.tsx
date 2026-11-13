// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope, type JsonEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { renderPage } from "./render-page.test-helpers.js";
import { findTapSheet } from "./tap-sheet.test-helpers.js";

const NOW = Date.parse("2031-03-05T12:00:00.000Z");
const CONFIRM = "c".repeat(64);
const PROPOSED = { authority: "HV-OR: gate", proposedBy: "fixture-planner", proposal: "Fixture planning proposal" };

function planItem(id: string, op: Record<string, unknown>): Record<string, unknown> {
  return {
    id, sources: [{ system: "deposit", ref: `fixture-planner/${id}` }], kind: "do", door: "one-way", summary: `Planning item ${id}`, context: "", keys: [],
    personal: false, lens: "blocking-agent", unblocks: [], openedAt: new Date(NOW - 3_600_000).toISOString(), status: "open", section: "blocking", action: { kind: "owner-op", op },
  };
}

const ready = (item: Record<string, unknown>, readBack: Record<string, unknown>): JsonEnvelope<unknown> =>
  successEnvelope({ status: "ready", itemId: item.id, action: item.action, readBack: { ...PROPOSED, ...readBack }, readAt: new Date(NOW).toISOString(), confirm: CONFIRM, expiresAt: new Date(NOW + 300_000).toISOString() });

/** The inbox over a recorded list of one item, live, with its prepare and act answered as given. */
function renderPlanItem(item: Record<string, unknown>, readBack: Record<string, unknown>, landed: Record<string, unknown>): void {
  const list = successEnvelope({ items: [item], planningCount: 0, gaps: [], fyiCount: 0, readAt: new Date(NOW).toISOString(), derived: [] });
  const snapshot: Snapshot = { format: SNAPSHOT_FORMAT, createdAt: new Date(NOW).toISOString(), calls: { [snapshotKey("inbox.list", {})]: list } };
  const inner = pageDataSource({ doc: new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html") });
  const taps: Record<string, () => Promise<JsonEnvelope<unknown>>> = { "inbox.prepare": () => Promise.resolve(ready(item, readBack)), "inbox.act": () => Promise.resolve(successEnvelope(landed)) };
  const source: DataSource = { subscribe: inner.subscribe.bind(inner), call: (name, args, options) => taps[name]?.() ?? inner.call(name, args, options) };
  renderPage(source, "#/inbox", { answers: source, inApp: false });
}

async function openSheet(itemId: string, verb: string): Promise<HTMLElement> {
  fireEvent.click(within(await screen.findByTestId(`inbox-row-${itemId}`)).getByText(verb));
  return findTapSheet("inbox-confirm");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const prediction = { metric: "handshake_pages_per_week", direction: "decrease", baseline: 6, expected: 1, read_by: "2031-03-14" };

describe("the inbox's planning taps", () => {
  it("reads each bet back with its outcome, prediction and tasks, then shows the selection as landed", async () => {
    const op = { kind: "plan-bet-select", initiative: "alpha", week: "2031-W10", bets: ["alpha/B1"] };
    const bet = { id: "alpha/B1", order: 1, outcome: "alpha/steady-relay", outcomeStatement: "A dropped handshake recovers without a page", state: "proposed", tasks: ["alpha/AL-12"], selector: null, prediction };
    const effect = "Select alpha/B1 as your bets for 2031-W10; agents plan the week from selected bets only";
    renderPlanItem(planItem("plan-1", op), { planOp: "bet-select", initiative: "alpha", week: "2031-W10", bets: [bet], effect }, { actionId: CONFIRM, outcome: { status: "plan-applied", op: op.kind, ids: op.bets }, message: "Selected alpha/B1; plan bet list --week now returns them" });

    const sheet = await openSheet("plan-1", "Select bets");

    expect(within(sheet).getByText(effect)).toBeTruthy();
    expect(within(sheet).getByText("alpha/B1 (rank 1) for alpha/steady-relay")).toBeTruthy();
    expect(within(sheet).getByText("Outcome: A dropped handshake recovers without a page")).toBeTruthy();
    expect(within(sheet).getByText("handshake_pages_per_week: decrease from 6 to 1, read by 2031-03-14")).toBeTruthy();
    expect(within(sheet).getByText("Tasks alpha/AL-12")).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByTestId("inbox-confirm-ok")));
    expect(screen.getByTestId("inbox-confirm-outcome").textContent).toContain("Selected alpha/B1; plan bet list --week now returns them");
  });

  it("reads an outcome edit back as the field now and what it becomes, leaving an unchanged field out", async () => {
    const op = { kind: "plan-outcome-edit", outcome: "alpha/steady-relay", to: { measure: "recoveries per 1,000 drops" } };
    const before = { statement: "A dropped handshake recovers", measure: "pages per week" };
    renderPlanItem(planItem("plan-2", op), { planOp: "outcome-edit", outcomeId: op.outcome, before, after: { ...before, ...op.to }, effect: "Replace the measure of alpha/steady-relay" }, { actionId: CONFIRM, outcome: { status: "plan-applied", op: op.kind, ids: [op.outcome] }, message: "Outcome alpha/steady-relay updated" });

    const sheet = await openSheet("plan-2", "Edit outcome");

    expect(within(sheet).getByText("Measure now: pages per week")).toBeTruthy();
    expect(within(sheet).getByText("Becomes: recoveries per 1,000 drops")).toBeTruthy();
    expect(within(sheet).queryByText(/^Statement now/)).toBeNull();
  });

  it("reads a freeze back as what it stops, why, and when it ends", async () => {
    const op = { kind: "plan-freeze-set", initiative: "alpha", freeze: { action: "set", tag: "upkeep", reason: "Upkeep waits", end_condition: { kind: "owner" }, intent_ref: "D13", quote_ref: "msg:0f9e8d" } };
    const readBack = { planOp: "freeze", action: "set", initiative: "alpha", freezeId: null, stops: "tasks tagged upkeep", reason: "Upkeep waits", ends: "when you end it", effect: "Freeze tasks tagged upkeep in alpha as yours; it ends when you end it" };
    renderPlanItem(planItem("plan-3", op), readBack, { actionId: CONFIRM, outcome: { status: "plan-applied", op: op.kind, ids: ["alpha/F1"] }, message: "Freeze alpha/F1 written as yours" });

    const sheet = await openSheet("plan-3", "Set freeze");

    expect(within(sheet).getByText("Stops tasks tagged upkeep in alpha")).toBeTruthy();
    expect(within(sheet).getByText("Why: Upkeep waits")).toBeTruthy();
    expect(within(sheet).getByText("Ends when you end it")).toBeTruthy();
    expect(within(sheet).getByText("Proposed by fixture-planner: Fixture planning proposal")).toBeTruthy();
  });
});
