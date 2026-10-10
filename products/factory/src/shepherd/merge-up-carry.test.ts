import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { G10_RELEASE_STEP } from "./g10-release.js";
import type { ShepherdPhases } from "./phases.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { reviewPhase, type ReviewerAgent, type ReviewerDispatch, type ReviewerReader } from "./review.js";
import { shepherdStoreRef, type ShepherdStore } from "./store.js";
import type { Git, GitResult } from "./tree-carry.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const AUTO_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const G10_REVIEW = "g10-review: auth change; TP-1";
const G10_ADVERSARY = "g10-adversary: trust rule (security); TP-1";
const MAIN = fakeSha("main-tip");
const EXTRA = fakeSha("extra-commit");
const MERGED_TREE = fakeSha("merge-tree");
/** The run-log step and rule name a clean merge-up carry records. */
const MERGE_UP_STEP = "sh-merge-up";
const MERGE_UP_RULE = "clean-merge-up";

/** How H2 came to be: a clean merge of main, a merge whose conflict someone resolved, or a merge on top of an extra commit. */
type Shape = "clean" | "conflict-resolved" | "extra-commit";

const ok = (stdout = ""): GitResult => ({ code: 0, stdout, stderr: "" });

/** The carry probes' git: H2's parents and trees follow `shape`, and every ancestry question answers yes. */
function scriptedGit(shape: Shape): Git {
  let fromHead = "";
  return async (_dir, args) => {
    const [command] = args;
    if (command === "fetch") fromHead = args[5] ?? "";
    if (command === "rev-list") return ok(`${args.at(-1)} ${shape === "extra-commit" ? EXTRA : fromHead} ${MAIN}`);
    if (command === "merge-tree" && shape === "conflict-resolved") return { code: 1, stdout: `${fakeSha("conflicted")}\0src/a.ts\0`, stderr: "" };
    if (command === "merge-tree") return ok(`${MERGED_TREE}\n`);
    if (command === "rev-parse") return ok(shape === "conflict-resolved" ? fakeSha("resolved-tree") : MERGED_TREE);
    if (command === "diff-tree") return ok("src/a.ts\0");
    return ok();
  };
}

const row = (name: string, presence: ReviewerAgent["presence"] = "exited"): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence, spawnedBy: "coord", predecessor: null });

/** Every reviewer Shepherd spawns says MERGE at the head it reads; `spawned` counts them. */
function mergingReviewers(): { dispatch: ReviewerDispatch; reader: ReviewerReader; spawned: string[] } {
  const agents: ReviewerAgent[] = [{ ...row("coord", "live"), spawnedBy: null }, row("impl-a")];
  const spawned: string[] = [];
  const dispatch: ReviewerDispatch = { roster: async () => [...agents], spawn: async (name) => void (spawned.push(name), agents.push(row(name))), resume: async () => undefined };
  const said = (who: ReviewerAgent, head: string) => ({ agentId: who.agentId, sessionId: who.sessionId, writtenAt: 1, text: `Verdict: MERGE\nPR: ${REPO}#1\nHead: ${head}\n`, locator: { source: { conversation: { nativeId: who.sessionId } } } as unknown as SourceTextLocator });
  const reader: ReviewerReader = { read: async (input) => agents.filter((who) => who.agentId === input.reviewerAgentId).map((who) => said(who, input.head)) };
  return { dispatch, reader, spawned };
}

interface World {
  host: FactoryHost;
  fake: FakeGitHub;
  store: ShepherdStore;
  runId: string;
  spawned: string[];
}

interface Scenario {
  shape?: Shape;
  hold?: string;
  redAtH2?: boolean;
}

/** H1 is behind main and reviewed by a spawned opus reviewer; Shepherd's update-branch makes H2, H1 plus a merge of main. */
function heldBehindRun({ shape = "clean", hold = G10_REVIEW, redAtH2 = false }: Scenario): World {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge"), mergeableState: "behind", behind: true });
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  fake.onGetPr = (pr) => {
    const red = redAtH2 && pr.headSha !== H1;
    fake.setRuns(pr.headSha, [successRun("validate", 1, undefined, red ? "failure" : "success"), successRun("dag-check", 2)]);
    if (pr.headSha !== H1) pr.mergeableState = "clean";
  };
  const reviewers = mergingReviewers();
  const carry = { stateDir: mkdtempSync(join(tmpdir(), "merge-up-")), git: scriptedGit(shape) };
  const wake: ShepherdPhases["wake"] = async () => ({ kind: "unhandled", reason: "no fixer in this test" });
  const ref = shepherdStoreRef();
  const review = { dispatch: reviewers.dispatch, reader: reviewers.reader, roles: { g10: "bd-reviewer", standard: "bd-reviewer" }, carry };
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal), review });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake })], routes, gatePollMs: 5 });
  hosts.push(host);
  const store = ref.get();
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO_POLICY) });
  store.register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO_POLICY, kind: "correctness" });
  store.hold(runId, hold);
  return { host, fake, store, runId, spawned: reviewers.spawned };
}

const results = (w: World) => Object.values(w.host.runtime.status(w.runId)!.stepResults);
const stepIds = (w: World): string[] => results(w).map((result) => result.stepId);
const resultOf = (w: World, stepId: string): unknown => results(w).find((result) => result.stepId === stepId)?.data?.["result"];
const h2 = (w: World): string => w.fake.pr(1).headSha;
/** The run reached the merge decision at H2, a gate, or a held run's wait for its seat, and went no further. */
const settledAtH2 = (w: World): boolean => h2(w) !== H1 && (/^(merge|sh-held-wait)(:|$)/.test(w.host.runtime.status(w.runId)?.currentStep ?? "") || w.host.pendingGates().length > 0);

describe("a verdict carried across Shepherd's own clean merge-up of main", () => {
  it("carries the MERGE to H2 with no fresh review, records the rule, and releases the g10-review hold at H2", async () => {
    const w = heldBehindRun({});

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), { timeout: 5_000 });

    expect(w.spawned).toHaveLength(1);
    expect(resultOf(w, `${MERGE_UP_STEP}:${h2(w)}`)).toMatchObject({ rule: MERGE_UP_RULE, fromHead: H1, head: h2(w), base: MAIN });
    expect(resultOf(w, `${G10_RELEASE_STEP}:${h2(w)}:0`)).toMatchObject({ released: true, head: h2(w), verdict: { head: H1 } });
    expect(w.store.byRun(w.runId)?.held).toBe(false);
  });

  it("never releases a g10-adversary hold: the MERGE carries but the seat releases", async () => {
    const w = heldBehindRun({ hold: G10_ADVERSARY });

    await vi.waitFor(() => expect(settledAtH2(w)).toBe(true), { timeout: 5_000 });

    expect(w.spawned).toHaveLength(1);
    expect(stepIds(w).filter((id) => id.startsWith(`${G10_RELEASE_STEP}:${h2(w)}`))).toEqual([]);
    expect(w.store.byRun(w.runId)).toMatchObject({ held: true, holdReason: G10_ADVERSARY });
    expect(w.fake.pr(1).merged).toBe(false);
  });
});

describe("a head move that is not a clean merge-up", () => {
  it.each(["conflict-resolved", "extra-commit"] as const)("spends a fresh review at H2 after a %s merge", async (shape) => {
    const w = heldBehindRun({ shape });

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), { timeout: 5_000 });

    expect(w.spawned).toHaveLength(2);
    expect(stepIds(w)).toContain(`sh-review-intent:${h2(w)}`);
    expect(stepIds(w).filter((id) => id.startsWith(MERGE_UP_STEP))).toEqual([]);
  });

  it("neither carries nor releases while CI at H2 is red", async () => {
    const w = heldBehindRun({ redAtH2: true });

    await vi.waitFor(() => expect(settledAtH2(w)).toBe(true), { timeout: 5_000 });

    expect(stepIds(w).filter((id) => id.startsWith(MERGE_UP_STEP) || id.startsWith(`${G10_RELEASE_STEP}:${h2(w)}`))).toEqual([]);
    expect(w.store.byRun(w.runId)).toMatchObject({ held: true, holdReason: G10_REVIEW });
    expect(w.fake.pr(1).merged).toBe(false);
  });
});
