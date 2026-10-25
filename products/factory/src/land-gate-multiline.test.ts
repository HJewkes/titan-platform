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
import { OWNER_AT_HEAD_LEAD, isOwnerAtHeadRow } from "./owner-at-head.js";
import { mergeAtHead } from "./owner-ops/merge-at-head.js";
import { standingAnswers, sweepStandingAnswers } from "./owner-ops/standing-answers.js";
import { LAND_WORKFLOW } from "./registry.js";
import { OWNER_GATE_POLICY } from "./shepherd/policy.js";
import { authorityGateReason, pendingCheck } from "./test-support/authority-reason.js";
import { shepherdFixture } from "./test-support/shepherd.js";
import { approveMergeAsk, approveMergeGate } from "./workflows/land-approval.js";

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
/** The D21 merge-guard rows the owner reads at their own head, which no remote path answers. */
const OWNER_AT_HEAD = [SKILL_PATH, "shepherd-merge-guard/ci-policy-weakened", "shepherd-merge-guard/ci-policy-malformed"];
const MECHANICAL = authorityGateReason(H, pendingCheck(H));
const SKILLS = [".claude/skills/synthetic-skill/SKILL.md"];
const OWNER_BRIEF = { what: "Adds a synthetic helper.", why: "A made-up caller needs it.", pros: ["Small change."], cons: ["One more export."], doorType: "two-way" as const };
const COORDINATOR: GateResolver = { class: "coordinator", id: "tc-synthetic", channel: "factory-cli" };

const liveGate = defineWorkflow({
  name: "live-merge-gate",
  steps: [{ id: "approve-merge", kind: "assisted" }],
  run: async (ctx) => {
    const rule = ctx.param("rule")!;
    const table = rule.slice(0, rule.indexOf("/"));
    const rowId = rule.slice(rule.indexOf("/") + 1);
    const skillPaths = rule === SKILL_PATH || ctx.param("skills") === "yes" ? SKILLS : [];
    const held = (ctx.param("facts") ?? "").split(",").filter(isOwnerAtHeadRow);
    const facts = { reviewedMerge: () => true, ownerBriefAt: () => OWNER_BRIEF, skillPathsAt: () => skillPaths, ownerAtHeadAt: () => held };
    const question = { repo: REPO, pr: Number(ctx.param("pr")), headSha: H, round: 0, reason: ctx.param("reason")!, base: "main" };
    if (ctx.param("preMarker") !== "yes") return void (await approveMergeGate({ table, rowId, version: 1 }, facts)(ctx, question));
    const { prompt, schema, brief } = approveMergeAsk({ table, rowId, version: 1 }, facts, question);
    await ctx.assisted("approve-merge", prompt.split("\n").filter((line) => !line.startsWith(OWNER_AT_HEAD_LEAD)).join("\n"), { schema, brief });
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
interface Shape {
  skills?: boolean;
  /** D21 facts the gate's head holds, whatever its rule. */
  facts?: readonly string[];
  /** Opens the gate with its marker line stripped, as a gate opened before markers existed reads. */
  preMarker?: boolean;
}

async function gatedPr(w: World, rule: string, { skills = false, facts = [], preMarker = false }: Shape = {}) {
  const reason = rule === MRG_AU ? MECHANICAL : `the owner reads ${rule} changes at their head`;
  const { number: pr } = w.fixture.fake.addPr({ headSha: H });
  const params = { pr: String(pr), rule, reason, skills: skills ? "yes" : "no", facts: facts.join(","), preMarker: preMarker ? "yes" : "no" };
  const runId = w.host.runtime.start("live-merge-gate", params);
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

/** Each D21 merge-guard row the owner reads at their own head, named as the remote paths name it in their refusals. */
const ownerRows = OWNER_AT_HEAD.map((rule) => ({ rule, row: rule.slice(rule.indexOf("/") + 1) }));

describe("a live-shaped multi-line skill-path, ci-policy-weakened or ci-policy-malformed gate", () => {
  it("reads as its rule, and a coordinator's merge is refused on evidence that matches it", async () => {
    for (const { rule } of ownerRows) {
      const { pr, gate, gateId } = await gatedPr(world(), rule);

      const reason = landGate(gate)!.reason;

      expect(gate.prompt.split("\n").length).toBeGreaterThan(2);
      expect(landGate(gate)?.rule).toBe(rule);
      expect(coordinatorEvidencePolicy(gate, COORDINATOR, { decision: "merge", headSha: H }, mergeEvidence(gateId, pr, rule, reason))).toBe(false);
    }
  });

  it("is refused by a console tap and by merge-at-head, which starts no land-pr", async () => {
    for (const { rule, row } of ownerRows) {
      const w = world();
      const { pr, runId, gateId } = await gatedPr(w, rule);

      const tapped = await resolveGate(tapRead(runId, gateId, pr), w.services.port, w.host);
      const merged = await mergeAtHead("act-1", { op: { kind: "merge-at-head", repo: REPO, pr, headSha: H }, confirmEvent: CONFIRM }, w.deps);

      expect(tapped).toMatchObject({ outcome: "refused", reason: "class", detail: expect.stringContaining(`a ${row} gate`) });
      expect(merged).toMatchObject({ outcome: "refused", reason: "class" });
      expect(landRuns(w.host)).toEqual([]);
      expect(w.host.gates.get(gateId)?.status).toBe("pending");
    }
  });

  it("is refused in a gate batch, by a standing answer and by a Ship answer", async () => {
    for (const { rule, row } of ownerRows) {
      const w = world();
      const mechanical = await gatedPr(w, MRG_AU);
      const held = await gatedPr(w, rule);
      await w.answers.add({ actionId: "act-2", confirmEvent: CONFIRM, repo: REPO, pr: held.pr, headSha: H, runId: held.runId, expiresAt: "2026-10-25T12:00:00.000Z" });
      const request = { runId: held.runId, gateId: held.gateId, headSha: H, tree: "t", packetSha: "p", roundId: "r", choice: "merge" as const };
      const files = { round: new Uint8Array(), packet: new Uint8Array(), feedback: new Uint8Array() };

      const batched = itemsRefusal(w.host, [mergeItem(mechanical.runId, mechanical.gateId, mechanical.pr), mergeItem(held.runId, held.gateId, held.pr)]);
      const swept = await sweepStandingAnswers(w.host, w.services, w.answers, new Date(NOW_MS));
      const shipped = await checkAnswer({ host: w.host, port: w.services.port, request, files, now: new Date(NOW_MS) });

      expect(batched).toBe(`item 2: ${held.gateId} is a ${row} gate; it stays one per proof`);
      expect(swept).toEqual([{ kind: "pending", actionId: "act-2", runId: held.runId, reason: `${held.gateId} is a ${row} gate, which no standing answer gives` }]);
      expect(shipped).toMatchObject({ kind: "refused", reason: "not-land-gate", detail: `gate ${held.gateId} is a ${row} gate, which no Ship answer gives` });
      expect(w.host.gates.get(held.gateId)?.status).toBe("pending");
    }
  });
});

/**
 * D21 facts under a rule that names something else: an owner-gate seat (the default seat `none`) never runs the merge guard,
 * an escalation route replaces its rule, and the guard's first row (files-unread, visual-path) wins over a CI-policy row.
 */
const D21_UNDER_OTHER_RULES: { rule: string; shape: Shape; row: string }[] = [
  { rule: "shepherd-seat/none", shape: { skills: true }, row: "skill-path" },
  { rule: "shepherd-route/conflict", shape: { skills: true }, row: "skill-path" },
  { rule: "shepherd-seat/none", shape: { facts: ["ci-policy-weakened"] }, row: "ci-policy-weakened" },
  { rule: "shepherd-merge-guard/visual-path", shape: { facts: ["ci-policy-weakened"] }, row: "ci-policy-weakened" },
  { rule: "shepherd-merge-guard/visual-path", shape: { facts: ["ci-policy-malformed"] }, row: "ci-policy-malformed" },
  { rule: "shepherd-seat/none", shape: { facts: ["files-unread"] }, row: "files-unread" },
  { rule: "shepherd-merge-guard/files-unread", shape: {}, row: "files-unread" },
  { rule: "shepherd-seat/none", shape: { preMarker: true }, row: "pre-marker" },
];

describe("a live-shaped gate holding a D21 fact under another rule", () => {
  it("reads as that fact, which the console tap, merge-at-head, a batch, a standing answer and a Ship answer refuse", async () => {
    for (const { rule, shape, row } of D21_UNDER_OTHER_RULES) {
      const w = world();
      const mechanical = await gatedPr(w, MRG_AU);
      const held = await gatedPr(w, rule, shape);
      const request = { runId: held.runId, gateId: held.gateId, headSha: H, tree: "t", packetSha: "p", roundId: "r", choice: "merge" as const };
      const files = { round: new Uint8Array(), packet: new Uint8Array(), feedback: new Uint8Array() };

      const tapped = await resolveGate(tapRead(held.runId, held.gateId, held.pr), w.services.port, w.host);
      const merged = await mergeAtHead("act-1", { op: { kind: "merge-at-head", repo: REPO, pr: held.pr, headSha: H }, confirmEvent: CONFIRM }, w.deps);
      await w.answers.add({ actionId: "act-2", confirmEvent: CONFIRM, repo: REPO, pr: held.pr, headSha: H, runId: held.runId, expiresAt: "2026-10-25T12:00:00.000Z" });
      const batched = itemsRefusal(w.host, [mergeItem(mechanical.runId, mechanical.gateId, mechanical.pr), mergeItem(held.runId, held.gateId, held.pr)]);
      const swept = await sweepStandingAnswers(w.host, w.services, w.answers, new Date(NOW_MS));
      const shipped = await checkAnswer({ host: w.host, port: w.services.port, request, files, now: new Date(NOW_MS) });

      expect(landGate(held.gate)?.rule).toBe(rule);
      expect(tapped).toMatchObject({ outcome: "refused", reason: "class", detail: expect.stringContaining(`a ${row} gate`) });
      expect(merged).toMatchObject({ outcome: "refused", reason: "class" });
      expect(batched).toBe(`item 2: ${held.gateId} is a ${row} gate; it stays one per proof`);
      expect(swept).toEqual([{ kind: "pending", actionId: "act-2", runId: held.runId, reason: `${held.gateId} is a ${row} gate, which no standing answer gives` }]);
      expect(shipped).toMatchObject({ kind: "refused", reason: "not-land-gate", detail: `gate ${held.gateId} is a ${row} gate, which no Ship answer gives` });
      expect(landRuns(w.host)).toEqual([]);
      expect(w.host.gates.get(held.gateId)?.status).toBe("pending");
    }
  });

  it("holding none of them stays open to the console tap", async () => {
    for (const rule of ["shepherd-seat/none", "shepherd-route/conflict", "shepherd-merge-guard/visual-path"]) {
      const w = world();
      const { pr, runId, gateId, gate } = await gatedPr(w, rule);

      const outcome = await resolveGate(tapRead(runId, gateId, pr), w.services.port, w.host);

      expect(gate.prompt).toContain(`${OWNER_AT_HEAD_LEAD}none.`);
      expect(outcome).toEqual({ outcome: "resolved", gateId });
    }
  });
});
