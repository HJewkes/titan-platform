import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import type { ReviewerAgent, ReviewerDispatch } from "@titan-design/review-panel";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import type { RoutedStepInput, StepRoute } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { shepherdEventMigration } from "./events.js";
import { fixProofRoute } from "./fix-proof.js";
import type { ShepherdDeps } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { DEFAULT_LATE_VERDICT_MS, DEFAULT_SESSION_START_TIMEOUT_MS, reviewRoutes, type ReviewWiring } from "./review.js";
import { holdReviewerMigration, holdSatisfiedMigration, shepherdMigration, shepherdStoreRef, sliceMigration } from "./store.js";

const MIN = 60_000;
const POLL_MS = 10_000;
const T0 = 1_800_000_000_000;
const FIX_PROOF_WAIT_MS = 35 * MIN;
const REPO = "octo/demo";
const HEAD = fakeSha("resumed-wait-head");
const TARGET = { repo: REPO, pr: 1, head: HEAD };

const Outcome = z.object({ ok: z.boolean(), output: z.string().optional() });
const StepRecord = z.object({ result: z.looseObject({ kind: z.string(), reason: z.string().optional() }) });
const resultOf = (outcome: unknown) => StepRecord.parse(JSON.parse(Outcome.parse(outcome).output ?? "{}")).result;

/** A first run, or the re-dispatch of a step a restart cut off whose first try began at `firstStartedAt`. */
function stepOf(stepId: string, input: object, resumed?: { firstStartedAt: number; attempt?: number }): RoutedStepInput {
  const restart = resumed && { firstStartedAt: new Date(resumed.firstStartedAt).toISOString(), restarts: 1 };
  return { runId: "run-1", workflowName: "resumed-waits", stepId, iteration: 0, prompt: JSON.stringify(input), signal: new AbortController().signal, attempt: resumed?.attempt ?? (resumed ? 1 : 0), requestKey: "k", ...restart };
}

const reviewer = (overrides: Partial<ReviewerAgent> = {}): ReviewerAgent => ({ name: "rv-1", agentId: "agent-1", sessionId: "", presence: "live", spawnedBy: null, predecessor: null, ...overrides });

function scene() {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD });
  fake.setRuns(HEAD, [{ ...successRun("validate", 5), headSha: HEAD, status: "in_progress", conclusion: null }]);
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16)]);
  const store = shepherdStoreRef();
  store.bind(db);
  store.get().register({ repo: REPO, pr: 1, runId: "run-1", task: "demo: tidy", implementer: "impl-a", policy: OWNER_GATE_POLICY, kind: "correctness" });
  const clock = { now: T0 };
  const sleep = async (ms: number) => void (clock.now += ms);
  const deps: ShepherdDeps = { port: githubPort(fake.wire), store, now: () => clock.now, sleep, pollMs: POLL_MS, agentChatBin: "agent-chat", reviewCheckouts: { root: "/data/reviews", remove: async () => undefined } };
  const agents: ReviewerAgent[] = [];
  const asks: string[] = [];
  const dispatch: ReviewerDispatch = { roster: async () => [...agents], spawn: async (name) => void asks.push(`spawn ${name}`), resume: async (name) => void asks.push(`resume ${name}`) };
  const route = (match: string, wiring: Partial<ReviewWiring> = {}): StepRoute => {
    const found = [fixProofRoute(deps), ...reviewRoutes(deps, { reader: { read: async () => [] }, dispatch, ...wiring })].find((candidate) => candidate.match === match);
    if (!found) throw new Error(`no route ${match}`);
    return found;
  };
  return { clock, agents, asks, route, elapsed: () => clock.now - T0 };
}

describe("a wait re-dispatched after a restart resumes its deadline from the step's first start", () => {
  it("ends sh-fix-proof about a minute after the restart when the first try began 34 min earlier", async () => {
    const s = scene();

    const outcome = await s.route("sh-fix-proof").runner.run(stepOf("sh-fix-proof", { ...TARGET, runId: "run-1" }, { firstStartedAt: T0 - (FIX_PROOF_WAIT_MS - MIN) }));

    expect(resultOf(outcome)).toMatchObject({ kind: "missing", reason: expect.stringContaining("before the deadline") });
    expect(s.elapsed()).toBeGreaterThanOrEqual(MIN);
    expect(s.elapsed()).toBeLessThanOrEqual(MIN + POLL_MS);
  });

  it("gives a first sh-fix-proof run its whole wait", async () => {
    const s = scene();

    await s.route("sh-fix-proof").runner.run(stepOf("sh-fix-proof", { ...TARGET, runId: "run-1" }));

    expect(s.elapsed()).toBeGreaterThanOrEqual(FIX_PROOF_WAIT_MS);
  });

  it("ends sh-late-verdict about a minute after the restart when the first try began 9 min earlier", async () => {
    const s = scene();
    s.agents.push(reviewer({ sessionId: "session-1" }));
    const input = { ...TARGET, reviewerAgentId: "agent-1", reviewerSessionId: "session-1", dispatchedAt: T0 - 60 * MIN };

    const outcome = await s.route("sh-late-verdict").runner.run(stepOf("sh-late-verdict", input, { firstStartedAt: T0 - (DEFAULT_LATE_VERDICT_MS - MIN) }));

    expect(resultOf(outcome).kind).toBe("none");
    expect(s.elapsed()).toBeGreaterThanOrEqual(MIN);
    expect(s.elapsed()).toBeLessThanOrEqual(MIN + POLL_MS);
  });

  it("ends sh-review's session-start wait about a minute after the restart for a reviewer the first try already asked for", async () => {
    const s = scene();
    s.agents.push(reviewer());
    const intent = { head: HEAD, reviewer: "rv-1", at: T0 - 5 * MIN, mode: "spawn" };

    const outcome = await s.route("sh-review").runner.run(stepOf("sh-review", { ...TARGET, intent }, { firstStartedAt: T0 - (DEFAULT_SESSION_START_TIMEOUT_MS - MIN) }));

    expect(resultOf(outcome)).toMatchObject({ kind: "none", reason: expect.stringContaining("did not start one session in time") });
    expect(s.asks).toEqual([]);
    expect(s.elapsed()).toBeLessThanOrEqual(MIN + POLL_MS);
  });

  it("gives a reviewer sh-review asks for again after a restart a whole session-start wait", async () => {
    const s = scene();
    const intent = { head: HEAD, reviewer: "rv-1", at: T0 - 5 * MIN, mode: "spawn" };

    await s.route("sh-review").runner.run(stepOf("sh-review", { ...TARGET, intent }, { firstStartedAt: T0 - (DEFAULT_SESSION_START_TIMEOUT_MS - MIN) }));

    expect(s.asks).toEqual(["spawn rv-1"]);
    expect(s.elapsed()).toBeGreaterThanOrEqual(DEFAULT_SESSION_START_TIMEOUT_MS);
  });

  it("treats a step with a restart as a repeat even at attempt 0, so a resumed reviewer is not resumed twice", async () => {
    const s = scene();
    s.agents.push(reviewer({ sessionId: "session-1" }));
    const intent = { head: HEAD, reviewer: "rv-1", agentId: "agent-1", at: T0 - MIN, mode: "resume" };

    const outcome = await s.route("sh-review").runner.run(stepOf("sh-review", { ...TARGET, intent }, { firstStartedAt: T0 - MIN, attempt: 0 }));

    expect(resultOf(outcome).kind).toBe("dispatched");
    expect(s.asks).toEqual([]);
  });
});
