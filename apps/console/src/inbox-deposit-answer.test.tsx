// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope, type JsonEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { renderPage } from "./render-page.test-helpers.js";
import { findTapSheet } from "./tap-sheet.test-helpers.js";

const NOW = "2031-03-05T12:00:00.000Z";
const CONFIRM = "d".repeat(64);

const depositItem = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  sources: [{ system: "deposit", ref: id }],
  kind: "decide",
  door: "two-way",
  summary: "Which video should the daily digest feature?",
  context: "Two candidates tied on score.",
  keys: [],
  personal: false,
  lens: "blocking-agent",
  unblocks: [],
  openedAt: NOW,
  status: "open",
  section: "blocking",
  action: { kind: "answer-deposit" },
  ...extra,
});

const PICKS = depositItem("dep-picks", {
  options: [
    { id: "first", label: "The first video" },
    { id: "second", label: "The second video" },
  ],
});
const OPEN = depositItem("dep-open");

const readBackOf = (item: Record<string, unknown>): Record<string, unknown> => ({
  title: item["summary"],
  question: item["context"],
  ...(item["options"] !== undefined && { options: item["options"] }),
  effect: "Answer the agent's question; the answer is filed beside the deposit, where the agent reads it",
});

interface Call {
  name: string;
  args: unknown;
}

function renderDeposit(item: Record<string, unknown>): Call[] {
  const list = successEnvelope({ items: [item], gaps: [], fyiCount: 0, readAt: NOW, derived: [] });
  const snapshot: Snapshot = { format: SNAPSHOT_FORMAT, createdAt: NOW, calls: { [snapshotKey("inbox.list", {})]: list } };
  const inner = pageDataSource({ doc: new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html") });
  const ready = successEnvelope({ status: "ready", itemId: item["id"], action: item["action"], readBack: readBackOf(item), readAt: NOW, confirm: CONFIRM, expiresAt: NOW });
  const taps: Record<string, () => Promise<JsonEnvelope<unknown>>> = {
    "inbox.prepare": () => Promise.resolve(ready),
    "inbox.act": () => Promise.resolve(successEnvelope({ actionId: CONFIRM, outcome: { status: "answered" }, message: "Answer sent" })),
  };
  const calls: Call[] = [];
  const source: DataSource = {
    subscribe: inner.subscribe.bind(inner),
    call: (name, args, options) => (calls.push({ name, args }), taps[name] ? taps[name]() : inner.call(name, args, options)),
  };
  renderPage(source, "#/inbox", { answers: source, inApp: false });
  return calls;
}

const actArgs = (calls: readonly Call[]): unknown[] => calls.filter((call) => call.name === "inbox.act").map((call) => call.args);

afterEach(() => {
  cleanup();
});

describe("the inbox page, answering a plain deposit", () => {
  it("shows Answer on the row, not Run on terminal", async () => {
    renderDeposit(PICKS);

    const row = await screen.findByTestId("inbox-row-dep-picks");

    expect(within(row).getByText("Answer")).toBeTruthy();
    expect(within(row).queryByText("Run on terminal")).toBeNull();
  });

  it("submits the option the owner picks", async () => {
    const calls = renderDeposit(PICKS);
    fireEvent.click(within(await screen.findByTestId("inbox-row-dep-picks")).getByText("Answer"));
    const sheet = await findTapSheet("inbox-confirm");

    fireEvent.click(within(sheet).getByText("The second video"));

    expect(await within(sheet).findByTestId("inbox-confirm-outcome")).toBeTruthy();
    expect(actArgs(calls)).toEqual([{ itemId: "dep-picks", optionId: "second", confirm: CONFIRM }]);
  });

  it("submits the free text the owner types", async () => {
    const calls = renderDeposit(OPEN);
    fireEvent.click(within(await screen.findByTestId("inbox-row-dep-open")).getByText("Answer"));
    const sheet = await findTapSheet("inbox-confirm");

    fireEvent.change(within(sheet).getByLabelText("Your answer"), { target: { value: "Feature neither video" } });
    fireEvent.click(within(sheet).getByText("Send answer"));

    expect(await within(sheet).findByTestId("inbox-confirm-outcome")).toBeTruthy();
    expect(actArgs(calls)).toEqual([{ itemId: "dep-open", text: "Feature neither video", confirm: CONFIRM }]);
  });
});
