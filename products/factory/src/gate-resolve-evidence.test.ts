import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { EvidenceSources } from "./coordinator-evidence-read.js";
import { defineWorkflow } from "./definition.js";
import { acknowledgeBrief, approveMergeDecision, frozenDecision, sentBackDecision } from "./gate-brief.js";
import { resolveGate, type OwnerPresence } from "./gate-resolve.js";
import { openFactoryHost, type FactoryHost } from "./host.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./shepherd/policy.js";
import { codeRoute, step } from "./workflows/land.js";

const REPO = "o/r";
const HEAD = fakeSha("head");
const MERGE_SHA = fakeSha("merge");
const TIP = fakeSha("tip");
const AGENT_SHELL = { AGENT_CHAT_AGENT_ID: "agent-1", AGENT_CHAT_NAME: "tc-synthetic" };
const AUTO: EffectivePolicy = { merge: "auto", mergeMethod: "squash", fixer: true, seat: "synthetic" };
const OwnerAck = z.object({ decision: z.literal("acknowledged"), mergeSha: z.string() });
const NOW = Date.parse("2026-10-07T18:00:00Z");

interface Scenario {
  gate: "merge" | "sent-back" | "main-red" | "main-frozen";
  rule?: string;
  verdict?: string;
  policy?: EffectivePolicy;
}

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
    { id: "main-red", kind: "assisted" },
    { id: "main-frozen", kind: "assisted" },
  ],
  run: async (ctx) => {
    const scenario = JSON.parse(ctx.param("scenario")!) as Scenario;
    if (scenario.gate === "main-red") return void (await ctx.assisted("main-red", `Main CI on ${REPO} at merge ${MERGE_SHA} (PR #1) is red: failed: validate. Acknowledge.`, { schema: OwnerAck, brief: acknowledgeBrief({ repo: REPO, mergeSha: MERGE_SHA, headline: "Main CI is red", detail: "failed: validate" }) }));
    if (scenario.gate === "main-frozen") {
      const prompt = `Main CI on ${REPO} at merge ${MERGE_SHA} (PR #1) is red: failed: validate. The repo is frozen. Stay frozen, or unfreeze?`;
      return void (await ctx.assisted("main-frozen", prompt, frozenDecision({ repo: REPO, mergeSha: MERGE_SHA, situation: prompt })));
    }
    if (scenario.gate === "sent-back") return void (await ctx.assisted("sh-sent-back", "Sent back.", sentBackDecision({ repo: REPO, pr: 1, headSha: HEAD, situation: "the reviewer sent it back" })));
    await step(ctx, `sh-await-verdict:${HEAD}`, { kind: "verdict", verdict: scenario.verdict ?? "MERGE", head: HEAD, reviewer: { agentId: "rv-synthetic" } }, Verdict);
    const [table, rowId] = (scenario.rule ?? "authority/MRG-AU").split("/");
    await step(ctx, "merge-policy:0", { outcome: "gate", headSha: HEAD, rule: { table, rowId, version: 1 }, reason: "synthetic" }, Decision);
    const prompt = `Merge PR #1 in ${REPO} at head ${HEAD}? CI is green. Policy ${table}/${rowId}: synthetic`;
    await ctx.assisted("approve-merge", prompt, approveMergeDecision({ repo: REPO, pr: 1, headSha: HEAD, reason: "synthetic", reviewedMerge: true }));
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
  runId: string;
  gh: FakeGitHub;
  sources: EvidenceSources;
  registration: { held: boolean; frozen: boolean };
}

async function paused(scenario: Scenario): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "factory-gate-evidence-"));
  dirs.push(dir);
  const host = openFactoryHost({ dbPath: join(dir, "factory.sqlite3"), workflows: [shepherdPr], routes, gatePollMs: 10 });
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
  return { host, runId, gh, sources, registration };
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

function presenceStub(): { presence: OwnerPresence; reasons: string[] } {
  const reasons: string[] = [];
  return { reasons, presence: async (reason) => (reasons.push(reason), undefined) };
}

const STEPS: Record<Scenario["gate"], string> = { merge: "approve-merge", "sent-back": "sh-sent-back", "main-red": "main-red", "main-frozen": "main-frozen" };

async function resolveAs(world: World, gate: Scenario["gate"], payload: object) {
  const { presence, reasons } = presenceStub();
  let out = "";
  let err = "";
  const io = { stdout: (t: string) => void (out += t), stderr: (t: string) => void (err += t), env: AGENT_SHELL };
  const code = await resolveGate(world.host, io, world.runId, STEPS[gate], JSON.stringify(payload), presence, world.sources).catch((error: Error) => ((err += error.message), 1));
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
      run: { rule: "authority/MRG-AU", merge: "auto", held: false, frozen: false },
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

    await resolveGate(world.host, io, world.runId, "approve-merge", JSON.stringify(MERGE), presenceStub().presence, world.sources);

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

    expect(result.gate).toMatchObject({ status: "resolved", resolvedEvidence: { kind: "pr-gone", state: "closed", run: { rule: "authority/MRG-AU" } } });
  });

  it("falls back on an abandon while the PR is still open", async () => {
    const world = await paused({ gate: "sent-back" });

    expectFellBack(await resolveAs(world, "sent-back", { decision: "abandon" }));
  });

  it("falls back on an abandon of a closed PR's visual-path gate", async () => {
    const world = await paused({ gate: "merge", rule: "shepherd-merge-guard/visual-path" });
    world.gh.pr(1).state = "closed";

    expectFellBack(await resolveAs(world, "merge", { decision: "abandon", headSha: HEAD }));
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
