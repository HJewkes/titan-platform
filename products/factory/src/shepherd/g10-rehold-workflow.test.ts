import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { G10_REHOLD_STEP } from "./g10-rehold.js";
import type { ShepherdPhases } from "./phases.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { reviewPhase, type ReviewerDispatch, type ReviewerReader } from "./review.js";
import { shepherdStoreRef, type ShepherdStore } from "./store.js";
import type { Git, GitResult } from "./tree-carry.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const AUTO_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const ADVERSARY_HOLD = "g10-adversary: trust rule (security); TP-1";
const MOVED = fakeSha("head-after-release");
const MAIN = fakeSha("main-tip");
const MERGED_TREE = fakeSha("merge-tree");

const ok = (stdout = ""): GitResult => ({ code: 0, stdout, stderr: "" });

/** How the moved head came to be: a clean merge of main onto the released head, or a fix pushed on top of it. */
function scriptedGit(shape: "clean-merge-up" | "fix-push"): Git {
  return async (_dir, args) => {
    const [command] = args;
    if (command === "rev-list") return ok(shape === "fix-push" ? `${args.at(-1)} ${H1}` : `${args.at(-1)} ${H1} ${MAIN}`);
    if (command === "merge-tree") return ok(`${MERGED_TREE}\n`);
    if (command === "rev-parse") return ok(shape === "fix-push" ? fakeSha("tree-with-fix") : MERGED_TREE);
    return ok();
  };
}

/** No reviewer ever answers: the re-hold decision is made on the CI read, before any review is asked for. */
const silentReviewers = (): { dispatch: ReviewerDispatch; reader: ReviewerReader } => ({
  dispatch: { roster: async () => [], spawn: async () => undefined, resume: async () => undefined },
  reader: { read: async () => [] },
});

interface World {
  host: FactoryHost;
  fake: FakeGitHub;
  store: ShepherdStore;
  runId: string;
}

/** A PR the seat released a g10-adversary hold on at H1, now at MOVED. */
function releasedThenMoved(shape: "clean-merge-up" | "fix-push"): World {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const wake: ShepherdPhases["wake"] = async () => ({ kind: "unhandled", reason: "no fixer in this test" });
  const ref = shepherdStoreRef();
  const review = { ...silentReviewers(), roles: { g10: "bd-reviewer", standard: "reviewer" }, carry: { git: scriptedGit(shape) } };
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal), review });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake })], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: MOVED, mergeSha: fakeSha("test-merge") });
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  const store = ref.get();
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO_POLICY) });
  store.register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO_POLICY, kind: "security" });
  store.hold(runId, ADVERSARY_HOLD);
  store.release(runId, { headSha: H1 });
  return { host, fake, store, runId };
}

const stepIds = (w: World): string[] => Object.values(w.host.runtime.status(w.runId)!.stepResults).map((result) => result.stepId);

describe("a g10-adversary hold the seat released at one head, with the PR now at another", () => {
  it("is re-held by the run's CI read after a fix push, and the PR does not merge", async () => {
    const w = releasedThenMoved("fix-push");

    await vi.waitFor(() => expect(w.store.byRun(w.runId)?.held).toBe(true), { timeout: 5_000 });

    expect(w.store.byRun(w.runId)?.holdReason).toContain(`from ${H1} to ${MOVED}`);
    expect(w.store.eventsOf(w.runId).at(-1)).toMatchObject({ kind: "hold", actor: "shepherd", headSha: MOVED });
    expect(stepIds(w)).toContain(G10_REHOLD_STEP);
    expect(w.fake.pr(1).merged).toBe(false);
  });

  it("stays released across a clean merge-up of the released head", async () => {
    const w = releasedThenMoved("clean-merge-up");

    await vi.waitFor(() => expect(stepIds(w)).toContain(G10_REHOLD_STEP), { timeout: 5_000 });

    expect(w.store.byRun(w.runId)?.held).toBe(false);
    expect(w.store.eventsOf(w.runId).map((event) => event.kind)).toEqual(["hold", "release"]);
  });
});
