import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { WakeRequest } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import type { ReviewerAgent, ReviewerDispatch, ReviewerMessage, ReviewerReader } from "./review.js";
import { reviewPhase } from "./review.js";
import { shepherdStoreRef } from "./store.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** Synthetic stand-ins for the replayed run's heads: the one both reviewers read, and the fixer's push after it. */
const REVIEWED = fakeSha("seat-replay-reviewed");
const FIXED = fakeSha("seat-replay-fixed");

const row = (name: string, presence = "exited"): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence, spawnedBy: "coord", predecessor: null });
const SEAT = row("seat-pr-1-review");
const verdictAt = (head: string, verdict = "MERGE") => `Read it all.\n\nVerdict: ${verdict}\nPR: ${REPO}#1\nHead: ${head}\n`;
const said = (who: ReviewerAgent, text: string): ReviewerMessage => ({
  ...{ agentId: who.agentId, sessionId: who.sessionId, writtenAt: 1, text },
  locator: { source: { conversation: { nativeId: who.sessionId } } } as unknown as SourceTextLocator,
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

describe("a seat check that cannot read the roster at every round", () => {
  it("names the failure, not a wait that ran out, in the owner's failed-rounds gate", async () => {
    const fake = fakeGitHub();
    fake.onGetPr = (open) => fake.setRuns(open.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
    const reason = "seat check: the roster could not be read: broker down";
    const phases = { review: async () => ({ kind: "none" as const, cause: "timeout" as const, reason }), wake: async () => ({ kind: "unhandled" as const, reason: "test" }) };
    const store = shepherdStoreRef();
    const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal) });
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
    hosts.push(host);
    fake.addPr({ headSha: REVIEWED });
    const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
    store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });

    await gateOpened(host, gateId(runId, "approve-merge"));
    const prompt = host.gates.get(gateId(runId, "approve-merge"))?.prompt ?? "";

    expect(prompt).toContain(`the last at ${REVIEWED} ended with ${reason}`);
    expect(prompt).not.toContain("wait ran out");
  });
});
