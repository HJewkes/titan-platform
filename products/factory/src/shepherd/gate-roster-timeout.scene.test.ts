import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DispatchTimeoutError } from "@titan-design/agent-dispatch";
import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { isolateAgentChatHome } from "../test-support/agent-chat-home.js";
import { factoryRoutesFor } from "../workflows.js";
import type { ReviewAccounts } from "./account-limit.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import type { EffectivePolicy } from "./policy-schema.js";
import type { ReviewerAgent, ReviewerDispatch, ReviewerMessage } from "@titan-design/review-panel";
import { DEFAULT_SESSION_START_TIMEOUT_MS, reviewPhase } from "./review.js";
import { REVIEW_STEP } from "./review-steps.js";
import { BUSY_FIRST_WAIT_MS } from "./review-wait.js";
import { agentChatReviewerDispatch } from "./reviewer-dispatch.js";
import { createRosterReader } from "./roster.js";
import { spawnGate } from "./spawn-gate.js";
import { shepherdStoreRef } from "./store.js";

/** TP-5295: a spawn-gate roster read that timed out at admission launched nobody, yet read as a landed ask and cost a 5-min session-start wait. */
const REPO = "octo/gate-roster";
const PR = 3549;
const HEAD = "9a7e0000".padEnd(40, "0");
const T0 = Date.parse("2026-11-10T22:57:35.000Z");
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
const dirs: string[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  vi.unstubAllEnvs();
});

/** The real port and gate over a fake `agent-chat` that accepts any spawn; the gate's first roster read times out. */
function reviewers(clock: () => number) {
  const dir = mkdtempSync(join(tmpdir(), "gate-roster-"));
  dirs.push(dir);
  isolateAgentChatHome(join(dir, "home"), ["rv"]);
  const checkout = join(dir, "checkout");
  mkdirSync(checkout, { recursive: true });
  const bin = join(dir, "agent-chat");
  writeFileSync(bin, "#!/bin/sh\ncat >/dev/null\nexit 0\n");
  chmodSync(bin, 0o755);
  const gate = spawnGate({ read: () => ({ load5: 0 }), now: clock, log: () => undefined });
  let timeouts = 1;
  const gateRoster = createRosterReader(async () => (timeouts-- > 0 ? Promise.reject(new DispatchTimeoutError("broker did not answer agents_result")) : []));
  const port = agentChatReviewerDispatch({ agentChatBin: bin, roles: { g10: "rv", standard: "rv" }, cwdFor: () => checkout, gate, roster: gateRoster });
  const agents: ReviewerAgent[] = [];
  const asks: number[] = [];
  const alerts: { repo: string; text: string }[] = [];
  const dispatch: ReviewerDispatch = {
    roster: async () => [...agents],
    spawn: async (name, brief, t, facts, signal) => {
      asks.push(clock());
      await port.spawn(name, brief, t, facts, signal);
      agents.push({ name, agentId: `id-${name}`, sessionId: `s-${name}`, presence: "live", spawnedBy: null, predecessor: null });
    },
    resume: async () => {
      throw new Error("no reviewer is resumed here");
    },
  };
  const read = async (input: { repo: string; pr: number; head: string; reviewerAgentId: string; reviewerSessionId: string }): Promise<ReviewerMessage[]> => [
    { agentId: input.reviewerAgentId, sessionId: input.reviewerSessionId, writtenAt: clock() + 1, text: `Verdict: MERGE\nPR: ${input.repo}#${input.pr}\nHead: ${input.head}\n`, locator: locatorIn(input.reviewerSessionId) },
  ];
  const accounts: ReviewAccounts = { dirs: ["/accounts/review"], dispatchUnder: () => dispatch, alert: async (repo, text) => void alerts.push({ repo, text }) };
  return { dispatch, accounts, reader: { read }, agents, asks };
}

/** One shepherd-pr run over the real review phase; every sleep moves the clock and yields once. */
function gateRosterTimeout() {
  const fake = fakeGitHub();
  fake.addPr({ number: PR, headSha: HEAD, mergeSha: fakeSha("gate-roster-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(PR, [{ path: "src/a.ts", status: "modified" }]);
  let clock = T0;
  const store = shepherdStoreRef(() => clock);
  const holds = new Set<string>();
  let runId = "";
  const tick = async (ms: number, signal: AbortSignal) => {
    clock += ms;
    const reason = runId === "" ? undefined : store.get().byRun(runId)?.holdReason;
    if (reason) holds.add(reason);
    signal.throwIfAborted();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const team = reviewers(() => clock);
  const review = { reader: team.reader, dispatch: team.dispatch, accounts: team.accounts, timeoutMs: 5 * MINUTE };
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: tick, review });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake: async () => ({ kind: "unhandled", reason: "no fixer here" }) })], routes, gatePollMs: 5 });
  hosts.push(host);
  runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: String(PR), policy: JSON.stringify(AUTO) });
  store.get().register({ repo: REPO, pr: PR, runId, task: "octo/TP-1", implementer: "tc-tp-1-a", policy: AUTO });
  const stepIds = () => Object.values(host.runtime.status(runId)!.stepResults).map((result) => result.stepId);
  return { fake, holds, team, asks: team.asks, stepIds };
}

describe("a spawn-gate roster read that times out at admission (TP-5295)", () => {
  it("spawns the reviewer on the next ask, a minute later, with no 5-min session-start wait", async () => {
    const scene = gateRosterTimeout();

    await vi.waitFor(() => expect(scene.fake.effects.merge === 1 || scene.holds.size > 0).toBe(true), { timeout: 20_000 });

    expect(scene.fake.effects.merge).toBe(1);
    expect(scene.holds).toEqual(new Set());
    expect(scene.asks).toHaveLength(2);
    const gap = (scene.asks[1] ?? 0) - (scene.asks[0] ?? 0);
    expect(gap).toBeGreaterThanOrEqual(BUSY_FIRST_WAIT_MS);
    expect(gap).toBeLessThan(DEFAULT_SESSION_START_TIMEOUT_MS);
    expect(scene.team.agents).toHaveLength(1);
    expect(scene.stepIds().filter((id) => id === `${REVIEW_STEP}:${HEAD}`)).toHaveLength(1);
    expect(scene.stepIds().filter((id) => id.startsWith("sh-no-reviewer"))).toEqual([]);
  });
});
