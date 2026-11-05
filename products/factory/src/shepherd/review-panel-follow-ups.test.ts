import { CONFIG_PATH, formatResultLine } from "@titan-design/fix-proof";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type PrFile } from "@titan-design/github";
import type { ReviewerAgent, ReviewerDispatch, ReviewerMessage, ReviewerReader } from "@titan-design/review-panel";
import type { SourceTextLocator } from "@titan-design/session-read";
import type { StepRoute } from "@titan-design/workflow";
import { fakeActiveWork } from "../test-support/active-work.js";
import { activeWorkFollowUpTasks } from "./cleanup-ports.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "../definition.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { shepherdEventMigration } from "./events.js";
import { FIX_PROOF_CHECK } from "./fix-proof.js";
import type { ShepherdDeps, Verdict } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { proofWaiverMigration } from "./proof-waiver-table.js";
import { DEFAULT_ADVERSARY_PROFILE, intentPlan, panelPolicyFor } from "./review-panel-plan.js";
import { REVIEW_STEPS, reviewPhase, reviewRoutes } from "./review.js";
import { holdReviewerMigration, holdSatisfiedMigration, holdSlotsMigration, shepherdMigration, shepherdStoreRef, sliceMigration } from "./store.js";

// Panel members on a test-only head under a g10-adversary hold each end their verdict with the same Follow-ups block.
const REPO = "octo/demo";
const H = fakeSha("tests-member-head");
const MERGE_BASE = fakeSha("tests-member-merge-base");
const FIX_PROOF_JOB = 77;
const TESTS_ONLY: PrFile[] = [{ path: "packages/x/src/a.test.ts", status: "modified" }];

const proofLine = (verdict: "vacuous" | "unproven" | "error", newApi = 0) => formatResultLine({
  head: H,
  mergeBase: MERGE_BASE,
  base: "main",
  verdict,
  counts: { reproduces: 0, "passes-on-base": verdict === "vacuous" ? 1 : 0, "new-api": newApi, "fails-on-head": 0, "not-run": 0 },
  notCollected: [],
  deletedTests: [],
  configEdited: false,
  tests: [],
  truncated: false,
});
const vacuousLine = proofLine("vacuous");
const actionsLog =(line: string) => ["Run pnpm fix-proof", line, "Post job cleanup."].map((text) => `2026-10-22T12:00:00.0000000Z ${text}`).join("\n");

/** What the test-only classifier reads: the merge base, the fix-proof config there and at main, and each changed file's blobs. */
function seedDiffReads(fake: FakeGitHub, files: readonly PrFile[]): void {
  const config = JSON.stringify({ tests: ["packages/*/src/**/*.test.ts"], carry: [] });
  fake.compares.set(`main...${H}`, { mergeBaseSha: MERGE_BASE, files: [] });
  for (const ref of [MERGE_BASE, "main"]) fake.files.set(`${ref}:${CONFIG_PATH}`, { content: config, blobSha: fakeSha(`${ref}:config`) });
  for (const file of files) for (const ref of [H, MERGE_BASE]) fake.files.set(`${ref}:${file.path}`, { content: "blob", blobSha: fakeSha(`${ref}:${file.path}`) });
}

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
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const ORIGIN = "http://127.0.0.1:7400";
const BLOCK = "Follow-ups:\n- Cache the head lookup | A second lookup at one head reads the cache | medium";
const verdictText = `Probes: removed bound -> test fails\n\n${BLOCK}\n\nVerdict: MERGE\nPR: ${REPO}#1\nHead: ${H}\n`;

function reviewers(now: () => number) {
  const agents: ReviewerAgent[] = [];
  const dispatch: ReviewerDispatch = {
    roster: async () => [...agents],
    spawn: async (name) => void agents.push({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence: "live", spawnedBy: null, predecessor: null }),
    resume: async () => undefined,
  };
  const says = (who: ReviewerAgent): ReviewerMessage[] => [{ agentId: who.agentId, sessionId: who.sessionId, writtenAt: now() + 1, text: verdictText, locator: locatorIn(who.sessionId) }];
  const reader: ReviewerReader = { read: async (input) => agents.filter((who) => who.agentId === input.reviewerAgentId).flatMap(says) };
  return { dispatch, reader };
}

async function review() {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H, mergeSha: fakeSha("tests-member-merge") });
  fake.setRuns(H, [successRun("validate", 1), successRun("dag-check", 2), { ...successRun(FIX_PROOF_CHECK, FIX_PROOF_JOB), headSha: H, pullRequests: [{ number: 1, baseRef: "main" }] }]);
  fake.jobLogs.set(FIX_PROOF_JOB, actionsLog(vacuousLine));
  fake.prFiles.set(1, TESTS_ONLY);
  seedDiffReads(fake, TESTS_ONLY);
  const aw = fakeActiveWork([{ id: "DM-1", status: "open", done_when: "Parent done.", notes: "", tags: [] }]);
  let clock = 10_000;
  const store = shepherdStoreRef();
  const deps: ShepherdDeps = { port: githubPort(fake.wire), store, now: () => clock, sleep: async (ms) => void (clock += ms), pollMs: 1_000, agentChatBin: "agent-chat", reviewCheckouts: { root: "/data/reviews", remove: async () => undefined }, noReproProceed: "on" };
  const { dispatch, reader } = reviewers(() => clock);
  const followUps = activeWorkFollowUpTasks({ origin: ORIGIN, fetch: aw.fetch });
  const routes = reviewRoutes(deps, { reader, dispatch, timeoutMs: 5_000, holdMember: { profile: DEFAULT_ADVERSARY_PROFILE }, followUps });
  const database = { extraMigrations: [shepherdMigration(4), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19), proofWaiverMigration(32)], bind: store.bind };
  const run = async (ctx: Parameters<typeof reviewPhase>[0]) => void (await reviewPhase(ctx, { repo: REPO, pr: 1, round: 0, headSha: H }));
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [defineWorkflow({ name: "panel-follow-ups-test", steps: REVIEW_STEPS, run })], routes: Object.assign(routes, { database }), gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("panel-follow-ups-test", { policy: JSON.stringify(OWNER_GATE_POLICY), task: "demo/DM-1" });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/DM-1", implementer: "impl-a", policy: OWNER_GATE_POLICY, kind: "test-only" });
  store.get().hold(runId, "g10-adversary: auth tests; TP-1", undefined, { actor: "seat" });
  await host.runtime.wait(runId);
  const recorded = Object.values(host.runtime.status(runId)!.stepResults);
  return { aw, followUpSteps: recorded.filter((result) => result.stepId.startsWith("sh-follow-ups:")).map((result) => ({ stepId: result.stepId, result: result.data?.["result"] })) };
}

describe("a panel's members and their follow-ups", () => {
  it("each panel member's follow-ups are filed under its own sh-follow-ups step and a title two members share is filed once", async () => {
    const { aw, followUpSteps } = await review();

    const memberSteps = followUpSteps.filter((recorded) => recorded.stepId.endsWith(":tests") || recorded.stepId.endsWith(":adversary"));
    const filed = [...aw.tasks.values()].filter((task) => task.title === "Cache the head lookup");
    expect(memberSteps.map((recorded) => recorded.stepId).sort()).toEqual([`sh-follow-ups:${H}:adversary`, `sh-follow-ups:${H}:tests`]);
    expect(filed).toHaveLength(1);
    expect(memberSteps.flatMap((recorded) => z.looseObject({ filed: z.array(z.looseObject({ deduped: z.boolean() })) }).parse(recorded.result).filed.map((entry) => entry.deduped)).filter(Boolean).length).toBeGreaterThan(0);
  });
});
