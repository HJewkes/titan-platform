// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope, type JsonEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { renderPage } from "./render-page.test-helpers.js";
import { findTapSheet } from "./tap-sheet.test-helpers.js";

const NOW = Date.parse("2031-03-05T12:00:00.000Z");
const HEAD = "0b7e2c1a5d4f4e8b9a1c3d5e7f9b0a2c4e6d8f01";
const CONFIRM = "c".repeat(64);

const g10Row = (holdClass: string): Record<string, unknown> => ({
  id: "g10-1",
  sources: [{ system: "hitl", ref: "run-g10-1/approve-merge" }],
  kind: "approve",
  door: "one-way",
  summary: "Merge example/repo#20",
  context: "",
  keys: [],
  personal: false,
  lens: "blocking-merge",
  unblocks: [],
  openedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
  status: "open",
  section: "blocking",
  hold: { class: holdClass, reason: `${holdClass}: waiting` },
  action: { kind: "hold-release", repo: "example/repo", pr: 20, headSha: HEAD, holdClass },
});

interface Call {
  name: string;
  args: unknown;
}

function renderInbox(row: Record<string, unknown>, taps: Record<string, (args: unknown) => Promise<JsonEnvelope<unknown>>>): Call[] {
  const answer = successEnvelope({ items: [row], planningCount: 0, gaps: [], fyiCount: 0, readAt: new Date(NOW).toISOString(), derived: [] });
  const snapshot: Snapshot = { format: SNAPSHOT_FORMAT, createdAt: new Date(NOW).toISOString(), calls: { [snapshotKey("inbox.list", {})]: answer } };
  const inner = pageDataSource({ doc: new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html") });
  const calls: Call[] = [];
  const source: DataSource = {
    subscribe: inner.subscribe.bind(inner),
    call: (name, args, options) => (calls.push({ name, args }), taps[name] ? taps[name](args) : inner.call(name, args, options)),
  };
  renderPage(source, "#/inbox", { answers: source });
  return calls;
}

const prepared = (row: Record<string, unknown>): Promise<JsonEnvelope<unknown>> =>
  Promise.resolve(
    successEnvelope({
      status: "ready",
      itemId: "g10-1",
      action: row.action,
      readBack: { repo: "example/repo", pr: 20, title: "add the widget cache", headSha: HEAD, hold: row.hold, effect: "Release the hold on example/repo#20 at 0b7e2c1" },
      readAt: new Date(NOW - 12_000).toISOString(),
      confirm: CONFIRM,
      expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
    }),
  );

const released = (): Promise<JsonEnvelope<unknown>> => Promise.resolve(successEnvelope({ actionId: CONFIRM, outcome: { status: "released" }, message: "Hold released" }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the inbox page, a g10 hold-release row", () => {
  it.each(["g10-review", "g10-adversary"])("offers Release hold and no terminal run on a %s hold, and a released act shows success", async (holdClass) => {
    const row = g10Row(holdClass);
    const calls = renderInbox(row, { "inbox.prepare": () => prepared(row), "inbox.act": released });
    const card = await screen.findByTestId("inbox-row-g10-1");
    expect(within(card).queryByText("Run on terminal")).toBeNull();
    fireEvent.click(within(card).getByText("Release hold"));
    await findTapSheet("inbox-confirm");
    await act(async () => void fireEvent.click(screen.getByTestId("inbox-confirm-ok")));
    const outcome = screen.getByTestId("inbox-confirm-outcome");
    expect(outcome.textContent).toContain("Hold released");
    expect(outcome.className).toContain("success");
    expect(calls.filter((call) => call.name === "inbox.prepare").map((call) => call.args)).toEqual([{ itemId: "g10-1" }]);
    expect(calls.filter((call) => call.name === "inbox.act").map((call) => call.args)).toEqual([{ itemId: "g10-1", confirm: CONFIRM }]);
  });

  it("keeps Run on terminal and the release command on a manual hold", async () => {
    renderInbox(g10Row("manual"), {});
    const card = await screen.findByTestId("inbox-row-g10-1");
    expect(within(card).queryByText("Release hold")).toBeNull();
    fireEvent.click(within(card).getByText("Run on terminal"));
    expect(within(card).getByText(`titan-factory shepherd release example/repo#20 --head ${HEAD} --class manual`)).toBeTruthy();
  });
});
