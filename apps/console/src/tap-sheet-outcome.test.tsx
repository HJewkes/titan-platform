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
const OP = { kind: "plan-bet-select", initiative: "alpha", week: "2031-W10", bets: ["alpha/B1"] };

const item = {
  id: "plan-1", sources: [{ system: "deposit", ref: "fixture-planner/plan-1" }], kind: "do", door: "one-way", summary: "Planning item plan-1", context: "", keys: [],
  personal: false, lens: "blocking-agent", unblocks: [], openedAt: new Date(NOW - 3_600_000).toISOString(), status: "open", section: "blocking", action: { kind: "owner-op", op: OP },
};
const prepared = successEnvelope({
  status: "ready", itemId: item.id, action: item.action, readAt: new Date(NOW).toISOString(), confirm: CONFIRM, expiresAt: new Date(NOW + 300_000).toISOString(),
  readBack: { planOp: "bet-select", initiative: "alpha", week: "2031-W10", bets: [], effect: "Select alpha/B1", authority: "HV-OR: gate", proposedBy: "fixture-planner", proposal: "Fixture planning proposal" },
});

/** The inbox over one planning item, whose act answers with the given outcome status. */
function renderActing(status: string): void {
  const list = successEnvelope({ items: [item], planningCount: 0, gaps: [], fyiCount: 0, readAt: new Date(NOW).toISOString(), derived: [] });
  const snapshot: Snapshot = { format: SNAPSHOT_FORMAT, createdAt: new Date(NOW).toISOString(), calls: { [snapshotKey("inbox.list", {})]: list } };
  const inner = pageDataSource({ doc: new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html") });
  const taps: Record<string, () => Promise<JsonEnvelope<unknown>>> = {
    "inbox.prepare": () => Promise.resolve(prepared),
    "inbox.act": () => Promise.resolve(successEnvelope({ actionId: CONFIRM, outcome: { status }, message: `Outcome ${status}` })),
  };
  const source: DataSource = { subscribe: inner.subscribe.bind(inner), call: (name, args, options) => taps[name]?.() ?? inner.call(name, args, options) };
  renderPage(source, "#/inbox", { answers: source, inApp: false });
}

async function outcomeAfterConfirm(status: string): Promise<HTMLElement> {
  renderActing(status);
  fireEvent.click(within(await screen.findByTestId("inbox-row-plan-1")).getByText("Select bets"));
  await findTapSheet("inbox-confirm");
  await act(async () => void fireEvent.click(screen.getByTestId("inbox-confirm-ok")));
  return screen.getByTestId("inbox-confirm-outcome");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the tap sheet outcome alert", () => {
  it.each(["plan-applied", "plan-approved", "answered", "resolved"])("shows a landed %s outcome as success", async (status) => {
    expect((await outcomeAfterConfirm(status)).outerHTML).toMatch(/success/);
  });

  it.each(["moved", "gone", "refused", "closed", "unreachable"])("shows a %s outcome as a warning", async (status) => {
    const alert = await outcomeAfterConfirm(status);
    expect(alert.outerHTML).toMatch(/warning/);
    expect(alert.outerHTML).not.toMatch(/success/);
  });
});
