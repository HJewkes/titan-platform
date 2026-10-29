import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentRow } from "@titan-design/agent-dispatch";
import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import { REFUSAL_SENTENCES, type ReviewerAgent, type ReviewerFacts, type ReviewerMessage, type ReviewerReader } from "@titan-design/review-panel";
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
import type { ScopeCheckMode } from "./scope-check-round.js";
import { shepherdStoreRef } from "./store.js";
import type { Git } from "./tree-carry.js";

/** Synthetic scene: a held security PR, FIX_FIRST at H1, the seat's fix pushed as H2, then a scoped re-review of H2. */
const H1 = fakeSha("scope-check-h1");
const H2 = fakeSha("scope-check-h2");
const FIX_PATH = "packages/tool-guard/src/deny-rules.ts";
const FINDING = "1. A quoted `git` word still slips past the deny rule.";
const OUTSIDE = "1. The alias table is never cleared at deny-rules.ts:900.";
const TAGGED = "1. Important: the alias table is never cleared at deny-rules.ts:900.\n   Class: stale state across calls";
const INSIDE = "1. The new branch at deny-rules.ts:11 drops `sudo`.";
const AUTO_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const ROLES = { g10: "bd-reviewer", standard: "reviewer" } as const;
/** A loop that kept asking would resume the reviewer again; the scene stops waiting once it has. */
const MAX_RESUMES = 3;

const SCRATCH = mkdtempSync(join(tmpdir(), "tp3735-check-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const block = (verdict: string, head: string) => `Probes: an empty list -> refused\nVerdict: ${verdict}\nPR: ${REPO}#1\nHead: ${head}\n`;
const fixFirstText = (items: string, head: string) => `${items}\n\nDefect class: unnormalised command words.\n\n${block("FIX_FIRST", head)}`;

const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
const NUMSTAT = `2\t1\t${FIX_PATH}\0`;
const UNIFIED = [`diff --git a/${FIX_PATH} b/${FIX_PATH}`, `--- a/${FIX_PATH}`, `+++ b/${FIX_PATH}`, "@@ -10 +10,2 @@", "-old", "+new", "+newer", ""].join("\n");

/** The scope probe's git, scripted: H2 contains H1, and the fix changes lines 10-11 of one file. */
const scriptedGit: Git = async (_dir, args) => {
  const [command, first] = args;
  if (command === "init" || command === "fetch") return ok("");
  if (command === "merge-base") return first === "--is-ancestor" ? ok("") : ok(fakeSha("scope-check-base"));
  if (command === "merge-tree") return ok(`${fakeSha("scope-check-tree")}\n`);
  if (command === "diff") return ok(args.includes("--numstat") ? NUMSTAT : UNIFIED);
  return { code: 128, stdout: "", stderr: "" };
};

/** What correctness says at H2: its first verdict, then each reply to a correction in turn. */
interface Script {
  atH2: string;
  replies: string[];
}

const row = (name: string, presence: Presence = "exited"): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence, spawnedBy: "coord", predecessor: null });
function said(who: ReviewerAgent, text: string, writtenAt: number): ReviewerMessage {
  const conversation = partialFake<SourceTextLocator["source"]["conversation"]>({ nativeId: who.sessionId });
  const locator = partialFake<SourceTextLocator>({ source: partialFake<SourceTextLocator["source"]>({ conversation }) });
  return { agentId: who.agentId, sessionId: who.sessionId, writtenAt, text, locator };
}

/** Correctness says FIX_FIRST at H1 and the script at H2; the adversary member always says MERGE. A resume appends the next reply. */
function scriptedReviewers(script: Script, resumes: string[]) {
  const agents: ReviewerAgent[] = [{ ...row("coord", "live"), spawnedBy: null }, row("impl-a")];
  const adversaries = new Set<string>();
  const replies = new Map<string, string[]>();
  const spawn = async (name: string, _brief: string, _target: unknown, facts?: ReviewerFacts) => {
    if (facts?.profile === DEFAULT_ADVERSARY_PROFILE) adversaries.add(name);
    agents.push({ ...row(name), spawnedBy: "human" });
  };
  const resume = async (name: string, prompt: string) => {
    resumes.push(prompt);
    await delay(resumes.length > MAX_RESUMES ? 1_000 : 1);
    if (resumes.length > MAX_RESUMES) throw new Error("the scene's reviewer takes no more corrections");
    const agent = agents.find((each) => each.name === name)!;
    replies.set(name, [...(replies.get(name) ?? []), script.replies[resumes.length - 1] ?? script.atH2]);
    agent.lastWrittenAt = 10 + resumes.length;
  };
  const firstSaid = (name: string, head: string) => (adversaries.has(name) ? block("MERGE", head) : head === H1 ? fixFirstText(FINDING, H1) : script.atH2);
  const messagesOf = (who: ReviewerAgent, head: string) => [said(who, firstSaid(who.name, head), 1), ...(replies.get(who.name) ?? []).map((text, index) => said(who, text, 10 + index + 1))];
  const reader: ReviewerReader = { read: async (input) => agents.filter((who) => who.agentId === input.reviewerAgentId).flatMap((who) => messagesOf(who, input.head)) };
  const rows = (): AgentRow[] => agents.map((agent) => ({ ...agent, state: agent.presence, status: "finished", profile: agent.profile ?? "", surface: "headless", cwd: "/work", generation: 1 }));
  const roster: RosterReader = { read: async () => ({ kind: "known", rows: rows() }), rows: async () => rows(), invalidate: () => undefined };
  return { dispatch: { roster: async () => [...agents], spawn, resume }, reader, roster };
}

interface Modes {
  scopedRereview?: ScopedRereviewMode;
  scopeCheck?: ScopeCheckMode;
}

/** The run is held, so the FIX_FIRST at H1 is a held notice to the seat, which pushes H2; the scene waits for H2's panel verdict or a merge. */
async function fixRoundRun(modes: Modes, script: Script) {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const exitNotice: ExitNoticePorts = {
    seatFor: () => "demo-coord",
    lastReport: async () => undefined,
    send: async (_seat, text) => void (text.includes(`at head ${H1}: the run is held`) && fake.pr(1).headSha === H1 && fake.pushHead(1, H2)),
  };
  const resumes: string[] = [];
  const { roster, ...reviewers } = scriptedReviewers(script, resumes);
  const carry = { stateDir: mkdtempSync(join(SCRATCH, "state-")), git: scriptedGit };
  const review = { ...reviewers, roles: ROLES, holdMember: { profile: DEFAULT_ADVERSARY_PROFILE }, twoMergeRelease: "on" as const, carry, ...modes };
  const ref = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal), roster, review, exitNotice });
  const wake: ShepherdPhases["wake"] = async () => ({ kind: "unhandled", reason: "the seat runs this held run's fix rounds" });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake })], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: H1, mergeSha: fakeSha("scope-check-merge") });
  fake.prFiles.set(1, [{ path: FIX_PATH, status: "modified" }]);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO_POLICY) });
  ref.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO_POLICY, kind: "security" });
  ref.get().hold(runId, "g10-adversary: security touch", undefined, { actor: "seat" });
  const results = () => Object.values(host.runtime.status(runId)!.stepResults);
  const stepIds = () => results().map((result) => result.stepId);
  await vi.waitFor(() => expect(fake.pr(1).merged || stepIds().includes(`sh-review-panel:${H2}`) || resumes.length > 1).toBe(true), { timeout: 10_000 });
  const resultOf = (stepId: string): unknown => results().find((result) => result.stepId === stepId)?.data?.result;
  return { resultOf, stepIds: stepIds(), resumes, merged: () => fake.pr(1).merged };
}

const ON = { scopedRereview: "on", scopeCheck: "on" } as const;
const checks = (stepIds: readonly string[]) => stepIds.filter((id) => id.startsWith("sh-scope-check"));
const scopeCorrections = (stepIds: readonly string[]) => stepIds.filter((id) => id === `sh-correct-verdict:${H2}:scope-1`);

describe("the scope check on a scoped fix round's FIX_FIRST", () => {
  it("on: an untagged item outside the fix's ranges gets one correction, and the reviewer's MERGE reply stands", async () => {
    const w = await fixRoundRun(ON, { atH2: fixFirstText(OUTSIDE, H2), replies: [block("MERGE", H2)] });

    expect(scopeCorrections(w.stepIds)).toHaveLength(1);
    expect(w.resumes).toHaveLength(1);
    expect(w.resumes[0]).toContain(REFUSAL_SENTENCES.scope_untagged);
    expect(w.resultOf(`sh-scope-check:${H2}`)).toMatchObject({ kind: "checked", mode: "on", untagged: 1, repeated: 0 });
    await vi.waitFor(() => expect(w.merged()).toBe(true), { timeout: 10_000 });
  });

  it("on: the same item tagged Important: with its Class: gets no correction", async () => {
    const w = await fixRoundRun(ON, { atH2: fixFirstText(TAGGED, H2), replies: [] });

    expect(w.resultOf(`sh-scope-check:${H2}`)).toMatchObject({ untagged: 0, repeated: 0 });
    expect(scopeCorrections(w.stepIds)).toEqual([]);
    expect(w.resultOf(`sh-review-panel:${H2}`)).toMatchObject({ outcome: "FIX_FIRST" });
  });

  it("on: an item that restates H1's finding is asked about as a repeat", async () => {
    const w = await fixRoundRun(ON, { atH2: fixFirstText("2. A quoted git word still slips past the DENY rule", H2), replies: [block("MERGE", H2)] });

    expect(w.resultOf(`sh-scope-check:${H2}`)).toMatchObject({ untagged: 0, repeated: 1 });
    expect(w.resumes[0]).toContain(REFUSAL_SENTENCES.repeated_finding);
  });

  it("on: an item inside the fix's ranges is checked and passes", async () => {
    const w = await fixRoundRun(ON, { atH2: fixFirstText(INSIDE, H2), replies: [] });

    expect(w.resultOf(`sh-scope-check:${H2}`)).toMatchObject({ untagged: 0, repeated: 0 });
    expect(w.resumes).toEqual([]);
  });

  it("a round whose brief was not scoped is never checked, whatever scopeCheck says", async () => {
    const shadowBrief = await fixRoundRun({ scopedRereview: "shadow", scopeCheck: "on" }, { atH2: fixFirstText(OUTSIDE, H2), replies: [] });
    const noScope = await fixRoundRun({ scopeCheck: "on" }, { atH2: fixFirstText(OUTSIDE, H2), replies: [] });

    expect(checks(shadowBrief.stepIds)).toEqual([]);
    expect(checks(noScope.stepIds)).toEqual([]);
    expect(shadowBrief.resumes).toEqual([]);
  });

  it("on: a reply that misses again is kept as written and recorded kept, with no second correction", async () => {
    const again = fixFirstText("1. The alias table still leaks at deny-rules.ts:901.", H2);
    const w = await fixRoundRun(ON, { atH2: fixFirstText(OUTSIDE, H2), replies: [again, again] });

    expect(w.resumes).toHaveLength(1);
    expect(scopeCorrections(w.stepIds)).toHaveLength(1);
    expect(w.resultOf(`sh-scope-check:${H2}`)).toMatchObject({ untagged: 1 });
    expect(w.resultOf(`sh-scope-check:${H2}`)).not.toHaveProperty("kept");
    expect(w.resultOf(`sh-scope-check:${H2}:reply-1`)).toMatchObject({ untagged: 1, kept: true });
    expect(w.resultOf(`sh-review-panel:${H2}`)).toMatchObject({ outcome: "FIX_FIRST", findings: [expect.objectContaining({ text: expect.stringContaining("deny-rules.ts:901") })] });
  });

  it("shadow: the counts are recorded and the reviewer is never asked", async () => {
    const w = await fixRoundRun({ scopedRereview: "on", scopeCheck: "shadow" }, { atH2: fixFirstText(OUTSIDE, H2), replies: [] });

    expect(w.resultOf(`sh-scope-check:${H2}`)).toMatchObject({ mode: "shadow", untagged: 1, repeated: 0 });
    expect(w.resumes).toEqual([]);
    expect(w.resultOf(`sh-review-panel:${H2}`)).toMatchObject({ outcome: "FIX_FIRST" });
  });
});
