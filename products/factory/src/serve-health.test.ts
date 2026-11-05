import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { partialFake } from "@titan-design/test-kit";
import type { WorkflowRun, WorkflowRuntime } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import type { FactoryHost, FactoryRoutes } from "./host.js";
import { serveHealth } from "./serve-health.js";
import type { ShepherdServices } from "./shepherd/services.js";
import { SpawnDeferred, spawnGate } from "./shepherd/spawn-gate.js";
import type { Registration, ShepherdStore, ShepherdStoreRef } from "./shepherd/store.js";

const REPO = "example/demo";
const T0 = 1_000_000;
const quiet = () => undefined;
const review = (pr: number) => ({ fixer: false, target: { repo: REPO, pr } });
const dirs: string[] = [];

afterEach(() => {
  spawnGate({ read: () => ({ load5: 1 }), now: () => T0, log: quiet }).admit("rv-demo-7", [], review(7));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function run(id: string, currentStep: string): WorkflowRun {
  return { id, workflowName: "shepherd-pr", params: {}, status: "running", currentStep, stepResults: {}, activeSteps: {}, revision: 1, ownerGeneration: 1, startedAt: "2026-01-01T00:00:00.000Z", completedAt: null, error: null };
}

function host(running: WorkflowRun[]): FactoryHost {
  const runtime = partialFake<WorkflowRuntime>({ list: (statuses) => (statuses?.includes("running") ? running : []), status: () => undefined });
  return partialFake<FactoryHost>({ runtime, countRuns: () => new Map(), pendingGates: () => [] });
}

/** Each run is registered, unheld, on the PR numbered in its id. */
const shepherd = partialFake<ShepherdServices>({
  store: partialFake<ShepherdStoreRef>({ get: () => partialFake<ShepherdStore>({ byRun: (id: string) => partialFake<Registration>({ repo: REPO, pr: Number(id.slice(1)), held: false }) }) }),
});

function busyOf(running: WorkflowRun[]): unknown {
  const deployStateDir = mkdtempSync(join(tmpdir(), "factory-health-"));
  dirs.push(deployStateDir);
  const health = serveHealth(host(running), { routes: partialFake<FactoryRoutes>({ shepherd }), deployStateDir }, {
    github: { status: () => "ok", refresh: async () => undefined },
    build: { sha: "a".repeat(40), status: () => 0 },
    routeFor: () => undefined,
    ownerKeys: { ok: false, refusal: "none" },
    start: undefined,
    notify: undefined,
    ingress: undefined,
    passStamp: { read: () => null, record: () => undefined },
    bot: { state: "absent" },
    reconciler: "disabled",
  });
  return health.busy;
}

describe("/health busy for the restart drain (TP-4474)", () => {
  it("leaves out a run whose review spawn the gate deferred, and lists one it did not", () => {
    expect(() => spawnGate({ read: () => ({ load5: 40 }), now: () => T0, log: quiet }).admit("rv-demo-7", [], review(7))).toThrow(SpawnDeferred);

    expect(busyOf([run("r7", "sh-review:abc1234"), run("r8", "sh-review:abc1234")])).toEqual([{ runId: "r8", step: "sh-review:abc1234", phase: "review" }]);
  });
});
