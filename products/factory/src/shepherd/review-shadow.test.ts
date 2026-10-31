import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import type { ReviewerAgent, ReviewerDispatch, ReviewerMessage } from "@titan-design/review-panel";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { factoryRoutesFor } from "../workflows.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { ReviewShadowRead, reviewShadow, workflowModeOf } from "./review-shadow.js";
import { reviewPhase } from "./review.js";
import { shepherdStoreRef } from "./store.js";

const REPO = "octo/shadow";
const PR = 7;
const HEAD = "5ad0e000".padEnd(40, "0");
const T0 = Date.parse("2026-10-30T09:00:00.000Z");
const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };

const round = (overrides: Record<string, unknown>) => ({ repo: REPO, pr: PR, head: HEAD, round: 1, proof: { kind: "skipped", reason: "no fix-proof ran" }, dispatched: { kind: "dispatched" }, verdict: { kind: "MERGE" }, ...overrides });

describe("reviewShadow", () => {
  it("would stop a panel round whose fix-proof shortfall left the tests seat empty as NO_REPRO at round 1 (tp#2145)", () => {
    const shadow = reviewShadow(round({ verdict: { kind: "NO_REPRO" } }));

    expect(shadow).toEqual({ kind: "shadow", round: 1, decision: "go", classes: ["shortfall"], would: "stop(NO_REPRO)" });
  });

  it("would send a head planned onto an uninstalled profile to the fixer before any dispatch (tp#1986)", () => {
    const shadow = reviewShadow(round({ dispatched: { kind: "none", refused: "DispatchError", reason: "no installed profile 'reviewer'" }, verdict: { kind: "none", cause: "no-verdict" } }), { profileInstalled: () => false });

    expect([shadow.decision.startsWith("fixer:start-refused:profile"), shadow.would]).toEqual([true, "fixer(start-refused:profile)"]);
  });

  it("spends one row step per timed-out round and reaches the fixer at round 3", () => {
    const wouldAt = (n: number) => reviewShadow(round({ round: n, verdict: { kind: "none", cause: "timeout" } })).would;

    expect([1, 2, 3].map(wouldAt)).toEqual(["late-read(timeout)", "retry(timeout)", "fixer(timeout)"]);
  });
});

describe("workflowModeOf", () => {
  it("runs on as off with a logged reason, and turns shadow and on:preflight on", () => {
    const warned: string[] = [];
    const modes = (["off", undefined, "on", "on:preflight", "shadow"] as const).map((mode) => workflowModeOf(mode, (text) => warned.push(text)));

    expect(modes).toEqual([{}, {}, {}, { workflow: "on:preflight" }, { workflow: "shadow" }]);
    expect(warned.map((text) => text.includes("runs as off"))).toEqual([true]);
  });
});

const locatorIn = (nativeId: string): SourceTextLocator => ({
  source: {
    sourceId: nativeId,
    harness: "claude-code",
    format: "jsonl",
    formatVersion: null,
    path: `${nativeId}.jsonl`,
    namespace: "test",
    conversation: { harness: "claude-code", namespace: "test", nativeId },
    provenance: { kind: "claude-code-transcript", legacySessionId: nativeId },
  },
  evidence: {
    line: { sourceId: nativeId, byteOffset: 0, byteLength: 0, contentHash: "", lineNumber: null, nativeOrdinal: null },
    subrecord: { index: 0, path: [] },
  },
  selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] },
});

const hosts: FactoryHost[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
});

/** One shepherd-pr run whose single reviewer says MERGE, under `review.workflow` shadow or off. */
function mergeRound(workflow: "shadow" | undefined) {
  const fake = fakeGitHub();
  fake.addPr({ number: PR, headSha: HEAD, mergeSha: fakeSha("shadow-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(PR, [{ path: "src/a.ts", status: "modified" }]);
  let clock = T0;
  const store = shepherdStoreRef(() => clock);
  const agents: ReviewerAgent[] = [];
  const spawned: string[] = [];
  const dispatch: ReviewerDispatch = {
    roster: async () => [...agents],
    spawn: async (name) => {
      spawned.push(name);
      agents.push({ name, agentId: `id-${name}`, sessionId: `s-${name}`, presence: "live", spawnedBy: null, predecessor: null });
    },
    resume: async () => {
      throw new Error("no reviewer is resumed here");
    },
  };
  const read = async (input: { repo: string; pr: number; head: string; reviewerAgentId: string; reviewerSessionId: string }): Promise<ReviewerMessage[]> => [
    { agentId: input.reviewerAgentId, sessionId: input.reviewerSessionId, writtenAt: clock + 1, text: `Verdict: MERGE\nPR: ${input.repo}#${input.pr}\nHead: ${input.head}\n`, locator: locatorIn(input.reviewerSessionId) },
  ];
  const review = { reader: { read }, dispatch, timeoutMs: 60_000, ...(workflow && { workflow }) };
  const sleep = async (ms: number) => {
    clock += ms;
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep, review });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake: async () => ({ kind: "unhandled", reason: "no fixer here" }) })], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: String(PR), policy: JSON.stringify(AUTO) });
  store.get().register({ repo: REPO, pr: PR, runId, task: "octo/TP-1", implementer: "tc-tp-1-a", policy: AUTO });
  const shadows = () => Object.values(host.runtime.status(runId)!.stepResults).filter((result) => result.stepId.startsWith("sh-review-shadow:"));
  return { fake, spawned, shadows };
}

describe("review.workflow shadow in Shepherd's review round", () => {
  it("records the round's would-action and spawns no reviewer beyond the one off spawns", async () => {
    const off = mergeRound(undefined);
    const shadow = mergeRound("shadow");

    await vi.waitFor(() => expect([off.fake.effects.merge, shadow.fake.effects.merge]).toEqual([1, 1]), { timeout: 30_000 });

    expect(shadow.spawned).toEqual(off.spawned);
    expect(shadow.shadows().map((result) => ReviewShadowRead.parse(result.data?.result).would)).toEqual(["merge"]);
  }, 40_000);

  it("records nothing under off", async () => {
    const off = mergeRound(undefined);

    await vi.waitFor(() => expect(off.fake.effects.merge).toBe(1), { timeout: 30_000 });

    expect(off.shadows()).toEqual([]);
  }, 40_000);
});
