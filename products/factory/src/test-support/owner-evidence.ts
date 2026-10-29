import { fakeGitHub, githubPort, type FakeGitHub } from "@titan-design/github";
import type { CiPolicy, CiPolicyKey } from "@titan-design/session-read";
import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { afterEach, expect, vi } from "vitest";
import { gitBlobId } from "../approved-set.js";
import type { ReadVerdictText } from "../console-action/owner-evidence.js";
import { defineWorkflow } from "../definition.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import type { Verdict } from "../shepherd/phases.js";
import { ownerAtHeadAt, skillPathsAt } from "../shepherd/policy.js";
import { approveMergeGate } from "../workflows/land-approval.js";

/** TP-4404: land opens each gate here from the evidence it was given, with its own fact functions; every value is synthetic. */
export const REPO = "example-org/example-repo";
export const H = "a".repeat(40);
const RV = { agentId: "agent-rv", sessionId: "session-rv" };
const LOCATOR = { source: { sourceId: "synthetic:session" }, evidence: { line: { byteOffset: 0 } } };
export const SOURCE = "src/synthetic.ts";
export const SKILL = ".claude/skills/synthetic-skill/SKILL.md";
export const WORKFLOW = ".github/workflows/ci.yml";
export const MERGE_BASE = "b".repeat(40);
export const CI_WEAKENED = "shepherd-merge-guard/ci-policy-weakened";
export const BEFORE_OPEN = "2020-01-01T00:00:00.000Z";
export const AFTER_OPEN = "2999-01-01T00:00:00.000Z";

export const weakened = (...keys: CiPolicyKey[]): CiPolicy => ({ kind: "weakened", keys });
export const verdictText = (...lines: string[]) => [...lines.slice(0, -1), "", "Verdict: MERGE", `PR: ${REPO}#1`, `Head: ${H}`, lines.at(-1)!].join("\n");

/** An evidence step's output at H, whole as the step writes it. */
export function evidence(ciPolicy?: CiPolicy, changedPaths: string[] = [SOURCE]) {
  const merge = { head: H, resolver: RV, dispatchedReviewer: RV, verdict: { value: "MERGE", head: H }, requiredContexts: [], allowedApps: [], checkRuns: [], mergeTreeClean: true, repoFrozen: false, changedPaths, seatGrants: [] };
  const record = { runId: "run-1", repo: REPO, pr: 1, head: H, baseRef: "main", testMergeSha: null, checkRuns: [], verdictLocator: LOCATOR, reviewer: RV, decision: { outcome: "gate", rule: { table: "shepherd-merge-guard", rowId: "ci-policy-weakened", version: 1 }, reason: "synthetic" } };
  return { head: H, merge, record, ...(ciPolicy && { ciPolicy }) };
}

const liveGate = defineWorkflow({
  name: "live-merge-gate",
  steps: [{ id: "approve-merge", kind: "assisted" }],
  run: async (ctx) => {
    const rule = ctx.param("rule")!;
    const verdictFor = (head: string): Verdict => ({ kind: "MERGE", headSha: head, evidence: JSON.parse(ctx.param("evidence")!) });
    const facts = { reviewedMerge: () => true, skillPathsAt: (head: string) => skillPathsAt(head, verdictFor), ownerAtHeadAt: (head: string) => ownerAtHeadAt(head, verdictFor) };
    const question = { repo: REPO, pr: 1, headSha: H, round: 0, reason: "synthetic reason", base: "main" };
    await approveMergeGate({ table: rule.slice(0, rule.indexOf("/")), rowId: rule.slice(rule.indexOf("/") + 1), version: 1 }, facts)(ctx, question);
  },
});

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

export const evidenceStep = (completedAt: string, result: object, iteration: number): StepResult => ({ stepId: `sh-merge-evidence:${H}`, iteration, agentId: null, signal: null, completedAt, data: { result } });

/** Stores `content` at `ref:path` under its real git blob sha, as GitHub answers it. */
export const putFile = (fake: FakeGitHub, ref: string, path: string, content: string) => fake.files.set(`${ref}:${path}`, { content, blobSha: gitBlobId(Buffer.from(content, "utf8")) });

/** Opens the gate on `opened`, then lays `steps` over its run as the evidence steps Shepherd recorded. */
export async function gateOn(opened: object, steps: StepResult[], rule = CI_WEAKENED) {
  const fake = fakeGitHub({ repo: REPO });
  fake.compares.set(`main...${H}`, { mergeBaseSha: MERGE_BASE, files: [] });
  fake.addPr({ headSha: H });
  const stored = openFactoryHost({ dbPath: ":memory:", workflows: [liveGate], routes: [], gatePollMs: 5 });
  hosts.push(stored);
  const withSteps = (run: WorkflowRun | undefined) => run && { ...run, stepResults: { ...run.stepResults, ...Object.fromEntries(steps.map((step) => [`${step.stepId}:${step.iteration}`, step])) } };
  const host: FactoryHost = { ...stored, runs: Object.assign(Object.create(stored.runs), { get: (id: string) => withSteps(stored.runs.get(id)) }) };
  const runId = stored.runtime.start("live-merge-gate", { rule, evidence: JSON.stringify(opened) });
  const gateId = `${runId}/approve-merge`;
  await vi.waitFor(() => expect(stored.gates.get(gateId)?.status).toBe("pending"));
  return { host, fake, port: githubPort(fake.wire), gate: stored.gates.get(gateId)! };
}

export const reads =
  (text: string): ReadVerdictText =>
  async () =>
    text;
