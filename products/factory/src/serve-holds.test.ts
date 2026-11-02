import { partialFake } from "@titan-design/test-kit";
import type { WorkflowRun } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { busyRuns } from "./restart-drain.js";
import { gateQueuedRun, heldRun } from "./serve-holds.js";
import type { ShepherdServices } from "./shepherd/services.js";
import { SpawnDeferred, spawnGate } from "./shepherd/spawn-gate.js";
import type { Registration, ShepherdStore, ShepherdStoreRef } from "./shepherd/store.js";
import type { MergeTrain, MergeTrainRef } from "./shepherd/train.js";

const REPO = "example/demo";

function run(id: string, currentStep: string): WorkflowRun {
  return { id, workflowName: "shepherd-pr", params: {}, status: "running", currentStep, stepResults: {}, activeSteps: {}, revision: 1, ownerGeneration: 1, startedAt: "2026-01-01T00:00:00.000Z", completedAt: null, error: null };
}

/** A shepherd store with one registration per run id, and a train held by `holder`. */
function services(registrations: Record<string, { held: boolean }>, holder: string | undefined): ShepherdServices {
  const byRun = (id: string) => registrations[id] && partialFake<Registration>({ repo: REPO, held: registrations[id].held, holdSatisfied: null });
  const train = partialFake<MergeTrain>({ holder: (repo) => (repo === REPO && holder !== undefined ? { repo, runId: holder, pr: 1, since: "2026-01-01T00:00:00.000Z" } : undefined) });
  const store = partialFake<ShepherdStoreRef>({ get: () => partialFake<ShepherdStore>({ byRun }) });
  return partialFake<ShepherdServices>({ store, train: partialFake<MergeTrainRef>({ get: () => train }) });
}

const route = () => undefined;

describe("serve's hold check for the restart drain", () => {
  it("skips a held run and a run waiting behind the train holder, and waits on the holder", () => {
    const shepherd = services({ held: { held: true }, waiting: { held: false }, head: { held: false } }, "head");
    const runs = [run("held", "merge:0"), run("waiting", "merge:0"), run("head", "merge:0")];

    expect(busyRuns(runs, route, heldRun(shepherd)).map((busy) => busy.runId)).toEqual(["head"]);
  });

  it("waits on a run at merge when the train is free", () => {
    expect(busyRuns([run("next", "merge:0")], route, heldRun(services({ next: { held: false } }, undefined)))).toHaveLength(1);
  });

  it("waits on a run whose store cannot be read", () => {
    const unbound = (): ShepherdStore => {
      throw new Error("the shepherd store is not bound");
    };
    const unreadable = partialFake<ShepherdServices>({ store: partialFake<ShepherdStoreRef>({ get: unbound }) });

    expect(busyRuns([run("a", "merge:0")], route, heldRun(unreadable))).toHaveLength(1);
  });

  it("has no hold check without Shepherd", () => {
    expect(heldRun(undefined)).toBeUndefined();
  });
});

describe("serve's spawn-gate queue check for the restart drain (TP-4474)", () => {
  const T0 = 1_000_000;
  const quiet = () => undefined;
  const loaded = () => spawnGate({ read: () => ({ load5: 40 }), now: () => T0, log: quiet });
  const roomy = () => spawnGate({ read: () => ({ load5: 1 }), now: () => T0, log: quiet });
  const review = (pr: number) => ({ fixer: false, target: { repo: REPO, pr } });
  const deferred = (pr: number) => expect(() => loaded().admit(`rv-demo-${pr}`, [], review(pr))).toThrow(SpawnDeferred);
  /** Each run is registered on its own PR, the number in its id. */
  const shepherd = partialFake<ShepherdServices>({
    store: partialFake<ShepherdStoreRef>({ get: () => partialFake<ShepherdStore>({ byRun: (id: string) => partialFake<Registration>({ repo: REPO, pr: Number(id.slice(1)) }) }) }),
  });

  afterEach(() => [7, 8].forEach((pr) => roomy().admit(`rv-demo-${pr}`, [], review(pr))));

  it("does not wait on a run whose only active step is a review spawn the gate deferred", () => {
    deferred(7);

    expect(busyRuns([run("r7", "sh-review:abc1234")], route, undefined, gateQueuedRun(shepherd))).toEqual([]);
  });

  it("waits on a run once the gate admits its review and the reviewer agent is spawned", () => {
    deferred(7);
    roomy().admit("rv-demo-7", [], review(7));

    expect(busyRuns([run("r7", "sh-review:abc1234")], route, undefined, gateQueuedRun(shepherd))).toEqual([{ runId: "r7", step: "sh-review:abc1234", phase: "review" }]);
  });

  it("waits on a run whose PR the gate never deferred, beside one it did", () => {
    deferred(8);

    expect(busyRuns([run("r7", "sh-review:abc1234"), run("r8", "sh-review:abc1234")], route, undefined, gateQueuedRun(shepherd)).map((busy) => busy.runId)).toEqual(["r7"]);
  });

  it("waits on a queued PR's run at a step that is not the review spawn", () => {
    deferred(7);

    expect(busyRuns([run("r7", "sh-review-intent:abc1234"), run("r7", "merge:0")], route, undefined, gateQueuedRun(shepherd))).toHaveLength(2);
  });

  it("waits on a review spawn whose store cannot be read", () => {
    deferred(7);
    const unreadable = partialFake<ShepherdServices>({ store: partialFake<ShepherdStoreRef>({ get: () => { throw new Error("the shepherd store is not bound"); } }) });

    expect(busyRuns([run("r7", "sh-review:abc1234")], route, undefined, gateQueuedRun(unreadable))).toHaveLength(1);
  });

  it("has no queue check without Shepherd", () => {
    expect(gateQueuedRun(undefined)).toBeUndefined();
  });
});
