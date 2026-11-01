import { fakeSha } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { partialFake } from "@titan-design/test-kit";
import { WorkflowRunStore, type WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { factoryMigrations } from "../host.js";
import { busyRuns } from "../restart-drain.js";
import { heldRun } from "../serve-holds.js";
import { SHEPHERD_MIGRATIONS } from "../workflows.js";
import { MergeOrder, orderDriving } from "./merge-order.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import type { ShepherdServices } from "./services.js";
import { ShepherdStore, type ShepherdStoreRef } from "./store.js";

const REPO = "owner/demo-repo";
const AT = "2026-10-28T12:00:00.000Z";
const H1 = fakeSha("lan-reader-1");
const H2 = fakeSha("lan-reader-2");
const SMOKE = "demo-smoke";
const RUN = "run-1";

/** A lan-gates-held run whose merge step last read CI at `mergeHead`, with `demo-smoke` green at `greenAt`. */
function rig(mergeHead: string, greenAt: string | undefined) {
  const db = openDatabase(":memory:");
  runMigrations(db, [...factoryMigrations(), ...SHEPHERD_MIGRATIONS]);
  const store = new ShepherdStore(db, () => Date.parse(AT));
  store.register({ repo: REPO, pr: 7, runId: RUN, task: "demo/T-1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  store.gateEvidence().declare(SMOKE);
  store.hold(RUN, `lan-gates: ${SMOKE}; runs off GitHub Actions`);
  if (greenAt !== undefined) store.gateEvidence().record({ repo: REPO, head: greenAt, gate: SMOKE, conclusion: "success", source: "factory:demo-build" });
  const ciWait = { stepId: "ci-wait:0", iteration: 0, agentId: null, signal: null, completedAt: AT, data: { result: { verdict: "green", headSha: mergeHead } } };
  const run: WorkflowRun = { id: RUN, workflowName: "shepherd-pr", params: { repo: REPO }, status: "running", currentStep: "merge:0", stepResults: { "ci-wait:0": ciWait }, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: AT, completedAt: null, error: null };
  new WorkflowRunStore(db).create(run);
  return { db, store, run };
}

const drives = (r: ReturnType<typeof rig>) => orderDriving(new MergeOrder(r.db), r.store)(RUN);

const drainWaits = (r: ReturnType<typeof rig>) => {
  const services = partialFake<ShepherdServices>({ store: partialFake<ShepherdStoreRef>({ get: () => r.store }) });
  return busyRuns([r.run], () => undefined, heldRun(services)).length === 1;
};

describe("a lan-gates hold read by merge order and the restart drain", () => {
  it("still orders peers once every gate is green at the head its merge step is at, since it may merge there", () => {
    const r = rig(H1, H1);

    expect(drives(r)).toBe(true);
  });

  it("orders nothing while its gates are green only at a head its merge step has moved past", () => {
    const r = rig(H2, H1);

    expect(drives(r)).toBe(false);
  });

  it("makes a restart wait on its merge step once every gate is green at that step's head", () => {
    const r = rig(H1, H1);

    expect(drainWaits(r)).toBe(true);
  });

  it("lets a restart skip its merge step while no gate evidence is green at that step's head", () => {
    const r = rig(H1, undefined);

    expect(drainWaits(r)).toBe(false);
  });
});
