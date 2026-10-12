import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { StepResult } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { HEAD_ORIGIN_STEP, UNREAD_ORIGIN, classifyHead } from "./head-origin.js";
import type { ShepherdPhases, Verdict } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef } from "./store.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const PREVIOUS = fakeSha("previous-head");
const HEAD = fakeSha("new-head");
const ON_BASE = fakeSha("on-base");
const OFF_BASE = fakeSha("off-base");

function withHead(parents: string[]): FakeGitHub {
  const fake = fakeGitHub();
  fake.commits.set(HEAD, { sha: HEAD, parents, tree: fakeSha("tree") });
  return fake;
}

const classify = (fake: FakeGitHub) => classifyHead(githubPort(fake.wire), { repo: REPO, fromHead: PREVIOUS, head: HEAD, baseRef: "main" });

describe("classifyHead", () => {
  it("reads a merge of a base commit onto the previous head as merge-of-base", async () => {
    const fake = withHead([PREVIOUS, ON_BASE]);
    fake.compares.set(`${ON_BASE}...main`, { mergeBaseSha: ON_BASE, files: [] });

    expect(await classify(fake)).toEqual({ head: HEAD, kind: "merge-of-base" });
  });

  it("reads a merge whose second parent is not on the base as merge-other", async () => {
    const fake = withHead([PREVIOUS, OFF_BASE]);
    fake.compares.set(`${OFF_BASE}...main`, { mergeBaseSha: fakeSha("older-base"), files: [] });

    expect(await classify(fake)).toEqual({ head: HEAD, kind: "merge-other" });
  });

  it("reads a rebase-then-merge, whose first parent is not the previous head, as merge-other", async () => {
    const fake = withHead([fakeSha("rebased"), ON_BASE]);
    fake.compares.set(`${ON_BASE}...main`, { mergeBaseSha: ON_BASE, files: [] });

    expect(await classify(fake)).toEqual({ head: HEAD, kind: "merge-other" });
  });

  it("reads a one-parent head as a push", async () => {
    expect(await classify(withHead([PREVIOUS]))).toEqual({ head: HEAD, kind: "push" });
  });

  it("answers unknown with a fixed reason when the commit read fails", async () => {
    const port = { getCommit: async () => Promise.reject(new Error("HTTP 502 from api.github.com")), compareFiles: async () => Promise.reject(new Error("unreached")) };

    expect(await classifyHead(port, { repo: REPO, fromHead: PREVIOUS, head: HEAD, baseRef: "main" })).toEqual({ head: HEAD, kind: "unknown", reason: UNREAD_ORIGIN });
  });
});

const MERGED_MAIN = fakeSha("seat-merged-main");

/** H1 is sent back; the woken agent pushes a merge of main onto it, and every later head is MERGE behind the owner gate. */
function sentBackThenMergedMain(fake: FakeGitHub): ShepherdPhases {
  return {
    review: async (_ctx, request): Promise<Verdict> => (request.headSha === H1 ? { kind: "FIX_FIRST", headSha: H1, text: "synthetic finding" } : { kind: "MERGE", headSha: request.headSha, evidence: {} }),
    wake: async () => {
      fake.commits.set(MERGED_MAIN, { sha: MERGED_MAIN, parents: [H1, fake.refs.get("main")!], tree: fakeSha("merged-tree") });
      fake.pushHead(1, MERGED_MAIN);
      return { kind: "woken", agent: "impl-a" };
    },
  };
}

/** Main's CI after the merge reads green, so a merged run completes. */
function openHost(fake: FakeGitHub, phases: ShepherdPhases, dbPath = ":memory:"): FactoryHost {
  const base = githubPort(fake.wire);
  const port = { ...base, checkRuns: async (repo: string, sha: string) => (sha === fake.pr(1).mergeSha && fake.setRuns(sha, [successRun("validate", 9), successRun("dag-check", 10)]), base.checkRuns(repo, sha)) };
  const routes = factoryRoutesFor({ port, store: shepherdStoreRef(), now: () => 0, sleep: async (_ms, signal) => sleep(1, signal) });
  const host = openFactoryHost({ dbPath, workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  return host;
}

const origins = (host: FactoryHost, runId: string): StepResult[] => Object.values(host.runtime.status(runId)!.stepResults).filter((result) => result.stepId === HEAD_ORIGIN_STEP);

describe("a shepherd-pr run whose head moves", () => {
  it("records no head origin for the head Shepherd's own update-branch made", async () => {
    const fake = fakeGitHub();
    fake.addPr({ headSha: H1, mergeableState: "behind", behind: true });
    fake.onGetPr = (pr) => {
      fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
      if (pr.headSha !== H1) pr.mergeableState = "clean";
    };
    const host = openHost(fake, { review: async () => ({ kind: "none", cause: "no-verdict" }), wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }) });

    const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
    await gateOpened(host, gateId(runId, "approve-merge"));

    expect(fake.effects.updateBranch).toBe(1);
    expect(origins(host, runId)).toEqual([]);
  });

  it("records one merge-of-base for a merge of main another agent pushed, and a restart replays it without another", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tp2080-")), "factory.db");
    const fake = fakeGitHub();
    fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge") });
    fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
    const first = openHost(fake, sentBackThenMergedMain(fake), dbPath);
    const runId = first.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
    await gateOpened(first, gateId(runId, "approve-merge"));
    const recorded = origins(first, runId);
    first.close();

    const second = openHost(fake, sentBackThenMergedMain(fake), dbPath);
    await second.adopt();
    second.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: MERGED_MAIN }, OWNER);
    await second.runtime.wait(runId);

    expect(recorded).toEqual([expect.objectContaining({ data: expect.objectContaining({ result: { head: MERGED_MAIN, kind: "merge-of-base" } }) })]);
    expect(origins(second, runId)).toEqual(recorded);
    expect(fake.pr(1).merged).toBe(true);
  });
});
