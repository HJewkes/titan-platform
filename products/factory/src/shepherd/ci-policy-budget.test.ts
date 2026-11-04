import { fakeGitHub, fakeSha, githubPort, successRun, type PrFile } from "@titan-design/github";
import type { CiPolicy, SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { toJSONSchema } from "zod";
import { coordinatorEvidencePolicy, type CoordinatorEvidence } from "../coordinator-evidence.js";
import { approveMergeDecision } from "../gate-brief.js";
import type { GateRecord } from "@titan-design/hitl";
import { ciPolicyClass, type CiPolicyClassInput } from "./ci-policy-class.js";
import type { CiPolicyFile } from "./ci-policy-changes.js";
import { mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidenceInput } from "./merge-facts.js";
import { ownerAtHeadAt } from "./policy.js";

const REPO = "octo/demo";
const HEAD = fakeSha("budget-head");
const RUN_URL = `https://github.com/${REPO}/actions/runs/123456`;
const BODY = `Measured over 150 runs: ${RUN_URL}`;
const BUDGET = ".github/ci-budget.json";
const CI_YML = ".github/workflows/ci.yml";
const REQUIRED = ["validate", "dag-check"];

const budgetJson = (p90: number, extra = ""): string =>
  ["{", '  "workflow": "ci.yml",', '  "budgets": [', `    { "event": "pull_request", "job": "validate", "p90": ${p90} },${extra}`, '    { "event": "pull_request", "job": "dag-check", "p90": 600 }', "  ]", "}", ""].join("\n");

/** #3117's shape: validate p90 600 -> 900 s, plus a new release-PR budget entry. */
const PR_3117: CiPolicyFile = { path: BUDGET, before: budgetJson(600), after: budgetJson(900, '\n    { "event": "release_pr", "job": "validate", "p90": 1800 },') };

const ciYml = (jobs: string): string => `name: CI\non: pull_request\njobs:\n${jobs}`;
const VALIDATE = "  validate:\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    steps:\n      - run: pnpm test\n";
const DAG_CHECK = "  dag-check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm dag:check\n";
const CI_BEFORE = ciYml(VALIDATE + DAG_CHECK);

const classOf = (files: CiPolicyFile[], overrides: Partial<CiPolicyClassInput> = {}) =>
  ciPolicyClass({ keys: ["other"], files, changedPaths: files.map((file) => file.path), unread: false, required: REQUIRED, repo: REPO, prBody: BODY, freshMerge: true, ...overrides });

describe("sorting a weakened CI-policy diff into budget or weakening", () => {
  it("reads a #3117-shaped p90 600 -> 900 change with a measurement link as budget", () => {
    expect(classOf([PR_3117])).toEqual({ kind: "budget", measurement: RUN_URL });
  });

  it("reads a workflow timeout-minutes bump as budget", () => {
    const file = { path: CI_YML, before: CI_BEFORE, after: CI_BEFORE.replace("timeout-minutes: 20", "timeout-minutes: 30") };

    expect(classOf([file])).toEqual({ kind: "budget", measurement: RUN_URL });
  });

  it("reads a required-check removal as weakening, naming the check", () => {
    const file = { path: CI_YML, before: CI_BEFORE, after: ciYml(VALIDATE) };

    expect(classOf([file])).toEqual({ kind: "weakening", why: "required check dag-check was removed or renamed" });
  });

  it("reads a required check renamed away as weakening", () => {
    const file = { path: CI_YML, before: CI_BEFORE, after: CI_BEFORE.replace("dag-check:", "dag-check-lite:") };

    expect(classOf([file])).toEqual({ kind: "weakening", why: "required check dag-check was removed or renamed" });
  });

  it.each([
    ["continue-on-error", "    continue-on-error: true\n", "it adds continue-on-error"],
    ["if: false", "    if: false\n", "it adds if: false"],
    ["if: ${{ false }}", "    if: ${{ false }}\n", "it adds if: false"],
    ["a skip", "    # skip-ci: true\n", "it adds a skip"],
  ])("reads an added %s beside a timeout bump as weakening", (_case, line, why) => {
    const after = CI_BEFORE.replace("timeout-minutes: 20\n", `timeout-minutes: 30\n${line}`);

    expect(classOf([{ path: CI_YML, before: CI_BEFORE, after }])).toEqual({ kind: "weakening", why: `${why} in ${CI_YML}` });
  });

  it("reads a changed run command beside a timeout bump as weakening", () => {
    const after = CI_BEFORE.replace("timeout-minutes: 20", "timeout-minutes: 30").replace("pnpm test", "echo ok");

    expect(classOf([{ path: CI_YML, before: CI_BEFORE, after }])).toEqual({ kind: "weakening", why: `${CI_YML} changes more than a timeout or budget number` });
  });

  it.each<[string, Partial<CiPolicyClassInput>, string]>([
    ["no measurement link", { prBody: "Measured in run 123456." }, "the PR body links no measurement run"],
    ["a measurement run of another repo", { prBody: "https://github.com/other/repo/actions/runs/1" }, "the PR body links no measurement run"],
    ["a measurement run inside another URL", { prBody: `https://evil.example/?u=${RUN_URL}` }, "the PR body links no measurement run"],
    ["a vitest.config.ts change beside it", { changedPaths: [BUDGET, "vitest.config.ts"] }, "the PR changes vitest.config.ts, which is not a classified .github/ file"],
    ["a MERGE carried from another head", { freshMerge: false }, "no reviewer MERGE was given at this head"],
    ["a required-check key", { keys: ["other", "required-check"] }, "the reviewer named required-check"],
    ["an unread file", { unread: true }, "a changed file was not read"],
  ])("reads a #3117-shaped diff with %s as weakening", (_case, overrides, why) => {
    expect(classOf([PR_3117], overrides)).toEqual({ kind: "weakening", why });
  });

  it("reads a diff that changes no budget number as weakening", () => {
    const file = { path: CI_YML, before: CI_BEFORE, after: CI_BEFORE.replace("name: CI\n", "name: CI\n# a note\n") };

    expect(classOf([file])).toEqual({ kind: "weakening", why: "no timeout, p90 or budget number changed" });
  });

  it.each<[string, string, string]>([
    ["the workflow it caps", budgetJson(900).replace('"ci.yml"', '"ci-2.yml"'), `it changes workflow in ${BUDGET}`],
    ["the run samples", budgetJson(900).replace('"workflow": "ci.yml",', '"workflow": "ci.yml",\n  "runs": { "pull_request": 1 },'), `it changes runs in ${BUDGET}`],
    ["a removed entry", budgetJson(600).replace(/\n.*"validate".*\n/, "\n").replace('"p90": 600 }\n', '"p90": 900 }\n'), `it removes or reshapes the budget entry {"event":"pull_request","job":"validate"} in ${BUDGET}`],
    ["a cap moved to another job", budgetJson(900).replace('"job": "dag-check"', '"job": "lint"'), `it removes or reshapes the budget entry {"event":"pull_request","job":"dag-check"} in ${BUDGET}`],
    ["a number turned to text", budgetJson(600).replace('"p90": 600 }\n', '"p90": "off" }\n'), `it removes or reshapes the budget entry {"event":"pull_request","job":"dag-check"} in ${BUDGET}`],
    ["a file that is not JSON", "{", `${BUDGET} is not a budget object at base and head`],
  ])("reads a p90 bump in ci-budget.json that also changes %s as weakening, with no required check to lose", (_case, after, why) => {
    expect(classOf([{ path: BUDGET, before: budgetJson(600), after }], { required: [] })).toEqual({ kind: "weakening", why });
  });

  it("reads every line of a workflow named for budgets by the line rule", () => {
    const path = ".github/workflows/budget-report.yml";
    const after = ciYml("  report:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n").replace("on: pull_request", "on: pull_request_target");

    expect(classOf([{ path, before: "", after }])).toEqual({ kind: "weakening", why: `${path} changes more than a timeout or budget number` });
  });
});

const locator = partialFake<SourceTextLocator>({ selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] } });
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const OTHER: CiPolicy = { kind: "weakened", keys: ["other"] };
const input: MergeEvidenceInput = {
  ...{ runId: "run-1", repo: REPO, pr: 1, head: HEAD, verdict: { value: "MERGE", head: HEAD, locator } },
  ...{ resolver: REVIEWER, dispatchedReviewer: REVIEWER, seatGrants: ["merge-on-green-approve"], ciPolicy: OTHER },
};

/** A reviewed MERGE at HEAD with green required checks, whose changed files are `file` read at main and at HEAD, and `others`. */
async function evidenceFor(file: CiPolicyFile, body = BODY, overrides: Partial<MergeEvidenceInput> = {}, others: string[] = []) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("test-merge"), body });
  fake.classicRules = { contexts: REQUIRED, strict: false };
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(1, [file.path, ...others].map((path): PrFile => ({ path, status: "modified" })));
  fake.files.set(`main:${file.path}`, { content: file.before, blobSha: fakeSha(`main:${file.path}`) });
  fake.files.set(`${HEAD}:${file.path}`, { content: file.after, blobSha: fakeSha(`head:${file.path}`) });
  return mergeEvidence(githubPort(fake.wire), { ...input, ...overrides }, noFreezeStoreUntilTp523, { kind: "correctness" });
}

const guard = (rowId: string) => ({ table: "shepherd-merge-guard", rowId, version: 1 });
const markedRows = async (file: CiPolicyFile, body?: string) => {
  const evidence = await evidenceFor(file, body);
  return ownerAtHeadAt(HEAD, () => ({ kind: "MERGE", headSha: HEAD, evidence }));
};

describe("the merge guard on a weakened CI-policy line", () => {
  it("gates a #3117-shaped budget diff on ci-policy-budget, unmarked, so a coordinator may resolve it", async () => {
    const evidence = await evidenceFor(PR_3117);

    expect(evidence.record.decision).toEqual({ outcome: "gate", rule: guard("ci-policy-budget"), reason: `CI-policy budget change: other; measured at ${RUN_URL}` });
    expect(await markedRows(PR_3117)).toEqual([]);
  });

  it("keeps a required-check removal on ci-policy-weakened, marked for the owner", async () => {
    const removal = { path: CI_YML, before: CI_BEFORE, after: ciYml(VALIDATE) };
    const evidence = await evidenceFor(removal);

    expect(evidence.record.decision).toMatchObject({ outcome: "gate", rule: guard("ci-policy-weakened") });
    expect(await markedRows(removal)).toEqual(["ci-policy-weakened"]);
  });

  it("keeps a #3117-shaped diff beside a package.json change on ci-policy-weakened, marked for the owner", async () => {
    const evidence = await evidenceFor(PR_3117, BODY, {}, ["package.json"]);

    expect(evidence.record.decision).toMatchObject({ outcome: "gate", rule: guard("ci-policy-weakened") });
    expect(ownerAtHeadAt(HEAD, () => ({ kind: "MERGE", headSha: HEAD, evidence }))).toEqual(["ci-policy-weakened"]);
  });

  it("keeps a #3117-shaped diff with no measurement link on ci-policy-weakened", async () => {
    const evidence = await evidenceFor(PR_3117, "No link.");

    expect(evidence.record.decision).toMatchObject({ rule: guard("ci-policy-weakened") });
    expect(await markedRows(PR_3117, "No link.")).toEqual(["ci-policy-weakened"]);
  });

  it("keeps a budget diff on ci-policy-weakened when the MERGE was given at another head", async () => {
    const evidence = await evidenceFor(PR_3117, BODY, { verdict: { value: "MERGE", head: fakeSha("older"), locator } });

    expect(evidence.record.decision).toMatchObject({ rule: guard("ci-policy-weakened") });
  });

  it("lets another gate the rest of the guard opens win over the budget row", async () => {
    const evidence = await evidenceFor(PR_3117, BODY, { seatGrants: [] });

    expect(evidence.record.decision).toMatchObject({ outcome: "gate", rule: { table: "authority" } });
  });
});

const COORDINATOR = { class: "coordinator", id: "tc-synthetic", channel: "factory-cli" } as const;

function landGateAt(rule: string, reason: string): GateRecord {
  const { schema, brief } = approveMergeDecision({ repo: REPO, pr: 1, headSha: HEAD, reason, reviewedMerge: true });
  const prompt = `Merge PR #1 in ${REPO} at head ${HEAD}? CI is green. Policy ${rule}: ${reason}`;
  const fields = { status: "pending", createdAt: "2026-11-04T00:00:00.000Z", schema: toJSONSchema(schema), ...brief } as const;
  return partialFake<GateRecord>({ id: "run-1/approve-merge", prompt, ...fields });
}

function coordinatorEvidence(rule: string, reason: string): CoordinatorEvidence {
  const run = { workflow: "shepherd-pr", repo: REPO, pr: 1, rule, reason, merge: "auto", visualPaths: false, held: false, frozen: false };
  const checks = { base: "main", required: REQUIRED, runs: REQUIRED.map((name, i) => ({ id: i + 1, name, conclusion: "success", headSha: HEAD })) };
  return {
    ...{ kind: "approve-merge", gateId: "run-1/approve-merge", repo: REPO, pr: 1, headSha: HEAD, run, checks, readAt: "2026-11-04T00:00:00.000Z" },
    ...{ verdict: { step: `sh-await-verdict:${HEAD}`, verdict: "MERGE", head: HEAD, reviewer: "rv-synthetic" }, pull: { state: "open", headSha: HEAD, mergeableState: "clean", mergeable: "MERGEABLE" } },
  };
}

describe("a coordinator resolving a CI-policy gate", () => {
  const reason = `CI-policy budget change: other; measured at ${RUN_URL}`;
  const admits = (rule: string) => coordinatorEvidencePolicy(landGateAt(rule, reason), COORDINATOR, { decision: "merge", headSha: HEAD }, coordinatorEvidence(rule, reason));

  it("admits a ci-policy-budget gate on fresh merge evidence", () => {
    expect(admits("shepherd-merge-guard/ci-policy-budget")).toBe(true);
  });

  it("refuses a ci-policy-weakened gate on the same evidence", () => {
    expect(admits("shepherd-merge-guard/ci-policy-weakened")).toBe(false);
  });

  it("refuses a ci-policy-budget gate whose required checks are not all green", () => {
    const evidence = coordinatorEvidence("shepherd-merge-guard/ci-policy-budget", reason);
    const red = { ...evidence, checks: { base: "main", required: REQUIRED, runs: [{ id: 1, name: "validate", conclusion: "success", headSha: HEAD }] } };

    expect(coordinatorEvidencePolicy(landGateAt("shepherd-merge-guard/ci-policy-budget", reason), COORDINATOR, { decision: "merge", headSha: HEAD }, red)).toBe(false);
  });

  it("refuses a ci-policy-budget gate on a held run", () => {
    const evidence = coordinatorEvidence("shepherd-merge-guard/ci-policy-budget", reason);
    const held = evidence.kind === "approve-merge" ? { ...evidence, run: { ...evidence.run, held: true } } : evidence;

    expect(coordinatorEvidencePolicy(landGateAt("shepherd-merge-guard/ci-policy-budget", reason), COORDINATOR, { decision: "merge", headSha: HEAD }, held)).toBe(false);
  });
});
