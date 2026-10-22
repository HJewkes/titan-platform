import type { AgentRow } from "@titan-design/agent-dispatch";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { ReviewerAgent, ReviewerDispatch, ReviewerFacts, ReviewerMessage, ReviewerReader } from "@titan-design/review-panel";
import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import type { WorkflowContext } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { withDemotionOff } from "../test-support/gate-demotions.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { GATE_DEMOTIONS } from "./auto-pass.js";
import type { ExitNoticePorts } from "./exit-notice.js";
import { onFixFirstEscalated, type FixFirstDemotionRun } from "./fix-first-demotion.js";
import type { ShepherdPhases } from "./phases.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import type { Presence } from "./presence.js";
import { reviewPhase } from "./review.js";
import { DEFAULT_ADVERSARY_PROFILE } from "./review-panel-plan.js";
import type { RosterReader } from "./roster.js";
import { shepherdStoreRef, type ShepherdStore } from "./store.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const AUTO_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const ROLES = { g10: "bd-reviewer", standard: "reviewer" } as const;
/** tp#1808's shape: a tool-guard deny-rule PR, held for its security touch, whose fix rounds never converged. */
const TOOL_GUARD_FILES = ["packages/tool-guard/src/deny-rules.ts", "packages/tool-guard/src/deny-rules.test.ts"];
const ADVERSARY_HOLD = "g10-adversary: security touch";
const CONVERGENCE = "This is a convergence review.";
const H2 = fakeSha("tp1808-fix-2");
const H3 = fakeSha("tp1808-fix-3");
const H4 = fakeSha("tp1808-planner-push");
const PUSHES: Record<string, string> = { [H1]: H2, [H2]: H3 };

const row = (name: string, presence: Presence = "exited"): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence, spawnedBy: "coord", predecessor: null });
/** Only the session a verdict came from is read off its locator. */
function locatorOf(sessionId: string): SourceTextLocator {
  const conversation = partialFake<SourceTextLocator["source"]["conversation"]>({ nativeId: sessionId });
  return partialFake<SourceTextLocator>({ source: partialFake<SourceTextLocator["source"]>({ conversation }) });
}
const said = (who: ReviewerAgent, text: string): ReviewerMessage => ({
  ...{ agentId: who.agentId, sessionId: who.sessionId, writtenAt: 1, text },
  locator: locatorOf(who.sessionId),
});

const block = (verdict: string, head: string) => `Probes: an empty list -> refused\nVerdict: ${verdict}\nPR: ${REPO}#1\nHead: ${head}\n`;
const fixFirstText = (head: string) => `1. A quoted \`git\` word still slips past the deny rule.\n\nDefect class: unnormalised command words.\n\n${block("FIX_FIRST", head)}`;

/** What each reviewer says: the convergence reviewer as the scene picks, the adversary MERGE, and correctness FIX_FIRST at `fixFirstAt`. */
interface Answers {
  convergence: (head: string) => "MERGE" | "FIX_FIRST";
  fixFirstAt: ReadonlySet<string>;
}

interface Reviewers {
  dispatch: ReviewerDispatch;
  reader: ReviewerReader;
  roster: RosterReader;
  briefs: Map<string, string>;
}

function scriptedReviewers(answers: Answers): Reviewers {
  const agents: ReviewerAgent[] = [{ ...row("coord", "live"), spawnedBy: null }, row("impl-a")];
  const briefs = new Map<string, string>();
  const adversaries = new Set<string>();
  const spawn = async (name: string, brief: string, _target: unknown, facts?: ReviewerFacts) => {
    briefs.set(name, brief);
    if (facts?.profile === DEFAULT_ADVERSARY_PROFILE) adversaries.add(name);
    agents.push({ ...row(name), spawnedBy: "human" });
  };
  const resume = async (name: string, brief: string) => {
    briefs.set(name, brief);
    agents.forEach((agent, i) => agent.name === name && (agents[i] = { ...agent, presence: "live" }));
  };
  const verdictOf = (name: string, head: string): string => {
    if (briefs.get(name)?.includes(CONVERGENCE)) return answers.convergence(head) === "MERGE" ? block("MERGE", head) : fixFirstText(head);
    return !adversaries.has(name) && answers.fixFirstAt.has(head) ? fixFirstText(head) : block("MERGE", head);
  };
  const reader: ReviewerReader = { read: async (input) => agents.filter((who) => who.agentId === input.reviewerAgentId).map((who) => said(who, verdictOf(who.name, input.head))) };
  const rows = (): AgentRow[] => agents.map((agent) => ({ ...agent, state: agent.presence, status: "finished", profile: agent.profile ?? "", surface: "headless", cwd: "/work", generation: 1 }));
  const roster: RosterReader = { read: async () => ({ kind: "known", rows: rows() }), rows: async () => rows(), invalidate: () => undefined };
  return { dispatch: { roster: async () => [...agents], spawn, resume }, reader, roster, briefs };
}

interface World {
  host: FactoryHost;
  fake: FakeGitHub;
  store: ShepherdStore;
  runId: string;
  briefs: Map<string, string>;
  /** The planner notices Shepherd sent the seat. */
  sends: string[];
  /** The heads the seat pushed a fix past, each on Shepherd's held-run notice of a FIX_FIRST. */
  wakes: string[];
}

/** The run is held, so each FIX_FIRST is a held notice to the seat, which pushes the next scripted head as its fix round. */
function tp1808Run(answers: Answers): World {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const sends: string[] = [];
  const wakes: string[] = [];
  const seatSaw = (text: string): void => {
    const head = /at head ([0-9a-f]{40}): the run is held/.exec(text)?.[1];
    if (text.includes("planner")) sends.push(text);
    if (head === undefined || PUSHES[head] === undefined) return;
    wakes.push(head);
    fake.pushHead(1, PUSHES[head]);
  };
  const exitNotice: ExitNoticePorts = { seatFor: () => "demo-coord", lastReport: async () => undefined, send: async (_seat, text) => seatSaw(text) };
  const { briefs, ...reviewers } = scriptedReviewers(answers);
  const ref = shepherdStoreRef();
  const review = { reader: reviewers.reader, dispatch: reviewers.dispatch, roles: ROLES, holdMember: { profile: DEFAULT_ADVERSARY_PROFILE }, twoMergeRelease: "on" as const };
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal), roster: reviewers.roster, review, exitNotice });
  const wake: ShepherdPhases["wake"] = async () => ({ kind: "unhandled", reason: "the seat runs this held run's fix rounds" });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake })], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: H1, mergeSha: fakeSha("tp1808-merge") });
  fake.prFiles.set(1, TOOL_GUARD_FILES.map((path) => ({ path, status: "modified" })));
  const store = ref.get();
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO_POLICY) });
  store.register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO_POLICY, kind: "security" });
  store.hold(runId, ADVERSARY_HOLD, undefined, { actor: "seat" });
  return { host, fake, store, runId, briefs, sends, wakes };
}

const stepIds = (w: World): string[] => Object.values(w.host.runtime.status(w.runId)!.stepResults).map((result) => result.stepId);
const approveMergeGates = (w: World) => w.host.pendingGates().filter((gate) => gate.runId === w.runId && gate.stepId.startsWith("approve-merge"));
const convergenceBriefs = (w: World): string[] => [...w.briefs.values()].filter((brief) => brief.includes(CONVERGENCE));
const RUNAWAY_AT_H3 = new Set([H1, H2, H3]);

describe("D8: a replay of tp#1808, three FIX_FIRSTs on a tool-guard PR", () => {
  it("sends one fresh convergence reviewer the whole FIX_FIRST trail, whose MERGE merges after the adversary's, with no approve-merge", async () => {
    const w = tp1808Run({ convergence: () => "MERGE", fixFirstAt: RUNAWAY_AT_H3 });

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), { timeout: 5_000 });

    expect(approveMergeGates(w)).toEqual([]);
    expect(w.host.gates.get(gateId(w.runId, "approve-merge"))).toBeUndefined();
    expect(w.wakes).toEqual([H1, H2]);
    expect(stepIds(w)).toContain(`sh-auto-pass:D8-convergence-review:${H3}`);
    expect(stepIds(w)).toContain(`sh-await-verdict:${H3}:adversary`);
    const [brief, ...others] = convergenceBriefs(w);
    expect(others).toEqual([]);
    expect(brief).toContain(`Review pull request ${REPO}#1 at head ${H3}`);
    expect(brief).toContain(`FIX_FIRST 3, at head ${H3.slice(0, 12)}:`);
    expect(brief).toContain("Give MERGE when no Important finding remains");
    expect(w.store.byRun(w.runId)?.held).toBe(false);
  });

  it("leaves one planner notice with the trail, wakes no third fixer, and opens no approve-merge when the convergence review says FIX_FIRST", async () => {
    const w = tp1808Run({ convergence: () => "FIX_FIRST", fixFirstAt: RUNAWAY_AT_H3 });

    await vi.waitFor(() => expect(w.host.runtime.status(w.runId)?.currentStep).toMatch(/^await-new-head/), { timeout: 5_000 });

    expect(w.sends).toHaveLength(1);
    expect(w.sends[0]).toContain(`${REPO}#1 at head ${H3}: the convergence review still said FIX_FIRST`);
    expect(w.sends[0]).toContain("goes to its planner to redesign or split it");
    expect(w.sends[0]).toContain(`FIX_FIRST 1 at ${H1.slice(0, 12)}: Defect class: unnormalised command words.`);
    expect(w.wakes).toEqual([H1, H2]);
    expect(approveMergeGates(w)).toEqual([]);
    expect(w.fake.pr(1).merged).toBe(false);
  });

  it("re-arms the convergence review at the head the planner pushes, and merges on its MERGE there", async () => {
    const w = tp1808Run({ convergence: (head) => (head === H4 ? "MERGE" : "FIX_FIRST"), fixFirstAt: new Set([...RUNAWAY_AT_H3, H4]) });
    await vi.waitFor(() => expect(w.sends).toHaveLength(1), { timeout: 5_000 });

    w.fake.pushHead(1, H4);

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), { timeout: 5_000 });
    expect(stepIds(w)).toEqual(expect.arrayContaining([`sh-auto-pass:D8-convergence-review:${H3}`, `sh-auto-pass:D8-convergence-review:${H4}`]));
    expect(convergenceBriefs(w)).toHaveLength(2);
    expect(approveMergeGates(w)).toEqual([]);
  });
});

describe("D8 with GATE_DEMOTIONS.fixFirstRunaway false", () => {
  withDemotionOff("fixFirstRunaway");

  it("gates the third FIX_FIRST at approve-merge as before, with no convergence review", async () => {
    const w = tp1808Run({ convergence: () => "MERGE", fixFirstAt: RUNAWAY_AT_H3 });

    await gateOpened(w.host, gateId(w.runId, "approve-merge"));

    expect(w.host.gates.get(gateId(w.runId, "approve-merge"))?.prompt).toContain("Policy shepherd-route/fix-first-runaway");
    expect(convergenceBriefs(w)).toEqual([]);
    expect(stepIds(w).filter((id) => id.startsWith("sh-auto-pass"))).toEqual([]);
  });
});

describe("onFixFirstEscalated", () => {
  const run = (): FixFirstDemotionRun => ({
    ...{ ctx: partialFake<WorkflowContext>({ runId: "run-1" }), target: { repo: REPO, pr: 1 }, state: { waits: 0 } },
    ...{ reviews: new Map(), fresh: new Set<string>(), fixFirstTrail: [] },
  });

  it.each(["failed-rounds", "conflict", "repair-budget", "policy-denial"] as const)("leaves a %s escalation to the owner gate", async (escalation) => {
    expect(await onFixFirstEscalated(run(), H1, { escalation, detail: "x" })).toBeUndefined();
  });

  it("leaves a runaway to the owner gate with the flag off, sending no review", async () => {
    const off = run();

    expect(await onFixFirstEscalated(off, H1, { escalation: "fix-first-runaway", detail: "x" }, { ...GATE_DEMOTIONS, fixFirstRunaway: false })).toBeUndefined();
    expect(off.fresh.size).toBe(0);
  });
});
