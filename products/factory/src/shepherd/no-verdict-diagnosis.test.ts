import { tmpdir } from "node:os";
import type { AgentRow } from "@titan-design/agent-dispatch";
import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import { partialFake } from "@titan-design/test-kit";
import type { DispatchOptions, StepResult, WorkflowContext } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FactoryConfigSchema } from "../config.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { SpawnRequest } from "./agents.js";
import { GATE_DEMOTIONS } from "./auto-pass.js";
import type { ExitNoticePorts } from "./exit-notice.js";
import { demoteFailedRounds, onEscalated, type FailedRoundsRun } from "./failed-rounds-demotion.js";
import { LeaveLand } from "./leave-land.js";
import { DEFAULT_DIAGNOSIS_PROFILE, diagnosisName, spawnDiagnosis, type DiagnosisPorts } from "./no-verdict-diagnosis.js";
import { freshNoVerdictState, noteReviewerStep, type ReviewerSeen } from "./no-verdict-round.js";
import type { ObservedPr } from "./observe.js";
import type { EffectivePolicy } from "./policy.js";
import type { ShepherdPhases } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import type { Escalated } from "./route-table.js";
import { countRound, type Routed } from "./routed.js";
import { shepherdStoreRef } from "./store.js";

const REPO = "octo/demo";
const HEAD = fakeSha("diagnosis-head");
const NEXT = fakeSha("diagnosis-next");
/** The planner starts in an existing directory; the temp dir stands in for the repo's checkout. */
const CHECKOUT = tmpdir();

const StepInput = z.record(z.string(), z.unknown());

interface Recorded {
  ctx: WorkflowContext;
  steps: { stepId: string; input: Record<string, unknown> }[];
}

/** A context whose code steps answer `answer` by step id and record their input. */
function recordingCtx(answer: (stepId: string, input: Record<string, unknown>) => unknown): Recorded {
  const steps: Recorded["steps"] = [];
  async function dispatch<T extends Record<string, unknown>>(stepId: string, _template: string, options: DispatchOptions<T> = {}): Promise<StepResult<T>> {
    const input = StepInput.parse(JSON.parse(Object.values(options.vars ?? {})[0] ?? "{}"));
    steps.push({ stepId, input });
    return { stepId, iteration: 0, agentId: null, signal: null, completedAt: "", data: options.schema?.parse({ result: answer(stepId, input) }) };
  }
  return { ctx: partialFake<WorkflowContext>({ runId: "run-1", param: () => undefined, dispatch }), steps };
}

function answers(spawned: boolean, noticeSent = true) {
  return (stepId: string, input: Record<string, unknown>): unknown => {
    if (stepId.startsWith("sh-no-verdict-diagnosis")) return spawned ? { spawned, agent: "diag-1", profile: "bd-planner" } : { spawned, agent: "diag-1", reason: "no diagnosis planner is wired" };
    if (stepId.startsWith("sh-seat-notice")) return { sent: noticeSent, detail: noticeSent ? "told hub-seat" : "no seat notice is wired" };
    if (stepId.startsWith("await-new-head")) return { headSha: NEXT, state: "open" };
    return { ...input, commentId: 7 };
  };
}

type Counted = FailedRoundsRun & Recorded & Parameters<typeof countRound>[0];

function failingRun(spawned = true, noticeSent = true): Counted {
  return {
    ...recordingCtx(answers(spawned, noticeSent)),
    ...{ target: { repo: REPO, pr: 1 }, task: "demo/T-1", state: { waits: 0 }, reviews: new Map(), fresh: new Set<string>(), escalations: new Map() },
    ...{ failedRounds: 0, failedOutcomes: [], fallbackReviewed: false, ...freshNoVerdictState() },
    ...{ throttledRounds: 1, closer: { streak: 0 }, seatHeldRounds: new Map(), fixFirstTrail: [] },
  };
}

const silentRound: Routed = { headSha: HEAD, verdict: { kind: "none", cause: "no-verdict" }, observed: partialFake<ObservedPr>(), outcome: "no-verdict", route: "fresh-reviewer" };

/** TP-3762's shape: the correctness reviewer says MERGE, and the adversary's dispatch is refused before any session starts. */
function refusedAdversaryRound(run: Counted, round: number): Promise<Escalated | undefined> {
  noteReviewerStep(run, `sh-review-intent:${HEAD}`, { kind: "intent", reviewer: `rv-demo-${round}`, panelReviewers: { adversary: `rv-demo-${round}-adversary` } });
  noteReviewerStep(run, `sh-review:${HEAD}:adversary`, { kind: "none", reason: "the reviewer dispatch was refused: DispatchError", refused: "DispatchError" });
  noteReviewerStep(run, `sh-review:${HEAD}`, { kind: "dispatched", at: 1, agentId: `agent-${round}`, sessionId: `session-${round}` });
  noteReviewerStep(run, `sh-await-verdict:${HEAD}`, { kind: "verdict", verdict: "MERGE" });
  return countRound(run, silentRound);
}

/** The adversary ran and said FIX_FIRST while a third blocking member stayed silent: reviewers disagreed, and D7 applies. */
function disagreeingRound(run: Counted, round: number): Promise<Escalated | undefined> {
  noteReviewerStep(run, `sh-review:${HEAD}:adversary`, { kind: "dispatched", at: 1, agentId: `adv-${round}`, sessionId: `adv-session-${round}` });
  noteReviewerStep(run, `sh-await-verdict:${HEAD}:adversary:corrected`, { kind: "verdict", verdict: "FIX_FIRST" });
  noteReviewerStep(run, `sh-review:${HEAD}:tests`, { kind: "dispatched", at: 1, agentId: `tests-${round}`, sessionId: `tests-session-${round}` });
  return countRound(run, silentRound);
}

async function threeRounds(run: Counted, round: (run: Counted, index: number) => Promise<Escalated | undefined>): Promise<Escalated> {
  await round(run, 1);
  await round(run, 2);
  return (await round(run, 3))!;
}

describe("failed rounds with no adversary verdict go to a diagnosis planner (TP-3796)", () => {
  it("marks three rounds whose adversary never started as never-verdict, keeping every reviewer's session or refusal", async () => {
    const run = failingRun();

    const escalated = await threeRounds(run, refusedAdversaryRound);

    expect(escalated).toMatchObject({ escalation: "failed-rounds", infraOnly: true, neverVerdict: true });
    expect(run.failedReviewers.filter((reviewer) => reviewer.shape === "adversary").map((reviewer) => reviewer.refused)).toEqual(Array(3).fill("the reviewer dispatch was refused: DispatchError"));
    expect(run.failedReviewers.filter((reviewer) => reviewer.shape === "correctness").map((reviewer) => reviewer.sessionId)).toEqual(["session-1", "session-2", "session-3"]);
  });

  it("marks three silent single-reviewer rounds as never-verdict", async () => {
    const run = failingRun();

    const escalated = await threeRounds(run, (counted) => countRound(counted, silentRound));

    expect(escalated).toMatchObject({ infraOnly: true, neverVerdict: true });
  });

  it("spawns the planner, opens no owner gate and starts no fourth review, then waits for a new head with rounds counted afresh", async () => {
    const run = failingRun();
    const escalated = await threeRounds(run, refusedAdversaryRound);

    const left = await onEscalated(run, HEAD, escalated).catch((error: unknown) => error);

    expect(left).toBeInstanceOf(LeaveLand);
    expect(run.steps.map((recorded) => recorded.stepId)).toEqual([`sh-auto-pass:D7-no-verdict-diagnosis:${HEAD}`, `sh-no-verdict-diagnosis:${HEAD}`, "await-new-head:0"]);
    const diagnosis = run.steps[1]!.input;
    expect(diagnosis).toMatchObject({ runId: "run-1", repo: REPO, pr: 1, headSha: HEAD, task: "demo/T-1", failedOutcomes: ["no-verdict", "no-verdict", "no-verdict"] });
    expect(diagnosis["reviewers"]).toHaveLength(6);
    expect(run.fresh.has(HEAD)).toBe(false);
    expect(run.escalations.size).toBe(0);
    expect(run).toMatchObject({ failedRounds: 0, failedOutcomes: [], failedReviewers: [], adversaryHeard: false });
  });

  it("tells ops when the planner cannot start, with no owner gate while the notice goes out", async () => {
    const run = failingRun(false);
    const escalated = await threeRounds(run, refusedAdversaryRound);

    await expect(onEscalated(run, HEAD, escalated)).rejects.toBeInstanceOf(LeaveLand);

    const notice = run.steps.find((recorded) => recorded.stepId === "sh-seat-notice")!.input;
    expect(notice).toMatchObject({ gate: "review-infra", headSha: HEAD });
    expect(notice["why"]).toContain("the diagnosis planner did not start: no diagnosis planner is wired");
    expect(run.escalations.size).toBe(0);
  });

  it("sends D7's fallback reviewer, not the planner and not the owner, when an adversary ran and returned a verdict", async () => {
    const run = failingRun();
    const escalated = await threeRounds(run, disagreeingRound);

    const goesToMerge = await onEscalated(run, HEAD, escalated);

    expect(escalated).toMatchObject({ infraOnly: true });
    expect(escalated).not.toHaveProperty("neverVerdict");
    expect(goesToMerge).toBe(false);
    expect(run.fresh.has(HEAD)).toBe(true);
    expect(run.escalations.size).toBe(0);
    expect(run.steps.map((recorded) => recorded.input["rule"])).toEqual(["D7/fallback-reviewer"]);
  });

  it("restores D7's fallback reviewer for never-verdict rounds with the flag off", async () => {
    const run = failingRun();
    const escalated = await threeRounds(run, refusedAdversaryRound);

    expect(await demoteFailedRounds(run, HEAD, escalated)).toEqual({ route: "diagnose", escalated });
    expect(await demoteFailedRounds(run, HEAD, escalated, { ...GATE_DEMOTIONS, neverVerdictDiagnosis: false })).toEqual({ route: "review-again" });
  });

  it("ships with the diagnosis on", () => {
    expect(GATE_DEMOTIONS.neverVerdictDiagnosis).toBe(true);
  });
});

const ROW: AgentRow = { name: "rv-demo-1", agentId: "agent-1", state: "exited", presence: "exited", status: "finished", profile: "bd-reviewer", surface: "headless", cwd: CHECKOUT, sessionId: "session-1", transcriptPath: "/transcripts/session-1.jsonl", transcriptExists: true, generation: 1 };

const REVIEWERS: ReviewerSeen[] = [
  { head: HEAD, shape: "correctness", name: "rv-demo-1", agentId: "agent-1", sessionId: "session-1", verdict: true },
  { head: HEAD, shape: "adversary", name: "rv-demo-1-adversary", refused: "installed profile 'reviewer' is unreadable" },
  { head: HEAD, shape: "correctness", name: "rv-demo-2", agentId: "agent-2", sessionId: "session-2" },
];

const LOG = ["12:00 spawn_gate admitted rv-demo-1-adversary", "12:00 unrelated line about another PR", "12:01 reviewer session-2 exited with no verdict"].join("\n");

function diagnosisPorts(profile: string, roster: readonly AgentRow[] = [ROW]): DiagnosisPorts & { spawned: SpawnRequest[] } {
  const spawned: SpawnRequest[] = [];
  const agents = { roster: async () => roster, spawn: async (request: SpawnRequest) => void spawned.push(request) };
  return { profile, agents, cwdFor: () => CHECKOUT, readLog: async () => LOG, reportTo: () => "hub-seat", spawned };
}

const input = { runId: "run-1", repo: REPO, pr: 1, headSha: HEAD, task: "demo/T-1", failedOutcomes: ["no-verdict", "no-verdict", "timeout"], reviewers: REVIEWERS };

describe("the diagnosis planner's spawn", () => {
  it("briefs the PR, the head, each no-verdict reviewer's session and transcript or refusal, and the log lines naming them", async () => {
    const ports = diagnosisPorts(DEFAULT_DIAGNOSIS_PROFILE);

    const result = await spawnDiagnosis(ports, input);

    expect(result).toEqual({ spawned: true, agent: diagnosisName("run-1", HEAD), profile: "bd-planner" });
    const [request] = ports.spawned;
    expect(request).toMatchObject({ name: diagnosisName("run-1", HEAD), profile: "bd-planner", cwd: CHECKOUT });
    expect(request!.brief).toContain(`PR: 1`);
    expect(request!.brief).toContain(`Head: ${HEAD}`);
    expect(request!.brief).toContain("adversary reviewer rv-demo-1-adversary");
    expect(request!.brief).toContain("never started (installed profile 'reviewer' is unreadable)");
    expect(request!.brief).toContain("session session-2, transcript not on the roster");
    expect(request!.brief).not.toContain("session-1.jsonl");
    expect(request!.brief).toContain("spawn_gate admitted rv-demo-1-adversary");
    expect(request!.brief).toContain("session-2 exited with no verdict");
    expect(request!.brief).not.toContain("unrelated line");
    expect(request!.brief).toContain("Send the report to hub-seat");
  });

  it("names a silent reviewer's transcript from the roster", async () => {
    const ports = diagnosisPorts(DEFAULT_DIAGNOSIS_PROFILE, [{ ...ROW, name: "rv-demo-2", agentId: "agent-2", sessionId: "session-2", transcriptPath: "/transcripts/session-2.jsonl" }]);

    await spawnDiagnosis(ports, input);

    expect(ports.spawned[0]!.brief).toContain("session session-2, transcript /transcripts/session-2.jsonl");
  });

  it("spawns at the configured profile as given, even one the panel cap would lower to an uninstalled profile (TP-3762)", async () => {
    const ports = diagnosisPorts("bd-reviewer");

    await spawnDiagnosis(ports, input);

    expect(ports.spawned.map((request) => request.profile)).toEqual(["bd-reviewer"]);
  });

  it("defaults the configured profile to bd-planner and accepts another in config", () => {
    expect(DEFAULT_DIAGNOSIS_PROFILE).toBe("bd-planner");
    expect(FactoryConfigSchema.parse({ shepherd: { diagnosisProfile: "bd-planner-2" } }).shepherd?.diagnosisProfile).toBe("bd-planner-2");
  });

  it("spawns nothing more when the planner is already on the roster", async () => {
    const ports = diagnosisPorts(DEFAULT_DIAGNOSIS_PROFILE, [{ ...ROW, name: diagnosisName("run-1", HEAD) }]);

    expect(await spawnDiagnosis(ports, input)).toMatchObject({ spawned: true });
    expect(ports.spawned).toEqual([]);
  });

  it("records a failed spawn, never a throw, when nothing is wired or the repo has no checkout", async () => {
    expect(await spawnDiagnosis(undefined, input)).toMatchObject({ spawned: false, reason: "no diagnosis planner is wired" });
    expect(await spawnDiagnosis({ ...diagnosisPorts("bd-planner"), cwdFor: () => undefined }, input)).toMatchObject({ spawned: false, reason: expect.stringContaining("no checkout path") });
  });
});

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const AUTO: EffectivePolicy = { merge: "auto", mergeMethod: "squash", fixer: true, seat: "repo-seat" };

/** A green PR whose every review gives no verdict, with the planner wired and a hub seat that records what it hears. */
function silentWorld() {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.addPr({ headSha: HEAD });
  const sent: string[] = [];
  const exitNotice: ExitNoticePorts = { seatFor: () => "repo-seat", hubSeat: () => "hub-seat", lastReport: async () => undefined, send: async (_seat, text) => void sent.push(text) };
  const reviews: string[] = [];
  const phases: ShepherdPhases = {
    wake: async () => ({ kind: "unhandled", reason: "no fixer in this replay" }),
    review: async (_ctx, request) => (reviews.push(request.headSha), { kind: "none", cause: "no-verdict" }),
  };
  const diagnosis = diagnosisPorts(DEFAULT_DIAGNOSIS_PROFILE, []);
  const store = shepherdStoreRef();
  let clock = 0;
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)), exitNotice, diagnosis, park: async () => ({ lines: [] }) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO });
  return { fake, host, runId, sent, reviews, diagnosis };
}

describe("a run whose reviews never give a verdict (TP-3796)", () => {
  it("spawns one planner after three rounds, with no fourth review, no owner gate and no seat notice, and waits for a new head", async () => {
    const world = silentWorld();

    await vi.waitFor(() => expect(world.host.runtime.status(world.runId)?.currentStep).toMatch(/^await-new-head/));

    expect(world.reviews).toEqual([HEAD, HEAD, HEAD]);
    expect(world.host.gates.listPending()).toEqual([]);
    expect(world.diagnosis.spawned.map((request) => request.profile)).toEqual(["bd-planner"]);
    expect(world.diagnosis.spawned[0]!.brief).toContain(`Head: ${HEAD}`);
    expect(world.sent).toEqual([]);
  });

  it("reviews a new head afresh after the planner", async () => {
    const world = silentWorld();
    await vi.waitFor(() => expect(world.diagnosis.spawned).toHaveLength(1));

    world.fake.pushHead(1, NEXT);

    await vi.waitFor(() => expect(world.diagnosis.spawned).toHaveLength(2));
    expect(world.reviews).toEqual([HEAD, HEAD, HEAD, NEXT, NEXT, NEXT]);
    expect(world.host.gates.listPending()).toEqual([]);
  });
});
