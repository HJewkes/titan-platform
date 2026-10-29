import type { WorkflowRun } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineWorkflow } from "../definition.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { isOwnerAtHeadRow } from "../owner-at-head.js";
import { OWNER_GATE_POLICY } from "../shepherd/policy.js";
import { shepherdFixture } from "../test-support/shepherd.js";
import { approveMergeGate } from "../workflows/land-approval.js";
import { resolveGate } from "./gate.js";
import { ownerEvidence, type ReadReviewerText } from "./owner-evidence.js";

/** TP-4404: land opens each gate here with its live prompt shape; every path, text and sha is synthetic. */
const REPO = "example-org/example-repo";
const H = "a".repeat(40);
const H2 = "c".repeat(40);
const BASE = "b".repeat(40);
const CONFIRM = `action:${"d".repeat(64)}`;
const WORKFLOW = ".github/workflows/ci.yml";
const SKILL = ".claude/skills/synthetic-skill/SKILL.md";
const SOURCE = "src/synthetic.ts";
const LOCATOR = { source: { sourceId: "synthetic:session" }, evidence: { line: { byteOffset: 0 } } };
const VERDICT_TEXT = ["The workflow drops a synthetic job's required flag, which is why I record `other`.", "", "Verdict: MERGE", `PR: ${REPO}#1`, `Head: ${H}`, "CI-policy: weakened other"].join("\n");

const liveGate = defineWorkflow({
  name: "live-merge-gate",
  steps: [{ id: "approve-merge", kind: "assisted" }],
  run: async (ctx) => {
    const rule = ctx.param("rule")!;
    const held = ctx.param("facts")!.split(",").filter(isOwnerAtHeadRow);
    const skillPaths = held.includes("skill-path") ? [SKILL] : [];
    const facts = { reviewedMerge: () => true, skillPathsAt: () => skillPaths, ownerAtHeadAt: () => held.filter((row) => row !== "skill-path") };
    const question = { repo: REPO, pr: Number(ctx.param("pr")), headSha: H, round: 0, reason: "synthetic reason", base: "main" };
    await approveMergeGate({ table: rule.slice(0, rule.indexOf("/")), rowId: rule.slice(rule.indexOf("/") + 1), version: 1 }, facts)(ctx, question);
  },
});

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** The run's merge-evidence step at H, as Shepherd records it, laid over the host's stored run. */
function withEvidenceStep(run: WorkflowRun | undefined): WorkflowRun | undefined {
  if (run === undefined) return undefined;
  const step = { stepId: `sh-merge-evidence:${H}`, iteration: 0, agentId: null, signal: null, completedAt: "2026-10-28T00:00:00.000Z", data: { result: { head: H, record: { verdictLocator: LOCATOR } } } };
  return { ...run, stepResults: { ...run.stepResults, [`sh-merge-evidence:${H}:0`]: step } };
}

function world(changed: readonly string[]) {
  const fixture = shepherdFixture();
  const stored = openFactoryHost({ dbPath: ":memory:", workflows: [...fixture.workflows, liveGate], routes: fixture.routes, gatePollMs: 5 });
  hosts.push(stored);
  const host: FactoryHost = { ...stored, runs: Object.assign(Object.create(stored.runs), { get: (id: string) => withEvidenceStep(stored.runs.get(id)) }) };
  const fake = fixture.fake;
  fake.compares.set(`main...${H}`, { mergeBaseSha: BASE, files: [...changed] });
  fake.files.set(`${BASE}:${WORKFLOW}`, { blobSha: "1", content: "jobs:\n  test:\n    required: true\n" });
  fake.files.set(`${H}:${WORKFLOW}`, { blobSha: "2", content: "jobs:\n  test:\n    required: false\n" });
  fake.files.set(`${H}:${SKILL}`, { blobSha: "3", content: "# Synthetic skill\n" });
  fake.files.set(`${BASE}:${SOURCE}`, { blobSha: "4", content: "export const a = 1;\n" });
  fake.files.set(`${H}:${SOURCE}`, { blobSha: "5", content: "export const a = 2;\n" });
  return { fixture, host, port: fixture.routes.shepherd!.port };
}

type World = ReturnType<typeof world>;

async function gatedPr(w: World, rule: string, facts: readonly string[]) {
  const { number: pr } = w.fixture.fake.addPr({ headSha: H });
  const runId = w.host.runtime.start("live-merge-gate", { pr: String(pr), rule, facts: facts.join(",") });
  const gateId = `${runId}/approve-merge`;
  await vi.waitFor(() => expect(w.host.gates.get(gateId)?.status).toBe("pending"));
  w.fixture.routes.shepherd!.store.get().register({ repo: REPO, pr, runId, task: "demo/T-1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  return { pr, runId, gateId, gate: w.host.gates.get(gateId)! };
}

const readText: ReadReviewerText = async () => VERDICT_TEXT;
const tap = (runId: string, gateId: string, pr: number, evidenceDigest?: string) => ({
  action: { kind: "resolve-gate" as const, gateId, runId, stepId: "approve-merge", repo: REPO, pr, headSha: H, decision: "merge", ...(evidenceDigest !== undefined && { evidenceDigest }) },
  confirmEvent: CONFIRM,
});
const CI_WEAKENED = "shepherd-merge-guard/ci-policy-weakened";

describe("owner-at-head evidence for a console tap", () => {
  it("shows a weakened CI policy as the .github/ diff against the merge base and the reviewer's own CI-policy line and rationale", async () => {
    const w = world([WORKFLOW, SOURCE]);
    const { gate } = await gatedPr(w, CI_WEAKENED, ["ci-policy-weakened"]);

    const evidence = await ownerEvidence(gate, { host: w.host, port: w.port, readText });

    expect(evidence).toMatchObject({ status: "ready", head: H, mergeBase: BASE, facts: ["ci-policy-weakened"] });
    expect(evidence.status === "ready" && evidence.sections).toEqual([
      {
        fact: "ci-policy-weakened",
        files: [{ path: WORKFLOW, lines: [{ side: "-", n: 3, text: "    required: true" }, { side: "+", n: 3, text: "    required: false" }], omitted: 0 }],
        reviewer: { line: "CI-policy: weakened other", text: VERDICT_TEXT },
      },
    ]);
  });

  it("merges at the pinned head on the digest of that evidence, and names the facts the tap covered", async () => {
    const w = world([WORKFLOW]);
    const { pr, runId, gateId, gate } = await gatedPr(w, CI_WEAKENED, ["ci-policy-weakened"]);
    const evidence = await ownerEvidence(gate, { host: w.host, port: w.port, readText });

    const outcome = await resolveGate(tap(runId, gateId, pr, evidence.status === "ready" ? evidence.digest : undefined), w.port, w.host, readText);

    expect(outcome).toEqual({ outcome: "resolved", gateId, covered: ["ci-policy-weakened"] });
    expect(w.host.gates.get(gateId)).toMatchObject({ status: "resolved", payload: { decision: "merge", headSha: H }, resolvedBy: { class: "owner-remote", confirmEvent: CONFIRM } });
  });

  it("refuses a tap that carries no evidence, showing the terminal command", async () => {
    const w = world([WORKFLOW]);
    const { pr, runId, gateId } = await gatedPr(w, CI_WEAKENED, ["ci-policy-weakened"]);

    const outcome = await resolveGate(tap(runId, gateId, pr), w.port, w.host, readText);

    expect(outcome).toMatchObject({ outcome: "refused", reason: "class", detail: expect.stringContaining(`a ci-policy-weakened gate, which the console answers only with its evidence shown; run titan-factory gate resolve ${runId} approve-merge`) });
    expect(w.host.gates.get(gateId)?.status).toBe("pending");
  });

  it("refuses a digest of other evidence, so a reviewer text or diff that changed after the owner read it never merges", async () => {
    const w = world([WORKFLOW]);
    const { pr, runId, gateId } = await gatedPr(w, CI_WEAKENED, ["ci-policy-weakened"]);

    const outcome = await resolveGate(tap(runId, gateId, pr, "e".repeat(64)), w.port, w.host, readText);

    expect(outcome).toMatchObject({ outcome: "refused", reason: "evidence", detail: `the evidence for ${gateId} changed since it was shown; read the item again` });
    expect(w.host.gates.get(gateId)?.status).toBe("pending");
  });

  it("refuses once the PR's head moved past the gate's, and reads the evidence as missing there", async () => {
    const w = world([WORKFLOW]);
    const { pr, runId, gateId, gate } = await gatedPr(w, CI_WEAKENED, ["ci-policy-weakened"]);
    const shown = await ownerEvidence(gate, { host: w.host, port: w.port, readText });
    w.fixture.fake.pushHead(pr, H2);

    const outcome = await resolveGate(tap(runId, gateId, pr, shown.status === "ready" ? shown.digest : undefined), w.port, w.host, readText);
    const after = await ownerEvidence(gate, { host: w.host, port: w.port, readText });

    expect(outcome).toEqual({ outcome: "moved", currentHead: H2 });
    expect(after).toMatchObject({ status: "missing", reason: `${REPO}#${pr} is at cccccccc, not the gate's aaaaaaaa` });
    expect(w.host.gates.get(gateId)?.status).toBe("pending");
  });

  it("reads as missing, with the command, when no .github/ file changed or the reviewer's text is unreadable", async () => {
    const w = world([SOURCE]);
    const { gate } = await gatedPr(w, CI_WEAKENED, ["ci-policy-weakened"]);

    const noGithub = await ownerEvidence(gate, { host: w.host, port: w.port, readText });
    w.fixture.fake.compares.set(`main...${H}`, { mergeBaseSha: BASE, files: [WORKFLOW] });
    const unreadable = await ownerEvidence(gate, { host: w.host, port: w.port, readText: async () => null });

    expect(noGithub).toMatchObject({ status: "missing", reason: "no .github/ file changed, so the weakening is outside what the card shows" });
    expect(unreadable).toMatchObject({ status: "missing", reason: "the reviewer's verdict text could not be read from its session", command: expect.stringContaining(`"headSha":"${H}"`) });
  });

  it("shows a skill change as the skill diff and unread files as every changed file with its diff", async () => {
    const w = world([SKILL, SOURCE]);
    const skill = await gatedPr(w, "shepherd-merge-guard/skill-path", ["skill-path"]);
    const unread = await gatedPr(w, "shepherd-merge-guard/files-unread", ["files-unread"]);

    const skillEvidence = await ownerEvidence(skill.gate, { host: w.host, port: w.port, readText });
    const unreadEvidence = await ownerEvidence(unread.gate, { host: w.host, port: w.port, readText });

    expect(skillEvidence.status === "ready" && skillEvidence.sections).toEqual([{ fact: "skill-path", files: [{ path: SKILL, lines: [{ side: "+", n: 1, text: "# Synthetic skill" }], omitted: 0 }] }]);
    expect(unreadEvidence.status === "ready" && unreadEvidence.sections.map((section) => section.files.map((file) => file.path))).toEqual([[SKILL, SOURCE]]);
  });

  it("reads as missing when a changed line runs past the card's line width, so a tail the card cuts never merges unseen", async () => {
    const w = world([WORKFLOW]);
    const long = `    run: pnpm test ${"x".repeat(160)} || true`;
    w.fixture.fake.files.set(`${H}:${WORKFLOW}`, { blobSha: "6", content: `jobs:\n  test:\n${long}\n` });
    const { gate } = await gatedPr(w, CI_WEAKENED, ["ci-policy-weakened"]);

    const evidence = await ownerEvidence(gate, { host: w.host, port: w.port, readText });

    expect(evidence).toMatchObject({ status: "missing", reason: `${WORKFLOW} has a changed line the card cuts or strips` });
  });

  it("reads as missing when a changed line differs only in characters the card strips", async () => {
    const w = world([WORKFLOW]);
    w.fixture.fake.files.set(`${H}:${WORKFLOW}`, { blobSha: "7", content: "jobs:\n  test:\n    required: true\u001b\n" });
    const { gate } = await gatedPr(w, CI_WEAKENED, ["ci-policy-weakened"]);

    const evidence = await ownerEvidence(gate, { host: w.host, port: w.port, readText });

    expect(evidence).toMatchObject({ status: "missing", reason: `${WORKFLOW} has a changed line the card cuts or strips` });
  });

  it("shows a renamed file's old path as deleted, so a workflow moved out of .github/ still shows on the card", async () => {
    const moved = "docs/ci.yml";
    const w = world([moved]);
    w.fixture.fake.files.set(`${H}:${moved}`, { blobSha: "8", content: "jobs:\n  test:\n    required: true\n" });
    w.fixture.fake.files.delete(`${H}:${WORKFLOW}`);
    const unread = await gatedPr(w, "shepherd-merge-guard/files-unread", ["files-unread"]);
    const weakened = await gatedPr(w, CI_WEAKENED, ["ci-policy-weakened"]);
    for (const { pr } of [unread, weakened]) w.fixture.fake.prFiles.set(pr, [{ path: moved, previousPath: WORKFLOW, status: "renamed" }]);

    const unreadEvidence = await ownerEvidence(unread.gate, { host: w.host, port: w.port, readText });
    const weakenedEvidence = await ownerEvidence(weakened.gate, { host: w.host, port: w.port, readText });

    const deleted = { path: WORKFLOW, lines: [1, 2, 3].map((n) => ({ side: "-", n, text: ["jobs:", "  test:", "    required: true"][n - 1] })), omitted: 0 };
    expect(unreadEvidence.status === "ready" && unreadEvidence.sections[0]!.files).toEqual([expect.objectContaining({ path: moved }), deleted]);
    expect(weakenedEvidence.status === "ready" && weakenedEvidence.sections[0]!.files).toEqual([deleted]);
  });
});
