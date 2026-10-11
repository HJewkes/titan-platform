import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { G10_RELEASE_STEP } from "./g10-release.js";
import type { ShepherdPhases } from "./phases.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import type { Presence } from "./presence.js";
import { reviewPhase, type ReviewerAgent, type ReviewerDispatch, type ReviewerMessage, type ReviewerReader } from "./review.js";
import type { ReviewerRoles } from "./reviewer-roles.js";
import { shepherdStoreRef, type ShepherdStore } from "./store.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const AUTO_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const G10_HOLD = "g10-review: auth change; TP-1";

const row = (name: string, presence: Presence = "exited"): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence, spawnedBy: "coord", predecessor: null });
const said = (who: ReviewerAgent, text: string): ReviewerMessage => ({
  ...{ agentId: who.agentId, sessionId: who.sessionId, writtenAt: 1, text },
  locator: { source: { conversation: { nativeId: who.sessionId } } } as unknown as SourceTextLocator,
});

const STANDING = "rv-standing";

/** Every reviewer Shepherd spawns or resumes says MERGE at the head it reads; the standing reviewer has ended with room to resume. */
function mergingReviewers(): { dispatch: ReviewerDispatch; reader: ReviewerReader } {
  const agents: ReviewerAgent[] = [{ ...row("coord", "live"), spawnedBy: null }, row("impl-a"), { ...row(STANDING), fillTokens: 1_000 }];
  const resume = async (name: string) => agents.forEach((agent, i) => agent.name === name && (agents[i] = { ...agent, presence: "live" }));
  const dispatch: ReviewerDispatch = { roster: async () => [...agents], spawn: async (name) => void agents.push(row(name)), resume };
  const reader: ReviewerReader = {
    read: async (input) => agents.filter((who) => who.agentId === input.reviewerAgentId).map((who) => said(who, `Read it all.\n\nVerdict: MERGE\nPR: ${REPO}#1\nHead: ${input.head}\n`)),
  };
  return { dispatch, reader };
}

interface World {
  host: FactoryHost;
  fake: FakeGitHub;
  store: ShepherdStore;
  runId: string;
}

/** A security PR held as `g10-review`, reviewed for real by a reviewer spawned with the profile `roles` gives its class. */
function heldSecurityRun(roles: ReviewerRoles, policy: EffectivePolicy = AUTO_POLICY, hold = G10_HOLD): World {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const wake: ShepherdPhases["wake"] = async () => ({ kind: "unhandled", reason: "no fixer in this test" });
  const ref = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal), review: { ...mergingReviewers(), roles } });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake })], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge") });
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  const store = ref.get();
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(policy) });
  store.register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy, kind: "security" });
  store.hold(runId, hold);
  return { host, fake, store, runId };
}

const stepIds = (w: World): string[] => Object.values(w.host.runtime.status(w.runId)!.stepResults).map((result) => result.stepId);
const reviewMode = (w: World, head = H1): unknown => Object.values(w.host.runtime.status(w.runId)!.stepResults).find((result) => result.stepId === `sh-review:${head}`)?.data?.["result"];

describe("a g10-review hold on a run Shepherd reviews itself", () => {
  it("releases itself on the spawned opus reviewer's MERGE at a green head, and the PR merges", async () => {
    const w = heldSecurityRun({ g10: "bd-reviewer", standard: "reviewer" });

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true), { timeout: 5_000 });

    expect(stepIds(w)).toContain(`${G10_RELEASE_STEP}:${H1}:0`);
    expect(w.store.byRun(w.runId)?.held).toBe(false);
  });

  it.each([
    ["the spawned reviewer's profile is not an opus one", { g10: "reviewer", standard: "reviewer" }, AUTO_POLICY, "spawn"],
    ["the MERGE is a resumed standing reviewer's", { g10: "bd-reviewer", standard: "reviewer" }, { ...AUTO_POLICY, reviewer: STANDING }, "resume"],
  ] as const)("stays held when %s", async (_case, roles, policy, mode) => {
    const w = heldSecurityRun(roles, policy);

    await vi.waitFor(() => expect(w.host.runtime.status(w.runId)?.currentStep).toBe("merge:0"), { timeout: 5_000 });

    expect(reviewMode(w)).toMatchObject({ kind: "dispatched", mode });
    expect(stepIds(w).filter((id) => id.startsWith(G10_RELEASE_STEP))).toEqual([]);
    expect(w.store.byRun(w.runId)).toMatchObject({ held: true, holdReason: G10_HOLD });
    expect(w.fake.pr(1).merged).toBe(false);
  });
});

describe("a hold no reviewer of Shepherd's releases, on a run waiting at merge whose head moves", () => {
  const H2 = fakeSha("g10-moved-h2");

  it.each([
    ["an owner's", "owner wants a look"],
    ["a g10-adversary", "g10-adversary: merge-policy change; TP-1"],
  ])("keeps %s hold through a fresh opus review and green CI at the new head, and merges neither head", async (_case, hold) => {
    const w = heldSecurityRun({ g10: "bd-reviewer", standard: "reviewer" }, AUTO_POLICY, hold);
    await vi.waitFor(() => expect(w.host.runtime.status(w.runId)?.currentStep).toBe("merge:0"), { timeout: 5_000 });

    w.fake.pushHead(1, H2);

    await vi.waitFor(() => expect(w.host.runtime.status(w.runId)?.currentStep).toBe("merge:1"), { timeout: 5_000 });
    expect(reviewMode(w, H2)).toMatchObject({ kind: "dispatched" });
    expect(w.store.byRun(w.runId)).toMatchObject({ held: true, holdReason: hold });
    expect(w.fake.calls).not.toContain("merge");
    expect(w.fake.pr(1).merged).toBe(false);
  });
});
