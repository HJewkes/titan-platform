import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { EvidenceSources } from "./coordinator-evidence-read.js";
import { defineWorkflow } from "./definition.js";
import { approveMergeDecision, ciFailedDecision } from "./gate-brief.js";
import { reviewGates, type ReviewGate } from "./gate-review-read.js";
import { openFactoryHost, type FactoryHost } from "./host.js";
import { invokeCommand } from "@titan-design/registry";
import { createFactoryRegistry } from "./registry.js";
import { OWNER_GATE_POLICY } from "./shepherd/policy.js";
import { codeRoute, step } from "./workflows/land.js";

const REPO = "o/r";
const HEAD = fakeSha("head");
const OLD_HEAD = fakeSha("old");
const TIP = fakeSha("tip");
const NOW = Date.parse("2026-10-07T18:00:00Z");

const Scenario = z.object({
  gate: z.enum(["merge", "ci-failed"]),
  pr: z.number(),
  rule: z.string().optional(),
  /** The head the recorded verdict is for; defaults to the gate's own head. */
  verdictHead: z.string().optional(),
});
type Scenario = z.infer<typeof Scenario>;

const Verdict = z.looseObject({ kind: z.string(), verdict: z.string(), head: z.string(), reviewer: z.looseObject({ agentId: z.string() }) });

const shepherdPr = defineWorkflow({
  name: "shepherd-pr",
  steps: [{ id: "sh-await-verdict", kind: "dispatch" }, { id: "approve-merge", kind: "assisted" }, { id: "ci-failed", kind: "assisted" }],
  run: async (ctx) => {
    const scenario = Scenario.parse(JSON.parse(ctx.param("scenario")!));
    if (scenario.gate === "ci-failed") return void (await ctx.assisted("ci-failed", "CI failed.", ciFailedDecision({ repo: REPO, pr: scenario.pr, headSha: HEAD, failing: [{ name: "validate", conclusion: "failure", url: "https://example.test/job/1", workflowRunId: null }] })));
    const verdictHead = scenario.verdictHead ?? HEAD;
    await step(ctx, `sh-await-verdict:${verdictHead}`, { kind: "verdict", verdict: "MERGE", head: verdictHead, reviewer: { agentId: "rv-synthetic" } }, Verdict);
    const [table, rowId] = (scenario.rule ?? "authority/MRG-AU").split("/");
    const prompt = `Merge PR #${scenario.pr} in ${REPO} at head ${HEAD}? CI is green. Policy ${table}/${rowId}: gating on nothing`;
    await ctx.assisted("approve-merge", prompt, approveMergeDecision({ repo: REPO, pr: scenario.pr, headSha: HEAD, reason: "gating on nothing", reviewedMerge: true }));
  },
});

const echo = async (input: object): Promise<object> => input;
const routes = [codeRoute("sh-await-verdict", () => NOW, echo)];

const dirs: string[] = [];
const hosts: FactoryHost[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

interface World {
  host: FactoryHost;
  gh: FakeGitHub;
  sources: EvidenceSources;
}

async function world(scenarios: Scenario[]): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "factory-gate-review-"));
  dirs.push(dir);
  const host = openFactoryHost({ dbPath: join(dir, "factory.sqlite3"), workflows: [shepherdPr], routes, gatePollMs: 10 });
  hosts.push(host);
  for (const scenario of scenarios) host.runtime.start("shepherd-pr", { repo: REPO, pr: String(scenario.pr), policy: JSON.stringify(OWNER_GATE_POLICY), scenario: JSON.stringify(scenario) });
  await vi.waitFor(() => expect(host.pendingGates()).toHaveLength(scenarios.length));
  const gh = fakeGitHub({ repo: REPO, baseSha: TIP });
  gh.addPr({ headSha: HEAD });
  gh.setRuns(HEAD, [successRun("validate", 11), successRun("dag-check", 12)]);
  const sources: EvidenceSources = { port: githubPort(gh.wire), registration: () => undefined, frozen: () => false, now: () => NOW };
  return { host, gh, sources };
}

async function reviewOf(w: World, pr: number): Promise<ReviewGate> {
  const gate = (await reviewGates(w.host, w.sources)).find((candidate) => candidate.pr === pr);
  return gate!;
}

describe("reviewGates", () => {
  it("shows a land merge gate's PR, head, rule, the reviewer's MERGE at that head and green required checks", async () => {
    const w = await world([{ gate: "merge", pr: 1 }]);

    expect(await reviewOf(w, 1)).toMatchObject({ repo: REPO, pr: 1, headSha: HEAD, rule: "authority/MRG-AU", batchable: true, verdict: { verdict: "MERGE", reviewer: "rv-synthetic" }, checks: { state: "green", failing: [] } });
  });

  it("shows no verdict for a verdict recorded at an earlier head", async () => {
    const w = await world([{ gate: "merge", pr: 1, verdictHead: OLD_HEAD }]);

    expect((await reviewOf(w, 1)).verdict).toBeNull();
  });

  it("names a failing required check, and reads a missing one as pending rather than green", async () => {
    const w = await world([{ gate: "merge", pr: 1 }]);
    w.gh.setRuns(HEAD, [successRun("validate", 11), successRun("dag-check", 12, undefined, "failure")]);
    const failing = (await reviewOf(w, 1)).checks;
    w.gh.setRuns(HEAD, [successRun("validate", 11)]);
    const pending = (await reviewOf(w, 1)).checks;

    expect(failing).toEqual({ state: "failing", failing: ["dag-check"] });
    expect(pending).toEqual({ state: "pending", failing: [] });
  });

  it("lists a release-table gate and a ci-failed gate as not batchable, with the reason", async () => {
    const w = await world([{ gate: "merge", pr: 1, rule: "shepherd-release/cut" }]);
    const release = await reviewOf(w, 1);
    const other = await world([{ gate: "ci-failed", pr: 1 }]);
    const ciFailed = (await reviewGates(other.host, other.sources))[0]!;

    expect(release.batchable).toEqual({ refusal: "a release gate" });
    expect(ciFailed).toMatchObject({ batchable: { refusal: "not a merge gate at a pinned head" }, repo: null, pr: null, headSha: null });
  });

  it("reads one PR GitHub cannot answer as unreadable while the other gate still carries its checks", async () => {
    const w = await world([{ gate: "merge", pr: 1 }, { gate: "merge", pr: 2 }]);

    const gates = await reviewGates(w.host, w.sources);

    expect(gates.find((gate) => gate.pr === 1)?.checks.state).toBe("green");
    expect(gates.find((gate) => gate.pr === 2)?.checks).toEqual({ state: "unreadable", failing: [] });
  });

  it("reads no verdict or checks without Shepherd's sources", async () => {
    const w = await world([{ gate: "merge", pr: 1 }]);

    const [gate] = await reviewGates(w.host);

    expect(gate).toMatchObject({ pr: 1, headSha: HEAD, verdict: null, checks: { state: "unreadable" } });
  });

  it("writes nothing: the gate stays pending, no batch opens and no resolve is attempted", async () => {
    const w = await world([{ gate: "merge", pr: 1 }]);
    const resolve = vi.spyOn(w.host.gates, "resolve");
    const open = vi.spyOn(w.host.batches, "open");
    const before = JSON.stringify([w.host.gates.get(w.host.pendingGates()[0]!.gate.id), w.host.runtime.list()]);

    await reviewGates(w.host, w.sources);
    const { envelope } = await invokeReview(w);

    expect(envelope.ok).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(JSON.stringify([w.host.gates.get(w.host.pendingGates()[0]!.gate.id), w.host.runtime.list()])).toBe(before);
  });
});

async function invokeReview(w: World) {
  const command = createFactoryRegistry().get("factory.gates-review")!;
  return invokeCommand(command, {}, { warnings: [], format: "json", host: w.host, aud: "basement" });
}
