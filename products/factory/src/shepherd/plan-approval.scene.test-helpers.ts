import type { AgentRow } from "@titan-design/agent-dispatch";
import { fakeGitHub, fakeSha, githubPort, successRun, type GitHubWire, type PrFile } from "@titan-design/github";
import type { ReviewerAgent, ReviewerDispatch, ReviewerMessage } from "@titan-design/review-panel";
import type { SourceTextLocator } from "@titan-design/session-read";
import { expect, onTestFinished, vi } from "vitest";
import { recordPlanApproval } from "../console-action/plan-approval.js";
import type { PlanApprovalAction } from "../console-action/record.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { gateId } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import type { ReviewAccounts } from "./account-limit.js";
import type { LowTierMode } from "./g10-low-tier.js";
import type { OwnerTierMode } from "./owner-tier.js";
import type { PlanApproval } from "./plan-approval.js";
import type { RosterReader } from "./ports.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import type { EffectivePolicy } from "./policy-schema.js";
import { shepherdPrWorkflow } from "./pr.js";
import { reviewPhase } from "./review.js";
import { DEFAULT_ADVERSARY_PROFILE } from "./review-panel-plan.js";
import type { ReviewerRoles } from "./reviewer-roles.js";
import { shepherdStoreRef, type ShepherdStoreRef } from "./store.js";
import type { VisualGateMode } from "./visual-gate-config.js";

/** The real shepherd-pr run the plan-approval scenes merge or gate, shared by the TP-4284 rows and the TP-4360 plan round. */
export const REPO = "octo/planned";
export const PR = 7;
export const HEAD = fakeSha("planned-head");
export const TASK = "demo/TP-1";
export const T0 = Date.parse("2026-10-28T12:00:00.000Z");
const MINUTE = 60_000;
export const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };

const locatorIn = (nativeId: string): SourceTextLocator => ({
  source: {
    ...{ sourceId: nativeId, harness: "claude-code", format: "jsonl", formatVersion: null, path: `${nativeId}.jsonl`, namespace: "test" },
    ...{ conversation: { harness: "claude-code", namespace: "test", nativeId }, provenance: { kind: "claude-code-transcript", legacySessionId: nativeId } },
  },
  evidence: { line: { sourceId: nativeId, byteOffset: 0, byteLength: 0, contentHash: "", lineNumber: null, nativeOrdinal: null }, subrecord: { index: 0, path: [] } },
  selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] },
});

/** Every spawn lands as a reviewer that says MERGE at the head it was asked about, with `above` lines before the block and `extra` lines after the head. */
function mergingReviewers(clock: () => number, extra: string, above = "") {
  const agents: ReviewerAgent[] = [];
  const dispatch: ReviewerDispatch = {
    roster: async () => [...agents],
    spawn: async (name) => void agents.push({ name, agentId: `id-${name}`, sessionId: `s-${name}`, presence: "live", spawnedBy: null, predecessor: null }),
    resume: async () => {
      throw new Error("no reviewer is resumed here");
    },
  };
  const read = async (input: { repo: string; pr: number; head: string; reviewerAgentId: string; reviewerSessionId: string }): Promise<ReviewerMessage[]> => {
    const text = `${above}Verdict: MERGE\nPR: ${input.repo}#${input.pr}\nHead: ${input.head}\n${extra}`;
    return [{ agentId: input.reviewerAgentId, sessionId: input.reviewerSessionId, writtenAt: clock() + 1, text, locator: locatorIn(input.reviewerSessionId) }];
  };
  const accounts: ReviewAccounts = { dirs: ["/accounts/review"], dispatchUnder: () => dispatch, alert: async () => undefined };
  const rows = (): AgentRow[] => agents.map((agent) => ({ ...agent, state: agent.presence, status: "finished", profile: "", surface: "headless", cwd: "/work", generation: 1 }));
  const roster: RosterReader = { read: async () => ({ kind: "known", rows: rows() }), rows: async () => rows(), invalidate: () => undefined };
  return { reader: { read }, dispatch, accounts, roster };
}

export interface Row {
  files: PrFile[];
  policy: EffectivePolicy;
  reviewerLines: string;
  approve: (store: ShepherdStoreRef, host: FactoryHost) => void;
  /** Wraps the fake's wire, so a scene can fail one read. */
  wire?: (wire: GitHubWire) => GitHubWire;
  /** The G10 hold its registration placed, which a seat reviewed and released at the head before the first CI read. */
  seatReleased?: string;
  /** The G10 hold its registration placed, still gating at the first CI read. */
  held?: string;
  /** The profile each reviewer class is spawned at; absent spawns with no profile recorded. */
  roles?: ReviewerRoles;
  /** `shepherd.gateReset.lowTierPolicy` for the run's own reclass reads; absent leaves it unset, which reads `shadow`. */
  lowTier?: LowTierMode;
  /** `shepherd.gateReset.ownerTier` for the run's routes; absent stands for an unset key, which the config reader reads as shadow. */
  ownerTier?: OwnerTierMode;
  /** `shepherd.visualGate` for the run's routes; absent leaves it unset, which reads `owner`. */
  visualGate?: VisualGateMode;
  /** Lines every reviewer writes above its verdict block, such as an adversary's `Probes:` and `Authority:` lines. */
  aboveVerdict?: string;
  /** Plans the g10-adversary hold's adversary member and releases the hold on two MERGEs, as `twoMergeRelease: on` does. */
  holdMember?: true;
}

export type FakeGitHub = ReturnType<typeof fakeGitHub>;

/** The run's reviewers and, when the hold's adversary member is planned, the roster its two-MERGE release reads to prove them separate. */
function reviewWiring({ reviewerLines, aboveVerdict, roles, holdMember }: Row, clock: () => number) {
  const { roster, ...reviewers } = mergingReviewers(clock, reviewerLines, aboveVerdict);
  const adversary = holdMember && { holdMember: { profile: DEFAULT_ADVERSARY_PROFILE }, twoMergeRelease: "on" as const };
  return { review: { ...reviewers, timeoutMs: 5 * MINUTE, ...(roles && { roles }), ...adversary }, ...(holdMember && { roster }) };
}

/** One shepherd-pr run of the PR under an auto policy, reviewed MERGE with green checks, after `seed` sets the files and the row's approval is written. */
export function plannedRun(row: Row, seed: (fake: FakeGitHub) => void) {
  const { files, policy, approve, wire = (each) => each, seatReleased, held, lowTier, ownerTier, visualGate } = row;
  const fake = fakeGitHub();
  fake.addPr({ number: PR, headSha: HEAD, mergeSha: fakeSha("planned-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(PR, files);
  seed(fake);
  let clock = T0;
  const store = shepherdStoreRef(() => clock);
  const tick = async (ms: number, signal: AbortSignal) => {
    clock += ms;
    signal.throwIfAborted();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const gates = { ...(lowTier && { lowTierPolicy: lowTier }), ownerTier: ownerTier ?? "shadow", ...(visualGate && { visualGate }) };
  const routes = factoryRoutesFor({ port: githubPort(wire(fake.wire)), store, now: () => clock, sleep: tick, ...reviewWiring(row, () => clock), ...gates });
  const workflow = shepherdPrWorkflow({ review: reviewPhase, wake: async () => ({ kind: "unhandled", reason: "no fixer here" }) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [workflow], routes, gatePollMs: 5 });
  // Per test: under isolate:false this module loads once per worker, so a top-level afterEach would close only the first importing file's hosts.
  onTestFinished(() => host.close());
  approve(store, host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: String(PR), policy: JSON.stringify(policy) });
  store.get().register({ repo: REPO, pr: PR, runId, task: TASK, implementer: "fc-synthetic", kind: "feature", policy });
  if (seatReleased !== undefined) {
    store.get().hold(runId, seatReleased, undefined, { actor: "shepherd" });
    store.get().release(runId, { actor: "seat", headSha: HEAD });
  }
  if (held !== undefined) store.get().hold(runId, held, undefined, { actor: "shepherd" });
  return { fake, approveMerge: () => host.gates.get(gateId(runId, "approve-merge")), store, runId, host };
}

let confirmations = 0;

/** The console's plan-approval tap, as `route.ts` reads an owner-written record's action. */
export const recordedAction =
  (action: PlanApprovalAction) =>
  (store: ShepherdStoreRef, host: FactoryHost): void =>
    void recordPlanApproval({ action, confirmEvent: `action:${"c".repeat(60)}${confirmations++}` }, store.get(), host);

export const byConsole = (approval: PlanApproval) => recordedAction({ kind: "plan-approval", task: TASK, repo: REPO, ...approval });

export async function merged(run: ReturnType<typeof plannedRun>): Promise<void> {
  await vi.waitFor(() => expect(run.fake.effects.merge).toBe(1), { timeout: 20_000 });
  expect(run.approveMerge()).toBeUndefined();
}

export async function gatedAt(run: ReturnType<typeof plannedRun>, rowId: string): Promise<void> {
  await vi.waitFor(() => expect(run.approveMerge() !== undefined || run.fake.effects.merge > 0).toBe(true), { timeout: 20_000 });
  expect(run.fake.effects.merge).toBe(0);
  expect(run.approveMerge()?.prompt).toContain(`Policy shepherd-merge-guard/${rowId}:`);
}

export const modified = (...paths: string[]): PrFile[] => paths.map((path) => ({ path, status: "modified" }));
