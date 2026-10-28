import { FakeHttpError, fakeGitHub, fakeSha, githubPort, successRun, type GitHubWire, type PrFile } from "@titan-design/github";
import type { ReviewerAgent, ReviewerDispatch, ReviewerMessage } from "@titan-design/review-panel";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordPlanApproval } from "../console-action/plan-approval.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { gateId } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import type { ReviewAccounts } from "./account-limit.js";
import type { PlanApproval } from "./plan-approval.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { reviewPhase } from "./review.js";
import { shepherdStoreRef, type ShepherdStoreRef } from "./store.js";

/**
 * TP-4284, owner decision 551: the owner decides WHAT at plan time, so a merge-guard row a claimed plan approval covers
 * does not ask again at merge. Each row is proven over a real shepherd-pr run: a covering console-written approval merges
 * with no approve-merge gate, while a differing approval, an agent-written one or another PR's still gates.
 */
const REPO = "octo/planned";
const PR = 7;
const HEAD = fakeSha("planned-head");
const TASK = "demo/TP-1";
const ROUND = "plan-round-1";
const T0 = Date.parse("2026-10-28T12:00:00.000Z");
const MINUTE = 60_000;
const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const MERGE_LINT = ".github/merge-lint.json";
const OLD_WORKFLOW = ".github/workflows/old.yml";
const PACKAGE_JSON = "package.json";
const SKILL_FILE = ".claude/skills/x/SKILL.md";
const VISUAL_FILE = "src/ui/button.tsx";
const LINT_AFTER = fakeSha("lint-after");
const PACKAGE_AFTER = fakeSha("package-after");

const locatorIn = (nativeId: string): SourceTextLocator => ({
  source: {
    ...{ sourceId: nativeId, harness: "claude-code", format: "jsonl", formatVersion: null, path: `${nativeId}.jsonl`, namespace: "test" },
    ...{ conversation: { harness: "claude-code", namespace: "test", nativeId }, provenance: { kind: "claude-code-transcript", legacySessionId: nativeId } },
  },
  evidence: { line: { sourceId: nativeId, byteOffset: 0, byteLength: 0, contentHash: "", lineNumber: null, nativeOrdinal: null }, subrecord: { index: 0, path: [] } },
  selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] },
});

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** Every spawn lands as a reviewer that says MERGE at the head it was asked about, with `extra` lines after the head. */
function mergingReviewers(clock: () => number, extra: string) {
  const agents: ReviewerAgent[] = [];
  const dispatch: ReviewerDispatch = {
    roster: async () => [...agents],
    spawn: async (name) => void agents.push({ name, agentId: `id-${name}`, sessionId: `s-${name}`, presence: "live", spawnedBy: null, predecessor: null }),
    resume: async () => {
      throw new Error("no reviewer is resumed here");
    },
  };
  const read = async (input: { repo: string; pr: number; head: string; reviewerAgentId: string; reviewerSessionId: string }): Promise<ReviewerMessage[]> => [
    { agentId: input.reviewerAgentId, sessionId: input.reviewerSessionId, writtenAt: clock() + 1, text: `Verdict: MERGE\nPR: ${input.repo}#${input.pr}\nHead: ${input.head}\n${extra}`, locator: locatorIn(input.reviewerSessionId) },
  ];
  const accounts: ReviewAccounts = { dirs: ["/accounts/review"], dispatchUnder: () => dispatch, alert: async () => undefined };
  return { reader: { read }, dispatch, accounts };
}

interface Row {
  files: PrFile[];
  policy: EffectivePolicy;
  reviewerLines: string;
  approve: (store: ShepherdStoreRef, host: FactoryHost) => void;
  /** Wraps the fake's wire, so a scene can fail one read. */
  wire?: (wire: GitHubWire) => GitHubWire;
}

/** One shepherd-pr run of the PR under an auto policy, reviewed MERGE with green checks, after the row's approval is written. */
function plannedRun({ files, policy, reviewerLines, approve, wire = (each) => each }: Row) {
  const fake = fakeGitHub();
  fake.addPr({ number: PR, headSha: HEAD, mergeSha: fakeSha("planned-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(PR, files);
  fake.files.set(`main:${MERGE_LINT}`, { content: '{ "allow": ["a"] }\n', blobSha: fakeSha("lint-before") });
  fake.files.set(`${HEAD}:${MERGE_LINT}`, { content: '{ "allow": ["a", "b"] }\n', blobSha: LINT_AFTER });
  fake.files.set(`main:${OLD_WORKFLOW}`, { content: "on: push\n", blobSha: fakeSha("old-before") });
  fake.files.set(`${HEAD}:${PACKAGE_JSON}`, { content: '{ "scripts": {} }\n', blobSha: PACKAGE_AFTER });
  let clock = T0;
  const store = shepherdStoreRef(() => clock);
  const tick = async (ms: number, signal: AbortSignal) => {
    clock += ms;
    signal.throwIfAborted();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const review = { ...mergingReviewers(() => clock, reviewerLines), timeoutMs: 5 * MINUTE };
  const routes = factoryRoutesFor({ port: githubPort(wire(fake.wire)), store, now: () => clock, sleep: tick, review });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow({ review: reviewPhase, wake: async () => ({ kind: "unhandled", reason: "no fixer here" }) })], routes, gatePollMs: 5 });
  hosts.push(host);
  approve(store, host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: String(PR), policy: JSON.stringify(policy) });
  store.get().register({ repo: REPO, pr: PR, runId, task: TASK, implementer: "fc-synthetic", kind: "feature", policy });
  return { fake, approveMerge: () => host.gates.get(gateId(runId, "approve-merge")) };
}

let confirmations = 0;

/** The console's plan-approval tap, as `route.ts` reads it from an owner-written record. */
const byConsole =
  (approval: PlanApproval) =>
  (store: ShepherdStoreRef, host: FactoryHost): void =>
    void recordPlanApproval({ action: { kind: "plan-approval", task: TASK, repo: REPO, ...approval }, confirmEvent: `action:${"c".repeat(60)}${confirmations++}` }, store.get(), host);

/** A row with the same scope but an agent's actor, as a write around the console would leave it. */
const byAgent =
  (approval: PlanApproval) =>
  (_store: ShepherdStoreRef, host: FactoryHost): void =>
    void host.db
      .prepare("INSERT INTO shepherd_plan_approval (confirm_event, task, repo, gate, scope, round, actor, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("action:agent", TASK, REPO, approval.gate, JSON.stringify(approval.scope), approval.round, "agent:fc-synthetic", new Date(T0).toISOString());

/** The console's approval, claimed first by another PR registered under the same task. */
const claimedElsewhere =
  (approval: PlanApproval) =>
  (store: ShepherdStoreRef, host: FactoryHost): void => {
    byConsole(approval)(store, host);
    store.get().register({ repo: REPO, pr: PR + 1, runId: "run-other-pr", task: TASK, implementer: "fc-synthetic", kind: "feature", policy: AUTO });
  };

async function merged(run: ReturnType<typeof plannedRun>): Promise<void> {
  await vi.waitFor(() => expect(run.fake.effects.merge).toBe(1), { timeout: 20_000 });
  expect(run.approveMerge()).toBeUndefined();
}

async function gatedAt(run: ReturnType<typeof plannedRun>, rowId: string): Promise<void> {
  await vi.waitFor(() => expect(run.approveMerge() !== undefined || run.fake.effects.merge > 0).toBe(true), { timeout: 20_000 });
  expect(run.fake.effects.merge).toBe(0);
  expect(run.approveMerge()?.prompt).toContain(`Policy shepherd-merge-guard/${rowId}:`);
}

const pinning = (files: { path: string; blob: string | null }[]): PlanApproval => ({ gate: "ci-policy", scope: { ciPolicyKeys: ["other"], files }, round: ROUND });
const CI_POLICY = pinning([{ path: MERGE_LINT, blob: LINT_AFTER }]);
const modified = (...paths: string[]): PrFile[] => paths.map((path) => ({ path, status: "modified" }));
const ciRow = (approve: Row["approve"], files = modified(MERGE_LINT)): Row => ({ files, policy: AUTO, reviewerLines: "CI-policy: weakened other\n", approve });

describe("a PR whose only guard row is ci-policy-weakened, a merge-lint entry", () => {
  it("merges with no owner gate under a console-written approval pinning that file's head blob", async () => {
    await merged(plannedRun(ciRow(byConsole(CI_POLICY))));
  });

  it("gates at the same head when the approval pins a different blob", async () => {
    await gatedAt(plannedRun(ciRow(byConsole(pinning([{ path: MERGE_LINT, blob: fakeSha("lint-other") }])))), "ci-policy-weakened");
  });

  it("gates at the same head under an agent-written approval with the right pin", async () => {
    await gatedAt(plannedRun(ciRow(byAgent(CI_POLICY))), "ci-policy-weakened");
  });

  it("gates a second PR registered later under the approved task", async () => {
    await gatedAt(plannedRun(ciRow(claimedElsewhere(CI_POLICY))), "ci-policy-weakened");
  });
});

describe("a weakened PR that merges content the approval did not pin", () => {
  it("gates a head carrying the approved merge-lint blob and an unpinned package.json change", async () => {
    await gatedAt(plannedRun(ciRow(byConsole(CI_POLICY), modified(MERGE_LINT, PACKAGE_JSON))), "ci-policy-weakened");
  });

  it("gates a weakening with no .github/ change at all", async () => {
    await gatedAt(plannedRun(ciRow(byConsole(CI_POLICY), modified(PACKAGE_JSON))), "ci-policy-weakened");
  });
});

describe("a weakened PR whose approval pins a deleted workflow as absent", () => {
  const files: PrFile[] = [...modified(MERGE_LINT), { path: OLD_WORKFLOW, status: "removed" }];
  const approval = pinning([{ path: MERGE_LINT, blob: LINT_AFTER }, { path: OLD_WORKFLOW, blob: null }]);
  const failingHeadRead = (wire: GitHubWire): GitHubWire => ({
    ...wire,
    getContent: async (repo, path, ref) => {
      if (path === OLD_WORKFLOW && ref === HEAD) throw new FakeHttpError(502, "bad gateway");
      return wire.getContent(repo, path, ref);
    },
  });

  it("merges when every head read succeeds", async () => {
    await merged(plannedRun(ciRow(byConsole(approval), files)));
  });

  it("gates when the deleted file's head read fails, rather than reading it as absent", async () => {
    await gatedAt(plannedRun({ ...ciRow(byConsole(approval), files), wire: failingHeadRead }), "ci-policy-weakened");
  });
});

const SKILL: PlanApproval = { gate: "skill", scope: { paths: [SKILL_FILE] }, round: ROUND };
const skillRow = (approve: Row["approve"]): Row => ({ files: [...modified("src/x.ts"), { path: SKILL_FILE, status: "added" }], policy: AUTO, reviewerLines: "", approve });

describe("a PR that adds a repo skill", () => {
  it("merges with no owner gate under a console-written approval of that skill path", async () => {
    await merged(plannedRun(skillRow(byConsole(SKILL))));
  });

  it("gates at the skill-path row when the approval names another skill path", async () => {
    await gatedAt(plannedRun(skillRow(byConsole({ ...SKILL, scope: { paths: [".claude/skills/y/SKILL.md"] } }))), "skill-path");
  });

  it("gates at the skill-path row under an agent-written approval of the same path", async () => {
    await gatedAt(plannedRun(skillRow(byAgent(SKILL))), "skill-path");
  });
});

const VISUAL: PlanApproval = { gate: "visual", scope: { paths: [VISUAL_FILE] }, round: ROUND };
const visualRow = (approve: Row["approve"]): Row => ({ files: modified(VISUAL_FILE), policy: { ...AUTO, visualPaths: ["src/ui/**"] }, reviewerLines: "", approve });

describe("a PR that changes a seat's visual path", () => {
  it("merges with no owner gate under a console-written approval of that path", async () => {
    await merged(plannedRun(visualRow(byConsole(VISUAL))));
  });

  it("gates at the visual-path row when the approval names another visual path", async () => {
    await gatedAt(plannedRun(visualRow(byConsole({ ...VISUAL, scope: { paths: ["src/ui/card.tsx"] } }))), "visual-path");
  });

  it("gates at the visual-path row under an agent-written approval of the same path", async () => {
    await gatedAt(plannedRun(visualRow(byAgent(VISUAL))), "visual-path");
  });
});
