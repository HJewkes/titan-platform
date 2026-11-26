import type { OwnerOp } from "@titan-design/owner-queue";
import { describe, expect, it, vi } from "vitest";
import type { LedgerEntry, OwnerOpsLedger } from "../owner-ops/ledger.js";
import { actOnOp, OP_EFFECTS, type OpEffect } from "./op.js";
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

  // Kills: mapping retire-agent back onto destructive-local, whose DSL-OR row denies every console retire.
  it("admits a retire-agent op under RET-OR and runs its effect", async () => {
    const answer: Outcome = { outcome: "retired", name: "item-42", caveats: [] };

    const outcome = await act({ kind: "retire-agent", name: "item-42", agentId: "9e3faa6c", force: false }, async () => answer);

    expect(outcome).toEqual(answer);
  });

  // Kills: mapping delete-branch onto a class whose owner-remote row allows it before the owner has answered for one.
  it("refuses a delete-branch op with class under DSR-OR, though its effect is wired, running nothing", async () => {
    const effect = vi.fn<OpEffect<undefined>>();
    const ledger = memoryLedger();

    const outcome = await act({ kind: "delete-branch", repo: REPO, branch: "scratch/spike", tipSha: H }, effect, ledger);

    expect(OP_EFFECTS).toHaveProperty("delete-branch");
    expect(outcome).toMatchObject({ outcome: "refused", reason: "class", detail: expect.stringContaining("DSR-OR denies destructive-remote by owner-remote") });
    expect(effect).not.toHaveBeenCalled();
    expect(ledger.entries).toEqual([]);
  });

  // Kills: mapping a planning op onto authority-config, whose CFG-OR row denies the console every planning tap.
  it.each<OwnerOp>([
    { kind: "plan-bet-select", initiative: "alpha", week: "2026-W47", bets: ["alpha/B1"] },
    { kind: "plan-outcome-edit", outcome: "alpha/faster-landing", to: { measure: "median hours" } },
    { kind: "plan-freeze-set", initiative: "alpha", freeze: { action: "end", id: "alpha/F1" } },
  ])("admits a $kind op as the owner's own verb, gated to owner-remote under HV-OR", async (op) => {
    const answer: Outcome = { outcome: "already", ids: [] };

    const outcome = await act(op, async () => answer);

    expect(outcome).toEqual(answer);
  });

  // Kills: mapping start-session onto a class the table denies owner-remote, or wiring an effect before the broker checks the record.
  it("admits a start-session op under SPN-OR but refuses it with class while it has no factory effect, logging nothing", async () => {
    const ledger = memoryLedger();
    const op: OwnerOp = {
      kind: "start-session", name: "research-lead", profile: "researcher", host: "build-box", account: "work-2",
      cwd: "/srv/work/example", surface: "tmux", remoteControl: false, briefPath: "/srv/briefs/research.md", briefSha256: "c".repeat(64),
    };

    const outcome = await actOnOp("act-1", { op, confirmEvent: CONFIRM }, { effects: {}, ledger, now: () => 0 }, CONTEXT);

    expect(OP_EFFECTS).not.toHaveProperty("start-session");
    expect(outcome).toMatchObject({ outcome: "refused", reason: "class", detail: "a start-session op has no factory effect" });
    expect(ledger.entries).toEqual([]);
  });

  it("refuses with class an admitted op whose kind has no effect yet", async () => {
    const ledger = memoryLedger();

    const outcome = await actOnOp("act-1", { op: { kind: "merge-at-head", repo: REPO, pr: 7, headSha: H }, confirmEvent: CONFIRM }, { effects: {}, ledger, now: () => 0 }, CONTEXT);

    expect(outcome).toMatchObject({ outcome: "refused", reason: "class", detail: expect.stringContaining("no factory effect") });
    expect(ledger.entries).toEqual([]);
  });
});
