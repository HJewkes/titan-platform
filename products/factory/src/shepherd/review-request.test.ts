import { fakeSha } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { shepherdEventMigration } from "./events.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { reviewRequestRoute } from "./review-request.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, lineageMigration, reviewRequestMigration, shepherdMigration, sliceMigration } from "./store.js";

const HEAD = fakeSha("head");
const Recorded = z.object({ result: z.unknown() });

function asked(): ShepherdStore {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), reviewRequestMigration(18)]);
  const store = new ShepherdStore(db);
  store.register({ repo: "octo/demo", pr: 1, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  store.requestReview("run-1", HEAD);
  return store;
}

/** One `sh-review-request` read at HEAD; `attempt` above 0 is the repeat of a step a crash interrupted. */
async function read(store: ShepherdStore, attempt = 0): Promise<unknown> {
  const route = reviewRequestRoute({ store: { get: () => store, bind: () => () => undefined }, now: () => 0 });
  const stepId = `sh-review-request:${HEAD}`;
  const done = await route.runner.run({ runId: "run-1", workflowName: "shepherd-pr", stepId, iteration: 0, prompt: JSON.stringify({ runId: "run-1", head: HEAD }), signal: new AbortController().signal, attempt, requestKey: stepId });
  return done.ok ? Recorded.parse(JSON.parse(done.output)).result : done;
}

describe("the sh-review-request read", () => {
  it("takes the ask it finds, so a second read at the head finds none and one ask ends one merge wait", async () => {
    const store = asked();

    expect([await read(store), await read(store)]).toEqual([{ requested: true }, { requested: false }]);
    expect(store.byRun("run-1")?.reviewRequest?.takenAt).not.toBeNull();
  });

  it("still finds an ask it took when a crash makes it repeat, so the ask is never lost", async () => {
    const store = asked();
    await read(store);

    expect(await read(store, 1)).toEqual({ requested: true });
  });
});
