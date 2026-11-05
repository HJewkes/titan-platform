import { fakeGitHub, fakeSha, githubPort, successRun, type GitHubPort, type PrFile } from "@titan-design/github";
import type { ReviewerAgent, ReviewerDispatch, ReviewerReader } from "@titan-design/review-panel";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { G10_RECLASS_STEP } from "./g10-reclass.js";
import type { ShepherdPhases } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import type { EffectivePolicy } from "./policy-schema.js";
import { shepherdPrWorkflow } from "./pr.js";
import { applyRegistrationHold } from "./registration-hold.js";
import { reviewPhase } from "./review.js";
import { shepherdStoreRef, type ShepherdStore } from "./store.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const AUTO_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const UNREAD = "g10-adversary: changed files unread at registration (Error)";

const row = (name: string): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence: "exited", spawnedBy: "coord", predecessor: null });

function locatorIn(sessionId: string): SourceTextLocator {
  const conversation = { harness: "claude-code", namespace: "test", nativeId: sessionId };
  const source = { sourceId: sessionId, harness: "claude-code", format: "claude-code-jsonl", formatVersion: null, path: "transcript.jsonl", namespace: "test", conversation, provenance: { kind: "claude-code-transcript" as const, legacySessionId: sessionId } };
  const evidence = { line: { sourceId: sessionId, byteOffset: 0, byteLength: 1, contentHash: "0", lineNumber: 1, nativeOrdinal: null }, subrecord: { index: 0, path: ["message"] } };
  return { source, evidence, selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] } };
}

/** Every reviewer Shepherd spawns says MERGE at the head it reads, so only the hold can stop the merge. */
function mergingReviewers(): { dispatch: ReviewerDispatch; reader: ReviewerReader } {
  const agents: ReviewerAgent[] = [{ ...row("coord"), presence: "live", spawnedBy: null }, row("impl-a")];
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
  store: ShepherdStore;
  runId: string;
  merged: () => boolean;
}

/** A PR whose file read failed twice at registration, holding it unread; every later read of its files succeeds. */
async function heldUnreadAtRegistration(files: PrFile[]): Promise<World> {
  const fake = fakeGitHub();
  const real = githubPort(fake.wire);
  let failing = 2;
  const port: GitHubPort = { ...real, listPrFiles: (repo, pr) => (failing-- > 0 ? Promise.reject(new Error("rate limited")) : real.listPrFiles(repo, pr)) };
  const wake: ShepherdPhases["wake"] = async () => ({ kind: "unhandled", reason: "no fixer in this test" });
  const ref = shepherdStoreRef();
  const routes = factoryRoutesFor({ port, store: ref, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal), review: { ...mergingReviewers(), roles: { g10: "bd-reviewer", standard: "reviewer" } } });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake })], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge") });
  fake.prFiles.set(1, files);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO_POLICY) });
  const store = ref.get();
  store.register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO_POLICY, kind: "correctness" });
  expect(await applyRegistrationHold(port, store, runId)).toBe(UNREAD);
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  return { host, store, runId, merged: () => fake.pr(1).merged };
}

const stepIds = (w: World): string[] => Object.values(w.host.runtime.status(w.runId)!.stepResults).map((result) => result.stepId);

describe("a run held because its changed files were unread at registration, whose files read whole at a CI read", () => {
  it("ends unheld and merges a PR with no adversary touch, its hold lifted as a re-class", async () => {
    const w = await heldUnreadAtRegistration([{ path: "src/a.ts", status: "modified", additions: 10, deletions: 0 }]);

    await vi.waitFor(() => expect(w.merged()).toBe(true), { timeout: 5_000 });

    expect(w.store.byRun(w.runId)?.held).toBe(false);
    expect(w.store.eventsOf(w.runId).map(({ kind, reason, reclass }) => ({ kind, reason, reclass }))).toEqual([
      { kind: "hold", reason: UNREAD, reclass: undefined },
      { kind: "release", reason: UNREAD, reclass: true },
    ]);
    expect(stepIds(w)).toContain(G10_RECLASS_STEP);
  });

  it("keeps the hold on an authority PR and does not merge it", async () => {
    const w = await heldUnreadAtRegistration([{ path: "packages/authority/src/x.ts", status: "modified", additions: 20, deletions: 0 }]);

    await vi.waitFor(() => expect(stepIds(w)).toContain(G10_RECLASS_STEP), { timeout: 5_000 });
    await vi.waitFor(() => expect(w.host.runtime.status(w.runId)?.currentStep).toBe("merge:0"), { timeout: 5_000 });

    expect(w.store.byRun(w.runId)).toMatchObject({ held: true, holdReason: UNREAD });
    expect(w.merged()).toBe(false);
  });
});
