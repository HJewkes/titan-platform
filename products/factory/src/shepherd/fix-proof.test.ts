import { TEST_CLASSES, formatResultLine, type FixProofResult } from "@titan-design/fix-proof";
import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import type { StepRoute } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { defineWorkflow } from "../definition.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { shepherdEventMigration } from "./events.js";
import { FIX_PROOF_CHECK, lastResultLine, readFixProof } from "./fix-proof.js";
import type { ShepherdDeps, Verdict } from "./phases.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { REVIEW_STEPS, reviewPhase, reviewRoutes, type ReviewerAgent, type ReviewerDispatch, type ReviewerMessage, type ReviewerReader } from "./review.js";
import { holdReviewerMigration, holdSatisfiedMigration, shepherdMigration, shepherdStoreRef, sliceMigration } from "./store.js";

const REPO = "octo/demo";
const H = fakeSha("fix-proof-head");
const OLD = fakeSha("fix-proof-older-head");
const BASE = fakeSha("fix-proof-base");
const AUTO: EffectivePolicy = { merge: "auto", mergeMethod: "squash", fixer: true, seat: "trusted-seat" };
const FIX_PROOF_JOB = 77;
const OTHER_APP = 424242;

function resultLine(head: string, verdict: FixProofResult["verdict"]): string {
  const counts = Object.fromEntries(TEST_CLASSES.map((name) => [name, 0])) as FixProofResult["counts"];
  if (verdict === "reproduced") counts.reproduces = 1;
  return formatResultLine({ head, mergeBase: BASE, verdict, counts, notCollected: [], deletedTests: [], configEdited: false, tests: [], truncated: false });
}

/** A job log as GitHub serves it: each line behind an Actions timestamp. */
const actionsLog = (...lines: string[]) => ["Run pnpm fix-proof", ...lines, "Post job cleanup."].map((line) => `2026-10-11T12:00:00.0000000Z ${line}`).join("\n");

const locatorIn = (nativeId: string): SourceTextLocator => ({
  source: {
    sourceId: nativeId,
    harness: "claude-code",
    format: "jsonl",
    formatVersion: null,
    path: `${nativeId}.jsonl`,
    namespace: "test",
    conversation: { harness: "claude-code", namespace: "test", nativeId },
    provenance: { kind: "claude-code-transcript", legacySessionId: nativeId },
  },
  evidence: {
    line: { sourceId: nativeId, byteOffset: 0, byteLength: 0, contentHash: "", lineNumber: null, nativeOrdinal: null },
    subrecord: { index: 0, path: [] },
  },
  selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] },
});

const fixProofRun = (overrides: Partial<CheckRun> = {}): CheckRun => ({ ...successRun(FIX_PROOF_CHECK, FIX_PROOF_JOB), headSha: H, ...overrides });

interface Scene {
  kind?: string;
  branch?: string;
  runs?: CheckRun[];
  log?: string;
}

function fakeDispatch(): ReviewerDispatch & { agents: ReviewerAgent[]; spawns: { name: string; brief: string }[] } {
  const fake = {
    agents: [] as ReviewerAgent[],
    spawns: [] as { name: string; brief: string }[],
    roster: async () => [...fake.agents],
    spawn: async (name: string, brief: string) => {
      fake.spawns.push({ name, brief });
      fake.agents.push({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence: "live", spawnedBy: null, predecessor: null });
    },
    resume: async () => undefined,
  };
  return fake;
}

describe("sh-fix-proof in reviewPhase", () => {
  const hosts: FactoryHost[] = [];
  afterEach(() => hosts.splice(0).forEach((host) => host.close()));

  async function review(scene: Scene) {
    const fake = fakeGitHub();
    fake.addPr({ headSha: H, mergeSha: fakeSha("fix-proof-merge") });
    fake.setRuns(H, [successRun("validate", 1), successRun("dag-check", 2), ...(scene.runs ?? [])]);
    if (scene.log !== undefined) fake.jobLogs.set(FIX_PROOF_JOB, scene.log);
    fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
    let clock = 10_000;
    const store = shepherdStoreRef();
    const deps: ShepherdDeps = { port: githubPort(fake.wire), store, now: () => clock, sleep: async (ms) => void (clock += ms), pollMs: 1_000, agentChatBin: "agent-chat", reviewCheckouts: { root: "/data/reviews", remove: async () => undefined } };
    const dispatch = fakeDispatch();
    const said = (who: ReviewerAgent): ReviewerMessage => ({ agentId: who.agentId, sessionId: who.sessionId, writtenAt: clock + 1, text: `Verdict: MERGE\nPR: ${REPO}#1\nHead: ${H}\n`, locator: locatorIn(who.sessionId) });
    const reader: ReviewerReader = { read: async (input) => dispatch.agents.filter((who) => who.agentId === input.reviewerAgentId).map(said) };
    const verdicts: Verdict[] = [];
    const inputs: Record<string, unknown> = {};
    const recorded = reviewRoutes(deps, { reader, dispatch, timeoutMs: 5_000 }).map((route): StepRoute => ({ ...route, runner: { run: (step) => ((inputs[step.stepId] = JSON.parse(step.prompt)), route.runner.run(step)) } }));
    const routes = Object.assign(recorded, { database: { extraMigrations: [shepherdMigration(4), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16)], bind: store.bind } });
    const run = async (ctx: Parameters<typeof reviewPhase>[0]) => void verdicts.push(await reviewPhase(ctx, { repo: REPO, pr: 1, round: 0, headSha: H }));
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [defineWorkflow({ name: "fix-proof-test", steps: REVIEW_STEPS, run })], routes, gatePollMs: 5 });
    hosts.push(host);
    const runId = host.runtime.start("fix-proof-test", { policy: JSON.stringify(AUTO) });
    store.get().register({ repo: REPO, pr: 1, runId, task: "demo: fix the parser", implementer: "impl-a", policy: OWNER_GATE_POLICY, ...(scene.kind && { kind: scene.kind }), ...(scene.branch && { branch: scene.branch }) });
    await host.runtime.wait(runId);
    const results = Object.values(host.runtime.status(runId)!.stepResults);
    const proof = (results.find((result) => result.stepId === `sh-fix-proof:${H}`)?.data as { result?: unknown } | undefined)?.result;
    return { verdicts, spawns: dispatch.spawns, stepIds: results.map((result) => result.stepId), proof, inputs };
  }

  it("ends a correctness PR with a vacuous proof at its head as NO_REPRO before any reviewer is spawned", async () => {
    const line = resultLine(H, "vacuous");

    const { verdicts, spawns, stepIds } = await review({ kind: "correctness", runs: [fixProofRun()], log: actionsLog(line) });

    expect(verdicts).toEqual([{ kind: "NO_REPRO", headSha: H, result: expect.objectContaining({ head: H, verdict: "vacuous" }) }]);
    expect(spawns).toEqual([]);
    expect(stepIds).toEqual([`sh-fix-proof:${H}`]);
  });

  it("ends a security PR whose proof found no tests as NO_REPRO", async () => {
    const { verdicts, spawns } = await review({ kind: "security", runs: [fixProofRun()], log: actionsLog(resultLine(H, "no-tests")) });

    expect(verdicts).toMatchObject([{ kind: "NO_REPRO", headSha: H, result: { verdict: "no-tests" } }]);
    expect(spawns).toEqual([]);
  });

  it("ignores a vacuous line naming an older head and reviews on this head's reproduced line", async () => {
    const reproduced = resultLine(H, "reproduced");

    const { verdicts, spawns, proof } = await review({ kind: "correctness", runs: [fixProofRun()], log: actionsLog(reproduced, resultLine(OLD, "vacuous")) });

    expect(proof).toEqual({ kind: "result", line: reproduced, verdict: "reproduced" });
    expect(verdicts).toMatchObject([{ kind: "MERGE", headSha: H }]);
    expect(spawns).toHaveLength(1);
  });

  it("ignores a fix-proof check run posted by another app, so its vacuous log cannot stop the review", async () => {
    const { verdicts, spawns, proof } = await review({ kind: "correctness", runs: [fixProofRun({ appId: OTHER_APP })], log: actionsLog(resultLine(H, "vacuous")) });

    expect(proof).toMatchObject({ kind: "missing" });
    expect(verdicts).toMatchObject([{ kind: "MERGE" }]);
    expect(spawns).toHaveLength(1);
  });

  it("skips the gate for a feature PR, so even a vacuous proof at the head reaches a reviewer", async () => {
    const { verdicts, spawns, proof } = await review({ kind: "feature", runs: [fixProofRun()], log: actionsLog(resultLine(H, "vacuous")) });

    expect(proof).toEqual({ kind: "skipped", reason: "kind feature" });
    expect(verdicts).toMatchObject([{ kind: "MERGE" }]);
    expect(spawns).toHaveLength(1);
  });

  it("runs the gate for a fix/ branch registered with kind feature", async () => {
    const { verdicts, spawns } = await review({ kind: "feature", branch: "fix/parser", runs: [fixProofRun()], log: actionsLog(resultLine(H, "vacuous")) });

    expect(verdicts).toMatchObject([{ kind: "NO_REPRO", headSha: H }]);
    expect(spawns).toEqual([]);
  });

  it("proceeds to review with the reason recorded when the head has no fix-proof check run", async () => {
    const { verdicts, spawns, proof, inputs } = await review({ kind: "correctness" });

    expect(proof).toEqual({ kind: "missing", reason: expect.stringContaining("no fix-proof check run") });
    expect(verdicts).toMatchObject([{ kind: "MERGE" }]);
    expect(spawns).toHaveLength(1);
    expect(inputs[`sh-review:${H}`]).not.toHaveProperty("fixProof");
  });

  it("hands a reproduced line at the head to the reviewer brief", async () => {
    const line = resultLine(H, "reproduced");

    const { spawns, inputs } = await review({ kind: "correctness", runs: [fixProofRun()], log: actionsLog(line) });

    expect(inputs[`sh-review:${H}`]).toMatchObject({ fixProof: line });
    expect(spawns[0]?.brief).toContain("fix-proof/v1 verdict for this head: reproduced");
  });
});

describe("readFixProof", () => {
  const signal = new AbortController().signal;

  function registered(kind: string, runs: CheckRun[]) {
    const fake = fakeGitHub();
    fake.setRuns(H, runs);
    fake.jobLogs.set(FIX_PROOF_JOB, actionsLog(resultLine(H, "vacuous")));
    const db = openDatabase(":memory:");
    runMigrations(db, [shepherdMigration(4), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16)]);
    const store = shepherdStoreRef();
    store.bind(db);
    store.get().register({ repo: REPO, pr: 1, runId: "run-1", task: "demo: tidy", implementer: "impl-a", policy: OWNER_GATE_POLICY, kind });
    let clock = 0;
    const timing = { now: () => clock, sleep: async (ms: number) => void (clock += ms), pollMs: 1_000, timeoutMs: 10_000 };
    return { fake, read: () => readFixProof({ port: githubPort(fake.wire), store }, { repo: REPO, head: H, runId: "run-1" }, timing, signal) };
  }

  it("makes no GitHub call for a kind outside the gate", async () => {
    const { fake, read } = registered("refactor", [fixProofRun()]);

    expect(await read()).toEqual({ kind: "skipped", reason: "kind refactor" });
    expect(fake.calls).toEqual([]);
  });

  it("gives up as missing at the deadline while the fix-proof run is still in progress", async () => {
    const { read } = registered("correctness", [fixProofRun({ status: "in_progress", conclusion: null })]);

    expect(await read()).toEqual({ kind: "missing", reason: expect.stringContaining("before the deadline") });
  });
});

describe("lastResultLine", () => {
  it("takes the last line that parses and names the head, skipping a later malformed one", () => {
    const first = resultLine(H, "vacuous");
    const second = resultLine(H, "reproduced");

    expect(lastResultLine(actionsLog(first, second, second.slice(0, -1)), H)).toBe(second);
  });

  it("finds nothing when every line names another head", () => {
    expect(lastResultLine(actionsLog(resultLine(OLD, "vacuous")), H)).toBeUndefined();
  });
});
