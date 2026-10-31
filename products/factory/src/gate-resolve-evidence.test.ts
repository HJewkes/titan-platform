import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActorClass } from "@titan-design/authority";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { GateResolverRefused } from "@titan-design/hitl";
import { openDatabase } from "@titan-design/store-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { EvidenceSources } from "./coordinator-evidence-read.js";
import { defineWorkflow } from "./definition.js";
import { acknowledgeBrief, approveMergeDecision, ciFailedDecision, frozenDecision, sentBackDecision, stuckBehindDecision } from "./gate-brief.js";
import { resolveGate } from "./gate-resolve.js";
import { openFactoryHost, type FactoryHost } from "./host.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./shepherd/policy.js";
import { authorityGateReason, pendingCheck } from "./test-support/authority-reason.js";
import { fakeOwnerHelper } from "./test-support/owner-edges.js";
import { codeRoute, step } from "./workflows/land.js";
import { tableGateRule } from "./workflows/land-approval.js";
import { partialFake } from "@titan-design/test-kit";
import type { FailingCheck } from "./workflows/land-ci.js";

const REPO = "o/r";
const HEAD = fakeSha("head");
const MERGE_SHA = fakeSha("merge");
const TIP = fakeSha("tip");
const AGENT_SHELL = { AGENT_CHAT_AGENT_ID: "agent-1", AGENT_CHAT_NAME: "tc-synthetic" };
const AUTO: EffectivePolicy = { merge: "auto", mergeMethod: "squash", fixer: true, seat: "synthetic" };
const OwnerAck = z.object({ decision: z.literal("acknowledged"), mergeSha: z.string() });
const NOW = Date.parse("2026-10-07T18:00:00Z");
const MECHANICAL = authorityGateReason(HEAD, pendingCheck(HEAD));

interface Scenario {
  gate: "merge" | "sent-back" | "ci-failed" | "main-red" | "main-frozen" | "main-ci-timeout";
  rule?: string;
  /** The recorded merge decision's reason; defaults to MRG-AU gating only on a required check still running. */
  reason?: string;
  verdict?: string;
  policy?: EffectivePolicy;
  /** Stamp the approve-merge gate with its table row's rule, as land does. */
  stamped?: boolean;
  /** Open a stuck-behind gate once the approve-merge gate is answered. */
  thenStuck?: boolean;
}

const RunScenario = z.looseObject({
  gate: z.enum(["merge", "sent-back", "ci-failed", "main-red", "main-frozen", "main-ci-timeout"]),
  rule: z.string().optional(),
  reason: z.string().optional(),
  verdict: z.string().optional(),
  stamped: z.boolean().optional(),
  thenStuck: z.boolean().optional(),
});
const Verdict = z.looseObject({ kind: z.string(), verdict: z.string(), head: z.string(), reviewer: z.looseObject({ agentId: z.string() }) });
const Decision = z.looseObject({ outcome: z.string(), headSha: z.string(), rule: z.looseObject({ table: z.string(), rowId: z.string() }) });

/** A stand-in for shepherd-pr that records a verdict and a merge decision the way Shepherd does, then opens one gate. */
const shepherdPr = defineWorkflow({
  name: "shepherd-pr",
  steps: [
    { id: "sh-await-verdict", kind: "dispatch" },
    { id: "merge-policy", kind: "dispatch" },
    { id: "approve-merge", kind: "assisted" },
    { id: "sh-sent-back", kind: "assisted" },
    { id: "ci-failed", kind: "assisted" },
    { id: "main-red", kind: "assisted" },
    { id: "main-frozen", kind: "assisted" },
    { id: "main-ci-timeout", kind: "assisted" },
    { id: "stuck-behind", kind: "assisted" },
  ],
  run: async (ctx) => {
    const scenario = RunScenario.parse(JSON.parse(ctx.param("scenario")!));
    if (scenario.gate === "main-red") return void (await ctx.assisted("main-red", `Main CI on ${REPO} at merge ${MERGE_SHA} (PR #1) is red: failed: validate. Acknowledge.`, { schema: OwnerAck, brief: acknowledgeBrief({ repo: REPO, mergeSha: MERGE_SHA, headline: "Main CI is red", detail: "failed: validate" }) }));
    if (scenario.gate === "main-ci-timeout") {
      const prompt = `Main CI on ${REPO} at merge ${MERGE_SHA} (PR #1) is not red, but unread: no completed main run containing it. Acknowledge.`;
      return void (await ctx.assisted("main-ci-timeout", prompt, { schema: OwnerAck, brief: acknowledgeBrief({ repo: REPO, mergeSha: MERGE_SHA, headline: "No completed main CI run contains the merge", detail: "unread" }) }));
    }
    if (scenario.gate === "main-frozen") {
      const prompt = `Main CI on ${REPO} at merge ${MERGE_SHA} (PR #1) is red: failed: validate. The repo is frozen. Stay frozen, or unfreeze?`;
      return void (await ctx.assisted("main-frozen", prompt, frozenDecision({ repo: REPO, mergeSha: MERGE_SHA, situation: prompt })));
    }
    if (scenario.gate === "ci-failed") return void (await ctx.assisted("ci-failed", "CI failed.", ciFailedDecision({ repo: REPO, pr: 1, headSha: HEAD, failing: [partialFake<FailingCheck>({ name: "validate", url: "https://example.test/job/1" })] })));
    if (scenario.gate === "sent-back") return void (await ctx.assisted("sh-sent-back", `The review of PR #1 in ${REPO} at head ${HEAD} said FIX_FIRST. Await a new head or abandon?`, sentBackDecision({ repo: REPO, pr: 1, headSha: HEAD, situation: "the reviewer sent it back" })));
    await step(ctx, `sh-await-verdict:${HEAD}`, { kind: "verdict", verdict: scenario.verdict ?? "MERGE", head: HEAD, reviewer: { agentId: "rv-synthetic" } }, Verdict);
    const [table = "", rowId = ""] = (scenario.rule ?? "authority/MRG-AU").split("/");
    const reason = scenario.reason ?? MECHANICAL;
    await step(ctx, "merge-policy:0", { outcome: "gate", headSha: HEAD, rule: { table, rowId, version: 1 }, reason }, Decision);
    const prompt = `Merge PR #1 in ${REPO} at head ${HEAD}? CI is green. Policy ${table}/${rowId}: ${reason}`;
    const rule = scenario.stamped ? tableGateRule({ table, rowId, version: 1 }) : undefined;
    await ctx.assisted("approve-merge", prompt, { ...approveMergeDecision({ repo: REPO, pr: 1, headSha: HEAD, reason, reviewedMerge: true }), ...(rule && { rule }) });
    if (scenario.thenStuck) await ctx.assisted("stuck-behind", `PR #1 in ${REPO} is behind. Retry or abandon?`, stuckBehindDecision({ repo: REPO, pr: 1, headSha: HEAD, why: "behind its base" }));
  },
});

const echo = async (input: object): Promise<object> => input;
const routes = [codeRoute("sh-await-verdict", () => NOW, echo), codeRoute("merge-policy", () => NOW, echo)];

const dirs: string[] = [];
const hosts: FactoryHost[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

interface World {
  host: FactoryHost;
  dbPath: string;
  runId: string;
  gh: FakeGitHub;
  sources: EvidenceSources;
  registration: { held: boolean; frozen: boolean };
}

async function paused(scenario: Scenario): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "factory-gate-evidence-"));
  dirs.push(dir);
  const dbPath = join(dir, "factory.sqlite3");
  const host = openFactoryHost({ dbPath, workflows: [shepherdPr], routes, gatePollMs: 10 });
  hosts.push(host);
  const policy = scenario.policy ?? AUTO;
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(policy), scenario: JSON.stringify(scenario) });
  await vi.waitFor(() => expect(host.runtime.status(runId)?.status).toBe("paused"));
  const gh = greenWorld();
  const registration = { held: false, frozen: false };
  const sources: EvidenceSources = {
    port: githubPort(gh.wire),
    registration: () => ({ repo: REPO, pr: 1, policy, held: registration.held }),
    frozen: () => registration.frozen,
    now: () => NOW,
  };
  return { host, dbPath, runId, gh, sources, registration };
}

/** PR #1 open at HEAD, mergeable, both required checks green; main's tip is green and contains MERGE_SHA. */
function greenWorld(): FakeGitHub {
  const gh = fakeGitHub({ repo: REPO, baseSha: TIP });
  gh.addPr({ headSha: HEAD });
  gh.setRuns(HEAD, [successRun("validate", 11), successRun("dag-check", 12)]);
  gh.setRuns(TIP, [successRun("validate", 21), successRun("dag-check", 22)]);
  return gh;
}

function mergedPr(gh: FakeGitHub): void {
  Object.assign(gh.pr(1), { state: "closed", merged: true, mergeSha: MERGE_SHA });
}

const STEPS: Record<Scenario["gate"] | "stuck-behind", string> = { merge: "approve-merge", "sent-back": "sh-sent-back", "ci-failed": "ci-failed", "main-red": "main-red", "main-frozen": "main-frozen", "main-ci-timeout": "main-ci-timeout", "stuck-behind": "stuck-behind" };

async function resolveAs(world: World, gate: Scenario["gate"] | "stuck-behind", payload: object) {
  const { reasons } = fakeOwnerHelper(undefined);
  let out = "";
  let err = "";
  const io = { stdout: (t: string) => void (out += t), stderr: (t: string) => void (err += t), env: AGENT_SHELL };
  const code = await resolveGate(world.host, io, world.runId, STEPS[gate], JSON.stringify(payload), world.sources).catch((error: Error) => ((err += error.message), 1));
  return { code, out, err, reasons, gate: world.host.gates.get(`${world.runId}/${STEPS[gate]}`) };
}

const MERGE = { decision: "merge", headSha: HEAD };

/** Today's path: the coordinator is asked for presence, gets none, and the store refuses it. */
function expectFellBack(result: Awaited<ReturnType<typeof resolveAs>>): void {
  expect(result.reasons).toHaveLength(1);
  expect(result.code).toBe(1);
  expect(result.err).toContain("actor class coordinator may not resolve a gate");
  expect(result.gate?.status).toBe("pending");
}

describe("coordinator resolve of an approve-merge gate on fresh evidence", () => {
  it("resolves without a dialog and stores the verdict, check run ids and mergeable read on the gate", async () => {
    const world = await paused({ gate: "merge" });

    const result = await resolveAs(world, "merge", MERGE);

    expect(result.reasons).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("as coordinator tc-synthetic on approve-merge evidence");
    expect(result.gate).toMatchObject({ status: "resolved", payload: MERGE, resolvedBy: { class: "coordinator", id: "tc-synthetic", channel: "factory-cli" } });
    expect(result.gate?.resolvedEvidence).toMatchObject({
      kind: "approve-merge",
      headSha: HEAD,
      run: { rule: "authority/MRG-AU", reason: MECHANICAL, merge: "auto", held: false, frozen: false },
      verdict: { step: `sh-await-verdict:${HEAD}`, verdict: "MERGE", head: HEAD, reviewer: "rv-synthetic" },
      checks: { base: "main", required: ["validate", "dag-check"], runs: [{ id: 11, name: "validate", conclusion: "success", headSha: HEAD }, { id: 12, name: "dag-check", conclusion: "success", headSha: HEAD }] },
      pull: { state: "open", headSha: HEAD, mergeableState: "clean", mergeable: "MERGEABLE" },
      readAt: "2026-10-07T18:00:00.000Z",
    });
  });

  it("falls back to the presence dialog when a required check is red at the head", async () => {
    const world = await paused({ gate: "merge" });
    world.gh.setRuns(HEAD, [successRun("validate", 11), successRun("dag-check", 12, undefined, "failure")]);

    expectFellBack(await resolveAs(world, "merge", MERGE));
  });

  it("falls back when a required check is still pending at the head", async () => {
    const world = await paused({ gate: "merge" });
    world.gh.setRuns(HEAD, [successRun("validate", 11)]);

    expectFellBack(await resolveAs(world, "merge", MERGE));
  });

  it("falls back when GitHub reports mergeable unknown", async () => {
    const world = await paused({ gate: "merge" });
    world.gh.pr(1).mergeableState = "unknown";

    expectFellBack(await resolveAs(world, "merge", MERGE));
  });

  it("falls back when the payload names a head other than the gate's", async () => {
    const world = await paused({ gate: "merge" });

    expectFellBack(await resolveAs(world, "merge", { decision: "merge", headSha: fakeSha("other") }));
  });

  it("falls back when the PR moved off the gated head", async () => {
    const world = await paused({ gate: "merge" });
    world.gh.pushHead(1, fakeSha("pushed"));

    expectFellBack(await resolveAs(world, "merge", MERGE));
  });

  it("falls back on a visual-path gate", async () => {
    const world = await paused({ gate: "merge", rule: "shepherd-merge-guard/visual-path" });

    expectFellBack(await resolveAs(world, "merge", MERGE));
  });

  it("falls back on a seat owner-gate", async () => {
    const world = await paused({ gate: "merge", rule: "shepherd-seat/synthetic", policy: OWNER_GATE_POLICY });

    expectFellBack(await resolveAs(world, "merge", MERGE));
  });

  it.each([
    ["a CODEOWNERS change", authorityGateReason(HEAD, { ...pendingCheck(HEAD), changedPaths: ["CODEOWNERS"] })],
    ["a .gitmodules change", authorityGateReason(HEAD, { changedPaths: [".gitmodules"] })],
    ["a non-canonical path", authorityGateReason(HEAD, { changedPaths: ["src/../CODEOWNERS"] })],
    ["a seat without the merge grant", authorityGateReason(HEAD, { ...pendingCheck(HEAD), seatGrants: [] })],
    ["a frozen repo at decision time", authorityGateReason(HEAD, { repoFrozen: true })],
    ["a tainted request", authorityGateReason(HEAD, {}, true)],
    ["an authority reason it cannot read", "the authority policy did not allow an automated merge: MRG-AU gates merge by automation; something new"],
  ])("falls back on an MRG-AU gate for %s, all else green", async (_case, reason) => {
    const world = await paused({ gate: "merge", reason });

    expectFellBack(await resolveAs(world, "merge", MERGE));
  });

  it("falls back on an authority gate under a rule other than MRG-AU", async () => {
    const world = await paused({ gate: "merge", rule: "authority/MRG-CO" });

    expectFellBack(await resolveAs(world, "merge", MERGE));
  });

  it("falls back when the reviewer said FIX_FIRST at the head", async () => {
    const world = await paused({ gate: "merge", verdict: "FIX_FIRST" });

    expectFellBack(await resolveAs(world, "merge", MERGE));
  });

  it("falls back when the registration is held or the repo is frozen", async () => {
    const held = await paused({ gate: "merge" });
    held.registration.held = true;
    const frozen = await paused({ gate: "merge" });
    frozen.registration.frozen = true;

    expectFellBack(await resolveAs(held, "merge", MERGE));
    expectFellBack(await resolveAs(frozen, "merge", MERGE));
  });

  it("falls back when a GitHub read fails", async () => {
    const world = await paused({ gate: "merge" });
    world.gh.wire.getBranchRules = async () => Promise.reject(new Error("HTTP 502"));

    expectFellBack(await resolveAs(world, "merge", MERGE));
  });

  it("an owner terminal resolves as the owner and reads no evidence", async () => {
    const world = await paused({ gate: "merge" });
    const io = { stdout: () => undefined, stderr: () => undefined, env: {} };
    fakeOwnerHelper(undefined);

    await resolveGate(world.host, io, world.runId, "approve-merge", JSON.stringify(MERGE), world.sources);

    expect(world.gh.calls).toEqual([]);
    expect(world.host.gates.get(`${world.runId}/approve-merge`)).toMatchObject({ resolvedBy: { class: "owner-terminal" }, resolvedEvidence: undefined });
  });
});

describe("coordinator abandon of a gate whose PR is gone", () => {
  it("abandons a sent-back gate once the PR merged, storing the PR state", async () => {
    const world = await paused({ gate: "sent-back" });
    mergedPr(world.gh);

    const result = await resolveAs(world, "sent-back", { decision: "abandon" });

    expect(result.reasons).toEqual([]);
    expect(result.gate).toMatchObject({ status: "resolved", resolvedEvidence: { kind: "pr-gone", repo: REPO, pr: 1, state: "merged" } });
  });

  it("abandons an approve-merge gate once the PR closed", async () => {
    const world = await paused({ gate: "merge" });
    world.gh.pr(1).state = "closed";

    const result = await resolveAs(world, "merge", { decision: "abandon", headSha: HEAD });

    expect(result.gate).toMatchObject({ status: "resolved", resolvedEvidence: { kind: "pr-gone", state: "closed" } });
  });

  it("abandons a red-CI gate once the PR merged, with the head its schema pins", async () => {
    const world = await paused({ gate: "ci-failed" });
    mergedPr(world.gh);

    const result = await resolveAs(world, "ci-failed", { decision: "abandon", headSha: HEAD });

    expect(result.reasons).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.gate).toMatchObject({ status: "resolved", payload: { decision: "abandon", headSha: HEAD }, resolvedEvidence: { kind: "pr-gone", repo: REPO, pr: 1, state: "merged" } });
  });

  it("falls back on a red-CI abandon whose payload omits or changes the pinned head", async () => {
    const bare = await paused({ gate: "ci-failed" });
    mergedPr(bare.gh);
    const other = await paused({ gate: "ci-failed" });
    mergedPr(other.gh);

    expectFellBack(await resolveAs(bare, "ci-failed", { decision: "abandon" }));
    expectFellBack(await resolveAs(other, "ci-failed", { decision: "abandon", headSha: fakeSha("other") }));
  });

  it("falls back on an abandon while the PR is still open", async () => {
    const world = await paused({ gate: "sent-back" });

    expectFellBack(await resolveAs(world, "sent-back", { decision: "abandon" }));
  });

  it.each([
    ["a visual-path gate", { gate: "merge", rule: "shepherd-merge-guard/visual-path" }],
    ["a seat owner-gate", { gate: "merge", rule: "shepherd-seat/synthetic", policy: OWNER_GATE_POLICY }],
    ["a gate the authority policy would not call mechanical", { gate: "merge", reason: authorityGateReason(HEAD, { changedPaths: ["CODEOWNERS"] }) }],
  ] satisfies [string, Scenario][])("abandons %s once the PR merged, as nothing is left to merge", async (_case, scenario) => {
    const world = await paused(scenario);
    mergedPr(world.gh);

    const result = await resolveAs(world, "merge", { decision: "abandon", headSha: HEAD });

    expect(result.reasons).toEqual([]);
    expect(result.gate).toMatchObject({ status: "resolved", resolvedEvidence: { kind: "pr-gone", repo: REPO, pr: 1, state: "merged" } });
  });

  it("abandons a held run's approve-merge gate once the PR merged", async () => {
    const world = await paused({ gate: "merge" });
    world.registration.held = true;
    mergedPr(world.gh);

    const result = await resolveAs(world, "merge", { decision: "abandon", headSha: HEAD });

    expect(result.gate).toMatchObject({ status: "resolved", resolvedEvidence: { kind: "pr-gone", state: "merged" } });
  });

  it("falls back on an approve-merge abandon while the PR is still open, held or not", async () => {
    const open = await paused({ gate: "merge" });
    const held = await paused({ gate: "merge" });
    held.registration.held = true;

    expectFellBack(await resolveAs(open, "merge", { decision: "abandon", headSha: HEAD }));
    expectFellBack(await resolveAs(held, "merge", { decision: "abandon", headSha: HEAD }));
  });

  it("falls back on an approve-merge abandon naming another head than the gate's", async () => {
    const world = await paused({ gate: "merge" });
    mergedPr(world.gh);

    expectFellBack(await resolveAs(world, "merge", { decision: "abandon", headSha: fakeSha("other") }));
    expectFellBack(await resolveAs(world, "merge", { decision: "abandon" }));
  });

  it("falls back on any other decision once the PR is gone: merge, await-new-head and unfreeze", async () => {
    const merge = await paused({ gate: "merge" });
    mergedPr(merge.gh);
    const sentBack = await paused({ gate: "sent-back" });
    mergedPr(sentBack.gh);
    const frozen = await paused({ gate: "main-frozen" });
    Object.assign(frozen.gh.pr(1), { state: "closed", merged: false });

    expectFellBack(await resolveAs(merge, "merge", MERGE));
    expectFellBack(await resolveAs(sentBack, "sent-back", { decision: "await-new-head" }));
    expectFellBack(await resolveAs(frozen, "main-frozen", { decision: "unfreeze", mergeSha: MERGE_SHA }));
  });
});

describe("coordinator resolve of a sent-back gate (owner decision 529)", () => {
  const AWAIT = { decision: "await-new-head" };

  it("waits for a new head while the PR is open at the gate's head, storing the PR read", async () => {
    const world = await paused({ gate: "sent-back" });

    const result = await resolveAs(world, "sent-back", AWAIT);

    expect(result.reasons).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("as coordinator tc-synthetic on pr-at-head evidence");
    expect(result.gate).toMatchObject({
      status: "resolved",
      payload: AWAIT,
      resolvedBy: { class: "coordinator", id: "tc-synthetic" },
      resolvedEvidence: { kind: "pr-at-head", repo: REPO, pr: 1, state: "open", headSha: HEAD, readAt: "2026-10-07T18:00:00.000Z" },
    });
  });

  it("falls back on await-new-head once the PR moved off the gate's head", async () => {
    const world = await paused({ gate: "sent-back" });
    world.gh.pushHead(1, fakeSha("pushed"));

    expectFellBack(await resolveAs(world, "sent-back", AWAIT));
  });

  it("falls back on await-new-head once the PR closed unmerged", async () => {
    const world = await paused({ gate: "sent-back" });
    world.gh.pr(1).state = "closed";

    expectFellBack(await resolveAs(world, "sent-back", AWAIT));
  });

  it("falls back on await-new-head carrying anything beside the decision", async () => {
    const world = await paused({ gate: "sent-back" });

    expectFellBack(await resolveAs(world, "sent-back", { decision: "await-new-head", headSha: HEAD }));
  });

  it("abandons once the PR closed unmerged, and falls back on an abandon while it is open", async () => {
    const closed = await paused({ gate: "sent-back" });
    closed.gh.pr(1).state = "closed";
    const open = await paused({ gate: "sent-back" });

    expect((await resolveAs(closed, "sent-back", { decision: "abandon" })).gate).toMatchObject({ status: "resolved", resolvedEvidence: { kind: "pr-gone", state: "closed" } });
    expectFellBack(await resolveAs(open, "sent-back", { decision: "abandon" }));
  });

  it("still refuses a coordinator's approve-merge whose evidence fails, and every other gate's await-style answer", async () => {
    const merge = await paused({ gate: "merge" });
    merge.gh.pushHead(1, fakeSha("pushed"));
    const ciFailed = await paused({ gate: "ci-failed" });

    expectFellBack(await resolveAs(merge, "merge", MERGE));
    expectFellBack(await resolveAs(ciFailed, "ci-failed", { decision: "await-fix", headSha: HEAD }));
  });

  it.each([
    ["an approve-merge merge", "merge", "approve-merge", MERGE],
    ["a sent-back abandon", "sent-back", "sh-sent-back", { decision: "abandon" }],
  ] as const)("refuses open-at-head evidence written straight to the store for %s", async (_case, gate, step, payload) => {
    const world = await paused({ gate });
    const gateId = `${world.runId}/${step}`;
    const evidence = { kind: "pr-at-head", gateId, repo: REPO, pr: 1, state: "open", headSha: HEAD, readAt: "2026-10-07T18:00:00.000Z" };

    expect(() => world.host.gates.resolve(gateId, payload, { class: "coordinator", id: "tc-synthetic", channel: "factory-cli" }, evidence)).toThrow(GateResolverRefused);
    expect(world.host.gates.get(gateId)?.status).toBe("pending");
  });
});

describe("coordinator acknowledgement of a red main a green main commit contains", () => {
  it("acknowledges main-red and stores the green sha, merge base and run ids", async () => {
    const world = await paused({ gate: "main-red" });
    mergedPr(world.gh);
    world.gh.compares.set(`${MERGE_SHA}...${TIP}`, { mergeBaseSha: MERGE_SHA, files: [] });

    const result = await resolveAs(world, "main-red", { decision: "acknowledged", mergeSha: MERGE_SHA });

    expect(result.reasons).toEqual([]);
    expect(result.gate?.resolvedEvidence).toMatchObject({ kind: "main-green", mergeSha: MERGE_SHA, base: "main", greenSha: TIP, mergeBaseSha: MERGE_SHA, runs: [{ id: 21 }, { id: 22 }] });
  });

  it("acknowledges main-red when only a job outside the required contexts is red on the tip, recording the required runs", async () => {
    const world = await paused({ gate: "main-red" });
    mergedPr(world.gh);
    world.gh.compares.set(`${MERGE_SHA}...${TIP}`, { mergeBaseSha: MERGE_SHA, files: [] });
    world.gh.setRuns(TIP, [successRun("validate", 21), successRun("dag-check", 22), successRun("release", 23, undefined, "failure")]);

    const result = await resolveAs(world, "main-red", { decision: "acknowledged", mergeSha: MERGE_SHA });

    expect(result.reasons).toEqual([]);
    expect(result.gate?.resolvedEvidence).toMatchObject({ kind: "main-green", runs: [{ id: 21 }, { id: 22 }] });
  });

  it("does not acknowledge main-red when the only non-success run on the tip is skipped, since headCheckFindings demands success", async () => {
    const world = await paused({ gate: "main-red" });
    mergedPr(world.gh);
    world.gh.compares.set(`${MERGE_SHA}...${TIP}`, { mergeBaseSha: MERGE_SHA, files: [] });
    world.gh.setRuns(TIP, [successRun("validate", 21), successRun("dag-check", 22, undefined, "skipped")]);

    const result = await resolveAs(world, "main-red", { decision: "acknowledged", mergeSha: MERGE_SHA });

    expect(result.gate?.resolvedEvidence).toBeUndefined();
  });

  it("unfreezes main-frozen on the same evidence, and falls back on stay-frozen", async () => {
    const unfreeze = await paused({ gate: "main-frozen" });
    mergedPr(unfreeze.gh);
    const stay = await paused({ gate: "main-frozen" });
    mergedPr(stay.gh);

    expect((await resolveAs(unfreeze, "main-frozen", { decision: "unfreeze", mergeSha: MERGE_SHA })).gate?.status).toBe("resolved");
    expectFellBack(await resolveAs(stay, "main-frozen", { decision: "stay-frozen", mergeSha: MERGE_SHA }));
  });

  it("falls back when main's tip does not contain the merge", async () => {
    const world = await paused({ gate: "main-red" });
    mergedPr(world.gh);
    world.gh.compares.set(`${MERGE_SHA}...${TIP}`, { mergeBaseSha: fakeSha("elsewhere"), files: [] });

    expectFellBack(await resolveAs(world, "main-red", { decision: "acknowledged", mergeSha: MERGE_SHA }));
  });

  it("falls back when main's tip is red", async () => {
    const world = await paused({ gate: "main-red" });
    mergedPr(world.gh);
    world.gh.setRuns(TIP, [successRun("validate", 21, undefined, "failure")]);

    expectFellBack(await resolveAs(world, "main-red", { decision: "acknowledged", mergeSha: MERGE_SHA }));
  });
});

describe("coordinator acknowledgement of a main-ci-timeout gate (owner decision 551)", () => {
  const ACK = { decision: "acknowledged", mergeSha: MERGE_SHA };

  async function timedOut(mergeBaseSha = MERGE_SHA): Promise<World> {
    const world = await paused({ gate: "main-ci-timeout" });
    mergedPr(world.gh);
    world.gh.compares.set(`${MERGE_SHA}...${TIP}`, { mergeBaseSha, files: [] });
    return world;
  }

  it("acknowledges once a later main commit containing the merge is green on every required context, storing that read", async () => {
    const world = await timedOut();

    const result = await resolveAs(world, "main-ci-timeout", ACK);

    expect(result.reasons).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.gate).toMatchObject({
      status: "resolved",
      payload: ACK,
      resolvedBy: { class: "coordinator", id: "tc-synthetic" },
      resolvedEvidence: { kind: "main-green", mergeSha: MERGE_SHA, greenSha: TIP, mergeBaseSha: MERGE_SHA, runs: [{ id: 21, conclusion: "success" }, { id: 22, conclusion: "success" }] },
    });
  });

  it("falls back when the green main commit does not contain the merge", async () => {
    expectFellBack(await resolveAs(await timedOut(fakeSha("elsewhere")), "main-ci-timeout", ACK));
  });

  it("falls back while a required context on main's tip is red or has not reported", async () => {
    const red = await timedOut();
    red.gh.setRuns(TIP, [successRun("validate", 21), successRun("dag-check", 22, undefined, "failure")]);
    const missing = await timedOut();
    missing.gh.setRuns(TIP, [successRun("validate", 21)]);

    expectFellBack(await resolveAs(red, "main-ci-timeout", ACK));
    expectFellBack(await resolveAs(missing, "main-ci-timeout", ACK));
  });

  it("falls back when the base requires no context, though main-red would take every Actions run there", async () => {
    const timeout = await timedOut();
    timeout.gh.rules = { contexts: [], strict: true };
    const red = await paused({ gate: "main-red" });
    mergedPr(red.gh);
    red.gh.compares.set(`${MERGE_SHA}...${TIP}`, { mergeBaseSha: MERGE_SHA, files: [] });
    red.gh.rules = { contexts: [], strict: true };

    expectFellBack(await resolveAs(timeout, "main-ci-timeout", ACK));
    expect((await resolveAs(red, "main-red", ACK)).gate?.status).toBe("resolved");
  });

  it("falls back on an acknowledgement naming another merge", async () => {
    expectFellBack(await resolveAs(await timedOut(), "main-ci-timeout", { decision: "acknowledged", mergeSha: fakeSha("other") }));
  });
});

describe("an approve-merge gate stamped with the MRG-AU row", () => {
  const STAMPED = { gate: "merge", stamped: true } as const;

  it("stores the row's resolvers and the coordinator delegate", async () => {
    const world = await paused(STAMPED);

    expect(world.host.gates.get(`${world.runId}/approve-merge`)?.rule).toEqual({ table: "F5", version: "1.0.0", ruleId: "MRG-AU", resolvers: ["owner-terminal", "owner-remote"], delegates: ["coordinator"] });
  });

  it("resolves a mechanical coordinator merge on fresh evidence", async () => {
    const world = await paused(STAMPED);

    const result = await resolveAs(world, "merge", MERGE);

    expect(result.reasons).toEqual([]);
    expect(result.gate).toMatchObject({ status: "resolved", resolvedBy: { class: "coordinator" }, resolvedEvidence: { kind: "approve-merge" } });
  });

  it("resolves a coordinator abandon once the PR is gone", async () => {
    const world = await paused(STAMPED);
    mergedPr(world.gh);

    const result = await resolveAs(world, "merge", { decision: "abandon", headSha: HEAD });

    expect(result.gate).toMatchObject({ status: "resolved", resolvedEvidence: { kind: "pr-gone", state: "merged" } });
  });

  it("refuses a coordinator with no evidence, since the rule naming it is not enough", async () => {
    const world = await paused(STAMPED);
    world.gh.setRuns(HEAD, [successRun("validate", 11), { ...successRun("dag-check", 12), conclusion: "failure" }]);

    const result = await resolveAs(world, "merge", MERGE);

    expect(result.reasons).toHaveLength(1);
    expect(result.code).toBe(1);
    expect(result.err).toContain("only on evidence or an allowance");
    expect(result.gate?.status).toBe("pending");
  });

  it.each<ActorClass>(["worker", "headless", "automation", "decider"])("refuses %s", async (actorClass) => {
    const world = await paused(STAMPED);
    const gateId = `${world.runId}/approve-merge`;

    expect(() => world.host.gates.resolve(gateId, MERGE, { class: actorClass, id: "a-synthetic", channel: "factory-cli" })).toThrow(GateResolverRefused);

    expect(world.host.gates.get(gateId)?.status).toBe("pending");
  });

  it("aborts a raw SQL resolve that records a worker", async () => {
    const world = await paused(STAMPED);
    const gateId = `${world.runId}/approve-merge`;
    const db = openDatabase(world.dbPath);
    const resolve = db.prepare("UPDATE hitl_gate SET status = 'resolved', payload = ?, resolved_by = ? WHERE id = ?");

    try {
      expect(() => resolve.run(JSON.stringify(MERGE), JSON.stringify({ class: "worker", id: "a-synthetic", channel: "sql" }), gateId)).toThrow(/resolver outside the gate rule/);
    } finally {
      db.close();
    }
    expect(world.host.gates.get(gateId)?.status).toBe("pending");
  });

  it("leaves a release gate rule-less, so a coordinator abandon of it once the PR is gone resolves", async () => {
    const world = await paused({ gate: "merge", rule: "shepherd-release/owner-gate", stamped: true });
    mergedPr(world.gh);

    const result = await resolveAs(world, "merge", { decision: "abandon", headSha: HEAD });

    expect(result.gate).toMatchObject({ status: "resolved", rule: undefined, resolvedEvidence: { kind: "pr-gone", state: "merged" } });
  });

  it("still lets the coordinator retry the stuck-behind gate that follows it", async () => {
    const world = await paused({ ...STAMPED, thenStuck: true });
    await resolveAs(world, "merge", MERGE);
    await vi.waitFor(() => expect(world.host.gates.get(`${world.runId}/stuck-behind`)?.status).toBe("pending"));

    const result = await resolveAs(world, "stuck-behind", { decision: "retry" });

    expect(result.gate).toMatchObject({ status: "resolved", payload: { decision: "retry" }, resolvedBy: { class: "coordinator" } });
  });
});
