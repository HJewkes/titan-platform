// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope, type JsonEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { href } from "./router.js";
import { renderPage } from "./render-page.test-helpers.js";
import { findTapSheet } from "./tap-sheet.test-helpers.js";

const NOW = Date.parse("2031-03-05T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const HEAD = "0b7e2c1a5d4f4e8b9a1c3d5e7f9b0a2c4e6d8f01";

const GATE_ID = "gate:0f1e2d3c-4b5a-4968-8776-655443322110/approve-merge";
const DEPOSIT_ID = `deposit:${"a1".repeat(16)}`;
const ROUND_ID = "round:ship-tile-r1";
const AGED_ID = `deposit:${"b2".repeat(16)}`;
const PLAN_ID = "task:orbit/OR-3";

function item(id: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return { id, sources: [{ system: "hitl", ref: id }], kind: "approve", door: "one-way", summary: `Summary of ${id}`, context: "", keys: [], personal: false, lens: "blocking-merge", unblocks: [], openedAt: ago(HOUR), status: "open", section: "blocking", action: { kind: "terminal", reason: "fixture" }, ...overrides };
}

const GATE = item(GATE_ID, {
  summary: "Merge example/repo#12",
  action: { kind: "resolve-gate", gateId: "0f1e2d3c-4b5a-4968-8776-655443322110/approve-merge", runId: "0f1e2d3c-4b5a-4968-8776-655443322110", stepId: "approve-merge", repo: "example/repo", pr: 12, headSha: HEAD, decision: "merge" },
});
const deposit = (id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  item(id, { sources: [{ system: "deposit", ref: id }], kind: "do", summary: "Publish the new package by hand", command: "pnpm publish --access public", action: { kind: "terminal", command: "pnpm publish --access public", reason: "run its command" }, ...overrides });
const ROUND = item(ROUND_ID, { sources: [{ system: "round", ref: "ship-tile-r1" }], kind: "review", summary: "Ship tile frames", evidence: "#/rounds/ship-tile-r1", action: { kind: "open-round", roundId: "ship-tile-r1" } });
const PLAN = item(PLAN_ID, { sources: [{ system: "active-work", ref: "orbit/OR-3" }], kind: "decide", lens: "planning", section: "planning", summary: "Plan OR-3", action: { kind: "open", route: "#/tasks/OR-3" } });
const ITEMS = [GATE, deposit(DEPOSIT_ID), ROUND, deposit(AGED_ID, { summary: "An aged deposit", openedAt: ago(5 * 24 * HOUR), aged: true }), PLAN];

const isPlanning = (each: Record<string, unknown>): boolean => each.section === "planning";

/** As the server answers: planning items counted, and listed only on the planning read a link makes. */
const inboxAnswer = (gaps: string[] = [], planning = true): JsonEnvelope<unknown> =>
  successEnvelope({ items: planning ? ITEMS : ITEMS.filter((each) => !isPlanning(each)), planningCount: ITEMS.filter(isPlanning).length, gaps, fyiCount: 0, readAt: new Date(NOW).toISOString(), derived: [] });

interface Call {
  name: string;
  args: unknown;
}

/** Opens `#/inbox/<id>` as a phone's link would, live so the gate's tap reaches `inbox.prepare`. */
function openLink(id: string | undefined, answer: JsonEnvelope<unknown> = inboxAnswer(), { inApp = false } = {}): Call[] {
  const snapshot: Snapshot = { format: SNAPSHOT_FORMAT, createdAt: new Date(NOW).toISOString(), calls: { [snapshotKey("inbox.list", {})]: inboxAnswer([], false), [snapshotKey("inbox.list", { planning: true })]: answer } };
  const inner = pageDataSource({ doc: new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html") });
  const calls: Call[] = [];
  const prepare = (): Promise<JsonEnvelope<unknown>> => Promise.resolve(successEnvelope({ status: "refused", message: "fixture" }));
  const source: DataSource = { subscribe: inner.subscribe.bind(inner), call: (name, args, options) => (calls.push({ name, args }), name === "inbox.prepare" ? prepare() : inner.call(name, args, options)) };
  renderPage(source, href(id === undefined ? { view: "inbox" } : { view: "inbox", id }), { answers: source, inApp });
  return calls;
}

let scrolled: Element[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  scrolled = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const badges = (): string[] => screen.queryAllByTestId("inbox-focus-badge").map((badge) => badge.closest("[data-testid^='inbox-row-']")?.getAttribute("data-testid") ?? "");

/** The row is marked, is the only one marked, and is the one the page scrolled to. */
async function expectFocused(id: string): Promise<HTMLElement> {
  const row = await screen.findByTestId(`inbox-row-${id}`);
  expect(badges()).toEqual([`inbox-row-${id}`]);
  await waitFor(() => expect(scrolled.some((element) => element.contains(row))).toBe(true));
  expect(scrolled).toHaveLength(1);
  expect(screen.queryByTestId("inbox-focus-missing")).toBeNull();
  return row;
}

describe("an inbox deep link", () => {
  it("focuses a gate and its Approve merge tap prepares that gate", async () => {
    const calls = openLink(GATE_ID);
    const row = await expectFocused(GATE_ID);
    fireEvent.click(within(row).getByText("Approve merge"));
    await findTapSheet("inbox-confirm");
    expect(calls.filter((call) => call.name === "inbox.prepare").map((call) => call.args)).toEqual([{ itemId: GATE_ID }]);
  });

  it("focuses a deposit and its Run on terminal tap shows the command", async () => {
    openLink(DEPOSIT_ID);
    const row = await expectFocused(DEPOSIT_ID);
    fireEvent.click(within(row).getByText("Run on terminal"));
    expect(within(row).getAllByText("pnpm publish --access public").length).toBeGreaterThan(0);
  });

  it("focuses a round and its evidence link opens the round", async () => {
    openLink(ROUND_ID, inboxAnswer(), { inApp: true });
    const row = await expectFocused(ROUND_ID);
    fireEvent.click(within(row).getByText("Open evidence"));
    expect(window.location.hash).toBe("#/rounds/ship-tile-r1");
  });

  it("focuses an item listed under Older than 4 days", async () => {
    openLink(AGED_ID);
    const row = await expectFocused(AGED_ID);
    expect(within(screen.getByTestId("inbox-blocking-aged")).getByTestId(`inbox-row-${AGED_ID}`)).toBe(row);
  });

  it("opens the collapsed Planning section when the item sits there", async () => {
    openLink(PLAN_ID);
    const row = await expectFocused(PLAN_ID);
    expect(within(screen.getByTestId("inbox-planning")).getByTestId(`inbox-row-${PLAN_ID}`)).toBe(row);
    expect(screen.getByText("Hide planning")).toBeTruthy();
  });

  it("keeps Planning collapsed when the linked item is not in it", async () => {
    openLink(GATE_ID);
    await expectFocused(GATE_ID);
    expect(screen.queryByTestId(`inbox-row-${PLAN_ID}`)).toBeNull();
  });

  it("says an unknown or answered id is no longer open, and marks no row", async () => {
    openLink("gate:00000000-0000-4000-8000-000000000000/approve-merge");
    const notice = await screen.findByTestId("inbox-focus-missing");
    expect(notice.textContent).toContain("This item is no longer open: it was answered or withdrawn.");
    expect(notice.textContent).toContain("gate:00000000-0000-4000-8000-000000000000/approve-merge");
    expect(badges()).toEqual([]);
    expect(scrolled).toEqual([]);
    expect(screen.getByTestId(`inbox-row-${GATE_ID}`)).toBeTruthy();
  });

  it("allows that an unread source may hide the item", async () => {
    openLink("round:gone-r1", inboxAnswer(["rounds: unreadable"]));
    expect((await screen.findByTestId("inbox-focus-missing")).textContent).toContain("or its source is unreadable right now");
  });

  it("leaves the plain inbox unmarked, with no notice", async () => {
    openLink(undefined);
    await screen.findByTestId(`inbox-row-${GATE_ID}`);
    expect(badges()).toEqual([]);
    expect(scrolled).toEqual([]);
    expect(screen.queryByTestId("inbox-focus-missing")).toBeNull();
  });
});
