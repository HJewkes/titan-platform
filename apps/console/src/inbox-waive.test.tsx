// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope, type JsonEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { App } from "./App.js";
import { AnswerSourceProvider } from "./data/submit.js";
import { findTapSheet } from "./tap-sheet.test-helpers.js";

const NOW = Date.parse("2031-03-05T12:00:00.000Z");
const HEAD = "0b7e2c1a5d4f4e8b9a1c3d5e7f9b0a2c4e6d8f01";
const CONFIRM = "c".repeat(64);
const EFFECT = "Skip the fix-proof requirement for example/repo#12 at 0b7e2c1 only";

const ACTION = { kind: "resolve-gate", gateId: "run-gate-1/sh-sent-back", runId: "run-gate-1", stepId: "sh-sent-back", repo: "example/repo", pr: 12, headSha: HEAD, decision: "await-new-head", alternatives: ["waive-proof"] };

const SENT_BACK = {
  id: "gate-1",
  sources: [{ system: "hitl", ref: "run-gate-1/sh-sent-back" }],
  kind: "approve",
  door: "one-way",
  summary: "Merge example/repo#12",
  context: "",
  keys: [],
  personal: false,
  lens: "blocking-merge",
  unblocks: [],
  openedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
  status: "open",
  section: "blocking",
  evidence: "https://github.com/example/repo/pull/12",
  action: ACTION,
};

interface Call {
  name: string;
  args: unknown;
}

function renderInbox(taps: Record<string, () => Promise<JsonEnvelope<unknown>>>): Call[] {
  const answer = successEnvelope({ items: [SENT_BACK], gaps: [], fyiCount: 0, readAt: new Date(NOW).toISOString(), derived: [] });
  const snapshot: Snapshot = { format: SNAPSHOT_FORMAT, createdAt: new Date(NOW).toISOString(), calls: { [snapshotKey("inbox.list", {})]: answer } };
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html");
  const inner = pageDataSource({ doc: page });
  const calls: Call[] = [];
  const source: DataSource = {
    subscribe: inner.subscribe.bind(inner),
    call: (name, args, options) => (calls.push({ name, args }), taps[name] ? taps[name]() : inner.call(name, args, options)),
  };
  window.location.hash = "#/inbox";
  render(
    <RpcProvider source={source}>
      <AnswerSourceProvider value={source}>
        <App />
      </AnswerSourceProvider>
    </RpcProvider>,
  );
  return calls;
}

const ready = (): Promise<JsonEnvelope<unknown>> =>
  Promise.resolve(
    successEnvelope({
      status: "ready",
      itemId: "gate-1",
      action: { ...ACTION, decision: "waive-proof" },
      readBack: { repo: "example/repo", pr: 12, title: "Merge example/repo#12", headSha: HEAD, gateId: ACTION.gateId, effect: EFFECT },
      readAt: new Date(NOW - 12_000).toISOString(),
      confirm: CONFIRM,
      expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
    }),
  );

const resolved = (): Promise<JsonEnvelope<unknown>> => Promise.resolve(successEnvelope({ actionId: CONFIRM, outcome: { status: "resolved" }, message: "Fix-proof waived at this head; nothing merged" }));

const argsOf = (calls: readonly Call[], name: string): unknown[] => calls.filter((call) => call.name === name).map((call) => call.args);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the inbox page on a waivable sent-back gate", () => {
  it("offers Waive fix-proof as a second tap beside Wait for new head, and prepares and acts with that decision", async () => {
    const calls = renderInbox({ "inbox.prepare": ready, "inbox.act": resolved });
    const row = await screen.findByTestId("inbox-row-gate-1");
    expect(within(row).getByText("Wait for new head")).toBeTruthy();

    fireEvent.click(within(row).getByText("Waive fix-proof"));
    const sheet = await findTapSheet("inbox-confirm");
    expect(within(sheet).getByText(EFFECT)).toBeTruthy();
    await act(async () => void fireEvent.click(within(sheet).getByTestId("inbox-confirm-ok")));

    expect(argsOf(calls, "inbox.prepare")).toEqual([{ itemId: "gate-1", decision: "waive-proof" }]);
    await waitFor(() => expect(argsOf(calls, "inbox.act")).toEqual([{ itemId: "gate-1", decision: "waive-proof", confirm: CONFIRM }]));
  });
});
