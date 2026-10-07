import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ShepherdPhases, Verdict } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdStoreRef } from "./store.js";

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
