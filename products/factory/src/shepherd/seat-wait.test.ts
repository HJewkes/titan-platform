import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import type { StepRoute } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { defineWorkflow } from "../definition.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { shepherdEventMigration } from "./events.js";
import type { SeatHeld, ShepherdDeps, Verdict } from "./phases.js";
import type { Presence } from "./presence.js";
import type { ReviewerAgent, ReviewerDispatch, ReviewerMessage, ReviewerReader } from "@titan-design/review-panel";
import { REVIEW_STEPS, reviewPhase, reviewRoutes } from "./review.js";
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
  /** Review rounds at H; each round after a held MERGE carries it, as the run's round loop does. Default 1. */
  rounds?: number;
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
  const run = async (ctx: Parameters<typeof reviewPhase>[0]) => {
    let seatHeld: SeatHeld | undefined;
    for (let round = 0; round < (scene.rounds ?? 1); round += 1) {
      const verdict = await reviewPhase(ctx, { repo: REPO, pr: 1, round, headSha: H, ...(seatHeld && { seatHeld }) });
      verdicts.push(verdict);
      seatHeld = verdict.kind === "none" ? verdict.seatHeld : undefined;
      if (!seatHeld) return;
    }
  };
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
        seatHeld: { head: H, locator: expect.any(Object), reviewer: expect.objectContaining({ agentId: `agent-${spawns[0]}` }), dispatchedReviewer: expect.objectContaining({ agentId: `agent-${spawns[0]}` }), merge: expect.objectContaining({ kind: "verdict", verdict: "MERGE", head: H }) },
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
  it("is still a timeout, not a held head, once its correction turn never lands", async () => {
    const { verdicts, stepIds } = await review({ ownMerges: false });

    expect(verdicts).toEqual([{ kind: "none", cause: "timeout", reason: "the resumed reviewer did not show on the roster in time" }]);
    expect(stepIds).toContain(`sh-late-verdict:${H}`);
    expect(stepIds).toContain(`sh-correct-verdict:${H}`);
  });
});

describe("the next round at a head whose own MERGE a seat held", () => {
  const held = (verdict: Verdict) => verdict.kind === "none" && verdict.seatHeld !== undefined;
  const count = (stepIds: string[], prefix: string) => stepIds.filter((id) => id.startsWith(`${prefix}:`)).length;

  it("re-checks only the seat through three WAITs and lets the one reviewer's MERGE stand once the seat clears", async () => {
    const clears = 10_000 + 3 * SEAT_WAIT_MS + 2_000;

    const { verdicts, spawns, stepIds } = await review({ seat: (now) => (now < clears ? "WAIT" : "MERGE"), ownMerges: true, rounds: 6 });

    expect(verdicts.slice(0, 3).every(held)).toBe(true);
    expect(verdicts.at(-1)).toMatchObject({ kind: "MERGE", headSha: H });
    expect(spawns).toHaveLength(1);
    expect(count(stepIds, "sh-review")).toBe(1);
    expect(count(stepIds, "sh-review-intent")).toBe(1);
    expect(count(stepIds, "sh-seat-recheck")).toBe(verdicts.length - 1);
    expect(count(stepIds, "sh-merge-evidence")).toBe(1);
  });

  it("sends the head back when the seat says FIX_FIRST after holding the own MERGE", async () => {
    const turns = 10_000 + SEAT_WAIT_MS + 2_000;

    const { verdicts, spawns, stepIds } = await review({ seat: (now) => (now < turns ? "WAIT" : "FIX_FIRST"), ownMerges: true, rounds: 4 });

    expect(held(verdicts[0]!)).toBe(true);
    expect(verdicts.at(-1)).toMatchObject({ kind: "FIX_FIRST", headSha: H, text: expect.stringContaining("FIX_FIRST") });
    expect(spawns).toHaveLength(1);
    expect(count(stepIds, "sh-merge-evidence")).toBe(0);
  });

  it("merges nothing while the seat still says WAIT at the recheck", async () => {
    const { verdicts, spawns, stepIds } = await review({ seat: () => "WAIT", ownMerges: true, rounds: 3 });

    expect(verdicts).toHaveLength(3);
    expect(verdicts.every(held)).toBe(true);
    expect(spawns).toHaveLength(1);
    expect(count(stepIds, "sh-merge-evidence")).toBe(0);
  });
});
