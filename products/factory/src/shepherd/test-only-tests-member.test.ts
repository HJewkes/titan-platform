import { CONFIG_PATH, formatResultLine } from "@titan-design/fix-proof";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type PrFile } from "@titan-design/github";
import type { ReviewerAgent, ReviewerDispatch, ReviewerMessage, ReviewerReader } from "@titan-design/review-panel";
import type { SourceTextLocator } from "@titan-design/session-read";
import type { StepRoute } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "../definition.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { shepherdEventMigration } from "./events.js";
import { FIX_PROOF_CHECK } from "./fix-proof.js";
import type { ShepherdDeps, Verdict } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { proofWaiverMigration } from "./proof-waiver.js";
import { DEFAULT_ADVERSARY_PROFILE, intentPlan, panelPolicyFor } from "./review-panel-plan.js";
import { REVIEW_STEPS, reviewPhase, reviewRoutes } from "./review.js";
import { holdReviewerMigration, holdSatisfiedMigration, holdSlotsMigration, shepherdMigration, shepherdStoreRef, sliceMigration } from "./store.js";

// A replay shaped like tp#2258 (TP-4058): a test-only head on a g10-adversary hold whose fix-proof is vacuous, as a test-only diff's always is.
const REPO = "octo/demo";
const H = fakeSha("tests-member-head");
const MERGE_BASE = fakeSha("tests-member-merge-base");
const FIX_PROOF_JOB = 77;
const TESTS_ONLY: PrFile[] = [{ path: "packages/x/src/a.test.ts", status: "modified" }];
const TEST_ONLY_QUESTION = "say whether the test would fail without that change";

const proofLine = (verdict: "vacuous" | "unproven" | "error", newApi = 0) => formatResultLine({
  head: H,
  mergeBase: MERGE_BASE,
  verdict,
  counts: { reproduces: 0, "passes-on-base": verdict === "vacuous" ? 1 : 0, "new-api": newApi, "fails-on-head": 0, "not-run": 0 },
  notCollected: [],
  deletedTests: [],
  configEdited: false,
  tests: [],
  truncated: false,
});
const vacuousLine = proofLine("vacuous");
const StepOutput = z.looseObject({ result: z.unknown() });
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

/** What the tests member says; every other member says MERGE. */
type TestsSays = "MERGE" | "FIX_FIRST" | "nothing";

function verdictText(said: "MERGE" | "FIX_FIRST"): string {
  const findings = said === "FIX_FIRST" ? "- The changed test still passes with the bound removed.\n\n" : "";
  return `${findings}Probes: removed bound -> test fails\n\nVerdict: ${said}\nPR: ${REPO}#1\nHead: ${H}\n`;
}

function reviewers(tests: TestsSays, now: () => number) {
  const agents: ReviewerAgent[] = [];
  const spawns: { name: string; brief: string }[] = [];
  const dispatch: ReviewerDispatch = {
    roster: async () => [...agents],
    spawn: async (name, brief) => {
      spawns.push({ name, brief });
      agents.push({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence: "live", spawnedBy: null, predecessor: null });
    },
    resume: async () => undefined,
  };
  const says = (who: ReviewerAgent): ReviewerMessage[] => {
    const said = who.name.endsWith("-tests") ? tests : "MERGE";
    return said === "nothing" ? [] : [{ agentId: who.agentId, sessionId: who.sessionId, writtenAt: now() + 1, text: verdictText(said), locator: locatorIn(who.sessionId) }];
  };
  const reader: ReviewerReader = { read: async (input) => agents.filter((who) => who.agentId === input.reviewerAgentId).flatMap(says) };
  return { dispatch, reader, spawns };
}

interface Scene {
  tests?: TestsSays;
  files?: PrFile[];
  line?: string;
  kind?: string;
  /** The intent step reads its input as one recorded before TP-4195, which planned no tests member for a bad line. */
  legacyIntent?: boolean;
}

const beforeBadProofTests = (prompt: string): string => JSON.stringify(Object.fromEntries(Object.entries(z.record(z.string(), z.unknown()).parse(JSON.parse(prompt))).filter(([key]) => key !== "badFixProof")));

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

async function review({ tests = "MERGE", files = TESTS_ONLY, line = vacuousLine, kind = "test-only", legacyIntent = false }: Scene = {}) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H, mergeSha: fakeSha("tests-member-merge") });
  fake.setRuns(H, [successRun("validate", 1), successRun("dag-check", 2), { ...successRun(FIX_PROOF_CHECK, FIX_PROOF_JOB), headSha: H, pullRequests: [{ number: 1, baseRef: "main" }] }]);
  fake.jobLogs.set(FIX_PROOF_JOB, actionsLog(line));
  fake.prFiles.set(1, files);
  seedDiffReads(fake, files);
  let clock = 10_000;
  const store = shepherdStoreRef();
  const deps: ShepherdDeps = { port: githubPort(fake.wire), store, now: () => clock, sleep: async (ms) => void (clock += ms), pollMs: 1_000, agentChatBin: "agent-chat", reviewCheckouts: { root: "/data/reviews", remove: async () => undefined }, noReproProceed: "on" };
  const { dispatch, reader, spawns } = reviewers(tests, () => clock);
  const results: Record<string, unknown> = {};
  const record = (stepId: string, outcome: Awaited<ReturnType<StepRoute["runner"]["run"]>>) => {
    if (outcome.ok) results[stepId] = StepOutput.parse(JSON.parse(outcome.output)).result;
    return outcome;
  };
  const routes = reviewRoutes(deps, { reader, dispatch, timeoutMs: 5_000, holdMember: { profile: DEFAULT_ADVERSARY_PROFILE } }).map((route): StepRoute => ({ ...route, runner: { run: async (step) => record(step.stepId, await route.runner.run(legacyIntent ? { ...step, prompt: beforeBadProofTests(step.prompt) } : step)) } }));
  const database = { extraMigrations: [shepherdMigration(4), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19), proofWaiverMigration(32)], bind: store.bind };
  const verdicts: Verdict[] = [];
  const run = async (ctx: Parameters<typeof reviewPhase>[0]) => void verdicts.push(await reviewPhase(ctx, { repo: REPO, pr: 1, round: 0, headSha: H }));
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [defineWorkflow({ name: "tests-member-test", steps: REVIEW_STEPS, run })], routes: Object.assign(routes, { database }), gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("tests-member-test", { policy: JSON.stringify(OWNER_GATE_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo: pin the bound", implementer: "impl-a", policy: OWNER_GATE_POLICY, kind });
  store.get().hold(runId, "g10-adversary: auth tests; TP-1", undefined, { actor: "seat" });
  await host.runtime.wait(runId);
  const stepIds = Object.values(host.runtime.status(runId)!.stepResults).map((result) => result.stepId);
  return { verdicts, spawns, stepIds, panel: results[`sh-review-panel:${H}`] };
}

describe("a test-only head on a g10-adversary hold with a vacuous proof (tp#2258)", () => {
  it("merges on a fresh tests member's MERGE, with no waiver and the G10 bar met", async () => {
    const { verdicts, spawns, stepIds, panel } = await review();

    const testsMember = spawns.find((spawn) => spawn.name.endsWith("-tests"));
    expect(spawns.map((spawn) => spawn.name)).toHaveLength(new Set(spawns.map((spawn) => spawn.name)).size);
    expect(testsMember?.brief).toContain(TEST_ONLY_QUESTION);
    expect(stepIds.some((id) => id.startsWith("sh-fix-proof-waive"))).toBe(false);
    expect(panel).toMatchObject({ outcome: "MERGE", satisfiesG10: true });
    expect(verdicts).toMatchObject([{ kind: "MERGE", headSha: H }]);
  });

  it("gives no verdict when the tests member says nothing, never the proof's NO_REPRO or a MERGE", async () => {
    const { verdicts, panel } = await review({ tests: "nothing" });

    expect(panel).toMatchObject({ outcome: "no-verdict", satisfiesG10: false });
    expect(panel).not.toHaveProperty("fixProofShortfall");
    expect(verdicts).toEqual([expect.objectContaining({ kind: "none", cause: "no-verdict" })]);
  });

  it("sends the tests member's FIX_FIRST to the fixer, never a MERGE", async () => {
    const { verdicts, panel } = await review({ tests: "FIX_FIRST" });

    expect(panel).toMatchObject({ outcome: "FIX_FIRST", dissent: ["tests"], satisfiesG10: false });
    expect(verdicts).toMatchObject([{ kind: "FIX_FIRST", headSha: H }]);
  });

  it("still ends a diff that also changes source as NO_REPRO before any reviewer starts", async () => {
    const { verdicts, spawns } = await review({ files: [...TESTS_ONLY, { path: "packages/x/src/a.ts", status: "modified" }] });

    expect(verdicts).toMatchObject([{ kind: "NO_REPRO", headSha: H }]);
    expect(spawns).toEqual([]);
  });
});

// tp#2431 (TP-4195): a new export has no bug to reproduce, so fix-proof reads unproven with 12 new-api tests, and every reviewer says MERGE.
describe("a g10 head with an unproven or error fix-proof and a correctness + adversary panel (tp#2431)", () => {
  const NEW_API: PrFile[] = [{ path: "packages/x/src/a.ts", status: "modified" }, { path: "packages/x/src/a.test.ts", status: "modified" }];
  const unproven = proofLine("unproven", 12);

  it.each([
    ["unproven", unproven],
    ["error", proofLine("error")],
  ])("plans a blocking tests member for a %s line and merges on its MERGE, never a no-verdict retry", async (_verdict, line) => {
    const { verdicts, spawns, panel } = await review({ files: NEW_API, line, kind: "correctness" });

    expect(spawns.map((spawn) => spawn.name.split("-").at(-1))).toEqual(expect.arrayContaining(["adversary", "tests"]));
    expect(panel).toMatchObject({ outcome: "MERGE", dissent: [] });
    expect(panel).not.toHaveProperty("fixProofShortfall");
    expect(verdicts).toMatchObject([{ kind: "MERGE", headSha: H }]);
  });

  it("says the unplanned tests seat withheld the verdict when an intent recorded before TP-4195 planned none", async () => {
    const { verdicts, spawns, panel } = await review({ files: NEW_API, line: unproven, kind: "correctness", legacyIntent: true });

    expect(spawns.some((spawn) => spawn.name.endsWith("-tests"))).toBe(false);
    expect(panel).toMatchObject({ outcome: "no-verdict", fixProofShortfall: true });
    expect(verdicts).toEqual([{ kind: "none", cause: "no-verdict", reason: "every dispatched panel member answered, but the fix-proof needs a tests member the panel never planned" }]);
  });
});

describe("the tests member a test-only proof plans", () => {
  const security = { facts: { repo: REPO, pr: 1, head: H, base: "", kind: "security", changedFiles: [{ path: "src/auth.ts", additions: 5_000, deletions: 0 }] }, sizeUnread: false };

  it("goes right after a hold's adversary under a full panel, so the member cap keeps both and it blocks", () => {
    const planned = intentPlan(security, panelPolicyFor(), undefined, undefined, { holdMember: { profile: DEFAULT_ADVERSARY_PROFILE }, testsMember: true });

    expect(planned.plan.members.map((member) => `${member.shape}:${member.blocking}`)).toEqual(["correctness:true", "adversary:true", "tests:true"]);
  });
});
