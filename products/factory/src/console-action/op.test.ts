import { DEFAULT_TABLE } from "@titan-design/authority";
import type { OwnerOp } from "@titan-design/owner-queue";
import { describe, expect, it, vi } from "vitest";
import { opAuthority } from "../owner-ops/authority.js";
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

describe("opAuthority", () => {
  it("gates close-pr, factory-config-set and deploy-pause-clear each on its own owner-remote row", () => {
    const ops: OwnerOp[] = [
      { kind: "close-pr", repo: REPO, pr: 7, headSha: H },
      { kind: "factory-config-set", path: "shepherd.gateReset.heldRepair", value: "on" },
      { kind: "deploy-pause-clear", pausedAt: "2026-01-01T00:00:00Z", target: "abc1234" },
    ];

    const decisions = ops.map((op) => opAuthority(op));

    expect(decisions).toMatchObject([
      { verdict: "gate", ruleId: "PRC-OR", resolvers: ["owner-remote"] },
      { verdict: "gate", ruleId: "FLC-OR", resolvers: ["owner-remote"] },
      { verdict: "gate", ruleId: "DPR-OR", resolvers: ["owner-remote"] },
    ]);
  });
});

describe("actOnOp", () => {
  it("refuses with class an op the authority table denies owner-remote, running no effect and logging nothing", async () => {
    const effect = vi.fn<OpEffect<undefined>>();
    const ledger = memoryLedger();

    const table = { ...DEFAULT_TABLE, rules: DEFAULT_TABLE.rules.map((rule) => (rule.id === "RET-OR" ? { ...rule, verdict: "deny" as const } : rule)) };
    const op: OwnerOp = { kind: "retire-agent", name: "impl-a", agentId: "agent-1", force: true };

    const outcome = await actOnOp("act-1", { op, confirmEvent: CONFIRM }, { effects: { [op.kind]: effect }, ledger, now: () => 0, table }, CONTEXT);

    expect(outcome).toMatchObject({ outcome: "refused", reason: "class", detail: expect.stringContaining("RET-OR denies agent-retire by owner-remote") });
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

  // Kills: mapping retire-agent back onto destructive-local, whose DSL-OR row denies every console retire.
  it("admits a retire-agent op under RET-OR and runs its effect", async () => {
    const answer: Outcome = { outcome: "retired", name: "item-42", caveats: [] };

    const outcome = await act({ kind: "retire-agent", name: "item-42", agentId: "9e3faa6c", force: false }, async () => answer);

    expect(outcome).toEqual(answer);
  });

  it("refuses with class an admitted op whose kind has no effect yet", async () => {
    const ledger = memoryLedger();

    const outcome = await actOnOp("act-1", { op: { kind: "merge-at-head", repo: REPO, pr: 7, headSha: H }, confirmEvent: CONFIRM }, { effects: {}, ledger, now: () => 0 }, CONTEXT);

    expect(outcome).toMatchObject({ outcome: "refused", reason: "class", detail: expect.stringContaining("no factory effect") });
    expect(ledger.entries).toEqual([]);
  });
});
