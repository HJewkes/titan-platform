import { formatResultLine, type FixProofResult } from "@titan-design/fix-proof";
import { fakeGitHub, fakeSha, ghCliWire, githubPort, successRun, type CheckRun, type FakeGitHub, type GitHubPort, type PrFile } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import type { StepRoute } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { defineWorkflow } from "../definition.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { shepherdEventMigration } from "./events.js";
import { FIX_PROOF_CHECK, FixProofReadSchema, fixProofStanding, lastResultLine, readFixProof } from "./fix-proof.js";
import type { ShepherdDeps, Verdict } from "./phases.js";
import { MERGE_ON_GREEN_GRANT, OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { REVIEW_STEPS, reviewPhase, reviewRoutes, type ReviewerAgent, type ReviewerDispatch, type ReviewerMessage, type ReviewerReader } from "./review.js";
import { holdReviewerMigration, holdSatisfiedMigration, holdSlotsMigration, shepherdMigration, shepherdStoreRef, sliceMigration } from "./store.js";

const REPO = "octo/demo";
const H = fakeSha("fix-proof-head");
const OLD = fakeSha("fix-proof-older-head");
const BASE = fakeSha("fix-proof-base");
const AUTO: EffectivePolicy = { merge: "auto", mergeMethod: "squash", fixer: true, seat: "trusted-seat" };
const FIX_PROOF_JOB = 77;
const OTHER_APP = 424242;
const UNVERIFIED_BRIEF = "Shepherd marks this head's fix-proof unverified";
const WORKFLOW_EDIT: PrFile = { path: ".github/workflows/fix-proof.yml", status: "modified" };

/** The fake PR's base is `main`, so this is the repo running fix-proof on every PR into it. */
const addWorkflowAtBase = (fake: FakeGitHub) => fake.files.set(`main:${WORKFLOW_EDIT.path}`, { content: "name: fix-proof\n", blobSha: "w1" });

function resultLine(head: string, verdict: FixProofResult["verdict"]): string {
  const counts: FixProofResult["counts"] = { reproduces: verdict === "reproduced" ? 1 : 0, "passes-on-base": 0, "new-api": 0, "fails-on-head": 0, "not-run": 0 };
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

const execRun = (name: string, id: number, overrides: Partial<CheckRun> = {}): CheckRun => ({ ...successRun(name, id), headSha: H, ...overrides });
const execRuns = (overrides: Partial<CheckRun> = {}): CheckRun[] => [execRun("fix-proof-base", 81, overrides), execRun("fix-proof-head", 82, overrides)];
const execPending = (): CheckRun[] => execRuns({ status: "in_progress", conclusion: null });

const fixProofRun = (overrides: Partial<CheckRun> = {}): CheckRun => ({ ...successRun(FIX_PROOF_CHECK, FIX_PROOF_JOB), headSha: H, pullRequests: [{ number: 1, baseRef: "main" }], ...overrides });

interface Scene {
  kind?: string;
  branch?: string;
  headRef?: string;
  runs?: CheckRun[];
  log?: string;
  files?: PrFile[];
  external?: string;
  workflow?: boolean;
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
    fake.addPr({ headSha: H, mergeSha: fakeSha("fix-proof-merge"), ...(scene.headRef && { headRef: scene.headRef }) });
    fake.setRuns(H, [successRun("validate", 1), successRun("dag-check", 2), ...(scene.runs ?? [])]);
    if (scene.log !== undefined) fake.jobLogs.set(FIX_PROOF_JOB, scene.log);
    fake.prFiles.set(1, scene.files ?? [{ path: "src/a.ts", status: "modified" }]);
    if (scene.workflow) addWorkflowAtBase(fake);
    let clock = 10_000;
    const store = shepherdStoreRef();
    const deps: ShepherdDeps = { port: githubPort(fake.wire), store, now: () => clock, sleep: async (ms) => void (clock += ms), pollMs: 1_000, agentChatBin: "agent-chat", reviewCheckouts: { root: "/data/reviews", remove: async () => undefined } };
    const dispatch = fakeDispatch();
    if (scene.external) dispatch.agents.push({ name: scene.external, agentId: `agent-${scene.external}`, sessionId: `session-${scene.external}`, presence: "live", spawnedBy: null, predecessor: null });
    const said = (who: ReviewerAgent): ReviewerMessage => ({ agentId: who.agentId, sessionId: who.sessionId, writtenAt: clock + 1, text: `Verdict: MERGE\nPR: ${REPO}#1\nHead: ${H}\n`, locator: locatorIn(who.sessionId) });
    const reader: ReviewerReader = { read: async (input) => dispatch.agents.filter((who) => who.agentId === input.reviewerAgentId).map(said) };
    const verdicts: Verdict[] = [];
    const inputs: Record<string, unknown> = {};
    const recorded = reviewRoutes(deps, { reader, dispatch, timeoutMs: 5_000 }).map((route): StepRoute => ({ ...route, runner: { run: (step) => ((inputs[step.stepId] = JSON.parse(step.prompt)), route.runner.run(step)) } }));
    const routes = Object.assign(recorded, { database: { extraMigrations: [shepherdMigration(4), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19)], bind: store.bind } });
    const run = async (ctx: Parameters<typeof reviewPhase>[0]) => void verdicts.push(await reviewPhase(ctx, { repo: REPO, pr: 1, round: 0, headSha: H }));
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [defineWorkflow({ name: "fix-proof-test", steps: REVIEW_STEPS, run })], routes, gatePollMs: 5 });
    hosts.push(host);
    const runId = host.runtime.start("fix-proof-test", { policy: JSON.stringify(AUTO) });
    store.get().register({ repo: REPO, pr: 1, runId, task: "demo: fix the parser", implementer: "impl-a", policy: OWNER_GATE_POLICY, ...(scene.kind && { kind: scene.kind }), ...(scene.branch && { branch: scene.branch }) });
    if (scene.external) store.get().hold(runId, "seat review", scene.external);
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

  it("gates a fresh test-only registration like correctness, so a vacuous proof ends as NO_REPRO", async () => {
    const { verdicts, spawns } = await review({ kind: "test-only", runs: [fixProofRun()], log: actionsLog(resultLine(H, "vacuous")), files: [{ path: "packages/x/src/a.test.ts", status: "modified" }] });

    expect(verdicts).toMatchObject([{ kind: "NO_REPRO", headSha: H }]);
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

  it("runs the gate for a fix/ PR registered by number with kind feature, reading its branch from the PR", async () => {
    const { verdicts, spawns } = await review({ kind: "feature", headRef: "fix/x", runs: [fixProofRun()], log: actionsLog(resultLine(H, "vacuous")) });

    expect(verdicts).toEqual([{ kind: "NO_REPRO", headSha: H, result: expect.objectContaining({ verdict: "vacuous" }) }]);
    expect(spawns).toEqual([]);
  });

  it("proceeds to review with the reason recorded when the head has no fix-proof check run", async () => {
    const { verdicts, spawns, proof, inputs } = await review({ kind: "correctness" });

    expect(proof).toEqual({ kind: "missing", reason: expect.stringContaining("no fix-proof check run") });
    expect(verdicts).toMatchObject([{ kind: "MERGE" }]);
    expect(spawns).toHaveLength(1);
    expect(inputs[`sh-review:${H}`]).not.toHaveProperty("fixProof");
  });

  it("records an error proof, not missing, when the head's exec jobs ran but the judge never did", async () => {
    const { verdicts, proof } = await review({ kind: "correctness", runs: execRuns() });

    expect(proof).toEqual({ kind: "error", reason: expect.stringContaining("no fix-proof judge run") });
    expect(fixProofStanding(FixProofReadSchema.parse(proof), H)).toEqual({ unverified: "unread" });
    expect(verdicts).not.toContainEqual(expect.objectContaining({ kind: "NO_REPRO" }));
  });

  it("records an error proof when a [skip ci] head has no Actions run in a repo with the fix-proof workflow", async () => {
    const { verdicts, proof } = await review({ kind: "correctness", workflow: true });

    expect(proof).toEqual({ kind: "error", reason: expect.stringContaining(WORKFLOW_EDIT.path) });
    expect(fixProofStanding(FixProofReadSchema.parse(proof), H)).toEqual({ unverified: "unread" });
    expect(verdicts).not.toContainEqual(expect.objectContaining({ kind: "NO_REPRO" }));
  });

  it("hands a reproduced line at the head to the reviewer brief", async () => {
    const line = resultLine(H, "reproduced");

    const { spawns, inputs } = await review({ kind: "correctness", runs: [fixProofRun()], log: actionsLog(line) });

    expect(inputs[`sh-review:${H}`]).toMatchObject({ fixProof: line });
    expect(spawns[0]?.brief).toContain("fix-proof/v1 verdict for this head: reproduced");
    expect(spawns[0]?.brief).toContain("Do not rerun");
  });

  it("withholds a reproduced line from the reviewer brief when the PR edits the fix-proof workflow", async () => {
    const line = resultLine(H, "reproduced");

    const { spawns, inputs, proof } = await review({ kind: "correctness", runs: [fixProofRun()], log: actionsLog(line), files: [WORKFLOW_EDIT] });

    expect(proof).toEqual({ kind: "untrusted", line, verdict: "reproduced", reason: expect.stringContaining(WORKFLOW_EDIT.path) });
    expect(inputs[`sh-review:${H}`]).not.toHaveProperty("fixProof");
    expect(spawns[0]?.brief).not.toContain("Do not rerun");
  });

  it("reviews a PR whose vacuous line is untrusted as unverified, and its MERGE keeps the grant with the standing recorded", async () => {
    const { verdicts, spawns, proof, inputs } = await review({ kind: "correctness", runs: [fixProofRun()], log: actionsLog(resultLine(H, "vacuous")), files: [WORKFLOW_EDIT] });

    expect(proof).toMatchObject({ kind: "untrusted", verdict: "vacuous" });
    expect(verdicts).toMatchObject([{ kind: "MERGE" }]);
    expect(spawns).toHaveLength(1);
    expect(inputs[`sh-review:${H}`]).toMatchObject({ fixProofUnverified: "untrusted" });
    expect(inputs[`sh-review:${H}`]).not.toHaveProperty("ownerBrief");
    expect(spawns[0]?.brief).toContain(UNVERIFIED_BRIEF);
    expect(inputs[`sh-merge-evidence:${H}`]).toMatchObject({ seatGrants: [MERGE_ON_GREEN_GRANT], proofUnverified: expect.stringMatching(/^untrusted \(/) });
  });

  it("reviews a correctness head that forces a fix-proof error as unverified, and its MERGE keeps the grant with the standing recorded", async () => {
    const { verdicts, spawns, proof, inputs } = await review({ kind: "correctness", runs: [fixProofRun()], log: actionsLog(resultLine(H, "error")) });

    expect(proof).toMatchObject({ kind: "result", verdict: "error" });
    expect(inputs[`sh-review:${H}`]).toMatchObject({ fixProofUnverified: "error" });
    expect(inputs[`sh-review:${H}`]).not.toHaveProperty("ownerBrief");
    expect(spawns[0]?.brief).toContain(UNVERIFIED_BRIEF);
    expect(spawns[0]?.brief).not.toContain("Do not rerun");
    expect(verdicts).toMatchObject([{ kind: "MERGE", headSha: H }]);
    expect(inputs[`sh-merge-evidence:${H}`]).toMatchObject({ seatGrants: [MERGE_ON_GREEN_GRANT], proofUnverified: "error" });
  });

  it("keeps the merge-on-green grant for an external reviewer's MERGE on a head whose fix-proof errored", async () => {
    const { verdicts, spawns, inputs } = await review({ kind: "correctness", runs: [fixProofRun()], log: actionsLog(resultLine(H, "error")), external: "seat-reviewer" });

    expect(spawns).toEqual([]);
    expect(verdicts).toMatchObject([{ kind: "MERGE", headSha: H }]);
    expect(inputs[`sh-merge-evidence:${H}`]).toMatchObject({ seatGrants: [MERGE_ON_GREEN_GRANT], proofUnverified: "error" });
  });

  it("keeps the merge-on-green grant and asks no owner brief for a reproduced proof", async () => {
    const { verdicts, spawns, inputs } = await review({ kind: "correctness", runs: [fixProofRun()], log: actionsLog(resultLine(H, "reproduced")) });

    expect(verdicts).toMatchObject([{ kind: "MERGE", headSha: H }]);
    expect(inputs[`sh-review:${H}`]).not.toHaveProperty("fixProofUnverified");
    expect(inputs[`sh-review:${H}`]).not.toHaveProperty("ownerBrief");
    expect(spawns[0]?.brief).not.toContain(UNVERIFIED_BRIEF);
    expect(inputs[`sh-merge-evidence:${H}`]).toMatchObject({ seatGrants: [MERGE_ON_GREEN_GRANT] });
  });

  it("keeps the merge-on-green grant for a repo that runs no fix-proof", async () => {
    const { inputs } = await review({ kind: "correctness" });

    expect(inputs[`sh-review:${H}`]).not.toHaveProperty("fixProofUnverified");
    expect(inputs[`sh-merge-evidence:${H}`]).toMatchObject({ seatGrants: [MERGE_ON_GREEN_GRANT] });
  });

  it("keeps today's grant for a feature PR outside the gate whose fix-proof errored", async () => {
    const { proof, inputs } = await review({ kind: "feature", runs: [fixProofRun()], log: actionsLog(resultLine(H, "error")) });

    expect(proof).toMatchObject({ kind: "skipped" });
    expect(inputs[`sh-review:${H}`]).not.toHaveProperty("fixProofUnverified");
    expect(inputs[`sh-merge-evidence:${H}`]).toMatchObject({ seatGrants: [MERGE_ON_GREEN_GRANT] });
  });
});

describe("readFixProof", () => {
  const signal = new AbortController().signal;

  interface Registered {
    branch?: string;
    headRef?: string;
    unreadablePr?: boolean;
    /** "default" leaves the reader's own wait budget in force. */
    timeoutMs?: number | "default";
    /** Each stage replaces the head's runs once the clock reaches its `ms`, as a job behind `needs:` appears. */
    later?: { ms: number; runs: CheckRun[] }[];
    logs?: Record<number, string>;
    files?: PrFile[];
    changedFiles?: number;
    workflow?: boolean;
    port?: (port: GitHubPort) => GitHubPort;
  }

  function registered(kind: string, runs: CheckRun[], options: Registered = {}) {
    const fake = fakeGitHub();
    if (!options.unreadablePr) fake.addPr({ headSha: H, ...(options.headRef !== undefined && { headRef: options.headRef }) });
    fake.setRuns(H, runs);
    fake.jobLogs.set(FIX_PROOF_JOB, actionsLog(resultLine(H, "vacuous")));
    for (const [job, log] of Object.entries(options.logs ?? {})) fake.jobLogs.set(Number(job), log);
    if (options.files !== undefined) fake.prFiles.set(1, options.files);
    if (options.changedFiles !== undefined) fake.prChangedFiles.set(1, options.changedFiles);
    if (options.workflow) addWorkflowAtBase(fake);
    const port = (options.port ?? ((base) => base))(githubPort(fake.wire));
    const db = openDatabase(":memory:");
    runMigrations(db, [shepherdMigration(4), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16)]);
    const store = shepherdStoreRef();
    store.bind(db);
    store.get().register({ repo: REPO, pr: 1, runId: "run-1", task: "demo: tidy", implementer: "impl-a", policy: OWNER_GATE_POLICY, kind, ...(options.branch && { branch: options.branch }) });
    let clock = 0;
    const sleep = async (ms: number) => {
      clock += ms;
      const stage = options.later?.filter((candidate) => clock >= candidate.ms).at(-1);
      if (stage !== undefined) fake.setRuns(H, stage.runs);
    };
    const timeoutMs = options.timeoutMs ?? 10_000;
    const timing = { now: () => clock, sleep, pollMs: 1_000, noActionsGraceMs: 180_000, ...(timeoutMs !== "default" && { timeoutMs }) };
    return { fake, elapsed: () => clock, read: () => readFixProof({ port, store }, { repo: REPO, head: H, runId: "run-1" }, timing, signal) };
  }

  it("reads the result from a job log fetched through the gh adapter, whose colour codes gh refuses without --allow-escape-sequences", async () => {
    const headers = "HTTP/2.0 200 OK\r\nContent-Type: text/plain";
    const colored = actionsLog(resultLine(H, "reproduced")).replace("Run pnpm", "\u001b[36;1mRun pnpm\u001b[0m");
    const exec = async (args: readonly string[]) =>
      args.includes("--allow-escape-sequences")
        ? { code: 0, stdout: `${headers}\r\n\r\n${colored}\n`, stderr: "" }
        : { code: 1, stdout: `${headers}\r\n\r\n`, stderr: "the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway\n" };
    const viaGh = githubPort(ghCliWire(exec));
    const { read } = registered("correctness", [fixProofRun()], { port: (base) => ({ ...base, jobLogTail: viaGh.jobLogTail }) });

    expect(await read()).toEqual({ kind: "result", line: resultLine(H, "reproduced"), verdict: "reproduced" });
  });

  it("makes no GitHub call for a kind outside the gate on a registered branch", async () => {
    const { fake, read } = registered("refactor", [fixProofRun()], { branch: "feat/tidy" });

    expect(await read()).toEqual({ kind: "skipped", reason: "kind refactor" });
    expect(fake.calls).toEqual([]);
  });

  it("reads only the PR for a feature PR registered by number on a feat/ branch, and skips the gate", async () => {
    const { fake, read } = registered("feature", [fixProofRun()], { headRef: "feat/x" });

    expect(await read()).toEqual({ kind: "skipped", reason: "kind feature" });
    expect(fake.calls).toEqual(["getPr"]);
  });

  it("skips the gate with the reason recorded when the PR's head branch cannot be read", async () => {
    const { read } = registered("feature", [fixProofRun()], { unreadablePr: true });

    expect(await read()).toEqual({ kind: "skipped", reason: expect.stringContaining("head branch unreadable") });
  });

  it("settles as missing after the short grace when the head has no GitHub Actions run at all", async () => {
    const { read, elapsed } = registered("correctness", [], { timeoutMs: 1_500_000 });

    expect(await read()).toEqual({ kind: "missing", reason: expect.stringContaining("no GitHub Actions run") });
    expect(elapsed()).toBeLessThan(200_000);
  });

  it("reads error, not missing, after the grace when a head with no Actions run is in a repo with the fix-proof workflow", async () => {
    const { read, elapsed } = registered("correctness", [], { workflow: true, timeoutMs: 1_500_000 });

    const proof = await read();

    expect(proof).toEqual({ kind: "error", reason: expect.stringContaining("no GitHub Actions run") });
    expect(proof).toEqual({ kind: "error", reason: expect.stringContaining(`${WORKFLOW_EDIT.path} exists at the base main`) });
    expect(elapsed()).toBeLessThan(200_000);
  });

  it("reads error when the fix-proof workflow cannot be read at the base and no run exists", async () => {
    const failing = (port: GitHubPort): GitHubPort => ({ ...port, getFile: async () => Promise.reject(Object.assign(new Error("server error"), { status: 500 })) });
    const { read } = registered("correctness", [], { port: failing });

    expect(await read()).toEqual({ kind: "error", reason: expect.stringContaining("could not be read at the base main: HTTP 500") });
  });

  it("reads error, not missing, when the PR's base branch no longer exists and no run exists", async () => {
    const { fake, read } = registered("correctness", []);
    fake.refs.delete("main");

    expect(await read()).toEqual({ kind: "error", reason: expect.stringContaining("the base main does not exist") });
  });

  it("reads error when the PR's base branch cannot be read and no run exists", async () => {
    const { read } = registered("correctness", [], { unreadablePr: true });

    expect(await read()).toEqual({ kind: "error", reason: expect.stringContaining("base branch could not be read") });
  });

  it("keeps polling past the grace while an Actions run that is not fix-proof is still in progress", async () => {
    const { read, elapsed } = registered("correctness", [{ ...successRun("validate", 5), headSha: H, status: "in_progress", conclusion: null }], { timeoutMs: 1_500_000 });

    expect(await read()).toEqual({ kind: "missing", reason: expect.stringContaining("before the deadline") });
    expect(elapsed()).toBeGreaterThanOrEqual(1_500_000);
  });

  it("trusts a successful run's line when the PR leaves the harness alone", async () => {
    const { read } = registered("correctness", [fixProofRun()], { files: [{ path: "src/a.ts", status: "modified" }] });

    expect(await read()).toEqual({ kind: "result", line: resultLine(H, "vacuous"), verdict: "vacuous" });
  });

  it("distrusts the line when the PR renames the fix-proof run script away", async () => {
    const { read } = registered("correctness", [fixProofRun()], { files: [{ path: "scripts/other.sh", previousPath: "scripts/fix-proof-run.sh", status: "renamed" }] });

    expect(await read()).toEqual({ kind: "untrusted", line: resultLine(H, "vacuous"), verdict: "vacuous", reason: expect.stringContaining("scripts/fix-proof-run.sh") });
  });

  it("distrusts the line from a fix-proof run that did not conclude success", async () => {
    const { read } = registered("correctness", [fixProofRun({ conclusion: "failure" })]);

    expect(await read()).toMatchObject({ kind: "untrusted", reason: expect.stringContaining("failure") });
  });

  it("distrusts the line when the PR's changed files cannot be read in full", async () => {
    const { read } = registered("correctness", [fixProofRun()], { files: [{ path: "src/a.ts", status: "modified" }], changedFiles: 5_000 });

    expect(await read()).toMatchObject({ kind: "untrusted", reason: expect.stringContaining("could not be read") });
  });

  it("ignores a newer fix-proof run bound to a different PR at the same head and trusts the one bound to this PR", async () => {
    const reproduced = resultLine(H, "reproduced");
    const forged = fixProofRun({ id: 99, pullRequests: [{ number: 2, baseRef: "main" }] });
    const { read } = registered("correctness", [fixProofRun(), forged], { logs: { 99: actionsLog(resultLine(H, "vacuous")), [FIX_PROOF_JOB]: actionsLog(reproduced) } });

    expect(await read()).toEqual({ kind: "result", line: reproduced, verdict: "reproduced" });
  });

  it("ignores a newer run for this PR number on another base branch", async () => {
    const reproduced = resultLine(H, "reproduced");
    const forged = fixProofRun({ id: 99, pullRequests: [{ number: 1, baseRef: "attacker" }] });
    const { read } = registered("correctness", [fixProofRun(), forged], { logs: { 99: actionsLog(resultLine(H, "vacuous")), [FIX_PROOF_JOB]: actionsLog(reproduced) } });

    expect(await read()).toEqual({ kind: "result", line: reproduced, verdict: "reproduced" });
  });

  it.each([
    ["newest last", [77, 78]],
    ["newest first", [78, 77]],
  ])("distrusts the line when two fix-proof runs at the head are bound to this PR (%s)", async (_order, ids) => {
    const { read } = registered("correctness", ids.map((id) => fixProofRun({ id })), { logs: { 78: actionsLog(resultLine(H, "reproduced")) } });

    expect(await read()).toMatchObject({ kind: "untrusted", verdict: "reproduced", reason: expect.stringContaining("2 fix-proof runs") });
  });

  it("distrusts the line when no fix-proof run at the head is bound to this PR", async () => {
    const { read } = registered("correctness", [fixProofRun({ pullRequests: [] })]);

    expect(await read()).toMatchObject({ kind: "untrusted", reason: expect.stringContaining("0 fix-proof runs") });
  });

  it("waits for the newest fix-proof run rather than read an older completed one", async () => {
    const { read, elapsed } = registered("correctness", [fixProofRun(), fixProofRun({ id: 78, status: "in_progress", conclusion: null })]);

    expect(await read()).toEqual({ kind: "error", reason: expect.stringContaining("at the deadline") });
    expect(elapsed()).toBeGreaterThanOrEqual(10_000);
  });

  it("reads the judge run of a three-job fix-proof that completes 30 minutes in under the default wait", async () => {
    const { read, elapsed } = registered("correctness", execPending(), { timeoutMs: "default", later: [{ ms: 30 * 60_000, runs: [...execRuns(), fixProofRun()] }] });

    expect(await read()).toEqual({ kind: "result", line: resultLine(H, "vacuous"), verdict: "vacuous" });
    expect(elapsed()).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it("keeps polling when the exec jobs finish and the judge appears several polls later, and reads its result", async () => {
    const validate = { ...successRun("validate", 5), headSha: H };
    const execDone = 5 * 60_000;
    const { read, elapsed } = registered("correctness", [validate, ...execPending()], {
      timeoutMs: "default",
      later: [
        { ms: execDone, runs: [validate, ...execRuns()] },
        { ms: execDone + 10_000, runs: [validate, ...execRuns(), fixProofRun()] },
      ],
    });

    expect(await read()).toEqual({ kind: "result", line: resultLine(H, "vacuous"), verdict: "vacuous" });
    expect(elapsed()).toBeGreaterThanOrEqual(execDone + 10_000);
  });

  it.each([
    ["succeeded", {}],
    ["were cancelled", { conclusion: "cancelled" }],
  ] as const)("reads error, not missing, when the exec jobs %s but no judge run exists at the deadline", async (_how, overrides) => {
    const validate = { ...successRun("validate", 5), headSha: H };
    const { read, elapsed } = registered("correctness", [validate, ...execRuns(overrides)], { files: [{ path: "src/a.ts", status: "modified" }] });

    expect(await read()).toEqual({ kind: "error", reason: expect.stringContaining("no fix-proof judge run") });
    expect(elapsed()).toBeGreaterThanOrEqual(10_000);
  });

  it("reads error, not missing, when the exec jobs drop out of the check-run list before any judge appears", async () => {
    const validate = { ...successRun("validate", 5), headSha: H };
    const { read, elapsed } = registered("correctness", [validate, ...execRuns()], { files: [{ path: "src/a.ts", status: "modified" }], later: [{ ms: 1_000, runs: [validate] }] });

    expect(await read()).toEqual({ kind: "error", reason: expect.stringContaining("no fix-proof judge run") });
    expect(elapsed()).toBeGreaterThanOrEqual(10_000);
  });

  it("reads a bound fix-proof run still in progress at the deadline as error, not missing", async () => {
    const { read } = registered("correctness", [fixProofRun({ status: "in_progress", conclusion: null })]);

    expect(await read()).toEqual({ kind: "error", reason: expect.stringContaining("still in_progress at the deadline") });
  });

  it("reads a completed fix-proof run with no result line for the head as error, not missing", async () => {
    const { read } = registered("correctness", [fixProofRun()], { logs: { [FIX_PROOF_JOB]: actionsLog(resultLine(OLD, "reproduced")) } });

    expect(await read()).toEqual({ kind: "error", reason: expect.stringContaining("no result line for this head") });
  });

  it("reads a PR that deletes the fix-proof workflow and leaves no run as error", async () => {
    const validate = { ...successRun("validate", 5), headSha: H };
    const { read } = registered("correctness", [validate], { files: [{ path: ".github/workflows/fix-proof.yml", status: "removed" }] });

    expect(await read()).toEqual({ kind: "error", reason: expect.stringContaining("harness: .github/workflows/fix-proof.yml") });
  });

  it("reads a PR whose changed files cannot be read in full and leaves no run as error", async () => {
    const { read } = registered("correctness", [], { files: [{ path: "src/a.ts", status: "modified" }], changedFiles: 5_000 });

    expect(await read()).toEqual({ kind: "error", reason: expect.stringContaining("could not be read") });
  });

  it("reads error, not missing, when every Actions run settled with no fix-proof run in a repo with the workflow", async () => {
    const validate = { ...successRun("validate", 5), headSha: H };
    const { read } = registered("correctness", [validate], { workflow: true, files: [{ path: "src/a.ts", status: "modified" }] });

    expect(await read()).toEqual({ kind: "error", reason: expect.stringContaining("no fix-proof check run, but") });
  });

  it("reads error, not missing, at the deadline with no run in a repo with the workflow", async () => {
    const pending = { ...successRun("validate", 5), headSha: H, status: "in_progress" as const, conclusion: null };
    const { read } = registered("correctness", [pending], { workflow: true });

    expect(await read()).toEqual({ kind: "error", reason: expect.stringContaining("before the deadline, but") });
  });

  it("still reads missing for a repo with no fix-proof run when the PR leaves the harness alone", async () => {
    const validate = { ...successRun("validate", 5), headSha: H };
    const { read } = registered("correctness", [validate], { files: [{ path: "src/a.ts", status: "modified" }] });

    expect(await read()).toEqual({ kind: "missing", reason: expect.stringContaining("no fix-proof check run") });
  });
});

describe("fixProofStanding", () => {
  const verdicts: FixProofResult["verdict"][] = ["reproduced", "unproven", "vacuous", "no-tests"];

  it.each(verdicts)("lets a trusted %s result at the head stand", (verdict) => {
    expect(fixProofStanding({ kind: "result", line: resultLine(H, verdict), verdict }, H)).toBeUndefined();
  });

  it("marks a trusted error result at the head unverified as error", () => {
    expect(fixProofStanding({ kind: "result", line: resultLine(H, "error"), verdict: "error" }, H)).toEqual({ unverified: "error" });
  });

  it.each([...verdicts, "error" as const])("marks an untrusted %s result unverified as untrusted", (verdict) => {
    expect(fixProofStanding({ kind: "untrusted", line: resultLine(H, verdict), verdict, reason: "harness edited" }, H)).toEqual({ unverified: "untrusted" });
  });

  it("marks an error read unverified as unread", () => {
    expect(fixProofStanding({ kind: "error", reason: "no result line" }, H)).toEqual({ unverified: "unread" });
  });

  it("marks a stored result line naming another head unverified as unread", () => {
    expect(fixProofStanding({ kind: "result", line: resultLine(OLD, "reproduced"), verdict: "reproduced" }, H)).toEqual({ unverified: "unread" });
  });

  it.each(["skipped", "missing"] as const)("lets a %s read stand, since no proof was expected", (kind) => {
    expect(fixProofStanding({ kind, reason: "no fix-proof run" }, H)).toBeUndefined();
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
