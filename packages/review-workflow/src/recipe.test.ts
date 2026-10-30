import { lineSourceFromTexts } from "@titan-design/evidence";
import { formatResultLine } from "@titan-design/fix-proof";
import type { PullRequest } from "@titan-design/github";
import { DEFAULT_PANEL_TABLE, memberName, type PanelPlan, type ReviewerAgent, type ReviewerMessage, type ReviewTarget } from "@titan-design/review-panel";
import { partialFake } from "@titan-design/test-kit";
import { codeRoute, type StepRoute } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { REVIEW_STEP_BODIES, type ReviewBodyPorts } from "./bodies.js";
import type { ParkedRun, ParkingPort } from "./fixer.js";
import type { ReviewPlanPolicy } from "./plan-for-head.js";
import { reviewHead, type ReviewHost } from "./recipe.js";
import type { StepCall } from "./step-schemas.js";
import { DEFAULT_REVIEW_STEP_IDS, type ReviewHeadInput } from "./types.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const target: ReviewTarget = { repo: "acme/widgets", pr: 7, head: HEAD };
const name = (shape: "correctness" | "adversary", attempt: 1 | 2 = 1): string => memberName(target, shape, attempt);

const POLICY: ReviewPlanPolicy = {
  panel: {
    roles: { g10: "bd-reviewer", standard: "reviewer" },
    shapeRoles: { adversary: { g10: "fable-reviewer", standard: "fable-reviewer" } },
    panel: DEFAULT_PANEL_TABLE,
  },
};
const TIMING = { pollMs: 1_000, startDeadlineMs: 5_000, verdictDeadlineMs: 10_000 };

/** A vacuous line its mutants prove: tp#2145's proof, which spent 8 reviewer sessions on 2 verdicts. */
const provedByMutants = formatResultLine({
  head: HEAD,
  mergeBase: BASE,
  verdict: "vacuous",
  counts: { reproduces: 0, "passes-on-base": 1, "new-api": 0, "fails-on-head": 0, "not-run": 0 },
  notCollected: [],
  deletedTests: [],
  configEdited: false,
  tests: [{ file: "src/widget.test.ts", name: "holds", class: "passes-on-base" }],
  truncated: false,
  mutants: { verdict: "killed", results: [{ spec: "src/widget.test.mutations.json", name: "drop the bound", outcome: "killed" }], uncovered: [] },
});

const input: ReviewHeadInput = { runId: "run-1", target, kind: "feature", brief: { checkoutRoot: "/tmp/reviews", fixProof: provedByMutants } };

type Reply = string | undefined;
/** What the member under `agent` has written last, before or after its correction. */
type Script = (agent: string, resumed: boolean) => Reply;

const MERGE = `Probes: drove the bound past its edge.\n\nVerdict: MERGE\nPR: ${target.repo}#${target.pr}\nHead: ${HEAD}\n`;
const merges: Script = () => MERGE;
type Locator = ReviewerMessage["locator"];
const locatorFor = (sessionId: string): Locator =>
  partialFake<Locator>({ source: partialFake<Locator["source"]>({ conversation: partialFake<Locator["source"]["conversation"]>({ nativeId: sessionId }) }) });

function fakeParking(): ParkingPort {
  const runs: ParkedRun[] = [];
  return {
    park: async (run) => void runs.push(run),
    parked: async (fingerprint) => runs.filter((run) => run.fingerprint === fingerprint),
    release: async () => [],
    round: async () => 0,
  };
}

/** One broker and one clock: a spawn adds a row, started unless named in `neverStarts`; a reply is written just after its spawn or resume. */
function fakeWorld(script: Script, neverStarts: readonly string[] = []) {
  const world = { now: 1_000_000, rows: [] as ReviewerAgent[], spawns: [] as string[], resumes: [] as string[], fixers: [] as string[], snapshotReads: 0 };
  const sent = new Map<string, { at: number; resumed: boolean }>();
  const read = async (agentId: string): Promise<ReviewerMessage[]> => {
    const row = world.rows.find((agent) => agent.agentId === agentId);
    const last = row && sent.get(row.name);
    const text = row && last && script(row.name, last.resumed);
    return row && last && text !== undefined ? [{ agentId, sessionId: row.sessionId, writtenAt: last.at, locator: locatorFor(row.sessionId), text }] : [];
  };
  const pr: PullRequest = { number: target.pr, state: "open", merged: false, mergeSha: null, mergedAt: null, headRef: "feat/widgets", headSha: HEAD, headRepo: null, baseRef: "main", draft: false, mergeableState: "clean", behind: false, autoMerge: false };
  const changedFiles = [{ path: "src/widget.ts", additions: 6, deletions: 2 }, { path: "src/widget.test.ts", additions: 12, deletions: 0 }];
  const ports: ReviewBodyPorts = {
    snapshot: { read: async () => ((world.snapshotReads += 1), { pr, ci: "green", facts: { ...target, base: BASE, changedFiles, authorityTouch: true } }) },
    proofReader: { read: async () => ({ kind: "result", line: provedByMutants }) },
    carry: { probe: async () => ({ kind: "no-carry" }) },
    checkout: { state: async () => ({ kind: "ready" }), refresh: async () => undefined },
    headroom: { read: async () => ({ opus: true, account: "available" }) },
    profiles: { installed: () => true },
    source: lineSourceFromTexts({}),
    clock: { now: () => world.now, sleep: async (ms) => void (world.now += ms) },
    reader: { read: (awaiting) => read(awaiting.reviewerAgentId) },
    dispatch: {
      roster: async () => world.rows,
      spawn: async (agent) => {
        world.spawns.push(agent);
        world.rows.push({ name: agent, agentId: `agent-${agent}`, sessionId: neverStarts.includes(agent) ? "" : `session-${agent}`, presence: "live", spawnedBy: null });
        sent.set(agent, { at: world.now + 1, resumed: false });
      },
      resume: async (agent) => {
        world.resumes.push(agent);
        world.now += 1;
        sent.set(agent, { at: world.now + 1, resumed: true });
      },
    },
    fixer: { roster: async () => [], spawn: async (agent) => void world.fixers.push(agent) },
    parking: fakeParking(),
  };
  return { world, ports };
}

/** Each body under its default id, as a host registers them: `codeRoute` parses the stored JSON input the body takes. */
function routesFor(ports: ReviewBodyPorts): StepRoute[] {
  const ids = DEFAULT_REVIEW_STEP_IDS;
  const bodies = REVIEW_STEP_BODIES;
  type In<K extends keyof typeof bodies> = Parameters<(typeof bodies)[K]>[0];
  return [
    codeRoute(ids.preflight, (body: In<"preflight">) => bodies.preflight(body, ports)),
    codeRoute(ids.heal, (body: In<"heal">) => bodies.heal(body, ports)),
    codeRoute(ids.intent, (body: In<"intent">) => bodies.intent(body)),
    codeRoute(ids.dispatch, (body: In<"dispatch">, step) => bodies.dispatch(body, ports, step.signal)),
    codeRoute(ids.await, (body: In<"await">, step) => bodies.await(body, ports, step.signal)),
    codeRoute(ids.correct, (body: In<"correct">, step) => bodies.correct(body, ports, step.signal)),
    codeRoute(ids.lateRead, (body: In<"lateRead">) => bodies.lateRead(body, ports)),
    codeRoute(ids.aggregate, (body: In<"aggregate">) => bodies.aggregate(body, ports)),
    codeRoute(ids.fixer, (body: In<"fixer">) => bodies.fixer(body, ports)),
  ];
}

const routeOf = (routes: readonly StepRoute[], stepId: string): StepRoute | undefined =>
  routes.find((route) => stepId === route.match || stepId.startsWith(`${route.match}:`));

/** Runs each step through its route, as a durable host stores it, and replays `recorded` in order until a step runs live. */
function fakeHost(ports: ReviewBodyPorts, recorded: readonly (readonly [string, object])[] = []) {
  const routes = routesFor(ports);
  const steps: string[] = [];
  let cursor = 0;
  const call: StepCall = async (stepId, stepInput, schema) => {
    steps.push(stepId);
    const replayed = recorded[cursor];
    if (replayed?.[0] === stepId) return (cursor += 1), schema.parse(replayed[1]);
    cursor = recorded.length;
    const run = { runId: "run-1", workflowName: "review", stepId, iteration: 0, prompt: JSON.stringify(stepInput), signal: new AbortController().signal, attempt: 0, requestKey: stepId };
    const outcome = await routeOf(routes, stepId)?.runner.run(run);
    if (!outcome?.ok) throw new Error(`step ${stepId} failed: ${outcome?.error ?? "no route"}`);
    return z.object({ result: schema }).parse(JSON.parse(outcome.output)).result;
  };
  const host: ReviewHost = { call, historyNext: () => recorded[cursor]?.[0] };
  return { host, steps };
}

const review = (ports: ReviewBodyPorts, recorded?: readonly (readonly [string, object])[]) => {
  const { host, steps } = fakeHost(ports, recorded);
  return reviewHead(host, input, { plan: POLICY, timing: TIMING }).then((outcome) => ({ outcome, steps }));
};

describe("reviewHead", () => {
  it("spends one session per member when correctness and the adversary each say MERGE once (tp#2145)", async () => {
    const { world, ports } = fakeWorld(merges);

    const { outcome } = await review(ports);

    expect(outcome).toMatchObject({ kind: "MERGE", head: HEAD });
    expect(world.spawns).toEqual([name("correctness"), name("adversary")]);
  });

  it("retries a member whose session never started once, under a fresh name", async () => {
    const { world, ports } = fakeWorld(merges, [name("correctness")]);

    const { outcome } = await review(ports);

    expect(outcome.kind).toBe("MERGE");
    expect(world.spawns).toEqual([name("correctness"), name("adversary"), name("correctness", 2)]);
  });

  it("never dispatches a member that said MERGE again while another member times out to the fixer", async () => {
    const { world, ports } = fakeWorld((agent) => (agent.includes("correctness") ? MERGE : undefined));

    const { outcome } = await review(ports);

    expect(outcome).toMatchObject({ kind: "needs-fixer", failure: "timeout", fingerprint: "timeout:adversary" });
    expect(world.spawns).toEqual([name("correctness"), name("adversary"), name("adversary", 2)]);
  });

  it("sends a member that repeats the same refusal after its correction to the fixer, with no fresh member", async () => {
    const { world, ports } = fakeWorld((agent) => (agent.includes("adversary") ? "I read the diff and it looks fine." : MERGE));

    const { outcome } = await review(ports);

    expect(outcome).toMatchObject({ kind: "needs-fixer", failure: "malformed", fingerprint: "parser:no_block" });
    expect([world.spawns, world.resumes, world.fixers.length]).toEqual([[name("correctness"), name("adversary")], [name("adversary")], 1]);
  });

  it("skips preflight on a run recorded before it existed and dispatches the plan its intent recorded", async () => {
    const { world, ports } = fakeWorld(merges);
    const plan: PanelPlan = { class: { class: "standard", touches: [] }, members: [{ shape: "correctness", profile: "reviewer", briefId: "correctness/v1", blocking: true, degraded: false }], spendEstimate: 1, degraded: false };

    const { outcome, steps } = await review(ports, [[`${DEFAULT_REVIEW_STEP_IDS.intent}:${HEAD}`, { plan }]]);

    expect(outcome.kind).toBe("MERGE");
    expect([world.snapshotReads, steps[0]]).toEqual([0, `${DEFAULT_REVIEW_STEP_IDS.intent}:${HEAD}`]);
  });
});
