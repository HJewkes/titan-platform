import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { factoryRoutesFor } from "../workflows.js";
import type { ReviewAccounts } from "./account-limit.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import type { ReviewerAgent, ReviewerDispatch, ReviewerMessage } from "@titan-design/review-panel";
import { reviewPhase } from "./review.js";
import { DEFAULT_BROKER_DOWN_WAIT_MS } from "./review-wait.js";
import { agentChatReviewerDispatch } from "./reviewer-dispatch.js";
import { shepherdStoreRef } from "./store.js";

/** TP-4641: serve booted before the agent-chat broker listened, and the first refused roster read held the run as no-reviewer. */
const REPO = "octo/boot-race";
const PR = 2962;
const HEAD = "b007ace0".padEnd(40, "0");
const T0 = Date.parse("2026-10-30T03:56:00.000Z");
const MINUTE = 60_000;
const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const HELD = `no-reviewer: broker unavailable (no broker answered for 15 min) at ${HEAD}; TP-2446`;
// What agent-chat prints, exiting 1, when AGENT_CHAT_NO_AUTOSTART=1 finds no broker listening.
const NO_BROKER = "broker unavailable: no broker is listening and AGENT_CHAT_NO_AUTOSTART=1 forbids starting one";

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
});

/** An `agent-chat` with no broker behind it, so the real port classifies the CLI's own output. */
function brokerlessAgentChat(): string {
  const dir = mkdtempSync(join(tmpdir(), "broker-boot-"));
  dirs.push(dir);
  const bin = join(dir, "agent-chat");
  writeFileSync(bin, `#!/bin/sh\necho '${NO_BROKER}' >&2\nexit 1\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** The first `downReads` roster reads go through the real port to a broker that is not listening; later reads answer, and a spawn lands as a reviewer that says MERGE. */
function reviewers(downReads: number, clock: () => number) {
  const agents: ReviewerAgent[] = [];
  const alerts: { repo: string; text: string }[] = [];
  const port = agentChatReviewerDispatch({ agentChatBin: brokerlessAgentChat(), roles: { g10: "rv", standard: "rv" }, cwdFor: () => undefined });
  let down = downReads;
  const dispatch: ReviewerDispatch = {
    roster: async () => (down-- > 0 ? port.roster() : [...agents]),
    spawn: async (name) => void agents.push({ name, agentId: `id-${name}`, sessionId: `s-${name}`, presence: "live", spawnedBy: null, predecessor: null }),
    resume: async () => {
      throw new Error("no reviewer is resumed here");
    },
  };
  const read = async (input: { repo: string; pr: number; head: string; reviewerAgentId: string; reviewerSessionId: string }): Promise<ReviewerMessage[]> => [
    { agentId: input.reviewerAgentId, sessionId: input.reviewerSessionId, writtenAt: clock() + 1, text: `Verdict: MERGE\nPR: ${input.repo}#${input.pr}\nHead: ${input.head}\n`, locator: locatorIn(input.reviewerSessionId) },
  ];
  const accounts: ReviewAccounts = { dirs: ["/accounts/review"], dispatchUnder: () => dispatch, alert: async (repo, text) => void alerts.push({ repo, text }) };
  return { dispatch, accounts, reader: { read }, agents, alerts };
}

/** One shepherd-pr run over the real review phase; every sleep moves the clock and yields once. */
function bootRace(downReads: number) {
  const fake = fakeGitHub();
  fake.addPr({ number: PR, headSha: HEAD, mergeSha: fakeSha("boot-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(PR, [{ path: "src/a.ts", status: "modified" }]);
  let clock = T0;
  let heldAt: number | undefined;
  const store = shepherdStoreRef(() => clock);
  const holds = new Set<string>();
  let runId = "";
  const tick = async (ms: number, signal: AbortSignal) => {
    clock += ms;
    const reason = runId === "" ? undefined : store.get().byRun(runId)?.holdReason;
    if (reason) holds.add(reason);
    if (reason && heldAt === undefined) heldAt = clock;
    signal.throwIfAborted();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const team = reviewers(downReads, () => clock);
  const review = { reader: team.reader, dispatch: team.dispatch, accounts: team.accounts, timeoutMs: 5 * MINUTE };
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: tick, review });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake: async () => ({ kind: "unhandled", reason: "no fixer here" }) })], routes, gatePollMs: 5 });
  hosts.push(host);
  runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: String(PR), policy: JSON.stringify(AUTO) });
  store.get().register({ repo: REPO, pr: PR, runId, task: "octo/TP-1", implementer: "tc-tp-1-a", policy: AUTO });
  const stepIds = () => Object.values(host.runtime.status(runId)!.stepResults).map((result) => result.stepId);
  return { runId, store, fake, holds, team, stepIds, now: () => clock, heldAt: () => heldAt };
}

describe("a broker that is not listening yet when serve boots (TP-4641)", () => {
  it("waits out a broker that comes up after two refused roster reads, then dispatches the reviewer with no hold", async () => {
    const scene = bootRace(2);

    await vi.waitFor(() => expect(scene.fake.effects.merge === 1 || scene.holds.size > 0).toBe(true), { timeout: 20_000 });

    expect(scene.fake.effects.merge).toBe(1);
    expect(scene.team.agents).toHaveLength(1);
    expect(scene.holds).toEqual(new Set());
    expect(scene.team.alerts).toEqual([]);
    expect(scene.stepIds().filter((id) => id.startsWith("sh-no-reviewer"))).toEqual([]);
  });

  it("holds once, naming the unavailable broker, only after the wait runs out, however long the broker stays down", async () => {
    const scene = bootRace(Number.POSITIVE_INFINITY);

    await vi.waitFor(() => expect(scene.now()).toBeGreaterThan(T0 + 150 * MINUTE), { timeout: 20_000 });

    expect(scene.heldAt()).toBeGreaterThanOrEqual(T0 + DEFAULT_BROKER_DOWN_WAIT_MS);
    expect(scene.store.get().byRun(scene.runId)).toMatchObject({ held: true, holdReason: HELD });
    expect(scene.holds).toEqual(new Set([HELD]));
    expect(scene.team.alerts).toEqual([{ repo: REPO, text: expect.stringContaining("broker unavailable") }]);
    expect(scene.fake.effects.merge).toBe(0);
  });
});
