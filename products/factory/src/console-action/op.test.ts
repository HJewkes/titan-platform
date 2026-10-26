import type { OwnerOp } from "@titan-design/owner-queue";
import { describe, expect, it, vi } from "vitest";
import type { LedgerEntry, OwnerOpsLedger } from "../owner-ops/ledger.js";
import { actOnOp, type OpEffect } from "./op.js";
import type { Outcome } from "./outcome.js";

const REPO = "example-org/example-repo";
const H = "a".repeat(40);
const CONFIRM = `action:${"d".repeat(64)}`;

function memoryLedger(): OwnerOpsLedger & { entries: LedgerEntry[] } {
  const entries: LedgerEntry[] = [];
  return { entries, append: async (entry) => void entries.push(entry), read: async (actionId) => entries.filter((entry) => entry.actionId === actionId) };
}

/** The effects these tests run read no context. */
const CONTEXT = undefined;

const act = (op: OwnerOp, effect: OpEffect<undefined>, ledger = memoryLedger()) => actOnOp("act-1", { op, confirmEvent: CONFIRM }, { effects: { [op.kind]: effect }, ledger, now: () => 0 }, CONTEXT);

describe("actOnOp", () => {
  it("refuses with class an op the authority table denies owner-remote, running no effect and logging nothing", async () => {
    const effect = vi.fn<OpEffect<undefined>>();
    const ledger = memoryLedger();

    const outcome = await act({ kind: "close-pr", repo: REPO, pr: 7, headSha: H }, effect, ledger);

    expect(outcome).toMatchObject({ outcome: "refused", reason: "class", detail: expect.stringContaining("DSR-OR denies destructive-remote by owner-remote") });
    expect(effect).not.toHaveBeenCalled();
    expect(ledger.entries).toEqual([]);
  });

  it("runs the effect of an op the table gates for owner-remote, between a started and a done line", async () => {
    const answer: Outcome = { outcome: "gone", reason: "synthetic" };
    const ledger = memoryLedger();
    const op: OwnerOp = { kind: "merge-at-head", repo: REPO, pr: 7, headSha: H };

    const outcome = await act(op, async (_actionId, read) => (read.op === op && read.confirmEvent === CONFIRM ? answer : { outcome: "gone", reason: "wrong read" }), ledger);

    expect(outcome).toEqual(answer);
    expect(ledger.entries.map((entry) => entry.phase)).toEqual(["started", "done"]);
  });

  it("refuses with class an admitted op whose kind has no effect yet", async () => {
    const ledger = memoryLedger();

    const outcome = await actOnOp("act-1", { op: { kind: "merge-at-head", repo: REPO, pr: 7, headSha: H }, confirmEvent: CONFIRM }, { effects: {}, ledger, now: () => 0 }, CONTEXT);

    expect(outcome).toMatchObject({ outcome: "refused", reason: "class", detail: expect.stringContaining("no factory effect") });
    expect(ledger.entries).toEqual([]);
  });
});
