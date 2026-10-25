import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateResolver } from "@titan-design/hitl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGate } from "./console-action/gate.js";
import { coordinatorEvidencePolicy, landGate } from "./coordinator-evidence.js";
import { defineWorkflow } from "./definition.js";
import { checkAnswer } from "./gate-answer-check.js";
import { itemsRefusal } from "./gate-batch-plan.js";
import { openFactoryHost, type FactoryHost } from "./host.js";
import { mergeAtHead } from "./owner-ops/merge-at-head.js";
import { standingAnswers, sweepStandingAnswers } from "./owner-ops/standing-answers.js";
import { LAND_WORKFLOW } from "./registry.js";
import { OWNER_GATE_POLICY } from "./shepherd/policy.js";
import { authorityGateReason, pendingCheck } from "./test-support/authority-reason.js";
import { shepherdFixture } from "./test-support/shepherd.js";
import { approveMergeGate } from "./workflows/land-approval.js";

/**
 * TP-4141: land opens an approve-merge gate whose prompt carries the reviewer's owner brief, and for a skill-path gate a
 * skill-diff line, under the policy line. Each gate here is opened by land's own `approveMergeGate`, so every prompt has
 * the live shape; all text is synthetic.
 */
const REPO = "example-org/example-repo";
const H = "a".repeat(40);
const CONFIRM = `action:${"d".repeat(64)}`;
const NOW_MS = Date.parse("2026-10-24T12:00:00.000Z");
const MRG_AU = "authority/MRG-AU";
const SKILL_PATH = "shepherd-merge-guard/skill-path";
const MECHANICAL = authorityGateReason(H, pendingCheck(H));
const SKILLS = [".claude/skills/synthetic-skill/SKILL.md"];
const OWNER_BRIEF = { what: "Adds a synthetic helper.", why: "A made-up caller needs it.", pros: ["Small change."], cons: ["One more export."], doorType: "two-way" as const };
const COORDINATOR: GateResolver = { class: "coordinator", id: "tc-synthetic", channel: "factory-cli" };

const liveGate = defineWorkflow({
  name: "live-merge-gate",
  steps: [{ id: "approve-merge", kind: "assisted" }],
  run: async (ctx) => {
    const [table, rowId] = ctx.param("rule")!.split("/") as [string, string];
    const skillPaths = table === "shepherd-merge-guard" ? SKILLS : [];
    const facts = { reviewedMerge: () => true, ownerBriefAt: () => OWNER_BRIEF, skillPathsAt: () => skillPaths };
    await approveMergeGate({ table, rowId, version: 1 }, facts)(ctx, { repo: REPO, pr: Number(ctx.param("pr")), headSha: H, round: 0, reason: ctx.param("reason")!, base: "main" });
  },
});

const hosts: FactoryHost[] = [];
const dirs: string[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function world() {
  const fixture = shepherdFixture();
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [...fixture.workflows, liveGate], routes: fixture.routes, gatePollMs: 5 });
  hosts.push(host);
  const dir = mkdtempSync(join(tmpdir(), "factory-land-gate-multiline-"));
  dirs.push(dir);
  const services = fixture.routes.shepherd!;
  const answers = standingAnswers(dir);
  return { fixture, host, services, answers, deps: { host, port: services.port, services, answers, now: () => NOW_MS } };
}

type World = ReturnType<typeof world>;

/** A PR whose Shepherd run waits on a live-shaped approve-merge gate under `rule`. */
async function gatedPr(w: World, rule: string, reason = rule === MRG_AU ? MECHANICAL : "the owner reviews repo skill changes") {
  const { number: pr } = w.fixture.fake.addPr({ headSha: H });
  const runId = w.host.runtime.start("live-merge-gate", { pr: String(pr), rule, reason });
  const gateId = `${runId}/approve-merge`;
  await vi.waitFor(() => expect(w.host.gates.get(gateId)?.status).toBe("pending"));
  w.services.store.get().register({ repo: REPO, pr, runId, task: "demo/T-1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  return { pr, runId, gateId, gate: w.host.gates.get(gateId)! };
}

function mergeEvidence(gateId: string, pr: number, rule: string, reason: string) {
  const runs = ["validate", "dag-check"].map((name, i) => ({ id: i + 1, name, conclusion: "success", headSha: H }));
  return {
    ...{ kind: "approve-merge", gateId, repo: REPO, pr, headSha: H, checks: { base: "main", required: ["validate", "dag-check"], runs } },
    ...{ run: { workflow: "shepherd-pr", repo: REPO, pr, rule, reason, merge: "auto", visualPaths: false, held: false, frozen: false } },
    ...{ verdict: { step: `sh-await-verdict:${H}`, verdict: "MERGE", head: H, reviewer: "rv-synthetic" } },
    ...{ pull: { state: "open", headSha: H, mergeableState: "clean", mergeable: "MERGEABLE" }, readAt: "2026-10-24T12:00:00.000Z" },
  };
}

const tapRead = (runId: string, gateId: string, pr: number) => ({ action: { kind: "resolve-gate" as const, gateId, runId, stepId: "approve-merge", repo: REPO, pr, headSha: H, decision: "merge" }, confirmEvent: CONFIRM });
const mergeItem = (runId: string, gateId: string, pr: number) => ({ gate: gateId, runId, stepId: "approve-merge", repo: REPO, pr, headSha: H, payload: { decision: "merge", headSha: H } });
const landRuns = (host: FactoryHost) => host.runtime.list(["running", "paused", "completed"]).filter((run) => run.workflowName === LAND_WORKFLOW);

describe("a live-shaped multi-line MRG-AU gate", () => {
  it("reads as a land gate on its policy line, with the owner brief below it", async () => {
    const { pr, gate } = await gatedPr(world(), MRG_AU);

    expect(gate.prompt.split("\n").length).toBeGreaterThan(2);
    expect(landGate(gate)).toEqual({ repo: REPO, pr, head: H, rule: MRG_AU, reason: MECHANICAL });
  });

  it("admits a coordinator's mechanical merge on matching evidence", async () => {
    const { pr, gate, gateId } = await gatedPr(world(), MRG_AU);

    expect(coordinatorEvidencePolicy(gate, COORDINATOR, { decision: "merge", headSha: H }, mergeEvidence(gateId, pr, MRG_AU, MECHANICAL))).toBe(true);
  });

  it("is resolved at once by the owner's merge-at-head tap, starting no land-pr", async () => {
    const w = world();
    const { pr, gateId } = await gatedPr(w, MRG_AU);

    const outcome = await mergeAtHead("act-1", { op: { kind: "merge-at-head", repo: REPO, pr, headSha: H }, confirmEvent: CONFIRM }, w.deps);

    expect(outcome).toEqual({ outcome: "resolved", gateId });
    expect(landRuns(w.host)).toEqual([]);
  });

  it("rides in a gate batch beside another such gate", async () => {
    const w = world();
    const first = await gatedPr(w, MRG_AU);
    const second = await gatedPr(w, MRG_AU);

    expect(itemsRefusal(w.host, [mergeItem(first.runId, first.gateId, first.pr), mergeItem(second.runId, second.gateId, second.pr)])).toBeUndefined();
  });

  it("is resolved by a console tap as owner-remote", async () => {
    const w = world();
    const { pr, runId, gateId } = await gatedPr(w, MRG_AU);

    const outcome = await resolveGate(tapRead(runId, gateId, pr), w.services.port, w.host);

    expect(outcome).toEqual({ outcome: "resolved", gateId });
    expect(w.host.gates.get(gateId)?.resolvedBy).toMatchObject({ class: "owner-remote", confirmEvent: CONFIRM });
  });
});

describe("a live-shaped multi-line skill-path gate", () => {
  it("reads as the skill-path rule, and a coordinator's merge is refused on evidence that matches it", async () => {
    const { pr, gate, gateId } = await gatedPr(world(), SKILL_PATH);

    const reason = landGate(gate)!.reason;

    expect(gate.prompt).toContain(`https://github.com/${REPO}/pull/${pr}/files`);
    expect(landGate(gate)?.rule).toBe(SKILL_PATH);
    expect(coordinatorEvidencePolicy(gate, COORDINATOR, { decision: "merge", headSha: H }, mergeEvidence(gateId, pr, SKILL_PATH, reason))).toBe(false);
  });

  it("is refused by a console tap and by merge-at-head, which starts no land-pr", async () => {
    const w = world();
    const { pr, runId, gateId } = await gatedPr(w, SKILL_PATH);

    const tapped = await resolveGate(tapRead(runId, gateId, pr), w.services.port, w.host);
    const merged = await mergeAtHead("act-1", { op: { kind: "merge-at-head", repo: REPO, pr, headSha: H }, confirmEvent: CONFIRM }, w.deps);

    expect(tapped).toMatchObject({ outcome: "refused", reason: "class", detail: expect.stringContaining("a skill-path gate") });
    expect(merged).toMatchObject({ outcome: "refused", reason: "class" });
    expect(landRuns(w.host)).toEqual([]);
    expect(w.host.gates.get(gateId)?.status).toBe("pending");
  });

  it("is refused in a gate batch, by a standing answer and by a Ship answer", async () => {
    const w = world();
    const mechanical = await gatedPr(w, MRG_AU);
    const skill = await gatedPr(w, SKILL_PATH);
    await w.answers.add({ actionId: "act-2", confirmEvent: CONFIRM, repo: REPO, pr: skill.pr, headSha: H, runId: skill.runId, expiresAt: "2026-10-25T12:00:00.000Z" });
    const request = { runId: skill.runId, gateId: skill.gateId, headSha: H, tree: "t", packetSha: "p", roundId: "r", choice: "merge" as const };
    const files = { round: new Uint8Array(), packet: new Uint8Array(), feedback: new Uint8Array() };

    const batched = itemsRefusal(w.host, [mergeItem(mechanical.runId, mechanical.gateId, mechanical.pr), mergeItem(skill.runId, skill.gateId, skill.pr)]);
    const swept = await sweepStandingAnswers(w.host, w.services, w.answers, new Date(NOW_MS));
    const shipped = await checkAnswer({ host: w.host, port: w.services.port, request, files, now: new Date(NOW_MS) });

    expect(batched).toBe(`item 2: ${skill.gateId} is a skill-path gate; it stays one per proof`);
    expect(swept).toEqual([{ kind: "pending", actionId: "act-2", runId: skill.runId, reason: `${skill.gateId} is a skill-path gate, which no standing answer gives` }]);
    expect(shipped).toMatchObject({ kind: "refused", reason: "not-land-gate", detail: expect.stringContaining("skill-path gate") });
    expect(w.host.gates.get(skill.gateId)?.status).toBe("pending");
  });
});
