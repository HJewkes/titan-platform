import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { factoryRoutesFor } from "../workflows.js";
import { accountLimitStoreRef } from "./account-store.js";
import type { ReviewAccounts } from "./account-limit.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { reviewPhase, type ReviewerAgent, type ReviewerDispatch, type ReviewerMessage } from "./review.js";
import { ReviewerAskTimedOut } from "./review-wait.js";
import { shepherdStoreRef } from "./store.js";

/** tp#1417, run aafc3dde: an exhausted account, then ReviewerAskTimedOut at every roster read, were counted as three failed rounds. */
const REPO = "octo/intent-refused";
const PR = 1417;
const HEAD = "1b09e685".padEnd(40, "0");
const ACCOUNT = "/accounts/review";
const T0 = Date.parse("2026-10-14T17:30:00.000Z");
const MINUTE = 60_000;
const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };

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

interface Scenario {
  /** The error the roster read throws at this time, or undefined once it answers. */
  rosterFails: (now: number) => Error | undefined;
  /** How long the account stays exhausted from T0; absent leaves it with headroom. */
  exhaustedFor?: number;
}

/** One shepherd-pr run of tp#1417 over the real review phase; every sleep moves the clock and yields once. */
function tp1417(scenario: Scenario) {
  const fake = fakeGitHub();
  fake.addPr({ number: PR, headSha: HEAD, mergeSha: fakeSha("intent-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(PR, [{ path: "src/a.ts", status: "modified" }]);
  let clock = T0;
  const store = shepherdStoreRef(() => clock);
  const accountLimits = accountLimitStoreRef(() => clock);
  const holds = new Set<string>();
  let runId = "";
  const tick = async (ms: number, signal: AbortSignal) => {
    clock += ms;
    const reason = runId === "" ? undefined : store.get().byRun(runId)?.holdReason;
    if (reason) holds.add(reason);
    signal.throwIfAborted();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const agents: ReviewerAgent[] = [];
  const alerts: { repo: string; text: string }[] = [];
  const dispatch: ReviewerDispatch = {
    roster: async () => {
      const failure = scenario.rosterFails(clock);
      if (failure) throw failure;
      return [...agents];
    },
    spawn: async (name) => void agents.push({ name, agentId: `id-${name}`, sessionId: `s-${name}`, presence: "live", spawnedBy: null, predecessor: null }),
    resume: async () => {
      throw new Error("no reviewer is resumed here");
    },
  };
  const read = async (input: { repo: string; pr: number; head: string; reviewerAgentId: string; reviewerSessionId: string }): Promise<ReviewerMessage[]> => [
    { agentId: input.reviewerAgentId, sessionId: input.reviewerSessionId, writtenAt: clock + 1, text: `Verdict: MERGE\nPR: ${input.repo}#${input.pr}\nHead: ${input.head}\n`, locator: locatorIn(input.reviewerSessionId) },
  ];
  const accounts: ReviewAccounts = { dirs: [ACCOUNT], dispatchUnder: () => dispatch, alert: async (repo, text) => void alerts.push({ repo, text }) };
  const review = { reader: { read }, dispatch, accounts, timeoutMs: 5 * MINUTE };
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: tick, review, accountLimits });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake: async () => ({ kind: "unhandled", reason: "no fixer here" }) })], routes, gatePollMs: 5 });
  hosts.push(host);
  if (scenario.exhaustedFor !== undefined) accountLimits.get().markExhausted(ACCOUNT, T0 + scenario.exhaustedFor, "You've hit your usage limit");
  runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: String(PR), policy: JSON.stringify(AUTO) });
  store.get().register({ repo: REPO, pr: PR, runId, task: "octo/TP-1", implementer: "tc-tp-1-a", policy: AUTO });
  const results = () => Object.values(host.runtime.status(runId)!.stepResults);
  const stepIds = () => results().map((result) => result.stepId);
  const approveMerges = () => host.pendingGates().filter((gate) => gate.runId === runId && gate.stepId.startsWith("approve-merge")).map((gate) => gate.gate.id);
  return { runId, store, host, fake, holds, approveMerges, alerts, results, stepIds, now: () => clock };
}

const timedOutBetween = (from: number, to: number) => (now: number) => (now >= from && now < to ? new ReviewerAskTimedOut("agent-chat timed out") : undefined);

describe("a refused sh-review-intent is not a failed review round (tp#1417 run aafc3dde)", () => {
  it("opens no approve-merge for an exhausted account followed by roster timeouts past three rounds, then merges", async () => {
    const scene = tp1417({ exhaustedFor: 30 * MINUTE, rosterFails: timedOutBetween(T0 + 30 * MINUTE, T0 + 120 * MINUTE) });

    await vi.waitFor(() => expect(scene.fake.effects.merge === 1 || scene.approveMerges().length > 0).toBe(true), { timeout: 30_000 });

    expect(scene.approveMerges()).toEqual([]);
    expect(scene.fake.effects.merge).toBe(1);
    expect(scene.stepIds().filter((id) => id.startsWith("sh-account-hold:")).length).toBeGreaterThanOrEqual(1);
    const intents = scene.results().filter((result) => result.stepId.startsWith("sh-review-intent:"));
    expect(intents.filter((result) => JSON.stringify(result).includes('"notStarted":true')).length).toBeGreaterThanOrEqual(3);
    expect(scene.stepIds().some((id) => id.startsWith("sh-no-reviewer-hold"))).toBe(false);
  }, 40_000);

  it("holds the run as no-reviewer and alerts once when the intent is refused for any other reason", async () => {
    const scene = tp1417({ rosterFails: () => new Error("the roster is not readable") });

    await vi.waitFor(() => expect(scene.approveMerges().length > 0 || scene.now() > T0 + 150 * MINUTE).toBe(true), { timeout: 30_000 });

    expect(scene.approveMerges()).toEqual([]);
    expect(scene.store.get().byRun(scene.runId)).toMatchObject({ held: true, holdReason: `no-reviewer: Error at ${HEAD}; TP-2446` });
    expect(scene.alerts).toHaveLength(1);
    expect(scene.fake.effects.merge).toBe(0);
  }, 40_000);

  it("reviews after the reset when the account alone is exhausted, with no gate", async () => {
    const scene = tp1417({ exhaustedFor: 90 * MINUTE, rosterFails: () => undefined });

    await vi.waitFor(() => expect(scene.fake.effects.merge === 1 || scene.approveMerges().length > 0).toBe(true), { timeout: 30_000 });

    expect(scene.approveMerges()).toEqual([]);
    expect(scene.fake.effects.merge).toBe(1);
    expect(scene.now()).toBeGreaterThanOrEqual(T0 + 90 * MINUTE);
  }, 40_000);
});
