import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, githubPort, successRun } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { step } from "../workflows/land.js";
import { readFixProofAt } from "./fix-proof.js";
import type { ShepherdPhases } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { reviewPhase, type ReviewerDispatch } from "./review.js";
import { shepherdStoreRef } from "./store.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** The review phase as built before TP-2966 a: a refused intent ends the round as no-verdict, with no hold step. */
const reviewBeforeTp2966: ShepherdPhases["review"] = async (ctx, request) => {
  const target = { repo: request.repo, pr: request.pr, head: request.headSha };
  await readFixProofAt(ctx, target);
  await step(ctx, `sh-review-intent:${request.headSha}`, { ...target, runId: ctx.runId }, z.looseObject({ kind: z.string() }));
  return { kind: "none", cause: "no-verdict" };
};

function host(dbPath: string, review: ShepherdPhases["review"], store: ReturnType<typeof shepherdStoreRef>) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1, mergeableState: "clean" });
  fake.setRuns(H1, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  const dispatch: ReviewerDispatch = {
    roster: async () => {
      throw new Error("the roster is not readable");
    },
    spawn: async () => undefined,
    resume: async () => {
      throw new Error("no reviewer is resumed here");
    },
  };
  const wiring = { reader: { read: async () => [] }, dispatch };
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => 0, sleep: async () => undefined, review: wiring });
  const opened = openFactoryHost({ dbPath, workflows: [shepherdPrWorkflow({ review, wake: async () => ({ kind: "unhandled", reason: "no fixer here" }) })], routes, gatePollMs: 5 });
  hosts.push(opened);
  return opened;
}

describe("a run recorded before TP-2966 a restarts on the build that holds a refused intent as no-reviewer", () => {
  it("replays the refused sh-review-intent as the no-verdict it recorded, and is not parked", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tp3015-")), "factory.db");
    const store = shepherdStoreRef();
    const first = host(dbPath, reviewBeforeTp2966, store);
    const runId = first.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
    store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
    await gateOpened(first, gateId(runId, "approve-merge"));
    expect(JSON.stringify(first.runtime.status(runId)!.stepResults)).toContain("refused");
    first.close();

    const second = host(dbPath, reviewPhase, store);
    await second.adopt();
    await new Promise((resolve) => setTimeout(resolve, 500));

    const run = second.runtime.status(runId)!;
    expect(second.pendingGates().map((gate) => gate.stepId)).toContain("approve-merge");
    expect(run.status).not.toBe("recovery_required");
    expect(Object.keys(run.stepResults).some((id) => id.startsWith("sh-no-reviewer-hold"))).toBe(false);
  }, 20_000);
});
