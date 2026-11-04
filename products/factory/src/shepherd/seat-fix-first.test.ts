import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { WakeRequest } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import type { ReviewerAgent, ReviewerDispatch, ReviewerMessage, ReviewerReader } from "@titan-design/review-panel";
import { reviewPhase } from "./review.js";
import { ReviewerAskTimedOut } from "./review-wait.js";
import { MAX_SEAT_HELD_ROUNDS } from "./route-table.js";
import { shepherdStoreRef } from "./store.js";
import type { Presence } from "./presence.js";
import { fakeLocator } from "../test-support/fakes.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** Synthetic stand-ins for the replayed run's heads: the one both reviewers read, and the fixer's push after it. */
const REVIEWED = fakeSha("seat-replay-reviewed");
const FIXED = fakeSha("seat-replay-fixed");
/** Synthetic stand-in for the head a seat held across rounds while its required checks ran (the tp#1300 pattern). */
const HELD = fakeSha("seat-replay-held");

const row = (name: string, presence: Presence = "exited"): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence, spawnedBy: "coord", predecessor: null });
const SEAT = row("seat-pr-1-review");
const verdictAt = (head: string, verdict = "MERGE") => `Read it all.\n\nVerdict: ${verdict}\nPR: ${REPO}#1\nHead: ${head}\n`;
const said = (who: ReviewerAgent, text: string): ReviewerMessage => ({
  ...{ agentId: who.agentId, sessionId: who.sessionId, writtenAt: 1, text },
  locator: fakeLocator({ source: { conversation: { nativeId: who.sessionId } } }),
});

/** Every reviewer Shepherd spawns says MERGE at the head it reads; the seat reviewer said FIX_FIRST at REVIEWED before the run looked. */
function reviewers(): { dispatch: ReviewerDispatch; reader: ReviewerReader } {
  const agents: ReviewerAgent[] = [row("coord", "live"), SEAT];
  const dispatch: ReviewerDispatch = {
    roster: async () => [...agents],
    spawn: async (name) => void agents.push(row(name)),
    resume: async () => undefined,
  };
  const reader: ReviewerReader = {
    read: async (input) => {
      if (input.reviewerAgentId === SEAT.agentId) return [said(SEAT, `The retry never ends.\n\n${verdictAt(REVIEWED, "FIX_FIRST")}`)];
      return agents.filter((who) => who.agentId === input.reviewerAgentId).map((who) => said(who, verdictAt(input.head)));
    },
  };
  return { dispatch, reader };
}

describe("Shepherd's reviewer says MERGE and a seat reviewer says FIX_FIRST at the same head", () => {
  it("wakes the fixer with the seat reviewer's findings instead of asking the owner, then asks the owner at the fixer's new head", async () => {
    const fake = fakeGitHub();
    fake.onGetPr = (open) => fake.setRuns(open.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
    const wakes: WakeRequest[] = [];
    const wake = async (_ctx: unknown, request: WakeRequest) => (wakes.push(request), fake.pushHead(1, FIXED), { kind: "woken" as const, agent: "impl-a" });
    const store = shepherdStoreRef();
    const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal), review: reviewers() });
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake })], routes, gatePollMs: 5 });
    hosts.push(host);
    fake.addPr({ headSha: REVIEWED });
    const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
    store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });

    await gateOpened(host, gateId(runId, "approve-merge"));

    expect(wakes).toEqual([expect.objectContaining({ kind: "review", headSha: REVIEWED, payload: expect.objectContaining({ kind: "FIX_FIRST", text: expect.stringContaining("The retry never ends.") }) })]);
    expect(host.gates.get(gateId(runId, "approve-merge"))?.prompt).toContain(`at head ${FIXED}`);
    expect(fake.pr(1).merged).toBe(false);
  });
});

/** Shepherd one PR at HELD under the real review phase and an owner-gate policy, until the approve-merge gate opens. */
async function gatedRun(review: { dispatch: ReviewerDispatch; reader: ReviewerReader }, until: "gate" | "no-reviewer-hold" = "gate") {
  const fake = fakeGitHub();
  fake.onGetPr = (open) => fake.setRuns(open.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const phases = { review: reviewPhase, wake: async () => ({ kind: "unhandled" as const, reason: "test" }) };
  let clock = 0;
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)), review: { ...review, seatWaitMs: 1_000 } });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: HELD });
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  if (until === "gate") await gateOpened(host, gateId(runId, "approve-merge"));
  else await vi.waitFor(() => expect(Object.values(host.runtime.status(runId)!.stepResults).map((result) => result.stepId)).toContain(`sh-no-reviewer-hold:${HELD}`), { timeout: 5_000 });
  const results = Object.values(host.runtime.status(runId)!.stepResults);
  const resultOf = (stepId: string) => (results.find((result) => result.stepId === stepId)?.data as { result?: unknown } | undefined)?.result;
  return { stepIds: results.map((result) => result.stepId), resultOf, prompt: host.gates.get(gateId(runId, "approve-merge"))?.prompt ?? "", merged: fake.pr(1).merged };
}

/** Every Shepherd reviewer says MERGE; once its MERGE is read, every roster read fails with `failure`, the seat check's and any later dispatch's alike. */
function rosterFailingAfterMerge(failure: () => Error): { dispatch: ReviewerDispatch; reader: ReviewerReader } {
  const agents: ReviewerAgent[] = [row("coord", "live"), SEAT];
  let merged = false;
  const dispatch: ReviewerDispatch = {
    roster: async () => (merged ? Promise.reject(failure()) : [...agents]),
    spawn: async (name) => void agents.push(row(name)),
    resume: async () => undefined,
  };
  const reader: ReviewerReader = {
    read: async (input) => {
      const own = agents.filter((who) => who.agentId === input.reviewerAgentId && who !== SEAT);
      merged ||= own.length > 0;
      return own.map((who) => said(who, verdictAt(input.head)));
    },
  };
  return { dispatch, reader };
}

describe("a seat check that cannot read the roster at every round", () => {
  it("holds the own MERGE while the reads time out, then names the timeout in the owner's failed-rounds gate and merges nothing", async () => {
    const { stepIds, prompt, merged } = await gatedRun(rosterFailingAfterMerge(() => new ReviewerAskTimedOut("agent-chat timed out")));

    expect(stepIds.filter((id) => id.startsWith(`sh-seat-recheck:${HELD}`)).length).toBeGreaterThanOrEqual(1);
    expect(stepIds).not.toContain(`sh-merge-evidence:${HELD}`);
    expect(prompt).toContain(`the seat held Shepherd's own MERGE for ${MAX_SEAT_HELD_ROUNDS} rounds at one head: at ${HELD}`);
    expect(prompt).not.toContain("review rounds failed");
    expect(prompt).toContain("seat check: the roster could not be read: ReviewerAskTimedOut");
    expect(prompt).not.toContain("wait ran out");
    expect(merged).toBe(false);
  });

  it("holds the run as no-reviewer when a later intent's roster read is refused for good, and merges nothing", async () => {
    const { stepIds, resultOf, merged } = await gatedRun(rosterFailingAfterMerge(() => Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })), "no-reviewer-hold");

    expect(resultOf(`sh-await-verdict:${HELD}`)).toEqual({ kind: "none", reason: "seat check: the roster could not be read: Error" });
    expect(stepIds.filter((id) => id.startsWith("sh-seat-recheck"))).toEqual([]);
    expect(stepIds).not.toContain(`sh-merge-evidence:${HELD}`);
    expect(merged).toBe(false);
  });
});


/** Every Shepherd reviewer says MERGE at once; the seat reviewer says WAIT on its first `waits` reads at HELD, then MERGE. */
function seatWaiting(waits: number): { dispatch: ReviewerDispatch; reader: ReviewerReader; spawns: string[] } {
  const agents: ReviewerAgent[] = [row("coord", "live"), SEAT];
  const spawns: string[] = [];
  let seatReads = 0;
  const dispatch: ReviewerDispatch = {
    roster: async () => [...agents],
    spawn: async (name) => void (spawns.push(name), agents.push(row(name))),
    resume: async () => undefined,
  };
  const reader: ReviewerReader = {
    read: async (input) => {
      if (input.reviewerAgentId === SEAT.agentId) return [said(SEAT, verdictAt(HELD, ++seatReads <= waits ? "WAIT" : "MERGE"))];
      return agents.filter((who) => who.agentId === input.reviewerAgentId).map((who) => said(who, verdictAt(input.head)));
    },
  };
  return { dispatch, reader, spawns };
}

describe("a seat that says WAIT at one head for three rounds over Shepherd's MERGE", () => {
  it("starts one reviewer, opens no failed-rounds gate, and takes the held MERGE to the merge decision once the seat clears", async () => {
    const seat = seatWaiting(6);

    const { stepIds, prompt, merged } = await gatedRun(seat);

    expect(seat.spawns).toHaveLength(1);
    expect(stepIds.filter((id) => id.startsWith(`sh-review:${HELD}`))).toHaveLength(1);
    expect(stepIds.filter((id) => id.startsWith(`sh-seat-recheck:${HELD}`)).length).toBeGreaterThanOrEqual(2);
    expect(stepIds).toContain(`sh-merge-evidence:${HELD}`);
    expect(prompt).toContain(`at head ${HELD}`);
    expect(prompt).not.toContain("review rounds failed");
    expect(merged).toBe(false);
  });
});

describe("a seat whose WAIT over Shepherd's MERGE never changes", () => {
  it("asks the owner in the failed-rounds gate, naming the seat and its WAIT, and merges nothing", async () => {
    const seat = seatWaiting(Number.POSITIVE_INFINITY);

    const { stepIds, prompt, merged } = await gatedRun(seat);

    expect(seat.spawns).toHaveLength(1);
    expect(stepIds).not.toContain(`sh-merge-evidence:${HELD}`);
    expect(prompt).not.toContain("review rounds failed");
    expect(prompt).toContain(
      `Policy shepherd-route/failed-rounds: the seat held Shepherd's own MERGE for ${MAX_SEAT_HELD_ROUNDS} rounds at one head: at ${HELD}, the last with seat check: ${SEAT.name} said WAIT at ${HELD}`,
    );
    expect(stepIds.filter((id) => id.startsWith(`sh-seat-recheck:${HELD}`))).toHaveLength(MAX_SEAT_HELD_ROUNDS - 1);
    expect(merged).toBe(false);
  });
});
