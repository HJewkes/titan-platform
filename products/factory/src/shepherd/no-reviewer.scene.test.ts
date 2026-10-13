import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { gateId } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import type { ReviewAccounts } from "./account-limit.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { ReviewerBrokerBusy, reviewPhase, type ReviewerAgent, type ReviewerDispatch, type ReviewerMessage } from "./review.js";
import { agentChatReviewerDispatch } from "./reviewer-dispatch.js";
import { createRosterReader } from "./roster.js";
import { shepherdStoreRef } from "./store.js";

/** relay#69, TP-460 b, run 89fcb29b: every sh-review at 53934fcf was refused with ReviewCheckoutUnusable. */
/** A stand-in key: the replayed repo is private, and only its lack of a bound checkout matters here. */
const REPO = "octo/unbound";
const PR = 69;
const HEAD = "53934fcf".padEnd(40, "0");
const T0 = Date.parse("2026-10-12T11:12:00.000Z");
const MINUTE = 60_000;
const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const HELD = "no-reviewer: ReviewCheckoutUnusable at 53934fcf00000000000000000000000000000000; TP-2446";

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

/** The checkout cwdFor answers, and what an unbound spawn throws instead of the real port's refusal; absent means the real port refuses it. */
interface Binding {
  checkout?: string;
  refuse?: () => Error;
}

/**
 * Spawns go through the real agent-chat port while no checkout is bound, so the refusal is its own ReviewCheckoutUnusable thrown
 * before any process starts. Once a checkout is bound, a spawn lands as a reviewer that says MERGE.
 */
function reviewers(binding: Binding, clock: () => number) {
  const agents: ReviewerAgent[] = [];
  const spawnedAt: number[] = [];
  const alerts: { repo: string; text: string }[] = [];
  const port = agentChatReviewerDispatch({ agentChatBin: "/nonexistent/agent-chat", roles: { g10: "rv", standard: "rv" }, cwdFor: () => binding.checkout, roster: createRosterReader(async () => []) });
  const dispatch: ReviewerDispatch = {
    roster: async () => [...agents],
    spawn: async (name, brief, target, facts) => {
      if (binding.refuse) throw binding.refuse();
      if (binding.checkout === undefined) return port.spawn(name, brief, target, facts);
      spawnedAt.push(clock());
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
  return { dispatch, accounts, reader: { read }, spawnedAt, alerts };
}

/** One shepherd-pr run of relay#69 over the real review phase; every sleep moves the clock and yields once. */
function relay69(binding: Binding) {
  const fake = fakeGitHub();
  fake.addPr({ number: PR, headSha: HEAD, mergeSha: fakeSha("relay-merge") });
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
  const team = reviewers(binding, () => clock);
  const review = { reader: team.reader, dispatch: team.dispatch, accounts: team.accounts, timeoutMs: 5 * MINUTE };
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: tick, review });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake: async () => ({ kind: "unhandled", reason: "no fixer here" }) })], routes, gatePollMs: 5 });
  hosts.push(host);
  runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: String(PR), policy: JSON.stringify(AUTO) });
  store.get().register({ repo: REPO, pr: PR, runId, task: "relay/TP-460", implementer: "tc-tp-460-b", policy: AUTO });
  const stepIds = () => Object.values(host.runtime.status(runId)!.stepResults).map((result) => result.stepId);
  return { runId, store, host, fake, holds, team, stepIds, now: () => clock };
}

describe("a reviewer dispatch refused for want of a checkout (relay#69 run 89fcb29b)", () => {
  it("holds the run as no-reviewer, alerts once and opens no approve-merge, however long the refusal stands", async () => {
    const scene = relay69({});

    const approveMerge = () => scene.host.gates.get(gateId(scene.runId, "approve-merge"));
    await vi.waitFor(() => expect(approveMerge() !== undefined || scene.now() > T0 + 150 * MINUTE).toBe(true), { timeout: 20_000 });

    expect(approveMerge()).toBeUndefined();
    expect(scene.store.get().byRun(scene.runId)).toMatchObject({ held: true, holdReason: HELD });
    expect(scene.holds).toEqual(new Set([HELD]));
    expect(scene.team.alerts).toEqual([{ repo: REPO, text: expect.stringContaining(`no reviewer could be started for ${REPO}#${PR} at ${HEAD}: ReviewCheckoutUnusable`) }]);
    expect(scene.stepIds().filter((id) => id.startsWith("sh-review:")).length).toBeGreaterThanOrEqual(3);
    expect(scene.fake.effects.merge).toBe(0);
  });

  it("reviews the same head and merges once a checkout is bound and the owner releases the hold", async () => {
    const binding: Binding = {};
    const scene = relay69(binding);
    await vi.waitFor(() => expect(scene.stepIds()).toContain(`sh-no-reviewer-wait:${HEAD}`), { timeout: 20_000 });

    binding.checkout = mkdtempSync(join(tmpdir(), "relay-checkout-"));
    dirs.push(binding.checkout);
    scene.store.get().release(scene.runId, { actor: "owner", headSha: HEAD });

    await vi.waitFor(() => expect(scene.fake.effects.merge).toBe(1), { timeout: 20_000 });
    expect(scene.team.spawnedAt).toHaveLength(1);
    expect(scene.team.alerts).toHaveLength(1);
    expect(scene.host.gates.get(gateId(scene.runId, "approve-merge"))).toBeUndefined();
  });

  it("keeps a still-busy broker on the retry path, with no hold and no alert", async () => {
    const scene = relay69({ refuse: () => new ReviewerBrokerBusy("broker busy") });

    await vi.waitFor(() => expect(scene.stepIds().filter((id) => id.startsWith("sh-review:")).length).toBeGreaterThanOrEqual(2), { timeout: 20_000 });

    expect(scene.stepIds().filter((id) => id.startsWith("sh-no-reviewer"))).toEqual([]);
    expect(scene.holds).toEqual(new Set());
    expect(scene.team.alerts).toEqual([]);
  });
});
