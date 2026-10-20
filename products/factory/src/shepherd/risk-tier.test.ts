import { fakeGitHub, fakeSha, githubPort, successRun, type PrFile } from "@titan-design/github";
import type { CiPolicy, SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { MERGE_EVIDENCE_STEP, mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidenceInput } from "./merge-facts.js";
import { ownerHoldOf, riskFactsOf, riskTier, type AuthorityLine, type RiskTierName } from "./risk-tier.js";
import type { Registration } from "./store.js";
import { watchRow } from "./view.js";

const VISUAL = ["apps/*/src/**"];

interface Row {
  scene: string;
  paths: string[];
  tier: RiskTierName;
  lines?: number;
  ciPolicy?: CiPolicy;
  authorityLine?: AuthorityLine;
  ownerHold?: string;
}

const tierOf = ({ paths, lines, ciPolicy, authorityLine, ownerHold }: Omit<Row, "scene" | "tier">) =>
  riskTier({ ...riskFactsOf({ paths, changedLines: lines, unread: undefined, ...(ciPolicy && { ciPolicy }), visualPaths: VISUAL, ownerHold }), ...(authorityLine && { authorityLine }) });

/** One row per line of the plan's section 3 that a head's facts decide; route escalations are no fact of the head. */
const TABLE: Row[] = [
  { scene: "a plain PR", paths: ["packages/store/src/a.ts"], tier: "low" },
  { scene: "a 600-line PR, which takes the g10 reviewer only", paths: ["packages/store/src/a.ts"], lines: 600, tier: "low" },
  { scene: "a 1200-line PR, which takes a second correctness MERGE", paths: ["packages/store/src/a.ts"], lines: 1200, tier: "medium" },
  { scene: "a dependency touch", paths: ["package.json", "pnpm-lock.yaml"], tier: "low" },
  { scene: "a migration touch", paths: ["packages/store/src/migrations/0007.sql"], tier: "low" },
  { scene: "a tool-guard security touch", paths: ["packages/tool-guard/src/deny.ts"], tier: "medium" },
  { scene: "a tool-guard security touch whose adversary says Authority widened", paths: ["packages/tool-guard/src/deny.ts"], authorityLine: "widened", tier: "high" },
  { scene: "a tool-guard security touch whose adversary says Authority tightened", paths: ["packages/tool-guard/src/deny.ts"], authorityLine: "tightened", tier: "medium" },
  { scene: "a generic policy touch", paths: ["packages/store/src/retention-policy.ts"], tier: "medium" },
  { scene: "a Shepherd merge-policy file", paths: ["products/factory/src/shepherd/g10-release.ts"], tier: "high" },
  { scene: "the risk classifier itself", paths: ["products/factory/src/shepherd/risk-tier.ts"], tier: "high" },
  { scene: "a Shepherd hold command file", paths: ["products/factory/src/shepherd/commands.ts"], tier: "high" },
  { scene: "an owner lever", paths: ["apps/console/server/routes/owner-tap-actions.ts"], tier: "high" },
  { scene: "a test of a merge-policy file", paths: ["products/factory/src/shepherd/g10-release.test.ts"], tier: "low" },
  { scene: "an authority touch", paths: ["packages/authority/src/evaluate.ts"], tier: "medium" },
  { scene: "the owner packet", paths: ["packages/authority/src/table.json"], tier: "high" },
  { scene: "an agent-chat profile", paths: ["profiles/bd-reviewer.json"], tier: "medium" },
  { scene: "an agent-chat profile whose adversary says Authority widened", paths: ["profiles/bd-reviewer.json"], authorityLine: "widened", tier: "high" },
  { scene: "a CI workflow, even with CI-policy unchanged", paths: [".github/workflows/ci.yml"], ciPolicy: { kind: "unchanged" }, tier: "high" },
  { scene: "a CI workflow spelt with folded case and a trailing dot", paths: [".GitHub./Workflows/ci.yml"], ciPolicy: { kind: "unchanged" }, tier: "high" },
  { scene: "CODEOWNERS", paths: [".github/CODEOWNERS"], ciPolicy: { kind: "unchanged" }, tier: "high" },
  { scene: "codewatch config", paths: [".codewatch/check.json"], tier: "high" },
  { scene: "another .github path", paths: [".github/pull_request_template.md"], ciPolicy: { kind: "unchanged" }, tier: "medium" },
  { scene: "a reviewer saying CI policy is weakened", paths: ["packages/store/src/a.ts"], ciPolicy: { kind: "weakened", keys: ["required-check"] }, tier: "high" },
  { scene: "a CI-policy line in a shape the parser refuses", paths: ["packages/store/src/a.ts"], ciPolicy: { kind: "malformed" }, tier: "high" },
  { scene: "a skill path", paths: [".claude/skills/demo/SKILL.md"], tier: "high" },
  { scene: "a visual path", paths: ["apps/console/src/App.tsx"], tier: "high" },
  { scene: "an owner-asked hold", paths: ["packages/store/src/a.ts"], ownerHold: "owner-asked: discuss", tier: "high" },
];

describe("riskTier, one row per tier table line", () => {
  it.each(TABLE)("$scene is $tier", (row) => {
    expect(tierOf(row).tier).toBe(row.tier);
  });

  it("names every fact that raised the tier, led by the tier it asks for", () => {
    const { reasons } = tierOf({ paths: ["packages/tool-guard/src/deny.ts", ".github/workflows/ci.yml"], lines: 900 });

    expect(reasons).toEqual(["high: CI workflow file .github/workflows/ci.yml", "medium: authority, security touch", "medium: .github path .github/workflows/ci.yml", "medium: size: 900 changed lines, over 800"]);
  });
});

describe("riskTier invariants", () => {
  it("classes the risk classifier as a policy touch, so registration holds a PR that edits it for the adversary", () => {
    expect(riskFactsOf({ paths: ["products/factory/src/shepherd/risk-tier.ts"], changedLines: 1, unread: undefined, ownerHold: undefined }).touches).toContain("policy");
  });

  it("never puts a 5000-line plain PR above medium", () => {
    expect(tierOf({ paths: ["packages/store/src/a.ts"], lines: 5000 })).toEqual({ tier: "medium", reasons: ["medium: size: 5000 changed lines, over 800"] });
  });

  it("reads an unread file list as high, whatever else it shows", () => {
    const facts = riskFactsOf({ paths: [], changedLines: undefined, unread: "the list is truncated", ownerHold: undefined });

    expect(riskTier(facts)).toEqual({ tier: "high", reasons: ["high: changed files unread: the list is truncated"] });
  });

  it("reads an empty file list as unread, so a failed read never lowers the tier", () => {
    expect(riskTier(riskFactsOf({ paths: [], changedLines: undefined, unread: undefined, ownerHold: undefined })).tier).toBe("high");
  });

  it("raises low to medium when the revert breaker tightens, and leaves high as it is", () => {
    const low = riskFactsOf({ paths: ["packages/store/src/a.ts"], changedLines: 10, unread: undefined, ownerHold: undefined });
    const high = riskFactsOf({ paths: [".github/workflows/ci.yml"], changedLines: 10, unread: undefined, ownerHold: undefined });

    expect(riskTier({ ...low, tighten: true })).toEqual({ tier: "medium", reasons: ["medium: tightened after reverts"] });
    expect(riskTier({ ...high, tighten: true }).tier).toBe("high");
  });

  it("counts no visual path when the run has no visual policy", () => {
    expect(riskTier(riskFactsOf({ paths: ["apps/console/src/App.tsx"], changedLines: 10, unread: undefined, ownerHold: undefined })).tier).toBe("low");
  });
});

const registered = (overrides: Partial<Registration>): Registration =>
  partialFake<Registration>({ held: false, holdReason: null, ownerHold: null, policy: { merge: "auto", mergeMethod: "squash", fixer: true, seat: "none" }, ...overrides });

describe("ownerHoldOf", () => {
  it("reads the owner slot, an owner or visual hold class, and an owner-asked or visual registration gate", () => {
    const at = "2026-10-20T00:00:00.000Z";

    expect(ownerHoldOf(registered({ ownerHold: { reason: "owner-asked: freeze", at, askedAt: null } }))).toBe("owner-asked: freeze");
    expect(ownerHoldOf(registered({ held: true, holdReason: "visual-gate2" }))).toBe("visual-gate2");
    expect(ownerHoldOf(registered({ held: true, holdReason: "owner-asked: discuss" }))).toBe("owner-asked: discuss");
    expect(ownerHoldOf(registered({ policy: { merge: "owner-gate", mergeMethod: "squash", fixer: true, seat: "s", ownerGateReason: "gate-2-visual" } }))).toBe("owner gate gate-2-visual");
  });

  it("leaves a seat owner gate with no owner reason, an agent's hold and a released hold low", () => {
    expect(ownerHoldOf(registered({ policy: { merge: "owner-gate", mergeMethod: "squash", fixer: true, seat: "s", ownerGateReason: "g10-security" } }))).toBeUndefined();
    expect(ownerHoldOf(registered({ held: true, holdReason: "g10-adversary: policy touch" }))).toBeUndefined();
    expect(ownerHoldOf(registered({ held: false, holdReason: "owner-asked: discuss" }))).toBeUndefined();
    expect(ownerHoldOf(undefined)).toBeUndefined();
  });
});

const REPO = "octo/demo";
const HEAD = fakeSha("risk-tier-head");
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const input: MergeEvidenceInput = {
  runId: "run-1",
  repo: REPO,
  pr: 1,
  head: HEAD,
  verdict: { value: "MERGE", head: HEAD, locator: partialFake<SourceTextLocator>() },
  resolver: REVIEWER,
  dispatchedReviewer: REVIEWER,
  seatGrants: ["merge-on-green-approve"],
};

async function evidenceFor(files: PrFile[], ownerHold?: string) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("test-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1)]);
  fake.prFiles.set(1, files);
  return mergeEvidence(githubPort(fake.wire), input, noFreezeStoreUntilTp523, { kind: "feature", ...(ownerHold !== undefined && { ownerHold }) });
}

describe("the merge evidence record", () => {
  it("carries the head's tier and reasons, sized from the file counts", async () => {
    const evidence = await evidenceFor([{ path: "packages/tool-guard/src/deny.ts", status: "modified", additions: 700, deletions: 300 }]);

    expect(evidence.record.riskTier).toEqual({ tier: "medium", reasons: ["medium: security touch", "medium: size: 1000 changed lines, over 800"] });
  });

  it("records the owner's own hold as high", async () => {
    const evidence = await evidenceFor([{ path: "packages/store/src/a.ts", status: "modified", additions: 1, deletions: 0 }], "owner-asked: discuss");

    expect(evidence.record.riskTier).toEqual({ tier: "high", reasons: ["high: owner hold: owner-asked: discuss"] });
  });
});

describe("the watch row shepherd status --json returns", () => {
  const registration = partialFake<Registration>({ repo: REPO, pr: 1, branch: "feat/x", runId: "run-1", task: "demo/T-1", held: false, policy: { merge: "auto", mergeMethod: "squash", fixer: true, seat: "none" } });
  const step = (stepId: string, completedAt: string, data: Record<string, unknown>) => partialFake<StepResult>({ stepId, iteration: 0, completedAt, signal: null, data });

  function runWith(evidenceHead: string): WorkflowRun {
    const ci = step("sh-ci:0", "2026-10-20T00:01:00.000Z", { result: { headSha: HEAD } });
    const evidence = step(`${MERGE_EVIDENCE_STEP}:${evidenceHead}`, "2026-10-20T00:02:00.000Z", { result: { head: evidenceHead, record: { riskTier: { tier: "high", reasons: ["high: visual apps/console/src/App.tsx"] } } } });
    const run = { id: "run-1", workflowName: "shepherd", params: { pr: "1" }, status: "paused" as const, currentStep: "merge:0", stepResults: { a: ci, b: evidence }, activeSteps: {} };
    return partialFake<WorkflowRun>({ ...run, revision: 1, ownerGeneration: 0, startedAt: "2026-10-20T00:00:00.000Z", completedAt: null, error: null });
  }

  it("shows the tier the newest evidence at the row's head recorded", () => {
    expect(watchRow({ registration, run: runWith(HEAD) }).riskTier).toEqual({ tier: "high", reasons: ["high: visual apps/console/src/App.tsx"] });
  });

  it("shows none for evidence at another head", () => {
    expect(watchRow({ registration, run: runWith(fakeSha("older-head")) }).riskTier).toBeUndefined();
  });
});
