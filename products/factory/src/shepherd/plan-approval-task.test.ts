import type { GateResolver } from "@titan-design/hitl";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SHEPHERD_MIGRATIONS } from "../workflows.js";
import { ownerTaskApproval } from "./owner-task-approval.js";
import { PlanApprovalRefused, PlanApprovalSchema, type TaskApproval } from "./plan-approval.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { ShepherdStore } from "./store.js";

const REPO = "example-org/example-repo";
const TASK = "example/TP-1";
const DONE_WHEN = "The widget renders in both themes.";
const CONSOLE = (confirmEvent: string): GateResolver => ({ class: "owner-remote", id: "titan-console", channel: "console:inbox", confirmEvent });
const TASK_APPROVAL: TaskApproval = { gate: "task", scope: { doneWhen: DONE_WHEN, reason: "new-direction", visualSignoff: true }, round: "validate-example-tp-1-r1" };

function openStore(): { store: ShepherdStore; db: Db } {
  const db = openDatabase(":memory:");
  runMigrations(db, SHEPHERD_MIGRATIONS);
  return { store: new ShepherdStore(db, () => Date.parse("2026-11-12T12:00:00Z")), db };
}

const approveTask = (store: ShepherdStore, resolver: GateResolver = CONSOLE("action:1"), task = TASK, claimRun?: string) =>
  store.planApprovals().record({ ...TASK_APPROVAL, task, repo: REPO }, resolver, claimRun);
const ClaimRow = z.object({ claimed_run: z.string().nullable() });
const claims = (db: Db): (string | null)[] => db.prepare("SELECT claimed_run FROM shepherd_plan_approval").all().map((row) => ClaimRow.parse(row).claimed_run);

describe("the owner's task approval", () => {
  it("a console task approval is recorded and read back by task key", () => {
    const { store } = openStore();

    approveTask(store);

    expect(ownerTaskApproval(store, TASK, DONE_WHEN)).toEqual(TASK_APPROVAL);
  });

  it.each<[string, GateResolver]>([
    ["a coordinator", { class: "coordinator", id: "tc-synthetic", channel: "factory-cli", confirmEvent: "action:1" }],
    ["the owner's terminal", { class: "owner-terminal", id: "titan-console", channel: "factory-cli", confirmEvent: "action:1" }],
    ["the console without a confirm event", { class: "owner-remote", id: "titan-console", channel: "console:inbox" }],
  ])("a task approval written by any other actor is refused: %s", (_case, resolver) => {
    const { store, db } = openStore();

    expect(() => approveTask(store, resolver)).toThrow(PlanApprovalRefused);
    expect(claims(db)).toEqual([]);
    expect(ownerTaskApproval(store, TASK, DONE_WHEN)).toBeUndefined();
  });

  it("a task approval is not claimed by a registering run", () => {
    const { store, db } = openStore();
    approveTask(store, CONSOLE("action:1"), TASK, "run-0");

    store.register({ repo: REPO, pr: 1, runId: "run-1", task: TASK, implementer: "impl-a", policy: OWNER_GATE_POLICY });

    expect(claims(db)).toEqual([null]);
    expect(store.planApprovals().forRun("run-1", TASK, REPO)).toEqual([]);
    expect(ownerTaskApproval(store, TASK, DONE_WHEN)).toEqual(TASK_APPROVAL);
  });

  it("a task scope missing its reason is refused", () => {
    const { scope } = TASK_APPROVAL;
    const noReason = { doneWhen: scope.doneWhen, visualSignoff: scope.visualSignoff };

    expect(PlanApprovalSchema.safeParse({ gate: "task", scope: noReason, round: "r" }).success).toBe(false);
    expect(PlanApprovalSchema.safeParse({ gate: "task", scope: { ...scope, reason: "nice-to-have" }, round: "r" }).success).toBe(false);
  });

  it("a task approval for an older done_when reads as none", () => {
    const { store } = openStore();
    approveTask(store);

    expect(ownerTaskApproval(store, TASK, "The widget renders in one theme.")).toBeUndefined();
    expect(ownerTaskApproval(store, TASK, `${DONE_WHEN} ref 10824333`)).toBeUndefined();
  });

  it("a task approval still reads back when the done_when is only reflowed", () => {
    const { store } = openStore();
    approveTask(store);

    expect(ownerTaskApproval(store, TASK, "  The widget renders\nin both   themes.\n")).toEqual(TASK_APPROVAL);
  });

  it.each([
    ["uncollapsed whitespace", "The widget renders\nin both themes."],
    ["an escape sequence", "The widget renders \u001b[8mhidden\u001b[0m in both themes."],
    ["a zero-width space", "The widget\u200b renders in both themes."],
    ["no text", ""],
  ])("a task approval whose done_when holds %s, which the owner would not see as bound, is refused", (_case, doneWhen) => {
    const { store } = openStore();

    expect(() => store.planApprovals().record({ ...TASK_APPROVAL, scope: { ...TASK_APPROVAL.scope, doneWhen }, task: TASK, repo: REPO }, CONSOLE("action:1"))).toThrow();
    expect(ownerTaskApproval(store, TASK, doneWhen)).toBeUndefined();
  });

  it.each(["TP-1", "example/tp-1", "Example/TP-1", "example/TP-1/extra"])("a task key %s that is not <initiative>/<ID> is refused on write and on read", (key) => {
    const { store } = openStore();

    expect(() => approveTask(store, CONSOLE("action:1"), key)).toThrow(PlanApprovalRefused);
    expect(() => ownerTaskApproval(store, key, DONE_WHEN)).toThrow(PlanApprovalRefused);
  });

  it("never reads back a task row an agent inserted directly", () => {
    const { store, db } = openStore();
    const insert = "INSERT INTO shepherd_plan_approval (confirm_event, task, repo, gate, scope, round, actor, claimed_run, answered_at) VALUES ('forged', ?, ?, 'task', ?, 'r', 'agent:x', NULL, 't')";
    db.prepare(insert).run(TASK, REPO, JSON.stringify(TASK_APPROVAL.scope));

    expect(ownerTaskApproval(store, TASK, DONE_WHEN)).toBeUndefined();
  });
});
