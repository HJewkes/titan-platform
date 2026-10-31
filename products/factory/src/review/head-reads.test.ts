import { formatResultLine, proofStanding, type FixProofResult } from "@titan-design/fix-proof";
import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun, type FakeGitHub } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { FIX_PROOF_CHECK } from "../shepherd/fix-proof.js";
import { formatReview, type CiRead } from "./format.js";
import { prProofReader, snapshotReader } from "./head-reads.js";

const REPO = "acme/widgets";
const HEAD = fakeSha("review-head");
const PROOF_JOB = 77;

function noReproLine(): string {
  const counts: FixProofResult["counts"] = { reproduces: 0, "passes-on-base": 0, "new-api": 0, "fails-on-head": 0, "not-run": 0 };
  return formatResultLine({ head: HEAD, mergeBase: fakeSha("merge-base"), base: "main", verdict: "vacuous", counts, notCollected: [], deletedTests: [], configEdited: false, tests: [], truncated: false });
}

const proofRun = (): CheckRun => ({ ...successRun(FIX_PROOF_CHECK, PROOF_JOB), headSha: HEAD, pullRequests: [{ number: 1, baseRef: "main" }] });

function repo(headRef: string, runs: CheckRun[]): FakeGitHub {
  const fake = fakeGitHub({ repo: REPO });
  fake.addPr({ headSha: HEAD, headRef });
  fake.setRuns(HEAD, runs);
  fake.prFiles.set(1, [{ path: "src/widget.ts", status: "modified" }]);
  return fake;
}

const target = { repo: REPO, pr: 1, head: HEAD };

describe("the review CLI's run-free fix-proof read", () => {
  it("reads a bug-fix PR whose fix-proof check printed a NO_REPRO line as no-repro, with no Shepherd run", async () => {
    const fake = repo("fix/widget-crash", [proofRun()]);
    fake.jobLogs.set(PROOF_JOB, `2026-10-11T12:00:00.0000000Z ${noReproLine()}`);

    const read = await prProofReader(githubPort(fake.wire)).read(target);

    expect(proofStanding(read, HEAD)).toMatchObject({ kind: "no-repro", result: { verdict: "vacuous" } });
  });

  it("skips a feature PR that has no fix-proof run at its head", async () => {
    const fake = repo("feat/widget", [{ ...successRun("validate", 1), headSha: HEAD }]);

    const read = await prProofReader(githubPort(fake.wire)).read(target);

    expect(proofStanding(read, HEAD)).toEqual({ kind: "none" });
  });
});

describe("the review CLI's CI read", () => {
  async function snapshot(fake: FakeGitHub): Promise<{ state: string; ci: CiRead | undefined }> {
    let seen: CiRead | undefined;
    const read = await snapshotReader(githubPort(fake.wire), (_target, ci) => void (seen = ci)).read(target);
    return { state: read.ci, ci: seen };
  }

  it("reads a repo with no required checks as green once every check run at the head passed, and names that source", async () => {
    const fake = repo("feat/widget", [{ ...successRun("build", 1), headSha: HEAD }, { ...successRun("lint", 2, undefined, "skipped"), headSha: HEAD }]);
    fake.rules = { contexts: [], strict: false };

    const { state, ci } = await snapshot(fake);

    expect([state, ci]).toEqual(["green", { state: "green", source: "head-check-runs" }]);
    expect(formatReview({ runId: "run-1", outcome: { kind: "head-moved", head: HEAD, current: HEAD }, members: [], ...(ci && { ci }) })).toContain("CI: green, from every check run at the head");
  });

  it.each<[string, CheckRun[]]>([
    ["failing", [{ ...successRun("build", 1, undefined, "failure"), headSha: HEAD }]],
    ["pending", [{ ...successRun("build", 1), headSha: HEAD, status: "in_progress", conclusion: null }]],
    ["pending", []],
  ])("reads a repo with no required checks as %s from its head's check runs", async (expected, runs) => {
    const fake = repo("feat/widget", runs);
    fake.rules = { contexts: [], strict: false };

    expect((await snapshot(fake)).ci).toEqual({ state: expected, source: "head-check-runs" });
  });

  it("keeps the required checks as the source when the base names them", async () => {
    const fake = repo("feat/widget", ["validate", "dag-check"].map((name, id) => ({ ...successRun(name, id + 1), headSha: HEAD })));

    expect((await snapshot(fake)).ci).toEqual({ state: "green", source: "required-checks" });
  });
});
