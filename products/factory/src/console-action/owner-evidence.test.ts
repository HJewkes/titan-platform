import { fakeGitHub, githubPort, type FakeGitHub } from "@titan-design/github";
import type { CiPolicy, CiPolicyKey } from "@titan-design/session-read";
import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gitBlobId } from "../approved-set.js";
import { defineWorkflow } from "../definition.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import type { Verdict } from "../shepherd/phases.js";
import { ownerAtHeadAt, skillPathsAt } from "../shepherd/policy.js";
import { approveMergeGate } from "../workflows/land-approval.js";
import { ownerEvidence, type ReadVerdictText } from "./owner-evidence.js";

/** TP-4404: land opens each gate here from the evidence it was given, with its own fact functions; every value is synthetic. */
const REPO = "example-org/example-repo";
const H = "a".repeat(40);
const RV = { agentId: "agent-rv", sessionId: "session-rv" };
const LOCATOR = { source: { sourceId: "synthetic:session" }, evidence: { line: { byteOffset: 0 } } };
const SOURCE = "src/synthetic.ts";
const SKILL = ".claude/skills/synthetic-skill/SKILL.md";
const WORKFLOW = ".github/workflows/ci.yml";
const MERGE_BASE = "b".repeat(40);
const CI_WEAKENED = "shepherd-merge-guard/ci-policy-weakened";
const BEFORE_OPEN = "2020-01-01T00:00:00.000Z";
const AFTER_OPEN = "2999-01-01T00:00:00.000Z";

const weakened = (...keys: CiPolicyKey[]): CiPolicy => ({ kind: "weakened", keys });
const verdictText = (...lines: string[]) => [...lines.slice(0, -1), "", "Verdict: MERGE", `PR: ${REPO}#1`, `Head: ${H}`, lines.at(-1)!].join("\n");

/** An evidence step's output at H, whole as the step writes it. */
function evidence(ciPolicy?: CiPolicy, changedPaths: string[] = [SOURCE]) {
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

const evidenceStep = (completedAt: string, result: object, iteration: number): StepResult => ({ stepId: `sh-merge-evidence:${H}`, iteration, agentId: null, signal: null, completedAt, data: { result } });

/** Stores `content` at `ref:path` under its real git blob sha, as GitHub answers it. */
const putFile = (fake: FakeGitHub, ref: string, path: string, content: string) => fake.files.set(`${ref}:${path}`, { content, blobSha: gitBlobId(Buffer.from(content, "utf8")) });

/** Opens the gate on `opened`, then lays `steps` over its run as the evidence steps Shepherd recorded. */
async function gateOn(opened: object, steps: StepResult[], rule = CI_WEAKENED) {
  const fake = fakeGitHub({ repo: REPO });
  fake.compares.set(`main...${H}`, { mergeBaseSha: MERGE_BASE, files: [] });
  const stored = openFactoryHost({ dbPath: ":memory:", workflows: [liveGate], routes: [], gatePollMs: 5 });
  hosts.push(stored);
  const withSteps = (run: WorkflowRun | undefined) => run && { ...run, stepResults: { ...run.stepResults, ...Object.fromEntries(steps.map((step) => [`${step.stepId}:${step.iteration}`, step])) } };
  const host: FactoryHost = { ...stored, runs: Object.assign(Object.create(stored.runs), { get: (id: string) => withSteps(stored.runs.get(id)) }) };
  const runId = stored.runtime.start("live-merge-gate", { rule, evidence: JSON.stringify(opened) });
  const gateId = `${runId}/approve-merge`;
  await vi.waitFor(() => expect(stored.gates.get(gateId)?.status).toBe("pending"));
  return { host, fake, port: githubPort(fake.wire), gate: stored.gates.get(gateId)! };
}

const reads =
  (text: string): ReadVerdictText =>
  async () =>
    text;

describe("the owner-at-head evidence card", () => {
  it("heads a decorated weakened line before a canonical unchanged one with the stored reading, listing both lines", async () => {
    const stored = evidence(weakened("secrets"));
    const { host, port, gate } = await gateOn(stored, [evidenceStep(BEFORE_OPEN, stored, 0)]);
    const text = verdictText("**CI policy:** weakened secrets", "CI-policy: unchanged");

    const card = await ownerEvidence(gate, { host, port, readText: reads(text) });

    expect(card).toMatchObject({ status: "ready", head: H, mergeBase: MERGE_BASE, facts: ["ci-policy-weakened"] });
    expect(card.status === "ready" && card.sections).toEqual([
      {
        fact: "ci-policy-weakened",
        ciPolicy: weakened("secrets"),
        verdictText: text,
        labelledLines: [
          { raw: "**CI policy:** weakened secrets", reading: weakened("secrets") },
          { raw: "CI-policy: unchanged", reading: { kind: "unchanged" } },
        ],
        files: [],
      },
    ]);
  });

  it("reads missing when the verdict text no longer reads as the stored CI-policy reading", async () => {
    const stored = evidence(weakened("permissions"));
    const { host, port, gate } = await gateOn(stored, [evidenceStep(BEFORE_OPEN, stored, 0)]);

    const card = await ownerEvidence(gate, { host, port, readText: reads(verdictText("CI-policy: weakened secrets")) });

    expect(card).toMatchObject({ status: "missing", reason: expect.stringContaining("does not read as the evidence's CI-policy reading") });
  });

  it("reads missing when the gate's marker names a fact the evidence does not hold, an unknown one included", async () => {
    const stored = evidence(weakened("secrets"));
    const { host, port, gate } = await gateOn(stored, [evidenceStep(BEFORE_OPEN, stored, 0)]);
    const marked = { ...gate, prompt: gate.prompt.replace("their own head: ci-policy-weakened.", "their own head: ci-policy-weakened, bogus.") };

    const card = await ownerEvidence(marked, { host, port, readText: reads(verdictText("CI-policy: weakened secrets")) });

    expect(card).toMatchObject({ status: "missing", facts: ["ci-policy-weakened", "bogus"] });
  });

  it("shows the evidence the gate opened on, not a re-read that completed after it", async () => {
    const opened = evidence(weakened("secrets"));
    const reread = evidence(weakened("permissions"));
    const { host, port, gate } = await gateOn(opened, [evidenceStep(BEFORE_OPEN, opened, 0), evidenceStep(AFTER_OPEN, reread, 1)]);

    const card = await ownerEvidence(gate, { host, port, readText: reads(verdictText("CI-policy: weakened secrets")) });

    expect(card.status === "ready" && card.sections.map((section) => section.ciPolicy)).toEqual([weakened("secrets")]);
  });

  it("shows a renamed workflow's old path as deleted, since the evidence lists both sides of the rename", async () => {
    const renamedTo = "docs/ci.yml";
    const stored = evidence(weakened("other"), [renamedTo, WORKFLOW]);
    const { host, fake, port, gate } = await gateOn(stored, [evidenceStep(BEFORE_OPEN, stored, 0)]);
    fake.compares.set(`main...${H}`, { mergeBaseSha: MERGE_BASE, files: [renamedTo] });
    putFile(fake, MERGE_BASE, WORKFLOW, "on: push\njobs: {}\n");
    putFile(fake, H, renamedTo, "on: push\njobs: {}\n");

    const card = await ownerEvidence(gate, { host, port, readText: reads(verdictText("CI-policy: weakened other")) });

    expect(card.status === "ready" && card.sections.map((section) => section.files)).toEqual([
      [{ path: WORKFLOW, rows: [{ side: "-", n: 1, text: "on: push\\u{A}" }, { side: "-", n: 2, text: "jobs: {}\\u{A}" }] }],
    ]);
  });

  it("shows a skill change's file exactly against the merge base", async () => {
    const stored = evidence(undefined, [SKILL]);
    const { host, fake, port, gate } = await gateOn(stored, [evidenceStep(BEFORE_OPEN, stored, 0)], "authority/MRG-AU");
    putFile(fake, H, SKILL, "# Synthetic skill\n");

    const card = await ownerEvidence(gate, { host, port, readText: reads(verdictText("CI-policy: unchanged")) });

    expect(card).toMatchObject({ status: "ready", facts: ["skill-path"], sections: [{ fact: "skill-path", files: [{ path: SKILL, rows: [{ side: "+", n: 1, text: "# Synthetic skill\\u{A}" }] }] }] });
  });

  it("reads missing, with the terminal command, for a files-unread gate, whose evidence holds no file list to show", async () => {
    const stored = { ...evidence(), changedFilesUnread: "synthetic: the file list was cut short" };
    const { host, port, gate } = await gateOn(stored, [evidenceStep(BEFORE_OPEN, stored, 0)], "authority/MRG-AU");

    const card = await ownerEvidence(gate, { host, port, readText: reads(verdictText("CI-policy: unchanged")) });

    expect(card).toMatchObject({ status: "missing", facts: ["files-unread"], reason: expect.stringContaining("files-unread"), command: expect.stringContaining(`"headSha":"${H}"`) });
  });

  it("reads missing when no evidence step completed before the gate opened", async () => {
    const stored = evidence(weakened("secrets"));
    const { host, port, gate } = await gateOn(stored, [evidenceStep(AFTER_OPEN, stored, 0)]);

    const card = await ownerEvidence(gate, { host, port, readText: reads(verdictText("CI-policy: weakened secrets")) });

    expect(card).toMatchObject({ status: "missing", reason: expect.stringContaining("no well-formed merge evidence") });
  });
});
