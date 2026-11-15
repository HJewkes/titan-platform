// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import { href } from "./router.js";
import { renderPage } from "./render-page.test-helpers.js";

const NOW = Date.parse("2031-03-05T12:00:00.000Z");

function plan(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `task:${id}`, sources: [{ system: "active-work", ref: id }], kind: "decide", door: "two-way", summary: `Plan ${id}`, context: "", keys: [], personal: false,
    lens: "planning", unblocks: [], openedAt: new Date(NOW - 3_600_000).toISOString(), status: "open", section: "planning", action: { kind: "open", route: `#/tasks/${id}` }, ...overrides,
  };
}

const ALPHA = ["a1", "a2", "a3"].map((id) => plan(id, { asker: "alpha-seat" }));
const GAMMA = ["g1", "g2"].map((id) => plan(id, { seat: "gamma-seat" }));
const BETA = plan("b1", { asker: "beta-seat", seat: "ignored-seat" });
const UNASKED = plan("u1");
const MIXED = [BETA, UNASKED, ...GAMMA, ...ALPHA];

function openInbox(planning: Record<string, unknown>[], focusId?: string): void {
  const answer = (items: Record<string, unknown>[]) => successEnvelope({ items, planningCount: planning.length, gaps: [], fyiCount: 0, readAt: new Date(NOW).toISOString(), derived: [] });
  const snapshot: Snapshot = { format: SNAPSHOT_FORMAT, createdAt: new Date(NOW).toISOString(), calls: { [snapshotKey("inbox.list", {})]: answer([]), [snapshotKey("inbox.list", { planning: true })]: answer(planning) } };
  const source = pageDataSource({ doc: new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html") });
  renderPage(source, href(focusId === undefined ? { view: "inbox" } : { view: "inbox", id: focusId }), { answers: source });
}

const openPlanning = async (): Promise<void> => {
  fireEvent.click(await screen.findByText(/^Show \d+ planning items$/));
};
const headers = (): string[] => screen.queryAllByTestId(/^inbox-planning-group-/).map((header) => header.textContent);
const rowIds = (): string[] => screen.queryAllByTestId(/^inbox-row-/).map((row) => row.getAttribute("data-testid") ?? "");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the inbox planning list grouped by asker", () => {
  it("lists the largest group first, each header carrying its count, ties in first-seen order", async () => {
    openInbox(MIXED);
    await openPlanning();
    await waitFor(() => expect(headers()).toHaveLength(4));
    expect(headers()).toEqual(["alpha-seat (3)", "gamma-seat (2)", "beta-seat (1)", "task (1)"]);
  });

  it("keys an item with neither asker nor seat by its source badge label", async () => {
    openInbox([UNASKED, ...ALPHA]);
    await openPlanning();
    await waitFor(() => expect(headers()).toContain("task (1)"));
  });

  it("keeps every group closed until its header is pressed", async () => {
    openInbox(MIXED);
    await openPlanning();
    await screen.findByText("alpha-seat (3)");
    expect(rowIds()).toEqual([]);
    fireEvent.click(screen.getByText("gamma-seat (2)"));
    expect(rowIds()).toEqual(["inbox-row-task:g1", "inbox-row-task:g2"]);
    fireEvent.click(screen.getByText("gamma-seat (2)"));
    expect(rowIds()).toEqual([]);
  });

  it("opens only the group holding the linked item", async () => {
    openInbox(MIXED, "task:b1");
    await screen.findByTestId("inbox-row-task:b1");
    expect(rowIds()).toEqual(["inbox-row-task:b1"]);
    expect(headers()).toHaveLength(4);
  });

  it("renders a single group with no header", async () => {
    openInbox(ALPHA);
    await openPlanning();
    await screen.findByTestId("inbox-row-task:a1");
    expect(headers()).toEqual([]);
    expect(rowIds()).toHaveLength(3);
  });
});
