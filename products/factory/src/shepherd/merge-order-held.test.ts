import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { WorkflowRunStore } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { factoryMigrations } from "../host.js";
import { SHEPHERD_MIGRATIONS } from "../workflows.js";
import { MergeOrder, orderDriving, type RunHolds } from "./merge-order.js";

const REPO = "hjewkes/titan-platform";
const AT = "2026-10-23T10:00:00.000Z";

type Holds = ReturnType<RunHolds["byRun"]>;
const UNHELD: Holds = { held: false, holdSatisfied: null, ownerHold: null };
const HELD: Holds = { held: true, holdSatisfied: null, ownerHold: null };
const SATISFIED: Holds = { ...HELD, holdSatisfied: { head: "head-1", by: { reviewer: "rv", agentId: "agent-rv-1", sessionId: "session-rv-1", locator: {} } } };
const OWNER_HELD: Holds = { ...SATISFIED, ownerHold: { reason: "owner hold in this test", at: AT, askedAt: null } };

/** Whether one running run, with the given registration hold facts, still orders its merge-order peers. */
function drives(holds: Holds, status: "running" | "completed" = "running"): boolean {
  const db = openDatabase(":memory:");
  runMigrations(db, [...factoryMigrations(), ...SHEPHERD_MIGRATIONS]);
  new WorkflowRunStore(db).create({ id: "run-x", workflowName: "shepherd-pr", params: { repo: REPO }, status, currentStep: null, stepResults: {}, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: AT, completedAt: null, error: null });
  const driving = orderDriving(new MergeOrder(db), { byRun: () => holds })("run-x");
  db.close();
  return driving;
}

describe("whether a reserving run still orders its peers (TP-4133)", () => {
  it("orders them while it runs unheld or with no registration", () => {
    expect([drives(UNHELD), drives(undefined)]).toEqual([true, true]);
  });

  it("orders nothing while a hold no reviewer has satisfied stands", () => {
    expect(drives(HELD)).toBe(false);
  });

  it("still orders them once a reviewer satisfied its hold, since it may merge at that head", () => {
    expect(drives(SATISFIED)).toBe(true);
  });

  it("orders nothing under an owner hold, even with the hold satisfied", () => {
    expect(drives(OWNER_HELD)).toBe(false);
  });

  it("orders nothing once its run stops driving", () => {
    expect(drives(UNHELD, "completed")).toBe(false);
  });
});
