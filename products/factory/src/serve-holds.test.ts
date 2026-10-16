import { partialFake } from "@titan-design/test-kit";
import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { busyRuns } from "./restart-drain.js";
import { heldRun } from "./serve-holds.js";
import type { ShepherdServices } from "./shepherd/services.js";
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
