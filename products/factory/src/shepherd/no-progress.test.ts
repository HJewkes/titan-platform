import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { SourceTextLocator } from "@titan-design/session-read";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep, step } from "../workflows/land.js";
import type { ShepherdPhases, Verdict } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { acceptVerdict } from "@titan-design/review-panel";
import { acceptExternalVerdict } from "./external-review.js";
import { reviewPhase, type ReviewerAgent, type ReviewerDispatch, type ReviewerMessage, type ReviewerReader } from "./review.js";
import type { Presence } from "./presence.js";
import { shepherdStoreRef } from "./store.js";
import { FIX_FIRST_STEP } from "./wake-brief.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const AUTO_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };

type Answer = "no" | "yes" | "absent" | "silent";

/** Reviews answer from `answers` in order, then Closer: yes; each FIX_FIRST is answered by a fixer that pushes a new head. */
async function runUntilGate(answers: Answer[]): Promise<{ prompt: string; reviews: number }> {
  const fake: FakeGitHub = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const asked: string[] = [];
  const review: ShepherdPhases["review"] = async (_ctx, request) => {
    const answer = answers[asked.length] ?? "yes";
    asked.push(request.headSha);
    if (answer === "silent") return { kind: "none" } satisfies Verdict;
    return { kind: "FIX_FIRST", headSha: request.headSha, text: "again", ...(answer !== "absent" && { closer: answer }) } satisfies Verdict;
  };
  const wake: ShepherdPhases["wake"] = async () => (fake.pushHead(1, fakeSha(`fix-${asked.length}`)), { kind: "woken", agent: "impl-a" });
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review, wake })], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge") });
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO_POLICY });
  await gateOpened(host, gateId(runId, "approve-merge"));
  return { prompt: host.gates.get(gateId(runId, "approve-merge"))?.prompt ?? "", reviews: asked.length };
}

describe("the no-progress escalation", () => {
  it("opens approve-merge at the second consecutive FIX_FIRST that said Closer: no", async () => {
    const gate = await runUntilGate(["no", "no"]);

    expect(gate.reviews).toBe(2);
    expect(gate.prompt).toContain("Policy shepherd-route/no-progress: 2 FIX_FIRST reviews in a row said the head is no closer to MERGE: the last at ");
  });

  it("does not escalate when a Closer: yes sits between two no answers", async () => {
    const gate = await runUntilGate(["no", "yes", "no"]);

    expect(gate.prompt).toContain("fix-first-runaway");
    expect(gate.reviews).toBe(6);
  });

  it("does not escalate when a round with no verdict sits between two no answers", async () => {
    const gate = await runUntilGate(["no", "silent", "no"]);

    expect(gate.prompt).toContain("fix-first-runaway");
  });

  it("does not escalate when a FIX_FIRST carries no Closer line, and runs to the runaway at 6", async () => {
    const gate = await runUntilGate(["no", "absent", "no", "absent", "absent", "absent"]);

    expect(gate.prompt).toContain("fix-first-runaway");
    expect(gate.reviews).toBe(6);
  });

  it("keeps fix-first-runaway at 6 when every FIX_FIRST has no Closer line", async () => {
    const gate = await runUntilGate(Array<Answer>(6).fill("absent"));

    expect(gate.prompt).toContain(`Policy shepherd-route/fix-first-runaway: 6 FIX_FIRST reviews at this task`);
  });
});

describe("a reviewer's Closer line", () => {
  const input = { repo: REPO, pr: 1, head: H1, reviewerAgentId: "a", reviewerSessionId: "s", dispatchedAt: 0 };
  const said = (text: string) => ({ agentId: "a", sessionId: "s", writtenAt: 1, text, locator: { source: { conversation: { nativeId: "s" } } } as unknown as SourceTextLocator });

  it("reaches the accepted FIX_FIRST verdict", () => {
    const result = acceptVerdict(input as never, [said(`Read all.\n\nVerdict: FIX_FIRST\nPR: ${REPO}#1\nHead: ${H1}\nCloser: no\n`)]);

    expect(result).toMatchObject({ kind: "verdict", verdict: "FIX_FIRST", closer: "no" });
  });
});

describe("the Closer signal through the real review phase", () => {
  const row = (name: string, presence: Presence = "exited"): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence, spawnedBy: "coord", predecessor: null });
  const said = (who: ReviewerAgent, text: string): ReviewerMessage => ({
    ...{ agentId: who.agentId, sessionId: who.sessionId, writtenAt: 1, text },
    locator: { source: { conversation: { nativeId: who.sessionId } } } as unknown as SourceTextLocator,
  });

  it("asks only a re-review for Closer, and two replies ending Closer: no open the no-progress gate", async () => {
    const fake = fakeGitHub();
    fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
    const agents: ReviewerAgent[] = [row("coord", "live")];
    const briefs: string[] = [];
    const dispatch: ReviewerDispatch = { roster: async () => [...agents], spawn: async (name, brief) => (briefs.push(brief), void agents.push(row(name))), resume: async () => undefined };
    const reader: ReviewerReader = {
      read: async (input) => agents.filter((who) => who.agentId === input.reviewerAgentId).map((who) => said(who, `Not yet.\n\nVerdict: FIX_FIRST\nPR: ${REPO}#1\nHead: ${input.head}\nCloser: no\n`)),
    };
    // The real wake records its FIX_FIRST iteration, which is what makes the next brief a re-review.
    const wake: ShepherdPhases["wake"] = async (ctx, request) => {
      await step(ctx, FIX_FIRST_STEP, { repo: request.repo, pr: request.pr, headSha: request.headSha, fixFirst: ctx.iteration(FIX_FIRST_STEP) + 1 }, z.looseObject({}));
      fake.pushHead(1, fakeSha(`fix-${briefs.length}`));
      return { kind: "woken", agent: "impl-a" };
    };
    const store = shepherdStoreRef();
    const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal), review: { dispatch, reader } });
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake })], routes, gatePollMs: 5 });
    hosts.push(host);
    fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge") });
    fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
    const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO_POLICY) });
    store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO_POLICY });

    await gateOpened(host, gateId(runId, "approve-merge"));

    expect(briefs).toHaveLength(2);
    expect(briefs[0]).not.toContain("Closer");
    expect(briefs[1]).toContain("`Closer: yes`");
    expect(host.gates.get(gateId(runId, "approve-merge"))?.prompt).toContain("shepherd-route/no-progress");
  });

  it("carries Closer: no from an external reviewer's FIX_FIRST", () => {
    const external = row("ext");
    const input = { repo: REPO, pr: 1, head: H1 };
    const text = `Verdict: FIX_FIRST\nPR: ${REPO}#1\nHead: ${H1}\nCloser: no\n`;

    const result = acceptExternalVerdict(input as never, external, [said(external, text)]);

    expect(result).toMatchObject({ kind: "verdict", verdict: "FIX_FIRST", closer: "no" });
  });
});
