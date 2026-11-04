import { describe, expect, it } from "vitest";
import type { OwnerItem } from "@titan-design/owner-queue";
import { actionFor, type WatchRow } from "./inbox-view.js";

const REPO = "example/repo";
const HEAD = "1234567890abcdef1234567890abcdef12345678";
const RUN = "11111111-0000-4000-8000-000000000001";
const GATE_ID = `${RUN}/sh-sent-back`;

function sentBack(options?: OwnerItem["options"]): OwnerItem {
  return {
    id: `gate:${GATE_ID}`,
    sources: [{ system: "hitl", ref: GATE_ID }],
    kind: "approve",
    door: "one-way",
    summary: `Settle ${GATE_ID}?`,
    context: "",
    keys: [`gate:${GATE_ID}`, `run:${RUN}`],
    personal: false,
    lens: "blocking-merge",
    unblocks: [],
    openedAt: "2026-10-10T00:00:00.000Z",
    status: "open",
    command: `titan-factory gate resolve ${RUN} sh-sent-back --json '<payload>'`,
    evidenceRef: `https://example.test/${REPO}/pull/1`,
    ...(options && { options }),
  };
}

const ROW: WatchRow = {
  repo: REPO,
  pr: 1,
  branch: "feat/1",
  runId: RUN,
  task: "EX-1",
  phase: "awaiting-approval",
  headSha: HEAD,
  phaseSince: "2026-10-10T00:00:00.000Z",
  nextAction: "owner: resolve sh-sent-back",
  pendingGate: { gateId: GATE_ID, stepId: "sh-sent-back", since: "2026-10-10T00:00:00.000Z" },
  held: null,
  stalled: null,
};

const AWAIT = { kind: "resolve-gate", gateId: GATE_ID, runId: RUN, stepId: "sh-sent-back", repo: REPO, pr: 1, headSha: HEAD, decision: "await-new-head" };
const WAIVE = { id: "waive-proof", label: "Waive the fix-proof" };
const ABANDON = { id: "abandon", label: "Abandon the PR" };

describe("a sent-back gate's waive-proof tap", () => {
  it("taps a waivable sh-sent-back gate with await-new-head and offers waive-proof as its second tap, never abandon", () => {
    const { action } = actionFor(sentBack([{ id: "await-new-head", label: "Wait for a new head" }, ABANDON, WAIVE]), ROW);

    expect(action).toEqual({ ...AWAIT, alternatives: ["waive-proof"] });
  });

  it("offers no waiver on a sent-back gate whose item lists no options, leaving that check to the factory", () => {
    const { action } = actionFor(sentBack(), ROW);

    expect(action).toEqual(AWAIT);
  });

  it("offers no waiver alone on a sent-back gate whose options lack await-new-head", () => {
    const { action } = actionFor(sentBack([ABANDON, WAIVE]), ROW);

    expect(action.kind).toBe("terminal");
  });
});
