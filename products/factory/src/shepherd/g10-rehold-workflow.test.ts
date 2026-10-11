import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { G10_REHOLD_STEP } from "./g10-rehold.js";
import type { ShepherdPhases } from "./phases.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { reviewPhase, type ReviewerAgent, type ReviewerDispatch, type ReviewerReader } from "./review.js";
import { shepherdStoreRef, type ShepherdStore } from "./store.js";
import type { Git, GitResult } from "./tree-carry.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const AUTO_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const ADVERSARY_HOLD = "g10-adversary: trust rule (security); TP-1";
const MOVED = fakeSha("head-after-release");
const MAIN = fakeSha("main-tip");
const MERGED_TREE = fakeSha("merge-tree");

const ok = (stdout = ""): GitResult => ({ code: 0, stdout, stderr: "" });

/** How the moved head came to be: a clean merge of main onto the released head, or a fix pushed on top of it. */
function scriptedGit(shape: "clean-merge-up" | "fix-push"): Git {
  return async (_dir, args) => {
    const [command] = args;
    if (command === "rev-list") return ok(shape === "fix-push" ? `${args.at(-1)} ${H1}` : `${args.at(-1)} ${H1} ${MAIN}`);
    if (command === "merge-tree") return ok(`${MERGED_TREE}\n`);
    if (command === "rev-parse") return ok(shape === "fix-push" ? fakeSha("tree-with-fix") : MERGED_TREE);
    return ok();
  };
}

const row = (name: string, presence: ReviewerAgent["presence"] = "exited"): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence, spawnedBy: "coord", predecessor: null });

/** Where a reviewer's verdict sits in its session; only the conversation's native id is read here. */
function locatorIn(sessionId: string): SourceTextLocator {
  const conversation = { harness: "claude-code", namespace: "test", nativeId: sessionId };
  const source = { sourceId: sessionId, harness: "claude-code", format: "claude-code-jsonl", formatVersion: null, path: "transcript.jsonl", namespace: "test", conversation, provenance: { kind: "claude-code-transcript" as const, legacySessionId: sessionId } };
  const evidence = { line: { sourceId: sessionId, byteOffset: 0, byteLength: 1, contentHash: "0", lineNumber: 1, nativeOrdinal: null }, subrecord: { index: 0, path: ["message"] } };
  return { source, evidence, selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] } };
}

/** Every reviewer Shepherd spawns says MERGE at the head it reads, so only the hold can stop the merge. */
function mergingReviewers(): { dispatch: ReviewerDispatch; reader: ReviewerReader } {
  const agents: ReviewerAgent[] = [{ ...row("coord", "live"), spawnedBy: null }, row("impl-a")];
  const dispatch: ReviewerDispatch = { roster: async () => [...agents], spawn: async (name) => void agents.push(row(name)), resume: async () => undefined };
  const reader: ReviewerReader = {
    read: async (input) =>
      agents
        .filter((who) => who.agentId === input.reviewerAgentId)
        .map((who) => ({ agentId: who.agentId, sessionId: who.sessionId, writtenAt: 1, text: `Read it all.\n\nVerdict: MERGE\nPR: ${REPO}#1\nHead: ${input.head}\n`, locator: locatorIn(who.sessionId) })),
  };
  return { dispatch, reader };
}

interface World {
  host: FactoryHost;
  fake: FakeGitHub;
  store: ShepherdStore;
  runId: string;
}

/** A PR the seat released a g10-adversary hold on at H1, now at MOVED. */
function releasedThenMoved(shape: "clean-merge-up" | "fix-push"): World {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const wake: ShepherdPhases["wake"] = async () => ({ kind: "unhandled", reason: "no fixer in this test" });
  const ref = shepherdStoreRef();
  const review = { ...mergingReviewers(), roles: { g10: "bd-reviewer", standard: "reviewer" }, carry: { git: scriptedGit(shape) } };
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal), review });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake })], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: MOVED, mergeSha: fakeSha("test-merge") });
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  const store = ref.get();
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO_POLICY) });
  store.register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO_POLICY, kind: "security" });
  store.hold(runId, ADVERSARY_HOLD);
  store.release(runId, { headSha: H1 });
  return { host, fake, store, runId };
}

const stepIds = (w: World): string[] => Object.values(w.host.runtime.status(w.runId)!.stepResults).map((result) => result.stepId);

describe("a g10-adversary hold the seat released at one head, with the PR now at another", () => {
  it("is re-held by the run's CI read after a fix push, and the PR does not merge", async () => {
    const w = releasedThenMoved("fix-push");

    await vi.waitFor(() => expect(w.store.byRun(w.runId)?.held).toBe(true), { timeout: 5_000 });
    await vi.waitFor(() => expect(w.host.runtime.status(w.runId)?.currentStep).toBe("merge:0"), { timeout: 5_000 });

    expect(w.store.byRun(w.runId)?.holdReason).toContain(`from ${H1} to ${MOVED}`);
    expect(w.store.eventsOf(w.runId).at(-1)).toMatchObject({ kind: "hold", actor: "shepherd", headSha: MOVED });
    expect(stepIds(w)).toContain(G10_REHOLD_STEP);
    expect(w.fake.pr(1).merged).toBe(false);
  });

  it("is re-held at the merge when the seat lifts a stall at the new head after the last CI read, and the PR does not merge", async () => {
    const w = releasedThenMoved("fix-push");
    w.store.hold(w.runId, "stalled: no progress; TP-2", undefined, { actor: "seat" });
    const read = w.fake.onGetPr;
    let lifted = false;
    w.fake.onGetPr = (pr, reads) => {
      if (!lifted && w.host.runtime.status(w.runId)?.currentStep?.startsWith("merge")) {
        lifted = true;
        w.store.release(w.runId, { actor: "seat", headSha: MOVED });
      }
      read?.(pr, reads);
    };

    await vi.waitFor(() => expect(w.store.byRun(w.runId)?.holdReason).toContain(`from ${H1} to ${MOVED}`), { timeout: 5_000 });
    await vi.waitFor(() => expect(stepIds(w)).toContain("sh-seat-notice"), { timeout: 5_000 });

    expect(w.store.eventsOf(w.runId).at(-1)).toMatchObject({ kind: "hold", actor: "shepherd", headSha: MOVED });
    expect(w.fake.pr(1).merged).toBe(false);
  });

  it("stays released across a clean merge-up of the released head", async () => {
    const w = releasedThenMoved("clean-merge-up");

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), { timeout: 5_000 });

    expect(w.store.byRun(w.runId)?.held).toBe(false);
    expect(w.store.eventsOf(w.runId).map((event) => event.kind)).toEqual(["hold", "release"]);
  });
});
