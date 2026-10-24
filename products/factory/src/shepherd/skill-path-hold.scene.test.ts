import { fakeGitHub, fakeSha, githubPort, successRun, type PrFile } from "@titan-design/github";
import { GateResolverRefused, type GateRecord, type GateResolver } from "@titan-design/hitl";
import type { ReviewerAgent, ReviewerDispatch, ReviewerMessage } from "@titan-design/review-panel";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coordinatorEvidencePolicy, landGate, type CoordinatorEvidence, type LandGate } from "../coordinator-evidence.js";
import { readCoordinatorEvidence, type EvidenceSources } from "../coordinator-evidence-read.js";
import { resolveGate } from "../gate-resolve.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { authorityGateReason, pendingCheck } from "../test-support/authority-reason.js";
import { gateId } from "../test-support/land.js";
import { fakeOwnerHelper } from "../test-support/owner-edges.js";
import { factoryRoutesFor } from "../workflows.js";
import type { ReviewAccounts } from "./account-limit.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { reviewPhase } from "./review.js";
import { shepherdStoreRef } from "./store.js";

/**
 * CC-1120, owner decision 2026-10-12: a PR from an implementer whose profile self-grants Edit(./.claude/skills/**) is
 * held until the owner approves the skill diff. Shepherd's skill-path guard is profile-blind, so the hold is proven here
 * for such an implementer over the real shepherd-pr run, and the gate it opens is shown to be the owner's alone.
 */
const REPO = "octo/skills";
const PR = 7;
const HEAD = fakeSha("self-granted-head");
const IMPLEMENTER = "tc-self-granted-skills";
const SKILL_FILE = ".claude/skills/x/SKILL.md";
const SKILL_POLICY = `Merge PR #${PR} in ${REPO} at head ${HEAD} into main? CI is green. Policy shepherd-merge-guard/skill-path: `;
const T0 = Date.parse("2026-10-12T12:00:00.000Z");
const MINUTE = 60_000;
const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const COORDINATOR: GateResolver = { class: "coordinator", id: "tc-synthetic-coord", channel: "factory-cli" };
const MERGE = { decision: "merge", headSha: HEAD };
const ABANDON = { decision: "abandon", headSha: HEAD };

const locatorIn = (nativeId: string): SourceTextLocator => ({
  source: {
    ...{ sourceId: nativeId, harness: "claude-code", format: "jsonl", formatVersion: null, path: `${nativeId}.jsonl`, namespace: "test" },
    ...{ conversation: { harness: "claude-code", namespace: "test", nativeId }, provenance: { kind: "claude-code-transcript", legacySessionId: nativeId } },
  },
  evidence: { line: { sourceId: nativeId, byteOffset: 0, byteLength: 0, contentHash: "", lineNumber: null, nativeOrdinal: null }, subrecord: { index: 0, path: [] } },
  selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] },
});

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** Every spawn lands as a reviewer that says MERGE at the head it was asked about. */
function mergingReviewers(clock: () => number) {
  const agents: ReviewerAgent[] = [];
  const dispatch: ReviewerDispatch = {
    roster: async () => [...agents],
    spawn: async (name) => void agents.push({ name, agentId: `id-${name}`, sessionId: `s-${name}`, presence: "live", spawnedBy: null, predecessor: null }),
    resume: async () => {
      throw new Error("no reviewer is resumed here");
    },
  };
  const read = async (input: { repo: string; pr: number; head: string; reviewerAgentId: string; reviewerSessionId: string }): Promise<ReviewerMessage[]> => [
    { agentId: input.reviewerAgentId, sessionId: input.reviewerSessionId, writtenAt: clock() + 1, text: `Verdict: MERGE\nPR: ${input.repo}#${input.pr}\nHead: ${input.head}\n`, locator: locatorIn(input.reviewerSessionId) },
  ];
  const accounts: ReviewAccounts = { dirs: ["/accounts/review"], dispatchUnder: () => dispatch, alert: async () => undefined };
  return { reader: { read }, dispatch, accounts };
}

/** One shepherd-pr run of the self-granted implementer's PR under an auto policy, reviewed MERGE with green checks; only the file list varies. */
function selfGrantedRun(files: PrFile[]) {
  const fake = fakeGitHub();
  fake.addPr({ number: PR, headSha: HEAD, mergeSha: fakeSha("skills-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(PR, files);
  let clock = T0;
  const store = shepherdStoreRef(() => clock);
  const tick = async (ms: number, signal: AbortSignal) => {
    clock += ms;
    signal.throwIfAborted();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const team = mergingReviewers(() => clock);
  const port = githubPort(fake.wire);
  const routes = factoryRoutesFor({ port, store, now: () => clock, sleep: tick, review: { ...team, timeoutMs: 5 * MINUTE } });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake: async () => ({ kind: "unhandled", reason: "no fixer here" }) })], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: String(PR), policy: JSON.stringify(AUTO) });
  store.get().register({ repo: REPO, pr: PR, runId, task: "demo/CC-1", implementer: IMPLEMENTER, kind: "correctness", policy: AUTO });
  const sources: EvidenceSources = { port, registration: (id) => store.get().byRun(id), frozen: () => false, now: () => clock };
  return { runId, host, fake, sources, approveMerge: () => host.gates.get(gateId(runId, "approve-merge")) };
}

async function heldAtSkillGate() {
  const scene = selfGrantedRun([{ path: "src/x.ts", status: "modified" }, { path: SKILL_FILE, status: "added" }]);
  await vi.waitFor(() => expect(scene.approveMerge() !== undefined || scene.fake.effects.merge > 0).toBe(true), { timeout: 20_000 });
  expect(scene.fake.effects.merge).toBe(0);
  expect(scene.approveMerge()?.status).toBe("pending");
  return { ...scene, gate: scene.approveMerge()! };
}

/** Evidence of every kind a coordinator can present, each field matched to `land`, the gate as the coordinator reads it. */
function evidenceMatching(gate: GateRecord, land: LandGate): CoordinatorEvidence[] {
  const at = { gateId: gate.id, repo: land.repo, pr: land.pr, readAt: "2026-10-12T13:00:00.000Z" };
  const run = { workflow: "shepherd-pr", repo: land.repo, pr: land.pr, rule: land.rule, reason: land.reason, merge: "auto", visualPaths: false, held: false, frozen: false };
  const runs = ["validate", "dag-check"].map((name, i) => ({ id: i + 1, name, conclusion: "success", headSha: land.head }));
  return [
    {
      ...{ ...at, kind: "approve-merge", headSha: land.head, run, checks: { base: "main", required: ["validate", "dag-check"], runs } },
      ...{ verdict: { step: `sh-await-verdict:${land.head}`, verdict: "MERGE", head: land.head, reviewer: "rv-synthetic" } },
      ...{ pull: { state: "open", headSha: land.head, mergeableState: "clean", mergeable: "MERGEABLE" } },
    },
    { ...at, kind: "main-green", mergeSha: land.head, base: "main", greenSha: land.head, mergeBaseSha: land.head, runs },
    { ...at, kind: "pr-at-head", state: "open", headSha: land.head },
    { ...at, kind: "pr-gone", state: "merged", run },
  ];
}

/** The rule and reason the skill gate names, as the land prompt's first line states them. */
function skillLand(gate: GateRecord): LandGate {
  const reason = gate.prompt.split("\n")[0]!.slice(SKILL_POLICY.length);
  return { repo: REPO, pr: PR, head: HEAD, rule: "shepherd-merge-guard/skill-path", reason };
}

/** The same gate with its prompt cut to the one line `landGate` parses, so only the rule stands between it and a merge. */
function oneLine(gate: GateRecord, prompt = gate.prompt.split("\n")[0]!): GateRecord {
  return { ...gate, prompt };
}

const KINDS = ["approve-merge", "main-green", "pr-at-head", "pr-gone"] as const;
const ofKind = (all: CoordinatorEvidence[], kind: CoordinatorEvidence["kind"]) => all.find((each) => each.kind === kind)!;

describe("a self-granted skills implementer's PR under an auto policy", () => {
  it("is held at the skill-path gate with nothing merged when its diff adds a repo skill", async () => {
    const scene = await heldAtSkillGate();

    expect(scene.gate.prompt.startsWith(SKILL_POLICY)).toBe(true);
    expect(skillLand(scene.gate).reason).toContain(`the owner reviews repo skill changes: ${SKILL_FILE}`);
    expect(scene.gate.summary).toContain(`Repo skill changes: ${SKILL_FILE}`);
    expect(scene.fake.effects.merge).toBe(0);
  });

  it("merges with no approve-merge gate when the same PR's diff holds no skill path", async () => {
    const scene = selfGrantedRun([{ path: "src/x.ts", status: "modified" }]);

    await vi.waitFor(() => expect(scene.fake.effects.merge).toBe(1), { timeout: 20_000 });

    expect(scene.approveMerge()).toBeUndefined();
  });
});

describe("releasing that skill-path gate", () => {
  it.each(KINDS)("refuses a coordinator merge on %s evidence matched to the gate", async (kind) => {
    const { host, gate, fake } = await heldAtSkillGate();
    const evidence = ofKind(evidenceMatching(gate, skillLand(gate)), kind);

    expect(() => host.gates.resolve(gate.id, MERGE, COORDINATOR, evidence)).toThrow(GateResolverRefused);
    expect(host.gates.get(gate.id)?.status).toBe("pending");
    expect(fake.effects.merge).toBe(0);
  });

  it.each(KINDS)("refuses a merge on %s evidence even once the prompt parses as a land gate, where an MRG-AU gate admits the same", async (kind) => {
    const { gate } = await heldAtSkillGate();
    const skill = oneLine(gate);
    const mechanical = oneLine(gate, `${SKILL_POLICY.replace("shepherd-merge-guard/skill-path", "authority/MRG-AU")}${authorityGateReason(HEAD, pendingCheck(HEAD))}`);

    const admits = (on: GateRecord) => coordinatorEvidencePolicy(on, COORDINATOR, MERGE, ofKind(evidenceMatching(on, landGate(on)!), kind));

    expect(landGate(skill)?.rule).toBe("shepherd-merge-guard/skill-path");
    expect(admits(skill)).toBe(false);
    expect(admits(mechanical)).toBe(kind === "approve-merge");
  });

  it("admits a coordinator's abandon only on evidence that the PR is already merged or closed, an answer that merges nothing", async () => {
    const { gate } = await heldAtSkillGate();
    const gone = ofKind(evidenceMatching(gate, skillLand(gate)), "pr-gone");
    const others = evidenceMatching(gate, skillLand(gate)).filter((each) => each.kind !== "pr-gone");

    expect(coordinatorEvidencePolicy(gate, COORDINATOR, ABANDON, gone)).toBe(true);
    expect(others.map((evidence) => coordinatorEvidencePolicy(gate, COORDINATOR, ABANDON, evidence))).toEqual([false, false, false]);
  });

  it("reads no coordinator evidence for any answer the gate offers while the PR is open", async () => {
    const { host, gate, sources } = await heldAtSkillGate();

    const read = await Promise.all([MERGE, ABANDON].map((payload) => readCoordinatorEvidence(host, sources, gate.id, payload, COORDINATOR)));

    expect(read).toEqual([undefined, undefined]);
  });

  it("refuses an agent shell's gate resolve merge without the owner's presence, and the run stays held", async () => {
    const { host, gate, runId, sources, fake } = await heldAtSkillGate();
    const io = { stdout: () => undefined, stderr: () => undefined, env: { AGENT_CHAT_AGENT_ID: "agent-synthetic", AGENT_CHAT_NAME: "tc-synthetic-coord" } };
    fakeOwnerHelper(undefined);

    const outcome = await resolveGate(host, io, runId, "approve-merge", JSON.stringify(MERGE), sources).then(
      (exit) => `resolved with exit ${exit}`,
      (error: unknown) => (error instanceof GateResolverRefused ? "refused" : String(error)),
    );

    expect(outcome).toBe("refused");
    expect(host.gates.get(gate.id)?.status).toBe("pending");
    expect(fake.effects.merge).toBe(0);
  });
});
