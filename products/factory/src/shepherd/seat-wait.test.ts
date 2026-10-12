import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import type { StepRoute } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { defineWorkflow } from "../definition.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { shepherdEventMigration } from "./events.js";
import type { ShepherdDeps, Verdict } from "./phases.js";
import type { Presence } from "./presence.js";
import { REVIEW_STEPS, reviewPhase, reviewRoutes, type ReviewerAgent, type ReviewerDispatch, type ReviewerMessage, type ReviewerReader } from "./review.js";
import { holdSlotsMigration } from "./store-migrations.js";
import { holdReviewerMigration, holdSatisfiedMigration, shepherdMigration, shepherdStoreRef, sliceMigration } from "./store.js";

const REPO = "octo/demo";
/** Synthetic stand-in for the head a seat reviewer said WAIT at while its required checks ran. */
const H = fakeSha("seat-wait-head");
const SEAT_WAIT_MS = 5_000;

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const row = (name: string, presence: Presence): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence, spawnedBy: "coord", predecessor: null });
const SEAT = row("tc-tp-1-review", "live");
const verdictAt = (verdict: string) => `Read it all.\n\nVerdict: ${verdict}\nPR: ${REPO}#1\nHead: ${H}\n`;
const locatorIn = (nativeId: string): SourceTextLocator => ({
  source: {
    sourceId: `transcript-${nativeId}`,
    harness: "claude-code",
    format: "jsonl",
    formatVersion: null,
    path: `/transcripts/${nativeId}.jsonl`,
    namespace: "test",
    conversation: { harness: "claude-code", namespace: "test", nativeId },
    provenance: { kind: "native", name: "test" },
  },
  evidence: {
    line: { sourceId: `transcript-${nativeId}`, byteOffset: 0, byteLength: 1, contentHash: "0".repeat(64), lineNumber: 1, nativeOrdinal: null },
    subrecord: { index: 0, path: [] },
  },
  selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] },
});
const said = (who: ReviewerAgent, text: string, writtenAt: number): ReviewerMessage => ({
  ...{ agentId: who.agentId, sessionId: who.sessionId, writtenAt, text },
  locator: locatorIn(who.sessionId),
});

interface Scene {
  /** The seat reviewer's verdict at H once `clock` has passed each key's time; absent means no seat reviewer is listed. */
  seat?: (now: number) => string;
  /** False leaves Shepherd's own reviewer silent and exited, so the round runs out. */
  ownMerges: boolean;
}

/** One review of H under the real review routes; the clock moves only in sleeps. */
async function review(scene: Scene) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1)]);
  let clock = 10_000;
  const agents: ReviewerAgent[] = [row("coord", "live"), ...(scene.seat ? [SEAT] : [])];
  const spawns: string[] = [];
  const dispatch: ReviewerDispatch = {
    roster: async () => [...agents],
    spawn: async (name) => void (spawns.push(name), agents.push(row(name, scene.ownMerges ? "live" : "exited"))),
    resume: async () => undefined,
  };
  const reader: ReviewerReader = {
    read: async (input) => {
      if (input.reviewerAgentId === SEAT.agentId) return scene.seat ? [said(SEAT, verdictAt(scene.seat(clock)), clock)] : [];
      const own = agents.find((agent) => agent.agentId === input.reviewerAgentId);
      return own && scene.ownMerges ? [said(own, verdictAt("MERGE"), clock + 1)] : [];
    },
  };
  const store = shepherdStoreRef();
  const deps: ShepherdDeps = { port: githubPort(fake.wire), store, now: () => clock, sleep: async (ms) => void (clock += ms), pollMs: 1_000, agentChatBin: "agent-chat", reviewCheckouts: { root: "/data/reviews", remove: async () => undefined } };
  const verdicts: Verdict[] = [];
  const run = async (ctx: Parameters<typeof reviewPhase>[0]) => void verdicts.push(await reviewPhase(ctx, { repo: REPO, pr: 1, round: 0, headSha: H }));
  const recorded: StepRoute[] = [...reviewRoutes(deps, { reader, dispatch, timeoutMs: 5_000, lateVerdictMs: 5_000, seatWaitMs: SEAT_WAIT_MS })];
  const routes = Object.assign(recorded, { database: { extraMigrations: [shepherdMigration(4), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19)], bind: store.bind } });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [defineWorkflow({ name: "seat-wait-test", steps: REVIEW_STEPS, run })], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("seat-wait-test", { policy: JSON.stringify({ merge: "auto", mergeMethod: "squash", fixer: true, seat: "trusted-seat" }) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: { merge: "auto", mergeMethod: "squash", fixer: true, seat: "trusted-seat" } });
  await host.runtime.wait(runId);
  const results = Object.values(host.runtime.status(runId)!.stepResults);
  const resultOf = (stepId: string) => (results.find((result) => result.stepId === stepId)?.data as { result?: unknown } | undefined)?.result;
  return { verdicts, spawns, stepIds: results.map((result) => result.stepId), resultOf };
}

describe("Shepherd's own MERGE meeting a seat reviewer's WAIT at the same head", () => {
  it("records external-hold with the held MERGE and runs no late step when the WAIT outlasts the seat wait", async () => {
    const { verdicts, spawns, stepIds } = await review({ seat: () => "WAIT", ownMerges: true });

    expect(verdicts).toEqual([
      {
        kind: "none",
        cause: "external-hold",
        reason: expect.stringContaining(`said WAIT at ${H}`),
        seatHeld: { head: H, locator: expect.any(Object), reviewer: expect.objectContaining({ agentId: `agent-${spawns[0]}` }), dispatchedReviewer: expect.objectContaining({ agentId: `agent-${spawns[0]}` }) },
      },
    ]);
    expect(stepIds).not.toContain(`sh-late-verdict:${H}`);
    expect(stepIds.filter((id) => id.startsWith("sh-correct-verdict"))).toEqual([]);
    expect(spawns).toHaveLength(1);
  });

  it("takes the MERGE through the evidence step when the seat says MERGE inside the seat wait", async () => {
    const turnsAt = 10_000 + SEAT_WAIT_MS / 2;
    const { verdicts, spawns } = await review({ seat: (now) => (now < turnsAt ? "WAIT" : "MERGE"), ownMerges: true });

    expect(verdicts).toMatchObject([{ kind: "MERGE", headSha: H }]);
    expect(spawns).toHaveLength(1);
  });

  it("is a G10 disagreement when the seat says FIX_FIRST after its WAIT", async () => {
    const turnsAt = 10_000 + SEAT_WAIT_MS / 2;
    const { verdicts, stepIds, resultOf } = await review({ seat: (now) => (now < turnsAt ? "WAIT" : "FIX_FIRST"), ownMerges: true });

    expect(verdicts).toMatchObject([{ kind: "FIX_FIRST", headSha: H }]);
    expect(resultOf(`sh-await-verdict:${H}`)).toMatchObject({ verdict: "FIX_FIRST", ownerOverride: { trigger: "g10-disagree", head: H, shepherd: "MERGE" } });
    expect(stepIds).not.toContain(`sh-late-verdict:${H}`);
  });
});

describe("a silent own reviewer with no seat reviewer listed", () => {
  it("is still a timeout, not a held head", async () => {
    const { verdicts, stepIds } = await review({ ownMerges: false });

    expect(verdicts).toEqual([{ kind: "none", cause: "timeout" }]);
    expect(stepIds).toContain(`sh-late-verdict:${H}`);
  });
});
