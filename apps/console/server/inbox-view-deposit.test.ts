import { describe, expect, it } from "vitest";
import type { OwnerItem } from "@titan-design/owner-queue";
import { actionFor, type WatchRow } from "./inbox-view.js";

const REPO = "example/repo";
const HEAD = "1234567890abcdef1234567890abcdef12345678";
const ASKER = "test-asker";
const RUN_PLAIN = "11111111-0000-4000-8000-000000000001";

function deposit(ref: string, overrides: Partial<OwnerItem> = {}): OwnerItem {
  return {
    id: `deposit:${ref}`,
    sources: [{ system: "deposit", ref: `${ASKER}/${ref}` }],
    kind: "do",
    door: "two-way",
    summary: `Settle ${ref}?`,
    context: "",
    keys: [],
    personal: false,
    lens: "blocking-agent",
    unblocks: [],
    openedAt: "2026-10-01T00:00:00.000Z",
    status: "open",
    asker: ASKER,
    command: "titan-factory shepherd waiting",
    ...overrides,
  };
}

const liveRow: WatchRow = {
  repo: REPO,
  pr: 1,
  branch: "feat/1",
  runId: RUN_PLAIN,
  task: "EX-1",
  phase: "awaiting-approval",
  headSha: HEAD,
  phaseSince: "2026-10-10T00:00:00.000Z",
  nextAction: "owner: resolve approve-merge",
  pendingGate: { gateId: `${RUN_PLAIN}/approve-merge`, stepId: "approve-merge", since: "2026-10-10T00:00:00.000Z" },
  held: null,
  stalled: null,
};

describe("actionFor on a plain deposit", () => {
  it("is answered in the inbox with no op", () => {
    expect(actionFor(deposit("none"), undefined).action).toEqual({ kind: "answer-deposit" });
  });

  it("gives a deposit carrying a live gate's key only the deposit answer", () => {
    const impostor = deposit("impostor", { keys: [`gate:${RUN_PLAIN}/approve-merge`, `run:${RUN_PLAIN}`] });

    expect(actionFor(impostor, liveRow).action).toEqual({ kind: "answer-deposit" });
  });
});
