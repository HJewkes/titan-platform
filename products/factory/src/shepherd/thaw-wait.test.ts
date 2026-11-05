import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { WorkflowRunStore, type ActiveStep, type StepResult, type WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { factoryMigrations } from "../host.js";
import { busyRuns } from "../restart-drain.js";
import { SHEPHERD_MIGRATIONS } from "../workflows.js";
import { blockers, MergeOrder, orderDriving, type MergeOrderRule, type Reservation } from "./merge-order.js";
import { ShepherdStore } from "./store.js";

const REPO = "synthetic/repo";
const H = "a".repeat(40);
const H2 = "b".repeat(40);
const T0 = Date.parse("2026-11-05T06:00:00.000Z");
const RULE: MergeOrderRule = { enabled: true, ttlMinutes: 60, ignore: [] };
const SHARED = "packages/x/src/shared.ts";

const SKEW = { table: "shepherd-merge-guard", rowId: "attest-deploy-skew", version: 1 };
const UNSETTLED = { table: "shepherd-merge-guard", rowId: "merge-state-unsettled", version: 1 };
const FROZEN = { table: "authority", rowId: "none", version: 1 };
const FROZEN_REASON = "MRG-AU-RV unmet: repo-not-frozen";

type Rule = typeof SKEW;

let tick = 0;
function result(stepId: string, payload: Record<string, unknown>): StepResult {
  tick += 1;
  return { stepId, iteration: 0, agentId: null, signal: null, completedAt: new Date(T0 + tick * 1000).toISOString(), data: { result: payload } };
}

const ciRead = (headSha: string) => [`ci-wait:r2:${tick}`, result("ci-wait", { verdict: "green", headSha })] as const;
const decision = (headSha: string, rule: Rule, outcome = "gate", reason = "synthetic gate reason") => [`merge-policy:r2:${tick}`, result("merge-policy", { outcome, headSha, rule, reason })] as const;

interface Shape {
  currentStep: string;
  steps: (readonly [string, StepResult])[];
  active?: string[];
}

/** Run R, at the step and with the record given, holding the merge order on SHARED that peer S waits behind. */
function world(shape: Shape) {
  const db = openDatabase(":memory:");
  runMigrations(db, [...factoryMigrations(), ...SHEPHERD_MIGRATIONS]);
  const startedAt = new Date(T0).toISOString();
  const active = (key: string): [string, ActiveStep] => [key, { kind: "legacy", stepId: key, iterKey: `${key}:0`, attempt: 1, startedAt }];
  const activeSteps = Object.fromEntries((shape.active ?? [shape.currentStep]).map(active));
  const r: WorkflowRun = {
    id: "run-r", workflowName: "shepherd-pr", params: { repo: REPO, pr: "1" }, status: "running", currentStep: shape.currentStep,
    stepResults: Object.fromEntries(shape.steps), activeSteps,
    revision: 0, ownerGeneration: 0, startedAt, completedAt: null, error: null,
  };
  new WorkflowRunStore(db).create(r);
  const order = new MergeOrder(db);
  const reservation: Reservation = { repo: REPO, runId: "run-r", pr: 1, headSha: H, baseSha: "c".repeat(40), paths: [SHARED], ahead: [], since: new Date(T0).toISOString(), reason: "base moved under green" };
  order.reserve(reservation);
  const driving = orderDriving(order, { byRun: () => undefined, gateEvidence: () => new ShepherdStore(db).gateEvidence() });
  const sWaitsOn = blockers({ repo: REPO, runId: "run-s", paths: [SHARED] }, order.list(REPO), RULE, T0 + 60_000, driving).map((b) => b.reservation.pr);
  const busy = busyRuns([r], () => undefined).map((run) => run.runId);
  db.close();
  return { sWaitsOn, busy };
}

const settling = (rule: Rule, reason?: string): Shape => ({ currentStep: "merge-settle:r2:14", steps: [ciRead(H), decision(H, rule, "gate", reason)] });

describe("a run waiting at its head on a deploy or a thaw (TP-4778)", () => {
  it("replays the deadlock: R waits on deploy skew, so it neither orders S nor holds the deploy that would release it", () => {
    expect(world(settling(SKEW))).toEqual({ sWaitsOn: [], busy: [] });
  });

  it("stops ordering peers under a freeze-only wait, but stays busy since no deploy ends a freeze", () => {
    expect(world(settling(FROZEN, FROZEN_REASON))).toEqual({ sWaitsOn: [], busy: ["run-r"] });
  });

  it("keeps ordering and stays busy at a settle wait the bound ends", () => {
    expect(world(settling(UNSETTLED))).toEqual({ sWaitsOn: [1], busy: ["run-r"] });
  });

  it("orders again once the wait ends and its decision allows the merge", () => {
    const allowed: Shape = { currentStep: "merge:r2:0", steps: [ciRead(H), decision(H, SKEW), decision(H, SKEW, "allow")] };
    expect(world(allowed)).toEqual({ sWaitsOn: [1], busy: ["run-r"] });
  });

  it("orders again and is busy when its CI read has moved past the head the skew gate was at", () => {
    const moved: Shape = { currentStep: "merge-settle:r2:14", steps: [decision(H, SKEW), ciRead(H2)] };
    expect(world(moved)).toEqual({ sWaitsOn: [1], busy: ["run-r"] });
  });

  it("fails closed while any write step is active beside the settle wait", () => {
    const writing: Shape = { ...settling(SKEW), active: ["merge-settle:r2:14", "merge:r2:0"] };
    expect(world(writing)).toEqual({ sWaitsOn: [1], busy: ["run-r"] });
  });
});
