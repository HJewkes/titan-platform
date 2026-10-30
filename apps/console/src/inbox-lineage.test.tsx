// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope, type JsonEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { renderPage } from "./render-page.test-helpers.js";

const NOW = "2031-03-05T12:00:00.000Z";
const HEAD = "0b7e2c1a5d4f4e8b9a1c3d5e7f9b0a2c4e6d8f01";
const CONFIRM = "c".repeat(64);
const LINEAGE_TEXT = "proven at 0b7e2c1UNMERGEDmain 11111113 behind";

const LINEAGE = { known: true, provenSha: HEAD, state: "open", merged: false, mergeSha: null, headSha: HEAD, baseRef: "main", baseSha: "1".repeat(40), behind: 3 };

const mergeGate = (lineage?: Record<string, unknown>): Record<string, unknown> => ({
  id: "gate-1",
  sources: [{ system: "hitl", ref: "run-gate-1/approve-merge" }],
  kind: "approve",
  door: "one-way",
  summary: "Merge example/repo#12",
  context: "",
  keys: [],
  personal: false,
  lens: "blocking-merge",
  unblocks: [],
  openedAt: NOW,
  status: "open",
  section: "blocking",
  action: { kind: "resolve-gate", gateId: "run-gate-1/approve-merge", runId: "run-gate-1", stepId: "approve-merge", repo: "example/repo", pr: 12, headSha: HEAD, decision: "merge" },
  ...(lineage && { lineage }),
});

const ready = (): Promise<JsonEnvelope<unknown>> =>
  Promise.resolve(
    successEnvelope({
      status: "ready",
      itemId: "gate-1",
      action: mergeGate()["action"],
      readBack: { repo: "example/repo", pr: 12, title: "Merge example/repo#12", headSha: HEAD, gateId: "run-gate-1/approve-merge", effect: "Merge example/repo#12 at 0b7e2c1" },
      readAt: NOW,
      confirm: CONFIRM,
      expiresAt: NOW,
    }),
  );

function renderInbox(item: Record<string, unknown>): void {
  const list = successEnvelope({ items: [item], gaps: [], fyiCount: 0, readAt: NOW, derived: [] });
  const snapshot: Snapshot = { format: SNAPSHOT_FORMAT, createdAt: NOW, calls: { [snapshotKey("inbox.list", {})]: list } };
  const inner = pageDataSource({ doc: new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html") });
  const source: DataSource = { subscribe: inner.subscribe.bind(inner), call: (name, args, options) => (name === "inbox.prepare" ? ready() : inner.call(name, args, options)) };
  renderPage(source, "#/inbox", { answers: source });
}

afterEach(() => {
  cleanup();
});

describe("the inbox page's Approve merge rows", () => {
  it("an Approve merge row whose head is 3 behind main shows the lineage line with 3 behind", async () => {
    renderInbox(mergeGate(LINEAGE));
    const row = await screen.findByTestId("inbox-row-gate-1");
    expect(within(row).getByTestId("ship-lineage").textContent).toBe(LINEAGE_TEXT);
    expect(within(row).getByTestId("ship-lineage").getAttribute("data-state")).toBe("stale");
  });

  it("the confirm sheet shows the same lineage line", async () => {
    renderInbox(mergeGate(LINEAGE));
    fireEvent.click(within(await screen.findByTestId("inbox-row-gate-1")).getByText("Approve merge"));
    const sheet = await screen.findByTestId("inbox-confirm");
    expect(within(sheet).getByTestId("ship-lineage").textContent).toBe(LINEAGE_TEXT);
  });

  it("a gate with no lineage shows lineage unknown", async () => {
    renderInbox(mergeGate());
    const row = await screen.findByTestId("inbox-row-gate-1");
    expect(within(row).getByTestId("ship-lineage").getAttribute("data-state")).toBe("unknown");
    expect(within(row).getByText("lineage unknown")).toBeTruthy();
  });
});
