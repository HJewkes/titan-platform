import { fakeGitHub, fakeSha, githubPort } from "@titan-design/github";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { WorkflowRunStore, workflowDefinitionVersionMigration, workflowMigration, workflowOwnershipMigration, type RoutedStepInput, type StepRoute, type WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import type { HeldCheck } from "./hold.js";
import { stepName } from "./stats.js";
import { disjointVerdict } from "./train-shadow-disjoint.js";
import { shadowRefresh, shadowsIn, trainShadowMigration, trainShadowRef, type ShadowDeps } from "./train-shadow.js";

const REPO = "acme/widgets";
const AT = "2026-09-15T10:00:00.000Z";
const HEAD = { 1: fakeSha("shadow-self"), 2: fakeSha("shadow-train"), 3: fakeSha("shadow-held"), 4: fakeSha("shadow-stacked") } as const;
const UPDATE_OK = { ok: true as const, output: "{}" };

type Step = [key: string, payload: Record<string, unknown>];

function result(key: string, payload: Record<string, unknown>, i: number): WorkflowRun["stepResults"][string] {
  return { stepId: stepName(key), iteration: i, agentId: null, signal: null, completedAt: new Date(Date.parse(AT) + i * 1000).toISOString(), data: { result: payload } };
}

function run(pr: number, steps: Step[], active: string, repo = REPO): WorkflowRun {
  const stepResults = Object.fromEntries(steps.map(([key, payload], i) => [key, result(key, payload, i)]));
  const activeSteps = { [active]: { kind: "legacy" as const, stepId: active, iterKey: active, attempt: 1, startedAt: AT } };
  return { id: `run-${pr}`, workflowName: "shepherd-pr", params: { repo, pr: String(pr) }, status: "running", currentStep: active, stepResults, activeSteps, revision: 0, ownerGeneration: 0, startedAt: AT, completedAt: null, error: null };
}

/** A green head whose base moved, as `ci-wait` reports it right before a land-time refresh. */
const stale = (head: string): Step => ["ci-wait:0", { verdict: "behind", headSha: head, checksGreen: true, baseMoved: true }];

interface World {
  db: Db;
  deps: ShadowDeps;
  updates: number;
}

/**
 * Four runs in one repo: #1 refreshes now, #2 waits at the train, #3 waits on its refresh CI but is held, and #4
 * refreshes on a stacked base. Only #2 is a peer a batch would take.
 */
function world(): World {
  const db = openDatabase(":memory:");
  runMigrations(db, [workflowMigration(1), workflowOwnershipMigration(2), workflowDefinitionVersionMigration(3), trainShadowMigration(4)]);
  const fake = fakeGitHub({ repo: REPO });
  for (const pr of [1, 2, 3, 4] as const) fake.addPr({ headSha: HEAD[pr], ...(pr === 4 ? { baseRef: "stack/parent" } : {}) });
  fake.prFiles.set(1, [{ path: "packages/a/src/index.ts", status: "modified" }]);
  fake.compares.set(`${HEAD[1]}...main`, { mergeBaseSha: fakeSha("fork"), files: ["packages/b/src/index.ts"] });
  const runs = new WorkflowRunStore(db);
  runs.create(run(1, [stale(HEAD[1])], "update-branch:0"));
  runs.create(run(2, [["ci-wait:0", { verdict: "green", headSha: HEAD[2] }]], "merge:0"));
  runs.create(run(3, [stale(fakeSha("held-before")), ["update-branch:0", { headSha: HEAD[3], own: true }]], "ci-wait:1"));
  runs.create(run(4, [stale(HEAD[4])], "update-branch:0"));
  const shadow = trainShadowRef();
  shadow.bind(db);
  const held: HeldCheck = async (_repo, pr) => (pr === 3 ? "g10-review: waiting on the adversary" : undefined);
  const port = githubPort(fake.wire);
  return { db, updates: 0, deps: { shadow, port, reads: port, held, advisory: () => false, now: () => Date.parse(AT) } };
}

function updateRoute(w: World): StepRoute {
  return { match: "update-branch", onRestart: "repeat", runner: { run: async () => (w.updates++, UPDATE_OK) } };
}

const input = (pr: number, stepId = "update-branch:0"): RoutedStepInput => ({ runId: `run-${pr}`, workflowName: "shepherd-pr", stepId, iteration: 0, prompt: JSON.stringify({ repo: REPO, pr, expectedHeadSha: HEAD[1] }), signal: new AbortController().signal, attempt: 1, requestKey: `k-${pr}` });

describe("the merge-train shadow at a land-time refresh", () => {
  it("admits only the trusted peer that is neither held nor stacked", async () => {
    const w = world();

    const outcome = await shadowRefresh(updateRoute(w), w.deps).runner.run(input(1));

    expect(outcome).toEqual(UPDATE_OK);
    const [row, ...rest] = shadowsIn(w.db);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ runId: "run-1", pr: 1, headSha: HEAD[1], disjoint: "units-disjoint" });
    expect(row?.selfExcluded).toBeUndefined();
    expect(row?.peers).toEqual([{ runId: "run-2", pr: 2, headSha: HEAD[2], stage: "train" }]);
    expect(row?.excluded).toEqual([
      { runId: "run-3", pr: 3, headSha: HEAD[3], reason: "held" },
      { runId: "run-4", pr: 4, headSha: HEAD[4], reason: "stacked" },
    ]);
  });

  it("marks a stacked run's own refresh as one no batch would take", async () => {
    const w = world();

    await shadowRefresh(updateRoute(w), w.deps).runner.run(input(4));

    expect(shadowsIn(w.db)[0]).toMatchObject({ pr: 4, selfExcluded: "stacked" });
  });

  it("records a step repeated after a crash once", async () => {
    const w = world();
    const route = shadowRefresh(updateRoute(w), w.deps);

    await route.runner.run(input(1));
    await route.runner.run(input(1));

    expect(shadowsIn(w.db)).toHaveLength(1);
    expect(w.updates).toBe(2);
  });

  it("records nothing for an update that is not a land-time refresh", async () => {
    const w = world();
    new WorkflowRunStore(w.db).create(run(5, [["ci-wait:0", { verdict: "behind", headSha: fakeSha("strict") }]], "update-branch:0"));

    await shadowRefresh(updateRoute(w), w.deps).runner.run(input(5));

    expect(shadowsIn(w.db)).toEqual([]);
    expect(w.updates).toBe(1);
  });

  it("still updates when the shadow cannot be recorded", async () => {
    const w = world();
    const unbound = { ...w.deps, shadow: trainShadowRef() };

    const outcome = await shadowRefresh(updateRoute(w), unbound).runner.run(input(1));

    expect(outcome).toEqual(UPDATE_OK);
    expect(w.updates).toBe(1);
  });
});

describe("the shadow's disjoint verdict", () => {
  it.each([
    { pr: ["packages/a/src/x.ts"], delta: ["packages/b/src/y.ts"], verdict: "units-disjoint" },
    { pr: ["packages/a/src/x.ts"], delta: ["packages/a/src/z.ts"], verdict: "overlap" },
    { pr: ["packages/a/src/x.ts"], delta: ["pnpm-lock.yaml"], verdict: "shared" },
    { pr: ["packages/a/src/x.ts"], delta: [".github/workflows/ci.yml"], verdict: "shared" },
    { pr: ["packages/a/package.json"], delta: ["products/b/src/y.ts"], verdict: "shared" },
    { pr: ["README.md"], delta: ["products/b/src/y.ts"], verdict: "shared" },
  ])("$pr against $delta is $verdict", ({ pr, delta, verdict }) => {
    expect(disjointVerdict(pr, delta)).toBe(verdict);
  });
});
