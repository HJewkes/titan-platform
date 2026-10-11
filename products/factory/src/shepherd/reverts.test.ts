import { FakeHttpError, fakeGitHub, fakeSha, githubPort } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { WorkflowRunStore, workflowMigration, workflowOwnershipMigration, type WorkflowRun } from "@titan-design/workflow";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openFactoryHost } from "../host.js";
import { factoryRoutes, factoryWorkflows } from "../workflows.js";
import type { ShepherdServices } from "./commands.js";
import { REVERTED_STEP, markRevertedRuns, revertOf, sweepReverts, type RevertDeps } from "./reverts.js";
import { redAfterMerge } from "./stats-quality.js";

const REPO = "acme/widgets";
const HOUR = 3_600_000;
const T0 = Date.parse("2026-09-15T10:00:00Z");
const iso = (at: number): string => new Date(at).toISOString();
const merge = (pr: number): string => fakeSha(`merge-${pr}`);

function step(key: string, at: number, data: Record<string, unknown>): WorkflowRun["stepResults"] {
  return { [key]: { stepId: key.split(":")[0]!, iteration: 0, agentId: null, signal: null, completedAt: iso(at), data: { result: data } } };
}

/** A shepherd-pr run that merged PR `pr` at `at` and read main CI there as `verdict`. */
function mergedRun(pr: number, at: number, verdict: "green" | "red"): WorkflowRun {
  return {
    id: `run-${pr}`,
    workflowName: "shepherd-pr",
    params: { repo: REPO, pr: String(pr) },
    status: "completed",
    currentStep: null,
    stepResults: { ...step("sh-landed:0", at, { repo: REPO, pr, mergeSha: merge(pr) }), ...step("sh-main-ci:0", at + HOUR / 4, { verdict, mergeSha: merge(pr), after: [], detail: "" }) },
    activeSteps: {},
    revision: 0,
    ownerGeneration: 0,
    startedAt: iso(at - HOUR),
    completedAt: iso(at + HOUR / 2),
    error: null,
  };
}

/** One red main CI, one green, and a third merge that a later main commit reverts; a factory database at `dbPath` is already migrated. */
function fixture(dbPath = ":memory:") {
  const db = openDatabase(dbPath);
  if (dbPath === ":memory:") runMigrations(db, [workflowMigration(1), workflowOwnershipMigration(2)]);
  const store = new WorkflowRunStore(db);
  for (const run of [mergedRun(1, T0, "red"), mergedRun(2, T0 + HOUR, "green"), mergedRun(3, T0 + 2 * HOUR, "green")]) store.create(run);
  const fake = fakeGitHub();
  fake.history.push(
    { sha: merge(1), message: "Fix the parser (#1)", committedAt: iso(T0) },
    { sha: merge(2), message: "Add a widget (#2)", committedAt: iso(T0 + HOUR) },
    { sha: merge(3), message: "Speed up the cache (#3)", committedAt: iso(T0 + 2 * HOUR) },
    { sha: fakeSha("revert-3"), message: `Revert "Speed up the cache (#3)"\n\nThis reverts commit ${merge(3)}.`, committedAt: iso(T0 + 5 * HOUR) },
  );
  const deps = (now = T0 + 6 * HOUR): RevertDeps => ({
    runs: store.listByStatus(["completed"]),
    port: githubPort(fake.wire),
    mark: (runId, data) => void store.annotate(runId, REVERTED_STEP, { stepId: REVERTED_STEP, iteration: 0, agentId: null, signal: null, completedAt: iso(now), data }),
    now,
  });
  return { store, fake, deps, close: () => db.close() };
}

describe("sweepReverts", () => {
  it("marks exactly the run whose merge a later main commit reverts, with the reverting sha", async () => {
    const { store, deps } = fixture();

    const sweep = await sweepReverts(deps());

    expect(sweep).toEqual({ reverted: [{ runId: "run-3", repo: REPO, pr: 3, mergeSha: merge(3), revertSha: fakeSha("revert-3") }], errors: [] });
    expect(store.listByStatus(["completed"]).filter((run) => run.stepResults[REVERTED_STEP]).map((run) => run.id)).toEqual(["run-3"]);
    expect(store.get("run-3")!.stepResults[REVERTED_STEP]!.data).toEqual({ mergeSha: merge(3), revertSha: fakeSha("revert-3") });
  });

  it("reads each repo's main once per sweep, from the earliest merge it still watches", async () => {
    const { fake, deps } = fixture();

    await sweepReverts(deps());

    expect(fake.calls.filter((call) => call === "listCommits")).toHaveLength(1);
  });

  it("leaves a marked run out of the next sweep", async () => {
    const { deps } = fixture();
    await sweepReverts(deps());

    expect((await sweepReverts(deps())).reverted).toEqual([]);
  });

  it("stops looking once every merge is older than the revert window", async () => {
    const { fake, deps } = fixture();

    expect(await sweepReverts(deps(T0 + 30 * 24 * HOUR))).toEqual({ reverted: [], errors: [] });
    expect(fake.calls).not.toContain("listCommits");
  });

  it("reports a repo whose main cannot be read and marks nothing there", async () => {
    const { deps } = fixture();
    const failing = { ...deps(), port: { listDefaultBranchCommits: () => Promise.reject(new FakeHttpError(502, "bad gateway")) } };

    expect(await sweepReverts(failing)).toEqual({ reverted: [], errors: [{ repo: REPO, cause: "HTTP 502" }] });
  });
});

describe("markRevertedRuns", () => {
  it("marks the reverted run in the host's ledger, and a dry run marks nothing", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "reverts-")), "factory.db");
    openFactoryHost({ dbPath, workflows: factoryWorkflows, routes: factoryRoutes() }).close();
    const { fake, close } = fixture(dbPath);
    const host = openFactoryHost({ dbPath, workflows: factoryWorkflows, routes: factoryRoutes() });
    const services = { port: githubPort(fake.wire) } as ShepherdServices;
    const now = () => T0 + 6 * HOUR;

    const dry = await markRevertedRuns(host, services, { dryRun: true, now });
    const marked = await markRevertedRuns(host, services, { now });

    expect(dry.reverted.map((run) => run.runId)).toEqual(["run-3"]);
    expect(marked.reverted.map((run) => run.runId)).toEqual(["run-3"]);
    expect(host.runtime.list(["completed"]).filter((run) => run.stepResults[REVERTED_STEP]).map((run) => run.id)).toEqual(["run-3"]);
    expect((await markRevertedRuns(host, services, { now })).reverted).toEqual([]);
    host.close();
    close();
  });
});

describe("revertOf", () => {
  const MERGE = fakeSha("m");
  const merged = { sha: MERGE, message: "Add retries (#7)\n\nbody" };

  it("matches a squashed revert PR by its title alone", () => {
    const revert = { sha: fakeSha("r"), message: `Revert "Add retries (#7)" (#9)\n\nReverts acme/widgets#7` };

    expect(revertOf(MERGE, [revert, merged])).toEqual(revert);
  });

  it("matches a body line naming the merge sha, abbreviated or not", () => {
    const revert = { sha: fakeSha("r"), message: `Back out retries\n\nThis reverts commit ${MERGE.slice(0, 12)}.` };

    expect(revertOf(MERGE, [revert])).toEqual(revert);
  });

  it("does not take a revert of a revert, or a revert of another commit, for one of the merge", () => {
    const other = { sha: fakeSha("o"), message: `Revert "Add retries (#8)"\n\nThis reverts commit ${fakeSha("x")}.` };
    const twice = { sha: fakeSha("t"), message: `Revert "Revert "Add retries (#7)""` };

    expect(revertOf(MERGE, [twice, other, merged])).toBeUndefined();
  });
});

describe("redAfterMerge over the fixture", () => {
  it("counts the one red main CI of three merged runs, and the one revert", async () => {
    const { store, deps } = fixture();
    await sweepReverts(deps());

    expect(redAfterMerge(store.listByStatus(["completed"]))).toEqual([{ repo: REPO, week: "2026-W38", merged: 3, red: 1, rate: 0.333, redPrs: [1], reverted: 1, revertedPrs: [3] }]);
  });
});
