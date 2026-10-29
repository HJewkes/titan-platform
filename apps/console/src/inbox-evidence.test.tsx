// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope, type JsonEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { App } from "./App.js";
import { AnswerSourceProvider } from "./data/submit.js";

/** TP-4404: the confirm sheet of an owner-at-head merge gate carries the evidence the factory read; all text is synthetic. */
const NOW = Date.parse("2031-03-05T12:00:00.000Z");
const HEAD = "0b7e2c1a5d4f4e8b9a1c3d5e7f9b0a2c4e6d8f01";
const BASE = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const CONFIRM = "c".repeat(64);
const RATIONALE = "The synthetic job is no longer required, so I record other.";
/** One row longer than any line cap a renderer might apply, ending in a distinct tail. */
const LONG_ROW = `${"x".repeat(290)}TAIL-MARK\\u{A}`;

const ACTION = { kind: "resolve-gate", gateId: "run-gate-1/approve-merge", runId: "run-gate-1", stepId: "approve-merge", repo: "example/repo", pr: 12, headSha: HEAD, decision: "merge" };

const GATE = {
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
  openedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
  status: "open",
  section: "blocking",
  evidence: "https://github.com/example/repo/pull/12",
  action: ACTION,
};

const EVIDENCE = {
  facts: ["ci-policy-weakened"],
  mergeBase: BASE,
  digest: "e".repeat(64),
  sections: [
    {
      fact: "ci-policy-weakened",
      ciPolicy: { kind: "weakened", keys: ["secrets"] },
      verdictLines: [RATIONALE, "**CI policy:** weakened secrets", "CI-policy: unchanged"],
      labelledLines: [
        { raw: "**CI policy:** weakened secrets", reading: { kind: "weakened", keys: ["secrets"] } },
        { raw: "CI-policy: unchanged", reading: { kind: "unchanged" } },
      ],
      files: [{ path: ".github/workflows/ci.yml", rows: [{ side: "-", n: 3, text: "required: true\\u{A}" }, { side: "+", n: 3, text: LONG_ROW }] }],
    },
  ],
};

function renderInbox(taps: Record<string, () => Promise<JsonEnvelope<unknown>>>): void {
  const answer = successEnvelope({ items: [GATE], gaps: [], fyiCount: 0, readAt: new Date(NOW).toISOString(), derived: [] });
  const snapshot: Snapshot = { format: SNAPSHOT_FORMAT, createdAt: new Date(NOW).toISOString(), calls: { [snapshotKey("inbox.list", {})]: answer } };
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html");
  const inner = pageDataSource({ doc: page });
  const source: DataSource = {
    subscribe: inner.subscribe.bind(inner),
    call: (name, args, options) => (taps[name] ? taps[name]() : inner.call(name, args, options)),
  };
  window.location.hash = "#/inbox";
  render(
    <RpcProvider source={source}>
      <AnswerSourceProvider value={source}>
        <App />
      </AnswerSourceProvider>
    </RpcProvider>,
  );
}

const ready = (): Promise<JsonEnvelope<unknown>> =>
  Promise.resolve(
    successEnvelope({
      status: "ready",
      itemId: "gate-1",
      action: ACTION,
      readBack: { repo: "example/repo", pr: 12, title: "Merge example/repo#12", headSha: HEAD, gateId: ACTION.gateId, effect: "Approve the merge of example/repo#12 at 0b7e2c1", evidence: EVIDENCE },
      readAt: new Date(NOW - 12_000).toISOString(),
      confirm: CONFIRM,
      expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
    }),
  );

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the inbox confirm sheet on an owner-at-head merge gate", () => {
  it("heads the section with the evidence's own CI-policy reading and lists every labelled line it folds", async () => {
    renderInbox({ "inbox.prepare": ready });
    const row = await screen.findByTestId("inbox-row-gate-1");

    fireEvent.click(within(row).getByText("Approve merge"));
    const evidence = await screen.findByTestId("inbox-readback-evidence");

    expect(within(evidence).getByText("You read this at the head: ci-policy-weakened. Diffs are against merge base 1a2b3c4.")).toBeTruthy();
    expect(within(evidence).getByTestId("inbox-evidence-ci-policy").textContent).toBe("CI policy: weakened: secrets");
    expect(within(evidence).getAllByTestId("inbox-evidence-labelled-line").map((line) => line.textContent)).toEqual(["**CI policy:** weakened secrets  (reads weakened: secrets)", "CI-policy: unchanged  (reads unchanged)"]);
    expect(within(evidence).getByTestId("inbox-evidence-verdict").textContent).toBe([RATIONALE, "**CI policy:** weakened secrets", "CI-policy: unchanged"].join("\n"));
  });

  it("shows every changed row whole, a 300-character one included, with nothing that clamps or cuts it", async () => {
    renderInbox({ "inbox.prepare": ready });
    const row = await screen.findByTestId("inbox-row-gate-1");

    fireEvent.click(within(row).getByText("Approve merge"));
    const evidence = await screen.findByTestId("inbox-readback-evidence");
    const file = within(evidence).getByTestId("inbox-evidence-file");

    expect(within(evidence).getByText(".github/workflows/ci.yml (2 changed lines)")).toBeTruthy();
    expect(file.textContent).toBe(`- L3: required: true\\u{A}\n+ L3: ${LONG_ROW}`);
    expect([evidence, ...evidence.querySelectorAll("*")].filter((node) => /line-clamp|truncate|max-h|overflow-hidden|text-ellipsis/.test(node.getAttribute("class") ?? ""))).toEqual([]);
  });
});
