import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRow } from "@titan-design/agent-dispatch";
import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import type { ReviewerAgent, ReviewerFacts, ReviewerMessage, ReviewerReader } from "@titan-design/review-panel";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { REPO } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ExitNoticePorts } from "./exit-notice.js";
import type { ShepherdPhases } from "./phases.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import type { Presence } from "./presence.js";
import { reviewPhase } from "./review.js";
import { DEFAULT_ADVERSARY_PROFILE } from "./review-panel-plan.js";
import type { ScopedRereviewMode } from "./review-scope-round.js";
import type { RosterReader } from "./roster.js";
import { shepherdStoreRef } from "./store.js";
import type { Git } from "./tree-carry.js";

/** Synthetic scene: a held security PR, FIX_FIRST at H1, the seat's fix pushed as H2, then MERGE from both members at H2. */
const H1 = fakeSha("scoped-rereview-h1");
const H2 = fakeSha("scoped-rereview-h2");
const FIX_PATH = "packages/tool-guard/src/deny-rules.ts";
const FINDING = "1. A quoted `git` word still slips past the deny rule.";
const AUTO_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const ROLES = { g10: "bd-reviewer", standard: "reviewer" } as const;

const SCRATCH = mkdtempSync(join(tmpdir(), "tp3735-scope-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const block = (verdict: string, head: string) => `Probes: an empty list -> refused\nVerdict: ${verdict}\nPR: ${REPO}#1\nHead: ${head}\n`;
const fixFirstText = (head: string) => `${FINDING}\n\nDefect class: unnormalised command words.\n\n${block("FIX_FIRST", head)}`;

const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
const NUMSTAT = `2\t1\t${FIX_PATH}\0`;
const UNIFIED = [`diff --git a/${FIX_PATH} b/${FIX_PATH}`, `--- a/${FIX_PATH}`, `+++ b/${FIX_PATH}`, "@@ -10 +10,2 @@", "-old", "+new", "+newer", ""].join("\n");

/** The scope probe's git, scripted: H2 contains H1 unless `rebased`, and the fix diff touches ten lines of one file. */
function scriptedGit(rebased: boolean): Git {
  return async (_dir, args) => {
    const [command, first] = args;
    if (command === "init" || command === "fetch") return ok("");
    if (command === "merge-base") return first === "--is-ancestor" ? { code: rebased ? 1 : 0, stdout: "", stderr: "" } : ok(fakeSha("scoped-rereview-base"));
    if (command === "merge-tree") return ok(`${fakeSha("scoped-rereview-tree")}\n`);
    if (command === "diff") return ok(args.includes("--numstat") ? NUMSTAT : UNIFIED);
    return { code: 128, stdout: "", stderr: "" };
  };
}

interface Spawned {
  name: string;
  brief: string;
  adversary: boolean;
}

const row = (name: string, presence: Presence = "exited"): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence, spawnedBy: "coord", predecessor: null });
function said(who: ReviewerAgent, text: string): ReviewerMessage {
  const conversation = partialFake<SourceTextLocator["source"]["conversation"]>({ nativeId: who.sessionId });
  const locator = partialFake<SourceTextLocator>({ source: partialFake<SourceTextLocator["source"]>({ conversation }) });
  return { agentId: who.agentId, sessionId: who.sessionId, writtenAt: 1, text, locator };
}

/** Correctness says FIX_FIRST at H1 and MERGE after; the adversary member always says MERGE. */
function scriptedReviewers(spawned: Spawned[]) {
  const agents: ReviewerAgent[] = [{ ...row("coord", "live"), spawnedBy: null }, row("impl-a")];
  const isAdversary = (name: string) => spawned.some((each) => each.name === name && each.adversary);
  const spawn = async (name: string, brief: string, _target: unknown, facts?: ReviewerFacts) => {
    spawned.push({ name, brief, adversary: facts?.profile === DEFAULT_ADVERSARY_PROFILE });
    agents.push({ ...row(name), spawnedBy: "human" });
  };
  const verdictOf = (name: string, head: string) => (!isAdversary(name) && head === H1 ? fixFirstText(head) : block("MERGE", head));
  const reader: ReviewerReader = { read: async (input) => agents.filter((who) => who.agentId === input.reviewerAgentId).map((who) => said(who, verdictOf(who.name, input.head))) };
  const rows = (): AgentRow[] => agents.map((agent) => ({ ...agent, state: agent.presence, status: "finished", profile: agent.profile ?? "", surface: "headless", cwd: "/work", generation: 1 }));
  const roster: RosterReader = { read: async () => ({ kind: "known", rows: rows() }), rows: async () => rows(), invalidate: () => undefined };
  return { dispatch: { roster: async () => [...agents], spawn, resume: async () => undefined }, reader, roster };
}

/** The run is held, so the FIX_FIRST at H1 is a held notice to the seat, which pushes H2 as its fix round. */
async function fixRoundRun(mode: ScopedRereviewMode | undefined, rebased = false) {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const exitNotice: ExitNoticePorts = {
    seatFor: () => "demo-coord",
    lastReport: async () => undefined,
    send: async (_seat, text) => void (text.includes(`at head ${H1}: the run is held`) && fake.pr(1).headSha === H1 && fake.pushHead(1, H2)),
  };
  const spawned: Spawned[] = [];
  const { roster, ...reviewers } = scriptedReviewers(spawned);
  const carry = { stateDir: mkdtempSync(join(SCRATCH, "state-")), git: scriptedGit(rebased) };
  const review = { ...reviewers, roles: ROLES, holdMember: { profile: DEFAULT_ADVERSARY_PROFILE }, twoMergeRelease: "on" as const, carry, ...(mode && { scopedRereview: mode }) };
  const ref = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal), roster, review, exitNotice });
  const wake: ShepherdPhases["wake"] = async () => ({ kind: "unhandled", reason: "the seat runs this held run's fix rounds" });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake })], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: H1, mergeSha: fakeSha("scoped-rereview-merge") });
  fake.prFiles.set(1, [{ path: FIX_PATH, status: "modified" }]);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO_POLICY) });
  ref.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO_POLICY, kind: "security" });
  ref.get().hold(runId, "g10-adversary: security touch", undefined, { actor: "seat" });
  await vi.waitFor(() => expect(fake.pr(1).merged).toBe(true), { timeout: 10_000 });
  const results = host.runtime.status(runId)!.stepResults;
  const resultOf = (stepId: string) => Object.values(results).find((result) => result.stepId === stepId)?.data?.result as Record<string, unknown> | undefined;
  const briefAt = (head: string, adversary: boolean) => spawned.filter((each) => each.adversary === adversary && each.brief.includes(`at head ${head}`)).map((each) => each.brief.replaceAll(runId, "<run>"));
  return { resultOf, briefAt, stepIds: Object.values(results).map((result) => result.stepId) };
}

const SCOPED_DIFF = `diff ${H1} ${H2} -- "${FIX_PATH}"`;

describe("a fix-round re-review under shepherd.review.scopedRereview", () => {
  it("on: the correctness brief at H2 reads the fix diff since H1 and H1's finding; the adversary member's reads neither", async () => {
    const w = await fixRoundRun("on");

    const [correctness] = w.briefAt(H2, false);
    expect(correctness).toContain(SCOPED_DIFF);
    expect(correctness).not.toContain("gh pr diff");
    expect(correctness).toContain(FINDING);
    expect(correctness).toContain(`- ${FIX_PATH}: 10-11`);
    const [adversary] = w.briefAt(H2, true);
    expect(adversary).toContain("gh pr diff");
    expect(adversary).not.toContain(SCOPED_DIFF);
    expect(adversary).not.toContain(FINDING);
    expect(w.resultOf(`sh-review:${H2}`)).toMatchObject({ scoped: true });
    expect(w.resultOf(`sh-review:${H2}:adversary`)).not.toHaveProperty("scoped");
  });

  it("on: the first review at H1 is not probed and reads the whole PR", async () => {
    const w = await fixRoundRun("on");

    expect(w.stepIds).toContain(`sh-review-scope:${H2}`);
    expect(w.stepIds).not.toContain(`sh-review-scope:${H1}`);
    expect(w.briefAt(H1, false)[0]).toContain("gh pr diff");
    expect(w.resultOf(`sh-review:${H1}`)).not.toHaveProperty("scoped");
  });

  it("off or absent: no head is probed and nothing about scope is recorded", async () => {
    const w = await fixRoundRun(undefined);

    expect(w.stepIds.filter((id) => id.startsWith("sh-review-scope"))).toEqual([]);
    expect(w.briefAt(H2, false)[0]).toContain("Read its commit history.");
    expect(w.resultOf(`sh-review:${H2}`)).not.toHaveProperty("scoped");
  });

  it("shadow: sh-review records the scope while the brief equals the unscoped one byte for byte", async () => {
    const off = await fixRoundRun("off");
    const shadow = await fixRoundRun("shadow");

    expect(shadow.resultOf(`sh-review:${H2}`)).toMatchObject({ scoped: true, scopeShadow: true });
    expect(shadow.briefAt(H2, false)).toEqual(off.briefAt(H2, false));
    expect(shadow.briefAt(H2, false)[0]).not.toContain(SCOPED_DIFF);
  });

  it("on: a probe refusal reviews the whole PR and records scoped false with the reason", async () => {
    const w = await fixRoundRun("on", true);

    expect(w.resultOf(`sh-review:${H2}`)).toMatchObject({ scoped: false, scopeReason: expect.stringContaining("rebase") });
    const [correctness] = w.briefAt(H2, false);
    expect(correctness).toContain("gh pr diff");
    expect(correctness).not.toContain(FINDING);
  });
});
